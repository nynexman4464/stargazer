#!/bin/bash
# Load 1km Bortle chunks into DreamHost MySQL via upload_chunk.php.
#
# Usage: API_URL=https://example.com/api UPLOAD_SECRET=... ./load_chunks.sh [data_dir]
#
# Reads bbox/npatches per chunk from manifest.json. Idempotent (INSERT ...
# ON DUPLICATE KEY UPDATE). Run manifest upload last.
set -euo pipefail

API_URL="${API_URL:?set API_URL, e.g. https://example.com/api}"
UPLOAD_SECRET="${UPLOAD_SECRET:?set UPLOAD_SECRET}"
DATA_DIR="${1:-$HOME/workspace/data/bortle-1km}"

if [ ! -f "$DATA_DIR/manifest.json" ]; then
  echo "no manifest.json in $DATA_DIR" >&2; exit 1
fi

n=$(python3 -c "
import json
m = json.load(open('$DATA_DIR/manifest.json'))
print(sum(len(r['chunks']) for r in m['regions'].values()))
")
echo "Uploading $n chunks to $API_URL ..."

i=0
python3 - "$DATA_DIR/manifest.json" <<'PYEOF' | while read -r cid rid sw_lat sw_lon ne_lat ne_lon npatches file; do
import json, sys
m = json.load(open(sys.argv[1]))
for rid, reg in m['regions'].items():
    for ch in reg['chunks']:
        s, w, n_, e = ch['bbox']
        print(ch['id'], rid, s, w, n_, e, ch['patches'], ch['file'])
PYEOF
  i=$((i+1))
  url="$API_URL/upload_chunk.php?secret=$UPLOAD_SECRET&chunk_id=$cid&region_id=$rid&sw_lat=$sw_lat&sw_lon=$sw_lon&ne_lat=$ne_lat&ne_lon=$ne_lon&npatches=$npatches"
  resp=$(curl -sS -X POST --data-binary "@$DATA_DIR/$file" "$url")
  ok=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "ERR")
  if [ "$ok" != "True" ]; then
    echo "FAILED $cid: $resp" >&2
  elif [ $((i % 20)) -eq 0 ]; then
    echo "  $i/$n ..."
  fi
done

echo "Uploading manifest.json ..."
curl -sS -X POST --data-binary "@$DATA_DIR/manifest.json" \
  "$API_URL/upload_chunk.php?secret=$UPLOAD_SECRET&manifest=1"
echo
echo "Done."
