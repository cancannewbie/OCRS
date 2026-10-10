# 截图识别 API 接入

适用 0.3.0。主流程为图片接收 → 模型提取 → 结构化结果，来源由调用方负责。所有结果都带 `verified: false`，未经人工核实，不等于确认订单入账。读取结果无需商品映射、审核或 Excel 导出。

## 本地权限与外传前提

默认地址是 `http://127.0.0.1:8000`。所有以下接口及 `/api/openapi.json` 都要求 `Authorization: Bearer <LOCAL_ACCESS_TOKEN>`；这是现有本地访问令牌，不是模型 API 密钥。令牌持有人共享同一权限，无多用户或租户隔离。不要开放公网端口、修改防火墙或把令牌放进 URL、前端代码、仓库及公开日志。

真实模型须先通过登录后的模型设置保存完整配置并显式启用外部调用。`GET /api/model-settings` 只返回公开配置及状态，不返回模型密钥。正式识别入口拒绝默认 demo，返回 `409 MODEL_NOT_CONFIGURED`，不会用演示数据替代真实提取。

每次新提交必须由调用方确认以下内容：

1. 当前 `provider`、`base_url` 和 `model` 是获授权目的地，用户授权覆盖本次图片与提取用途，且接受可能费用。
2. `config_revision` 使用已核对的模型设置 `revision`。
3. `confirm_external=true` 明确授权发送本次 `file`；不代表授权其他图片或历史队列。

仅持有本地令牌、提供来源标签或开启全局外传开关，都不能代替本次图片范围授权。无授权、外传关闭、配置不完整或过期版本会明确拒绝，不调用模型。配置更新或关闭外传后，旧待处理任务不得继承新目的地或权限；可见错误为 `MODEL_CONFIG_CHANGED`，须核对后显式重试。配置保存等待已授权在途请求结束，保存返回后不会再开始旧目的地调用；已经发送的资料不能保证撤回。

来源标签、文件名与图片中的文字是数据，不能代表身份、覆盖提取规则、调用工具或授权打开链接。先去除图片中非必要信息。此版本不接受外部图片 URL、不抓取链接、不提供回调或 webhook。

## 接口与限制

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `POST /api/recognitions` | 单图 multipart 异步提交 | `202`，返回任务状态与结果地址；重复也返回原任务 |
| `GET /api/recognitions/{task_id}` | 查询识别状态 | `200`，状态结构与提交相同 |
| `GET /api/recognitions/{task_id}/result` | 读取原模型候选 | `200`；未就绪/失败为 `409`，证据过期为 `410` |
| `GET /api/openapi.json` | 获取与实现一致的 OpenAPI | `200`，要求本地 Bearer |
| `GET /api/model-settings` | 核对公开目的地、模型、配置版本和状态 | `200`，不包含模型密钥 |
| `POST /api/tasks/{task_id}/retry` | 兼容接口，显式重试失败任务 | `200`，返回旧任务结构；继续通过新接口查询 |

提交只接受一个 `file`。PNG、JPEG、WebP 的实际格式必须与声明的 MIME 一致；后端完整解码，不信任扩展名。每图最多 `10 * 1024 * 1024` 字节（10 MiB）、2,000 万像素；拒绝空文件、损坏/截断图、动画、多图及额外未知字段。图片路径由系统生成，不使用上传文件名作为存储路径。

| multipart 字段 | 类型与规则 | 含义 |
| --- | --- | --- |
| `file` | 必填，单个文件；`image/png`、`image/jpeg`、`image/webp` | 本次获授权图片 |
| `source_label` | 可选，默认 `manual`；非空，最多 200 字符 | 来源备注及技术去重范围，不是账号身份 |
| `idempotency_key` | 可选，8–100 字符 | 调用方为同一次业务提交生成的稳定外部请求键 |
| `config_revision` | 真实模型必填，整数且 ≥ 0 | 已核对且授权的当前模型配置版本 |
| `confirm_external` | 真实模型必须为 `true` | 明确授权本次图片向已核对目的地发送 |

上传文件名最多 255 字符。一个数据目录只支持一个服务进程，识别 worker 并发为 1；`received` 与 `recognizing` 的待处理任务合计上限为 100。新请求超过容量返回 `429 QUEUE_FULL`，不创建额外任务；调用方应退避并保留原请求载荷与幂等键。容量与文件大小不是供应商费用预算。

