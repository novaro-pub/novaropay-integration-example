// Gets a payments report through the API, end to end, from
// docs.novaro.ink/reports/get-reports-through-the-api: lists the report
// types, creates a payments.itemized.1 run, waits for it, downloads its file
// and prints a summary. See REPORTS.md.
//
//   npm run report                          the last 30 days, waiting by reading the run
//   npm run report -- --month 2026-11       a calendar month in India
//   npm run report -- --status all          every payment, not only succeeded ones
//   npm run report -- --wait webhook        create the run and leave the rest to
//                                           the webhook handler in src/server.mjs
//
// Settings (environment, see .env.example): NOVARO_API_KEY (sk_test_in_… or
// sk_live_in_…), NOVARO_API_VERSION, NOVARO_API_BASE.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, reportRuns } from "./report-runs.mjs";
import { ApiError, monthInterval, reportsClient, summarizeFile, writeReport } from "./reports.mjs";

const API = process.env.NOVARO_API_BASE ?? "https://api.novaro.ink";
const KEY = process.env.NOVARO_API_KEY;
if (!KEY) throw new Error("NOVARO_API_KEY is not set (see .env.example)");
const VERSION = process.env.NOVARO_API_VERSION ?? "2026-11-14.acacia";
// India: its time zone, and the offset a month starts at midnight in.
const TIMEZONE = "Asia/Kolkata";
const OFFSET = "+05:30";
const TYPE = "payments.itemized.1";
// The columns we ask for, in this order: what a reconciliation needs.
const COLUMNS = ["payment_id", "merchant_reference", "account_id", "currency", "status", "finalized_at", "amount_credited", "fee_amount", "net_amount", "fee_status", "utr"];

const { values: opt } = parseArgs({
  options: {
    month: { type: "string" }, // YYYY-MM
    status: { type: "string", default: "succeeded" }, // a payment status, or "all"
    wait: { type: "string", default: "poll" }, // poll | webhook
  },
});
if (opt.wait !== "poll" && opt.wait !== "webhook") throw new Error(`--wait is poll or webhook, not ${opt.wait}`);
const DATA = dataDir(); // data/, or NOVARO_DATA_DIR
const reports = reportsClient({ api: API, key: KEY, version: VERSION, log: (m) => console.log("  " + m) });
const fmt = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

try {
  // 1. The types this key can ask for.
  const types = await reports.listTypes();
  console.log(`report types: ${types.data.map((t) => t.id).join(", ")} (livemode ${types.data[0]?.livemode})`);
  const type = await reports.getType(TYPE);
  if (type.data_available_start == null) {
    console.log(`${TYPE}: no payment on this account yet, so nothing to report. In test mode, make payments with the magic UTRs first.`);
    process.exit(1);
  }
  console.log(`${TYPE}: data from ${fmt(type.data_available_start)} to ${fmt(type.data_available_end)}`);

  // 2. The period: within the type's data, its end not included.
  let { start, end } = opt.month ? monthInterval(opt.month, OFFSET) : { start: type.data_available_end - 30 * 86400, end: type.data_available_end };
  if (start < type.data_available_start) {
    console.log(`  the period starts at the account's first payment, ${fmt(type.data_available_start)}, not ${fmt(start)}`);
    start = type.data_available_start;
  }
  if (end > type.data_available_end) {
    console.log(`  the period ends at ${fmt(type.data_available_end)}, a minute ago, not ${fmt(end)}`);
    end = type.data_available_end;
  }

  // 3. The run: its columns, a filter, and one Idempotency-Key for this report.
  const parameters = {
    interval_start: start,
    interval_end: end,
    timezone: TIMEZONE,
    date_basis: "finalized",
    columns: COLUMNS.filter((c) => type.columns.includes(c)),
    ...(opt.status === "all" ? {} : { status: opt.status }),
  };
  // Where the run's id is kept for the shop (npm start), which sweeps it and
  // downloads it unless this command already has: checked before the run is
  // made, so a folder that cannot be written makes no run.
  const runs = reportRuns({ reports, dir: join(DATA, "report-runs"), reportsDir: join(DATA, "reports") });
  runs.writable();

  const idempotencyKey = randomUUID();
  let run = await reports.createRun({ report_type: TYPE, parameters }, idempotencyKey);
  console.log(`created ${run.id}: ${run.status}, ${fmt(start)} to ${fmt(end)}, data as of ${fmt(run.data_as_of)}, Idempotency-Key ${idempotencyKey}`);

  runs.record(run);
  if (opt.wait === "webhook") {
    console.log("the shop (npm start) downloads it: soon after its webhook, or at its next sweep");
    process.exit(0);
  }

  // 4. Wait by reading the run, with a backoff; 5. download, keep, sum up.
  // On a failure, the shop's sweep picks the run up.
  try {
    run = await reports.waitForRun(run);
    if (run.status !== "succeeded") {
      console.log(`${run.id} ${run.status}: ${run.error}`);
      process.exit(1);
    }
    const got = await reports.fetchFile(run);
    const path = writeReport(join(DATA, "reports"), got.run, got.bytes);
    runs.downloaded(run.id, path, got.run.result.id);
    console.log(`downloaded ${got.run.result.filename}, ${got.bytes.length} bytes, to ${path}`);
    const { summary, sample } = await summarizeFile(path, { sample: 3 });
    console.log(summary.replace(/^/gm, "  "));
    for (const r of sample) console.log("  " + JSON.stringify(r));
  } catch (err) {
    console.error(`${run.id}: ${[err.status, err.code ?? err.type, err.message].filter(Boolean).join(" ")}. The shop's sweep (npm start) picks it up.`);
    process.exit(1);
  }
} catch (err) {
  if (!(err instanceof ApiError)) throw err;
  // The API's error: its code says what to change (docs.novaro.ink/reports/get-reports-through-the-api/#errors).
  const what = {
    report_interval_invalid: "the period is outside the type's data, ends before it starts or is longer than 366 days: read the type again and change the end it names",
    report_runs_in_progress: "3 runs of this key, or 5 of the merchant's, are still being prepared: wait for one to end, then send it again",
    file_expired: "the file is past its expires_at: create a new run with the same parameters",
  }[err.code];
  console.error(`${[err.status, err.code ?? err.type, err.param && `(${err.param})`].filter(Boolean).join(" ")}: ${err.message}${what ? `\n  ${what}` : ""}${err.requestId ? `\n  X-Request-Id ${err.requestId}` : ""}`);
  process.exit(1);
}
