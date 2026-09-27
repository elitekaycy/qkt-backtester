#!/usr/bin/env bash
# Smoke test for a running qkt-backtester container started on an EMPTY /workspace and EMPTY /data.
# Usage: smoke.sh [base-url]   (needs curl + jq). Exits non-zero on any failure.
set -euo pipefail
B="${1:-http://127.0.0.1:8080}"
AUTH=()
[ -n "${STUDIO_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $STUDIO_TOKEN")
j() { curl -fsS "${AUTH[@]}" "$@"; }
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

for i in $(seq 1 60); do j "$B/api/health" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 60 ] && fail "no /api/health after 60s"; done
info=$(j "$B/api/info"); echo "info: $info"
[ "$(jq -r .hasConfig <<<"$info")" = true ] || fail "empty workspace was not seeded (hasConfig=false)"
j "$B/api/tree?path=strategies" | jq -e '.entries | map(select(.name|endswith(".qkt"))) | length > 0' >/dev/null || fail "no sample strategy"
j "$B/api/data/scan" | jq -e 'tostring | test("DEMOUSD")' >/dev/null || fail "demo data not found in scan"

req='{"strategy":"strategies/ema_cross.qkt","from":"2024-01-01","to":"2024-03-30","tier":"draft"}'
run() {
  local r id st
  r=$(j -XPOST -H 'content-type: application/json' -d "$req" "$B/api/runs")
  id=$(jq -r '.runId' <<<"$r")
  [ -n "$id" ] && [ "$id" != null ] || fail "POST /api/runs: $r"
  for _ in $(seq 1 180); do
    st=$(j "$B/api/runs/$id" | jq -r .status)
    case "$st" in done) break ;; failed|cancelled|interrupted) j "$B/api/runs/$id" >&2; fail "run $id ended $st" ;; esac
    sleep 1
  done
  [ "$st" = done ] || fail "run $id did not finish (status $st)"
  echo "$(jq -c '{cached}' <<<"$r") $id"
}
t0=$(date +%s.%N); out1=$(run); t1=$(date +%s.%N); out2=$(run); t2=$(date +%s.%N)
id1=${out1##* }; id2=${out2##* }
echo "run1 $out1 $(echo "$t1-$t0" | bc)s; run2 $out2 $(echo "$t2-$t1" | bc)s"
[ "$id1" = "$id2" ] || fail "identical inputs gave different run ids ($id1 vs $id2)"
grep -q '"cached":true' <<<"$out2" || fail "second identical run was not a cache hit"
s=$(j "$B/api/runs/$id1/derived/summary"); echo "summary: $(jq -c . <<<"$s" | cut -c1-600)"
integ=$(j "$B/api/runs/$id1/derived/integrity"); echo "integrity: $(jq -c . <<<"$integ" | cut -c1-600)"
echo SMOKE OK
