# Webhooks in practice

What a delivery looks like, how to handle it, and how to see retries with
your own eyes. The reference is
[docs.novaro.ink/webhooks](https://docs.novaro.ink/webhooks/).

## A delivery

One `POST` per event to your endpoint:

```http
POST /webhooks HTTP/1.1
Content-Type: application/json
PSP-Signature: t=1794076573,v1=5f0c…
PSP-Event-Id: evt_in_01M6VN6AYAE399R4SSZXSVRCPA
PSP-Delivery-Attempt: 1
User-Agent: NovaroPay/1.0 (+https://docs.novaro.ink/webhooks)

{"id":"evt_in_01M6…","object":"event","account":"macc_01M6…","api_version":"2026-11-04.acacia",
 "created":1794076573,
 "data":{"object":{"id":"pay_in_01M6…","object":"payment","status":"succeeded","version":4,…}},
 "livemode":false,"pending_webhooks":1,
 "request":{"id":null,"idempotency_key":null},"type":"payment.succeeded"}
```

`data.object` is the payment as `GET /payments/{id}` returns it right after the
change. `data.previous_attributes` comes only with
`payment.instructions_updated`. A delivery always has `request`: the `id` and
`idempotency_key` of the API request that caused the event, or `null` when none
did (the payer, a bank, or time passing). `GET /events/{id}` answers
`"request": null` then.

## Handling it: four rules

1. **Verify first, on the raw bytes.** Parse the JSON only after the
   signature passes. A framework that parses the body for you gives you other
   bytes. Read the raw body (`express.raw()`, `request.get_data()`,
   `file_get_contents('php://input')`). Refuse with `400`.
2. **Answer `2xx` within 10 seconds.** Queue the work, then answer. A redirect
   counts as a failure too.
3. **Once per event id.** The same event comes again after a timeout or a
   resend, with the same `id`. Store the ids you processed.
4. **Order by `version`, not by arrival.** Two events can arrive swapped.
   Keep the payment's highest `version`, and ignore an event with a lower one.

## Your secret(s)

| Who sends | Its secret |
| --- | --- |
| `novaro listen` on your machine | `novaro listen --print-secret` |
| A test endpoint in the portal | the endpoint's page, Test mode on |
| A live endpoint in the portal | the endpoint's page, Test mode off |

Each sender has its own secret. When more than one sends to the same server,
accept a signature that matches **any** of them. The example takes them
comma-separated in `NOVARO_WEBHOOK_SECRET`. While you roll a secret in the
portal, the header carries two `v1` values, and either one matching is
enough.

## Watching retries yourself

The example shop answers `503` while the file `data/DOWN` exists, so you can
see the schedule:

```sh
touch data/DOWN                         # the shop is "down"
checks/live-payment.sh                  # one live payment: a sk_live_ key in your clipboard
python3 checks/watch-retries.py <pay_in_…> 3
```

`watch-retries.py` prints every attempt of the payment's `payment.created`
event, with the time since the one before. After the 3rd failed attempt it
deletes `data/DOWN`, so the next attempt gets `200`. The schedule seen on
production:

| Attempt | When | Gap | The docs say |
| --- | --- | --- | --- |
| 1 | 18:44:04 | | at once |
| 2 | 18:45:06 | 1.04 min | 1 min ±10% |
| 3 | 18:50:23 | 5.27 min | 5 min ±10% |
| 4 | 19:04:16 | 13.89 min, answered `200` | 15 min ±10% |

Every attempt carries the same `PSP-Event-Id` and a new `PSP-Signature`
(a new `t`). `PSP-Delivery-Attempt` counts up.

In test mode the schedule is shorter: at once, then after 5 minutes, 30
minutes and 2 hours.

## When you were down for longer

- `GET /events?delivery_success=false` lists the events whose delivery failed.
- The endpoint's page in the portal: **Resend** one, or **Resend failed** for all.
- `novaro events resend evt_in_… --webhook-endpoint whe_in_…` from the CLI.
- An endpoint with no success for 24 hours is reported to your admins. After
  72 hours and at least 10 failed attempts it is turned off. Turn it on in
  the portal; events made while it was off are not sent, so read them with
  `GET /events?created[gte]=…`.
