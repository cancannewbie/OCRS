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
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ocrs import __version__
from ocrs.capture import MAX_IMAGE_PIXELS, CaptureError
from ocrs.config import Settings
from ocrs.domain import CURRENCY_MINOR_UNITS
from ocrs.model_settings import (
    ModelSettingsConflict,
    ModelSettingsError,
    ModelSettingsStore,
    ModelSettingsUpdate,
)
from ocrs.providers import OpenAICompatibleProvider, ProviderError
from ocrs.recognition_contracts import ErrorResponse, RecognitionResult, RecognitionTask
from ocrs.security import RequestGuard
from ocrs.service import AppError, CandidateRevision, Confirmation, ReviewReopen, Service
from ocrs.storage import SCHEMA_VERSION, connect


class RejectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=500)


class RetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    config_revision: int | None = Field(default=None, ge=0)
    confirm_external: bool = False


class ModelTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    confirm_external: bool = False


def _ingest_inbox(service: Service, data: bytes, label: str) -> tuple[dict[str, Any], bool]:
    filename = label.removeprefix("inbox:")
    # Valid filesystem names can exceed the source-label bound after the prefix.
    # Hash only long labels, preserving previous identities and the full filename.
    source_label = (
        label
        if len(label) <= 200
        else "inbox-long-sha256:" + hashlib.sha256(filename.encode()).hexdigest()
    )
    return service.ingest(data, filename, source_label, from_inbox=True)


