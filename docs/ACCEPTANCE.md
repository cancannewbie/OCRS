# 核心流程验收矩阵

## 范围与收敛标准

面向 README 中单人、单机、本地运行范围，使用完全虚构的数据和离线模型替身。一次验收以同一最终提交的 Python、DOM、浏览器、类型/格式/构建检查为基准；不能用旧提交或局部测试的通过替代完整通过。

0.3.0 主流程是来源无关的图片接收、模型提取与未经人工核实的结果，API/页面上传不以审核或导出为前提。原订单工作流是可选下游，仍纳入回归；不接入微信、不监听桌面或目录、不调用付费模型。

收敛条件是适用检查通过，已发现且能在该范围内复现的高/中严重问题已修复并有回归。此条件不等于“零 bug”，也不涵盖真实模型准确率或未接入系统。

| 环节 | 核验内容 | 自动化证据 |
| --- | --- | --- |
| 图片接收 | 文件类型/体积/像素、实际内容与 MIME、单图正式上传/旧批量兼容、同图同来源去重、不同来源保留 | test_capture_export.py、test_api.py、test_workbench_api.py、test_recognition_api.py |
| 正式识别 API | Bearer、无配置/未授权、不收 URL/多图/额外字段、异步任务/状态/结果、持久幂等/重试/冲突/并发、容量、失败/未就绪/证据过期、未知SKU/未审核可读、配置变化与旧demo隔离、OpenAPI一致性 | test_recognition_api.py；最终执行结果由对应 PR/CI 记录 |
| 来源边界 | `OCRS_INBOX` 忽略、worker不创建/调用扫描器、不开发/调用微信或桌面监听；旧数据与兼容接口保留 | test_config_boundary.py、test_recognition_api.py；历史 InboxWatcher 类库用例仅验证兼容，不证明运行扫描 |
| 原图留存 | 写入失败回滚、崩溃残留回收、证据鉴权与过期、秘密不回显 | test_reliability.py、test_api.py |
| 提取 | demo醒目标记、无配置不能伪识别、结构化schema/提示词注入/拒答/超时/重试预算 | test_domain_providers.py、test_workflow.py |
| 队列 | 服务端分页与搜索、500条以上旧待审可查、稳定排序、处理状态筛选 | test_reliability.py、test_workbench_api.py、前端DOM测试 |
| 人工审核 | 不确认不入正式导出、字段/金额/SKU/证据校验、轮询保留输入、重复点击与冲突 | test_workflow.py、test_api.py、前端DOM与浏览器测试 |
| 驳回复审 | 修正与复审分离、原模型候选/驳回理由/修订审计、幂等/并发/非法状态、无重识别或正式导出、当前页选择及上下文变化清空 | test_review_revisions.py、前端DOM与 review-resubmission.spec.cjs |
| 幂等 | 同键同内容重放、同键异内容冲突、配置变化后仍返回原成功回执、事务回滚 | test_workflow.py、test_reliability.py |
| 改撤单 | 目标及预期版本、原因和操作者、订单/事件/outbox原子性、混合批次重复警告、并发快照 | test_workflow.py、test_reliability.py、order-changes.spec.cjs |
| 导出 | 仅正式订单、精确金额列、公式注入防护、锁/文件占用、失败重试、下载鉴权 | test_capture_export.py、test_api.py、test_platform.py、浏览器测试 |
| 备份恢复 | 停机锁、完整引用及摘要校验、新目录恢复、禁止嵌套、重建outbox和新令牌 | test_cli.py、test_recovery.py |
| 清理 | 先记录过期状态，文件失败可重试，不让活跃记录指向已删原图 | test_recovery.py |
| 访问与会话 | 本地Bearer、跨站拒绝、上传前鉴权、token失效、退出清理、陈旧响应隔离 | test_api.py、前端DOM测试 |
| 模型设置 | 鉴权、密钥不回显、密文/主密钥隔离、旧环境忽略、版本冲突、无网络保存、虚构测试、外传确认、队列绑定及备份排除 | test_model_settings.py、test_model_settings_api.py、model-settings.spec.cjs、前端 DOM 回归；最终执行以对应提交记录为准 |
| 模型网络 | 公网 HTTPS、DNS 地址校验及固定连接、原域名 TLS/SNI、禁用代理与重定向、超时边界 | test_safe_model_transport.py、test_minimax_provider.py |
| 界面 | 上传识别/识别结果/API接入主导航，原图/未审核结果、空错加载/结果状态、显式演示和外传授权、可选审核/订单/下载、键盘和窄屏 | 前端DOM测试、Playwright Chromium截图与断言 |
| UI 细节 | 本地 SVG、输入边界对比度、手机目标尺寸、可见焦点、动效/减少动效、强制色彩及对话框滚动 | ui-polish.spec.cjs、前端 DOM 回归及虚构数据截图 |

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

