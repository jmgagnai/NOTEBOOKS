import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { IngestionFailure } from '../src/ingestion/stage.js';
import {
  DOCLING_ARTIFACTS_PATH,
  DOCLING_IMAGE,
  createDoclingConverter,
  looksScanned,
  markdownOutputPath,
} from '../src/ingestion/docling.js';
import { missingDocker, scriptedDocker } from './support/scripted-docker.js';

const execFileAsync = promisify(execFile);

/** Whether the pinned Docling image is already present locally. */
async function imageIsPresent(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['images', '-q', DOCLING_IMAGE]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * A one-page PDF whose text is text (not a scan), built by hand so the test
 * carries no binary fixture. Offsets in the cross-reference table are
 * computed, not guessed: Docling's PDF backend reads the file for real.
 */
function textPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Everything above is ASCII, so string length and byte offsets agree.
  return Buffer.from(body, 'latin1');
}

/**
 * A stand-in for the `docker` binary: records each invocation's arguments
 * and writes `output` as `<stem>.md` into the host directory mounted at
 * `/work/out`.
 *
 * This is what lets the argument list and the scanned-PDF refusal be tested
 * without the 4.5GB image, and without a scanned PDF fixture.
 */
async function fakeDocker(
  directory: string,
  output: string,
): Promise<{ docker: string; invocations: () => Promise<string[][]> }> {
  const outputFile = join(directory, 'canned.md');
  const log = join(directory, 'invocations.log');
  await writeFile(outputFile, output, 'utf8');
  await writeFile(log, '', 'utf8');

  const script = await scriptedDocker(
    `printf '%s\\n' "$@" >> '${log}'
printf -- '---\\n' >> '${log}'
out=''
prev=''
for a in "$@"; do
  if [ "$prev" = '--volume' ]; then case "$a" in *:/work/out) out="\${a%:/work/out}";; esac; fi
  prev="$a"
done
last=''
for a in "$@"; do last="$a"; done
stem=$(basename "$last")
stem="\${stem%.*}"
cp '${outputFile}' "$out/$stem.md"`,
  );

  return {
    docker: script,
    async invocations() {
      const recorded = await readFile(log, 'utf8');
      return recorded
        .split('---\n')
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.split('\n').filter((line) => line.length > 0));
    },
  };
}

describe('Docling converter: arguments and OCR policy (fake docker)', () => {
  it('converts a text PDF without OCR, pointing the CLI at the models in the image', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'nbk-docling-fake-'));
    const inputPath = join(workDir, 'report.pdf');
    const outputPath = markdownOutputPath(workDir);
    await writeFile(inputPath, textPdf('Quarterly report'));
    const fake = await fakeDocker(workDir, '# Quarterly report\n\nRevenue grew in every region.\n');

    await createDoclingConverter({ docker: fake.docker })({ inputPath, outputPath });

    const invocations = await fake.invocations();
    expect(invocations).toHaveLength(1);
    const [args] = invocations;
    // Bare, the CLI cannot find the models the image ships and tries to
    // download them — which `--network none` turns into a crash on every PDF.
    expect(args).toContain('--artifacts-path');
    expect(args[args.indexOf('--artifacts-path') + 1]).toBe(DOCLING_ARTIFACTS_PATH);
    expect(args).toContain('--network');
    expect(args).toContain('--no-ocr');
    expect(args).not.toContain('--ocr');
    expect(await readFile(outputPath, 'utf8')).toContain('Revenue grew in every region.');
  });

  it('refuses a PDF that came back without a text layer instead of OCRing it', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'nbk-docling-fake-'));
    const inputPath = join(workDir, 'scan.pdf');
    const outputPath = markdownOutputPath(workDir);
    await writeFile(inputPath, textPdf('irrelevant'));
    const fake = await fakeDocker(workDir, '<!-- image -->\n\n<!-- image -->\n\n<!-- image -->\n');

    // OCR is never run: it costs a model load per conversion and more memory
    // than a book-length PDF leaves. A scan is a clear failure the user can
    // act on, not an empty Document for stage 2 to summarise.
    const refusal = createDoclingConverter({ docker: fake.docker })({ inputPath, outputPath });
    await expect(refusal).rejects.toThrow(/no text layer/);
    // NBK-64: classified here, where the scan is recognised, so the reason a
    // user is shown never depends on how this message is worded.
    await expect(refusal).rejects.toBeInstanceOf(IngestionFailure);
    await expect(refusal).rejects.toMatchObject({ reason: 'no-text-layer' });

    const invocations = await fake.invocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain('--no-ocr');
    expect(invocations[0]).not.toContain('--ocr');
  });

  it('accepts an empty non-PDF, since only a PDF can be a scan', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'nbk-docling-fake-'));
    const inputPath = join(workDir, 'empty.md');
    const outputPath = markdownOutputPath(workDir);
    await writeFile(inputPath, '', 'utf8');
    const fake = await fakeDocker(workDir, '');

    await createDoclingConverter({ docker: fake.docker })({ inputPath, outputPath });

    expect(await fake.invocations()).toHaveLength(1);
    expect(await readFile(outputPath, 'utf8')).toBe('');
  });
});

/**
 * NBK-65: every way stage 1 knows it failed carries its reason on the typed
 * failure. The assertions are on `reason` alone, never the message, so the
 * diagnostics can be reworded without changing what the user is told.
 */
