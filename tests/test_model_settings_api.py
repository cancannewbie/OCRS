"""Page settings integration: offline only, using disposable synthetic credentials."""

import io
import json
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ocrs.api import _ingest_inbox, create_app
from ocrs.config import Settings
from ocrs.model_settings import ModelSettingsStore, ModelSettingsUpdate
from ocrs.providers import DemoProvider, OpenAICompatibleProvider, ProviderError
from ocrs.storage import SCHEMA, connect, migrate

TOKEN = "synthetic-model-page-local-token-123456789"
KEY = "synthetic-model-page-key-not-a-real-credential"
AUTH = {"Authorization": "Bearer " + TOKEN}


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "data"
    migrate(root)
    monkeypatch.setattr(
        "ocrs.api.ModelSettingsStore",
        lambda directory: ModelSettingsStore(directory, key_dir=tmp_path / "keys"),
    )
    return create_app(Settings(root, TOKEN), start_worker=False)


def payload(revision: int = 0, **updates):
    return {
        "expected_revision": revision,
        "provider": "minimax-cn",
        "model": "MiniMax-M3",
        "base_url": "https://api.minimax.cn/v1",
        "allow_external": True,
        "api_key_action": "replace",
        "api_key": KEY,
        **updates,
    }


def image() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


def test_settings_auth_origin_validation_and_no_secret_echo(app):
    with TestClient(app) as client:
        assert client.get("/api/model-settings").status_code == 401
        assert client.put("/api/model-settings", json=payload()).status_code == 401
        response = client.put(
            "/api/model-settings",
            headers={**AUTH, "Origin": "https://untrusted.example"},
            json=payload(),
        )
        assert response.status_code == 403
        assert client.get("/api/model-settings", headers=AUTH).json()["revision"] == 0
        response = client.put("/api/model-settings", headers=AUTH, json=payload(unexpected=KEY))
        assert response.status_code == 422
        assert KEY not in response.text
        assert TOKEN not in response.text


def test_save_restart_persistence_no_network_and_safe_configuration(app, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("save/GET must not resolve or connect")

    monkeypatch.setattr("socket.getaddrinfo", forbidden)
    monkeypatch.setattr(OpenAICompatibleProvider, "test_connection", forbidden)
    with TestClient(app) as client:
        response = client.put("/api/model-settings", headers=AUTH, json=payload())
        assert response.status_code == 200
        assert response.json()["test_status"] == "not_tested"
        assert response.json()["api_key_configured"] is True
        assert KEY not in response.text
        config = client.get("/api/config", headers=AUTH).json()
        assert config["provider"] == "minimax-cn"
        assert config["model_configured"] is True
        assert config["external_transmission_enabled"] is True
        assert KEY not in json.dumps(config)
    store = app.state.service.model_store
    assert ModelSettingsStore(store.data_dir, key_dir=store.key_dir).snapshot().api_key == KEY


@pytest.mark.parametrize("outcome", ["passed", "failed"])
def test_explicit_connection_probe_only_and_sanitized_result(app, monkeypatch, outcome):
    calls = []

    def probe(self):
        calls.append(self)
        if outcome == "failed":
            raise RuntimeError(KEY)

    monkeypatch.setattr(OpenAICompatibleProvider, "test_connection", probe)
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=payload())
        assert not calls
        for body in [
            {"expected_revision": 1},
            {"expected_revision": 0, "confirm_external": True},
        ]:
            response = client.post("/api/model-settings/test", headers=AUTH, json=body)
            assert response.status_code == 409
        assert not calls
        response = client.post(
            "/api/model-settings/test",
            headers=AUTH,
            json={
                "expected_revision": 1,
                "confirm_external": True,
            },
        )
        assert response.status_code == 200
        assert response.json()["test_status"] == outcome
        assert len(calls) == 1
        assert KEY not in response.text
        response = client.put(
            "/api/model-settings",
            headers=AUTH,
            json=payload(
                1,
                api_key_action="keep",
                api_key="",
                allow_external=False,
            ),
        )
        assert response.json()["test_status"] == "not_tested"
        assert (
            client.post(
                "/api/model-settings/test",
                headers=AUTH,
                json={
                    "expected_revision": 2,
                    "confirm_external": True,
                },
            ).status_code
            == 409
        )
        assert len(calls) == 1


def test_stale_test_cannot_mark_new_configuration_passed(app, monkeypatch):
    service = app.state.service

    def probe(self):
        service.save_model_settings(
            ModelSettingsUpdate(
                **payload(
                    1,
                    api_key_action="keep",
                    api_key="",
                    allow_external=False,
                )
            )
        )

    monkeypatch.setattr(OpenAICompatibleProvider, "test_connection", probe)
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=payload())
        response = client.post(
            "/api/model-settings/test",
            headers=AUTH,
            json={
                "expected_revision": 1,
                "confirm_external": True,
            },
        )
        assert response.status_code == 409
        assert client.get("/api/model-settings", headers=AUTH).json()["test_status"] == "not_tested"


