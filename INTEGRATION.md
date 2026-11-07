# Integrating NovaroPay: step by step

This guide takes your server from nothing to taking UPI payments in India
through NovaroPay's hosted payment page, with webhooks. To show the payment
details on your own page or in your app instead (host to host), follow this
guide up to step 2.3, then [H2H.md](H2H.md). Every step was run
against the production API with this repository's example shop
(`src/server.mjs`), which you can copy from. The full reference is
[docs.novaro.ink](https://docs.novaro.ink).

You will need:

- a NovaroPay merchant account on the India market, and a person with the
  **admin** or **developer** role on it in the merchant portal,
  [portal.novaro.ink](https://portal.novaro.ink);
- a server that can make HTTPS requests and receive them on a public
  `https` URL (for webhooks and for the payer's way back);
- for local development: macOS, Linux or Windows, and the `novaro` CLI.

Amounts are in **paise** (`49900` is ₹499.00). Times are seconds since the
Unix epoch.

---

## 1. Install the CLI

```sh
brew install novaro-pub/tap/novaro      # macOS, Linux
novaro version
```

On Windows: `scoop bucket add novaro https://github.com/novaro-pub/scoop-bucket`
then `scoop install novaro`. Other systems, packages and the Docker image:
[github.com/novaro-pub/novaro-cli](https://github.com/novaro-pub/novaro-cli).
Install it only from there: releases are signed, and
[docs.novaro.ink/webhooks/test-locally](https://docs.novaro.ink/webhooks/test-locally/)
shows how to check a download.

## 2. Build in test mode first

Test mode is the same API on the same host, with its own keys and data and no
real money. The key you send decides the mode: `sk_test_in_…` is test,
`sk_live_in_…` is live.

### 2.1 Pair the CLI with your account

In the merchant portal, **open the company and account you are integrating**
(the page that allows the CLI offers the accounts of the company that is open).
Then:

```sh
novaro login
```

It shows a code and opens the portal's **Allow CLI access** page. Check the
code is the same, pick the account, and press **Allow**. The CLI keeps its own
test key (`rk_test_in_…`, 90 days) in your keychain. You can see and expire it
in the portal under **Settings › Developers › API keys › CLI keys**.

### 2.2 Create your server's test key

Portal, **Test mode** on, **Settings › Developers › API keys › Create secret key**.
The secret is shown **once**: put it in your secret manager or `.env`, never in
code, a browser or an app.

```sh
cp .env.example .env     # then fill in NOVARO_API_KEY=sk_test_in_…
```

Check the key and the CLI are on the **same account**: a payment the CLI makes
must be readable with your key.

```sh
novaro trigger payment.created            # prints the payment id
curl -s https://api.novaro.ink/payments/<that id> -H "Authorization: Bearer $NOVARO_API_KEY"
```

`404 resource_missing` means the two keys are of different accounts: create
the key on the account the CLI is paired with, or run `novaro login` again.
`400 method_not_enabled` on `POST /payments` means UPI in INR is not switched
on for the account in that mode: ask your account manager.

### 2.3 Receive webhooks on your machine

Start your server, then forward test events to it. `--forward-to` is the
address of **your own** webhook handler on your machine: the port your server
listens on and the path of its webhook route. Do not copy the value below as
it is: put in yours.

```sh
npm start                                             # your server
novaro listen --forward-to localhost:<port>/<path>    # in a second terminal
```

For example:

| Your server | `--forward-to` |
| --- | --- |
| this example shop, `PORT=3000` in `.env`, route `POST /webhooks` | `localhost:3000/webhooks` |
| Express on port 8080, `app.post("/api/novaro/webhook", …)` | `localhost:8080/api/novaro/webhook` |
| Django on port 8000, `path("payments/webhook/", …)` | `localhost:8000/payments/webhook/` |
| a local `https` server with a self-signed certificate | `https://localhost:8443/hooks --skip-verify` |

Without a scheme it is `http://`. If `listen` shows `[404]`, the path is not
your route; nothing at all in your server's log usually means the port is
wrong.

`novaro listen --print-secret` prints the signing secret (`whsec_…`) of this
machine: put it in `NOVARO_WEBHOOK_SECRET`. Now make events happen:

```sh
novaro trigger payment.succeeded     # created → processing → succeeded
novaro trigger payment.failed        # created → processing → failed (about 5 s later)
```

`listen` prints each event and your server's answer. Your handler must:

1. **Check the signature first**, on the raw body as it came
   (`PSP-Signature: t=…,v1=…`, HMAC-SHA256 of `t.body` with the secret, and
   `t` within 5 minutes). Copy the function from
   [docs.novaro.ink/webhooks/signatures](https://docs.novaro.ink/webhooks/signatures/)
   (Go, Node.js, Python, PHP, Java); `src/verify.mjs` here is that file.
   Answer `400` to a request that fails it, and do nothing.
2. **Answer `2xx` within 10 seconds**, then do the work.
3. **Process each event id once**: a retry repeats the same `id`.
4. **Never go back**: events can come out of order. Keep the payment's
   `data.object.version` and ignore an event with an older one.

See `webhook()` and `applyPayment()` in `src/server.mjs`.

### 2.4 Create a payment and send the payer to the hosted page

From your server, never from a browser:

```sh
curl https://api.novaro.ink/payments \
  -H "Authorization: Bearer $NOVARO_API_KEY" \
  -H "PSP-Version: 2026-11-04.acacia" \
  -H "Idempotency-Key: ord_8812:create-payment" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49900,
    "currency": "INR",
    "payment_method_data": { "type": "upi" },
    "merchant_reference": "ord_8812",
    "customer": { "id": "cus_4921" },
    "checkout": { "return_url": "https://shop.example/orders/ord_8812" }
  }'
```

The answer is `201` with the payment; redirect the payer to
`checkout.url`. The page shows the amount, a QR, the UPI ID and a form for
the payer's UTR, on your account's own checkout domain and in your brand.

- **`Idempotency-Key` is required.** Use one per operation (your order id and
  the step), and send the same key when you retry: you get the first answer
  again (`Idempotent-Replayed: true`) and never a second payment. Retry only
  `409`, `429` and `5xx`, and network errors.
- **`PSP-Version`** pins your code to the API version it was written for.
  Send it on every request: without it a request runs in your account's
  default version.
- `503 checkout_unavailable` means your account has no checkout domain yet:
  ask your account manager. A payment without `checkout` works meanwhile.

**Try it in test mode:** on the page, type a magic UTR into
"Paid? Enter your UTR":

| UTR | Result |
| --- | --- |
| `000000000001` | succeeded at once |
| `000000000003` | failed about 5 s later |
| `000000000004` | succeeded, paid ₹1.00 less (`amount_mismatch`) |
| `000000000005` | expires, then succeeds late |
| any other 12 digits | succeeded about 5 s later |

### 2.5 Take the payer back and deliver

The page sends the payer to your `return_url` **exactly as you sent it**:
nothing is added, no status. So:

1. Keep your order id in the `return_url`.
2. On that page, read the payment from your server: `GET /payments/{id}`.
3. Show what its `status` says. `processing` is normal on the way back: the
   money is confirmed shortly after; refresh until it is final.
4. **Deliver on `payment.succeeded`** (webhook) or on a `GET` that says
   `succeeded`, whichever comes first, once. The payer may never come back.

| `status` | Meaning |
| --- | --- |
| `awaiting_payer` | not paid yet |
| `processing` | the payer gave a UTR; we are finding the money |
| `succeeded` | paid: deliver (credit `amount_credited`) |
| `expired` | not paid in time; a late payment can still succeed |
| `failed` | will not be paid |

## 3. Go live

1. **Live key.** Portal with Test mode **off** › Settings › Developers ›
   API keys › Create secret key. Replace the test key on your servers.
2. **IP allowlist** (recommended). Settings › Developers › IP allowlist: your
   servers' addresses. A live key is then useless anywhere else.
3. **Live webhook endpoint.** Settings › Developers › Webhooks › add
   endpoint: your public `https://…/webhooks` URL (a host name, not an IP)
   and the event types (all, or `payment.*`). Copy its signing secret into
   `NOVARO_WEBHOOK_SECRET`. Several secrets, comma-separated, work in the
   example shop, for when the CLI and an endpoint both send to it. If your
   firewall filters, allow
   [our IP addresses](https://docs.novaro.ink/security/our-ips/).
4. **Retries.** Answer `2xx` within 10 s or we try again, with the same event
   `id`: at once, then after 1, 5, 15 and 30 minutes, then 1, 2, 3, 4, 6, 6,
   7, 8, 10, 12 and 12 hours (16 attempts over about 3 days). An endpoint with
   no success for 24 hours is reported to your admins; after 72 hours it is
   turned off. Missed events: `GET /events?delivery_success=false`, or
   **Resend failed** on the endpoint's page.
5. **First live payment.** Make a small real payment through your shop and
   watch it reach `succeeded` and your endpoint.

## Checklist

- [ ] Secret keys only on servers, from a secret manager; none in code.
- [ ] Every `POST` has an `Idempotency-Key`; retries reuse it.
- [ ] Every request sends `PSP-Version`.
- [ ] Webhook signature checked on the raw body before anything else; `400` when it fails.
- [ ] `2xx` within 10 s; work done after.
- [ ] Each event id processed once; older `version`s ignored.
- [ ] The order is delivered from the payment's status, never from the way back.
- [ ] Live key limited by the IP allowlist.
- [ ] Live endpoint added, its secret deployed, a live event received.

## Running this example

```sh
cp .env.example .env     # fill in the key, the secret and PUBLIC_URL
npm start
```

`PUBLIC_URL` must be an `https` address that reaches the server, for the
payer's way back and for live webhooks: your domain, or a tunnel while you
try it (`cloudflared tunnel --url http://localhost:3000`). Create a file
`data/DOWN` to make the shop answer webhooks with `503`, to watch retries.
`checks/idempotency-and-versions.sh` checks idempotency and `PSP-Version`
with the test key in `.env`.
