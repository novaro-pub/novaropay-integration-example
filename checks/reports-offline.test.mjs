// The reporting client (src/reports.mjs) against a fake API on localhost, for
// what a test key cannot make happen on demand: a file past its expires_at,
// a 409 that clears, a link on another host, a dropped connection; and the
// shop's handling of report runs (src/report-runs.mjs). Every answer is shaped as
// docs.novaro.ink/api/report-runs and /api/files show it. No key, no network:
//
//   npm test
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { reportRuns, sweepEvery } from "../src/report-runs.mjs";
import { ApiError, monthInterval, parseCsv, reportsClient, summarize, summarizeFile } from "../src/reports.mjs";

const KEY = "sk_test_in_offline_not_a_key";
const BOM = "﻿";
const CSV =
  BOM +
  "payment_id,merchant_reference,currency,status,amount_credited,fee_amount,net_amount\r\n" +
  'pay_1,"ord,1",INR,succeeded,499.00,12.48,486.52\r\n' +
  'pay_2,"say ""hi""\r\nthere",INR,succeeded,1000.00,25.00,975.00\r\n' +
  "pay_3,'-1042,INR,succeeded,0.50,,\r\n" +
  "pay_4,ऑर्डर-७७,INR,failed,,,\r\n"; // a reference in Devanagari: bytes of a letter may be split between two reads

let api, files; // two servers: the API, and the host the file link points at
let routes = {}; // "METHOD /path" -> [handler, …], one per call, the last repeats
const seen = []; // every request: { host, method, path, headers, body }
const sleeps = [];
const logs = [];
const drop = (q) => q.socket.destroy(); // no answer: the connection closes

function server(host) {
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const path = req.url.split("?")[0];
    seen.push({ host, method: req.method, path, headers: req.headers, body: body && JSON.parse(body) });
    const list = routes[`${req.method} ${path}`] ?? routes[`${host} ${req.method} ${path}`];
    if (!list) return json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such thing." } });
    const h = list.length > 1 ? list.shift() : list[0];
    h(req, res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const err = (code, message, param, type = "invalid_request_error") => ({ error: { type, code, message, ...(param ? { param } : {}) } });

const run = (status, extra = {}) => ({
  id: "frr_in_1",
  object: "reporting.report_run",
  report_type: "payments.itemized.1",
  status,
  parameters: { interval_start: 100, interval_end: 200, timezone: "Asia/Kolkata", columns: ["payment_id"], date_basis: "finalized", status: "succeeded", method: null, traffic_type: null, amount_min: null, amount_max: null },
  result: status === "succeeded" ? { id: "file_in_1", object: "file", purpose: "finance_report_run", type: "csv", filename: "payments_x.csv", size: CSV.length, expires_at: 9e9, url: "/files/file_in_1/contents" } : null,
  error: status === "failed" ? "The file is over 1.5 GB: choose a shorter period or fewer columns." : null,
  livemode: false,
  ...extra,
});

let client;
before(async () => {
  api = await server("api");
  files = await server("files");
  client = reportsClient({ api: base(api), key: KEY, version: "2026-11-14.acacia", sleep: async (ms) => void sleeps.push(ms), log: (m) => logs.push(m) });
});
after(() => {
  api.closeAllConnections(); // a request left hanging on purpose
  files.closeAllConnections();
  api.close();
  files.close();
});
const reset = (r) => {
  routes = r;
  seen.length = 0;
  sleeps.length = 0;
  logs.length = 0;
};

test("download: a relative Location is resolved against the API and followed without the key", async () => {
  reset({
    "api GET /files/file_in_1/contents": [(q, s) => (s.writeHead(302, { Location: "/files/file_in_1/download?sig=abc" }), s.end())],
    "api GET /files/file_in_1/download": [(q, s) => (s.writeHead(200, { "Content-Type": "text/csv" }), s.end(CSV))],
  });
  const bytes = await client.download(run("succeeded").result);
  assert.equal(bytes.toString(), CSV);
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0].headers["psp-version"], "2026-11-14.acacia");
  assert.equal(seen[1].path, "/files/file_in_1/download");
  assert.equal(seen[1].headers.authorization, undefined, "the key never goes to the link");
});