## 状态、幂等与重复图片

识别状态为 `received → recognizing → succeeded`，处理失败进入 `failed`。失败任务经显式重试可回到 `received`。`succeeded` 表示结构化提取完成，仍未经人工核实；可选审核的 `review_status` 单独表示 `review_required`、`confirmed` 或 `rejected` 等旧工作流状态。人工修订、驳回或确认不会改写这里返回的原模型候选。

外部幂等键在当前本地数据目录的识别入口范围内持久保存，绑定“图片字节摘要 + 来源标签 + `config_revision` + `confirm_external`”。同键同载荷重放返回原任务，`duplicate=true`；同键异载荷返回 `409 IDEMPOTENCY_CONFLICT`。键不是身份或密钥，不能充当跨账号隔离。

未提供幂等键时仍按“图片字节摘要 + 来源标签”技术去重。同图同标签返回原任务，永不暗中重新识别、补授权或恢复过期证据；同图不同标签可建立另一个来源场景，不能用换标签绕过业务重复核对。旧 demo 任务的同图同标签在正式入口返回 `409 DEMO_SOURCE_CONFLICT`，不能把虚构演示当作正式提取；明确新的正式来源标签后再授权提交。已过期来源的重复提交返回 `410 EVIDENCE_EXPIRED`。重放已成功提交的原请求，即使后来配置改变或禁用，也只读取原任务，不因此调用模型。旧任务未获授权或已失败时，重复上传不能代替显式重试。

请求超时不代表服务器未收到。先用同一幂等键和完全相同载荷重放，或查询已取得的任务 ID；不要随机换键重新提交。若配置已变，保留原授权字段以恢复原回执，再核对是否需要显式重试，不把原授权自动改成新目的地。

提交和状态响应示例（全部为虚构标识）：

```json
{
  "schema_version": "1",
  "task_id": "00000000-0000-4000-8000-000000000001",
  "status": "received",
  "version": 1,
  "provider": "openai-compatible",
  "recognition_mode": "external",
  "model_revision": 7,
  "verified": false,
  "review_status": "received",
  "duplicate": false,
  "result_url": "/api/recognitions/00000000-0000-4000-8000-000000000001/result",
  "error_code": null,
  "created_at": "2026-10-10T12:00:00+00:00",
  "updated_at": "2026-10-10T12:00:00+00:00"
}
```

`version` 用于显式重试/审核的并发检查，不能自行加一猜测。`model_revision` 是任务绑定版本，未必仍是当前配置版本。GET 查询的 `duplicate` 不用于判断本次 POST 是否重放。证据过期后的状态查询返回 `200`，`status=failed`、`error_code=EVIDENCE_EXPIRED`；结果查询为 `410`。

## curl 提交与轮询

以下是 POSIX shell 示例，Windows PowerShell 请使用 `curl.exe` 并按 PowerShell 规则改写换行。`sample.png` 必须是完全虚构且有权处理的图；示例中的令牌、服务与模型占位符必须在受控本机替换，不能提交真实值。

```sh
BASE_URL='http://127.0.0.1:8000'
LOCAL_TOKEN='<LOCAL_ACCESS_TOKEN>'

# 先核对返回的 provider/base_url/model/revision/allow_external/status。
curl --fail-with-body "$BASE_URL/api/model-settings" \
  -H "Authorization: Bearer $LOCAL_TOKEN"

# 仅在授权覆盖当前目的地与 sample.png 后执行；7 是已核对版本的示例。
curl --fail-with-body "$BASE_URL/api/recognitions" \
  -H "Authorization: Bearer $LOCAL_TOKEN" \
  -F 'file=@sample.png;type=image/png' \
  -F 'source_label=fictitious-api-sample' \
  -F 'idempotency_key=fictitious-request-0001' \
  -F 'config_revision=7' \
  -F 'confirm_external=true'

# 用提交响应中的真实 task_id 替换占位符；建议每秒查询一次。
TASK_ID='<TASK_ID_FROM_RESPONSE>'
curl --fail-with-body "$BASE_URL/api/recognitions/$TASK_ID" \
  -H "Authorization: Bearer $LOCAL_TOKEN"

# status=succeeded 时读取；未完成会返回409 RESULT_NOT_READY。
curl --fail-with-body "$BASE_URL/api/recognitions/$TASK_ID/result" \
  -H "Authorization: Bearer $LOCAL_TOKEN"

curl --fail-with-body "$BASE_URL/api/openapi.json" \
  -H "Authorization: Bearer $LOCAL_TOKEN"
```

