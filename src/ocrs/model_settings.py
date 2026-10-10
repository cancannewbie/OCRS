"""Versioned runtime model settings; credentials stay encrypted and outside backups."""

import ctypes
import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from ocrs.safe_transport import validate_public_host


class ModelSettingsError(Exception):
    """Safe-to-display configuration failure, never includes supplied values."""


class ModelSettingsConflict(ModelSettingsError):
    """The supplied revision is no longer current."""


def validate_base_url(value: str) -> str:
    """Validate syntax without DNS or network; runtime must also prevent SSRF."""
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or "?" in value
            or "#" in value
            or any(ord(c) <= 32 or ord(c) >= 127 for c in value)
            or "\\" in value
            or "%" in parsed.netloc
            or parsed.port not in {None, 443}
        ):
            raise ValueError
        validate_public_host(host)
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if (
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host)
                or "." not in host
                or any(not label or len(label) > 63 for label in host.split("."))
                or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid"))
                or host in {"metadata.google.internal", "metadata.azure.com"}
                or re.fullmatch(r"[0-9.]+", host)
                or len(host) > 253
            ):
                raise ValueError from None
        else:
            if not address.is_global:
                raise ValueError
    except (ValueError, UnicodeError):
        raise ValueError("模型地址必须为不含凭据或参数的公网 HTTPS 地址") from None
    return value.rstrip("/")


class ModelSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)
    expected_revision: int = Field(ge=0)
    provider: Literal["demo", "openai-compatible", "minimax-cn"]
    model: str = Field(default="", max_length=200)
    base_url: str = Field(default="https://api.openai.com/v1", max_length=2048)
    allow_external: bool = False
    api_key_action: Literal["keep", "replace", "delete"] = "keep"
    api_key: SecretStr | None = Field(default=None, repr=False, exclude=True)
    timeout_seconds: int = Field(default=15, ge=1, le=60)
    total_timeout_seconds: int = Field(default=45, ge=1, le=180)
    max_output_tokens: int = Field(default=4096, ge=1, le=8192)
    max_requests: int = Field(default=100, ge=1, le=100_000)

    @model_validator(mode="after")
    def validate_settings(self) -> "ModelSettingsUpdate":
        if self.total_timeout_seconds < self.timeout_seconds:
            raise ValueError("总超时不得小于单次超时")
        if any(ord(c) < 32 or ord(c) == 127 for c in self.model):
            raise ValueError("模型名称不可包含控制字符")
        self.model = self.model.strip()
        if self.provider == "minimax-cn":
            if (
                self.model != "MiniMax-M3"
                or self.base_url.rstrip("/") != "https://api.minimax.cn/v1"
            ):
                raise ValueError("MiniMax 国内服务必须使用固定地址和 MiniMax-M3 模型")
        if self.provider != "demo":
            self.base_url = validate_base_url(self.base_url)
        else:
            self.model = ""
            self.base_url = "https://api.openai.com/v1"
            self.allow_external = False
        secret = self.api_key.get_secret_value() if self.api_key else ""
        if len(secret) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in secret):
            raise ValueError("API Key 必须为最多 8192 字符的安全 ASCII 文本")
        if secret and self.api_key_action != "replace":
            raise ValueError("提供新 API Key 时必须选择替换")
        if self.api_key_action == "replace" and not secret:
            raise ValueError("替换 API Key 时不得为空")
        return self


@dataclass(frozen=True)
class ModelSnapshot:
    revision: int = 0
    provider: str = "demo"
    model: str = ""
    base_url: str = "https://api.openai.com/v1"
    api_key: str = field(default="", repr=False)
    allow_external: bool = False
    timeout_seconds: int = 15
    total_timeout_seconds: int = 45
    max_output_tokens: int = 4096
    max_requests: int = 100
    test_status: str = "not_tested"

    def public(self) -> dict[str, Any]:
        status = (
            "demo"
            if self.provider == "demo"
            else ("configured" if self.api_key and self.model else "not_configured")
        )
        return {
            "revision": self.revision,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "api_key_configured": bool(self.api_key),
            "credential_status": "available" if self.api_key else "missing",
            "allow_external": self.allow_external,
            "status": status,
            "test_status": self.test_status,
            "timeout_seconds": self.timeout_seconds,
            "total_timeout_seconds": self.total_timeout_seconds,
            "max_output_tokens": self.max_output_tokens,
            "max_requests": self.max_requests,
        }


