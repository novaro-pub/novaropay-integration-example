// The shop's own report runs (REPORTS.md). The shop keeps the id of every run
// npm run report created, in data/report-runs/runs/<id>.json, and SWEEPS them:
// at start, then every REPORTS_SWEEP_MS (5 minutes), and soon after a
// reporting.report_run.* webhook for one of them. A sweep settles each kept
// run that is not final, one after another: it reads the run,
// GET /reporting/report_runs/{id}, and does what the API says:
//
//   pending                 leave it for the next sweep
//   succeeded               download its file
//   failed                  record it failed
//   its file has expired    ask for the same report again, once, and keep the new run
//
// A run the API could not be asked about (no answer, 5xx) is asked again at
// the next sweep, however long that lasts: it is not counted. A download or a
// rerun that fails after a good answer is counted, and tried at a later sweep
// after 1 minute, then twice as long each time; after 8 of those the run is
// given up. A run the shop did not
// create has no file and is left alone. Nothing here throws out of a sweep:
// a run that cannot be settled is logged, and the shop keeps taking payments.
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rerunOf, summarizeFile, writeReport } from "./reports.mjs";

// Where the shop and npm run report keep their files: NOVARO_DATA_DIR, or data/.
export const dataDir = () => (process.env.NOVARO_DATA_DIR ? resolve(process.env.NOVARO_DATA_DIR) : fileURLToPath(new URL("../data", import.meta.url)));

const RUN_ID = /^frr_[A-Za-z0-9_]+$/;
const FINAL = new Set(["downloaded", "failed", "expired", "gave_up"]);
const FIRST_RETRY = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_RERUNS = 1; // a rerun's file expiring too is given up, not chased
const SWEEP_DEFAULT = 300_000;

// The sweep's interval from REPORTS_SWEEP_MS: a whole number of ms from a
// minute up to what a timer takes (2^31-1); anything else is the default.
export function sweepEvery(value, log = console.log) {
  if (value === undefined || value === "") return SWEEP_DEFAULT;
  const ms = Number(value);
  if (Number.isInteger(ms) && ms >= 60_000 && ms <= 2 ** 31 - 1) return ms;
  log(`REPORTS_SWEEP_MS=${value} is not between 60000 and ${2 ** 31 - 1}; sweeping every ${SWEEP_DEFAULT} ms`);
  return SWEEP_DEFAULT;
}

