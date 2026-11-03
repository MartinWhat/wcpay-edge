# 支付宝外部程序接入指南

简体中文 · [English](../en-US/ALIPAY_INTEGRATION.md)

本文面向接入 GMPay Edge 的外部商户服务，说明如何配置支付宝、创建订单、
展示电脑网站支付或当面付、验证商户通知并完成沙箱验收。外部程序只与 GMPay
Edge 通信，不直接保存或调用支付宝私钥。

## 1. 接入模型

```text
浏览器 / 收银端
       │ 创建订单
       ▼
外部商户服务 ─────► GMPay Edge ─────► 支付宝开放平台
       ▲                │
       └── 商户通知 ◄───┘
```

职责划分：

- 外部商户服务负责订单、业务金额、用户身份和幂等。
- GMPay Edge 负责 API 签名校验、选择支付接入、创建支付宝交易、展示收银台、
  接收支付宝异步通知并投递商户通知。
- 支付宝应用私钥和支付宝公钥只保存在 GMPay Edge 的支付宝连接中。
- 浏览器最终打开 GMPay Edge 返回的 HTTPS `payment_url`。

外部程序不得把 API Secret、支付宝应用私钥或支付宝公钥发送给浏览器，也不得
允许浏览器直接调用 GMPay Edge 的商户下单接口。

## 2. 系统侧准备

### 2.1 准备支付宝资料

从支付宝开放平台取得所选环境的以下资料：

| 字段 | 沙箱 | 生产 |
| --- | --- | --- |
| App ID | 沙箱应用 App ID | 生产应用 App ID |
| 应用私钥 | 沙箱应用私钥，PKCS8 | 生产应用私钥，PKCS8 |
| 支付宝公钥 | 沙箱支付宝公钥 | 生产支付宝公钥 |
| 产品权限 | 沙箱对应产品已开通 | 电脑网站支付或当面付已签约并开通 |

沙箱与生产资料不能混用。电脑网站支付调用
`alipay.trade.page.pay`，当面付调用 `alipay.trade.precreate`。

### 2.2 配置公网应用地址

在 GMPay Edge 的 **系统设置 → 认证配置 / 密钥管理** 中确认应用地址为支付宝
可访问的公网 HTTPS Origin，例如：

```text
https://pay.example.com
```

不要填写具体页面或回调路径。支付宝异步通知由系统固定使用：

```text
https://pay.example.com/api/providers/alipay/notify
```

支付宝开放平台的“应用网关”与这个交易异步通知路由不是同一个配置项。当前
接入流程不使用开放平台通用应用网关。

### 2.3 创建支付宝连接

在 **支付设置 → 支付接入 → 新增支付宝连接** 中按“环境 × 产品”建立独立连接：

| 名称示例 | 环境 | 支付产品 |
| --- | --- | --- |
| 支付宝沙箱网站支付 | 沙箱环境 | 电脑网站支付 |
| 支付宝沙箱当面付 | 沙箱环境 | 当面付 |
| 支付宝生产网站支付 | 生产环境 | 电脑网站支付 |
| 支付宝生产当面付 | 生产环境 | 当面付 |

每条连接填写该环境的 App ID、应用私钥和支付宝公钥，并启用需要的连接。
密钥只填写在连接中。不要为同一个 App ID 混用不同环境或不同产品的密钥。

### 2.4 创建收款方式

在 **后台 → 收款方式 → 新建收款方式** 中：

1. 类型选择“法币”。
2. 平台选择“支付宝”。
3. 币种选择 CNY。
4. 填写已启用支付宝连接使用的 App ID。
5. 选择“电脑网站支付”或“当面付”。
6. 按需设置 USD 最低和最高订单金额。
7. 创建后确认收款方式已启用。

所选产品必须有使用同一 App ID 的已启用支付宝连接。收款方式不重复保存私钥或
支付宝公钥。修改连接中的密钥后，新的支付请求和后续支付宝通知直接使用连接中的
最新配置。

### 2.5 创建商户 API 凭证

