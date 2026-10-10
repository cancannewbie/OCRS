"""Validated backend-only configuration; secrets are never sent to clients."""

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    token: str = field(repr=False)
    provider: str = "demo"
    model_url: str = "https://api.openai.com/v1"
    model: str = ""
    api_key: str = field(default="", repr=False)
    allow_external: bool = False
    inbox: Path | None = None
    sku_catalog: frozenset[str] = frozenset({"DEMO-001"})
    max_upload_bytes: int = 10 * 1024 * 1024
    max_requests: int = 100
    evidence_days: int = 30
    model_timeout_seconds: int = 15
    model_total_timeout_seconds: int = 45
    model_max_output_tokens: int = 4096

    @classmethod
    def from_env(cls) -> "Settings":
        root = Path(os.getenv("OCRS_DATA_DIR", str(Path.home() / ".ocrs"))).expanduser()
        token = os.getenv("OCRS_ACCESS_TOKEN", "")
        token_path = root / "access-token"
        if not token and token_path.is_file():
            token = token_path.read_text().strip()
        if len(token) < 32:
            raise ValueError("OCRS_ACCESS_TOKEN 必须至少 32 字符；请先运行 ocrs init")
        provider = os.getenv("OCRS_PROVIDER", "demo")
        if provider not in {"demo", "openai-compatible", "minimax-cn"}:
            raise ValueError("OCRS_PROVIDER 无效")
        external = os.getenv("OCRS_ALLOW_EXTERNAL", "false").lower() == "true"
        key = os.getenv("OCRS_API_KEY", "")
        model = os.getenv("OCRS_MODEL", "")
        if provider != "demo" and (not external or not key or not model):
            raise ValueError("真实模型需要 OCRS_ALLOW_EXTERNAL、OCRS_API_KEY、OCRS_MODEL")
        inbox = os.getenv("OCRS_INBOX", "")
        catalog = frozenset(
            s.strip() for s in os.getenv("OCRS_SKUS", "DEMO-001").split(",") if s.strip()
        )
        if not catalog:
            raise ValueError("OCRS_SKUS 不得为空")
        default_url = (
            "https://api.minimax.cn/v1" if provider == "minimax-cn" else "https://api.openai.com/v1"
        )
        limits: dict[str, int] = {}
        for name, default, low, high in (
            ("OCRS_MODEL_TIMEOUT_SECONDS", 60 if provider == "minimax-cn" else 15, 1, 60),
            ("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS", 120 if provider == "minimax-cn" else 45, 1, 180),
            ("OCRS_MODEL_MAX_OUTPUT_TOKENS", 4096, 1, 8192),
            ("OCRS_MAX_REQUESTS", 100, 1, 100_000),
        ):
            try:
                value = int(os.getenv(name, str(default)))
            except ValueError:
                raise ValueError(f"{name} 必须是范围内的整数") from None
            if not low <= value <= high:
                raise ValueError(f"{name} 超出允许范围 {low}–{high}")
            limits[name] = value
        if limits["OCRS_MODEL_TOTAL_TIMEOUT_SECONDS"] < limits["OCRS_MODEL_TIMEOUT_SECONDS"]:
            raise ValueError("OCRS_MODEL_TOTAL_TIMEOUT_SECONDS 不得小于单次超时")
        return cls(
            root.resolve(),
            token,
            provider,
            os.getenv("OCRS_MODEL_URL", default_url),
            model,
            key,
            external,
            Path(inbox).expanduser().absolute() if inbox else None,
            catalog,
            max_requests=limits["OCRS_MAX_REQUESTS"],
            model_timeout_seconds=limits["OCRS_MODEL_TIMEOUT_SECONDS"],
            model_total_timeout_seconds=limits["OCRS_MODEL_TOTAL_TIMEOUT_SECONDS"],
            model_max_output_tokens=limits["OCRS_MODEL_MAX_OUTPUT_TOKENS"],
        )