## Python 完整轮询示例

调用方自行安装 `requests`（不是 OCRS 的新增运行依赖），把以下保存为本机 `recognize_sample.py`。代码只提交 `sample.png`，使用固定超时，并在发送前比对已授权目的地与配置版本；它不配置模型密钥或自动开启外传。只打印最终虚构样本结果，真实结果不应进入公开日志。

```python
import argparse
import json
import os
import time
from pathlib import Path

import requests

parser = argparse.ArgumentParser()
parser.add_argument("--provider", required=True, help="已获授权供应商")
parser.add_argument("--destination", required=True, help="已获授权的模型 base_url")
parser.add_argument("--model", required=True, help="已获授权模型")
parser.add_argument("--config-revision", type=int, required=True)
parser.add_argument("--confirm-external", action="store_true")
args = parser.parse_args()
if not args.confirm_external:
    raise SystemExit("须明确授权 sample.png 的外传范围与费用后再运行。")

base = "http://127.0.0.1:8000"
token = os.environ.get("OCRS_LOCAL_TOKEN", "<LOCAL_ACCESS_TOKEN>")
if token == "<LOCAL_ACCESS_TOKEN>":
    raise SystemExit("请在受控本机设置 OCRS_LOCAL_TOKEN；不要把令牌提交到仓库。")

session = requests.Session()
session.headers["Authorization"] = f"Bearer {token}"


def read_json(response):
    body = response.json()
    if not response.ok:
        code = body.get("error", {}).get("code", "HTTP_ERROR")
        raise RuntimeError(f"HTTP {response.status_code}: {code}")
    return body


current = read_json(session.get(f"{base}/api/model-settings", timeout=(5, 15)))
if (
    current["provider"] == "demo"
    or current["status"] != "configured"
    or not current["allow_external"]
    or current["provider"] != args.provider
    or current["base_url"] != args.destination
    or current["model"] != args.model
    or current["revision"] != args.config_revision
):
    raise SystemExit("配置、目的地或版本不匹配；重新核对授权，不能自动改用新目的地。")

payload = {
    "source_label": "fictitious-api-sample",
    "idempotency_key": "fictitious-request-0001",
    "config_revision": str(args.config_revision),
    "confirm_external": "true",
}
with Path("sample.png").open("rb") as image:
    submitted = read_json(
        session.post(
            f"{base}/api/recognitions",
            data=payload,
            files={"file": ("sample.png", image, "image/png")},
            timeout=(5, 30),
        )
    )

task_id = submitted["task_id"]
deadline = time.monotonic() + 180
while True:
    state = read_json(session.get(f"{base}/api/recognitions/{task_id}", timeout=(5, 15)))
    if state["status"] == "succeeded":
        output = read_json(
            session.get(f"{base}/api/recognitions/{task_id}/result", timeout=(5, 15))
        )
        assert output["verified"] is False
        # 原模型 Candidate；无需审核或已知SKU。十进制字段保留字符串。
        print(json.dumps(output["result"], ensure_ascii=False, indent=2))
        break
    if state["status"] == "failed":
        raise RuntimeError(f"识别失败：{state['error_code']}；任务 {task_id}")
    if time.monotonic() >= deadline:
        raise TimeoutError(f"轮询超时；保留任务 {task_id} 后续查询，勿换键重传。")
    time.sleep(1)
```

运行前在本机通过私有方式设置 `OCRS_LOCAL_TOKEN`。命令中的地址与版本是占位示例，必须与已获授权配置一致：

```sh
python recognize_sample.py \
  --provider 'openai-compatible' \
  --destination 'https://<AUTHORIZED_MODEL_HOST>/v1' \
  --model '<AUTHORIZED_IMAGE_MODEL>' \
  --config-revision 7 \
  --confirm-external
```