在 **后台 → API 凭证 → 创建 API 凭证** 中创建服务端凭证：

- 名称示例：`支付宝沙箱接入`
- 权限至少包括 `orders:create` 和 `orders:read`
- 保存创建时只显示一次的 `PID` 与 `API Secret`

Secret 应放入外部服务的 Secret Manager 或部署平台加密环境变量。不要写进
源码、镜像、日志、浏览器代码或仓库。

## 3. 网络与安全要求

- 外部服务通过公网 HTTPS 访问 GMPay Edge。
- `notify_url` 和 `redirect_url` 必须是公网 HTTPS URL。
- 私网地址、回环地址、链路本地地址、带用户名密码的 URL 和云元数据地址会被拒绝。
- API Secret 是签名密钥，不是 Bearer Token。
- 每个订单使用商户侧唯一的 `order_id`；重试必须复用原订单号和原业务参数。
- 日志只能记录 `request_id`、订单引用和脱敏后的错误，不记录 Secret、私钥或完整签名载荷。

## 4. GMPay 签名

### 4.1 参与签名的字段

对准备发送的字段执行：

1. 排除 `signature`。
2. 排除 `null`、`undefined` 和空字符串。
3. 数字转换为普通十进制字符串。
4. 按字段名 ASCII 升序排序。
5. 不进行 URL Encode，以 `&` 连接 `key=value`。
6. 使用 `API Secret` 作为 HMAC Key 计算 HMAC-SHA256。
7. 将结果编码为 64 位小写十六进制。

字段名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`；值中不得出现 `&字段名=` 这种会
改变参数字段边界的片段。

### 4.2 Bun 签名示例

```ts
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function signGmpay(
  parameters: Record<string, string | number | undefined>,
  secret: string,
) {
  const payload = Object.entries(parameters)
    .filter(([key, value]) =>
      key !== "signature" && value !== undefined && value !== "")
    .map(([key, value]) => {
      const text = String(value);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /&[A-Za-z_][A-Za-z0-9_]*=/.test(text)
      ) {
        throw new Error("Ambiguous signature parameter");
      }
      return [key, text] as const;
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return bytesToHex(
    hmac(sha256, utf8ToBytes(secret), utf8ToBytes(payload)),
  );
}
```

验签时重新计算期望值，并使用常量时间比较；不要用普通字符串相等比较签名。

## 5. 创建支付宝订单

### 5.1 接口

```http
POST /payments/gmpay/v1/order/create-transaction
Content-Type: application/json
```

### 5.2 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `pid` | 是 | 后台生成的 API PID |
| `order_id` | 是 | 商户订单号，外部服务内唯一 |
| `currency` | 是 | 支付宝订单固定为 `CNY` |
| `amount` | 是 | 正十进制金额，最多 18 位整数和 8 位小数 |
| `notify_url` | 是 | GMPay Edge 通知商户的公网 HTTPS URL |
| `token` | 支付宝必填 | 固定为 `CNY` |
| `network` | 支付宝必填 | 固定为 `alipay` |
| `alipay_environment` | 建议 | `production` 或 `sandbox`；省略时默认生产 |
| `alipay_product` | 建议 | `website` 或 `face_to_face`；必须与收款方式选择一致，省略时使用收款方式产品 |
| `redirect_url` | 否 | 用户支付后的商户 HTTPS 返回页 |
| `name` | 否 | 订单标题，提交支付宝时截断到 256 字符 |
| `signature` | 是 | GMPay HMAC-SHA256 签名 |

`token` 和 `network` 必须同时提供。支付宝环境和产品字段只能用于支付宝网络。

### 5.3 电脑网站支付示例

```ts
const parameters = {
  pid: process.env.GMPAY_PID!,
  order_id: `order-${Date.now()}`,
  currency: "CNY",
  amount: "0.01",
  notify_url: "https://merchant.example.com/gmpay/notify",
  redirect_url: "https://merchant.example.com/payment/return",
  token: "CNY",
  network: "alipay",
  alipay_environment: "sandbox",
  alipay_product: "website",
  name: "接入测试订单",
};

const response = await fetch(
  "https://pay.example.com/payments/gmpay/v1/order/create-transaction",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...parameters,
      signature: signGmpay(parameters, process.env.GMPAY_API_SECRET!),
    }),
  },
);

