# Watches data/deliveries.jsonl for the live payment.created event of a payment:
# after `up_after` failed attempts it removes data/DOWN, and exits once an
# attempt is answered 200. Prints each attempt with the gap to the one before.
import json, os, sys, time, datetime as dt
pay, up_after, deadline = sys.argv[1], int(sys.argv[2]), time.time() + 45 * 60
log, down, seen, prev = "data/deliveries.jsonl", "data/DOWN", set(), None
while time.time() < deadline:
    for line in open(log) if os.path.exists(log) else []:
        d = json.loads(line); b = json.loads(d["body"])
        if not b.get("livemode") or b["data"]["object"].get("id") != pay or b["type"] != "payment.created": continue
        key = (d["event"], d["attempt"])
        if key in seen: continue
        seen.add(key); at = dt.datetime.fromisoformat(d["at"].replace("Z", "+00:00"))
        gap = "" if prev is None else f"+{(at - prev).total_seconds() / 60:.2f} min"
        prev = at
        print(f'{at:%H:%M:%S} attempt {d["attempt"]} {b["type"]} {d["event"]} answered {d["answered"]} sig {d["signature_ok"]} {gap}', flush=True)
        if d["answered"] == 200: sys.exit(0)
        if int(d["attempt"]) >= up_after and os.path.exists(down):
            os.remove(down); print(f"{dt.datetime.now(dt.timezone.utc):%H:%M:%S} shop up again", flush=True)
    time.sleep(5)
print("timed out"); sys.exit(1)
