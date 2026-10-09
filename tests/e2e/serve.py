"""Serve the real application against disposable, synthetic-only E2E storage."""

from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from ocrs.api import create_app
from ocrs.config import Settings
from ocrs.storage import migrate

# Public test credential; valid only for this disposable loopback test service.
# Deliberately do not read dotenv, a real access-token file, or Settings.from_env().
TOKEN = "synthetic-playwright-only-token-not-a-secret"


def main() -> None:
    with TemporaryDirectory(prefix="ocrs-playwright-") as directory:
        root = Path(directory)
        migrate(root)
        settings = Settings(
            data_dir=root,
            token=TOKEN,
            provider="demo",
            api_key="",
            allow_external=False,
            inbox=None,
        )
        uvicorn.run(
            create_app(settings),
            host="127.0.0.1",
            port=8765,
            log_level="warning",
            access_log=False,
        )


if __name__ == "__main__":
    main()
