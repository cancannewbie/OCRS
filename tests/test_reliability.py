"""Synthetic regressions for paginated review and transactional recovery boundaries."""

import io
import sqlite3
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

import ocrs.service as service_module
from ocrs.config import Settings
from ocrs.service import AppError, Confirmation, Service
from ocrs.storage import connect, migrate, transaction


@pytest.fixture
def service(tmp_path: Path) -> Service:
    migrate(tmp_path)
    return Service(Settings(tmp_path, "synthetic-reliability-token-" * 2))


def picture() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, "PNG")
    return stream.getvalue()


def ready(service: Service, label: str = "fictional-source") -> dict[str, Any]:
    task, _ = service.ingest(picture(), "fictional.png", label)
    assert service.process_one()
    return service.task(task["id"])


def confirmation(task: dict[str, Any], key: str = "reliability-request-0001") -> Confirmation:
    return Confirmation(
        expected_version=task["version"],
        idempotency_key=key,
        actor="fictional-reviewer",
        reason="Reviewed synthetic image",
        events=task["candidate"]["events"],
    )


def test_pagination_keeps_older_actionable_tasks_discoverable(service: Service) -> None:
    oldest = ready(service)
    with transaction(service.root) as db:
        for index in range(501):
            db.execute(
                "INSERT INTO tasks(id,source_id,status,provider,created_at,updated_at) "
                "VALUES(?,?,'rejected','demo',?,?)",
                (f"newer-{index:04d}", oldest["source_id"], "2099-01-01", "2099-01-01"),
            )
    first = service.task_page(limit=100)
    assert first["total"] == 502 and first["has_more"]
    assert len(first["tasks"]) == 100
    last = service.task_page(limit=100, offset=500)
    assert len(last["tasks"]) == 2 and not last["has_more"]
    assert oldest["id"] in {task["id"] for task in last["tasks"]}
    filtered = service.task_page(status="review_required")
    assert filtered["total"] == 1 and filtered["tasks"][0]["id"] == oldest["id"]
    repeated = service.task_page(limit=100)
    assert [task["id"] for task in repeated["tasks"]] == [task["id"] for task in first["tasks"]]


def test_task_search_and_processing_group_are_server_side_and_literal(service: Service) -> None:
    task, _ = service.ingest(picture(), "Fictional_%_Image.png", "Inbox_%_Label")
    assert service.task_page(status="processing")["total"] == 1
    assert service.task_page(q="fictional_%_")["total"] == 1
    assert service.task_page(q="inbox_%_")["total"] == 1
    assert service.task_page(q=task["id"])["total"] == 1
    assert service.task_page(q="missing%")["total"] == 0
    service.process_one()
    assert service.task_page(status="processing")["total"] == 0
    # Customer data is deliberately not part of the documented search scope.
    assert service.task_page(q="DEMO ONLY")["total"] == 0


@pytest.mark.parametrize(
    "arguments",
    [
        {"limit": 0},
        {"limit": 501},
        {"limit": True},
        {"offset": -1},
        {"status": "unknown"},
        {"q": "x" * 201},
    ],
)
def test_task_pagination_rejects_invalid_arguments(
    service: Service, arguments: dict[str, Any]
) -> None:
    with pytest.raises(AppError) as caught:
        service.task_page(**arguments)
    assert caught.value.code == "VALIDATION_ERROR"


def test_committed_confirmation_replay_survives_catalog_change(service: Service) -> None:
    task = ready(service)
    request = confirmation(task)
    result = service.confirm(task["id"], request)
    restarted = Service(replace(service.settings, sku_catalog=frozenset({"NEW-SKU"})))
    assert restarted.confirm(task["id"], request) == result
    changed = request.model_copy(update={"reason": "Different synthetic review"})
    with pytest.raises(AppError) as caught:
        restarted.confirm(task["id"], changed)
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert len(restarted.orders()) == 1