网络异常可能使 POST 结果未知，示例不会自动换键或改授权再试。重放须复用同一图片、来源、键及授权字段；读取状态可以继续使用已取得的任务 ID。`requests`、供应商账户连通性与费用不由示例存在证明通过。

## 结果结构与证据

成功结果外层 `schema_version="1"`，`result` 复用 `Candidate` schema。单张图可产生多个 `events`，分别表示提取出的 `create`、`amend` 或 `cancel` 候选动作；它们是待核实语义，不会执行订单变更。当前 schema 专注订单截图字段，不承诺通用文档版面/OCR全文接口。

```json
{
  "schema_version": "1",
  "task_id": "00000000-0000-4000-8000-000000000001",
  "status": "succeeded",
  "verified": false,
  "recognition_mode": "external",
  "review_status": "review_required",
  "result": {
    "schema_version": "1",
    "events": [{
      "action": "create",
      "target_order_id": null,
      "expected_order_version": null,
      "customer": "虚构客户甲",
      "external_id": null,
      "currency": "CNY",
      "occurred_at": null,
      "reason": null,
      "items": [{
        "line_id": null,
        "sku": "FICTIONAL-UNMAPPED",
        "name": "虚构样品",
        "quantity": "2",
        "unit": "件",
        "unit_price": null
      }],
      "evidence": [{
        "source_id": "00000000-0000-4000-8000-000000000002",
        "field": "items.0.quantity",
        "text": "虚构样品 2件"
      }],
      "warnings": ["商品编码尚未映射，仍可读取原始字段"],
      "missing_reasons": ["截图未见单价和明确业务时间"]
    }],
    "warnings": [],
    "missing_reasons": []
  }
}
```

`evidence` 是模型声称的原文片段与受控 `source_id`，仍需人工核验，不能当作事实认证。`warnings` 与 `missing_reasons` 保留不确定性；客户、日期、数量、价格及订单关系缺失时不得编造。数量最多 6 位小数，单价最多 4 位小数，均为非负十进制字符串；没有单价不自动补零，缺数量不自动补一。

结果接口始终提供原模型 Candidate，人工修订另由旧任务详情/历史接口提供。既有鉴权 `/api/sources/{source_id}` 可按需提供原图。供应商完整原始 HTTP 响应、隐藏推理、凭据或未定义字段不会作为结果回显；不宣称具备截图全文的独立 OCR 转写。

## 错误与受控重试

错误结构为 `{"error":{"code":"...","message":"...","details":...}}`，部分错误省略 `details`。依赖稳定 `code` 处理，不解析中文 `message`；错误和日志只提供安全原因，不回显供应商原始响应或用户原文。

| HTTP / 错误码 | 含义与处理 |
| --- | --- |
| `401 UNAUTHORIZED` | 本地令牌缺失或不匹配；在受控本机核对令牌，不使用模型密钥 |
| `403 ORIGIN_DENIED` | 跨站来源被拒；不通过扩大 CORS 或关闭边界绕过 |
| `400 MULTIPART_INVALID` | multipart 请求格式损坏，例如缺少 boundary；让 HTTP 客户端生成表单头，不手写不完整的 `Content-Type` |
| `400 IMAGE_INVALID` / `IMAGE_ANIMATED` / `IMAGE_TYPE_MISMATCH` | 空/损坏图、动画或声明 MIME 与实际图不符；修正虚构样本格式/内容 |
| `415 IMAGE_UNSUPPORTED` | 实际格式不是 PNG/JPEG/WebP；按允许格式重新准备图片 |
| `413 UPLOAD_TOO_LARGE` / `IMAGE_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS` | 请求体、图片字节或像素超限；压缩/裁剪后重新明确图片范围 |
| `422 VALIDATION_ERROR` | 缺少文件、额外字段、字段类型/范围无效等；按 OpenAPI 修正 |
| `409 MODEL_NOT_CONFIGURED` | 正式入口当前为 demo；先配置真实模型，绝不视为识别成功 |
| `409 MODEL_DISABLED` | 真实模型不完整或外部调用未开启；在页面核对并配置 |
| `409 MODEL_CONSENT_REQUIRED` | 缺本次外传确认或配置版本不符；重新核对获授权供应商、目的地、模型、版本与图片范围 |
| `409 DEMO_SOURCE_CONFLICT` | 同图同来源已是旧 demo 任务；明确新的正式来源标签，重新核对并授权提交 |
| `400 UPLOAD_COUNT` / `SOURCE_INVALID` | 单请求多图、空/过长来源或文件名超限；按接收边界修正 |
| `409 IDEMPOTENCY_CONFLICT` | 同外部键载荷变化；查询原任务，不盲目换键 |
| `429 QUEUE_FULL` | 待处理容量已满；退避后重放同一请求 |
| `404 NOT_FOUND` | 任务不存在；核对任务 ID 与当前数据目录 |
| `409 RESULT_NOT_READY` | 任务已接收/识别中，尚无结果；继续轮询状态 |
| `409 RECOGNITION_FAILED` | 识别失败；`details` 提供 `task_id` 与脱敏 `error_code`，核对后显式重试 |
| `410 EVIDENCE_EXPIRED` | 原证据及候选已按显式清理过期；重复上传不能恢复原任务 |
| `409 VERSION_CONFLICT` / `RETRY_LIMIT` | 重试任务版本陈旧、状态不符或已达 5 次尝试；读取最新任务后核对 |
| `500 INTERNAL_ERROR` | 未预期内部异常；响应只含安全错误码与固定说明，`details=null`，不回显异常详情、堆栈、凭据或用户原文；请求结果未知时先查询任务或按同键同载荷恢复回执 |

