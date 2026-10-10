"""Read-only workbench diagnostics never expose credentials or private paths."""

import json
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from ocrs import __version__
from ocrs.api import create_app
from ocrs.config import Settings
from ocrs.storage import migrate

TOKEN = "fictional-workbench-test-token-not-a-secret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_configuration_requires_authentication(tmp_path: Path) -> None:
    migrate(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path, token=TOKEN), start_worker=False)
    ) as client:
        response = client.get("/api/config")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_configuration_is_explicit_safe_allowlist(tmp_path: Path) -> None:
    migrate(tmp_path)
    settings = Settings(
        data_dir=tmp_path,
        token=TOKEN,
        model="fictional-private-model-name",
        api_key="fictional-provider-test-secret",
        model_url="https://fictional.invalid/private?key=fictional-private-url",
        allow_external=True,
        sku_catalog=frozenset({"DEMO-002", "DEMO-001"}),
    )
    with TestClient(create_app(settings, start_worker=False)) as client:
        response = client.get("/api/config", headers=AUTH)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {
            "version": __version__,
            "schema_version": 2,
            "provider": "demo",
            "recognition_mode": "demo",
            "model_configured": False,
            "external_transmission_enabled": False,
            "inbox_enabled": False,
            "max_upload_bytes": 10 * 1024 * 1024,
            "max_upload_files": 8,
            "evidence_days": 30,
            "sku_catalog": ["DEMO-001", "DEMO-002"],
            "supported_currencies": ["CNY", "EUR", "GBP", "JPY", "USD"],
            "deployment_mode": "single-user-local",
            "backup_mode": "offline-cli",
        }
        for private in [TOKEN, settings.api_key, settings.model_url, settings.model, str(tmp_path)]:
            assert private not in response.text


def test_external_configuration_does_not_claim_provider_validation(tmp_path: Path) -> None:
    migrate(tmp_path)
    settings = Settings(
        data_dir=tmp_path,
        token=TOKEN,
        provider="openai-compatible",
        model="fictional-model",
        api_key="fictional-key",
        allow_external=True,
    )
    with TestClient(create_app(settings, start_worker=False)) as client:
        config = client.get("/api/config", headers=AUTH).json()
        assert config["recognition_mode"] == "demo"
        assert config["model_configured"] is False
        assert config["external_transmission_enabled"] is False
        assert "verified" not in json.dumps(config)


def test_project_version_matches_diagnostic_version() -> None:
    project = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with project.open("rb") as file:
        assert tomllib.load(file)["project"]["version"] == __version__


def test_task_pagination_parameters_are_bounded(tmp_path: Path) -> None:
    migrate(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path, token=TOKEN), start_worker=False)
    ) as client:
        for query in ["limit=0", "limit=501", "offset=-1", "status=made_up", "q=" + "x" * 201]:
            response = client.get(f"/api/tasks?{query}", headers=AUTH)
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_long_inbox_names_preserve_identity_and_filename(tmp_path: Path) -> None:
    import io

    from PIL import Image

    from ocrs.api import _ingest_inbox
    from ocrs.service import Service

    migrate(tmp_path)
    service = Service(Settings(data_dir=tmp_path, token=TOKEN))
    output = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(output, format="PNG")
    data = output.getvalue()
    seen = set()
    for filename in ["short.png", "a" * 195 + ".png", "a" * 250 + "1.png", "a" * 250 + "2.png"]:
        first, duplicate = _ingest_inbox(service, data, "inbox:" + filename)
        assert not duplicate
        assert first["sources"][0]["filename"] == filename
        assert len(first["sources"][0]["source_label"]) <= 200
        assert first["id"] not in seen
        seen.add(first["id"])
        repeated, duplicate = _ingest_inbox(service, data, "inbox:" + filename)
        assert duplicate and repeated["id"] == first["id"]
    short = _ingest_inbox(service, data, "inbox:short.png")[0]
    assert short["sources"][0]["source_label"] == "inbox:short.png"


def test_retry_http_requires_version_and_rejects_stale_request(tmp_path: Path) -> None:
    import io

    from PIL import Image

    from ocrs.storage import transaction

    migrate(tmp_path)
    settings = Settings(data_dir=tmp_path, token=TOKEN)
    with TestClient(create_app(settings, start_worker=False)) as client:
        output = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(output, format="PNG")
        task = client.post(
            "/api/uploads",
            headers=AUTH,
            files=[("files", ("fictional.png", output.getvalue(), "image/png"))],
        ).json()["tasks"][0]
        with transaction(tmp_path) as db:
            db.execute("UPDATE tasks SET status='failed',version=2 WHERE id=?", (task["id"],))
        endpoint = f"/api/tasks/{task['id']}/retry"
        assert client.post(endpoint, headers=AUTH).status_code == 422
        stale = client.post(endpoint, headers=AUTH, json={"expected_version": 1})
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "VERSION_CONFLICT"
        queued = client.post(endpoint, headers=AUTH, json={"expected_version": 2})
        assert queued.status_code == 200
        assert queued.json()["status"] == "received"
        replay = client.post(endpoint, headers=AUTH, json={"expected_version": 2})
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "VERSION_CONFLICT"
