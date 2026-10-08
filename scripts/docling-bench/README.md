# Docling table-mode benchmark

Compares Docling's `accurate` and `fast` table modes, and table structure off, on a generated PDF with two ruled tables per page (NBK-72, NBK-74):

```bash
scripts/docling-bench/run.sh        # 40 pages, about 15 minutes
scripts/docling-bench/run.sh 2      # a quick sanity run
```

It needs Docker and the pinned image (`DOCLING_IMAGE` in `apps/backend/src/ingestion/docling.ts`; an env var of the same name overrides it). It prints wall time and peak memory per mode, the number of Markdown table lines, and whether `fast`'s Markdown is byte-identical to `accurate`'s.

The "off" run goes through `convert_no_tables.py`, because the CLI cannot turn table structure off. It is there to show what off costs (every table's text), not as an option.
