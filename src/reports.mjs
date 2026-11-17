// Reports through the API, from docs.novaro.ink/reports/get-reports-through-the-api,
// /api/report-types, /api/report-runs and /api/files alone. Node.js 20+, no packages.
//
//   const reports = reportsClient({ api, key, version });
//   const type = await reports.getType("payments.itemized.1");
//   let run = await reports.createRun({ report_type: type.id, parameters }, randomUUID());
//   run = await reports.waitForRun(run);              // or wait for the webhook
//   const { bytes } = await reports.fetchFile(run);   // a new run if the file expired
//   const path = writeReport("data/reports", run, bytes);
//   const { summary } = await summarizeFile(path);
//
// src/report.mjs is the command that does it; src/server.mjs downloads a
// report when its reporting.report_run.succeeded webhook comes.
import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// An error the API answered: { error: { type, code, message, param } }
// (docs.novaro.ink/api/errors), with the HTTP status and X-Request-Id.
export class ApiError extends Error {
  constructor(status, error = {}, requestId) {
    super(error.message ?? `HTTP ${status}`);
    Object.assign(this, { status, type: error.type, code: error.code, param: error.param, requestId });
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Worth sending again: nothing was made (rate limit, our side, a busy key).
const retryable = (status) => status === 409 || status === 429 || status >= 500;

// timeouts: how long an API call, and a file's download, may take before it
// counts as no answer (and is tried again).
export function reportsClient({ api, key, version, sleep = defaultSleep, log = () => {}, timeouts = { api: 30_000, file: 300_000 } }) {
  const base = api.replace(/\/$/, "");
  const headers = (extra = {}) => ({ Authorization: `Bearer ${key}`, "PSP-Version": version, ...extra });

  async function call(method, path, { body, idempotencyKey } = {}) {
    const h = headers(body ? { "Content-Type": "application/json" } : {});
    if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
    return fetch(base + path, { method, headers: h, body: body && JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeouts.api) });
  }
  async function asJson(res) {
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, json.error, res.headers.get("x-request-id"));
    return json;
  }
  // One GET. A 429, a 5xx or no answer is worth asking again: { retryIn }
  // is then at least the Retry-After the API asked for, in ms.
  async function once(path) {
    try {
      const res = await call("GET", path);
      if (res.status === 429 || res.status >= 500) return { res, retryIn: retryAfter(res) };
      return { res };
    } catch (err) {
      return { err, retryIn: 0 };
    }
  }

  // A read: asked again after a 429, a 5xx or no answer, waiting longer each time.
  async function read(path) {
    for (let attempt = 1, wait = 2000; ; attempt++, wait *= 2) {
      const a = await once(path);
      if (a.retryIn === undefined || attempt >= 5) {
        if (a.err) throw a.err;
        return asJson(a.res);
      }
      await sleep(Math.max(wait, a.retryIn));
    }
  }

