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
        if provider not in {"demo", "openai-compatible"}:
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
        return cls(
            root.resolve(),
            token,
            provider,
            os.getenv("OCRS_MODEL_URL", "https://api.openai.com/v1"),
            model,
            key,
            external,
            Path(inbox).expanduser().absolute() if inbox else None,
            catalog,
        )
