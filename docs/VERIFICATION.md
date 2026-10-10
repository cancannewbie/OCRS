# 验证记录

## 0.3.0：来源无关的截图识别服务

2026-10-10，在从最新 `main`（`0b69f2d5ce31485435acf3c3c6f85701fc4f19a8`）创建的独立 Windows 工作区验证。只使用完全虚构的图片、临时数据库和模型 HTTP mock；没有读取用户模型凭据、调用付费模型、接入微信、操作运行数据库或重启用户服务。

本地运行时为 Python 3.12.13、Node.js 22.22.2、uv 0.12.23（通过 `uv tool run --from uv==0.12.23 uv ...` 调用与 CI 相同的版本）。实际结果：

| 命令／检查 | 结果 |
| --- | --- |
| `uv sync --locked --python 3.12`、`npm ci` | 锁定依赖安装成功；无新增运行依赖 |
| `uv run --locked ruff check .` | 通过 |
| `uv run --locked ruff format --check .` | 50 个文件格式通过 |
| `uv run --locked mypy src` | 14 个源文件通过 |
| `uv run --locked pytest -q -rs` | 549 passed、9 skipped、1 个上游弃用警告，72.40 秒 |
| `node --check src/ocrs/static/app.js` | 通过 |
| `npm run test:frontend` | 114 项 DOM 回归通过 |
| `npm run test:e2e` | 57 项真实 Chromium 回归通过，6.3 分钟；390、1366、1440 像素宽度 |
| `uv build` | 生成 `ocrs-0.3.0` wheel 和源码包成功 |
| API 文档检查 | 38 个本地链接、2 个 JSON 契约示例、Python 示例语法/Ruff 通过；离线执行成功轮询及缺授权、配置变化、失败分支 |
| `git diff --check` | 通过 |

识别回归覆盖单图 multipart、实际格式／内容／大小／数量／像素限制、鉴权、显式目的地及图片授权、重复与耐久幂等、队列容量、异步提交、配置切换与发送并发、失败和未就绪、恢复与迁移、原候选隔离、未知商品、null 和十进制字段。既有审核、复审、改单／撤单、审计、Excel 与备份恢复均参与完整回归。浏览器覆盖真实图片解码、worker 与 API、原图预览、原始结果、API 接入、移动／桌面布局、键盘焦点、轮询、减少动效与强制色彩。

本机 9 项跳过均因当前 Windows 账户不能创建符号链接：`test_capture_export.py` 2 项、`test_cli.py` 1 项、既有 `test_recovery.py` 6 项。新兼容判断只跳过 Windows 错误 1314，其他错误仍失败；Linux CI 应执行相应用例。Starlette TestClient 的 httpx 兼容层弃用警告未影响测试结果。

Windows/Linux CI 的结论以对应 PR 和最终提交的 GitHub Actions 为准，不把本地通过写成 CI 通过。截图和浏览器报告在隔离工作区的 gitignored `test-results/`，CI 保存对应构建产物。

尚未验证真实供应商连通性、付费调用、真实图片准确率及原生 Excel 打开效果；没有部署此版本，也没有迁移用户的运行数据。数据库 schema 3 → 4 的备份、迁移和恢复步骤见 [运维说明](OPERATIONS.md)，调用方式见 [识别 API 接入](RECOGNITION_API.md)。以下保留首版历史记录，其限制不代表本次浏览器验收状态。

## 首版历史验证记录

2026-10-09，使用完全虚构的数据和临时数据库，在隔离的 Python 3.12/Linux 工作区完成：

- `uv run --locked ruff check .`、`ruff format --check .`、`mypy src` 通过。
- `uv run --locked pytest -q`：204 项离线测试通过。包括模型契约、金额精度、图片校验、鉴权、上传、人工审核、并发/幂等、改单/撤单事务回滚、导出、备份恢复、过期证据清理。
- `node --check src/ocrs/static/app.js` 通过。
- `uv build` 生成 wheel 和源码包；静态页面随包发布。
- 以 FastAPI TestClient 对实际应用执行上传、demo 候选、图像预览鉴权、提交审核 JSON、幂等确认和 XLSX 下载，结果符合接口契约。
- 以隔离 DOM 环境检查 21 条界面流程，包括登录/退出、任务切换、轮询保留修改、重复提交、重复单明确确认、版本冲突、拒绝/重试、XSS 文本、导出与大小写错误码。

## 未验证与限制

- Chromium 实际启动被当前执行器的 socket 权限限制阻断，因此没有真实浏览器视觉/布局/交互验收，也不能把 DOM 检查当作浏览器验收。
- 没有调用真实付费模型，没有上传客户资料，没有真实图片准确率结论。真实适配器只做了 HTTP mock 契约和失败测试。
- 没有连接微信或企业微信，没有验证微信聊天自动监听。
- 没有在 Windows 桌面或原生 Excel 中打开页面/工作簿；CI 包含 Linux 和 Windows，具体提交结果请看对应 GitHub Actions。
- 测试依赖 Starlette TestClient 提示 httpx 兼容层未来弃用，当前测试通过；后续升级需继续检查兼容性。

本记录描述首版本地验证。之后的变更以对应提交的 CI、测试报告和人工验收为准。GitHub CI 不是部署，draft PR 也不代表已合并或可以处理真实客户资料。
