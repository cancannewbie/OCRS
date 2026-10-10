"""Offline CLI backup, restore, migration and retained-evidence checks."""

import io
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest
from filelock import FileLock, Timeout
from PIL import Image

from ocrs.cli import main
from ocrs.config import Settings
from ocrs.service import Confirmation, Service
from ocrs.storage import backup, connect, migrate, transaction


def invoke(monkeypatch: pytest.MonkeyPatch, root: Path, *arguments: str) -> None:
    monkeypatch.setenv("OCRS_DATA_DIR", str(root))
    monkeypatch.delenv("OCRS_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(sys, "argv", ["ocrs", *arguments])
    main()


def populated(root: Path) -> tuple[Service, dict[str, Any]]:
    migrate(root)
    service = Service(Settings(data_dir=root, token="synthetic-cli-token-" * 3))
    image = io.BytesIO()
    Image.new("RGB", (10, 10), "white").save(image, format="PNG")
    task, _ = service.ingest(image.getvalue(), "fictional.png", "fictional-source")
    assert service.process_one()
    task = service.task(task["id"])
    service.confirm(
        task["id"],
        Confirmation(
            expected_version=task["version"],
            idempotency_key="cli-confirm-request-0001",
            actor="fictional-operator",
            reason="Checked synthetic image",
            events=task["candidate"]["events"],
        ),
    )
    return service, task


def test_init_is_idempotent_and_token_is_private(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    root = tmp_path / "new-data"
    invoke(monkeypatch, root, "init")
    token = (root / "access-token").read_text().strip()
    assert len(token) >= 32
    assert token not in capsys.readouterr().out
    invoke(monkeypatch, root, "init")
    assert (root / "access-token").read_text().strip() == token
    if os.name == "posix":
        assert (root / "access-token").stat().st_mode & 0o777 == 0o600
        assert root.stat().st_mode & 0o777 == 0o700
    capsys.readouterr()
    invoke(monkeypatch, root, "token")
    assert capsys.readouterr().out.strip() == token
    with connect(root) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_backup_restore_preserves_references_order_versions_and_replays_outbox(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = tmp_path / "original"
    service, task = populated(original)
    invoke(monkeypatch, original, "init")
    original_token = (original / "access-token").read_text()
    service.export()
    snapshot = service.orders()
    bundle = tmp_path / "bundle"
    invoke(monkeypatch, original, "backup", str(bundle))
    assert not (bundle / "access-token").exists()
    assert not (bundle / "exports").exists()
    restored = tmp_path / "restored"
    invoke(monkeypatch, restored, "restore", str(bundle))
    assert (restored / "access-token").read_text() != original_token
    new = Service(Settings(data_dir=restored, token="synthetic-restored-token-" * 2))
    assert new.orders() == snapshot
    assert new.task(task["id"])["status"] == "confirmed"
    with connect(restored) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT count(*) FROM exports").fetchone()[0] == 0
        assert db.execute("SELECT status,export_id FROM outbox").fetchone()[:] == ("pending", None)
        rows = db.execute("SELECT path FROM sources WHERE expired=0").fetchall()
        assert all((restored / row[0]).is_file() for row in rows)
    new.recover()
    assert new.export()["order_count"] == 1
    assert new.status()["pending_export_events"] == 0


def test_restore_refuses_existing_target_without_changing_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    populated(source)
    target = tmp_path / "existing"
    target.mkdir()
    sentinel = target / "do-not-replace"
    sentinel.write_text("synthetic content")
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(source))
    assert sentinel.read_text() == "synthetic content"
    assert not (target / "ocrs.sqlite3").exists()


@pytest.mark.parametrize(
    "path",
    ["../outside.png", "/tmp/fictional-absolute.png", "images/missing.png", "ocrs.sqlite3", ""],
)
def test_restore_rejects_unsafe_or_missing_image_reference_before_copying(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    source = tmp_path / "source"
    populated(source)
    with transaction(source) as db:
        db.execute("UPDATE sources SET path=?", (path,))
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(source))
    assert not target.exists()


def test_restore_rejects_symlink_in_backup_before_copying(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    populated(source)
    with connect(source) as db:
        path = source / db.execute("SELECT path FROM sources").fetchone()[0]
    outside = tmp_path / "outside.png"
    outside.write_bytes(path.read_bytes())
    path.unlink()
    path.symlink_to(outside)
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(source))
    assert not target.exists()


def test_restore_rejects_future_schema_before_copying(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    populated(source)
    with connect(source) as db:
        db.execute("PRAGMA user_version=999")
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(source))
    assert not target.exists()


def test_restore_rejects_broken_foreign_key_before_copying(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    populated(source)
    with sqlite3.connect(source / "ocrs.sqlite3") as db:
        db.execute("UPDATE items SET order_id='nonexistent-order'")
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(source))
    assert not target.exists()


def test_backup_requires_service_to_be_stopped(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    populated(source)
    destination = tmp_path / "bundle"
    with FileLock(str(source / "service.lock"), timeout=0):
        with pytest.raises(Timeout):
            invoke(monkeypatch, source, "backup", str(destination))
    assert not destination.exists()


def test_backup_rejects_nested_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    populated(tmp_path)
    destination = tmp_path / "images" / "recursive-backup"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, tmp_path, "backup", str(destination))
    assert not destination.exists()


def test_migration_refuses_newer_schema_without_mutation(tmp_path: Path) -> None:
    migrate(tmp_path)
    with connect(tmp_path) as db:
        db.execute("PRAGMA user_version=999")
    with pytest.raises(RuntimeError, match="DATABASE_VERSION_NEWER"):
        migrate(tmp_path)
    with connect(tmp_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 999


def test_expired_evidence_requires_explicit_purge_and_preserves_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, task = populated(tmp_path)
    snapshot = service.orders()
    with transaction(tmp_path) as db:
        db.execute("UPDATE sources SET created_at='2000-01-01T00:00:00+00:00'")
    with pytest.raises(SystemExit):
        invoke(monkeypatch, tmp_path, "purge-evidence", "--days", "1")
    assert len(list((tmp_path / "images").iterdir())) == 1
    invoke(monkeypatch, tmp_path, "purge-evidence", "--days", "1", "--confirm")
    assert service.orders() == snapshot
    assert service.task(task["id"])["sources"][0]["expired"] == 1
    assert service.task(task["id"])["candidate"] is None
    assert not list((tmp_path / "images").iterdir())
    with connect(tmp_path) as db:
        assert db.execute("SELECT count(*) FROM candidate_history").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 1
    bundle = tmp_path.parent / f"{tmp_path.name}-purged-backup"
    backup(tmp_path, bundle)
    restored = tmp_path.parent / f"{tmp_path.name}-purged-restored"
    invoke(monkeypatch, restored, "restore", str(bundle))
    assert Service(Settings(restored, "synthetic-restored-token-" * 2)).orders() == snapshot
