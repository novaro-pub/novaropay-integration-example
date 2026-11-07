#!/usr/bin/env bash
# Checks the API against docs.novaro.ink/api/idempotent-requests and
# /api/versioning, with the test key in .env. Prints each case, what the docs
# say, and what came back.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
API=${NOVARO_API_BASE:-https://api.novaro.ink}
B='{"amount":49900,"currency":"INR","payment_method_data":{"type":"upi"},"merchant_reference":"REF","customer":{"id":"cus_check"}}'
body() { echo "${B/REF/$1}"; }
call() { # method path key version body -> "status|replayed|psp-version|body"
  local h=(-H "Authorization: Bearer $NOVARO_API_KEY" -H 'Content-Type: application/json')
  [ -n "$3" ] && h+=(-H "Idempotency-Key: $3")
  [ "$4" != - ] && for v in $4; do h+=(-H "PSP-Version: ${v//+/ }"); done
  local hf; hf=$(mktemp); local out; out=$(curl -s -D "$hf" -X "$1" "$API$2" "${h[@]}" ${5:+-d "$5"})
  printf '%s|%s|%s|%s' "$(awk 'NR==1{print $2}' "$hf")" \
    "$(grep -i '^idempotent-replayed:' "$hf" | tr -d '\r' | cut -d' ' -f2)" \
    "$(grep -i '^psp-version:' "$hf" | tr -d '\r' | cut -d' ' -f2)" "$out"; rm -f "$hf"
}
show() { IFS='|' read -r st rp ver js <<<"$2"; printf '%-58s %s replayed=%s psp-version=%s %s\n' "$1" "$st" "${rp:-}" "${ver:-none}" "$(echo "$js" | python3 -c 'import sys,json
d=json.load(sys.stdin); e=d.get("error")
print(e and {k:e.get(k) for k in ("type","code","param")} or d.get("id"))' 2>/dev/null)"; }

echo "== Idempotency"
K=$(uuidgen); R=chk-$RANDOM
a=$(call POST /payments "$K" - "$(body $R)"); show "1. first request" "$a"
b=$(call POST /payments "$K" - "$(body $R)"); show "2. same key, same body: first answer, replayed" "$b"
[ "${a#*|*|*|}" = "${b#*|*|*|}" ] && echo "   body byte for byte the same: yes" || echo "   body byte for byte the same: NO"
show "3. same key, another body: 400 idempotency_error, no code" "$(call POST /payments "$K" - "$(body $R-x)")"
show "4. no key: 400 parameter_missing Idempotency-Key" "$(call POST /payments '' - "$(body chk-$RANDOM)")"
show "5. key of 256 chars: 400 parameter_invalid" "$(call POST /payments "$(printf 'k%.0s' {1..256})" - "$(body chk-$RANDOM)")"
K2=$(uuidgen); R2=chk-$RANDOM
show "6. refused for a parameter (400) with key K2" "$(call POST /payments "$K2" - "${B/49900/1}")"
show "7. K2 again, corrected: 201, not used up by 6" "$(call POST /payments "$K2" - "$(body $R2)")"
K3=$(uuidgen); R3=chk-$RANDOM
for i in 1 2 3; do call POST /payments "$K3" - "$(body $R3)" > /tmp/novaro-par-$i & done; wait
for i in 1 2 3; do show "8. same key at once ($i): one 201, others 409 in_use or replay" "$(cat /tmp/novaro-par-$i)"; done

echo "== PSP-Version"
show "9. names a version: that one" "$(call GET /balance '' 2026-10-25.acacia)"
show "10. none: the account's default" "$(call GET /balance '' -)"
show "11. unknown: 400 invalid_api_version, no PSP-Version" "$(call GET /balance '' 2099-01-01.zinnia)"
show "12. sent twice: 400 invalid_api_version" "$(call GET /balance '' '2026-11-04.acacia 2026-10-25.acacia')"
show "13. upper case name: 400 (matched exactly)" "$(call GET /balance '' 2026-11-04.ACACIA)"
NOVARO_API_KEY=sk_test_in_wrong show "14. wrong key + bad version: 401, no PSP-Version" "$(NOVARO_API_KEY=sk_test_in_wrong call GET /balance '' 2099-01-01.zinnia)"
