"""Application use cases: evidence, review transactions, durable jobs and exports."""

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ocrs.capture import validate_image
from ocrs.config import Settings
from ocrs.domain import Candidate, CandidateEvent, validate_confirmation
from ocrs.exporter import ExportError, write_workbook
from ocrs.model_settings import ModelSettingsStore, ModelSettingsUpdate
from ocrs.providers import (
    DemoProvider,
    MiniMaxCNProvider,
    OpenAICompatibleProvider,
    ProviderError,
    RecognitionProvider,
    RecognitionSource,
)
from ocrs.storage import connect, encode, transaction

logger = logging.getLogger("ocrs.jobs")


def now() -> str:
    return datetime.now(UTC).isoformat()


def uid() -> str:
    return str(uuid.uuid4())


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, details: Any = None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


class Confirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=100)
    actor: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)
    events: list[CandidateEvent] = Field(min_length=1, max_length=50)
    acknowledge_duplicates: bool = False


class Service:
    def __init__(self, settings: Settings, model_store: ModelSettingsStore | None = None):
        self.settings = settings
        self.root = settings.data_dir
        self.model_store = model_store
        self._model_lock = threading.RLock()
        self._provider_revision = -1
        self.provider: RecognitionProvider = (
            self._make_provider(settings) if model_store is None else DemoProvider()
        )

    @staticmethod
    def _make_provider(settings: Settings) -> RecognitionProvider:
        if settings.provider == "demo":
            return DemoProvider()
        return (
            MiniMaxCNProvider if settings.provider == "minimax-cn" else OpenAICompatibleProvider
        )(
            base_url=settings.model_url,
            model=settings.model,
            api_key=settings.api_key,
            max_requests=settings.max_requests,
            timeout_seconds=settings.model_timeout_seconds,
            total_timeout_seconds=settings.model_total_timeout_seconds,
            max_output_tokens=settings.model_max_output_tokens,
        )

    def runtime_settings(self) -> tuple[Settings, int]:
        if self.model_store is None:
            return self.settings, 0
        snapshot = self.model_store.snapshot()
        return replace(
            self.settings,
            provider=snapshot.provider,
            model=snapshot.model,
            model_url=snapshot.base_url,
            api_key=snapshot.api_key,
            allow_external=snapshot.allow_external,
            max_requests=snapshot.max_requests,
            model_timeout_seconds=snapshot.timeout_seconds,
            model_total_timeout_seconds=snapshot.total_timeout_seconds,
            model_max_output_tokens=snapshot.max_output_tokens,
        ), snapshot.revision

    def save_model_settings(self, body: ModelSettingsUpdate) -> dict[str, Any]:
        assert self.model_store is not None
        with self._model_lock:
            saved = self.model_store.save(body)
            # Revision binding is the fail-closed guard even if this independent
            # business-DB transaction fails after settings were committed.
            with transaction(self.root) as db:
                db.execute(
                    "UPDATE tasks SET status='failed',error_code='MODEL_CONFIG_CHANGED',"
                    "version=version+1,updated_at=? WHERE status='received' AND model_revision!=?",
                    (now(), saved.revision),
                )
            return saved.public()

    def _authorize_model(
        self, config_revision: int | None, confirm_external: bool
    ) -> tuple[Settings, int]:
        settings, revision = self.runtime_settings()
        if self.model_store and settings.provider != "demo":
            if not settings.allow_external or not settings.api_key or not settings.model:
                raise AppError("MODEL_DISABLED", "请先在模型设置保存完整配置并允许外部调用", 409)
            if not confirm_external or config_revision != revision:
                raise AppError("MODEL_CONSENT_REQUIRED", "请确认当前模型目的地及本次图片外传", 409)
        return settings, revision

    def recover(self) -> None:
        with transaction(self.root) as db:
            db.execute(
                "UPDATE tasks SET "
                "status='failed',error_code='INTERRUPTED',version=version+1 "
                "WHERE status='recognizing'"
            )
            db.execute(
                "UPDATE exports SET status='failed',error_code='INTERRUPTED' WHERE status='writing'"
            )
            db.execute("UPDATE outbox SET status='pending',export_id=NULL WHERE status='writing'")
            # The service lock excludes other processes; this writer transaction
            # also excludes ingestion while reconciling interrupted file writes.
            retained = {row[0] for row in db.execute("SELECT path FROM sources")}
            for path in (self.root / "images").iterdir():
                if path.suffix not in {".png", ".jpg", ".webp"}:
                    continue
                try:
                    generated = str(uuid.UUID(path.stem)) == path.stem
                except ValueError:
                    generated = False
                if generated and f"images/{path.name}" not in retained and not path.is_dir():
                    path.unlink(missing_ok=True)

    def ingest(
        self,
        data: bytes,
        filename: str,
        source_label: str,
        *,
        config_revision: int | None = None,
        confirm_external: bool = False,
        from_inbox: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        with self._model_lock:
            if from_inbox:
                runtime, revision = self.runtime_settings()
            else:
                runtime, revision = self._authorize_model(config_revision, confirm_external)
            return self._ingest(data, filename, source_label, runtime, revision, confirm_external)

    def _ingest(
        self,
        data: bytes,
        filename: str,
        source_label: str,
        runtime: Settings,
        revision: int,
        confirm_external: bool,
    ) -> tuple[dict[str, Any], bool]:
        if not source_label.strip() or len(source_label) > 200 or len(filename) > 255:
            raise AppError("SOURCE_INVALID", "来源标签或文件名无效")
        image = validate_image(data, max_bytes=self.settings.max_upload_bytes)
        created_path: Path | None = None
        try:
            with transaction(self.root) as db:
                prior = db.execute(
                    (
                        "SELECT t.id FROM tasks t JOIN sources s ON s.id=t.source_id "
                        "WHERE s.digest=? AND s.source_label=?"
                    ),
                    (image.sha256, source_label),
                ).fetchone()
                if prior:
                    return self._task(db, prior["id"]), True
                source_id, task_id = uid(), uid()
                relative = f"images/{source_id}{image.extension}"
                path = self.root / relative
                with path.open("xb") as stream:
                    created_path = path
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                directory_flag = getattr(os, "O_DIRECTORY", None)
                if os.name == "posix" and directory_flag is not None:
                    descriptor = os.open(path.parent, os.O_RDONLY | directory_flag)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                stamp = now()
                db.execute(
                    (
                        "INSERT INTO "
                        "sources(id,digest,source_label,filename,mime,path,created_at) "
                        "VALUES(?,?,?,?,?,?,?)"
                    ),
                    (
                        source_id,
                        image.sha256,
                        source_label,
                        Path(filename.replace("\\", "/")).name,
                        image.mime,
                        relative,
                        stamp,
                    ),
                )
                db.execute(
                    (
                        "INSERT INTO "
                        "tasks(id,source_id,status,provider,created_at,updated_at,"
                        "model_revision,external_authorized) "
                        "VALUES(?,?,'received',?,?,?,?,?)"
                    ),
                    (
                        task_id,
                        source_id,
                        runtime.provider,
                        stamp,
                        stamp,
                        revision,
                        int(confirm_external),
                    ),
                )
                return self._task(db, task_id), False
        except BaseException:
            if created_path is not None:
                try:
                    with transaction(self.root) as db:
                        referenced = db.execute(
                            "SELECT 1 FROM sources WHERE path=?",
                            (f"images/{created_path.name}",),
                        ).fetchone()
                        if not referenced:
                            created_path.unlink(missing_ok=True)
                except (OSError, sqlite3.Error):
                    # A later startup reconciles the file if disk/DB access is
                    # currently unavailable. Do not hide the original failure.
                    logger.error('{"error_code":"EVIDENCE_CLEANUP_PENDING"}')
            raise

    def _task(self, db: sqlite3.Connection, task_id: str) -> dict[str, Any]:
        row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise AppError("NOT_FOUND", "任务不存在", 404)
        result = dict(row)
        result["candidate"] = json.loads(row["candidate"]) if row["candidate"] else None
        source = dict(
            db.execute(
                "SELECT id,filename,mime,source_label,digest,expired FROM sources WHERE id=?",
                (row["source_id"],),
            ).fetchone()
        )
        source["url"] = f"/api/sources/{source['id']}"
        result["sources"] = [source]
        return result

    def task(self, task_id: str) -> dict[str, Any]:
        with connect(self.root) as db:
            return self._task(db, task_id)

    def tasks(self) -> list[dict[str, Any]]:
        """Compatibility helper; HTTP callers use the explicitly paginated view."""
        return self.task_page(limit=500)["tasks"]

    def task_page(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        status: str | None = None,
        q: str | None = None,
    ) -> dict[str, Any]:
        if type(limit) is not int or not 1 <= limit <= 500 or type(offset) is not int or offset < 0:
            raise AppError("VALIDATION_ERROR", "分页参数无效", 422)
        statuses = {"received", "recognizing", "review_required", "confirmed", "rejected", "failed"}
        if status and status not in statuses | {"processing"}:
            raise AppError("VALIDATION_ERROR", "任务状态无效", 422)
        if q is not None and (not isinstance(q, str) or len(q) > 200):
            raise AppError("VALIDATION_ERROR", "搜索文本过长", 422)
        filters: list[str] = []
        parameters: list[Any] = []
        if status == "processing":
            filters.append("t.status IN ('received','recognizing')")
        elif status:
            filters.append("t.status=?")
            parameters.append(status)
        if q and q.strip():
            # instr performs literal matching: '%' and '_' are ordinary input.
            filters.append(
                "(instr(lower(t.id),lower(?))>0 OR instr(lower(s.source_label),lower(?))>0 "
                "OR instr(lower(s.filename),lower(?))>0)"
            )
            parameters.extend([q.strip()] * 3)
        query = " FROM tasks t JOIN sources s ON s.id=t.source_id"
        if filters:
            query += " WHERE " + " AND ".join(filters)
        with connect(self.root) as db:
            db.execute("BEGIN")
            total = db.execute("SELECT count(*)" + query, parameters).fetchone()[0]
            rows = db.execute(
                "SELECT t.id" + query + " ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?",
                [*parameters, limit, offset],
            ).fetchall()
            tasks = [self._task(db, row[0]) for row in rows]
        return {
            "tasks": tasks,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(tasks) < total,
        }

    def orders(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        if db is None:
            with connect(self.root) as connection:
                connection.execute("BEGIN")
                return self.orders(connection)
        result = []
        for row in db.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall():
            order = dict(row)
            order["items"] = [
                dict(x)
                for x in db.execute(
                    (
                        "SELECT line_id,sku,name,quantity,unit,unit_price FROM items "
                        "WHERE order_id=? ORDER BY position"
                    ),
                    (row["id"],),
                ).fetchall()
            ]
            result.append(order)
        return result

    def process_one(self) -> bool:
        with self._model_lock:
            runtime, revision = self.runtime_settings()
            claimed = self._claim_task(runtime, revision)
            if claimed is None:
                return False
            row, provider = claimed
        task_id = row["id"]
        started = time.monotonic()
        try:
            if self.model_store:
                if row["model_revision"] != revision:
                    raise AppError("MODEL_CONFIG_CHANGED", "模型配置已改变，请确认后重新识别")
                if runtime.provider != "demo" and (
                    not runtime.allow_external
                    or not runtime.api_key
                    or not runtime.model
                    or not row["external_authorized"]
                ):
                    raise AppError("MODEL_CONSENT_REQUIRED", "本任务尚未确认外传")
            if row["expired"]:
                raise AppError("EVIDENCE_EXPIRED", "原图已过期")
            image_path = self.root / row["path"]
            if hashlib.sha256(image_path.read_bytes()).hexdigest() != row["digest"]:
                raise AppError("EVIDENCE_CHANGED", "原图摘要已变更")
            candidate = provider.recognize(
                [RecognitionSource(id=row["source_id"], path=image_path, mime=row["mime"])]
            )
            self._validate_evidence(candidate, {row["source_id"]})
            payload = candidate.model_dump_json()
            with transaction(self.root) as db:
                db.execute(
                    "INSERT INTO candidate_history(task_id,attempt,candidate,created_at,"
                    "model,prompt_version,input_digest) VALUES(?,?,?,?,?,?,?)",
                    (
                        task_id,
                        row["attempts"] + 1,
                        payload,
                        now(),
                        runtime.model or "demo",
                        getattr(provider, "prompt_version", "unknown"),
                        row["digest"],
                    ),
                )
                db.execute(
                    "UPDATE tasks SET status='review_required',candidate=?,error_code=NULL,"
                    "version=version+1,updated_at=?,duration_ms=? "
                    "WHERE id=? AND status='recognizing'",
                    (payload, now(), round((time.monotonic() - started) * 1000), task_id),
                )
            self._log(task_id, "review_required", None, started, row["attempts"] + 1)
        except (ProviderError, AppError) as exc:
            self._fail_task(task_id, exc.code, started, row["attempts"] + 1)
        except Exception:
            self._fail_task(task_id, "RECOGNITION_INTERNAL", started, row["attempts"] + 1)
        return True

    def _claim_task(
        self, runtime: Settings, revision: int
    ) -> tuple[sqlite3.Row, RecognitionProvider] | None:
        # Validate/build before claiming: a damaged configuration must never
        # strand a task in recognizing or partially mix a key and destination.
        provider = self.model_provider(runtime, revision)
        with transaction(self.root) as db:
            row = db.execute(
                "SELECT t.*,s.path,s.mime,s.expired,s.digest FROM tasks t JOIN sources s "
                "ON s.id=t.source_id WHERE t.status='received' ORDER BY "
                "t.created_at LIMIT 1"
            ).fetchone()
            if not row:
                return None
            task_id = row["id"]
            db.execute(
                (
                    "UPDATE tasks SET "
                    "status='recognizing',attempts=attempts+1,version=version+1,u"
                    "pdated_at=?,provider=? WHERE id=?"
                ),
                (now(), runtime.provider, task_id),
            )
        return row, provider

    def model_provider(self, runtime: Settings, revision: int) -> RecognitionProvider:
        if self.model_store and self._provider_revision != revision:
            if runtime.provider == "demo" or (
                runtime.api_key and runtime.model and runtime.allow_external
            ):
                try:
                    self.provider = self._make_provider(runtime)
                except ProviderError:
                    raise AppError(
                        "MODEL_CONFIG_INVALID", "模型配置无效，请重新保存设置", 409
                    ) from None
            else:
                self.provider = DemoProvider()  # Gated before any recognition.
            self._provider_revision = revision
        return self.provider

    @staticmethod
    def _validate_evidence(candidate: Candidate, source_ids: set[str]) -> None:
        for event in candidate.events:
            if any(e.source_id not in source_ids for e in event.evidence):
                raise AppError("EVIDENCE_INVALID", "证据引用不属于当前任务")

    def _fail_task(self, task_id: str, code: str, started: float, attempts: int) -> None:
        with transaction(self.root) as db:
            db.execute(
                (
                    "UPDATE tasks SET "
                    "status='failed',error_code=?,version=version+1,updated_at=?,"
                    "duration_ms=? WHERE id=? AND status='recognizing'"
                ),
                (code, now(), round((time.monotonic() - started) * 1000), task_id),
            )
        self._log(task_id, "failed", code, started, attempts)

    @staticmethod
    def _log(task_id: str, status: str, error: str | None, started: float, attempts: int) -> None:
        logger.info(
            encode(
                {
                    "trace_id": task_id,
                    "job_id": task_id,
                    "status": status,
                    "error_code": error,
                    "duration_ms": round((time.monotonic() - started) * 1000),
                    "attempts": attempts,
                }
            )
        )

    def retry(
        self,
        task_id: str,
        expected_version: int | None = None,
        *,
        config_revision: int | None = None,
        confirm_external: bool = False,
    ) -> dict[str, Any]:
        with self._model_lock:
            _, revision = self._authorize_model(config_revision, confirm_external)
            return self._retry(task_id, expected_version, revision, confirm_external)

    def _retry(
        self, task_id: str, expected_version: int | None, revision: int, confirm_external: bool
    ) -> dict[str, Any]:
        with transaction(self.root) as db:
            task = self._task(db, task_id)
            if expected_version is not None and task["version"] != expected_version:
                raise AppError("VERSION_CONFLICT", "任务状态已改变，请刷新", 409)
            if task["status"] != "failed":
                raise AppError("STATE_CONFLICT", "仅失败任务可重试", 409)
            if task["sources"][0]["expired"]:
                raise AppError("EVIDENCE_EXPIRED", "原图已过期，无法重试", 409)
            if task["attempts"] >= 5:
                raise AppError(
                    "RETRY_LIMIT", "任务已达 5 次尝试上限，请检查配置后重新导入新来源", 409
                )
            db.execute(
                (
                    "UPDATE tasks SET "
                    "status='received',error_code=NULL,version=version+1,updated_at=?,"
                    "model_revision=?,external_authorized=? WHERE id=?"
                ),
                (now(), revision, int(confirm_external), task_id),
            )
            return self._task(db, task_id)

    def reject(self, task_id: str, version: int, reason: str) -> dict[str, Any]:
        with transaction(self.root) as db:
            task = self._task(db, task_id)
            if task["version"] != version or task["status"] not in {
                "received",
                "review_required",
                "failed",
            }:
                raise AppError("VERSION_CONFLICT", "任务状态已改变，请刷新", 409)
            db.execute(
                "UPDATE tasks SET status='rejected',version=version+1,updated_at=? WHERE id=?",
                (now(), task_id),
            )
            db.execute(
                (
                    "INSERT INTO audit(kind,record_id,actor,reason,created_at) "
                    "VALUES('rejected',?,'local-operator',?,?)"
                ),
                (task_id, reason, now()),
            )
            return self._task(db, task_id)

    def confirm(self, task_id: str, request: Confirmation) -> dict[str, Any]:
        payload_hash = hashlib.sha256(
            encode({"task_id": task_id, **request.model_dump(mode="json")}).encode()
        ).hexdigest()
        with transaction(self.root) as db:
            prior = db.execute(
                "SELECT * FROM requests WHERE key=?", (request.idempotency_key,)
            ).fetchone()
            if prior:
                if prior["payload_hash"] != payload_hash:
                    raise AppError("IDEMPOTENCY_CONFLICT", "同一请求标识对应不同内容", 409)
                return json.loads(prior["response"])
            if not request.actor.strip() or not request.reason.strip():
                raise AppError("VALIDATION_ERROR", "操作者和原因不得为空白", 422)
            for event in request.events:
                validate_confirmation(event, set(self.settings.sku_catalog))
            task = self._task(db, task_id)
            if task["version"] != request.expected_version or task["status"] != "review_required":
                raise AppError("VERSION_CONFLICT", "任务已被处理，请刷新", 409)
            if task["sources"][0]["expired"]:
                raise AppError("EVIDENCE_EXPIRED", "原图已过期，不可审核确认", 409)
            self._validate_evidence(
                Candidate(schema_version="1", events=request.events), {task["source_id"]}
            )
            ids = [
                self._apply_event(db, task_id, event, request.actor, request.reason)
                for event in request.events
            ]
            # Compare the final transaction state, including amendments and
            # cancellations in this same batch. A warning rolls back every write.
            changed_ids = {
                order_id
                for order_id, event in zip(ids, request.events, strict=True)
                if event.action in {"create", "amend"}
            }
            created_ids = {
                order_id
                for order_id, event in zip(ids, request.events, strict=True)
                if event.action == "create"
            }
            confirmed = [order for order in self.orders(db) if order["status"] == "confirmed"]
            duplicate_ids: set[str] = set()
            for current in confirmed:
                if current["id"] not in changed_ids:
                    continue
                for other in confirmed:
                    if current["id"] == other["id"]:
                        continue
                    same_external = bool(current["external_id"]) and (
                        current["external_id"] == other["external_id"]
                    )
                    same_items = (
                        current["customer"] == other["customer"]
                        and current["currency"] == other["currency"]
                        and self._item_fingerprint(current["items"])
                        == self._item_fingerprint(other["items"])
                    )
                    if same_external or same_items:
                        duplicate_ids.add(
                            "current-batch" if other["id"] in created_ids else other["id"]
                        )
            if duplicate_ids and not request.acknowledge_duplicates:
                raise AppError(
                    "DUPLICATE_WARNING",
                    "发现可能重复订单，请核对后明确继续",
                    409,
                    {"order_ids": sorted(duplicate_ids)},
                )
            db.execute(
                "UPDATE tasks SET status='confirmed',version=version+1,updated_at=? WHERE id=?",
                (now(), task_id),
            )
            response = {"orders": ids}
            db.execute(
                "INSERT INTO requests VALUES(?,?,?)",
                (request.idempotency_key, payload_hash, encode(response)),
            )
            return response

    @staticmethod
    def _item_fingerprint(items: list[dict[str, Any]]) -> str:
        from decimal import Decimal

        return encode(
            sorted(
                [
                    (
                        i["sku"],
                        str(Decimal(i["quantity"]).normalize()),
                        i["unit"],
                        str(Decimal(i["unit_price"]).normalize()),
                    )
                    for i in items
                ]
            )
        )

    def _apply_event(
        self, db: sqlite3.Connection, task_id: str, event: CandidateEvent, actor: str, reason: str
    ) -> str:
        stamp = now()
        order_id = uid() if event.action == "create" else event.target_order_id
        assert order_id is not None
        version = 1
        old_line_ids: set[str] = set()
        if event.action != "create":
            existing = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
            if (
                not existing
                or existing["version"] != event.expected_order_version
                or existing["status"] != "confirmed"
            ):
                raise AppError("VERSION_CONFLICT", "目标订单不存在、已撤单或版本已变更", 409)
            version = existing["version"] + 1
            old_line_ids = {
                r[0]
                for r in db.execute(
                    "SELECT line_id FROM items WHERE order_id=?", (order_id,)
                ).fetchall()
            }
        if event.action == "cancel":
            db.execute(
                "UPDATE orders SET status='cancelled',version=?,updated_at=? WHERE id=?",
                (version, stamp, order_id),
            )
        else:
            occurred = event.occurred_at.isoformat() if event.occurred_at else None
            if event.action == "create":
                db.execute(
                    "INSERT INTO orders VALUES(?,?,'confirmed',?,?,?,?,?,?)",
                    (
                        order_id,
                        version,
                        event.customer,
                        event.external_id,
                        event.currency,
                        occurred,
                        stamp,
                        stamp,
                    ),
                )
            else:
                db.execute(
                    (
                        "UPDATE orders SET "
                        "version=?,customer=?,external_id=?,currency=?,occurred_at=?,"
                        "updated_at=? WHERE id=?"
                    ),
                    (
                        version,
                        event.customer,
                        event.external_id,
                        event.currency,
                        occurred,
                        stamp,
                        order_id,
                    ),
                )
            seen: set[str] = set()
            for item in event.items:
                if item.line_id is not None and (
                    item.line_id not in old_line_ids or item.line_id in seen
                ):
                    raise AppError("LINE_ID_INVALID", "明细 ID 不属于目标订单或重复")
                if item.line_id:
                    seen.add(item.line_id)
            db.execute("DELETE FROM items WHERE order_id=?", (order_id,))
            for position, item in enumerate(event.items):
                db.execute(
                    "INSERT INTO items VALUES(?,?,?,?,?,?,?,?)",
                    (
                        item.line_id or uid(),
                        order_id,
                        position,
                        item.sku,
                        item.name,
                        str(item.quantity),
                        item.unit,
                        str(item.unit_price),
                    ),
                )
        event_id = uid()
        snapshot = next(o for o in self.orders(db) if o["id"] == order_id)
        db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
            (
                event_id,
                order_id,
                version,
                task_id,
                event.action,
                actor,
                event.reason or reason,
                encode(snapshot),
                stamp,
            ),
        )
        db.execute("INSERT INTO outbox(id) VALUES(?)", (event_id,))
        return order_id

    def export(self) -> dict[str, Any]:
        # The dedicated service process serializes this method with a cross-process writer lock.
        from filelock import FileLock

        with FileLock(str(self.root / "export-job.lock"), timeout=20):
            export_id = uid()
            relative = f"exports/orders-{export_id}.xlsx"
            with transaction(self.root) as db:
                snapshot = self.orders(db)
                event_ids = [
                    r[0]
                    for r in db.execute(
                        "SELECT id FROM outbox WHERE status IN ('pending','failed')"
                    ).fetchall()
                ]
                db.execute(
                    "INSERT INTO exports(id,status,path,created_at) VALUES(?,'writing',?,?)",
                    (export_id, relative, now()),
                )
                for event_id in event_ids:
                    db.execute(
                        "UPDATE outbox SET status='writing',export_id=?,error_code=NULL WHERE id=?",
                        (export_id, event_id),
                    )
            try:
                metadata = write_workbook(snapshot, self.root / relative)
            except (ExportError, OSError) as exc:
                code = exc.code if isinstance(exc, ExportError) else "EXPORT_IO"
                with transaction(self.root) as db:
                    db.execute(
                        "UPDATE exports SET status='failed',error_code=? WHERE id=?",
                        (code, export_id),
                    )
                    db.execute(
                        "UPDATE outbox SET status='failed',error_code=? WHERE export_id=?",
                        (code, export_id),
                    )
                raise AppError(
                    "EXPORT_FAILED",
                    "导出失败，订单已保存，可重新导出",
                    503,
                    {"export_id": export_id, "error_code": code},
                ) from None
            with transaction(self.root) as db:
                db.execute(
                    "UPDATE exports SET status='completed',metadata=? WHERE id=?",
                    (encode(metadata), export_id),
                )
                db.execute("UPDATE outbox SET status='completed' WHERE export_id=?", (export_id,))
            return {"id": export_id, "status": "completed", **metadata}

    def record_inbox(self, summary: dict[str, Any]) -> None:
        with transaction(self.root) as db:
            row = db.execute("SELECT summary FROM inbox_state WHERE id=1").fetchone()
            previous = json.loads(row[0]) if row else {}
            errors = previous.get("errors", [])
            for error in summary.get("errors", []):
                if error not in errors:
                    errors.append(error)
            summary = {**summary, "errors": errors[-20:], "updated_at": now()}
            db.execute(
                "INSERT INTO inbox_state VALUES(1,?) ON CONFLICT(id) "
                "DO UPDATE SET summary=excluded.summary",
                (encode(summary),),
            )

    def status(self) -> dict[str, Any]:
        with connect(self.root) as db:
            db.execute("BEGIN")
            counts = {
                r[0]: r[1]
                for r in db.execute("SELECT status,count(*) FROM tasks GROUP BY status").fetchall()
            }
            export = db.execute(
                "SELECT id,status,error_code,created_at,metadata FROM exports "
                "ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            pending = db.execute(
                "SELECT count(*) FROM outbox WHERE status!='completed'"
            ).fetchone()[0]
            inbox = db.execute("SELECT summary FROM inbox_state WHERE id=1").fetchone()
            avg = db.execute(
                "SELECT avg(duration_ms) FROM tasks WHERE duration_ms IS NOT NULL"
            ).fetchone()[0]
        export_status = dict(export) if export else {"status": "none", "error_code": None}
        if export:
            export_status["metadata"] = (
                json.loads(export["metadata"]) if export["metadata"] else None
            )
        return {
            "provider": self.model_store.public()["provider"]
            if self.model_store
            else self.settings.provider,
            "counts": counts,
            "export": export_status,
            "pending_export_events": pending,
            "recognition_avg_ms": avg,
            "inbox_enabled": self.settings.inbox is not None,
            "inbox": json.loads(inbox[0]) if inbox else None,
            "sku_catalog": sorted(self.settings.sku_catalog),
        }
