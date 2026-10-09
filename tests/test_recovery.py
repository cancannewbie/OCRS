"""Synthetic failure injection for evidence retention and recovery integrity."""

import io
import os
import shutil
import sqlite3
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from PIL import Image

from ocrs.cli import main
from ocrs.config import Settings
from ocrs.service import Service
from ocrs.storage import EvidenceIntegrityError, backup, connect, migrate, transaction


def image_bytes(color: str) -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(stream, "PNG")
    return stream.getvalue()


def populated(root: Path) -> Service:
    migrate(root)
    service = Service(Settings(root, "synthetic-recovery-token-" * 3))
    for color in ("white", "blue"):
        service.ingest(image_bytes(color), f"{color}.png", f"synthetic-{color}")
        assert service.process_one()
    return service


def invoke(monkeypatch: pytest.MonkeyPatch, root: Path, *arguments: str) -> None:
    monkeypatch.setenv("OCRS_DATA_DIR", str(root))
    monkeypatch.setenv("OCRS_ACCESS_TOKEN", "")
    monkeypatch.setattr(sys, "argv", ["ocrs", *arguments])
    main()


def expire_dates(root: Path) -> None:
    with transaction(root) as db:
        db.execute("UPDATE sources SET created_at='2000-01-01T00:00:00+00:00'")


def source_paths(root: Path) -> list[Path]:
    with connect(root) as db:
        return [root / row[0] for row in db.execute("SELECT path FROM sources ORDER BY rowid")]


def assert_logically_expired(root: Path) -> None:
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM sources WHERE expired=0").fetchone()[0] == 0
        assert (
            db.execute("SELECT count(*) FROM tasks WHERE candidate IS NOT NULL").fetchone()[0] == 0
        )
        assert db.execute("SELECT count(*) FROM candidate_history").fetchone()[0] == 0


def test_purge_commit_failure_keeps_every_original_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    populated(root)
    expire_dates(root)
    paths = source_paths(root)

    @contextmanager
    def fail_commit(path: Path) -> Iterator[sqlite3.Connection]:
        with transaction(path) as db:
            yield db
            raise sqlite3.OperationalError("synthetic commit failure")

    monkeypatch.setattr("ocrs.cli.transaction", fail_commit)
    with pytest.raises(sqlite3.OperationalError):
        invoke(monkeypatch, root, "purge-evidence", "--days", "1", "--confirm")
    assert all(path.is_file() for path in paths)
    with connect(root) as db:
        assert db.execute("SELECT count(*) FROM sources WHERE expired=0").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM candidate_history").fetchone()[0] == 2


def test_purge_unlink_failure_is_expired_retryable_and_not_backed_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    service = populated(root)
    expire_dates(root)
    first, second = source_paths(root)
    unlink = Path.unlink

    def fail_one(path: Path, *args: object, **kwargs: object) -> None:
        if path == second:
            raise PermissionError("synthetic locked image")
        unlink(path, *args, **kwargs)  # type: ignore[arg-type]

    with monkeypatch.context() as failure:
        failure.setattr(Path, "unlink", fail_one)
        with pytest.raises(SystemExit) as error:
            invoke(failure, root, "purge-evidence", "--days", "1", "--confirm")
        assert error.value.code == 2
    assert not first.exists() and second.is_file()
    assert_logically_expired(root)
    assert all(task["sources"][0]["expired"] for task in service.tasks())
    bundle = tmp_path / "bundle"
    backup(root, bundle)
    assert not list((bundle / "images").iterdir())
    invoke(monkeypatch, tmp_path / "restored", "restore", str(bundle))
    # Retry expired records even when the caller chooses a longer retention window.
    invoke(monkeypatch, root, "purge-evidence", "--days", "36500", "--confirm")
    assert not second.exists()
    invoke(monkeypatch, root, "purge-evidence", "--days", "36500", "--confirm")
    assert_logically_expired(root)


def test_purge_interruption_after_first_unlink_recovers_on_next_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    populated(root)
    expire_dates(root)
    first, second = source_paths(root)
    unlink = Path.unlink

    def interrupt(path: Path, *args: object, **kwargs: object) -> None:
        unlink(path, *args, **kwargs)  # type: ignore[arg-type]
        if path == first:
            raise KeyboardInterrupt

    with monkeypatch.context() as failure:
        failure.setattr(Path, "unlink", interrupt)
        with pytest.raises(KeyboardInterrupt):
            invoke(failure, root, "purge-evidence", "--days", "1", "--confirm")
    assert_logically_expired(root)
    assert not first.exists() and second.exists()
    invoke(monkeypatch, root, "purge-evidence", "--days", "1", "--confirm")
    assert not second.exists()


