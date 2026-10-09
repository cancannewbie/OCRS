"""Explicit initialization and loopback-only single-process service entrypoint."""

import argparse
import os
import secrets
import shutil
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from filelock import FileLock

from ocrs.storage import backup, connect, migrate, transaction


def main() -> None:
    load_dotenv(override=False)
    parser = argparse.ArgumentParser(description="OCRS 本地截图订单审核")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="创建本地数据库、应用迁移并生成本地访问令牌")
    commands.add_parser("token", help="在本机终端显示访问令牌，请勿分享或记录")
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8000)
    backup_cmd = commands.add_parser("backup")
    backup_cmd.add_argument("destination", type=Path)
    restore = commands.add_parser("restore")
    restore.add_argument("source", type=Path)
    purge = commands.add_parser("purge-evidence")
    purge.add_argument("--days", type=int, default=30)
    purge.add_argument("--confirm", action="store_true", help="确认永久删除到期图片和候选原文")
    args = parser.parse_args()
    root = Path(os.getenv("OCRS_DATA_DIR", str(Path.home() / ".ocrs"))).expanduser().resolve()
    if args.command == "restore":
        if root.exists():
            parser.error("恢复目标必须是不存在的新 OCRS_DATA_DIR")
        source = args.source.resolve()
        if not (source / "ocrs.sqlite3").is_file() or not (source / "images").is_dir():
            parser.error("备份缺少数据库或图片目录")
        if source.is_symlink() or any(path.is_symlink() for path in source.rglob("*")):
            parser.error("备份不得包含符号链接")
        with sqlite3.connect(source / "ocrs.sqlite3") as db:
            if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                parser.error("备份数据库版本不受支持")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                parser.error("备份数据库完整性检查失败")
            if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                parser.error("备份数据库关联完整性检查失败")
            for row in db.execute("SELECT path FROM sources WHERE expired=0"):
                path = Path(row[0])
                resolved = (source / path).resolve()
                if (
                    not path.parts
                    or path.is_absolute()
                    or ".." in path.parts
                    or path.parts[0] != "images"
                    or not resolved.is_relative_to(source / "images")
                    or not resolved.is_file()
                ):
                    parser.error("备份图片引用不完整")
        root.mkdir(mode=0o700)
        shutil.copy2(source / "ocrs.sqlite3", root / "ocrs.sqlite3")
        shutil.copytree(source / "images", root / "images")
        migrate(root)
        with transaction(root) as db:
            db.execute("DELETE FROM exports")
            db.execute("UPDATE outbox SET status='pending',export_id=NULL,error_code=NULL")
        _create_token(root)
        print("已恢复并重置导出状态。请运行 ocrs token，再启动服务并重建 Excel。")
        return
    if args.command == "init":
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with FileLock(str(root / "service.lock"), timeout=0):
            migrate(root)
            _create_token(root)
        print("本地数据库已初始化。运行 ocrs token 获取访问令牌，然后运行 ocrs serve。")
    elif args.command == "token":
        from ocrs.config import Settings

        print(Settings.from_env().token)
    elif args.command == "serve":
        import uvicorn

        from ocrs.api import create_app
        from ocrs.config import Settings

        settings = Settings.from_env()
        if not (root / "ocrs.sqlite3").is_file():
            parser.error("请先运行 ocrs init")
        uvicorn.run(create_app(settings), host="127.0.0.1", port=args.port, access_log=False)
    elif args.command == "backup":
        if args.destination.resolve().is_relative_to(root):
            parser.error("备份目标必须位于数据目录之外")
        with FileLock(str(root / "service.lock"), timeout=0):
            backup(root, args.destination.resolve())
        print("备份完成，包含数据库及原图，不含密钥和可重建 Excel。")
    elif args.command == "purge-evidence":
        if not args.confirm or args.days < 1:
            parser.error("请指定 --days >=1 并用 --confirm 确认永久删除；请先停服务并核对保留策略")
        cutoff = (datetime.now(UTC) - timedelta(days=args.days)).isoformat()
        with FileLock(str(root / "service.lock"), timeout=0):
            with transaction(root) as db:
                rows = db.execute(
                    "SELECT id,path FROM sources WHERE created_at<? AND expired=0", (cutoff,)
                ).fetchall()
                for row in rows:
                    (root / row["path"]).unlink(missing_ok=True)
                    db.execute("UPDATE sources SET expired=1 WHERE id=?", (row["id"],))
                    db.execute(
                        (
                            "DELETE FROM candidate_history WHERE task_id IN (SELECT id FROM "
                            "tasks WHERE source_id=?)"
                        ),
                        (row["id"],),
                    )
                    db.execute("UPDATE tasks SET candidate=NULL WHERE source_id=?", (row["id"],))
            with connect(root) as db:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")
        print(f"已清理 {len(rows)} 份到期证据；正式订单与审计保留，备份需单独清理。")


def _create_token(root: Path) -> None:
    path = root / "access-token"
    if not path.exists():
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(secrets.token_urlsafe(32) + "\n")


if __name__ == "__main__":
    main()
