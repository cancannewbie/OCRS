"""Offline regression coverage for opt-in recognition with saved model settings."""

import io
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ocrs.api import _ingest_inbox, create_app
from ocrs.config import Settings
from ocrs.domain import Candidate
from ocrs.model_settings import ModelSettingsStore
from ocrs.providers import DemoProvider, OpenAICompatibleProvider, ProviderError
from ocrs.service import AppError
from ocrs.storage import connect, migrate

TOKEN = "synthetic-enable-local-token-1234567890"
KEY = "synthetic-enable-api-key-never-a-real-credential"
AUTH = {"Authorization": "Bearer " + TOKEN}
ENABLE = "/api/model-settings/enable-external"


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Recognition enable regression tests must never use a live network")

    monkeypatch.setattr("socket.getaddrinfo", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", forbidden)
    monkeypatch.setattr(OpenAICompatibleProvider, "test_connection", forbidden)
    root = tmp_path / "data"
    migrate(root)
    monkeypatch.setattr(
        "ocrs.api.ModelSettingsStore",
        lambda directory: ModelSettingsStore(directory, key_dir=tmp_path / "keys"),
    )
    return create_app(Settings(root, TOKEN), start_worker=False)


def configuration(**updates):
    return {
        "expected_revision": 0,
        "provider": "minimax-cn",
        "model": "MiniMax-M3",
        "base_url": "https://api.minimax.cn/v1",
        "api_key_action": "replace",
        "api_key": KEY,
        "allow_external": False,
        "timeout_seconds": 12,
        "total_timeout_seconds": 33,
        "max_output_tokens": 1234,
        "max_requests": 17,
        **updates,
    }


def synthetic_image():
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


def enable(client, revision=1, **updates):
    return client.post(
        ENABLE,
        headers=AUTH,
        json={"expected_revision": revision, "confirm_external": True, **updates},
    )


def saved_row(app):
    with sqlite3.connect(app.state.service.model_store.path) as db:
        return db.execute(
            "SELECT revision,config,secret,test_status FROM model_settings"
        ).fetchone()


def upload(client, **consent):
    return client.post(
        "/api/uploads",
        headers=AUTH,
        files={"files": ("synthetic.png", synthetic_image(), "image/png")},
        data={"source_label": "fictional-enabled-upload", **consent},
    )


def test_enable_requires_auth_same_origin_and_valid_contract(app):
    with TestClient(app) as client:
        assert (
            client.put("/api/model-settings", headers=AUTH, json=configuration()).status_code == 200
        )
        before = saved_row(app)
        body = {"expected_revision": 1, "confirm_external": True}
        assert client.post(ENABLE, json=body).status_code == 401
        response = client.post(
            ENABLE, headers={**AUTH, "Origin": "https://untrusted.example"}, json=body
        )
        assert response.status_code == 403
        for invalid in [{}, {**body, "api_key": KEY}, {**body, "expected_revision": -1}]:
            response = client.post(ENABLE, headers=AUTH, json=invalid)
            assert response.status_code == 422
            assert KEY not in response.text and TOKEN not in response.text
        assert saved_row(app) == before


@pytest.mark.parametrize(
    "body", [{"expected_revision": 1}, {"expected_revision": 1, "confirm_external": False}]
)
def test_enable_without_confirmation_never_mutates_or_sends(app, body):
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        before = saved_row(app)
        response = client.post(ENABLE, headers=AUTH, json=body)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MODEL_CONSENT_REQUIRED"
        assert saved_row(app) == before


def test_enable_stale_revision_never_mutates_or_sends(app):
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        before = saved_row(app)
        response = enable(client, revision=0)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MODEL_SETTINGS_CONFLICT"
        assert saved_row(app) == before


@pytest.mark.parametrize("missing", ["demo", "key", "model", "unreadable_key"])
def test_enable_incomplete_configuration_is_safe_and_unchanged(app, missing):
    with TestClient(app) as client:
        revision = 0
        if missing != "demo":
            updates = {}
            if missing == "key":
                updates = {"api_key_action": "delete", "api_key": ""}
            elif missing == "model":
                updates = {
                    "provider": "openai-compatible",
                    "model": "",
                    "base_url": "https://api.openai.com/v1",
                }
            assert (
                client.put(
                    "/api/model-settings", headers=AUTH, json=configuration(**updates)
                ).status_code
                == 200
            )
            revision = 1
        if missing == "unreadable_key":
            app.state.service.model_store.key_path.unlink()
        before = saved_row(app)
        response = enable(client, revision=revision)
        assert response.status_code in {409, 422}
        assert response.json()["error"]["code"] in {
            "MODEL_DISABLED",
            "PROVIDER_NOT_CONFIGURED",
            "MODEL_DEMO",
            "MODEL_SETTINGS_INVALID",
        }
        assert response.json()["error"]["message"]
        assert KEY not in response.text
        assert saved_row(app) == before


def test_enable_preserves_destination_limits_secret_and_does_not_claim_test_passed(app):
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        before = asdict(app.state.service.model_store.snapshot())
        encrypted_before = saved_row(app)[2]
        response = enable(client)
        assert response.status_code == 200
        public = response.json()
        assert public["revision"] == 2 and public["allow_external"] is True
        assert public["test_status"] == "not_tested"
        assert KEY not in response.text and "api_key" not in public
        after = asdict(app.state.service.model_store.snapshot())
        assert after == {**before, "revision": 2, "allow_external": True}
        assert saved_row(app)[2] == encrypted_before
        config = client.get("/api/config", headers=AUTH).json()
        assert config["recognition_mode"] == "external"
        assert config["external_transmission_enabled"] is True
        assert config["model_configured"] is True
        assert KEY not in json.dumps(config)
        # A repeated click with the current revision is an exact no-op.
        before_repeat = saved_row(app)
        repeated = enable(client, revision=2)
        assert repeated.status_code == 200 and repeated.json() == public
        assert saved_row(app) == before_repeat
        assert enable(client, revision=1).status_code == 409


def test_enable_does_not_replay_old_queue_and_retry_still_needs_consent(app, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Enabling a destination must never recognize queued evidence")

    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", forbidden)
    service = app.state.service
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        old, _ = _ingest_inbox(service, synthetic_image(), "inbox:fictional-before-enable.png")
        assert old["status"] == "received"
        assert enable(client).status_code == 200
        old = service.task(old["id"])
        assert old["status"] == "failed" and old["error_code"] == "MODEL_CONFIG_CHANGED"
        assert service.process_one() is False
        for consent in [{}, {"confirm_external": True, "config_revision": 1}]:
            response = client.post(
                f"/api/tasks/{old['id']}/retry",
                headers=AUTH,
                json={"expected_version": old["version"], **consent},
            )
            assert response.status_code == 409
            assert service.task(old["id"])["status"] == "failed"
        response = client.post(
            f"/api/tasks/{old['id']}/retry",
            headers=AUTH,
            json={
                "expected_version": old["version"],
                "config_revision": 2,
                "confirm_external": True,
            },
        )
        assert response.status_code == 200
        assert response.json()["model_revision"] == 2
        assert response.json()["external_authorized"] == 1


def test_upload_requires_separate_current_revision_consent_after_enable(app):
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        response = upload(client, config_revision=1, confirm_external="true")
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MODEL_DISABLED"
        assert enable(client).status_code == 200
        for consent in [{}, {"config_revision": 1, "confirm_external": "true"}]:
            assert upload(client, **consent).status_code == 409
        assert client.get("/api/tasks", headers=AUTH).json()["total"] == 0
        response = upload(client, config_revision=2, confirm_external="true")
        assert response.status_code == 200
        task = response.json()["tasks"][0]
        assert task["model_revision"] == 2 and task["external_authorized"] == 1


@pytest.mark.parametrize(
    "failure",
    ["provider_auth_failed", "provider_schema_invalid", "provider_unavailable", "internal"],
)
def test_enabled_recognition_failure_never_falls_back_to_demo(app, monkeypatch, failure, caplog):
    calls = []

    def recognize(self, sources):
        calls.append((self._endpoint, self._model, self._api_key, sources))
        if failure == "internal":
            raise RuntimeError(KEY)
        raise ProviderError(failure)

    def no_demo(*args, **kwargs):
        pytest.fail("External recognition failures must never substitute demo results")

    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", recognize)
    monkeypatch.setattr(DemoProvider, "recognize", no_demo)
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        assert enable(client).status_code == 200
        task = upload(client, config_revision=2, confirm_external="true").json()["tasks"][0]
        assert app.state.service.process_one() is True
        response = client.get(f"/api/tasks/{task['id']}", headers=AUTH)
        failed = response.json()
        assert failed["status"] == "failed" and failed["candidate"] is None
        assert failed["error_code"] == (
            "RECOGNITION_INTERNAL" if failure == "internal" else failure
        )
        assert failed["attempts"] == 1
        assert app.state.service.process_one() is False
        assert len(calls) == 1
        assert calls[0][:3] == ("https://api.minimax.cn/v1/chat/completions", "MiniMax-M3", KEY)
        assert KEY not in response.text and KEY not in caplog.text
        with connect(app.state.service.root) as db:
            assert db.execute("SELECT count(*) FROM orders").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM candidate_history").fetchone()[0] == 0


def test_enabled_recognition_only_creates_review_candidate(app, monkeypatch):
    def recognize(self, sources):
        return Candidate.model_validate(
            {
                "schema_version": "1",
                "events": [
                    {
                        "action": "create",
                        "customer": "Fictional review-only buyer",
                        "external_id": None,
                        "currency": "CNY",
                        "occurred_at": None,
                        "items": [
                            {
                                "sku": "DEMO-001",
                                "name": "Imaginary product",
                                "quantity": "2",
                                "unit": "piece",
                                "unit_price": "3.50",
                            }
                        ],
                        "evidence": [
                            {"source_id": sources[0].id, "field": "customer", "text": "fake"}
                        ],
                        "missing_reasons": [],
                    }
                ],
            }
        )

    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", recognize)
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        assert enable(client).status_code == 200
        task = upload(client, config_revision=2, confirm_external="true").json()["tasks"][0]
        assert app.state.service.process_one() is True
        result = client.get(f"/api/tasks/{task['id']}", headers=AUTH).json()
        assert result["status"] == "review_required" and result["error_code"] is None
        assert result["candidate"]["events"][0]["customer"] == "Fictional review-only buyer"
        with connect(app.state.service.root) as db:
            assert db.execute("SELECT count(*) FROM orders").fetchone()[0] == 0
            assert db.execute("SELECT model FROM candidate_history").fetchone()[0] == "MiniMax-M3"


def test_concurrent_enable_uses_one_revision_and_keeps_the_secret(app):
    service = app.state.service
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        before = saved_row(app)
        barrier = threading.Barrier(2)

        def attempt():
            barrier.wait(timeout=5)
            try:
                return service.enable_external(1, True)
            except AppError as exc:
                return {"error_code": exc.code}

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))
        successes = [result for result in results if "revision" in result]
        assert len(successes) == 1 and successes[0]["revision"] == 2
        assert {"error_code": "MODEL_SETTINGS_CONFLICT"} in results
        assert saved_row(app)[0] == 2
        assert saved_row(app)[2] == before[2]