@pytest.mark.parametrize("after_unlink", [False, True])
def test_purge_hard_process_exit_leaves_durable_expiry_and_resumable_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, after_unlink: bool
) -> None:
    root = tmp_path / "data"
    populated(root)
    expire_dates(root)
    program = """
import os
import sys
from pathlib import Path
from ocrs.cli import main
unlink = Path.unlink
def interrupted(path, *args, **kwargs):
    if os.environ['SYNTHETIC_AFTER_UNLINK'] == '1':
        unlink(path, *args, **kwargs)
    os._exit(71)
Path.unlink = interrupted
sys.argv = ['ocrs', 'purge-evidence', '--days', '1', '--confirm']
main()
"""
    result = subprocess.run(
        [sys.executable, "-c", program],
        env={
            **os.environ,
            "OCRS_DATA_DIR": str(root),
            "SYNTHETIC_AFTER_UNLINK": "1" if after_unlink else "0",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        check=False,
        timeout=20,
    )
    assert result.returncode == 71
    assert_logically_expired(root)
    assert sum(path.exists() for path in source_paths(root)) == (1 if after_unlink else 2)
    invoke(monkeypatch, root, "purge-evidence", "--days", "1", "--confirm")
    assert not any(path.exists() for path in source_paths(root))


def test_purge_invalid_reference_cannot_delete_outside_image_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    populated(root)
    expire_dates(root)
    sentinel = tmp_path / "synthetic-do-not-delete.png"
    sentinel.write_bytes(image_bytes("red"))
    with transaction(root) as db:
        db.execute("UPDATE sources SET path='../synthetic-do-not-delete.png'")
    with pytest.raises(SystemExit):
        invoke(monkeypatch, root, "purge-evidence", "--days", "1", "--confirm")
    assert sentinel.is_file()
    with connect(root) as db:
        assert db.execute("SELECT sum(expired) FROM sources").fetchone()[0] == 0


@pytest.mark.parametrize("damage", ["missing", "changed", "invalid-path"])
def test_backup_refuses_incomplete_evidence_before_creating_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str
) -> None:
    root = tmp_path / "data"
    populated(root)
    path = source_paths(root)[0]
    if damage == "missing":
        path.unlink()
    elif damage == "changed":
        path.write_bytes(image_bytes("red"))
    else:
        with transaction(root) as db:
            db.execute("UPDATE sources SET path='../outside.png'")
    bundle = tmp_path / "bundle"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, root, "backup", str(bundle))
    assert not bundle.exists()


def test_backup_copies_only_referenced_unexpired_evidence(tmp_path: Path) -> None:
    root = tmp_path / "data"
    populated(root)
    expired, live = source_paths(root)
    with transaction(root) as db:
        db.execute(
            "UPDATE sources SET expired=1 WHERE path=?", (expired.relative_to(root).as_posix(),)
        )
    orphan = root / "images" / "synthetic-orphan.png"
    orphan.write_bytes(image_bytes("red"))
    bundle = tmp_path / "bundle"
    backup(root, bundle)
    assert (bundle / "images" / live.name).read_bytes() == live.read_bytes()
    assert not (bundle / "images" / expired.name).exists()
    assert not (bundle / "images" / orphan.name).exists()


def test_backup_checks_copied_bytes_before_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "data"
    populated(root)
    copy2 = shutil.copy2

    def corrupt_copy(source: Path, destination: Path) -> str:
        result = copy2(source, destination)
        Path(destination).write_bytes(image_bytes("red"))
        return result

    monkeypatch.setattr(shutil, "copy2", corrupt_copy)
    with pytest.raises(EvidenceIntegrityError, match="EVIDENCE_CHANGED"):
        backup(root, tmp_path / "bundle")


@pytest.mark.parametrize("relative", ["inside", "images/inside"])
def test_restore_refuses_nested_target_without_mutating_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, relative: str
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    before = {
        str(path.relative_to(bundle)): path.read_bytes()
        for path in bundle.rglob("*")
        if path.is_file()
    }
    target = bundle / relative
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not target.exists()
    after = {
        str(path.relative_to(bundle)): path.read_bytes()
        for path in bundle.rglob("*")
        if path.is_file()
    }
    assert before == after


