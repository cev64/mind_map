#!/bin/bash
# Cloud-sandbox bootstrap (not needed on a normal machine). Idempotent. Run from the repo root:
#   scripts/sandbox/setup.sh
# 1. npm install   2. Docker daemon   3. local Supabase stack   4. edge-runtime TLS env (git-ignored)
# 5. functions serve with gte-small pre-seeded   6. db reset + embed all seed nodes (via reset-local.sh)
set -e
cd "$(dirname "$0")/../.."

[ -d node_modules ] || npm install
python3 -c "import xxhash" 2>/dev/null || pip install -q xxhash  # seed-gte-cache.sh needs it

if ! docker info >/dev/null 2>&1; then
  (sudo dockerd > "${TMPDIR:-/tmp}/dockerd.log" 2>&1 &)
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
docker info >/dev/null 2>&1 || { echo "docker did not start"; exit 1; }

# The sandbox re-terminates TLS through a proxy; the edge runtime needs its CA to fetch jsr/npm imports.
mkdir -p supabase/functions/.certs
cp /root/.ccr/ca-bundle.crt supabase/functions/.certs/ca.crt
C="$PWD/supabase/functions/.certs/ca.crt"
printf 'DENO_CERT=%s\nDENO_TLS_CA_STORE=mozilla,system\nSSL_CERT_FILE=%s\n' "$C" "$C" > supabase/functions/.env

npx supabase status >/dev/null 2>&1 || npx supabase start -x studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit

scripts/sandbox/reset-local.sh
echo "Local stack ready. Test login: test@example.com / password (see supabase/seed.sql)."
