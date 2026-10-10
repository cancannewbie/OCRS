"""Serve the real application against disposable, synthetic-only E2E storage."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import uvicorn

from ocrs.api import create_app
from ocrs.config import Settings
from ocrs.model_settings import ModelSettingsStore
from ocrs.providers import OpenAICompatibleProvider, ProviderError
from ocrs.storage import migrate

# Public test credential; valid only for this disposable loopback test service.
# Deliberately do not read dotenv, a real access-token file, or Settings.from_env().
TOKEN = "synthetic-playwright-only-token-not-a-secret"


def main() -> None:
    with TemporaryDirectory(prefix="ocrs-playwright-") as directory:
        root = Path(directory) / "data"
        migrate(root)
        settings = Settings(
            data_dir=root,
            token=TOKEN,
            provider="demo",
            api_key="",
            allow_external=False,
            inbox=None,
        )

        # Keep both credentials and encryption material disposable, but separate.
        # Tests exercise the real save/read API; only paid provider calls are fake.
        def isolated_store(data_dir: Path) -> ModelSettingsStore:
            return ModelSettingsStore(data_dir, key_dir=Path(directory) / "keys")

        with (
            patch("ocrs.api.ModelSettingsStore", side_effect=isolated_store),
            patch.object(OpenAICompatibleProvider, "test_connection", return_value=None),
            patch.object(
                OpenAICompatibleProvider,
                "recognize",
                side_effect=ProviderError("offline_e2e_no_external_recognition"),
            ),
        ):
            uvicorn.run(
                create_app(settings),
                host="127.0.0.1",
                port=8765,
                log_level="warning",
                access_log=False,
            )


if __name__ == "__main__":
    main()