export function reportRuns({ reports, dir, reportsDir = join(dir, "reports"), log = console.log, now = Date.now }) {
  const runsDir = join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const file = (id) => {
    if (!RUN_ID.test(id ?? "")) throw new Error(`not a report run id: ${id}`);
    return join(runsDir, `${id}.json`);
  };
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if (!(err instanceof SyntaxError)) return log(`report runs: cannot read ${path} (${err.message}); skipped`), null;
      const aside = `${path}.bad-${Date.now()}`;
      renameSync(path, aside);
      return log(`report runs: ${path} does not parse (${err.message}); moved to ${aside}`), null;
    }
  };
  const get = (id) => (existsSync(file(id)) ? read(file(id)) : null);
  const put = (id, fields) => {
    const tmp = `${file(id)}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...get(id), id, ...fields, at: new Date(now()).toISOString() }, null, 2));
    renameSync(tmp, file(id));
  };

  async function settle(id) {
    const state = get(id);
    if (!state || FINAL.has(state.state) || now() < (state.next_try_at ?? 0)) return;
    let run;
    try {
      run = await reports.getRun(id);
    } catch (err) {
      return log(`report ${id}: the API did not answer (${err.status ?? err.message}); the next sweep asks again`);
    }
    try {
      if (run.status === "pending") return;
      if (run.status === "failed") return put(id, { state: "failed", error: run.error }), log(`report ${id} failed: ${run.error}`);
      const path = writeReport(reportsDir, run, await reports.download(run.result));
      put(id, { state: "downloaded", path, file: run.result.id });
      await summarizeFile(path).then(
        ({ summary }) => log(`report ${id} downloaded to ${path}\n${summary.replace(/^/gm, "  ")}`),
        (err) => log(`report ${id} downloaded to ${path}; its summary failed: ${err.message}`),
      );
    } catch (err) {
      if (err.code === "file_expired") return askAgain(id, run, state);
      later(id, state, err);
    }
  }

  // The file expired before it was downloaded: the same report again, with an
  // Idempotency-Key kept in the run's state before it is sent, so a retry
  // after a lost answer gets the same new run. Once per chain.
  async function askAgain(id, run, state) {
    if ((state.generation ?? 0) >= MAX_RERUNS) {
      put(id, { state: "gave_up", error: "its file expired, and it was already asked for again once" });
      return log(`report ${id}: its file expired again; given up. Create a new run.`);
    }
    const key = state.rerun_key ?? randomUUID();
    if (!state.rerun_key) put(id, { rerun_key: key });
    try {
      const again = await reports.createRun(rerunOf(run), key);
      put(again.id, { state: "created", created: again.created, replaces: id, generation: (state.generation ?? 0) + 1 });
      put(id, { state: "expired", replaced_by: again.id });
      log(`report ${id}: its file expired; asked for it again as ${again.id}`);
    } catch (err) {
      later(id, { ...state, rerun_key: key }, err);
    }
  }

  function later(id, state, err) {
    const attempts = (state.attempts ?? 0) + 1;
    const error = [err.status, err.code, err.message].filter(Boolean).join(" ");
    if (attempts >= MAX_ATTEMPTS) {
      put(id, { state: "gave_up", attempts, error });
      return log(`report ${id}: failed ${attempts} times (${error}); given up. Redo it: GET /reporting/report_runs/${id}, then its result.url.`);
    }
    const next = now() + FIRST_RETRY * 2 ** (attempts - 1);
    put(id, { attempts, error, next_try_at: next });
    log(`report ${id}: ${error}; a sweep tries it again after ${new Date(next).toISOString()}`);
  }

  // Every kept run that is not final, one after another. Never throws.
  async function sweep() {
    try {
      for (const name of readdirSync(runsDir)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!RUN_ID.test(id)) continue;
        try {
          await settle(id);
        } catch (err) {
          log(`report ${id}: could not be settled (${err.message}); the next sweep tries again`);
        }
      }
    } catch (err) {
      log(`report runs: the sweep failed (${err.message})`);
    }
  }

  // Temporary files older than an hour: left by a stop in the middle of a
  // write. Younger ones may be another process's write in progress.
  function cleanup() {
    for (const d of [runsDir, reportsDir]) {
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        const path = join(d, name);
        try {
          if (name.endsWith(".tmp") && now() - statSync(path).mtimeMs > 3_600_000) rmSync(path), log(`report runs: removed ${path}, left by a stop`);
        } catch (err) {
          log(`report runs: could not remove ${path} (${err.message})`);
        }
      }
    }
  }

  return {
    sweep,
    cleanup,
    // Throws when the folder of kept runs cannot be written: check it before a run is made.
    writable: () => accessSync(runsDir, constants.W_OK),
    state: get,
    record: (run) => put(run.id, { state: "created", created: run.created }),
    downloaded: (id, path, fileId) => put(id, { state: "downloaded", path, file: fileId }),
    kept: (id) => RUN_ID.test(id ?? "") && get(id) !== null,
    // The shop's loop: a sweep now, then every `every` ms; kick() asks for one
    // soon. One sweep at a time: a kick during a sweep runs one more after it.
    loop({ every, setInterval: tick = setInterval }) {
      let running = null;
      let again = false;
      const kick = () => {
        if (running) return void (again = true);
        running = (async () => {
          do {
            again = false;
            await sweep();
          } while (again);
          running = null;
        })();
      };
      const timer = tick(kick, every);
      timer?.unref?.();
      kick();
      return { kick, idle: () => running ?? Promise.resolve(), stop: () => clearInterval(timer) };
    },
  };
}
