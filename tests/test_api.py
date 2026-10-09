"""Offline HTTP acceptance and boundary security tests with synthetic images."""

import asyncio
import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ocrs.api import create_app
from ocrs.config import Settings
from ocrs.security import RequestGuard
from ocrs.storage import connect, migrate, transaction

TOKEN = "synthetic-api-token-not-a-real-secret-0001"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    migrate(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path, token=TOKEN), start_worker=False)
    ) as test:
        yield test


def picture() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="PNG")
    return stream.getvalue()


def upload(client: TestClient, filename: str = "fictional.png") -> dict[str, Any]:
    response = client.post(
        "/api/uploads",
        headers=AUTH,
        files=[("files", (filename, picture(), "image/png"))],
        data={"source_label": "fictional-chat"},
    )
    assert response.status_code == 200
    return response.json()["tasks"][0]


def ready_payload(client: TestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    task = upload(client)
    assert client.app.state.service.process_one()
    task = client.get(f"/api/tasks/{task['id']}", headers=AUTH).json()
    return task, {
        "expected_version": task["version"],
        "idempotency_key": "api-synthetic-request",
        "actor": "fictional-operator",
        "reason": "Checked synthetic sample",
        "events": task["candidate"]["events"],
    }


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/status"),
        ("GET", "/api/tasks"),
        ("GET", "/api/tasks/example"),
        ("POST", "/api/uploads"),
        ("GET", "/api/sources/example"),
        ("POST", "/api/tasks/example/retry"),
        ("POST", "/api/tasks/example/reject"),
        ("POST", "/api/tasks/example/confirm"),
        ("GET", "/api/orders"),
        ("GET", "/api/orders/example/history"),
        ("POST", "/api/export"),
        ("GET", "/api/export/download"),
    ],
)
@pytest.mark.parametrize("authorization", [None, "Bearer incorrect-token"])
def test_every_sensitive_endpoint_requires_authentication(
    client: TestClient,
    method: str,
    path: str,
    authorization: str | None,
) -> None:
    headers = {} if authorization is None else {"Authorization": authorization}
    response = client.request(method, path, headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"
    assert response.headers["cache-control"] == "no-store"
    assert TOKEN not in response.text


def test_unauthorized_malformed_body_is_rejected_before_parsing(client: TestClient) -> None:
    response = client.post(
        "/api/tasks/example/confirm",
        content="{invalid-json",
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 401
    response = client.post(
        "/api/uploads",
        content="not-multipart",
        headers={"Content-Type": "multipart/form-data; boundary=bad"},
    )
    assert response.status_code == 401


def test_full_upload_review_download_flow(client: TestClient) -> None:
    task, payload = ready_payload(client)
    source = client.get(task["sources"][0]["url"], headers=AUTH)
    assert source.status_code == 200 and source.content == picture()
    assert source.headers["content-type"] == "image/png"
    assert client.get("/api/orders", headers=AUTH).json() == {"orders": []}
    response = client.post(f"/api/tasks/{task['id']}/confirm", json=payload, headers=AUTH)
    assert response.status_code == 200
    order_id = response.json()["orders"][0]
    order = client.get("/api/orders", headers=AUTH).json()["orders"][0]
    assert order["id"] == order_id
    history = client.get(f"/api/orders/{order_id}/history", headers=AUTH).json()["events"]
    assert len(history) == 1 and history[0]["action"] == "create"
    assert client.post("/api/export", headers=AUTH).status_code == 200
    exported = client.get("/api/export/download", headers=AUTH)
    assert exported.status_code == 200 and exported.content.startswith(b"PK")
    assert "attachment" in exported.headers["content-disposition"]
    assert "frame-ancestors 'none'" in exported.headers["content-security-policy"]


def test_upload_duplicate_returns_original_task(client: TestClient) -> None:
    first = upload(client)
    repeated = client.post(
        "/api/uploads",
        headers=AUTH,
        files=[("files", ("other.png", picture(), "image/png"))],
        data={"source_label": "fictional-chat"},
    )
    assert repeated.json()["duplicates"] == [first["id"]]
    assert repeated.json()["tasks"][0]["id"] == first["id"]


@pytest.mark.parametrize("bad", [b"not-an-image", b"<svg onload='alert(1)'/>", b"\x89PNG\r\n"])
def test_invalid_upload_batch_creates_nothing(client: TestClient, bad: bytes) -> None:
    response = client.post(
        "/api/uploads",
        headers=AUTH,
        files=[
            ("files", ("good.png", picture(), "image/png")),
            ("files", ("bad.png", bad, "image/png")),
        ],
    )
    assert response.status_code == 400
    assert client.get("/api/tasks", headers=AUTH).json()["tasks"] == []
    assert not list((client.app.state.service.root / "images").iterdir())


def test_long_filename_rejects_batch_without_partial_import(client: TestClient) -> None:
    response = client.post(
        "/api/uploads",
        headers=AUTH,
        files=[
            ("files", ("valid.png", picture(), "image/png")),
            ("files", ("x" * 256 + ".png", picture(), "image/png")),
        ],
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "SOURCE_INVALID"
    assert client.get("/api/tasks", headers=AUTH).json()["tasks"] == []


def test_filename_traversal_is_never_used_as_storage_path(client: TestClient) -> None:
    task = upload(client, "../../outside.png")
    assert task["sources"][0]["filename"] == "outside.png"
    root = client.app.state.service.root
    with connect(root) as db:
        path = Path(db.execute("SELECT path FROM sources").fetchone()[0])
    assert path.parts[0] == "images" and ".." not in path.parts
    assert (root / path).is_file()
    response = client.get("/api/sources/..%2F..%2Faccess-token", headers=AUTH)
    assert response.status_code == 404 and TOKEN not in response.text


@pytest.mark.parametrize(
    "body_change",
    [
        {"unknown_field": "SYNTHETIC_PRIVATE_VALUE"},
        {"expected_version": 0},
    ],
)
def test_schema_errors_do_not_echo_request_values(
    client: TestClient,
    body_change: dict[str, Any],
) -> None:
    task, payload = ready_payload(client)
    payload.update(body_change)
    response = client.post(f"/api/tasks/{task['id']}/confirm", json=payload, headers=AUTH)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "SYNTHETIC_PRIVATE_VALUE" not in response.text
    assert client.get("/api/orders", headers=AUTH).json()["orders"] == []


def test_missing_sku_has_controlled_validation_error(client: TestClient) -> None:
    task, payload = ready_payload(client)
    payload["events"][0]["items"][0]["sku"] = None
    response = client.post(f"/api/tasks/{task['id']}/confirm", json=payload, headers=AUTH)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_expired_evidence_is_not_viewable_or_confirmable(client: TestClient) -> None:
    task, payload = ready_payload(client)
    with transaction(client.app.state.service.root) as db:
        db.execute("UPDATE sources SET expired=1")
    response = client.get(task["sources"][0]["url"], headers=AUTH)
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "EVIDENCE_EXPIRED"
    response = client.post(f"/api/tasks/{task['id']}/confirm", json=payload, headers=AUTH)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EVIDENCE_EXPIRED"


def test_cross_origin_and_untrusted_host_requests_are_denied(client: TestClient) -> None:
    response = client.get("/api/status", headers={**AUTH, "Origin": "https://attacker.invalid"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_DENIED"
    assert (
        client.get("/api/status", headers={**AUTH, "Host": "attacker.invalid"}).status_code == 400
    )


def test_large_declared_body_rejected_before_reading(client: TestClient) -> None:
    response = client.post(
        "/api/uploads",
        content=b"",
        headers={
            **AUTH,
            "Content-Length": str(100 * 1024 * 1024),
        },
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "UPLOAD_TOO_LARGE"


def test_guard_bounds_chunked_bodies_and_does_not_read_unauthorized_body() -> None:
    async def check(authenticated: bool) -> None:
        reads = 0
        messages: list[dict[str, Any]] = []

        async def app(scope: Any, receive: Any, send: Any) -> None:
            await receive()
            await receive()

        async def receive() -> Any:
            nonlocal reads
            reads += 1
            return {"type": "http.request", "body": b"123456", "more_body": reads == 1}

        async def send(message: Any) -> None:
            messages.append(message)

        scope = {
            "type": "http",
            "path": "/api/uploads",
            "method": "POST",
            "headers": [(b"authorization", f"Bearer {TOKEN}".encode())] if authenticated else [],
        }
        await RequestGuard(app, TOKEN, max_bytes=10)(scope, receive, send)
        assert messages[0]["status"] == (413 if authenticated else 401)
        assert reads == (2 if authenticated else 0)

    asyncio.run(check(True))
    asyncio.run(check(False))


def test_actual_chunked_json_body_gets_size_error(tmp_path: Path) -> None:
    migrate(tmp_path)
    settings = Settings(data_dir=tmp_path, token=TOKEN, max_upload_bytes=1)
    with TestClient(create_app(settings, start_worker=False)) as client:
        response = client.post(
            "/api/tasks/example/confirm",
            headers={**AUTH, "Content-Type": "application/json"},
            content=iter([b'{"reason":"', b"a" * 70_000, b'"}']),
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "UPLOAD_TOO_LARGE"