test("download: a full Location on another host gets no key", async () => {
  reset({
    "api GET /files/file_in_1/contents": [(q, s) => (s.writeHead(302, { Location: `${base(files)}/b/file.csv?X-Goog-Signature=1` }), s.end())],
    "files GET /b/file.csv": [(q, s) => (s.writeHead(200), s.end(CSV))],
  });
  await client.download(run("succeeded").result);
  assert.equal(seen[1].host, "files");
  assert.equal(seen[1].headers.authorization, undefined);
});

test("download: 400 file_expired is an ApiError with its code", async () => {
  reset({ "api GET /files/file_in_1/contents": [(q, s) => json(s, 400, err("file_expired", "The file expired."))] });
  await assert.rejects(client.download(run("succeeded").result), (e) => e instanceof ApiError && e.status === 400 && e.code === "file_expired");
});

test("fetchFile: an expired file makes a new run with the same type and parameters, then downloads its file", async () => {
  reset({
    "api GET /files/file_in_1/contents": [(q, s) => json(s, 400, err("file_expired", "The file expired."))],
    "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending", { id: "frr_in_2" }))],
    "api GET /reporting/report_runs/frr_in_2": [
      (q, s) => json(s, 200, run("succeeded", { id: "frr_in_2", result: { ...run("succeeded").result, id: "file_in_2", url: "/files/file_in_2/contents" } })),
    ],
    "api GET /files/file_in_2/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/2" }), s.end())],
    "api GET /dl/2": [(q, s) => (s.writeHead(200), s.end(CSV))],
  });
  const got = await client.fetchFile(run("succeeded"));
  assert.equal(got.run.id, "frr_in_2");
  assert.equal(got.bytes.toString(), CSV);
  const post = seen.find((r) => r.method === "POST");
  assert.equal(post.body.report_type, "payments.itemized.1");
  assert.deepEqual(post.body.parameters, { interval_start: 100, interval_end: 200, timezone: "Asia/Kolkata", columns: ["payment_id"], date_basis: "finalized", status: "succeeded" });
  assert.ok(post.headers["idempotency-key"]);
});

test("createRun: 409 report_runs_in_progress is sent again a minute later with the same Idempotency-Key", async () => {
  reset({
    "api POST /reporting/report_runs": [
      (q, s) => json(s, 409, err("report_runs_in_progress", "3 of your key's reports are still being prepared.")),
      (q, s) => json(s, 201, run("pending")),
    ],
  });
  const r = await client.createRun({ report_type: "payments.itemized.1", parameters: { interval_start: 100, interval_end: 200 } }, "key-1");
  assert.equal(r.id, "frr_in_1");
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(seen.map((x) => x.headers["idempotency-key"]), ["key-1", "key-1"]);
});

test("createRun: 409 five times gives up with the API's error", async () => {
  reset({ "api POST /reporting/report_runs": [(q, s) => json(s, 409, err("report_runs_in_progress", "busy"))] });
  await assert.rejects(client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "k"), (e) => e.code === "report_runs_in_progress" && e.status === 409);
  assert.equal(seen.length, 5);
});

test("createRun: report_interval_invalid is not retried, and names the end to change", async () => {
  reset({
    "api POST /reporting/report_runs": [(q, s) => json(s, 400, err("report_interval_invalid", "starts before your data", "parameters[interval_start]"))],
  });
  await assert.rejects(client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "k"), (e) => e.code === "report_interval_invalid" && e.param === "parameters[interval_start]");
  assert.equal(seen.length, 1);
  assert.deepEqual(sleeps, []);
});