def test_old_queue_and_inbox_never_auto_transmit_after_enable(app, monkeypatch):
    service = app.state.service
    calls = []
    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", lambda *args: calls.append(args))
    old, _ = service.ingest(image(), "synthetic.png", "old-demo-queue")
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=payload())
        assert service.task(old["id"])["status"] == "failed"
        assert service.task(old["id"])["error_code"] == "MODEL_CONFIG_CHANGED"
        assert service.process_one() is False
        inbox, _ = _ingest_inbox(service, image(), "inbox:synthetic.png")
        assert service.process_one() is True
        assert service.task(inbox["id"])["error_code"] == "MODEL_CONSENT_REQUIRED"
        assert not calls
        task = service.task(old["id"])
        assert (
            client.post(
                f"/api/tasks/{old['id']}/retry",
                headers=AUTH,
                json={
                    "expected_version": task["version"],
                },
            ).status_code
            == 409
        )
        assert (
            client.post(
                f"/api/tasks/{old['id']}/retry",
                headers=AUTH,
                json={
                    "expected_version": task["version"],
                    "config_revision": 1,
                    "confirm_external": True,
                },
            ).status_code
            == 200
        )
        # Retry consent binds to this destination; another settings save invalidates it.
        client.put(
            "/api/model-settings",
            headers=AUTH,
            json=payload(
                1,
                api_key_action="keep",
                api_key="",
                allow_external=False,
            ),
        )
        assert service.process_one() is False
        assert not calls


def test_upload_requires_current_revision_and_explicit_image_consent(app):
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=payload())
        for consent in [{}, {"config_revision": "0", "confirm_external": "true"}]:
            response = client.post(
                "/api/uploads",
                headers=AUTH,
                files={"files": ("synthetic.png", image(), "image/png")},
                data={"source_label": "synthetic-explicit", **consent},
            )
            assert response.status_code == 409
        assert client.get("/api/tasks", headers=AUTH).json()["total"] == 0
        response = client.post(
            "/api/uploads",
            headers=AUTH,
            files={"files": ("synthetic.png", image(), "image/png")},
            data={
                "source_label": "synthetic-explicit",
                "config_revision": "1",
                "confirm_external": "true",
            },
        )
        assert response.status_code == 200
        task = response.json()["tasks"][0]
        assert task["model_revision"] == 1
        assert task["external_authorized"] == 1


def test_running_task_keeps_one_provider_model_key_snapshot(app, monkeypatch):
    service = app.state.service
    service.save_model_settings(ModelSettingsUpdate(**payload()))
    task, _ = service.ingest(
        image(), "synthetic.png", "snapshot", config_revision=1, confirm_external=True
    )
    started, release = threading.Event(), threading.Event()
    used = []

    def recognize(self, sources):
        used.append((self._endpoint, self._model, self._api_key))
        started.set()
        assert release.wait(5)
        return DemoProvider().recognize(sources)

    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", recognize)
    thread = threading.Thread(target=service.process_one)
    thread.start()
    assert started.wait(5)
    service.save_model_settings(
        ModelSettingsUpdate(
            **payload(
                1,
                provider="openai-compatible",
                model="synthetic-vision",
                base_url="https://api.openai.com/v1",
                api_key="synthetic-second-key",
            )
        )
    )
    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert used == [("https://api.minimax.cn/v1/chat/completions", "MiniMax-M3", KEY)]
    assert service.task(task["id"])["status"] == "review_required"
    with connect(service.root) as db:
        assert db.execute("SELECT model FROM candidate_history").fetchone()[0] == "MiniMax-M3"
        assert db.execute("SELECT count(*) FROM orders").fetchone()[0] == 0


def test_schema_one_migration_preserves_facts_but_revokes_old_queue(tmp_path):
    with sqlite3.connect(tmp_path / "ocrs.sqlite3") as db:
        db.executescript(SCHEMA + "PRAGMA user_version=1;")
        db.execute(
            "INSERT INTO sources VALUES('s','d','label','fictional.png',"
            "'image/png','images/s.png','now',0)"
        )
        db.execute(
            "INSERT INTO tasks(id,source_id,status,provider,created_at,updated_at) "
            "VALUES('t','s','received','demo','now','now')"
        )
    migrate(tmp_path)
    with connect(tmp_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        task = db.execute("SELECT * FROM tasks").fetchone()
        assert task["model_revision"] == -1
        assert task["external_authorized"] == 0
        assert task["source_id"] == "s"


def test_lost_key_page_recovers_without_blocking_login(app):
    with TestClient(app) as client:
        assert client.put("/api/model-settings", headers=AUTH, json=payload()).status_code == 200
        app.state.service.model_store.key_path.unlink()
        for path in ("/api/status", "/api/config", "/api/model-settings"):
            assert client.get(path, headers=AUTH).status_code == 200
        safe = client.get("/api/model-settings", headers=AUTH).json()
        assert safe["credential_status"] == "unavailable"
        assert safe["status"] == "not_configured"
        assert safe["api_key_configured"] is True
        assert KEY not in json.dumps(safe)
        response = client.put("/api/model-settings", headers=AUTH, json=payload(1))
        assert response.status_code == 200
        assert response.json()["status"] == "configured"


def test_provider_build_failure_never_claims_queue_or_returns_500(app, monkeypatch):
    service = app.state.service
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=payload())
        task, _ = service.ingest(
            image(),
            "synthetic.png",
            "constructor-failure",
            config_revision=1,
            confirm_external=True,
        )

        def failure(*args):
            raise ProviderError("provider_config_model")

        monkeypatch.setattr(service, "_make_provider", failure)
        from ocrs.service import AppError

        with pytest.raises(AppError, match="模型配置无效"):
            service.process_one()
        assert service.task(task["id"])["status"] == "received"
        response = client.post(
            "/api/model-settings/test",
            headers=AUTH,
            json={
                "expected_revision": 1,
                "confirm_external": True,
            },
        )
        assert response.status_code == 409
        assert KEY not in response.text