def _dpapi(data: bytes, *, decrypt: bool = False) -> bytes:
    """Bind the master key to the current Windows account; no plaintext fallback."""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    name = "CryptUnprotectData" if decrypt else "CryptProtectData"
    function = getattr(crypt32, name)
    function.argtypes = [
        ctypes.POINTER(Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(Blob),
    ]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ModelSettingsError("无法访问系统密钥保护服务")
    try:
        return ctypes.string_at(target.data, target.length)
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(target.data)


class ModelSettingsStore:
    """A separate SQLite file is deliberately absent from business backup bundles."""

    def __init__(self, data_dir: Path, *, key_dir: Path | None = None):
        self.data_dir = data_dir.resolve()
        self.path = self.data_dir / "model-settings.sqlite3"
        identity = hashlib.sha256(os.fsencode(self.data_dir)).hexdigest()
        self.key_dir = (key_dir or Path.home() / ".ocrs-model-keys").resolve()
        if self.key_dir == self.data_dir or self.data_dir in self.key_dir.parents:
            raise ModelSettingsError("加密主密钥必须保存在业务数据目录之外")
        self.key_path = self.key_dir / (identity + ".key")
        self._aad = identity.encode("ascii")
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.path.is_symlink():
                raise OSError
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT, 0o600)
            os.close(fd)
            with self._connect() as connection:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS model_settings "
                    "(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, "
                    "config TEXT NOT NULL, secret BLOB, test_status TEXT NOT NULL)"
                )
                connection.execute(
                    "INSERT OR IGNORE INTO model_settings VALUES(1,0,?,NULL,?)",
                    (
                        json.dumps(
                            ModelSettingsUpdate(expected_revision=0, provider="demo").model_dump(
                                exclude={"expected_revision", "api_key_action"}
                            )
                        ),
                        "not_tested",
                    ),
                )
            if os.name != "nt":
                self.path.chmod(0o600)
        except (OSError, sqlite3.Error):
            raise ModelSettingsError("无法打开模型配置存储") from None

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _key(self, *, create: bool) -> bytes:
        try:
            if self.key_dir.is_symlink() or self.key_path.is_symlink():
                raise OSError
            self.key_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            if os.name != "nt":
                self.key_dir.chmod(0o700)
            with FileLock(str(self.key_path) + ".lock", timeout=10):
                if not self.key_path.exists():
                    if not create:
                        raise OSError
                    key = AESGCM.generate_key(bit_length=256)
                    encoded = _dpapi(key) if os.name == "nt" else key
                    fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(encoded)
                        stream.flush()
                        os.fsync(stream.fileno())
                if os.name != "nt":
                    self.key_path.chmod(0o600)
                encoded = self.key_path.read_bytes()
                try:
                    key = _dpapi(encoded, decrypt=True) if os.name == "nt" else encoded
                    if len(key) != 32:
                        raise ModelSettingsError("加密主密钥格式损坏")
                except ModelSettingsError:
                    if not create:
                        raise
                    # Only explicit credential replacement reaches create=True.
                    # Replace an unusable key atomically; ordinary reads never repair it.
                    key = AESGCM.generate_key(bit_length=256)
                    encoded = _dpapi(key) if os.name == "nt" else key
                    fd, temporary = tempfile.mkstemp(prefix=".key-", dir=self.key_dir)
                    try:
                        with os.fdopen(fd, "wb") as stream:
                            stream.write(encoded)
                            stream.flush()
                            os.fsync(stream.fileno())
                        os.replace(temporary, self.key_path)
                    finally:
                        if os.path.exists(temporary):
                            os.unlink(temporary)
                return key
        except (OSError, TimeoutError):
            raise ModelSettingsError("无法访问模型加密主密钥；请恢复原密钥或重新配置") from None

    def _decode(self, row: sqlite3.Row) -> ModelSnapshot:
        try:
            config = json.loads(row["config"])
            validated = ModelSettingsUpdate(expected_revision=row["revision"], **config)
            key = ""
            if row["secret"] is not None:
                ciphertext = bytes(row["secret"])
                key = (
                    AESGCM(self._key(create=False))
                    .decrypt(ciphertext[:12], ciphertext[12:], self._aad)
                    .decode("ascii")
                )
            return ModelSnapshot(
                revision=row["revision"],
                api_key=key,
                test_status=row["test_status"],
                **validated.model_dump(exclude={"expected_revision", "api_key_action"}),
            )
        except ModelSettingsError:
            raise
        except Exception:
            raise ModelSettingsError("模型配置无法解密或已损坏；请重新配置") from None

    def snapshot(self) -> ModelSnapshot:
        try:
            with self._connect() as connection:
                return self._decode(
                    connection.execute("SELECT * FROM model_settings WHERE id=1").fetchone()
                )
        except sqlite3.Error:
            raise ModelSettingsError("无法读取模型配置") from None

    def public(self) -> dict[str, Any]:
        """Expose recoverable metadata when the credential cannot be decrypted."""
        try:
            with self._connect() as connection:
                row = connection.execute("SELECT * FROM model_settings WHERE id=1").fetchone()
                # Validate metadata before catching a decryption failure. A corrupt
                # configuration must not be mistaken for a recoverable missing key.
                try:
                    validated = ModelSettingsUpdate(
                        expected_revision=row["revision"], **json.loads(row["config"])
                    )
                    if row["test_status"] not in {"not_tested", "passed", "failed"}:
                        raise ValueError
                    metadata = ModelSnapshot(
                        revision=row["revision"],
                        test_status=row["test_status"],
                        **validated.model_dump(exclude={"expected_revision", "api_key_action"}),
                    ).public()
                except Exception:
                    raise ModelSettingsError("模型配置元数据已损坏；请修复本机配置存储") from None
                try:
                    return self._decode(row).public()
                except ModelSettingsError:
                    if row["secret"] is None:
                        raise
                    metadata.update(
                        api_key_configured=True,
                        credential_status="unavailable",
                        status="not_configured",
                        test_status="not_tested",
                    )
                    return metadata
        except sqlite3.Error:
            raise ModelSettingsError("无法读取模型配置") from None

    def save(self, payload: ModelSettingsUpdate) -> ModelSnapshot:
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM model_settings WHERE id=1").fetchone()
                if payload.expected_revision != row["revision"]:
                    raise ModelSettingsConflict("配置已被另一页面更新，请刷新后重试")
                previous = json.loads(row["config"])
                changed_destination = (previous["provider"], previous["base_url"]) != (
                    payload.provider,
                    payload.base_url,
                )
                ciphertext = row["secret"]
                if payload.provider == "demo" or payload.api_key_action == "delete":
                    ciphertext = None
                elif payload.api_key_action == "replace":
                    assert payload.api_key is not None
                    nonce = os.urandom(12)
                    ciphertext = nonce + AESGCM(self._key(create=True)).encrypt(
                        nonce, payload.api_key.get_secret_value().encode("ascii"), self._aad
                    )
                elif changed_destination and ciphertext is not None:
                    raise ModelSettingsError("供应商或地址改变后，请替换或删除原 API Key")
                config = payload.model_dump(exclude={"expected_revision", "api_key_action"})
                connection.execute(
                    "UPDATE model_settings SET revision=revision+1, config=?, "
                    "secret=?, test_status='not_tested' WHERE id=1",
                    (json.dumps(config), ciphertext),
                )
                result = self._decode(
                    connection.execute("SELECT * FROM model_settings WHERE id=1").fetchone()
                )
            return result
        except (sqlite3.Error, OSError, ValueError, TypeError):
            raise ModelSettingsError("模型配置保存失败") from None

    def record_test(self, expected_revision: int, passed: bool) -> ModelSnapshot:
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                result = connection.execute(
                    "UPDATE model_settings SET test_status=? WHERE id=1 AND revision=?",
                    ("passed" if passed else "failed", expected_revision),
                )
                if result.rowcount != 1:
                    raise ModelSettingsConflict("测试期间配置已改变，请重新测试")
                snapshot = self._decode(
                    connection.execute("SELECT * FROM model_settings WHERE id=1").fetchone()
                )
            return snapshot
        except sqlite3.Error:
            raise ModelSettingsError("无法保存模型测试结果") from None