const result = await response.json();
```

也可以在临时目录创建完整测试脚本：

```ts
// alipay-create-test.ts
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const baseUrl = process.env.GMPAY_BASE_URL;
const pid = process.env.GMPAY_PID;
const secret = process.env.GMPAY_API_SECRET;
const notifyUrl = process.env.MERCHANT_NOTIFY_URL;
const returnUrl = process.env.MERCHANT_RETURN_URL;
const product = process.env.ALIPAY_PRODUCT ?? "website";

if (!baseUrl || !pid || !secret || !notifyUrl || !returnUrl)
  throw new Error("Set GMPAY_BASE_URL, GMPAY_PID, GMPAY_API_SECRET, MERCHANT_NOTIFY_URL and MERCHANT_RETURN_URL");
if (product !== "website" && product !== "face_to_face")
  throw new Error("ALIPAY_PRODUCT must be website or face_to_face");

const parameters = {
  pid,
  order_id: `alipay-sandbox-${Date.now()}`,
  currency: "CNY",
  amount: "0.01",
  notify_url: notifyUrl,
  redirect_url: returnUrl,
  token: "CNY",
  network: "alipay",
  alipay_environment: "sandbox",
  alipay_product: product,
  name: "支付宝沙箱接入测试",
};

const source = Object.entries(parameters)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => `${key}=${value}`)
  .join("&");
const signature = bytesToHex(
  hmac(sha256, utf8ToBytes(secret), utf8ToBytes(source)),
);

const response = await fetch(
  `${baseUrl}/payments/gmpay/v1/order/create-transaction`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...parameters, signature }),
  },
);

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok)
  process.exitCode = 1;
```

安装依赖并运行：

```bash
bun add @noble/hashes

export GMPAY_BASE_URL="https://pay.example.com"
export GMPAY_PID="后台生成的 PID"
export GMPAY_API_SECRET="后台生成的 API Secret"
export MERCHANT_NOTIFY_URL="https://merchant.example.com/gmpay/notify"
export MERCHANT_RETURN_URL="https://merchant.example.com/payment/return"
export ALIPAY_PRODUCT="website"