test("waitForRun: 2 s, then twice as long, through a 429 and a 503", async () => {
  reset({
    "api GET /reporting/report_runs/frr_in_1": [
      (q, s) => json(s, 200, run("pending")),
      (q, s) => json(s, 429, err("rate_limit", "slow down", null, "rate_limit_error"), { "Retry-After": "1" }),
      (q, s) => json(s, 503, err("temporarily_unavailable", "try again", null, "api_error")),
      (q, s) => json(s, 200, run("succeeded")),
    ],
  });
  const r = await client.waitForRun(run("pending"));
  assert.equal(r.status, "succeeded");
  assert.deepEqual(sleeps, [2000, 4000, 8000, 16000]);
});

test("waitForRun: never more than a minute apart", async () => {
  const pending = Array.from({ length: 8 }, () => (q, s) => json(s, 200, run("pending")));
  reset({ "api GET /reporting/report_runs/frr_in_1": [...pending, (q, s) => json(s, 200, run("failed"))] });
  const r = await client.waitForRun(run("pending"));
  assert.equal(r.status, "failed");
  assert.deepEqual(sleeps, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
});

test("parseCsv: BOM, CRLF, quotes, a line break inside a field; the apostrophe stays", () => {
  const { header, rows } = parseCsv(Buffer.from(CSV));
  assert.equal(header[0], "payment_id", "no BOM in the first name");
  assert.equal(rows.length, 4);
  assert.equal(rows[3].merchant_reference, "ऑर्डर-७७");
  assert.equal(rows[0].merchant_reference, "ord,1");
  assert.equal(rows[1].merchant_reference, 'say "hi"\r\nthere');
  assert.equal(rows[2].merchant_reference, "'-1042");
  assert.equal(rows[2].fee_amount, "");
});

test("summarize: sums in paise, per currency and status, with no float drift", () => {
  const { header, rows } = parseCsv(Buffer.from(CSV));
  const s = summarize(header, rows);
  assert.match(s, /4 rows/);
  assert.match(s, /succeeded: 3, failed: 1/);
  assert.match(s, /INR amount_credited 1499\.50/);
  assert.match(s, /INR net_amount 1461\.52/);
});

test("monthInterval: a month at midnight in India, as the docs' October example", () => {
  assert.deepEqual(monthInterval("2026-10", "+05:30"), { start: 1790793000, end: 1793471400 });
});

test("createRun: a 5xx made no run, so it is sent again a minute later with the same key", async () => {
  reset({
    "api POST /reporting/report_runs": [
      (q, s) => json(s, 503, err("temporarily_unavailable", "try again", null, "api_error")),
      (q, s) => json(s, 201, run("pending")),
    ],
  });
  const r = await client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "key-5xx");
  assert.equal(r.id, "frr_in_1");
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(seen.map((x) => x.headers["idempotency-key"]), ["key-5xx", "key-5xx"]);
});

test("createRun: no answer is sent again a minute later with the same key", async () => {
  reset({ "api POST /reporting/report_runs": [drop, (q, s) => json(s, 201, run("pending"))] });
  const r = await client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "key-drop");
  assert.equal(r.id, "frr_in_1");
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(seen.length, 2);
});

test("createRun: a replay is told apart by Idempotent-Replayed", async () => {
  reset({ "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending"), { "Idempotent-Replayed": "true" })] });
  await client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "key-again");
  assert.ok(logs.some((m) => m.includes("Idempotent-Replayed")), logs.join("\n"));
  reset({ "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending"))] });
  await client.createRun({ report_type: "payments.itemized.1", parameters: {} }, "key-new");
  assert.ok(!logs.some((m) => m.includes("Idempotent-Replayed")), "a new run is no replay");
});

