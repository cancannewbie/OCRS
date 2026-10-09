"""Loopback-only HTTP boundary; every data endpoint requires bearer authentication."""

import hashlib
import hmac
import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, Header, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ocrs import __version__
from ocrs.capture import CaptureError, InboxWatcher
from ocrs.config import Settings
from ocrs.domain import CURRENCY_MINOR_UNITS
from ocrs.security import RequestGuard
from ocrs.service import AppError, Confirmation, Service
from ocrs.storage import SCHEMA_VERSION, connect


class RejectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=500)


class RetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)


def _ingest_inbox(service: Service, data: bytes, label: str) -> tuple[dict[str, Any], bool]:
    filename = label.removeprefix("inbox:")
    # Valid filesystem names can exceed the source-label bound after the prefix.
    # Hash only long labels, preserving previous identities and the full filename.
    source_label = (
        label
        if len(label) <= 200
        else "inbox-long-sha256:" + hashlib.sha256(filename.encode()).hexdigest()
    )
    return service.ingest(data, filename, source_label)


def create_app(settings: Settings, *, start_worker: bool = True) -> FastAPI:
    service = Service(settings)
    stop = threading.Event()
    lock = FileLock(str(settings.data_dir / "service.lock"), timeout=0)
    watcher = (
        InboxWatcher(
            settings.inbox,
            lambda data, mime, label: _ingest_inbox(service, data, label),
        )
        if settings.inbox
        else None
    )

    def worker() -> None:
        while not stop.is_set():
            try:
                if watcher:
                    service.record_inbox(dict(watcher.scan_once()))
                worked = service.process_one()
            except Exception:
                # Safe boundary logging, never customer data or third-party exception strings.
                logging.getLogger("ocrs.worker").error('{"error_code":"WORKER_TICK_FAILED"}')
                worked = False
            stop.wait(0.05 if worked else 1)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        lock.acquire()
        thread = None
        try:
            with connect(settings.data_dir) as db:
                if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                    raise RuntimeError("请先运行 ocrs init 完成数据库迁移")
            service.recover()
            if start_worker:
                thread = threading.Thread(target=worker, name="ocrs-worker", daemon=True)
                thread.start()
            yield
        finally:
            stop.set()
            if thread:
                thread.join()
            lock.release()

    app = FastAPI(
        title="OCRS 本地订单审核",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.service = service
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]", "testserver"]
    )

    @app.middleware("http")
    async def safety_headers(request: Request, call_next: Any) -> Any:
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse(
                {"error": {"code": "ORIGIN_DENIED", "message": "禁止跨站请求"}}, status_code=403
            )
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > settings.max_upload_bytes * 8 + 65536):
            return JSONResponse(
                {"error": {"code": "UPLOAD_TOO_LARGE", "message": "请求过大"}}, status_code=413
            )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; form-action 'self'"
        )
        return response

    def authenticate(authorization: Annotated[str | None, Header()] = None) -> None:
        expected = "Bearer " + settings.token
        if authorization is None or not hmac.compare_digest(
            authorization.encode(), expected.encode()
        ):
            raise AppError("UNAUTHORIZED", "请输入本地访问令牌", 401)

    auth = [Depends(authenticate)]

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
            status_code=exc.status,
        )

    @app.exception_handler(CaptureError)
    async def capture_error(request: Request, exc: CaptureError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": exc.code, "message": "图片无效或超过限制"}}, status_code=400
        )

    @app.exception_handler(RequestValidationError)
    async def request_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "请求字段无效；请检查必填、金额精度及版本",
                }
            },
            status_code=422,
        )

    @app.exception_handler(ValidationError)
    async def validation_error(request: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": "VALIDATION_ERROR", "message": "订单字段未通过校验"}},
            status_code=422,
        )

    @app.get("/api/status", dependencies=auth)
    def status() -> dict[str, Any]:
        return service.status()

    @app.get("/api/config", dependencies=auth)
    def configuration() -> dict[str, Any]:
        # Explicit allowlist: never serialize Settings, credentials, URLs, or local paths.
        return {
            "version": __version__,
            "schema_version": SCHEMA_VERSION,
            "provider": settings.provider,
            "recognition_mode": "demo" if settings.provider == "demo" else "external",
            "model_configured": bool(settings.model and settings.api_key),
            "external_transmission_enabled": (
                settings.provider != "demo" and settings.allow_external
            ),
            "inbox_enabled": settings.inbox is not None,
            "max_upload_bytes": settings.max_upload_bytes,
            "max_upload_files": 8,
            "evidence_days": settings.evidence_days,
            "sku_catalog": sorted(settings.sku_catalog),
            "supported_currencies": sorted(CURRENCY_MINOR_UNITS),
            "deployment_mode": "single-user-local",
            "backup_mode": "offline-cli",
        }

    @app.get("/api/tasks", dependencies=auth)
    def tasks(
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
        status: Annotated[
            str | None,
            Query(
                pattern="^(received|recognizing|processing|review_required|confirmed|rejected|failed)$"
            ),
        ] = None,
        q: Annotated[str | None, Query(max_length=200)] = None,
    ) -> dict[str, Any]:
        return service.task_page(limit=limit, offset=offset, status=status, q=q)

    @app.get("/api/tasks/{task_id}", dependencies=auth)
    def task(task_id: str) -> dict[str, Any]:
        return service.task(task_id)

    @app.post("/api/uploads", dependencies=auth)
    def upload(
        files: Annotated[list[UploadFile], File()], source_label: Annotated[str, Form()] = "manual"
    ) -> dict[str, Any]:
        if not 1 <= len(files) <= 8:
            raise AppError("UPLOAD_COUNT", "每次上传 1 至 8 张图片")
        results, duplicates = [], []
        # Validate every image first so an invalid batch creates no partial import.
        if not source_label.strip() or len(source_label) > 200:
            raise AppError("SOURCE_INVALID", "来源标签无效")
        if any(len(file.filename or "image") > 255 for file in files):
            raise AppError("SOURCE_INVALID", "文件名过长")
        staged = []
        from ocrs.capture import validate_image

        for file in files:
            data = file.file.read(settings.max_upload_bytes + 1)
            validate_image(data, max_bytes=settings.max_upload_bytes)
            staged.append((data, file.filename or "image"))
        for data, filename in staged:
            task, duplicate = service.ingest(data, filename, source_label)
            results.append(task)
            if duplicate:
                duplicates.append(task["id"])
        return {"tasks": results, "duplicates": duplicates}

    @app.get("/api/sources/{source_id}", dependencies=auth)
    def source(source_id: str) -> FileResponse:
        with connect(settings.data_dir) as db:
            row = db.execute(
                "SELECT path,mime,expired FROM sources WHERE id=?", (source_id,)
            ).fetchone()
        if not row:
            raise AppError("NOT_FOUND", "原图不存在", 404)
        if row["expired"] or not (settings.data_dir / row["path"]).is_file():
            raise AppError("EVIDENCE_EXPIRED", "原图已过期", 410)
        return FileResponse(settings.data_dir / row["path"], media_type=row["mime"])

    @app.post("/api/tasks/{task_id}/retry", dependencies=auth)
    def retry(task_id: str, body: RetryRequest) -> dict[str, Any]:
        return service.retry(task_id, body.expected_version)

    @app.post("/api/tasks/{task_id}/reject", dependencies=auth)
    def reject(task_id: str, body: RejectRequest) -> dict[str, Any]:
        return service.reject(task_id, body.expected_version, body.reason)

    @app.post("/api/tasks/{task_id}/confirm", dependencies=auth)
    def confirm(task_id: str, body: Confirmation) -> dict[str, Any]:
        try:
            return service.confirm(task_id, body)
        except ValueError:
            raise AppError(
                "VALIDATION_ERROR",
                "订单校验未通过；请核对 SKU、必填、数量、金额、目标版本和原因",
                422,
            ) from None

    @app.get("/api/orders", dependencies=auth)
    def orders() -> dict[str, Any]:
        return {"orders": service.orders()}

    @app.get("/api/orders/{order_id}/history", dependencies=auth)
    def history(order_id: str) -> dict[str, Any]:
        import json

        with connect(settings.data_dir) as db:
            rows = db.execute(
                "SELECT * FROM events WHERE order_id=? ORDER BY version", (order_id,)
            ).fetchall()
        return {"events": [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]}

    @app.post("/api/export", dependencies=auth)
    def export() -> dict[str, Any]:
        return service.export()

    @app.get("/api/export/download", dependencies=auth)
    def download() -> FileResponse:
        with connect(settings.data_dir) as db:
            row = db.execute(
                "SELECT path FROM exports WHERE status='completed' ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        if not row or not (settings.data_dir / row["path"]).is_file():
            raise AppError("NOT_FOUND", "请先生成 Excel 快照", 404)
        return FileResponse(
            settings.data_dir / row["path"],
            filename=Path(row["path"]).name,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

    app.add_middleware(
        RequestGuard, token=settings.token, max_bytes=settings.max_upload_bytes * 8 + 65536
    )
    app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
    return app
