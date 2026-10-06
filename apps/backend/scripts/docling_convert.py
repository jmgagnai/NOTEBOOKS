#!/usr/bin/env python3
"""Convert one document to Markdown with Docling (ingestion stage 1, NBK-6).

Spawned by the backend's convert-to-Markdown job, once per conversion — see
apps/backend/src/ingestion/docling.ts for why a subprocess rather than a
long-lived sidecar service.

Contract with the caller:

  python docling_convert.py --input <path> --output <path>

* The Markdown is written to ``--output``, never to stdout. Docling and its
  transitive dependencies print warnings and progress to stdout, which would
  corrupt the result; a file also survives the caller crashing after this
  process succeeded, so a retried job can still pick the output up.
* stdout and stderr carry diagnostics only. The caller attaches them to an
  error message on a non-zero exit and otherwise ignores them.
* Exit 0 means "``--output`` holds the converted Markdown". Any other exit
  code means the conversion failed and the caller should retry or give up.

Install: see docs/ingestion-docling.md.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a document to Markdown with Docling.")
    parser.add_argument("--input", required=True, help="File to convert. Its extension picks the backend.")
    parser.add_argument("--output", required=True, help="Path to write the Markdown to.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.is_file():
        print(f"Input file does not exist: {input_path}", file=sys.stderr)
        return 2

    # Imported here, not at module scope: Docling pulls in a large dependency
    # tree, and an argument mistake should fail immediately rather than after
    # several seconds of imports.
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(str(input_path))
    markdown = result.document.export_to_markdown()

    # Written via a sibling temp file and renamed, so the output path is
    # either absent or complete. The caller reads it as soon as this process
    # exits 0 and must never see a half-written document — and a crash
    # mid-write would otherwise leave exactly that.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path = output_path.with_name(output_path.name + ".partial")
    partial_path.write_text(markdown, encoding="utf-8")
    os.replace(partial_path, output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