@pytest.mark.parametrize("reverse", [False, True])
def test_mixed_amend_create_duplicate_rolls_back_then_requires_acknowledgement(
    service: Service, reverse: bool
) -> None:
    first = ready(service)
    service.confirm(first["id"], confirmation(first))
    original = service.orders()
    task = ready(service, "mixed-batch")
    request = confirmation(task, "mixed-batch-request")
    create = request.events[0]
    create.items[0].quantity = "3"  # type: ignore[assignment]
    amend = create.model_copy(deep=True)
    amend.action = "amend"
    amend.target_order_id = original[0]["id"]
    amend.expected_order_version = 1
    amend.reason = "Synthetic quantity correction"
    request.events = [create, amend] if reverse else [amend, create]
    with pytest.raises(AppError) as caught:
        service.confirm(task["id"], request)
    assert caught.value.code == "DUPLICATE_WARNING"
    assert service.orders() == original
    assert service.task(task["id"])["status"] == "review_required"
    with connect(service.root) as db:
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM outbox").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 1
    request.acknowledge_duplicates = True
    service.confirm(task["id"], request)
    assert len(service.orders()) == 2
    assert {order["items"][0]["quantity"] for order in service.orders()} == {"3"}


def test_amendment_that_introduces_duplicate_requires_acknowledgement(service: Service) -> None:
    first = ready(service)
    service.confirm(first["id"], confirmation(first))
    second = ready(service, "second-order")
    request = confirmation(second, "different-order-request")
    request.events[0].customer = "Another fictional customer"
    service.confirm(second["id"], request)
    other = next(
        order for order in service.orders() if order["customer"] == "Another fictional customer"
    )
    task = ready(service, "amend-second-order")
    request = confirmation(task, "amend-duplicate-request")
    event = request.events[0]
    event.action = "amend"
    event.target_order_id = other["id"]
    event.expected_order_version = 1
    event.reason = "Synthetic customer correction"
    with pytest.raises(AppError) as caught:
        service.confirm(task["id"], request)
    assert caught.value.code == "DUPLICATE_WARNING"
    assert all(order["version"] == 1 for order in service.orders())


def test_same_batch_cancellation_removes_duplicate_from_final_state(service: Service) -> None:
    first = ready(service)
    service.confirm(first["id"], confirmation(first))
    original = service.orders()[0]
    task = ready(service, "replace-cancelled")
    request = confirmation(task, "replace-cancelled-request")
    create = request.events[0]
    cancel = create.model_copy(deep=True)
    cancel.action = "cancel"
    cancel.target_order_id = original["id"]
    cancel.expected_order_version = 1
    cancel.reason = "Cancel synthetic original"
    cancel.items = []
    request.events = [cancel, create]
    service.confirm(task["id"], request)
    assert sorted(order["status"] for order in service.orders()) == ["cancelled", "confirmed"]


