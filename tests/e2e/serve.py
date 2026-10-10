"""Serve the real application against disposable, synthetic-only E2E storage."""

import base64
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
import uvicorn
from PIL import Image

from ocrs.api import create_app
from ocrs.config import Settings
from ocrs.model_settings import ModelSettingsStore
from ocrs.storage import migrate

# Public test credential; valid only for this disposable loopback test service.
# Deliberately do not read dotenv, a real access-token file, or Settings.from_env().
TOKEN = "synthetic-playwright-only-token-not-a-secret"


def synthetic_model_response(request: httpx.Request) -> httpx.Response:
    """Only the remote wire is fake: exercise real image encoding and parsing.

    Unexpected hosts/models fail closed and can never reach DNS or a socket.
    Every accepted payload must actually contain a decodable image.
    """
    assert request.url.host == "models.example.com"
    assert request.url.path == "/v1/chat/completions"
    payload = json.loads(request.content)
    content = payload["messages"][1]["content"]
    source_ids = [
        part["text"].removeprefix("Source ID: ") for part in content if part["type"] == "text"
    ]
    images = [part["image_url"]["url"] for part in content if part["type"] == "image_url"]
    assert source_ids and len(source_ids) == len(images)
    for image in images:
        assert image.startswith("data:image/png;base64,")
        with Image.open(io.BytesIO(base64.b64decode(image.split(",", 1)[1]))) as decoded:
            decoded.verify()
    model = payload["model"]
    if model == "synthetic-unsupported-image":
        return httpx.Response(400, json={"error": "synthetic unsupported image input"})
    if model == "synthetic-timeout":
        raise httpx.ReadTimeout("synthetic provider timeout", request=request)
    if model == "synthetic-invalid-json":
        result = "{synthetic malformed candidate"
    else:
        assert model == "synthetic-vision-model", "Only explicit synthetic models are permitted"
        result = json.dumps(
            {
                "schema_version": "1",
                "events": [
                    {
                        "action": "create",
                        "customer": "SYNTHETIC Vision Buyer",
                        "external_id": "000042",
                        "currency": "CNY",
                        "items": [
                            {
                                "sku": "DEMO-001",
                                "name": "SYNTHETIC Vision Box",
                                "quantity": "2.5",
                                "unit": "box",
                                "unit_price": "12.40",
                            }
                        ],
                        "evidence": [
                            {
                                "source_id": source_id,
                                "field": "items",
                                "text": "SYNTHETIC pixels: 2.5 boxes at CNY 12.40",
                            }
                            for source_id in source_ids
                        ],
                        "warnings": ["SYNTHETIC NETWORK FIXTURE: human verification required"],
                        "missing_reasons": ["occurred_at: no date in synthetic evidence"],
                    }
                ],
            }
        )
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": result},
                }
            ]
        },
    )


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
            patch(
                "ocrs.providers.PublicHTTPTransport",
                side_effect=lambda: httpx.MockTransport(synthetic_model_response),
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
