#!/usr/bin/env bash
# Makes one live payment (no checkout, nobody pays it: it expires in 15 min)
# so that live events go to the live webhook endpoint. The live key comes from
# the clipboard and is never printed or written anywhere.
set -euo pipefail
key=$(pbpaste)
case "$key" in sk_live_in_*) ;; *) echo "the clipboard holds no sk_live_in_ key"; exit 1;; esac
curl -s https://api.novaro.ink/payments \
  -H "Authorization: Bearer $key" -H "PSP-Version: 2026-11-04.acacia" \
  -H "Idempotency-Key: retry-check-$(date +%s)" -H 'Content-Type: application/json' \
  -d '{"amount":74321,"currency":"INR","payment_method_data":{"type":"upi"},"merchant_reference":"retry-check","customer":{"id":"cus_retry_check"}}' |
  python3 -I -c 'import sys,json; d=json.load(sys.stdin); print(d.get("error") or {k:d.get(k) for k in ("id","status","livemode","expires_at")})'
