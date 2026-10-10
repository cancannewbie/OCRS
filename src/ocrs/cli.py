"""Explicit initialization and loopback-only single-process service entrypoint."""

import argparse
import os
import secrets
import shutil
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from filelock import FileLock

from ocrs.storage import (
    SCHEMA_VERSION,
    EvidenceIntegrityError,
    backup,
    connect,
    copy_evidence,
    evidence_path,
    migrate,
    transaction,
    verify_evidence,
)


def main() -> None:
    load_dotenv(override=False)
    parser = argparse.ArgumentParser(description="OCRS 本地截图信息识别（可选订单审核与导出）")
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
        source = args.source.expanduser().absolute()
        if source.is_symlink() or source.is_junction():
            parser.error("备份根目录不得是符号链接或目录联接")
        source = source.resolve()
        if root.is_relative_to(source):
            parser.error("恢复目标必须位于备份目录之外")
        database = source / "ocrs.sqlite3"
        # SQLite can automatically read or write its fixed journal sidecars.
        for suffix in ("", "-wal", "-shm", "-journal"):
            database_file = source / f"ocrs.sqlite3{suffix}"
            if database_file.is_symlink() or database_file.is_junction():
                parser.error("备份数据库及日志文件不得是符号链接或目录联接")
        if not database.is_file() or not (source / "images").is_dir():
            parser.error("备份缺少数据库或图片目录")
        images = source / "images"
        if images.is_symlink() or images.is_junction():
            parser.error("备份图片目录不得是符号链接或目录联接")
        with closing(sqlite3.connect(database)) as db:
            if db.execute("PRAGMA user_version").fetchone()[0] not in range(1, SCHEMA_VERSION + 1):
                parser.error("备份数据库版本不受支持")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                parser.error("备份数据库完整性检查失败")
            if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                parser.error("备份数据库关联完整性检查失败")
            try:
                paths = verify_evidence(source, db)
            except EvidenceIntegrityError:
                parser.error("备份图片引用不完整或摘要不匹配")
        root.mkdir(mode=0o700)
        shutil.copy2(database, root / "ocrs.sqlite3")
        copy_evidence(source, root, paths)
        with connect(root) as db:
            try:
                verify_evidence(root, db)
            except EvidenceIntegrityError:
                parser.error("恢复后的图片引用不完整或摘要不匹配，请保留原备份并使用新目录重试")
        migrate(root)
        with transaction(root) as db:
            db.execute("DELETE FROM exports")
            db.execute(
                "UPDATE tasks SET model_revision=-1,external_authorized=0,"
                "status=CASE WHEN status='received' THEN 'failed' ELSE status END,"
                "error_code=CASE WHEN status='received' THEN 'MODEL_CONFIG_CHANGED' "
                "ELSE error_code END"
            )
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
            try:
                backup(root, args.destination.resolve())
            except EvidenceIntegrityError:
                parser.error("原图缺失、引用无效或摘要不匹配，备份未完成")
        print("备份完成，包含数据库及原图，不含密钥和可重建 Excel。")
    elif args.command == "purge-evidence":
        if not args.confirm or args.days < 1:
            parser.error("请指定 --days >=1 并用 --confirm 确认永久删除；请先停服务并核对保留策略")
        cutoff = (datetime.now(UTC) - timedelta(days=args.days)).isoformat()
        with FileLock(str(root / "service.lock"), timeout=0):
            with transaction(root) as db:
                rows = db.execute(
                    "SELECT id,path FROM sources WHERE expired=1 OR (created_at<? AND expired=0)",
                    (cutoff,),
                ).fetchall()
                try:
                    paths = [evidence_path(root, row["path"]) for row in rows]
                except EvidenceIntegrityError:
                    parser.error("到期图片引用无效，未执行删除")
                for row in rows:
                    db.execute("UPDATE sources SET expired=1 WHERE id=?", (row["id"],))
                    db.execute(
                        (
                            "DELETE FROM candidate_history WHERE task_id IN (SELECT id FROM "
                            "tasks WHERE source_id=?)"
                        ),
                        (row["id"],),
                    )
                    db.execute(
                        "DELETE FROM candidate_revisions WHERE task_id IN "
                        "(SELECT id FROM tasks WHERE source_id=?)",
                        (row["id"],),
                    )
                    db.execute("UPDATE tasks SET candidate=NULL WHERE source_id=?", (row["id"],))
            # Commit logical expiry before deleting bytes. Already-expired rows are
            # included above so interruptions and individual unlink failures can retry.
            delete_failed = False
            for path in paths:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    delete_failed = True
            with connect(root) as db:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")
            if delete_failed:
                parser.error(
                    "部分到期图片删除失败；证据已标记过期，请排除文件占用或权限问题后重试同一命令"
                )
        print(f"已处理 {len(rows)} 份到期证据（含重试清理）；正式订单与审计保留，备份需单独清理。")


def _create_token(root: Path) -> None:
    path = root / "access-token"
    if not path.exists():
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(secrets.token_urlsafe(32) + "\n")


if __name__ == "__main__":
    main()