其他 HTTP 异常也不回显底层 `detail`：未找到地址使用 `NOT_FOUND`，方法不支持使用 `METHOD_NOT_ALLOWED`，其余使用 `HTTP_ERROR`，保留对应 HTTP 状态码。

失败任务的 `error_code` 可为 `MODEL_CONFIG_CHANGED`、`INTERRUPTED`、`EVIDENCE_CHANGED`、`RECOGNITION_INTERNAL`、`TASK_REJECTED`（未产生结果即被拒绝）或供应商分类：`provider_auth_failed`、`provider_http_rejected`、`provider_api_rejected`、`provider_refused`、`provider_truncated`、`provider_schema_invalid` 等。拒答、schema 错误或认证失败须先修正原因，不能无限重试；超时可能发生在供应商已计费之后。

显式重试复用旧接口，发送当前任务版本及重新核对的配置版本/范围授权，不重新建来源：

```sh
curl --fail-with-body "$BASE_URL/api/tasks/$TASK_ID/retry" \
  -H "Authorization: Bearer $LOCAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"expected_version":3,"config_revision":7,"confirm_external":true}'
```

其中 `3`、`7` 均只是示例，必须来自最新状态和获授权的当前配置。正式提取成功后不自动重识别；人工审核、驳回复审与正式订单确认使用原接口，继续遵守商品/必填/并发/幂等规则。

外部识别失败任务切换到 demo 后不能重试为虚构候选，返回 `MODEL_NOT_CONFIGURED`。结果按当前识别尝试读取；当前尝试未完成或失败时不返回旧候选历史冒充新结果。

## 兼容、存储与验收

旧 `/api/uploads` 保留 `files` 批量（1–8 张）与 200 响应，供旧客户端兼容及显式离线 demo 演示；新的来源接入使用单图 `/api/recognitions`。旧 `/api/tasks`、审核/修订/复审/确认、订单与 Excel 接口保留，不删除已有数据。`OCRS_INBOX` 被忽略，不启动扫描；迁移为 API 或手工上传。

升级须先停机备份并执行 `ocrs init`，schema 3 → 4 新增 `recognition_requests` 幂等映射；旧程序不得直接打开 schema 4。备份/恢复、保留期限、不可撤销证据清理与回退到新目录见 [运维说明](OPERATIONS.md)。结果与证据可能包含敏感原文，调用方对保存、副本、公开日志和最终删除负责。

自动化只使用隔离虚构数据和模型 mock；不调用付费模型、不读取用户秘密、不上传真实资料。Windows/Linux、Python、DOM、Chromium、格式/类型/构建及 OpenAPI 一致性按最终提交实际运行报告，详见 [验收矩阵](ACCEPTANCE.md)。本次代码交付不代表已部署本机服务、验证真实账户或生产识别准确率。