test("waitForRun: waits at least Retry-After, and through no answer", async () => {
  reset({
    "api GET /reporting/report_runs/frr_in_1": [
      (q, s) => json(s, 429, err("rate_limit", "slow down", null, "rate_limit_error"), { "Retry-After": "30" }),
      drop,
      (q, s) => json(s, 200, run("succeeded")),
    ],
  });
  const r = await client.waitForRun(run("pending"));
  assert.equal(r.status, "succeeded");
  assert.deepEqual(sleeps, [2000, 30_000, 8000]);
});

test("waitForRun: gives up after an hour", async () => {
  // Pending for 200 reads, far more than an hour's: without the cap it would end succeeded.
  const pending = Array.from({ length: 200 }, () => (q, s) => json(s, 200, run("pending")));
  reset({ "api GET /reporting/report_runs/frr_in_1": [...pending, (q, s) => json(s, 200, run("succeeded"))] });
  await assert.rejects(client.waitForRun(run("pending")), /after an hour/);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 3_602_000); // 2+4+…+32 s, then a minute at a time, until an hour has passed
  assert.equal(seen.length, sleeps.length);
});

test("download: a 5xx or no answer from the link asks for a new link", async () => {
  reset({
    "api GET /files/file_in_1/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/1" }), s.end())],
    "api GET /dl/1": [(q, s) => json(s, 503, {}), drop, (q, s) => (s.writeHead(200), s.end(CSV))],
  });
  const bytes = await client.download(run("succeeded").result);
  assert.equal(bytes.toString(), CSV);
  assert.equal(seen.filter((r) => r.path === "/files/file_in_1/contents").length, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test("fetchFile: destructured, it still asks for an expired report again", async () => {
  reset({
    "api GET /files/file_in_1/contents": [(q, s) => json(s, 400, err("file_expired", "The file expired."))],
    "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("succeeded", { id: "frr_in_3", result: { ...run("succeeded").result, url: "/files/file_in_3/contents" } }))],
    "api GET /files/file_in_3/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/3" }), s.end())],
    "api GET /dl/3": [(q, s) => (s.writeHead(200), s.end(CSV))],
  });
  const { fetchFile } = client;
  assert.equal((await fetchFile(run("succeeded"))).run.id, "frr_in_3");
});

test("summarizeFile: read in pieces of any size, a quote, a CRLF or a letter split between two", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "report-")), "r.csv");
  writeFileSync(path, CSV);
  const whole = summarize(...Object.values(parseCsv(Buffer.from(CSV))));
  for (const highWaterMark of [1, 2, 3, 5, 7, 64]) {
    const got = await summarizeFile(path, { sample: 4, highWaterMark });
    assert.equal(got.summary, whole, `pieces of ${highWaterMark}`);
    assert.equal(got.header[0], "payment_id");
    assert.equal(got.sample[1].merchant_reference, 'say "hi"\r\nthere', `pieces of ${highWaterMark}`);
    assert.equal(got.sample[3].merchant_reference, "ऑर्डर-७७", `pieces of ${highWaterMark}`);
  }
});

// ---- The shop's report runs: src/report-runs.mjs, as src/server.mjs uses it ----
let clock = 1_000_000_000_000;
function shop() {
  const dir = mkdtempSync(join(tmpdir(), "report-runs-"));
  const runs = reportRuns({ reports: client, dir, log: (m) => logs.push(m), now: () => clock });
  const state = (id) => (existsSync(join(dir, "runs", `${id}.json`)) ? JSON.parse(readFileSync(join(dir, "runs", `${id}.json`), "utf8")) : null);
  const write = (id, st) => writeFileSync(join(dir, "runs", `${id}.json`), JSON.stringify({ id, ...st }));
  return { dir, runs, state, write };
}
// The API: the run as GET /reporting/report_runs/frr_in_1 answers it, and its file.
const api1 = (status, more = {}) => ({
  "api GET /reporting/report_runs/frr_in_1": [(q, s) => json(s, 200, run(status))],
  "api GET /files/file_in_1/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/1" }), s.end())],
  "api GET /dl/1": [(q, s) => (s.writeHead(200), s.end(CSV))],
  ...more,
});
const reads = () => seen.filter((r) => r.path === "/reporting/report_runs/frr_in_1").length;
const downloads = () => seen.filter((r) => r.path === "/dl/1").length;
const gone = { "api GET /files/file_in_1/contents": [(q, s) => json(s, 404, err("resource_missing", "No such file.", "id"))] };
const expired = { "api GET /files/file_in_1/contents": [(q, s) => json(s, 400, err("file_expired", "The file expired."))] };

