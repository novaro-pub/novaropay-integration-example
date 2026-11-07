// A merchant's server integrated with NovaroPay from docs.novaro.ink alone:
// a shop page, POST /payments with the hosted page, the payer's way back,
// and a webhook handler that checks PSP-Signature. Node.js 20+, no packages.
//
//   node --env-file=.env src/server.mjs
//
// Settings (environment, see .env.example):
//   NOVARO_API_KEY         sk_test_in_… while you build, sk_live_in_… in production
//   NOVARO_WEBHOOK_SECRET  whsec_… of your endpoint, or the one `novaro listen` prints;
//                          several, comma-separated, when more than one endpoint or
//                          novaro listen sends here (each has its own secret)
//   NOVARO_API_VERSION     the PSP-Version this code was written for
//   PUBLIC_URL             where payers reach this server (https), for return_url
//   PORT                   default 3000
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { verify } from "./verify.mjs";

const API = process.env.NOVARO_API_BASE ?? "https://api.novaro.ink";
const KEY = must("NOVARO_API_KEY");
const SECRETS = must("NOVARO_WEBHOOK_SECRET").split(",").map((s) => s.trim()).filter(Boolean);
const VERSION = process.env.NOVARO_API_VERSION ?? "2026-11-04.acacia";
const PUBLIC_URL = must("PUBLIC_URL").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
const DATA = new URL("../data/", import.meta.url);
mkdirSync(DATA, { recursive: true });

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

// ---- Storage: a JSON file is enough for an example; use your database. ----
const ORDERS = new URL("orders.json", DATA);
const SEEN = new URL("seen-events.json", DATA);
const load = (f, empty) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : empty);
const orders = load(ORDERS, {});
const seen = new Set(load(SEEN, []));
const save = () => {
  writeFileSync(ORDERS, JSON.stringify(orders, null, 2));
  writeFileSync(SEEN, JSON.stringify([...seen]));
};

// ---- The API: every request names its version; every create has a key. ----
async function api(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${KEY}`, "PSP-Version": VERSION };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  // Retry what the docs say is worth retrying (409, 429, 5xx, network) with
  // the same Idempotency-Key: one payment however many times we send it.
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    const retryable = res.status === 409 || res.status === 429 || res.status >= 500;
    if (res.ok || !retryable || attempt >= 4) {
      if (!res.ok) throw Object.assign(new Error(json.error?.message ?? res.statusText), { status: res.status, error: json.error });
      return json;
    }
    await sleep(250 * 2 ** attempt);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Orders ----
async function createOrder(amountRupees) {
  const id = `ord_${randomUUID().slice(0, 8)}`;
  const order = { id, amount: Math.round(amountRupees * 100), status: "new", created: new Date().toISOString() };
  orders[id] = order;
  save();
  const payment = await api("POST", "/payments", {
    // One key per operation, not per attempt: the order id and the step.
    idempotencyKey: `${id}:create-payment`,
    body: {
      amount: order.amount, // in paise
      currency: "INR",
      payment_method_data: { type: "upi" },
      merchant_reference: id,
      customer: { id: "cus_example" },
      checkout: { return_url: `${PUBLIC_URL}/orders/${id}` },
    },
  });
  Object.assign(order, { payment: payment.id, status: payment.status, version: payment.version ?? 0 });
  save();
  return { order, checkoutUrl: payment.checkout.url };
}

// Applies a payment as the API or an event shows it, never going back to an
// older version of it: events can come out of order.
function applyPayment(p) {
  const order = Object.values(orders).find((o) => o.payment === p.id || o.id === p.merchant_reference);
  if (!order) return;
  if (p.version != null && order.version != null && p.version < order.version) return;
  Object.assign(order, { status: p.status, version: p.version ?? order.version, credited: p.amount_credited ?? order.credited });
  if (p.status === "succeeded" && !order.delivered) order.delivered = new Date().toISOString(); // deliver the goods here
  save();
}

// ---- Webhooks ----
const DELIVERIES = new URL("deliveries.jsonl", DATA);
function webhook(raw, headers, res) {
  // A test switch for the retries check: while data/DOWN exists we answer 503.
  const down = existsSync(new URL("DOWN", DATA));
  const sig = headers["psp-signature"] ?? "";
  const ok = SECRETS.some((secret) => verify(raw, sig, secret));
  appendFileSync(
    DELIVERIES,
    JSON.stringify({
      at: new Date().toISOString(),
      event: headers["psp-event-id"],
      attempt: headers["psp-delivery-attempt"],
      signature_ok: ok,
      answered: down ? 503 : ok ? 200 : 400,
      body: raw.toString("utf8"),
    }) + "\n",
  );
  if (down) return send(res, 503, "down for a test");
  if (!ok) return send(res, 400, "bad signature"); // never act on it
  send(res, 200, "ok"); // answer at once, then do the work
  const event = JSON.parse(raw);
  if (seen.has(event.id)) return; // at least once: a retry repeats the id
  seen.add(event.id);
  if (event.data?.object?.object === "payment") applyPayment(event.data.object);
  save();
}

// ---- HTTP ----
const send = (res, status, text, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
};
const page = (title, body) =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">${body}</body>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks); // the raw body: the signature is over these bytes
  try {
    if (req.method === "POST" && url.pathname === "/webhooks") return webhook(raw, req.headers, res);
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, page("Example shop", `<h1>Example shop</h1><form method=post action=/orders>
        <label>Amount, ₹ <input name=amount value=499 inputmode=decimal></label> <button>Pay with UPI</button></form>`), "text/html");
    }
    if (req.method === "POST" && url.pathname === "/orders") {
      const amount = Number(new URLSearchParams(raw.toString()).get("amount") ?? 499);
      const { checkoutUrl } = await createOrder(amount);
      res.writeHead(303, { Location: checkoutUrl }); // send the payer to our page
      return res.end();
    }
    const m = url.pathname.match(/^\/orders\/(ord_[\w-]+)$/);
    if (req.method === "GET" && m && orders[m[1]]) {
      // The way back carries nothing: read the payment, it is the truth.
      const order = orders[m[1]];
      applyPayment(await api("GET", `/payments/${order.payment}`));
      const words = { succeeded: "Paid, thank you.", processing: "We are checking your payment: this page updates in a moment.", awaiting_payer: "Not paid yet.", expired: "The time to pay ran out.", failed: "Not paid." };
      const refresh = order.status === "processing" || order.status === "awaiting_payer" ? `<meta http-equiv=refresh content=5>` : "";
      return send(res, 200, page("Your order", `${refresh}<h1>Order ${esc(order.id)}</h1><p>₹${(order.amount / 100).toFixed(2)} · <b>${esc(order.status)}</b></p><p>${words[order.status] ?? ""}</p><p><a href=/>Back to the shop</a></p>`), "text/html");
    }
    send(res, 404, "not found");
  } catch (err) {
    console.error(err.status ?? "", err.message, err.error ?? "");
    send(res, 502, "payment provider error: " + err.message);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`shop on http://127.0.0.1:${PORT}, public ${PUBLIC_URL}, API ${API}, PSP-Version ${VERSION}, key ${KEY.slice(0, 11)}…`));