  // Creates a run. One Idempotency-Key per report, the same on every retry:
  // a retry after a timeout answers the run the first request made, never a
  // second one. 409 report_runs_in_progress (3 of the key's runs, or 5 of
  // the merchant's, are being prepared), 429, 5xx and no answer made no run:
  // the same request a minute later makes it. Five times at most.
  async function createRun(body, idempotencyKey) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await call("POST", "/reporting/report_runs", { body, idempotencyKey });
      } catch (err) {
        if (attempt >= 5) throw err;
        log(`no answer (${err.message}); sending it again in a minute`);
        await sleep(60_000);
        continue;
      }
      if (res.ok || !retryable(res.status) || attempt >= 5) {
        const run = await asJson(res);
        if (res.headers.get("idempotent-replayed") === "true") log(`${run.id}: the run this key already made (Idempotent-Replayed)`);
        return run;
      }
      const e = await res.json().catch(() => ({}));
      log(`${res.status} ${e.error?.code ?? ""}: ${e.error?.message ?? ""} Sending it again in a minute (${attempt}/5).`);
      await sleep(60_000);
    }
  }

  // Reads the run until it is no longer pending: 2 s, then twice as long
  // each time, at most a minute apart (longer only when Retry-After asks),
  // for an hour at most. A 429, a 5xx or no answer: read it again later.
  async function waitForRun(run) {
    let waited = 0;
    let retryIn = 0;
    for (let wait = 2000; run.status === "pending"; wait = Math.min(wait * 2, 60_000)) {
      if (waited >= 3_600_000) throw new Error(`${run.id} is still pending after an hour`);
      const pause = Math.max(wait, retryIn);
      await sleep(pause);
      waited += pause;
      const a = await once(`/reporting/report_runs/${encodeURIComponent(run.id)}`);
      retryIn = a.retryIn ?? 0;
      if (a.retryIn !== undefined) continue;
      run = await asJson(a.res);
      log(`${run.id}: ${run.status}`);
    }
    return run;
  }

  // GET /files/{id}/contents with the key answers 302 to the file itself, a
  // link good for 60 seconds. The link is followed at once WITHOUT the key:
  // the key goes to the API's host alone. A Location that is a path is on
  // the API's host. A 429, a 5xx or no answer, from either: wait and ask
  // for a new link.
  async function download(file) {
    for (let attempt = 1, wait = 2000; ; attempt++, wait *= 2) {
      const a = await once(file.url);
      if (a.res?.status === 302) {
        const link = new URL(a.res.headers.get("location"), base + "/");
        let got;
        try {
          got = await fetch(link, { signal: AbortSignal.timeout(timeouts.file) }); // no Authorization header
          if (got.ok) return Buffer.from(await got.arrayBuffer());
        } catch (err) {
          if (attempt >= 5) throw err;
          got = undefined; // no answer, or it stopped: a new link
        }
        if (got && !(got.status === 429 || got.status >= 500)) throw new ApiError(got.status, { message: `the file link answered ${got.status}` });
        if (attempt >= 5) throw new ApiError(got.status, { message: `the file link answered ${got.status}` });
        await sleep(wait);
        continue;
      }
      if (a.retryIn !== undefined && attempt < 5) {
        await sleep(Math.max(wait, a.retryIn));
        continue;
      }
      if (a.err) throw a.err;
      await asJson(a.res); // throws the API's error: 400 file_expired, 404 resource_missing…
      throw new ApiError(a.res.status, { message: `expected a 302 from ${file.url}, got ${a.res.status}` });
    }
  }

  // The file of a succeeded run. Past its expires_at (400 file_expired) it
  // asks for the same report again: a new run with the run's report_type and
  // parameters, waits for it and downloads its file.
  async function fetchFile(run) {
    try {
      return { run, bytes: await download(run.result) };
    } catch (err) {
      if (err.code !== "file_expired") throw err;
      log(`${run.result.id} expired (${err.message}); asking for the same report again`);
      let again = await createRun(rerunOf(run), randomUUID());
      again = await waitForRun(again);
      if (again.status !== "succeeded") throw new Error(`${again.id} ${again.status}: ${again.error}`);
      return { run: again, bytes: await download(again.result) };
    }
  }

  return {
    // The types this key can ask for, with their columns and the period their data covers now.
    listTypes: () => read("/reporting/report_types"),
    getType: (id) => read(`/reporting/report_types/${encodeURIComponent(id)}`),
    getRun: (id) => read(`/reporting/report_runs/${encodeURIComponent(id)}`),
    createRun,
    waitForRun,
    download,
    fetchFile,
  };
}

const retryAfter = (res) => 1000 * (Number(res.headers.get("retry-after")) || 0);

// A month at midnight in the market's time zone, as the docs count one:
// October 2026 in India is 2026-10-01T00:00:00+05:30 up to, not including,
// 2026-11-01T00:00:00+05:30. offset is the zone's, "+05:30" in India.
export function monthInterval(month, offset) {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const at = (ym) => Date.parse(`${ym}-01T00:00:00${offset}`) / 1000;
  if (!Number.isFinite(at(month))) throw new Error(`not a month: ${month} (YYYY-MM)`);
  return { start: at(month), end: at(next) };
}