test("shop: only the runs it kept; other ids are left alone", async () => {
  reset(api1("succeeded"));
  const { runs, write } = shop();
  assert.equal(runs.kept("frr_in_1"), false);
  assert.equal(runs.kept("../escaped"), false);
  await runs.sweep();
  assert.equal(seen.length, 0);
  write("frr_in_1", { state: "created" });
  assert.equal(runs.kept("frr_in_1"), true);
});

test("shop: a sweep leaves a pending run, downloads a succeeded one, and reads a final one no more", async () => {
  const { runs, state, dir } = shop();
  runs.record(run("pending"));
  reset(api1("pending"));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "created");
  reset(api1("succeeded"));
  await runs.sweep();
  const s = state("frr_in_1");
  assert.equal(s.state, "downloaded");
  assert.equal(readFileSync(s.path, "utf8"), CSV);
  assert.ok(s.path.startsWith(join(dir, "reports")));
  assert.ok(logs.some((m) => m.includes("4 rows")));
  seen.length = 0;
  await runs.sweep();
  assert.equal(seen.length, 0);
});

test("shop: a run the API says failed is recorded failed", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("failed"));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "failed");
  assert.equal(downloads(), 0);
});

test("shop: an event during a sweep is not lost: one more sweep runs after it", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  let release;
  const held = new Promise((r) => (release = r));
  reset(api1("succeeded", {
    "api GET /reporting/report_runs/frr_in_1": [
      async (q, s) => (await held, json(s, 200, run("pending"))), // the sweep reads it pending…
      (q, s) => json(s, 200, run("succeeded")),
    ],
  }));
  const loop = runs.loop({ every: 3_600_000, setInterval: () => null });
  while (reads() === 0) await new Promise((r) => setTimeout(r, 5));
  loop.kick(); // …while its webhook comes
  release();
  await loop.idle();
  assert.equal(state("frr_in_1").state, "downloaded");
  assert.equal(reads(), 2);
});

test("shop: a sweep where writing the state fails logs it and does not throw", async () => {
  const { runs, dir, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("succeeded"));
  chmodSync(join(dir, "runs"), 0o500); // read only: every put() throws
  try {
    await runs.sweep();
    await runs.loop({ every: 3_600_000, setInterval: () => null }).idle();
  } finally {
    chmodSync(join(dir, "runs"), 0o700);
  }
  assert.ok(logs.some((m) => m.includes("could not be settled")), logs.join("\n"));
});

test("shop: a failed download waits for next_try_at, doubling, then is given up", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("succeeded", gone));
  const gaps = [];
  for (let i = 0; i < 20 && state("frr_in_1").state === "created"; i++) {
    const before = reads();
    await runs.sweep();
    assert.equal(reads(), before + 1, "read once a sweep when due");
    const next = state("frr_in_1").next_try_at;
    if (state("frr_in_1").state !== "created") break;
    gaps.push((next - clock) / 1000);
    clock = next - 1; // a sweep just before it: skipped
    await runs.sweep();
    assert.equal(reads(), before + 1, "not before next_try_at");
    clock = next;
  }
  assert.deepEqual(gaps, [60, 120, 240, 480, 960, 1920, 3840]);
  assert.equal(state("frr_in_1").state, "gave_up");
  assert.equal(state("frr_in_1").attempts, 8);
  assert.ok(logs.some((m) => m.includes("GET /reporting/report_runs/frr_in_1")));
});

