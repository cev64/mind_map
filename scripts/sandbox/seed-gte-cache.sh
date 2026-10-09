#!/bin/sh
# Cloud-sandbox only (not needed on a normal machine).
# The local edge runtime downloads gte-small from Hugging Face with a client that
# can't verify the sandbox's TLS proxy, so `Supabase.ai.Session('gte-small')`
# fails with "failed to download". This copies the model into the runtime's cache
# with the xxh3 checksums it expects. Cache dirs are fxhash(url) of the model URLs
# (edge-runtime ext/ai/utils.rs, fetch_and_cache_from_url).
#
# Run right after `npx supabase functions serve` starts the container and BEFORE the
# first embed call (a failed model load is remembered until the runtime restarts).
# `supabase db reset` recreates the container, so re-run after a reset (and restart serve).
set -e
G=.sandbox/gte
CT=supabase_edge_runtime_mind_map
HF=https://huggingface.co/Supabase/gte-small/resolve/main
mkdir -p $G
[ -f $G/model.onnx ] || curl -sSL -o $G/model.onnx "$HF/onnx/model.onnx"
[ -f $G/tokenizer.json ] || curl -sSL -o $G/tokenizer.json "$HF/tokenizer.json?download=true"
for spec in model/6732992620216748519/model.onnx tokenizer/5492507592542126767/tokenizer.json; do
  f=$(basename $spec); d=/root/.cache/ort.pyke.io/$(dirname $spec)
  [ -f "$G/$f.checksum" ] || python3 -c "import xxhash,sys; print(xxhash.xxh3_64(open(sys.argv[1],'rb').read()).hexdigest(), end='')" "$G/$f" > "$G/$f.checksum"
  docker exec $CT mkdir -p $d
  docker cp -q "$G/$f" $CT:$d/$f
  docker cp -q "$G/$f.checksum" $CT:$d/$f.checksum
  echo "seeded $spec"
done