def test_restore_rejects_valid_but_changed_image_before_creating_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    source_paths(bundle)[0].write_bytes(image_bytes("red"))
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not target.exists()


def test_restore_checks_the_copied_images_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    copy2 = shutil.copy2

    def corrupt_copy(source: Path, destination: Path) -> str:
        result = copy2(source, destination)
        if Path(destination).suffix == ".png":
            Path(destination).write_bytes(image_bytes("red"))
        return result

    monkeypatch.setattr(shutil, "copy2", corrupt_copy)
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not (target / "access-token").exists()


def test_restore_accepts_legacy_bundle_with_expired_image_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    expired = source_paths(bundle)[0]
    with transaction(bundle) as db:
        db.execute(
            "UPDATE sources SET expired=1 WHERE path=?", (expired.relative_to(bundle).as_posix(),)
        )
    expired.unlink()
    restored = tmp_path / "restored"
    invoke(monkeypatch, restored, "restore", str(bundle))
    with connect(restored) as db:
        assert db.execute("SELECT sum(expired) FROM sources").fetchone()[0] == 1
    assert (restored / "access-token").is_file()


@pytest.mark.parametrize("linked_root", ["backup", "images"])
def test_restore_rejects_top_level_symbolic_links_before_resolving(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, linked_root: str
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    if linked_root == "backup":
        original = bundle
        bundle = tmp_path / "alias"
        link = bundle
    else:
        original = tmp_path / "original-images"
        (bundle / "images").rename(original)
        link = bundle / "images"
    try:
        link.symlink_to(original, target_is_directory=True)
    except OSError:
        pytest.skip("This system cannot create directory symbolic links")
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not target.exists()


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal"])
def test_restore_rejects_database_symlink_before_opening_sqlite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    external = tmp_path / "external.sqlite3"
    database = bundle / f"ocrs.sqlite3{suffix}"
    if not suffix:
        database.rename(external)
    else:
        external.write_bytes(b"Fictional sidecar bytes that SQLite must not open")
    before = external.read_bytes()
    try:
        database.symlink_to(external)
    except OSError:
        pytest.skip("This system cannot create file symbolic links")

    def forbidden_database_open(*args: object, **kwargs: object) -> None:
        pytest.fail("Restore must reject the database link before opening SQLite")

    monkeypatch.setattr("ocrs.cli.sqlite3.connect", forbidden_database_open)
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not target.exists()
    assert external.read_bytes() == before


@pytest.mark.parametrize("linked_root", ["backup", "images", "database", "wal", "shm", "journal"])
def test_restore_rejects_detected_junction_without_copying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, linked_root: str
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    detected = {
        "backup": bundle,
        "images": bundle / "images",
        "database": bundle / "ocrs.sqlite3",
        "wal": bundle / "ocrs.sqlite3-wal",
        "shm": bundle / "ocrs.sqlite3-shm",
        "journal": bundle / "ocrs.sqlite3-journal",
    }[linked_root]
    is_junction = Path.is_junction
    monkeypatch.setattr(Path, "is_junction", lambda path: path == detected or is_junction(path))
    target = tmp_path / "restored"
    with pytest.raises(SystemExit):
        invoke(monkeypatch, target, "restore", str(bundle))
    assert not target.exists()


def test_restore_ignores_legacy_expired_and_unreferenced_image_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "data"
    populated(source)
    bundle = tmp_path / "bundle"
    backup(source, bundle)
    expired, live = source_paths(bundle)
    with transaction(bundle) as db:
        db.execute(
            "UPDATE sources SET expired=1 WHERE path=?", (expired.relative_to(bundle).as_posix(),)
        )
    extra = bundle / "images" / "unreferenced-directory"
    extra.mkdir()
    (extra / "synthetic.txt").write_text("Fictional data that must not be copied")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "synthetic.txt").write_text("Fictional outside data")
    try:
        (bundle / "images" / "unreferenced-link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pass  # The unrelated directory still exercises reference-only copying.

    def forbidden_tree_walk(*args: object, **kwargs: object) -> None:
        pytest.fail("Restore must not walk unreferenced backup directories")

    monkeypatch.setattr(Path, "rglob", forbidden_tree_walk)
    target = tmp_path / "restored"
    invoke(monkeypatch, target, "restore", str(bundle))
    assert sorted(path.name for path in (target / "images").iterdir()) == [live.name]
    assert (target / "images" / live.name).read_bytes() == live.read_bytes()
    assert not (target / "images" / expired.name).exists()