test("shop: an expired file is asked for again once, and the new run is kept and swept", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  const file2 = { ...run("succeeded").result, id: "file_in_2", url: "/files/file_in_2/contents" };
  reset(api1("succeeded", {
    ...expired,
    "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending", { id: "frr_in_2" }))],
    "api GET /reporting/report_runs/frr_in_2": [(q, s) => json(s, 200, run("succeeded", { id: "frr_in_2", result: file2 }))],
    "api GET /files/file_in_2/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/2" }), s.end())],
    "api GET /dl/2": [(q, s) => (s.writeHead(200), s.end(CSV))],
  }));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "expired");
  assert.equal(state("frr_in_1").replaced_by, "frr_in_2");
  assert.equal(state("frr_in_2").generation, 1);
  await runs.sweep();
  assert.equal(state("frr_in_2").state, "downloaded");
  assert.deepEqual(seen.find((r) => r.method === "POST").body.parameters, { interval_start: 100, interval_end: 200, timezone: "Asia/Kolkata", columns: ["payment_id"], date_basis: "finalized", status: "succeeded" });
});

test("shop: a rerun whose file expires too is given up, not asked for again", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created", generation: 1 });
  reset(api1("succeeded", { ...expired, "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending", { id: "frr_in_3" }))] }));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "gave_up");
  assert.ok(!seen.some((r) => r.method === "POST"));
});

test("shop: the rerun's Idempotency-Key is kept and sent again after a lost answer", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("succeeded", { ...expired, "api POST /reporting/report_runs": [drop] })); // no answer, every time
  await runs.sweep();
  const key = state("frr_in_1").rerun_key;
  assert.ok(key);
  assert.equal(state("frr_in_1").state, "created");
  clock = state("frr_in_1").next_try_at;
  reset(api1("succeeded", { ...expired, "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending", { id: "frr_in_2" }), { "Idempotent-Replayed": "true" })] }));
  await runs.sweep();
  assert.equal(state("frr_in_1").replaced_by, "frr_in_2");
  assert.deepEqual([...new Set(seen.filter((r) => r.method === "POST").map((r) => r.headers["idempotency-key"]))], [key]);
});

test("shop: downloaded is kept when the summary fails", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("succeeded", { "api GET /dl/1": [(q, s) => (s.writeHead(200), s.end("currency,amount_credited\r\nINR,abc\r\n"))] }));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "downloaded");
  assert.equal(state("frr_in_1").next_try_at, undefined);
  assert.ok(logs.some((m) => m.includes("summary failed")), logs.join("\n"));
});

test("shop: a state file that does not parse is moved aside; one it cannot read, and stray files, are skipped", async () => {
  const { dir, runs, state } = shop();
  const runsDir = join(dir, "runs");
  writeFileSync(join(runsDir, "frr_in_9.json"), '{"id":"frr_in_9","sta'); // half written
  mkdirSync(join(runsDir, "frr_in_6.json")); // not a file: cannot be read
  writeFileSync(join(runsDir, ".DS_Store"), Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]));
  writeFileSync(join(runsDir, "frr_in_8.json.123.abc.tmp"), "{");
  writeFileSync(join(runsDir, "frr_in_1.json"), JSON.stringify({ id: "frr_in_1", state: "created" }));
  reset(api1("succeeded"));
  await runs.sweep();
  const names = readdirSync(runsDir);
  assert.ok(!names.includes("frr_in_9.json") && names.some((n) => n.startsWith("frr_in_9.json.bad-")), names.join(","));
  assert.ok(names.includes("frr_in_6.json"), "an unreadable one is not moved");
  assert.ok(names.includes(".DS_Store") && names.includes("frr_in_8.json.123.abc.tmp"));
  assert.equal(state("frr_in_1").state, "downloaded", "the good one is settled");
  assert.ok(!seen.some((r) => /frr_in_[6-9]/.test(r.path)), "a state it could not read is not asked about");
  assert.ok(logs.some((m) => m.includes("does not parse")) && logs.some((m) => m.includes("cannot read")));
});