bun alipay-create-test.ts
```

将 `ALIPAY_PRODUCT` 改为 `face_to_face` 可测试当面付。浏览器必须打开脚本输出中的
`data.payment_url`，不要直接打开支付宝网关 URL。

沙箱测试必须显式发送：

```json
{
  "alipay_environment": "sandbox",
  "alipay_product": "website"
}
```

### 5.4 当面付示例

将订单参数改为：

```json
{
  "token": "CNY",
  "network": "alipay",
  "alipay_environment": "sandbox",
  "alipay_product": "face_to_face"
}
```

后台必须存在并启用“沙箱环境 + 当面付”的支付宝连接，以及对应 App ID 的收款方式。

### 5.5 成功响应

```json
{
  "status_code": 200,
  "message": "success",
  "data": {
    "trade_id": "GMPay 系统订单号",
    "order_id": "order-时间戳",
    "amount": "0.01",
    "currency": "CNY",
    "actual_amount": "0.01",
    "receive_address": "支付宝 App ID",
    "token": "CNY",
    "network": "alipay",
    "status": 1,
    "status_detail": "pending",
    "expiration_time": 1234567890,
    "payment_url": "https://pay.example.com/checkout/..."
  },
  "request_id": "用于排查的请求 ID"
}
```

浏览器只打开 `data.payment_url`：

- 电脑网站支付在收银台显示“打开支付宝收银台”，随后跳转支付宝。
- 当面付在收银台显示支付宝二维码。

外部服务应始终使用本次响应中的 `payment_url`，不要自行拼接支付宝网关 URL。

## 6. 订单查询

查询使用同一凭证，并且每次只能提供 `trade_id` 或 `order_id` 其中一个：

```http
GET /payments/gmpay/v1/order/query?pid=<PID>&order_id=<商户订单号>&signature=<签名>
```

或：

```http
GET /payments/gmpay/v1/order/query?pid=<PID>&trade_id=<GMPay系统订单号>&signature=<签名>
```

查询签名只包含实际发送的 `pid`、`order_id` 或 `trade_id`、`signature` 之外
的非空字段。查询响应结构与创建订单相同。

查询适合以下用途：

- 商户通知暂时失败时补偿订单状态。
- 用户返回页面后刷新状态。
- 排查超时后结果未知的创建请求。

查询不是商户通知的替代品；通知恢复和查询补偿应同时存在。

## 7. 商户通知

### 7.1 GMPay 通知

系统向创建订单时的不可变 `notify_url` 发送 JSON POST：

```json
{
  "pid": "100000000001",
  "trade_id": "GMPay 系统订单号",
  "order_id": "商户订单号",
  "amount": "0.01",
  "actual_amount": "0.01",
  "receive_address": "支付宝 App ID",
  "token": "CNY",
  "block_transaction_id": "支付宝交易号或空字符串",
  "status": 2,
  "signature": "lowercase-hmac-sha256"
}
```

`status` 使用兼容状态：

| 值 | 含义 |
| ---: | --- |
| 1 | 等待支付或其他非终结状态 |
| 2 | 支付成功，对应 GMPay Edge 的 `paid` 或 `overpaid` |
| 3 | 已关闭，对应取消、过期或失败 |

通知载荷不包含 `status_detail`；以整数 `status` 和 `trade_id` 对应订单的业务记录
处理状态，并兼容重复、乱序投递。`actual_amount` 来自事件冻结快照，是订单的应付
金额，不是累计实收。

### 7.2 成功应答

接收端先验签并持久化事件，再返回：

```http
HTTP/1.1 200 OK
Content-Type: text/plain

