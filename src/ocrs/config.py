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
        # Model settings are entered only through the authenticated local page.
        # Legacy model environment variables are deliberately not imported: doing
        # so could silently send a previous queue to an unreviewed destination.
        inbox = os.getenv("OCRS_INBOX", "")
        catalog = frozenset(
            s.strip() for s in os.getenv("OCRS_SKUS", "DEMO-001").split(",") if s.strip()
        )
        if not catalog:
            raise ValueError("OCRS_SKUS 不得为空")
        return cls(
            root.resolve(),
            token,
            inbox=Path(inbox).expanduser().absolute() if inbox else None,
            sku_catalog=catalog,
        )