test("shop: states are written aside and renamed; an id that is no run id is refused", () => {
  const { dir, runs } = shop();
  runs.record(run("pending"));
  assert.deepEqual(readdirSync(join(dir, "runs")), ["frr_in_1.json"]);
  assert.throws(() => runs.record({ ...run("pending"), id: "../escaped" }), /not a report run id/);
  assert.ok(!existsSync(join(dir, "escaped.json")));
});

// ---- npm run report, run as a process ----
function cli(data, ...args) {
  return new Promise((resolve) =>
    execFile(process.execPath, ["src/report.mjs", "--status", "all", ...args], { env: { ...process.env, NOVARO_API_KEY: KEY, NOVARO_API_BASE: base(api), NOVARO_DATA_DIR: data } }, (e, stdout, stderr) =>
      resolve({ code: e ? e.code : 0, out: stdout + stderr }),
    ),
  );
}
const TYPE = { id: "payments.itemized.1", object: "reporting.report_type", columns: ["payment_id", "status"], data_available_start: 100, data_available_end: 200, livemode: false };
const typeRoutes = {
  "api GET /reporting/report_types": [(q, s) => json(s, 200, { object: "list", data: [TYPE], has_more: false })],
  "api GET /reporting/report_types/payments.itemized.1": [(q, s) => json(s, 200, TYPE)],
  "api POST /reporting/report_runs": [(q, s) => json(s, 201, run("pending", { data_as_of: 200 }))],
};
const cliState = (data) => JSON.parse(readFileSync(join(data, "report-runs", "runs", "frr_in_1.json"), "utf8"));

test("npm run report -- --wait webhook: keeps the id for the shop and stops", async () => {
  const data = mkdtempSync(join(tmpdir(), "report-cli-"));
  reset({ ...typeRoutes, ...api1("succeeded") });
  const { code, out } = await cli(data, "--wait", "webhook");
  assert.equal(code, 0, out);
  assert.match(out, /the shop \(npm start\) downloads it/);
  assert.equal(cliState(data).state, "created");
  assert.equal(reads(), 0);
});

test("npm run report: downloads, and marks the kept run downloaded", async () => {
  const data = mkdtempSync(join(tmpdir(), "report-cli-"));
  reset({ ...typeRoutes, ...api1("succeeded") });
  const { code, out } = await cli(data);
  assert.equal(code, 0, out);
  const s = cliState(data);
  assert.equal(s.state, "downloaded");
  assert.equal(readFileSync(s.path, "utf8"), CSV);
});

test("npm run report: a failed download is left to the shop's sweep, exit 1", async () => {
  const data = mkdtempSync(join(tmpdir(), "report-cli-"));
  reset({ ...typeRoutes, ...api1("succeeded", gone) });
  const { code, out } = await cli(data);
  assert.equal(code, 1, out);
  assert.match(out, /The shop's sweep \(npm start\) picks it up/);
  assert.equal(cliState(data).state, "created");
});

test("timeouts: an API call or a file that does not answer in time is no answer, and is tried again", async () => {
  const quick = reportsClient({ api: base(api), key: KEY, version: "2026-11-14.acacia", sleep: async (ms) => void sleeps.push(ms), timeouts: { api: 200, file: 200 } });
  const hang = () => {}; // never answers
  reset({
    "api GET /reporting/report_runs/frr_in_1": [hang, (q, s) => json(s, 200, run("succeeded"))],
    "api GET /files/file_in_1/contents": [(q, s) => (s.writeHead(302, { Location: "/dl/1" }), s.end())],
    "api GET /dl/1": [(q, s) => (s.writeHead(200), s.write(CSV.slice(0, 10))), (q, s) => (s.writeHead(200), s.end(CSV))], // the first stops half way
  });
  // Without a timeout these would wait for ever: fail after 3 s instead.
  const within = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("still waiting: no timeout")), 3000).unref())]);
  assert.equal((await within(quick.getRun("frr_in_1"))).status, "succeeded");
  assert.equal((await within(quick.download(run("succeeded").result))).toString(), CSV);
  assert.equal(seen.filter((r) => r.path === "/files/file_in_1/contents").length, 2, "a new link after the stalled one");
});

