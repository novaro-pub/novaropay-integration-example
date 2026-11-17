# Reports through the API

Your server asks for a CSV of your account's payments over a period, waits
for it and downloads it: to close a month, reconcile with your balance or
load into your accounting. Written from
[docs.novaro.ink/reports/get-reports-through-the-api](https://docs.novaro.ink/reports/get-reports-through-the-api/),
[/api/report-types](https://docs.novaro.ink/api/report-types/),
[/api/report-runs](https://docs.novaro.ink/api/report-runs/) and
[/api/files](https://docs.novaro.ink/api/files/) alone. What each column
holds: [docs.novaro.ink/reports](https://docs.novaro.ink/reports/).

In the code:

- `src/reports.mjs`: the client. Report types, creating a run, waiting for it,
  downloading its file, reading the CSV.
- `src/report.mjs`: the command, `npm run report`.
- `src/server.mjs` and `src/report-runs.mjs`: the shop downloads a report it
  asked for when its `reporting.report_run.succeeded` webhook comes, and tries
  again when the download fails.
- `checks/reports.mjs`: every documented answer, against your key.
  `checks/reports-offline.test.mjs` (`npm test`): what a key cannot make happen
  on demand, against a fake API.

You need a **secret key** (`sk_test_in_…` while you build). A CLI key
(`rk_…`) gets `403 api_key_permission`. Reports came with API version
`2026-11-14.acacia`: `.env.example` pins it.

## Run it

```sh
cp .env.example .env        # NOVARO_API_KEY=sk_test_in_…
npm run report              # the last 30 days, succeeded payments
npm run report -- --month 2026-11 --status all
```

What it prints, with a test key (ids shortened):

```text
$ npm run report -- --month 2026-11 --status all
report types: payments.itemized.1 (livemode false)
payments.itemized.1: data from 2026-11-14T14:08:59Z to 2026-11-17T08:32:57Z
  the period starts at the account's first payment, 2026-11-14T14:08:59Z, not 2026-10-31T18:30:00Z
  the period ends at 2026-11-17T08:32:57Z, a minute ago, not 2026-11-30T18:30:00Z
created frr_in_01M7MA8D…: pending, 2026-11-14T14:08:59Z to 2026-11-17T08:32:57Z, data as of 2026-11-17T08:32:57Z, Idempotency-Key 7e27a161-…
  frr_in_01M7MA8D…: succeeded
downloaded payments_<merchant>_IN_2026-11-14_2026-11-17_frr_in_01M7MA8D….csv, 900 bytes, to data/reports/…
  5 rows
  by status: failed: 3, succeeded: 2
  INR amount_credited 998.00
  INR fee_amount 29.96
  INR net_amount 968.04
  {"payment_id":"pay_in_01M7MA64…","merchant_reference":"novaro_trigger_95416ce5…","status":"succeeded","amount_credited":"499.00","fee_amount":"14.98","net_amount":"484.02","fee_status":"posted","utr":"000000000001",…}
```

The file is kept in `data/reports/` under the name the API gives it.

## The four steps

### 1. Choose the report type

`GET /reporting/report_types` lists the types your key can ask for:
`payments.itemized.1`, and `payouts.itemized.1` on a market that has payouts.
`GET /reporting/report_types/payments.itemized.1` gives its `columns`,
`filters` and the period its data covers now:

- `data_available_start`: your account's first payment. A period may not
  start before it, so the month of your first payment starts there, not at
  the month's start. `null` while the account has no payment: in test mode,
  make some with the magic UTRs first ([INTEGRATION.md](INTEGRATION.md#24-create-a-payment-and-send-the-payer-to-the-hosted-page)).
- `data_available_end`: one minute ago. A period may not end after it.

`src/report.mjs` moves the period's ends inside these two and says so.

### 2. Create the run

```js
await reports.createRun({
  report_type: "payments.itemized.1",
  parameters: {
    interval_start: 1790793000,   // 2026-10-01T00:00:00+05:30
    interval_end: 1793471400,     // 2026-11-01T00:00:00+05:30, not included
    timezone: "Asia/Kolkata",     // the times in the file, the dates in its name
    date_basis: "finalized",      // a payment is in the period it reached its final status in
    columns: ["payment_id", "merchant_reference", "account_id", "currency", "status", "finalized_at",
              "amount_credited", "fee_amount", "net_amount", "fee_status", "utr"],
    status: "succeeded",          // a filter: only the succeeded payments
  },
}, idempotencyKey);
```

- **A month** is midnight to midnight in the market's time zone:
  `monthInterval("2026-10", "+05:30")` in `src/reports.mjs`.
- **`Idempotency-Key`**: one per report, the same on every retry. A retry
  after a timeout answers the run the first request made, with
  `Idempotent-Replayed: true`, never a second one.
- **`PSP-Version`** on every request, as everywhere else.
- Without `columns` you get the type's `default_columns`; without
  `timezone`, `Etc/UTC`.

The answer is `201` with the run, `status` `pending`.

### 3. Wait for it: webhook or polling

A run is `pending` while its file is made, usually for seconds. It ends
`succeeded`, with its file in `result`, or `failed`, with `error` in words.

**By webhook.** A run your key created sends `reporting.report_run.succeeded`
or `reporting.report_run.failed` to your account's endpoints that listen to
them, or to all events, with the run in `data.object`: an endpoint of
`payment.*` alone gets neither. The example shop handles it in the same `webhook()` as the
payment events: signature first, `200` at once, each event id once. The
event is only a hint: the shop does not act on its payload.

`npm run report` keeps the id of every run it creates, in
`data/report-runs/runs/`. The shop **sweeps** those runs (`src/report-runs.mjs`):
at start, every 5 minutes (`REPORTS_SWEEP_MS`, from 60000 ms; another value
is logged and the default used), and soon after a webhook for
one of them. A sweep goes through the kept runs that are not final, one after
another, reads each, `GET /reporting/report_runs/{id}`, and does what the API
says:

| The API says | The sweep |
| --- | --- |
| `pending` | leaves it for the next sweep |
| `succeeded` | downloads the file, marks it `downloaded` as soon as the file is written, then logs a summary |
| `failed` | records it failed |
| the file has expired (`400 file_expired`) | asks for the same report again, once, with an `Idempotency-Key` kept in the run's state, and keeps the new run for the next sweep |

- **Only the runs it kept.** Every key of your account, and your team in the
  portal, can make runs; the shop leaves the others alone.
- **A missed webhook** is caught by the next sweep, at most 5 minutes later;
  a webhook that comes during a sweep runs one more sweep after it.
- **The API does not answer** (no answer, a `5xx`): the run is asked about
  again at the next sweep, however long that takes, and not counted.
- **A download or a rerun fails** after the API answered: that is counted,
  and tried again at a sweep after 1 minute, then 2, 4… (`next_try_at` in its
  state). After 8 such failures the run is given up, and so is a report
  whose second run's file expired too. Redo it yourself:
  `GET /reporting/report_runs/{id}` and download its `result.url`, or create
  a new run.
- **`npm run report` without `--wait webhook`** waits and downloads itself,
  and marks the kept run `downloaded`. If it fails, it says so and exits `1`,
  and the shop's sweep takes the run up. A sweep in between may download the
  same file too: to the same name.
- **A sweep never stops the shop.** A run that cannot be settled, its state
  unwritable for one, is logged and tried at the next sweep. Each state and
  report is written to a temporary name and renamed. A state file that does
  not parse is logged and moved aside (`<id>.json.bad-<time>`); one that
  cannot be read, and any other file in the folder, is skipped.
- **Stopping.** `Ctrl-C` or `SIGTERM` stops new sweeps and requests, and
  waits up to 10 seconds for a running sweep to end. Temporary files more than
  an hour old, left by a stop in the middle of a write, are removed at start.
- **Where.** `data/` in this folder, or `NOVARO_DATA_DIR` for both the shop
  and `npm run report`: they must share it.

To try it on your machine:

```sh
npm start                                                   # terminal 1: the shop, PORT=3000
novaro listen --forward-to localhost:3000/webhooks          # terminal 2
npm run report -- --wait webhook                            # terminal 3: create the run and stop
```

```text
novaro listen   --> reporting.report_run.succeeded [evt_in_01M7MA8R…]
                <--  [200] POST http://localhost:3000/webhooks [evt_in_01M7MA8R…]
npm start       report frr_in_01M7MA8R… downloaded to data/reports/payments_<merchant>_IN_2026-11-14_2026-11-17_frr_in_01M7MA8R….csv
                  5 rows
                  by status: failed: 3, succeeded: 2
                  INR amount_credited 998.00
                  …
```

A run of another key, or of your team, is logged as `not a run this shop
created; left alone`.

**By polling.** `npm run report` without `--wait webhook` reads the run with
a backoff: 2 seconds, then twice as long each time, at most a minute apart,
for an hour at most, through a `429` or a `5xx` (`waitForRun()`).

### 4. Download the file

`result.url` is a path, `/files/{id}/contents`: put the API's base URL before
it and call it **with your key**. The answer is a `302` to the file itself, a
link good for 60 seconds. Follow it at once **without your key**: the key goes
to the API's host alone. `download()` asks with `redirect: "manual"` and
fetches the `Location` with no `Authorization` header. A `Location` that is a
path is on the API's host: `new URL(location, base)`.

With curl that is `-L`, which drops the key on another host; never
`--location-trusted`.

The file is kept for 7 days after the run succeeded, until
`result.expires_at`. Download it when the run ends, and keep it.

## Reading the file

- UTF-8 with a **byte order mark**, so a spreadsheet reads ₹ and names in any
  script. Strip it before the first column's name.
- **CRLF** line ends, RFC 4180 quoting: a field can hold a comma, a quote or a
  line break. `csvReader()` reads all three, a piece at a time; a split on
  `\n` and `,` does not.
- **Amounts** in major units with a dot, `4999.00`. `summarizeFile()` adds
  them up as whole paise, never as floats, reading the saved file as a
  stream: a large report is never in memory whole.
- A text value that began with `=`, `+`, `-` or `@` has an apostrophe before
  it (`'-1042`), so a spreadsheet does not run it as a formula. Strip it
  before you join the file to your own order ids.
- `amount_credited` in the report is what your balance got for the payment,
  corrections included; the payment object's `amount_credited` is what to
  credit your customer.

## Errors

A refused request makes no run. `src/report.mjs` prints the API's `code`,
`param`, `message` and what to do.

| Error | When | What the example does |
| --- | --- | --- |
| `400 report_interval_invalid` | The period starts before `data_available_start`, ends after `data_available_end`, ends before it starts, or is longer than 366 days. `param` names the end to change: `parameters[interval_start]` or `parameters[interval_end]`. | Reads the type first and keeps the period inside it. If refused anyway, prints the end to change. Split a longer period into several runs. |
| `409 report_runs_in_progress` | 3 runs of your key, or 5 of your merchant's, are still being prepared. | Sends the same request, with the same `Idempotency-Key`, a minute later, five times at most: no run was made, so it makes one. |
| `400 file_expired` | The file is past its `expires_at`. | A new run with the run's `report_type` and `parameters`: `npm run report` waits for it and downloads its file (`fetchFile()`); the shop's sweep asks once, and keeps the new run. |
| `400 parameter_invalid` | A column the type has not, a time zone that is not an IANA name, a `status` that is not final with `date_basis` `finalized`. `param` names it. | Asks only for columns in the type's `columns`. |
| `400`, type `idempotency_error` | The key was used for another request in the last 24 hours. | A new key for each new report. |
| `404 resource_missing` | The run or file is not your key's account's, or does not exist. | |
| `429`, `5xx`, no answer | | Sent again: a create a minute later with the same key; a read or a download with a backoff. |

A run that ends **`failed`** has `error` in words, such as "The file is over
1.5 GB: choose a shorter period or fewer columns.". Create a new run as it
says; the failed one is not tried again.

## Checks

```sh
node --env-file=.env checks/reports.mjs     # against your key: makes a few test runs
npm test                                    # no key, no network
```

`checks/reports.mjs` prints each case, what the docs say, and what came back:
the types, a type that does not exist, a period before the first payment,
after `data_available_end` and ending before it starts, an unknown column and
parameter, a status that is not final, the same `Idempotency-Key` twice and
with another body, six runs at once (at most three of them prepared together,
the rest `409 report_runs_in_progress`), the `302` and the file through its
link without the key (BOM, CRLF), and a file and a run that do not exist. It
takes a test key only.

`file_expired` comes 7 days after a run, so a key cannot make it on demand:
`checks/reports-offline.test.mjs` runs the client against a fake API for it,
and for a `409` or a `5xx` that clears, no answer, `Retry-After`, a
`Location` on another host, the backoff and its one-hour end, a CSV with
quotes and line breaks in its fields, and the shop's runs: only its own,
marked before the download, tried again, taken up on start.

## Checklist

- [ ] A secret key, on the server; never a CLI key.
- [ ] The period inside the type's `data_available_start` and `data_available_end`; a month at midnight in the market's time zone.
- [ ] One `Idempotency-Key` per report, reused on retries; `PSP-Version` on every request.
- [ ] Waiting by the `reporting.report_run.*` webhook (signature checked, `200` first, the download after, only for your own runs, tried again when it fails), or by reading the run with a backoff.
- [ ] The file link followed without the key.
- [ ] The CSV read with its BOM, CRLF and quoting; amounts summed as integers.
- [ ] The file downloaded when its run ends and kept: it expires in 7 days.
