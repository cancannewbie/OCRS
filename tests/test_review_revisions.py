"""Synthetic regression coverage for human revisions and rejected review reopening."""

import copy
import hashlib
import io
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from ocrs.api import create_app
from ocrs.cli import main
from ocrs.config import Settings
from ocrs.service import AppError, CandidateRevision, Confirmation, ReviewReopen, Service
from ocrs.storage import SCHEMA, SCHEMA_VERSION, backup, connect, migrate, transaction

TOKEN = "fictional-revision-local-token-not-a-secret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def service(tmp_path: Path) -> Service:
    migrate(tmp_path)
    return Service(Settings(data_dir=tmp_path, token=TOKEN))


def ready(service: Service, label: str = "fictional-revision") -> dict[str, Any]:
    image = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(image, "PNG")
    task, _ = service.ingest(image.getvalue(), "fictional.png", label)
    assert service.process_one()
    return service.task(task["id"])


def revision(task: dict[str, Any], key: str = "fictional-save-001") -> CandidateRevision:
    candidate = copy.deepcopy(task["candidate"])
    candidate["events"][0]["customer"] = "Corrected fictional customer"
    candidate["events"][0]["items"][0]["quantity"] = "3"
    return CandidateRevision(
        expected_version=task["version"],
        idempotency_key=key,
        actor="fictional-reviewer",
        reason="Correct fictional customer and quantity",
        candidate=candidate,
    )


def reopen(task: dict[str, Any], key: str = "fictional-reopen-001") -> ReviewReopen:
    return ReviewReopen(
        expected_version=task["version"],
        idempotency_key=key,
        actor="fictional-reviewer",
        reason="Submit corrected fictional candidate for another review",
    )