test("sweepEvery: REPORTS_SWEEP_MS only from a minute to 2^31-1 ms, else the default, logged", () => {
  const said = [];
  const log = (m) => said.push(m);
  assert.equal(sweepEvery(undefined, log), 300_000);
  assert.equal(sweepEvery("60000", log), 60_000);
  assert.equal(sweepEvery(String(2 ** 31 - 1), log), 2 ** 31 - 1);
  assert.equal(said.length, 0);
  for (const bad of ["59999", "20000", String(2 ** 31), "abc", "Infinity", "-1", "60000.5"]) assert.equal(sweepEvery(bad, log), 300_000, bad);
  assert.equal(said.length, 7);
});

test("shop: an API outage longer than 2 hours is not counted, and does not make it give up", async () => {
  const { runs, state, write } = shop();
  write("frr_in_1", { state: "created" });
  reset(api1("succeeded", { "api GET /reporting/report_runs/frr_in_1": [(q, s) => json(s, 503, err("temporarily_unavailable", "down", null, "api_error"))] }));
  for (let i = 0; i < 36; i++, clock += 300_000) await runs.sweep(); // 3 hours of sweeps
  assert.equal(state("frr_in_1").state, "created");
  assert.equal(state("frr_in_1").attempts, undefined);
  reset(api1("succeeded"));
  await runs.sweep();
  assert.equal(state("frr_in_1").state, "downloaded");
});

test("shop: at start, temporary files older than an hour are removed, younger ones kept", () => {
  clock = Date.now();
  const { dir, runs } = shop();
  mkdirSync(join(dir, "reports"), { recursive: true });
  const old = new Date(Date.now() - 2 * 3_600_000);
  const files = { stale: join(dir, "runs", "frr_in_1.json.1.a.tmp"), staleCsv: join(dir, "reports", "r.csv.1.b.tmp"), young: join(dir, "runs", "frr_in_2.json.2.c.tmp"), kept: join(dir, "runs", "frr_in_3.json") };
  for (const f of Object.values(files)) writeFileSync(f, "{}");
  utimesSync(files.stale, old, old);
  utimesSync(files.staleCsv, old, old);
  utimesSync(files.kept, old, old);
  runs.cleanup();
  assert.ok(!existsSync(files.stale) && !existsSync(files.staleCsv));
  assert.ok(existsSync(files.young) && existsSync(files.kept));
});

test("npm run report: a data folder it cannot write makes no run", async () => {
  const data = mkdtempSync(join(tmpdir(), "report-cli-"));
  mkdirSync(join(data, "report-runs", "runs"), { recursive: true });
  chmodSync(join(data, "report-runs", "runs"), 0o500);
  reset({ ...typeRoutes, ...api1("succeeded") });
  try {
    const { code, out } = await cli(data);
    assert.notEqual(code, 0, out);
  } finally {
    chmodSync(join(data, "report-runs", "runs"), 0o700);
  }
  assert.ok(!seen.some((r) => r.method === "POST"), "no run made");
});

test("npm run report: an error with a type and no code prints the type", async () => {
  const data = mkdtempSync(join(tmpdir(), "report-cli-"));
  reset({ ...typeRoutes, "api POST /reporting/report_runs": [(q, s) => json(s, 400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters." } })] });
  const { code, out } = await cli(data);
  assert.equal(code, 1, out);
  assert.match(out, /400 idempotency_error: Keys for idempotent/);
});
