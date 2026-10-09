"""SQLite schema migration, atomic transactions and backup support."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import TracebackType
from typing import Any, Literal

SCHEMA_VERSION = 1
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


def backup(root: Path, destination: Path) -> None:
    """Offline service lock is acquired by CLI; bundle every retained image with DB."""
    import shutil

    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    source = connect(root)
    target = sqlite3.connect(destination / "ocrs.sqlite3")
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    shutil.copytree(root / "images", destination / "images")