def assert_no_orders(service: Service) -> None:
    with connect(service.root) as db:
        for table in ("orders", "items", "events", "outbox"):
            assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_save_then_explicit_reopen_retains_evidence_and_audit(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = ready(service)
    rejected = service.reject(original["id"], original["version"], "Fictional original rejection")
    with connect(service.root) as db:
        model_history = tuple(db.execute("SELECT * FROM candidate_history").fetchone())

    def no_model(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("Human revision/reopening must never call or configure a model")

    monkeypatch.setattr(service, "runtime_settings", no_model)
    monkeypatch.setattr(service.provider, "recognize", no_model)
    saved = service.save_candidate(rejected["id"], revision(rejected))
    assert saved == {"id": rejected["id"], "status": "rejected", "version": rejected["version"] + 1}
    detail = service.task(rejected["id"])
    assert detail["candidate"]["events"][0]["items"][0]["quantity"] == "3"
    assert detail["model_candidate"] == original["candidate"]
    assert detail["candidate_revisions"][0]["candidate"] == detail["candidate"]
    assert detail["review_history"][0]["reason"] == "Fictional original rejection"
    reopened = service.reopen_review(detail["id"], reopen(detail))
    current = service.task(detail["id"])
    assert reopened == {
        "id": detail["id"],
        "status": "review_required",
        "version": detail["version"] + 1,
    }
    for field in ("attempts", "provider", "duration_ms", "model_revision", "external_authorized"):
        assert current[field] == original[field]
    assert [row["kind"] for row in current["review_history"]] == [
        "rejected",
        "candidate_saved",
        "review_reopened",
    ]
    assert [row["task_version"] for row in current["review_history"]] == [
        rejected["version"],
        saved["version"],
        reopened["version"],
    ]
    assert current["review_history"][-1]["actor"] == "fictional-reviewer"
    assert current["review_history"][-1]["from_status"] == "rejected"
    assert current["review_history"][-1]["to_status"] == "review_required"
    with connect(service.root) as db:
        assert tuple(db.execute("SELECT * FROM candidate_history").fetchone()) == model_history
        responses = [json.loads(row[0]) for row in db.execute("SELECT response FROM requests")]
        assert all(set(response) == {"id", "status", "version"} for response in responses)
    assert_no_orders(service)


def test_review_revision_can_keep_uncertain_fields_null_until_confirmation(
    service: Service,
) -> None:
    task = ready(service)
    request = revision(task)
    request.candidate.events[0].customer = None
    request.candidate.events[0].items[0].quantity = None
    receipt = service.save_candidate(task["id"], request)
    assert receipt["status"] == "review_required"
    current = service.task(task["id"])
    assert current["candidate"]["events"][0]["customer"] is None
    assert current["candidate"]["events"][0]["items"][0]["quantity"] is None
    assert_no_orders(service)


@pytest.mark.parametrize("operation", ["save", "reopen"])
def test_review_mutation_replay_and_changed_payload_conflict(
    service: Service, operation: str
) -> None:
    task = ready(service)
    task = service.reject(task["id"], task["version"], "Synthetic reject")
    action = service.save_candidate if operation == "save" else service.reopen_review
    request = revision(task) if operation == "save" else reopen(task)
    first = action(task["id"], request)
    assert action(task["id"], request) == first
    changed = request.model_copy(update={"reason": "Different fictional reason"})
    with pytest.raises(AppError) as caught:
        action(task["id"], changed)
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    with connect(service.root) as db:
        assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM audit").fetchone()[0] == 2
    assert_no_orders(service)


def test_idempotency_key_is_bound_to_task_and_operation(service: Service) -> None:
    first, second = ready(service, "fictional-first"), ready(service, "fictional-second")
    request = revision(first)
    service.save_candidate(first["id"], request)
    with pytest.raises(AppError) as caught:
        service.save_candidate(second["id"], request)
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    current = service.task(first["id"])
    rejected = service.reject(first["id"], current["version"], "Synthetic reject")
    with pytest.raises(AppError) as caught:
        service.reopen_review(first["id"], reopen(rejected, request.idempotency_key))
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"


@pytest.mark.parametrize(
    "status", ["received", "recognizing", "review_required", "confirmed", "failed"]
)
def test_reopen_rejects_every_non_rejected_state(service: Service, status: str) -> None:
    task = ready(service)
    with transaction(service.root) as db:
        db.execute("UPDATE tasks SET status=? WHERE id=?", (status, task["id"]))
    with pytest.raises(AppError) as caught:
        service.reopen_review(task["id"], reopen(task))
    assert caught.value.code == "STATE_CONFLICT"
    assert service.task(task["id"])["status"] == status
    assert_no_orders(service)


@pytest.mark.parametrize("status", ["received", "recognizing", "confirmed", "failed"])
def test_candidate_save_rejects_non_review_states(service: Service, status: str) -> None:
    task = ready(service)
    with transaction(service.root) as db:
        db.execute("UPDATE tasks SET status=? WHERE id=?", (status, task["id"]))
    with pytest.raises(AppError) as caught:
        service.save_candidate(task["id"], revision(task))
    assert caught.value.code == "STATE_CONFLICT"
    assert service.task(task["id"])["candidate"] == task["candidate"]


@pytest.mark.parametrize("operation", ["save", "reopen"])
def test_review_mutation_checks_version_and_serializes_concurrent_updates(
    service: Service, operation: str
) -> None:
    task = ready(service)
    task = service.reject(task["id"], task["version"], "Synthetic reject")
    barrier = Barrier(2)
    action = service.save_candidate if operation == "save" else service.reopen_review

    def run(index: int) -> str:
        request = (
            revision(task, f"fictional-race-save-{index}")
            if operation == "save"
            else reopen(task, f"fictional-race-reopen-{index}")
        )
        barrier.wait()
        try:
            action(task["id"], request)
            return "saved"
        except AppError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(run, range(2))) == ["VERSION_CONFLICT", "saved"]
    with connect(service.root) as db:
        assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM audit").fetchone()[0] == 2
    assert_no_orders(service)


@pytest.mark.parametrize("operation", ["save", "reopen"])
def test_same_idempotency_key_concurrent_replay_writes_one_mutation(
    service: Service, operation: str
) -> None:
    task = ready(service)
    task = service.reject(task["id"], task["version"], "Fictional rejection")
    request = revision(task) if operation == "save" else reopen(task)
    action = service.save_candidate if operation == "save" else service.reopen_review
    barrier = Barrier(2)

    def run() -> dict[str, Any]:
        barrier.wait()
        return action(task["id"], request)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: run(), range(2)))
    assert results[0] == results[1]
    assert service.task(task["id"])["version"] == task["version"] + 1
    with connect(service.root) as db:
        assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM audit").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM candidate_revisions").fetchone()[0] == (
            1 if operation == "save" else 0
        )
    assert_no_orders(service)


