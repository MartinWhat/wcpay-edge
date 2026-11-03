# Alipay External Service Integration Guide

[简体中文](../zh-CN/ALIPAY_INTEGRATION.md) · English

This guide describes how an external merchant service configures Alipay in
GMPay Edge, creates orders, presents website or face-to-face payments, verifies
merchant notifications, and accepts a sandbox integration. External services
communicate with GMPay Edge and do not store or call Alipay private keys.

## 1. Responsibility boundary

```text
Browser / checkout UI
       │ create order
       ▼
External merchant service ─────► GMPay Edge ─────► Alipay
       ▲                              │
       └──── merchant notification ◄──┘
```

The external merchant service owns its business order, amount, customer
identity, and idempotency. GMPay Edge verifies merchant API signatures, invokes
the selected Alipay connection, hosts checkout, receives Alipay notifications,
and delivers merchant notifications.

The external service must keep API Secrets and Alipay keys in server-side secret
storage. Browsers receive only the HTTPS `payment_url` returned by GMPay Edge.

## 2. Configure GMPay Edge

### 2.1 Alipay application material

Prepare a separate App ID, application private key, and Alipay public key for
each environment:

- Sandbox: sandbox App ID, sandbox application private key, sandbox Alipay public key.
- Production: production App ID, application private key, production Alipay public key.

Use PKCS8 application private keys. The selected Alipay product must be enabled
on that application. Website payment uses `alipay.trade.page.pay`; face-to-face
payment uses `alipay.trade.precreate`.

### 2.2 Public application URL

Set **Settings → Authentication and signing keys → Application URL** to the
public HTTPS origin that Alipay can reach:

```text
https://pay.example.com
```

GMPay Edge derives the Alipay callback as:

```text
https://pay.example.com/api/providers/alipay/notify
```

This is a transaction notification endpoint. It is not the Alipay Open Platform
general application gateway, which this integration does not use.

### 2.3 Create a connection

Create one Alipay connection for each environment and payment product:

| Example name | Environment | Product |
| --- | --- | --- |
| Alipay sandbox website | Sandbox | Website payment |
| Alipay sandbox face-to-face | Sandbox | Face-to-face payment |
| Alipay production website | Production | Website payment |
| Alipay production face-to-face | Production | Face-to-face payment |

Enter the App ID, application private key, and Alipay public key only on the
connection. Do not reuse sandbox keys for production or keys from a different
payment product.

### 2.4 Create a receiving method

Create a receiving method with:

- type: Fiat;
- provider: Alipay;
- currency: CNY;
- the App ID of an enabled Alipay connection;
- product: Website payment or face-to-face payment;
- optional USD minimum and maximum order limits.

The receiving method stores no second copy of the keys. It selects the business
App ID and product and controls checkout exposure. The selected product must
have an enabled connection for that App ID. Connection changes take effect for
new payments and callback verification without duplicate receiving-method secrets.

### 2.5 Create a merchant API credential

Create a credential under **Admin → API credentials** with at least:

- `orders:create`;
- `orders:read`.

Save the displayed PID and API Secret immediately. The Secret is shown once and
must stay on the server in encrypted environment configuration or a secret
manager.

## 3. Network and security requirements

- Use HTTPS between the external service, GMPay Edge, and your notification receiver.
- `notify_url` and `redirect_url` must be public HTTPS URLs.
- Private, loopback, link-local, credential-bearing, and cloud-metadata URLs are rejected.
- API Secret is an HMAC key, not a Bearer token.
- Reuse the original `order_id` and parameters when retrying an unknown result.
- Never log Secrets, private keys, complete signatures, or unredacted callback payloads.

## 4. GMPay signing

Exclude `signature`, `null`, `undefined`, and empty values. Convert numeric
values to normal decimal strings, sort field names by ASCII, join `key=value`
pairs with `&` without URL encoding, calculate HMAC-SHA256 with the API Secret as
the key, and encode the result as 64 lowercase hexadecimal characters.

Field names must match `[A-Za-z_][A-Za-z0-9_]*`. A value must not contain
`&field_name=` because the legacy signature format has no escaping.

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

Use constant-time comparison when verifying signatures.

## 5. Create an Alipay order

```http
POST /payments/gmpay/v1/order/create-transaction
Content-Type: application/json
```

| Field | Required | Description |
| --- | --- | --- |
| `pid` | Yes | Merchant API PID |
| `order_id` | Yes | Unique merchant order ID |
| `currency` | Yes | `CNY` for Alipay |
| `amount` | Yes | Positive decimal, up to 18 integer and 8 fraction digits |
| `notify_url` | Yes | Public HTTPS merchant notification URL |
| `token` | Alipay | `CNY` |
| `network` | Alipay | `alipay` |
| `alipay_environment` | Recommended | `production` or `sandbox`; defaults to production |
| `alipay_product` | Recommended | `website` or `face_to_face`; must match the receiving method and defaults to its selected product |
| `redirect_url` | No | Merchant HTTPS return page after payment |
| `name` | No | Order subject, truncated to 256 characters for Alipay |
| `signature` | Yes | Lowercase HMAC-SHA256 signature |

