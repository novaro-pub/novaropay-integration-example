import { Buffer } from "node:buffer";
import crypto from "node:crypto";

// How old a delivery's timestamp may be, in seconds.
const TOLERANCE = 300;

// Checks the PSP-Signature header of a webhook delivery against the raw
// request body (a Buffer or string, exactly as received) and your
// endpoint's signing secret (whsec_…). True when the body is ours and
// recent.
export function verify(body, header, secret, now = Math.floor(Date.now() / 1000)) {
  let timestamp = "";
  const signatures = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - Number(timestamp)) > TOLERANCE) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  // During a secret's roll the header has a v1 for each secret in force:
  // any one of them that matches is enough.
  return signatures.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}