@pytest.mark.parametrize("operation", ["save", "reopen"])
@pytest.mark.parametrize("damage", ["expired", "no_candidate"])
def test_expired_or_missing_candidate_cannot_be_reopened_or_edited(
    service: Service, operation: str, damage: str
) -> None:
    task = ready(service)
    rejected = service.reject(task["id"], task["version"], "Synthetic reject")
    with transaction(service.root) as db:
        if damage == "expired":
            db.execute("UPDATE sources SET expired=1 WHERE id=?", (task["source_id"],))
        else:
            db.execute("UPDATE tasks SET candidate=NULL WHERE id=?", (task["id"],))
    action = service.save_candidate if operation == "save" else service.reopen_review
    request = revision(rejected) if operation == "save" else reopen(rejected)
    with pytest.raises(AppError) as caught:
        action(task["id"], request)
    assert caught.value.code == (
        "EVIDENCE_EXPIRED" if damage == "expired" else "CANDIDATE_REQUIRED"
    )
    assert service.task(task["id"])["status"] == "rejected"


def test_candidate_revision_cannot_attach_another_tasks_evidence(service: Service) -> None:
    task = ready(service)
    request = revision(task)
    request.candidate.events[0].evidence[0].source_id = "fictional-other-source"
    with pytest.raises(AppError) as caught:
        service.save_candidate(task["id"], request)
    assert caught.value.code == "EVIDENCE_INVALID"
    assert service.task(task["id"])["candidate_revisions"] == []


