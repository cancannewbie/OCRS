"""Reject unauthorized and over-limit bodies before multipart parsing."""

import hmac
import tempfile

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestGuard:
    def __init__(self, app: ASGIApp, token: str, max_bytes: int):
        self.app = app
        self.expected = ("Bearer " + token).encode()
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        if not hmac.compare_digest(headers.get(b"authorization", b""), self.expected):
            await self._error(scope, receive, send, 401, "UNAUTHORIZED", "请输入本地访问令牌")
            return
        length = headers.get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > self.max_bytes):
            await self._error(scope, receive, send, 413, "UPLOAD_TOO_LARGE", "请求过大")
            return
        # Bound chunked bodies before framework parsers can translate a size failure
        # into a generic 400 or allocate unlimited multipart temporary storage.
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as body:
            consumed = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                consumed += len(chunk)
                if consumed > self.max_bytes:
                    await self._error(scope, receive, send, 413, "UPLOAD_TOO_LARGE", "请求过大")
                    return
                body.write(chunk)
                if not message.get("more_body", False):
                    break
            body.seek(0)
            replayed = 0
            delivered_final = False

            async def replay() -> Message:
                nonlocal replayed, delivered_final
                if delivered_final:
                    return await receive()
                if replayed < consumed:
                    chunk = body.read(65536)
                    replayed += len(chunk)
                    delivered_final = replayed == consumed
                    return {"type": "http.request", "body": chunk, "more_body": replayed < consumed}
                delivered_final = True
                return {"type": "http.request", "body": b"", "more_body": False}

            await self.app(scope, replay, send)

    @staticmethod
    async def _error(
        scope: Scope, receive: Receive, send: Send, status: int, code: str, message: str
    ) -> None:
        response = JSONResponse(
            {"error": {"code": code, "message": message}},
            status_code=status,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
        await response(scope, receive, send)