- 默认 demo 不读取图中文字，仅供明确标识的离线演示；正式识别 API 返回 `MODEL_NOT_CONFIGURED`。真实模型的连通性、输出质量、费用、服务端数据政策需用户配置并授权后另验。配置保存不联网；显式合成连接测试也不证明生产准确率。
- 系统不负责来源采集，`OCRS_INBOX` 已忽略，不扫描文件夹；没有微信客户端/账号接入、桌面监听、URL抓取、回调或webhook。旧类库与测试保留不代表运行中启用。
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

0.2.3 新增页面模型设置、独立加密秘密存储、schema 1 → 2 迁移和外传授权版本绑定。要求覆盖原先模型环境变量被忽略、备份排除模型存储、恢复后重新配置，以及无真实 API Key 的完整页面保存/测试/上传确认/重试流程。此矩阵描述验收要求与测试入口；本次最终测试数量、通过状态、截图复核及 CI 链接由对应 PR 记录，不能从文件存在推断通过。

0.2.4 增加上传就地显式启用当前目的地与批次授权、并发/过期配置拒绝、旧队列隔离和安全失败信息。Chromium 配置→上传→识别→证据审核→正式订单→Excel 使用真实应用流程，仅供应商网络由 mock 替换；不代表真实账户调用。覆盖取消、重复、刷新、模型能力/JSON/超时失败与更换配置后显式重试。

0.2.5 增加已驳回候选保存修正与明确提交复审，以及审核队列当前页勾选/多选/逐条编辑。schema 3 的迁移、备份恢复、审计和证据清理纳入 Python 回归；取消、双击、版本冲突、刷新持久化及搜索/筛选/分页选择范围纳入 DOM/Chromium 回归。实际最终提交的执行数量、截图复核和双平台 CI 链接由对应 PR 记录；本机用户服务更新需另行安排。

0.2.6 使用 better-ui 统一全站视觉细节，并修复组合输入/编辑字段快捷键、忙碌语义及焦点恢复。三个现有 Chromium 视口继续覆盖 0.2.5 全流程，并追加普通/减少动效、强制色彩、输入边界对比度及手机目标尺寸检查。改前/改后截图在用户 Windows 电脑的隔离测试浏览器中生成，均使用虚构数据；不代表真实模型、Safari、原生输入法或完整辅助技术认证。最终通过数量、截图复核与双平台 CI 链接由本次 PR 记录。

0.3.0 新增来源无关的单图正式识别 API、直接读取原模型 Candidate、schema 4 持久幂等映射与上传/结果/API主导航，停止运行时目录扫描。要求验证未知商品与人工修订不阻塞/覆盖原始结果、配置变化后的授权隔离、旧审核/复审/导出与 schema 1–3 升级/备份恢复。此段仅记录验收要求；实际数量、桌面/窄屏截图复核与 Windows/Linux CI 状态以最终提交对应记录为准，本机用户服务未由开发验收部署。
