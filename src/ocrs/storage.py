"""SQLite schema migration, atomic transactions and backup support."""

import hashlib
import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import TracebackType
from typing import Any, Literal

SCHEMA_VERSION = 4
SCHEMA = """
CREATE TABLE sources(id TEXT PRIMARY KEY, digest TEXT NOT NULL, source_label TEXT NOT NULL,
 filename TEXT NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL,
 expired INTEGER NOT NULL DEFAULT 0, UNIQUE(digest,source_label));
CREATE TABLE tasks(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
 status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
 provider TEXT NOT NULL, candidate TEXT, error_code TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, duration_ms INTEGER);
CREATE TABLE candidate_history(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 attempt INTEGER NOT NULL,candidate TEXT NOT NULL,created_at TEXT NOT NULL,
 model TEXT NOT NULL,prompt_version TEXT NOT NULL,input_digest TEXT NOT NULL);
CREATE TABLE orders(id TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,
 customer TEXT NOT NULL,external_id TEXT,currency TEXT NOT NULL,occurred_at TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE items(line_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),
 position INTEGER NOT NULL,sku TEXT NOT NULL,name TEXT NOT NULL,quantity TEXT NOT NULL,
 unit TEXT NOT NULL,unit_price TEXT NOT NULL);
CREATE TABLE events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),
 version INTEGER NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),action TEXT NOT NULL,
 actor TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(order_id,version));
CREATE TABLE outbox(id TEXT PRIMARY KEY REFERENCES events(id),
 status TEXT NOT NULL DEFAULT 'pending',
 export_id TEXT,error_code TEXT);
CREATE TABLE requests(key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE exports(id TEXT PRIMARY KEY,status TEXT NOT NULL,path TEXT NOT NULL,
 created_at TEXT NOT NULL,error_code TEXT,metadata TEXT);
CREATE TABLE inbox_state(id INTEGER PRIMARY KEY CHECK(id=1),summary TEXT NOT NULL);
CREATE TABLE audit(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,record_id TEXT NOT NULL,
 actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
"""


class ClosingConnection(sqlite3.Connection):
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> Literal[False]:
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def connect(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(root / "ocrs.sqlite3", timeout=15, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


def migrate(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with connect(root) as connection:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError("DATABASE_VERSION_NEWER")
        if version == 0:
            connection.executescript("BEGIN IMMEDIATE;" + SCHEMA + "PRAGMA user_version=1;COMMIT;")
        if version < 2:
            connection.executescript(
                "BEGIN IMMEDIATE;"
                "ALTER TABLE tasks ADD COLUMN model_revision INTEGER NOT NULL DEFAULT -1;"
                "ALTER TABLE tasks ADD COLUMN external_authorized INTEGER NOT NULL DEFAULT 0;"
                "PRAGMA user_version=2;COMMIT;"
            )
        if version < 3:
            connection.executescript(
                "BEGIN IMMEDIATE;"
                "CREATE TABLE candidate_revisions("
                "task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL,"
                "candidate TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,"
                "created_at TEXT NOT NULL,PRIMARY KEY(task_id,version));"
                "ALTER TABLE audit ADD COLUMN task_version INTEGER;"
                "ALTER TABLE audit ADD COLUMN from_status TEXT;"
                "ALTER TABLE audit ADD COLUMN to_status TEXT;"
                "PRAGMA user_version=3;COMMIT;"
            )
        if version < 4:
            connection.executescript(
                "BEGIN IMMEDIATE;"
                "CREATE TABLE recognition_requests("
                "key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,"
                "task_id TEXT NOT NULL REFERENCES tasks(id));"
                "PRAGMA user_version=4;COMMIT;"
            )
        connection.execute("PRAGMA journal_mode=WAL")
    for name in ("images", "exports"):
        (root / name).mkdir(mode=0o700, exist_ok=True)


@contextmanager
def transaction(root: Path) -> Iterator[sqlite3.Connection]:
    connection = connect(root)
    try:
        connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class EvidenceIntegrityError(ValueError):
    """A retained image has an unsafe reference, missing bytes or a changed digest."""


def evidence_path(root: Path, reference: str) -> Path:
    """Validate a generated image reference, including missing files during purge."""
    root = root.resolve()
    relative = Path(reference)
    if (
        len(relative.parts) < 2
        or relative.is_absolute()
        or ".." in relative.parts
        or relative.parts[0] != "images"
    ):
        raise EvidenceIntegrityError("EVIDENCE_PATH_INVALID")
    path = root / relative
    images = root / "images"
    try:
        if not path.resolve().is_relative_to(images):
            raise EvidenceIntegrityError("EVIDENCE_PATH_INVALID")
        for part in (path, *path.parents):
            if part.is_symlink() or part.is_junction():
                raise EvidenceIntegrityError("EVIDENCE_PATH_INVALID")
            if part == images:
                break
    except (OSError, RuntimeError) as exc:
        raise EvidenceIntegrityError("EVIDENCE_PATH_INVALID") from exc
    return path


def verify_evidence(root: Path, connection: sqlite3.Connection) -> list[Path]:
    """Verify every live evidence reference and its bytes, with bounded-memory hashing."""
    paths = []
    for reference, digest in connection.execute("SELECT path,digest FROM sources WHERE expired=0"):
        path = evidence_path(root, reference)
        try:
            if not path.is_file():
                raise EvidenceIntegrityError("EVIDENCE_MISSING")
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
        except OSError as exc:
            raise EvidenceIntegrityError("EVIDENCE_UNREADABLE") from exc
        if actual != digest:
            raise EvidenceIntegrityError("EVIDENCE_CHANGED")
        paths.append(path)
    return paths


def copy_evidence(root: Path, destination: Path, paths: list[Path]) -> None:
    """Copy only verified, retained evidence; never traverse unreferenced files."""
    import shutil

    (destination / "images").mkdir(mode=0o700)
    for path in paths:
        copy = destination / path.relative_to(root)
        copy.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(path, copy)


def backup(root: Path, destination: Path) -> None:
    """Offline service lock is acquired by CLI; bundle every retained image with DB."""
    root = root.resolve()
    with connect(root) as source:
        paths = verify_evidence(root, source)
        destination.mkdir(parents=True, exist_ok=False, mode=0o700)
        target = sqlite3.connect(destination / "ocrs.sqlite3")
        try:
            source.backup(target)
        finally:
            target.close()
        copy_evidence(root, destination, paths)
    # Check the actual copied bytes too, before reporting a recoverable backup.
    with connect(destination) as snapshot:
        verify_evidence(destination, snapshot)
