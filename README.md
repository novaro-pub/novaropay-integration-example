# NovaroPay integration example

A merchant's shop integrated with NovaroPay from [docs.novaro.ink](https://docs.novaro.ink)
alone: UPI payments in India through the hosted payment page, the payer's way
back, and signed webhooks. Node.js 20.6+, no packages.

Start here:

| Read | For |
| --- | --- |
| **[INTEGRATION.md](INTEGRATION.md)** | the step-by-step guide: test mode with the `novaro` CLI first, then live, and a checklist |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | the payment flow and its statuses in two diagrams, and where each step is in the code |
| [WEBHOOKS.md](WEBHOOKS.md) | a delivery, the four rules of handling it, secrets, and watching retries yourself |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | every error we met while integrating, what it means and the fix |

In the code:

- `src/server.mjs`: the shop. `src/verify.mjs`: the docs' webhook signature check, as published.
- `checks/`: idempotency and `PSP-Version` checks, a live test payment, a retries watcher.

```sh
cp .env.example .env   # NOVARO_API_KEY, NOVARO_WEBHOOK_SECRET, PUBLIC_URL
npm start
```