ok
```

只有 HTTP `200` 且正文 trim 后为纯文本 `ok` 才算成功。返回重定向、JSON
成功对象、空正文或其他内容都会触发重试。

### 7.3 验签示例

```ts
import { timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export async function receiveGmpayNotification(request: Request) {
  const body = await request.json() as Record<string, string | number>;
  const received = String(body.signature ?? "");
  const source = Object.entries(body)
    .filter(([key, value]) =>
      key !== "signature" && value !== undefined && value !== "")
    .map(([key, value]) => {
      const text = String(value);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /&[A-Za-z_][A-Za-z0-9_]*=/.test(text)
      ) {
        throw new Error("Ambiguous signature parameter");
      }
      return [key, text] as const;
    })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = bytesToHex(hmac(
    sha256,
    utf8ToBytes(process.env.GMPAY_API_SECRET!),
    utf8ToBytes(source),
  ));

  const valid = received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return new Response("invalid signature", { status: 401 });

  await persistEventOnce({
    eventId: request.headers.get("x-gmpay-event-id"),
    tradeId: String(body.trade_id),
    status: Number(body.status),
  });
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
```

示例中的 `persistEventOnce` 必须由接入方实现。建议使用
`x-gmpay-event-id`、`trade_id` 或业务订单状态建立唯一约束和事务幂等。

### 7.4 重试和安全边界

- 通知是至少一次投递，可能重复、乱序或被手动重发。
- 系统使用有界指数退避重新投递失败通知。
- 接收端处理时限应低于 10 秒；消费端会根据 `Retry-After` 调整下一次重试。
- GMPay 通知签名只覆盖业务字段，不包含签名时间戳。事件 ID 和投递 ID 位于
  `x-gmpay-event-id`、`x-gmpay-delivery-id` 未签名请求头中。
- TLS 之外截获的载荷可能重放，因此必须按已持久化的订单和事件身份去重。
- 不要因为收到旧状态通知就把已成功订单回退。

## 8. 错误处理

响应通用结构：

```json
{
  "status_code": 10003,
  "message": "Payment provider is unavailable",
  "data": null,
  "request_id": "..."
}
```

| `status_code` | 常见原因 | 外部服务处理 |
| ---: | --- | --- |
| `10001` | 查询订单不存在 | 检查 API 凭证和订单选择条件 |
| `10002` | 外部订单号已存在 | 使用相同订单号查询，不要更换参数重建 |
| `10003` | 收款方式或支付宝供应商不可用 | 检查连接、收款方式、支付宝产品和凭据；可重试 |
| `10004` | 金额无效 | 修正金额，不要浮点累加 |
| `10009` | 参数无效 | 检查 CNY、token/network、HTTPS URL 和支付宝选路 |
| `10016` | 资产或汇率不可用 | 检查 CNY 资产和汇率配置 |
| `401` | PID、Scope 或签名错误 | 停止自动用错误 Secret 重试 |
| `429` | 请求或认证失败超过限流 | 按退避重试 |
| `500` | 未预期服务端错误 | 保存 `request_id`，稍后用原订单号查询 |

创建请求超时表示结果未知。不要更换 `order_id` 自动创建第二单；先用原
`order_id` 查询。查询结果不存在时可以重试原请求，存在时继续原订单流程。

## 9. 沙箱验收

### 9.1 电脑网站支付

1. 后台启用“沙箱 + 电脑网站支付”连接和 CNY 收款方式。
2. 使用 `alipay_environment=sandbox`、`alipay_product=website` 创建 0.01 CNY 订单。
3. 确认响应包含 HTTPS `payment_url`。
4. 在浏览器打开 `payment_url`，确认收银台出现“打开支付宝收银台”按钮。
5. 通过支付宝沙箱收银端完成付款。
6. 确认订单后台变成支付成功。
7. 确认支付宝入站通知有成功处理记录。
8. 确认商户接收端收到 GMPay 成功通知并返回纯文本 `ok`。
9. 篡改一次通知金额或签名，确认接收端拒绝并返回非成功状态。
10. 重放同一事件，确认业务状态没有重复入账。

### 9.2 当面付

1. 后台启用“沙箱 + 当面付”连接和 CNY 收款方式。
2. 使用 `alipay_environment=sandbox`、`alipay_product=face_to_face` 创建订单。
3. 确认收银台渲染支付宝二维码，而不是网站支付跳转按钮。
4. 使用支付宝沙箱扫码或扫描测试二维码完成付款。
5. 重复检查订单状态、支付宝通知和商户通知。

### 9.3 失败恢复

还应验证：

- 商户通知接口返回 `500` 后能够收到重试。
- 停机恢复后通知仍能继续投递。
- 收银端刷新或重复提交不会生成第二笔订单。
- 连接被停用后不再有新的支付宝订单命中该连接。
- 生产连接未启用时，仅发送沙箱参数不会误用生产凭据。

## 10. 上线检查

- [ ] 生产应用地址为支付宝可访问的 HTTPS Origin。
- [ ] 生产支付宝应用已开通所选支付产品。
- [ ] 生产与沙箱连接、App ID 和密钥完全隔离。
- [ ] 支付宝私钥和公钥只存在启用且正确的连接中。
- [ ] 收款方式使用同一 App ID 且已启用。
- [ ] 商户 API 只授予所需 Scope。
- [ ] API Secret 保存在服务端 Secret Manager。
- [ ] 浏览器端只能访问 `payment_url`，不能获取 API Secret。
- [ ] `notify_url` 已通过验签、常量时间比较和幂等测试。
- [ ] 接收端审查了失败、超时、重定向和重复投递。
- [ ] 生产日志和审计中没有私钥、Secret、完整签名或未脱敏回调载荷。
- [ ] 电脑网站支付和当面付至少各完成一笔真实全链路测试。

## 相关文档

- [商户 API](MERCHANT_API.md)
- [支付方式与收款方式](PAYMENT_METHODS.md)
- [Webhook](WEBHOOKS.md)
- [安全说明](SECURITY.md)
- [部署检查清单](DEPLOYMENT.md)