def test_ingest_database_failure_removes_unreferenced_evidence(service: Service) -> None:
    with transaction(service.root) as db:
        db.execute(
            "CREATE TRIGGER fail_ingest BEFORE INSERT ON tasks BEGIN "
            "SELECT RAISE(ABORT,'synthetic database fault'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        service.ingest(picture(), "fictional.png", "failing-source")
    assert list((service.root / "images").iterdir()) == []
    with connect(service.root) as db:
        assert db.execute("SELECT count(*) FROM sources").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


def test_startup_reconciles_crashed_ingest_without_deleting_retained_or_unknown_files(
    service: Service,
) -> None:
    task, _ = service.ingest(picture(), "fictional.png", "retained-source")
    orphan = service.root / "images" / f"{uuid.uuid4()}.png"
    orphan.write_bytes(picture())
    unrelated = service.root / "images" / "operator-owned.png"
    unrelated.write_bytes(picture())
    with connect(service.root) as db:
        retained = (
            service.root
            / db.execute("SELECT path FROM sources WHERE id=?", (task["source_id"],)).fetchone()[0]
        )
    service.recover()
    assert not orphan.exists()
    assert retained.read_bytes() == picture()
    assert unrelated.read_bytes() == picture()
    assert service.task(task["id"])["status"] == "received"


def test_orders_read_uses_one_snapshot_during_concurrent_amendment(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = ready(service)
    service.confirm(first["id"], confirmation(first))
    original = service.orders()
    task = ready(service, "concurrent-amendment")
    request = confirmation(task, "concurrent-amendment-request")
    event = request.events[0]
    event.action = "amend"
    event.target_order_id = original[0]["id"]
    event.expected_order_version = 1
    event.reason = "Synthetic currency correction"
    event.currency = "JPY"
    event.items[0].unit_price = "999"  # type: ignore[assignment]
    triggered = False

    def traced_connection(root: Path) -> sqlite3.Connection:
        connection = connect(root)

        def trace(sql: str) -> None:
            nonlocal triggered
            if "SELECT line_id,sku" in sql and not triggered:
                triggered = True
                service.confirm(task["id"], request)

        connection.set_trace_callback(trace)
        return connection

    monkeypatch.setattr(service_module, "connect", traced_connection)
    assert service.orders() == original
    assert triggered
    latest = service.orders()[0]
    assert (latest["version"], latest["currency"], latest["items"][0]["unit_price"]) == (
        2,
        "JPY",
        "999",
    )


def test_export_status_includes_safe_timestamp_and_metadata(service: Service) -> None:
    result = service.export()
    status = service.status()["export"]
    assert status["created_at"]
    assert status["metadata"]["sha256"] == result["sha256"]
    assert status["metadata"]["order_count"] == 0
    assert "path" not in status


def test_status_uses_one_snapshot_while_recognition_completes(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    service.ingest(picture(), "fictional.png", "status-snapshot")
    triggered = False

    def traced_connection(root: Path) -> sqlite3.Connection:
        connection = connect(root)

        def trace(sql: str) -> None:
            nonlocal triggered
            if "SELECT id,status,error_code,created_at,metadata" in sql and not triggered:
                triggered = True
                assert service.process_one()

        connection.set_trace_callback(trace)
        return connection

    monkeypatch.setattr(service_module, "connect", traced_connection)
    status = service.status()
    assert triggered and status["counts"] == {"received": 1}
    assert status["recognition_avg_ms"] is None
    assert service.status()["counts"] == {"review_required": 1}


def test_page_count_and_rows_use_one_snapshot_during_ingestion(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    original, _ = service.ingest(picture(), "fictional.png", "original-snapshot")
    triggered = False

    def traced_connection(root: Path) -> sqlite3.Connection:
        connection = connect(root)

        def trace(sql: str) -> None:
            nonlocal triggered
            if "SELECT t.id FROM tasks" in sql and not triggered:
                triggered = True
                service.ingest(picture(), "fictional.png", "concurrent-snapshot")

        connection.set_trace_callback(trace)
        return connection

    monkeypatch.setattr(service_module, "connect", traced_connection)
    page = service.task_page()
    assert triggered and page["total"] == 1
    assert [task["id"] for task in page["tasks"]] == [original["id"]]
    assert not page["has_more"]
    assert service.task_page()["total"] == 2


def test_delayed_retry_cannot_queue_another_attempt_after_a_new_failure(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ocrs.providers import ProviderError

    def fail(*args: object) -> Any:
        raise ProviderError("provider_timeout")

    monkeypatch.setattr(service.provider, "recognize", fail)
    task, _ = service.ingest(picture(), "fictional.png", "retry-version")
    assert service.process_one()
    failed = service.task(task["id"])
    assert failed["attempts"] == 1
    service.retry(task["id"], expected_version=failed["version"])
    assert service.process_one()
    new_failure = service.task(task["id"])
    assert new_failure["attempts"] == 2
    with pytest.raises(AppError) as caught:
        service.retry(task["id"], expected_version=failed["version"])
    assert caught.value.code == "VERSION_CONFLICT"
    assert service.task(task["id"]) == new_failure
    assert not service.process_one()
    service.retry(task["id"], expected_version=new_failure["version"])
    assert service.task(task["id"])["status"] == "received"