`token` and `network` must be supplied together. Alipay environment and product
fields are invalid for another payment network.

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
  name: "Integration test order",
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
```

For face-to-face payment, send `alipay_product: "face_to_face"` and provide an
enabled sandbox or production face-to-face connection for the selected App ID.

A successful response includes `trade_id`, `order_id`, `status`,
`status_detail`, `expiration_time`, and an HTTPS `payment_url`. Open that URL in
the browser. Website payment presents an Alipay checkout action. Face-to-face
payment renders the Alipay QR code. Do not construct an Alipay gateway URL in
the external application.

## 6. Query an order

Send exactly one selector:

```http
GET /payments/gmpay/v1/order/query?pid=<PID>&order_id=<merchant-order-id>&signature=<signature>
```

or:

```http
GET /payments/gmpay/v1/order/query?pid=<PID>&trade_id=<gmpay-trade-id>&signature=<signature>
```

The response uses the same structure as order creation. Query is useful for
notification recovery, return-page refresh, and resolving a timed-out create
request. It does not replace merchant notifications.

## 7. Merchant notifications

GMPay Edge POSTs JSON to the order's immutable `notify_url`:

```json
{
  "pid": "100000000001",
  "trade_id": "GMPay trade ID",
  "order_id": "merchant order ID",
  "amount": "0.01",
  "actual_amount": "0.01",
  "receive_address": "Alipay App ID",
  "token": "CNY",
  "block_transaction_id": "Alipay trade ID or empty string",
  "status": 2,
  "signature": "lowercase-hmac-sha256"
}
```

Compatibility `status` values are `1` pending or another non-terminal state,
`2` paid or overpaid, and `3` closed. The notification has no `status_detail`;
apply status to the business record identified by `trade_id` and accept
duplicate or out-of-order delivery. `actual_amount` is the frozen expected order
amount, not cumulative received value.

The receiver must verify the signature, persist event identity, and return only:

```http
HTTP/1.1 200 OK
Content-Type: text/plain

ok
```

Only HTTP 200 with a trimmed plain-text body of `ok` succeeds. Redirects,
JSON success objects, empty bodies, and other text trigger retries.

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

Delivery is at least once. Deduplicate by `x-gmpay-event-id`, `trade_id`, and
business status using a database uniqueness constraint and transaction. Do not
roll a successful order backwards because an older notification arrives later.

The GMPay signature covers business fields only. Event and delivery IDs are
unsigned headers. Payloads captured outside TLS may be replayed, so the receiver
must rely on persisted event or order identity rather than message freshness.

## 8. Errors and retries

Responses use `status_code`, `message`, `data`, and `request_id`. Relevant order
codes include:

| Code | Meaning | Client action |
| ---: | --- | --- |
| `10001` | Query target not found | Check credential and selector |
| `10002` | External order ID already exists | Query the original order |
| `10003` | Receiving method or provider unavailable | Fix connection/product credentials or retry |
| `10004` | Invalid amount | Correct the amount without floating-point arithmetic |
| `10009` | Invalid parameters | Check CNY, token/network, HTTPS URLs, and Alipay selection |
| `10016` | Asset or exchange rate unavailable | Check CNY asset and rate configuration |
| `401` | PID, scope, or signature rejected | Stop retrying a bad Secret |
| `429` | Rate limited | Back off |
| `500` | Unexpected server failure | Keep `request_id` and query by the original order ID |

An order creation timeout has an unknown outcome. Keep the original `order_id`
and query it. If it does not exist, retry the original request; if it exists,
continue that order.

## 9. Sandbox acceptance

For website payment:

1. Enable the sandbox website connection and the CNY receiving method.
2. Create a 0.01 CNY order with `sandbox` and `website`.
3. Verify the HTTPS `payment_url`.
4. Open checkout and follow the Alipay action.
5. Pay with a sandbox payer.
6. Verify paid status, the Alipay inbound receipt, and the merchant notification.
7. Tamper with the notification signature and verify rejection.
8. Replay the same event and verify business idempotency.

Repeat the flow with `face_to_face`, confirming that checkout renders the QR
code. Also test notification retry after a `500`, recovery after downtime, no
duplicate order on browser refresh, and no use of a disabled connection.

## 10. Production checklist

- [ ] Alipay can reach the public HTTPS application URL.
- [ ] The selected Alipay products are enabled on the production application.
- [ ] Production and sandbox connections, App IDs, and keys are isolated.
- [ ] Alipay keys exist only on the correct connections.
- [ ] The receiving method uses the same enabled App ID.
- [ ] Merchant API credentials have only the required scopes.
- [ ] API Secrets stay in server-side secret storage.
- [ ] The receiver verifies signatures and handles duplicate delivery.
- [ ] Failure, timeout, redirect, and replay paths are tested.
- [ ] Logs contain no keys, Secrets, complete signatures, or unredacted payloads.
- [ ] Website and face-to-face payments each pass a real end-to-end test.

## Related documentation

- [Merchant API](MERCHANT_API.md)
- [Payment and receiving methods](PAYMENT_METHODS.md)
- [Webhooks](WEBHOOKS.md)
- [Security notes](SECURITY.md)
- [Deployment checklist](DEPLOYMENT.md)
