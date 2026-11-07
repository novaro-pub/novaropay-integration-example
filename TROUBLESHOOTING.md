# Troubleshooting

What the API answered while we integrated, what it meant, and the fix. Every
error body has `error.type`, usually `error.code`, and often `error.param`
and `error.doc_url`. Always log `error.code` and the response's
`X-Request-Id`, and quote them when you ask us.

## Keys and accounts

| You see | It means | Fix |
| --- | --- | --- |
| `401` "Invalid API key provided." | the key is wrong, or not this mode's | check which key your server read: test vs live, a stale env value |
| `401` `api_key_expired` | the key was expired or rotated away; the message names its prefix | put the current key in its place (portal › API keys) |
| `403` `ip_not_allowed` | a live key from an address the IP allowlist does not list | add the server's address in the portal's IP allowlist |
| `403` `api_key_permission` | a CLI key (`rk_test_…`) on a call the CLI does not make | use a secret key (`sk_…`) on your server |
| `404` `resource_missing` on a payment you just made with the CLI | your `sk_test_` key and the CLI's key are of **different accounts** | create the key on the account the CLI is paired with, or `novaro logout && novaro login` with the right company open in the portal |

The last one is easy to hit. `novaro login` pairs the CLI with an account of
the company **open in the portal** when you press Allow. If you have access
to several companies, switch to the right one first.

## Making a payment

| You see | It means | Fix |
| --- | --- | --- |
| `400` `parameter_missing`, param `Idempotency-Key` | `POST /payments` without the header | send one per operation |
| `400` `method_not_enabled`, param `payment_method_data.type` | UPI in INR is not switched on for your account **in this mode** (test and live are set apart) | ask your account manager to switch it on |
| `400` `amount_too_small` / `amount_too_large` | outside the method's limits (UPI in India: from ₹200) | change the amount |
| `503` `checkout_unavailable` | your account has no checkout domain yet; nothing was created | ask your account manager; a payment without `checkout` works meanwhile |
| `400` `parameter_invalid`, param `checkout.return_url` | not an absolute `https` URL, longer than 2048 characters, or not printable ASCII | send `https://…` |

## Idempotency

| You see | It means | Fix |
| --- | --- | --- |
| `201` with `Idempotent-Replayed: true` | a retry: you get the first answer, nothing ran again | nothing: this is the point |
| `409` `idempotency_key_in_use` | the first request with this key is still running | retry shortly, with the same key |
| `400` type `idempotency_error`, no code | the same key with another body, or to another endpoint | a new operation needs a new key |
| `400` `parameter_invalid`, param `Idempotency-Key` | longer than 255 characters, or not printable ASCII | use a UUID or `<order id>:<step>` |

A request refused for a parameter (`400`) does not use its key up. Fix the
request and send it again with the same key.

## Versions

| You see | It means | Fix |
| --- | --- | --- |
| `400` `invalid_api_version` | `PSP-Version` names no version, is sent twice, or is not written exactly (lower-case name) | send the version as the docs' top bar shows it, e.g. `2026-11-04.acacia` |
| The response's `PSP-Version` is not the one you expected | you sent none, so your account's default answered | send `PSP-Version` on every request |

## Webhooks

| You see | It means | Fix |
| --- | --- | --- |
| Your check refuses every delivery | you verify re-serialised JSON, or with the wrong secret | verify the raw body; check which sender it is (`novaro listen`, test or live endpoint) and use its secret |
| It refuses some deliveries, not others | your clock is off by more than 5 minutes, or a second sender with its own secret | sync the clock (NTP); accept every sender's secret |
| `listen` shows `[503]` / `[500]` | your server answered that | fix the handler; it must answer `2xx` |
| Nothing arrives at your live endpoint | the URL is not public `https` with a host name, it resolves to a private address, it redirects, or your firewall blocks us | fix the URL; allow [our IP addresses](https://docs.novaro.ink/security/our-ips/) |
| The same event twice | a retry or a resend: the same `id` | process each id once |

## The hosted page

| You see | It means |
| --- | --- |
| The payer is back but the payment is `processing` | normal: the UTR is in, the money is confirmed a little later. Refresh, or wait for `payment.succeeded` |
| The payer never came back | normal too: deliver on the webhook |
| "This link is no longer valid" | the page's token is wrong or past its time (24 hours after the payment expires) |
| In an iframe, nothing shows | the payment was made without `checkout.embed_origin`, or with another origin than the framing page's |