def create_app(settings: Settings, *, start_worker: bool = True) -> FastAPI:
    model_store = ModelSettingsStore(settings.data_dir)
    service = Service(settings, model_store=model_store)
    stop = threading.Event()
    lock = FileLock(str(settings.data_dir / "service.lock"), timeout=0)

    def worker() -> None:
        while not stop.is_set():
            try:
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
                if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
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
        title="OCRS 本地图片识别",
        version=__version__,
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
        body_limit = (
            settings.max_upload_bytes * (1 if request.url.path == "/api/recognitions" else 8)
            + 65536
        )
        if length and (
            len(length) > 20
            or not length.isascii()
            or not length.isdigit()
            or int(length) > body_limit
        ):
            return JSONResponse(
                {"error": {"code": "UPLOAD_TOO_LARGE", "message": "请求过大"}}, status_code=413
            )
        try:
            response = await call_next(request)
        except Exception as exc:
            # Catch before ServerErrorMiddleware can re-raise the exception to
            # uvicorn and log a traceback containing private adapter/path data.
            response = await internal_error(request, exc)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; form-action 'self'"
        )
        return response

    bearer = HTTPBearer(auto_error=False, scheme_name="LocalBearerToken")

    def authenticate(
        authorization: Annotated[str | None, Header()] = None,
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)] = None,
    ) -> None:
        expected = "Bearer " + settings.token
        if authorization is None or not hmac.compare_digest(
            authorization.encode(), expected.encode()
        ):
            raise AppError("UNAUTHORIZED", "请输入本地访问令牌", 401)

    auth = [Depends(authenticate)]

    async def recognition_form(request: Request) -> None:
        form = await request.form()
        allowed = {"file", "source_label", "idempotency_key", "config_revision", "confirm_external"}
        if set(form) - allowed or any(len(form.getlist(key)) != 1 for key in form if key != "file"):
            raise AppError("VALIDATION_ERROR", "仅支持声明的识别表单字段且不得重复", 422)
        if not form.getlist("file"):
            raise AppError("VALIDATION_ERROR", "请提供 file 图片文件", 422)
        if len(form.getlist("file")) != 1:
            raise AppError("UPLOAD_COUNT", "正式识别接口每次接收一张图片")

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
            status_code=exc.status,
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {400: "MULTIPART_INVALID", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        return JSONResponse(
            {
                "error": {
                    "code": codes.get(exc.status_code, "HTTP_ERROR"),
                    "message": "请求无法处理，请检查地址、方法与表单格式",
                    "details": None,
                }
            },
            status_code=exc.status_code,
        )

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> JSONResponse:
        logging.getLogger("ocrs.api").error('{"error_code":"INTERNAL_ERROR"}')
        return JSONResponse(
            {
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "服务暂时无法处理请求",
                    "details": None,
                }
            },
            status_code=500,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.exception_handler(ModelSettingsError)
    async def model_settings_error(request: Request, exc: ModelSettingsError) -> JSONResponse:
        conflict = isinstance(exc, ModelSettingsConflict)
        return JSONResponse(
            {
                "error": {
                    "code": "MODEL_SETTINGS_CONFLICT" if conflict else "MODEL_SETTINGS_INVALID",
                    "message": "配置已改变，请重新载入"
                    if conflict
                    else "配置保存或读取失败，请检查字段和本机安全存储",
                }
            },
            status_code=409 if conflict else 422,
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

    @app.get("/api/openapi.json", dependencies=auth, include_in_schema=False)
    def openapi() -> dict[str, Any]:
        return app.openapi()

    @app.get("/api/config", dependencies=auth)
    def configuration() -> dict[str, Any]:
        # Explicit allowlist: never serialize credentials or local paths.
        current = model_store.public()
        return {
            "version": __version__,
            "schema_version": SCHEMA_VERSION,
            "provider": current["provider"],
            "recognition_mode": "demo" if current["provider"] == "demo" else "external",
            "model_configured": current["status"] == "configured",
            "external_transmission_enabled": (
                current["provider"] != "demo" and current["allow_external"]
            ),
            "inbox_enabled": False,
            "max_upload_bytes": settings.max_upload_bytes,
            "max_upload_files": 8,
            "recognition_max_files": 1,
            "max_image_pixels": MAX_IMAGE_PIXELS,
            "max_pending_tasks": settings.max_pending_tasks,
            "recognition_concurrency": 1,
            "recognition_api": "/api/recognitions",
            "evidence_days": settings.evidence_days,
            "sku_catalog": sorted(settings.sku_catalog),
            "supported_currencies": sorted(CURRENCY_MINOR_UNITS),
            "deployment_mode": "single-user-local",
            "backup_mode": "offline-cli",
        }

    @app.get("/api/model-settings", dependencies=auth)
    def model_configuration() -> dict[str, Any]:
        return model_store.public()

    @app.put("/api/model-settings", dependencies=auth)
    def save_model_configuration(body: ModelSettingsUpdate) -> dict[str, Any]:
        return service.save_model_settings(body)

    @app.post("/api/model-settings/enable-external", dependencies=auth)
    def enable_external_configuration(body: ModelTestRequest) -> dict[str, Any]:
        return service.enable_external(body.expected_revision, body.confirm_external)

    @app.post("/api/model-settings/test", dependencies=auth)
    def test_model_configuration(body: ModelTestRequest) -> dict[str, Any]:
        # Save/GET never calls the provider; this explicit request uses only an
        # internally generated synthetic picture, never queued business evidence.
        with service._model_lock:
            runtime, revision = service._authorize_model(
                body.expected_revision, body.confirm_external
            )
            if revision != body.expected_revision:
                raise AppError("MODEL_SETTINGS_CONFLICT", "配置已改变，请重新载入", 409)
            if runtime.provider == "demo":
                raise AppError("MODEL_DEMO", "Demo 不执行真实连接测试", 409)
            provider = service.model_provider(runtime, revision)
        assert isinstance(provider, OpenAICompatibleProvider)
        passed = False
        failure_code = None
        try:
            with service._dispatch_lock:
                with service._model_lock:
                    _, current_revision = service.runtime_settings()
                    if current_revision != revision:
                        raise AppError("MODEL_SETTINGS_CONFLICT", "配置已改变，请重新载入", 409)
                provider.test_connection()
            passed = True
        except AppError:
            raise
        except ProviderError as exc:
            failure_code = exc.code
        except Exception:
            # Neither arbitrary transport exception messages nor model bodies
            # are allowed into HTTP errors, diagnostics or logs.
            failure_code = "RECOGNITION_INTERNAL"
        result = model_store.record_test(revision, passed).public()
        result["test_error_code"] = failure_code
        result["test_message"] = (
            "合成图片测试成功；不代表真实订单识别准确率"
            if passed
            else "连接或候选结构测试失败；请检查凭据、模型权限和网络后手动重试"
        )
        return result

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

    recognition_errors: dict[int | str, dict[str, Any]] = {
        status: {"model": ErrorResponse, "description": description}
        for status, description in {
            400: "IMAGE_INVALID / IMAGE_TYPE_MISMATCH / IMAGE_ANIMATED / "
            "UPLOAD_COUNT / SOURCE_INVALID / MULTIPART_INVALID",
            401: "UNAUTHORIZED",
            409: "MODEL_NOT_CONFIGURED / MODEL_DISABLED / MODEL_CONSENT_REQUIRED / "
            "IDEMPOTENCY_CONFLICT / DEMO_SOURCE_CONFLICT",
            410: "EVIDENCE_EXPIRED",
            413: "IMAGE_TOO_LARGE / IMAGE_TOO_MANY_PIXELS / UPLOAD_TOO_LARGE",
            415: "IMAGE_UNSUPPORTED",
            422: "VALIDATION_ERROR",
            429: "QUEUE_FULL",
            500: "INTERNAL_ERROR",
        }.items()
    }

    @app.post(
        "/api/recognitions",
        dependencies=[*auth, Depends(recognition_form)],
        status_code=202,
        response_model=RecognitionTask,
        responses=recognition_errors,
        summary="提交单张图片进行异步提取",
        description="只接收 PNG/JPEG/WebP 文件，不抓取 URL。source_label 是可选来源备注，"
        "不代表账号身份或指令。config_revision 绑定已核对的模型目的地；"
        "confirm_external=true 仅授权本次图片范围。幂等重放与同图同来源复用"
        "已有任务，不重新识别或续期授权。结果未经人工核实。",
    )
    def recognize(
        file: Annotated[
            UploadFile,
            File(
                description="单张静态 PNG/JPEG/WebP，须与声明MIME一致",
                json_schema_extra={"format": "binary"},
            ),
        ],
        source_label: Annotated[str, Form(max_length=200)] = "manual",
        idempotency_key: Annotated[str | None, Form(min_length=8, max_length=100)] = None,
        config_revision: Annotated[int | None, Form(ge=0)] = None,
        confirm_external: Annotated[bool, Form()] = False,
    ) -> dict[str, Any]:
        return service.submit_recognition(
            file.file.read(settings.max_upload_bytes + 1),
            file.filename or "image",
            file.content_type,
            source_label,
            idempotency_key=idempotency_key,
            config_revision=config_revision,
            confirm_external=confirm_external,
        )

    @app.get(
        "/api/recognitions/{task_id}",
        dependencies=auth,
        response_model=RecognitionTask,
        responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
        summary="查询提取任务状态",
    )
    def recognition_status(task_id: str) -> dict[str, Any]:
        return service.recognition_task(task_id)

    @app.get(
        "/api/recognitions/{task_id}/result",
        dependencies=auth,
        response_model=RecognitionResult,
        responses={
            401: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            409: {"model": ErrorResponse, "description": "RESULT_NOT_READY / RECOGNITION_FAILED"},
            410: {"model": ErrorResponse, "description": "EVIDENCE_EXPIRED"},
        },
        summary="读取本次任务的原始模型提取结果",
        description="候选无需完成商品映射或人工审核即可读取。人工修订、确认和导出不改变"
        "此模型候选；返回 verified=false，不等于正式订单。",
    )
    def recognition_result(task_id: str) -> dict[str, Any]:
        return service.recognition_result(task_id)

    @app.post(
        "/api/uploads",
        dependencies=auth,
        deprecated=True,
        description="兼容批量人工导入与显式虚构 demo；新接入使用 /api/recognitions",
    )
    def upload(
        files: Annotated[list[UploadFile], File()],
        source_label: Annotated[str, Form()] = "manual",
        config_revision: Annotated[int | None, Form(ge=0)] = None,
        confirm_external: Annotated[bool, Form()] = False,
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
            task, duplicate = service.ingest(
                data,
                filename,
                source_label,
                config_revision=config_revision,
                confirm_external=confirm_external,
            )
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
        return service.retry(
            task_id,
            body.expected_version,
            config_revision=body.config_revision,
            confirm_external=body.confirm_external,
        )

    @app.post("/api/tasks/{task_id}/reject", dependencies=auth)
    def reject(task_id: str, body: RejectRequest) -> dict[str, Any]:
        return service.reject(task_id, body.expected_version, body.reason)

    @app.put("/api/tasks/{task_id}/candidate", dependencies=auth)
    def save_candidate(task_id: str, body: CandidateRevision) -> dict[str, Any]:
        return service.save_candidate(task_id, body)

    @app.post("/api/tasks/{task_id}/reopen", dependencies=auth)
    def reopen_review(task_id: str, body: ReviewReopen) -> dict[str, Any]:
        return service.reopen_review(task_id, body)

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
        RequestGuard,
        token=settings.token,
        max_bytes=settings.max_upload_bytes * 8 + 65536,
        recognition_max_bytes=settings.max_upload_bytes + 65536,
    )
    app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
    return app
