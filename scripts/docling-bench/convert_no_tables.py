# Converts a PDF the way the backend's `docling` CLI call does, except with
# table structure off, which the CLI cannot do. It builds the CLI's own
# standard-pipeline options (docling/cli/main.py, Docling 2.43.0: --no-ocr,
# --artifacts-path, --table-mode accurate, image export embedded) so the
# only difference from the CLI run is do_table_structure=False. With tables
# on, this script's output is byte-identical to the CLI's (checked in NBK-72).
# Runs inside the Docling image: python convert_no_tables.py <pdf> <outdir>
import sys
import time
from pathlib import Path

from docling.backend.docling_parse_v2_backend import DoclingParseV2DocumentBackend
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption

src, outdir = Path(sys.argv[1]), Path(sys.argv[2])
options = PdfPipelineOptions(
    artifacts_path="/opt/app-root/src/.cache/docling/models",
    do_ocr=False,
    do_table_structure=False,
)
options.table_structure_options.do_cell_matching = True
options.table_structure_options.mode = TableFormerMode.ACCURATE
options.generate_page_images = True
options.generate_picture_images = True
options.images_scale = 2
pdf = PdfFormatOption(pipeline_options=options, backend=DoclingParseV2DocumentBackend)
converter = DocumentConverter(format_options={InputFormat.PDF: pdf, InputFormat.IMAGE: pdf})

started = time.time()
result = converter.convert(src)
(outdir / (src.stem + ".md")).write_text(result.document.export_to_markdown())
print(f"convert() {time.time() - started:.1f}s", file=sys.stderr)
