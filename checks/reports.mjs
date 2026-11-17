// Checks the Reporting API against docs.novaro.ink/api/report-types,
// /api/report-runs, /api/files and /reports/get-reports-through-the-api, with
// the key in .env (a test key: it makes a few test report runs). Prints each
// case, what the docs say, and what came back.
//
//   node --env-file=.env checks/reports.mjs
//
// A file past its expires_at (400 file_expired) cannot be made on demand: it
// is 7 days after the run. checks/reports-offline.test.mjs covers it.
import { randomUUID } from "node:crypto";

const API = (process.env.NOVARO_API_BASE ?? "https://api.novaro.ink").replace(/\/$/, "");
const KEY = process.env.NOVARO_API_KEY;
if (!KEY?.startsWith("sk_test_")) throw new Error("NOVARO_API_KEY must be a test secret key, sk_test_…: this check makes report runs");
const VERSION = process.env.NOVARO_API_VERSION ?? "2026-11-14.acacia";
const TYPE = "payments.itemized.1";

async function call(method, path, { body, key = KEY, idem } = {}) {
  const headers = { Authorization: `Bearer ${key}`, "PSP-Version": VERSION };
  if (body) headers["Content-Type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body), redirect: "manual" });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, json };
}
function show(label, r) {
  const e = r.json.error;
  const got = e ? [e.type, e.code, e.param].filter(Boolean).join(" ") : r.json.id ?? r.json.object ?? "";
  const replayed = r.headers.get("idempotent-replayed");
  console.log(`${label.padEnd(66)} ${r.status} ${got}${replayed ? ` replayed=${replayed}` : ""}`);
  return r;
}
const run = (parameters) => ({ report_type: TYPE, parameters });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== Report types");
const list = show("1. list: the types this key can ask for", await call("GET", "/reporting/report_types"));
console.log(`   ${list.json.data?.map((t) => t.id).join(", ")} livemode=${list.json.data?.[0]?.livemode}`);
const type = show(`2. ${TYPE}: its columns and data_available_*`, await call("GET", `/reporting/report_types/${TYPE}`)).json;
show("3. a type that does not exist: 404 resource_missing id", await call("GET", "/reporting/report_types/nope.itemized.1"));
if (type.data_available_start == null) {
  console.log("   no payment on this account yet: make test payments with the magic UTRs, then run this again");
  process.exit(1);
}
const start = Math.max(type.data_available_start, type.data_available_end - 86400);
const end = type.data_available_end;

console.log("== Creating a run: refused, nothing made");
show("4. starts before data_available_start: 400 report_interval_invalid", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: type.data_available_start - 86400, interval_end: end }) }));
show("5. ends after data_available_end: 400 report_interval_invalid", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: start, interval_end: end + 3600 }) }));
show("6. ends before it starts: 400 report_interval_invalid", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: end, interval_end: start }) }));
show("7. a column the type has not: 400 parameter_invalid parameters[columns]", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: start, interval_end: end, columns: ["payment_id", "nope"] }) }));
show("8. a parameter it does not take: 400 parameter_unknown", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: start, interval_end: end, foo: 1 }) }));
show("9. a status that is not final with date_basis finalized: 400", await call("POST", "/reporting/report_runs", { idem: randomUUID(), body: run({ interval_start: start, interval_end: end, status: "processing" }) }));

console.log("== Idempotency-Key");
const K = randomUUID();
const body = run({ interval_start: start, interval_end: end, columns: ["payment_id", "status", "amount_credited"], status: "succeeded" });
const first = show("10. first request: 201", await call("POST", "/reporting/report_runs", { idem: K, body }));
const again = show("11. same key, same body: the same run, Idempotent-Replayed true", await call("POST", "/reporting/report_runs", { idem: K, body }));
console.log(`   same run: ${first.json.id === again.json.id ? "yes" : "NO"}`);
show("12. same key, another body: 400 idempotency_error", await call("POST", "/reporting/report_runs", { idem: K, body: run({ interval_start: start, interval_end: end }) }));

console.log("== Too many at once");
const burst = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/reporting/report_runs", { idem: randomUUID(), body })));
const n = (s) => burst.filter((r) => r.status === s).length;
console.log(`13. 6 at once: at most 3 of a key's are prepared together, the rest 409 report_runs_in_progress`);
console.log(`   201: ${n(201)}, 409: ${n(409)} (${[...new Set(burst.filter((r) => r.status === 409).map((r) => r.json.error?.code))].join(", ")}), other: ${burst.length - n(201) - n(409)}`);
if (n(409) === 0) console.log("   no 409: the runs ended before the next one came, which a short period on a small account does");
if (n(201) > 3) console.log("   more than 3 made: a run of this key ended while they were being sent, which frees its place");

console.log("== The file");
let r = first.json;
for (let wait = 2000; r.status === "pending"; wait = Math.min(wait * 2, 60_000)) {
  await sleep(wait);
  r = (await call("GET", `/reporting/report_runs/${r.id}`)).json;
}
console.log(`14. ${r.id} ended ${r.status}; result.url ${r.result?.url}, expires_at - succeeded_at = ${r.result ? (r.result.expires_at - r.succeeded_at) / 86400 : "-"} days`);
if (r.status === "succeeded") {
  const c = show("15. GET result.url with the key: 302 to the file", await call("GET", r.result.url));
  const loc = c.headers.get("location");
  if (loc) {
    const link = new URL(loc, API + "/");
    const f = await fetch(link); // without the key, as the docs say
    const bytes = Buffer.from(await f.arrayBuffer());
    console.log(`16. the link, without the key: 200, the CSV`.padEnd(67) + ` ${f.status} ${f.headers.get("content-type")} ${bytes.length} bytes (result.size ${r.result.size})`);
    if (f.ok) {
      const t = bytes.toString("utf8");
      console.log(`   BOM ${t.charCodeAt(0) === 0xfeff ? "yes" : "NO"}, CRLF lines ${t.split("\r\n").length - 1}, bare LF ${t.split("\n").length - t.split("\r\n").length}, header ${JSON.stringify(t.slice(1, t.indexOf("\r\n")))}`);
    }
    console.log(`   Location is ${loc.startsWith("/") ? "a path on the API's host" : `on ${link.host}`}`);
  }
}
show("17. a file that does not exist: 404 resource_missing", await call("GET", "/files/file_in_nope/contents"));
show("18. a run that does not exist: 404 resource_missing", await call("GET", "/reporting/report_runs/frr_in_nope"));
show("19. a wrong key: 401", await call("GET", "/reporting/report_types", { key: "sk_test_in_wrong" }));
console.log("20. file_expired: 7 days after a run, not made on demand; see checks/reports-offline.test.mjs");
