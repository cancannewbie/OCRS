# 首版验证记录

2026-10-09，使用完全虚构的数据和临时数据库，在隔离的 Python 3.12/Linux 工作区完成：

- `uv run --locked ruff check .`、`ruff format --check .`、`mypy src` 通过。
- `uv run --locked pytest -q`：200 项离线测试通过。包括模型契约、金额精度、图片校验、鉴权、上传、人工审核、并发/幂等、改单/撤单事务回滚、导出、备份恢复、过期证据清理。
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