// The report file: UTF-8 with a byte order mark, RFC 4180 quoting, CRLF line
// ends, the header first (docs.novaro.ink/reports/#the-file). Values are kept
// as they are: an apostrophe before a value that began with = + - @ is the
// file's guard against spreadsheet formulas, not part of your data.
//
// A reader fed the text in pieces: a quoted field may hold a comma, a quote
// or a line break, and a piece may end anywhere, even inside one.
export function csvReader(onRecord) {
  let record = [];
  let field = "";
  let quoted = false;
  let quoteSeen = false; // a quote inside a quoted field: the end, or the first of ""
  let cr = false; // a \r outside quotes: a line end if \n follows
  let first = true;
  const endRecord = () => {
    record.push(field);
    onRecord(record);
    record = [];
    field = "";
  };
  return {
    push(text) {
      if (first && text.length) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        first = false;
      }
      for (const c of text) {
        if (quoteSeen) {
          quoteSeen = false;
          if (c === '"') {
            field += '"';
            continue;
          }
          quoted = false;
        }
        if (cr) {
          cr = false;
          if (c === "\n") {
            endRecord();
            continue;
          }
          field += "\r";
        }
        if (quoted) {
          if (c === '"') quoteSeen = true;
          else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ",") record.push(field), (field = "");
        else if (c === "\r") cr = true;
        else field += c;
      }
    },
    end() {
      if (cr) field += "\r";
      if (field !== "" || record.length) endRecord();
    },
  };
}

export function parseCsv(input) {
  const records = [];
  const reader = csvReader((r) => records.push(r));
  reader.push(Buffer.isBuffer(input) ? input.toString("utf8") : String(input));
  reader.end();
  const [header = [], ...lines] = records;
  return { header, rows: lines.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

// A short summary: rows by status, and the money columns summed per currency.
// Amounts are in major units with a dot ("4999.00"): summed as whole paise.
// It keeps the sums alone, not the rows: add() one row at a time.
const MONEY = ["amount_requested", "amount_payable", "amount_paid", "amount_credited", "fee_amount", "net_amount"];
export function summary(header) {
  const money = MONEY.filter((c) => header.includes(c));
  const by = {};
  const sums = {};
  let n = 0;
  return {
    add(r) {
      n++;
      if (header.includes("status")) by[r.status] = (by[r.status] ?? 0) + 1;
      const cur = r.currency || "?";
      for (const c of money) if (r[c] !== "") sums[`${cur} ${c}`] = (sums[`${cur} ${c}`] ?? 0n) + minor(r[c]);
    },
    text() {
      const lines = [`${n} rows`];
      if (n && header.includes("status")) lines.push("by status: " + Object.entries(by).map(([s, k]) => `${s}: ${k}`).join(", "));
      for (const [k, v] of Object.entries(sums)) lines.push(`${k} ${major(v)}`);
      return lines.join("\n");
    },
  };
}
export function summarize(header, rows) {
  const s = summary(header);
  for (const r of rows) s.add(r);
  return s.text();
}

// Sums up a saved report as it reads it, a piece at a time: the file is never
// in memory whole. sample: the first rows, to show.
export async function summarizeFile(path, { sample = 0, highWaterMark } = {}) {
  let header = null;
  let s = null;
  const rows = [];
  const reader = csvReader((r) => {
    if (!header) return void ((header = r), (s = summary(r)));
    const row = Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]));
    s.add(row);
    if (rows.length < sample) rows.push(row);
  });
  for await (const piece of createReadStream(path, { encoding: "utf8", highWaterMark })) reader.push(piece);
  reader.end();
  return { header: header ?? [], sample: rows, summary: (s ?? summary([])).text() };
}

function minor(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`not an amount: ${s}`);
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -v : v;
}
function major(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

// Keeps the file in dir under its own name (payments_<merchant>_<market>_<from>_<to>_<run id>.csv;
// only its last path part is used): written aside, then renamed, so a reader
// never sees half a file.
export function writeReport(dir, run, bytes) {
  const name = basename(run.result.filename || `${run.id}.csv`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  return path;
}

// The body that asks for a run's report again: its type and parameters,
// the defaults it was given left out.
export function rerunOf(run) {
  return { report_type: run.report_type, parameters: Object.fromEntries(Object.entries(run.parameters).filter(([, v]) => v != null)) };
}
