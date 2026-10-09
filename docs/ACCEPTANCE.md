# 核心流程验收矩阵

## 范围与收敛标准

面向 README 中单人、单机、本地运行范围，使用完全虚构的数据和离线模型替身。一次验收以同一最终提交的 Python、DOM、浏览器、类型/格式/构建检查为基准；不能用旧提交或局部测试的通过替代完整通过。

收敛条件是适用检查通过，已发现且能在该范围内复现的高/中严重问题已修复并有回归。此条件不等于“零 bug”，也不涵盖真实模型准确率或未接入系统。

| 环节 | 核验内容 | 自动化证据 |
| --- | --- | --- |
| 采集 | 文件类型/体积/像素、批次校验、同图同来源去重、不同来源保留、inbox稳定扫描/长文件名 | test_capture_export.py、test_api.py、test_workbench_api.py |
| 原图留存 | 写入失败回滚、崩溃残留回收、证据鉴权与过期、秘密不回显 | test_reliability.py、test_api.py |
| 提取 | demo醒目标记、无配置不能伪识别、结构化schema/提示词注入/拒答/超时/重试预算 | test_domain_providers.py、test_workflow.py |
| 队列 | 服务端分页与搜索、500条以上旧待审可查、稳定排序、处理状态筛选 | test_reliability.py、test_workbench_api.py、前端DOM测试 |
| 人工审核 | 不确认不入正式导出、字段/金额/SKU/证据校验、轮询保留输入、重复点击与冲突 | test_workflow.py、test_api.py、前端DOM与浏览器测试 |
| 幂等 | 同键同内容重放、同键异内容冲突、配置变化后仍返回原成功回执、事务回滚 | test_workflow.py、test_reliability.py |
| 改撤单 | 目标及预期版本、原因和操作者、订单/事件/outbox原子性、混合批次重复警告、并发快照 | test_workflow.py、test_reliability.py、order-changes.spec.cjs |
| 导出 | 仅正式订单、精确金额列、公式注入防护、锁/文件占用、失败重试、下载鉴权 | test_capture_export.py、test_api.py、test_platform.py、浏览器测试 |
| 备份恢复 | 停机锁、完整引用及摘要校验、新目录恢复、禁止嵌套、重建outbox和新令牌 | test_cli.py、test_recovery.py |
| 清理 | 先记录过期状态，文件失败可重试，不让活跃记录指向已删原图 | test_recovery.py |
| 访问与会话 | 本地Bearer、跨站拒绝、上传前鉴权、token失效、退出清理、陈旧响应隔离 | test_api.py、前端DOM测试 |
| 界面 | 导航/空错加载/队列与详情、原图、上传审核下载、键盘和窄屏 | 前端DOM测试、Playwright Chromium截图与断言 |

## 可复现检查

```sh
uv sync --locked --python 3.12
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked mypy src
uv run --locked pytest
node --check src/ocrs/static/app.js
npm ci
npm run test:frontend
npx playwright install --with-deps chromium
npm run test:e2e
uv build
```

Node.js 22 与前端依赖只用于开发验收。E2E 使用临时数据目录和固定的虚构测试令牌，不读取本机生产资料，不调用真实模型。CI 在 Linux/Windows 上执行，并保留 `browser-acceptance-*` 产物；这些截图仅含合成样本。实际通过/失败以相关 PR 的最终 commit 运行记录为准。

## 明确的验收边界

- 默认 demo 不读取图中文字；真实模型的连通性、输出质量、费用、服务端数据政策需用户配置并授权后另验。只读配置页面不声称验证了供应商。
- inbox 是受控图片文件夹，不是微信聊天监控；没有微信客户端或账号接入。
- Chromium 自动化不代表 Safari/Firefox、用户具体 Windows 桌面、输入法或辅助技术全部验证。
- openpyxl/ZIP/XML 测试验证文件结构、精确值及公式文本隔离；原生 Excel 打开与人工编辑仍需在用户客户端演练。
- 关闭上传/审核对话框不是取消已送达服务器的操作。请求超时需刷新核对；已开始的识别没有即时中断承诺，失败可受控重试。
- 单一访问令牌不是多用户权限体系；审核人是审计标签。公网部署、多租户、共享盘与多worker不在支持范围。
- 备份/恢复和永久证据清理保留为明确的停机 CLI 操作；界面仅解释步骤，不暗示可在服务运行中执行。

## 版本记录

0.1.0：204 项 Python 测试、Linux/Windows 检查通过；真实浏览器视觉未验收。

0.2.0：新增上述工作台、可复现前端/浏览器验收和可靠性回归。最终数量、截图复核与运行链接写在对应 PR；没有完成的验证不得从此矩阵推断为通过。

0.2.0 已合并：[PR #3](https://github.com/cancannewbie/OCRS/pull/3)。最终 c6a244e 的 Linux/Windows 均通过 260 项 Python、39 项 DOM、3 组 Chromium 视口验收，截图已复核。

0.2.1 将同样的真实浏览器覆盖延伸至改单、撤单、重复警告与版本冲突；具体执行结果以该版本最终 PR/CI 为准。