describe('Docling converter: named failures (scripted docker)', () => {
  async function convertWith(docker: string, timeoutMs?: number): Promise<unknown> {
    const workDir = await mkdtemp(join(tmpdir(), 'nbk-docling-fail-'));
    const inputPath = join(workDir, 'report.pdf');
    await writeFile(inputPath, textPdf('Quarterly report'));
    return createDoclingConverter({ docker, timeoutMs })({
      inputPath,
      outputPath: markdownOutputPath(workDir),
    }).then(
      () => {
        throw new Error('expected the conversion to fail');
      },
      (err: unknown) => err,
    );
  }

  it("is 'unreadable' when Docling exits with an error", async () => {
    const failure = await convertWith(
      await scriptedDocker("echo 'RuntimeError: PDF is damaged' >&2; exit 1"),
    );

    expect(failure).toBeInstanceOf(IngestionFailure);
    expect(failure).toMatchObject({ reason: 'unreadable' });
  });

  it("is 'unreadable' when Docling exits 0 but writes no Markdown", async () => {
    const failure = await convertWith(await scriptedDocker("echo 'failed to convert'; exit 0"));

    expect(failure).toBeInstanceOf(IngestionFailure);
    expect(failure).toMatchObject({ reason: 'unreadable' });
  });

  it("is 'timed-out' when Docling is killed after its timeout", async () => {
    const failure = await convertWith(await scriptedDocker('exec sleep 30'), 200);

    expect(failure).toBeInstanceOf(IngestionFailure);
    expect(failure).toMatchObject({ reason: 'timed-out' });
  });

  it("is 'service-unavailable' when Docling cannot be started", async () => {
    const failure = await convertWith(missingDocker());

    expect(failure).toBeInstanceOf(IngestionFailure);
    expect(failure).toMatchObject({ reason: 'service-unavailable' });
  });
});

describe('looksScanned', () => {
  it('is true for Markdown that is only picture placeholders', () => {
    expect(looksScanned('<!-- image -->\n\n<!-- image -->\n')).toBe(true);
    expect(looksScanned('')).toBe(true);
    expect(looksScanned('\n\n---\n\n')).toBe(true);
  });

  it('is false once there is a sentence of real text, in any script', () => {
    expect(looksScanned('# Chapter One\n\nIt was a dark and stormy night.\n')).toBe(false);
    expect(looksScanned('<!-- image -->\n\nLe commissaire regarda la fenêtre un instant.\n')).toBe(
      false,
    );
    expect(looksScanned('第一章 夜は暗く、嵐が吹き荒れていた。その中で彼は立ち上がった。')).toBe(
      false,
    );
  });
});

/**
 * The tests that run Docling for real. Everything else stubs the
 * `MarkdownConverter` seam or the `docker` binary, which means the actual
 * `docker run` invocation — the mount layout, the entrypoint override, the
 * artifacts path, the rename from the CLI's own output filename to the path
 * the caller asked for — would otherwise never be exercised.
 *
 * Skipped unless the image is already pulled: it is a multi-gigabyte
 * download, so `pnpm test` must not drag it in on a fresh clone. See
 * docs/ingestion-docling.md for the one-line pull.
 */
describe('Docling converter (real container)', () => {
  let available = false;

  beforeAll(async () => {
    available = await imageIsPresent();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping real Docling conversion: ${DOCLING_IMAGE} is not pulled. See docs/ingestion-docling.md.`,
      );
    }
  }, 60_000);

  it('converts a real document to Markdown at the requested output path', async () => {
    if (!available) return;

    const workDir = await mkdtemp(join(tmpdir(), 'nbk6-docling-'));
    const inputPath = join(workDir, 'handbook.md');
    const outputPath = markdownOutputPath(workDir);
    await writeFile(inputPath, '# Team Handbook\n\nOnboarding starts on day one.\n', 'utf8');

    const convert = createDoclingConverter();
    await convert({ inputPath, outputPath });

    // The Markdown is at the path the caller named, not at whatever the
    // docling CLI chose to call it.
    const markdown = await readFile(outputPath, 'utf8');
    expect(markdown).toContain('Team Handbook');
    expect(markdown).toContain('Onboarding starts on day one');
  }, 600_000);

  it('converts a real PDF through the PDF pipeline', async () => {
    if (!available) return;

    // The Markdown test above never touches the PDF pipeline, which is the
    // one that loads the layout and OCR models — and the one that failed on
    // every upload when the CLI could not find them (it tried to download
    // them with the network off). A PDF, however small, goes through it.
    const workDir = await mkdtemp(join(tmpdir(), 'nbk6-docling-pdf-'));
    const inputPath = join(workDir, 'memo.pdf');
    const outputPath = markdownOutputPath(workDir);
    await writeFile(inputPath, textPdf('Onboarding starts on day one'));

    await createDoclingConverter()({ inputPath, outputPath });

    expect(await readFile(outputPath, 'utf8')).toContain('Onboarding starts on day one');
  }, 600_000);

  it('fails loudly when Docling converts nothing but still exits 0', async () => {
    if (!available) return;

    const workDir = await mkdtemp(join(tmpdir(), 'nbk6-docling-bad-'));
    // A .pdf extension picks Docling's PDF backend, which cannot read this.
    const inputPath = join(workDir, 'corrupt.pdf');
    await writeFile(inputPath, 'this is definitely not a PDF', 'utf8');

    // The `docling` CLI logs "failed to convert", writes no output file, and
    // *exits 0* — verified against the pinned image. So a zero exit code is
    // not evidence of success, and the converter has to check for the output
    // itself or a failed conversion would look like an empty document.
    await expect(
      createDoclingConverter()({ inputPath, outputPath: markdownOutputPath(workDir) }),
    ).rejects.toThrow(/produced no Markdown/i);
  }, 600_000);
});
