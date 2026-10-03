#!/usr/bin/env bash
# Runs every test against ../team-console. Needs Node.js 20+ and `npm install` in ../team-console.
# A local stand-in for Groq, Jina, OpenAI and Gemini runs on port 8899 while the tests run.
set -u
cd "$(dirname "$0")"
TSX="${TSX:-npx --yes tsx}"   # set TSX=tsx to use an installed copy
LOGS="${TMPDIR:-/tmp}/part2-tests"
mkdir -p "$LOGS"

$TSX mock-openai.ts > "$LOGS/ai-standin.log" 2>&1 &
STANDIN=$!
trap 'kill $STANDIN 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null -X POST http://127.0.0.1:8899/__control -d '{}' && break
  sleep 0.5
done

failed=0
for t in t_ingest t_search t_search_sem t_query t_reply t_understand t_config t_prompt_size t_groq t_batch; do
  if $TSX "$t.ts" > "$LOGS/$t.log" 2>&1; then
    echo "pass  $t"
  else
    echo "FAIL  $t  (log: $LOGS/$t.log)"
    failed=1
  fi
done
[ $failed -eq 0 ] && echo "All tests passed." || echo "Some tests failed."
exit $failed
