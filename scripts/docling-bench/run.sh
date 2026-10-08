#!/usr/bin/env bash
# Converts a generated PDF with Docling's `accurate` and `fast` table modes and
# with table structure off, on the pinned image, then diffs the Markdown.
# Usage: scripts/docling-bench/run.sh [pages]   (default 40; about 15 minutes)
set -euo pipefail

pages="${1:-40}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${DOCLING_IMAGE:-$(sed -n "s/^export const DOCLING_IMAGE = '\(.*\)';$/\1/p" "$repo/apps/backend/src/ingestion/docling.ts")}"
artifacts="$(sed -n "s/^export const DOCLING_ARTIFACTS_PATH = '\(.*\)';$/\1/p" "$repo/apps/backend/src/ingestion/docling.ts")"
work="$(mktemp -d)"
mkdir -p "$work/in" "$work/accurate" "$work/fast" "$work/off"

python3 -I "$here/make_pdf.py" "$work/in/bench.pdf" "$pages"
echo "image: $image, $pages pages, output in $work"

run() {
  local mode="$1"; shift
  printf '%-9s ' "$mode"
  docker run --rm --network none \
    -v "$work/in:/work/in:ro" -v "$here:/work/bench:ro" -v "$work/$mode:/work/out" \
    --entrypoint python "$image" /work/bench/measure.py "$@" 2>&1 >/dev/null | grep '^exit='
}

run accurate docling --artifacts-path "$artifacts" --no-ocr --table-mode accurate \
  --to md --output /work/out /work/in/bench.pdf
run fast docling --artifacts-path "$artifacts" --no-ocr --table-mode fast \
  --to md --output /work/out /work/in/bench.pdf
run off python /work/bench/convert_no_tables.py /work/in/bench.pdf /work/out

for mode in accurate fast off; do
  printf '%-9s table lines: %s\n' "$mode" "$(grep -c '^|' "$work/$mode/bench.md" || true)"
done
if diff -q "$work/accurate/bench.md" "$work/fast/bench.md" >/dev/null; then
  echo "fast == accurate (byte-identical Markdown)"
else
  echo "fast != accurate:"; diff "$work/accurate/bench.md" "$work/fast/bench.md" | head -40
fi
