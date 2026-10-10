#!/bin/bash
# Sandbox-only: db reset, restart `functions serve` with gte-small pre-seeded, then embed every node.
set -e
S=${TMPDIR:-/tmp}
cd /home/user/mind_map
npx supabase db reset 2>&1 | tail -1
kill $(pgrep -x supabase) 2>/dev/null || true
until ! docker ps --format '{{.Names}}' | grep -q edge_runtime; do sleep 1; done
(npx supabase functions serve --no-verify-jwt > $S/serve.log 2>&1 &)
for i in $(seq 1 60); do docker ps --format '{{.Names}}' | grep -q edge_runtime && break; sleep 1; done
docker ps --format '{{.Names}}' | grep -q edge_runtime || { echo "functions serve failed:"; tail -5 $S/serve.log; exit 1; }
scripts/sandbox/seed-gte-cache.sh
for i in $(seq 1 30); do curl -s -m 3 http://127.0.0.1:54321/functions/v1/hello | grep -q ok && break; sleep 2; done
P="docker exec -i supabase_db_mind_map psql -U postgres -tA"
$P -c "select count(net.http_post(url := (select value from mind.internal_config where key='functions_url') || '/embed', body := jsonb_build_object('node_id', id), headers := jsonb_build_object('Content-Type','application/json','x-mind-webhook-secret',(select value from mind.internal_config where key='webhook_secret')), timeout_milliseconds := 30000)) from mind.nodes" >/dev/null
for i in $(seq 1 45); do n=$($P -c "select count(*) from mind.nodes where embedding is null"); [ "$n" = 0 ] && break; sleep 2; done
echo "nodes without embedding: $n"