@pytest.mark.parametrize("operation", ["save", "reopen"])
def test_audit_failure_rolls_back_revision_state_and_idempotency(
    service: Service, operation: str
) -> None:
    task = ready(service)
    rejected = service.reject(task["id"], task["version"], "Synthetic reject")
    before = service.task(task["id"])
    action = service.save_candidate if operation == "save" else service.reopen_review
    request = revision(rejected) if operation == "save" else reopen(rejected)
    with transaction(service.root) as db:
        db.execute(
            "CREATE TRIGGER fictional_audit_failure BEFORE INSERT ON audit "
            "BEGIN SELECT RAISE(ABORT, 'fictional audit failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        action(task["id"], request)
    assert service.task(task["id"]) == before
    with transaction(service.root) as db:
        assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 0
        db.execute("DROP TRIGGER fictional_audit_failure")
    assert action(task["id"], request)["version"] == rejected["version"] + 1


@pytest.mark.parametrize(
    "field,value",
    [("actor", "  "), ("reason", "\t"), ("expected_version", True), ("expected_version", "3")],
)
def test_review_request_has_strict_nonblank_contract(field: str, value: Any) -> None:
    payload = {
        "expected_version": 3,
        "actor": "fictional-reviewer",
        "reason": "fictional reason",
        "idempotency_key": "fictional-key-001",
        field: value,
    }
    with pytest.raises(ValidationError):
        ReviewReopen.model_validate(payload)


def test_corrected_reopened_candidate_still_requires_human_confirmation(service: Service) -> None:
    task = ready(service)
    rejected = service.reject(task["id"], task["version"], "Synthetic reject")
    service.save_candidate(task["id"], revision(rejected))
    current = service.task(task["id"])
    service.reopen_review(task["id"], reopen(current))
    current = service.task(task["id"])
    assert_no_orders(service)
    service.confirm(
        task["id"],
        Confirmation(
            expected_version=current["version"],
            idempotency_key="fictional-confirm-001",
            actor="fictional-reviewer",
            reason="Final fictional manual confirmation",
            events=current["candidate"]["events"],
        ),
    )
    assert service.orders()[0]["customer"] == "Corrected fictional customer"
    assert service.orders()[0]["items"][0]["quantity"] == "3"
    assert service.task(task["id"])["model_candidate"] == task["candidate"]


@pytest.mark.parametrize("old_version", [1, 2])
def test_migration_preserves_old_model_candidate_and_rejection(
    tmp_path: Path, old_version: int
) -> None:
    with connect(tmp_path) as db:
        db.executescript(SCHEMA + "PRAGMA user_version=1;")
        if old_version == 2:
            db.executescript(
                "ALTER TABLE tasks ADD COLUMN model_revision INTEGER NOT NULL DEFAULT -1;"
                "ALTER TABLE tasks ADD COLUMN external_authorized INTEGER NOT NULL DEFAULT 0;"
                "PRAGMA user_version=2;"
            )
        db.execute(
            "INSERT INTO sources VALUES('fictional-source','digest','label','fictional.png',"
            "'image/png','images/fictional.png','2000-01-01',0)"
        )
        db.execute(
            "INSERT INTO tasks(id,source_id,status,provider,created_at,updated_at) "
            "VALUES('fictional-task','fictional-source','rejected','demo','2000-01-01','2000-01-01')"
        )
        db.execute(
            "INSERT INTO audit(kind,record_id,actor,reason,created_at) "
            "VALUES('rejected','fictional-task','old-fictional-reviewer',"
            "'Old fictional rejection','2000-01-01')"
        )
    migrate(tmp_path)
    migrate(tmp_path)
    service = Service(Settings(tmp_path, TOKEN))
    detail = service.task("fictional-task")
    assert detail["status"] == "rejected"
    assert detail["review_history"][0]["reason"] == "Old fictional rejection"
    assert detail["review_history"][0]["task_version"] is None
    assert detail["candidate_revisions"] == []
    with connect(tmp_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 4
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("old_version", [1, 2])
def test_restore_older_backup_migrates_without_losing_rejected_model_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, old_version: int
) -> None:
    source, bundle, restored = (tmp_path / name for name in ("old", "bundle", "restored"))
    (source / "images").mkdir(parents=True)
    picture = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(picture, "PNG")
    data = picture.getvalue()
    (source / "images" / "fictional.png").write_bytes(data)
    candidate = {"schema_version": "1", "events": [{"action": "create", "customer": None}]}
    payload = json.dumps(candidate)
    with connect(source) as db:
        db.executescript(SCHEMA + "PRAGMA user_version=1;")
        if old_version == 2:
            db.executescript(
                "ALTER TABLE tasks ADD COLUMN model_revision INTEGER NOT NULL DEFAULT -1;"
                "ALTER TABLE tasks ADD COLUMN external_authorized INTEGER NOT NULL DEFAULT 0;"
                "PRAGMA user_version=2;"
            )
        db.execute(
            "INSERT INTO sources VALUES('fictional-source',?,'label','fictional.png',"
            "'image/png','images/fictional.png','2000-01-01',0)",
            (hashlib.sha256(data).hexdigest(),),
        )
        db.execute(
            "INSERT INTO tasks(id,source_id,status,provider,candidate,created_at,updated_at) "
            "VALUES('fictional-task','fictional-source','rejected','demo',?,'2000-01-01','2000-01-01')",
            (payload,),
        )
        db.execute(
            "INSERT INTO candidate_history(task_id,attempt,candidate,created_at,model,"
            "prompt_version,input_digest) VALUES('fictional-task',1,?,'2000-01-01','demo','1',?)",
            (payload, hashlib.sha256(data).hexdigest()),
        )
        db.execute(
            "INSERT INTO audit(kind,record_id,actor,reason,created_at) "
            "VALUES('rejected','fictional-task','old-reviewer',"
            "'Fictional old rejection','2000-01-01')"
        )
    backup(source, bundle)
    monkeypatch.setenv("OCRS_DATA_DIR", str(restored))
    monkeypatch.setenv("OCRS_ACCESS_TOKEN", "")
    monkeypatch.setattr(sys, "argv", ["ocrs", "restore", str(bundle)])
    main()
    detail = Service(Settings(restored, TOKEN)).task("fictional-task")
    assert detail["status"] == "rejected"
    assert detail["candidate"] == detail["model_candidate"] == candidate
    assert detail["review_history"][0]["reason"] == "Fictional old rejection"
    with connect(restored) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_backup_restore_and_purge_preserve_audit_but_remove_candidate_revisions(
    service: Service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = ready(service)
    rejected = service.reject(task["id"], task["version"], "Fictional retained rejection")
    service.save_candidate(task["id"], revision(rejected))
    service.reopen_review(task["id"], reopen(service.task(task["id"])))
    detail = service.task(task["id"])
    bundle = tmp_path.parent / f"{tmp_path.name}-review-backup"
    restored = tmp_path.parent / f"{tmp_path.name}-review-restored"
    backup(service.root, bundle)
    monkeypatch.setenv("OCRS_DATA_DIR", str(restored))
    monkeypatch.setenv("OCRS_ACCESS_TOKEN", "")
    monkeypatch.setattr(sys, "argv", ["ocrs", "restore", str(bundle)])
    main()
    recovered = Service(Settings(restored, TOKEN))
    recovered.recover()
    current = recovered.task(task["id"])
    for field in (
        "candidate",
        "model_candidate",
        "candidate_revisions",
        "review_history",
        "status",
        "version",
    ):
        assert current[field] == detail[field]
    with transaction(restored) as db:
        db.execute("UPDATE sources SET created_at='2000-01-01T00:00:00+00:00'")
    monkeypatch.setattr(sys, "argv", ["ocrs", "purge-evidence", "--days", "1", "--confirm"])
    main()
    purged = recovered.task(task["id"])
    assert purged["candidate"] is purged["model_candidate"] is None
    assert purged["candidate_revisions"] == []
    assert purged["review_history"] == detail["review_history"]
    with connect(restored) as db:
        assert db.execute("SELECT count(*) FROM candidate_revisions").fetchone()[0] == 0
        for row in db.execute("SELECT response FROM requests"):
            assert "Corrected fictional customer" not in row[0]


def test_http_revision_reopen_and_conflicts_are_authenticated_and_value_safe(
    tmp_path: Path,
) -> None:
    migrate(tmp_path)
    with TestClient(create_app(Settings(tmp_path, TOKEN), start_worker=False)) as client:
        service = client.app.state.service
        task = ready(service)
        task = service.reject(task["id"], task["version"], "Fictional HTTP rejection")
        save_url, reopen_url = (
            f"/api/tasks/{task['id']}/candidate",
            f"/api/tasks/{task['id']}/reopen",
        )
        payload = revision(task).model_dump(mode="json")
        assert client.put(save_url, json=payload).status_code == 401
        saved = client.put(save_url, headers=AUTH, json=payload)
        assert saved.status_code == 200 and saved.json()["status"] == "rejected"
        assert client.put(save_url, headers=AUTH, json=payload).json() == saved.json()
        stale = client.post(reopen_url, headers=AUTH, json=reopen(task).model_dump(mode="json"))
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"
        detail = client.get(f"/api/tasks/{task['id']}", headers=AUTH).json()
        payload = reopen(detail).model_dump(mode="json")
        assert client.post(reopen_url, json=payload).status_code == 401
        response = client.post(reopen_url, headers=AUTH, json=payload)
        assert response.status_code == 200 and response.json()["status"] == "review_required"
        malformed = {
            **payload,
            "reason": "PRIVATE-FICTIONAL-REASON",
            "unexpected": "PRIVATE-FICTIONAL-TEXT",
        }
        error = client.post(reopen_url, headers=AUTH, json=malformed)
        assert error.status_code == 422
        assert "PRIVATE-FICTIONAL" not in error.text
        assert (
            client.get(f"/api/tasks/{task['id']}", headers=AUTH).json()["review_history"][0][
                "reason"
            ]
            == "Fictional HTTP rejection"
        )


@pytest.mark.parametrize("field", ["customer", "quantity"])
def test_http_uncertain_saved_revision_cannot_be_confirmed(tmp_path: Path, field: str) -> None:
    migrate(tmp_path)
    with TestClient(create_app(Settings(tmp_path, TOKEN), start_worker=False)) as client:
        service = client.app.state.service
        task = ready(service)
        request = revision(task)
        if field == "customer":
            request.candidate.events[0].customer = None
        else:
            request.candidate.events[0].items[0].quantity = None
        saved = client.put(
            f"/api/tasks/{task['id']}/candidate",
            headers=AUTH,
            json=request.model_dump(mode="json"),
        )
        assert saved.status_code == 200
        current = service.task(task["id"])
        response = client.post(
            f"/api/tasks/{task['id']}/confirm",
            headers=AUTH,
            json={
                "expected_version": current["version"],
                "idempotency_key": "fictional-null-confirm",
                "actor": "fictional-reviewer",
                "reason": "Attempt incomplete fictional candidate",
                "events": current["candidate"]["events"],
            },
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        assert service.task(task["id"])["status"] == "review_required"
        assert_no_orders(service)
