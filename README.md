# NovaroPay integration example

A merchant's shop integrated with NovaroPay from [docs.novaro.ink](https://docs.novaro.ink)
alone: UPI payments in India through the hosted payment page, the payer's way
back, signed webhooks, and reports of your payments through the API.
Node.js 20.6+, no packages.

Start here:

| Read | For |
| --- | --- |
| **[INTEGRATION.md](INTEGRATION.md)** | the step-by-step guide: test mode with the `novaro` CLI first, then live, and a checklist |
| **[H2H.md](H2H.md)** | host to host: the payer pays on **your own** page or app, from the payment's `next_action` details, and you pass on their UTR |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | the payment flow and its statuses in two diagrams, and where each step is in the code |
| **[REPORTS.md](REPORTS.md)** | reports through the API: ask for a CSV of your payments, wait for it by webhook or by polling, download and read it |
| [WEBHOOKS.md](WEBHOOKS.md) | a delivery, the four rules of handling it, secrets, and watching retries yourself |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | every error we met while integrating, what it means and the fix |

In the code:

- `src/server.mjs`: the shop. `src/verify.mjs`: the docs' webhook signature check, as published.
- `src/reports.mjs`, `src/report.mjs`, `src/report-runs.mjs`: reports through the API (`npm run report`).
- `checks/`: idempotency and `PSP-Version` checks, a live test payment, a retries watcher,
  the Reporting API's answers (`checks/reports.mjs`) and the reporting client's offline tests (`npm test`).

```sh
cp .env.example .env   # NOVARO_API_KEY, NOVARO_WEBHOOK_SECRET, PUBLIC_URL
npm start
npm run report         # a payments report of the last 30 days
```