@pytest.mark.parametrize(
    "failure", [None, "provider_auth_failed", "provider_schema_invalid", "internal"]
)
def test_explicit_probe_reports_safe_failure_codes_without_recognizing_queue(
    app, monkeypatch, failure
):
    calls = []

    def probe(self):
        calls.append(self._model)
        if failure == "internal":
            raise RuntimeError(KEY)
        if failure:
            raise ProviderError(failure)

    def forbidden(*args, **kwargs):
        pytest.fail("A connection probe must never consume queued business images")

    monkeypatch.setattr(OpenAICompatibleProvider, "test_connection", probe)
    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", forbidden)
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        assert enable(client).status_code == 200
        task = upload(client, config_revision=2, confirm_external="true").json()["tasks"][0]
        response = client.post(
            "/api/model-settings/test",
            headers=AUTH,
            json={"expected_revision": 2, "confirm_external": True},
        )
        assert response.status_code == 200
        assert response.json()["test_status"] == ("failed" if failure else "passed")
        assert response.json()["test_error_code"] == (
            "RECOGNITION_INTERNAL" if failure == "internal" else failure
        )
        assert calls == ["MiniMax-M3"] and KEY not in response.text
        assert app.state.service.task(task["id"])["status"] == "received"


def test_incomplete_real_candidate_keeps_nulls_until_explicit_human_completion(app, monkeypatch):
    missing_reasons = [
        "customer: not readable in fictional image",
        "items.0.quantity: not shown in fictional image",
        "items.0.unit_price: not shown in fictional image",
    ]

    def recognize(self, sources):
        return Candidate.model_validate(
            {
                "schema_version": "1",
                "events": [
                    {
                        "action": "create",
                        "customer": None,
                        "currency": "CNY",
                        "items": [
                            {
                                "sku": "DEMO-001",
                                "name": "Fictional incomplete product",
                                "quantity": None,
                                "unit": "piece",
                                "unit_price": None,
                            }
                        ],
                        "evidence": [{"source_id": sources[0].id, "text": "fictional fragment"}],
                        "missing_reasons": missing_reasons,
                    }
                ],
            }
        )

    monkeypatch.setattr(OpenAICompatibleProvider, "recognize", recognize)
    service = app.state.service
    with TestClient(app) as client:
        client.put("/api/model-settings", headers=AUTH, json=configuration())
        assert enable(client).status_code == 200
        task = upload(client, config_revision=2, confirm_external="true").json()["tasks"][0]
        assert service.process_one() is True
        review = client.get(f"/api/tasks/{task['id']}", headers=AUTH).json()
        assert review["status"] == "review_required"
        event = review["candidate"]["events"][0]
        assert event["customer"] is None
        assert event["items"][0]["quantity"] is None
        assert event["items"][0]["unit_price"] is None
        assert event["missing_reasons"] == missing_reasons
        body = {
            "expected_version": review["version"],
            "idempotency_key": "fictional-incomplete-confirmation",
            "actor": "fictional-human-reviewer",
            "reason": "Fictional regression review",
            "events": [event],
        }
        rejected = client.post(f"/api/tasks/{task['id']}/confirm", headers=AUTH, json=body)
        assert rejected.status_code == 422
        assert rejected.json()["error"]["code"] == "VALIDATION_ERROR"
        assert service.task(task["id"])["status"] == "review_required"
        with connect(service.root) as db:
            assert db.execute("SELECT count(*) FROM orders").fetchone()[0] == 0
            original = json.loads(
                db.execute("SELECT candidate FROM candidate_history").fetchone()[0]
            )
            assert original["events"][0]["customer"] is None
            assert original["events"][0]["items"][0]["quantity"] is None
            assert original["events"][0]["items"][0]["unit_price"] is None

        # Only explicit reviewer-supplied values make this candidate confirmable.
        event["customer"] = "Fictional human-supplied buyer"
        event["items"][0]["quantity"] = "2"
        event["items"][0]["unit_price"] = "3.50"
        event["missing_reasons"] = []
        body["idempotency_key"] = "fictional-completed-confirmation"
        accepted = client.post(f"/api/tasks/{task['id']}/confirm", headers=AUTH, json=body)
        assert accepted.status_code == 200
        assert service.task(task["id"])["status"] == "confirmed"
        orders = client.get("/api/orders", headers=AUTH).json()["orders"]
        assert len(orders) == 1
        assert orders[0]["customer"] == "Fictional human-supplied buyer"
        with connect(service.root) as db:
            original = json.loads(
                db.execute("SELECT candidate FROM candidate_history").fetchone()[0]
            )
            assert original["events"][0]["customer"] is None
            assert original["events"][0]["missing_reasons"] == missing_reasons
