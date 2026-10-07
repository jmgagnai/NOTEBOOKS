import { spawn } from 'node:child_process';
import { access, readFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join, parse } from 'node:path';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Where to read the raw upload from, and where to write the Markdown to. */
export interface MarkdownConversionRequest {
  inputPath: string;
  outputPath: string;
}

/**
 * The seam between the ingestion job and Docling (NBK-6). The job hands over
 * two file paths and gets nothing back but a resolved promise; the Markdown
 * is read from `outputPath` by the caller.
 *
 * Expressing it as a plain function type is what lets the seam-2 job tests
 * (test/convert-to-markdown.job.test.ts) stub the conversion at exactly this
 * boundary — real Postgres, real MinIO, no Docker.
 */
export type MarkdownConverter = (request: MarkdownConversionRequest) => Promise<void>;

/**
 * The Docling image. `docling-serve-cpu` is an HTTP service image, but it has
 * the `docling` CLI and the full Docling library installed, so overriding its
 * entrypoint turns it into the one-shot converter this pipeline wants. There
 * is no published CLI-only Docling image: `ghcr.io/docling-project/docling`
 * and `docling-cli` do not exist, and `quay.io/docling-project/docling`
 * requires authentication (checked against both registries' APIs) — a
 * familiar problem in this repo, see docker-compose.yml on MinIO.
 *
 * Pinned to an exact version, not `latest` or `main`: conversion output feeds
 * everything downstream, so the converter must not change under the app
 * without someone deciding to change it.
 */
export const DOCLING_IMAGE = 'ghcr.io/docling-project/docling-serve-cpu:v1.1.0';

/**
 * Where the pinned image keeps its pre-downloaded models (layout, table
 * structure, figure classifier, and the EasyOCR weights).
 *
 * The image advertises this directory only through `DOCLING_SERVE_ARTIFACTS_PATH`,
 * which the HTTP server reads and the `docling` CLI does not. Run bare, the
 * CLI looks in Docling's default cache, finds nothing, and tries to download
 * — which `--network none` turns into `Name or service not known` ten
 * seconds into every PDF. So the path is passed explicitly on every run.
 * It is tied to the image tag above: bump one, re-check the other.
 */
export const DOCLING_ARTIFACTS_PATH = '/opt/app-root/src/.cache/docling/models';

export interface DoclingOptions {
  /** Container image to run. Defaults to `DOCLING_IMAGE`, overridable by `DOCLING_IMAGE` in the env. */
  image?: string;
  /** The `docker` binary. Defaults to `DOCKER_BIN` or `docker`. */
  docker?: string;
  /** Hard cap on one conversion, in ms. Defaults to `DOCLING_TIMEOUT_MS` or 60 minutes. */
  timeoutMs?: number;
}

/** Mount points inside the container. Nothing outside them is visible to it. */
const CONTAINER_INPUT_DIR = '/work/in';
const CONTAINER_OUTPUT_DIR = '/work/out';

/**
 * One conversion's hard cap. Sixty minutes rather than Docling's own idea of
 * "a document": the layout model runs on every page on CPU, and a 540-page
 * novel took the pinned image well over ten minutes on a four-core Docker
 * Desktop. A cap that kills the largest legitimate upload is a bug report
 * that reads as "conversion hangs"; a cap this generous still stops a
 * genuinely wedged container from holding the one-at-a-time worker forever.
 */
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/**
 * The timeout one conversion runs under: `override` if given, else
 * `DOCLING_TIMEOUT_MS` from the env, else the default above.
 *
 * Exported because the job queue has to know it too: pg_boss expires a job
 * still active after the queue's own limit, and that limit has to sit above
 * this one or a long conversion is retried while its container is still
 * running (NBK-22). Resolving it in one place keeps the two from drifting.
 */
export function resolveDoclingTimeoutMs(override?: number): number {
  return override ?? Number(process.env.DOCLING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
}

/**
 * Whether Markdown that Docling produced looks like it came from a scanned
 * PDF — pages that are pictures of text rather than text.
 *
 * OCR is never run (see `createDoclingConverter`), so a scanned PDF has to
 * be refused rather than let through: Docling's layout model still emits an
 * `<!-- image -->` placeholder per picture it finds, and on a scanned page
 * that is all it emits, so the Document would otherwise reach stage 2 as an
 * empty text that gets summarised and indexed as if it meant something.
 * "Scanned" here means: once the placeholders and Markdown punctuation are
 * gone, essentially no letters or digits remain. The threshold is low on
 * purpose, so a sparse but genuine text PDF is not refused.
 */
export function looksScanned(markdown: string): boolean {
  const textual = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  return textual.length < MIN_TEXT_CHARS_FOR_TEXT_PDF;
}

const MIN_TEXT_CHARS_FOR_TEXT_PDF = 20;

/**
 * Builds the real Docling-backed converter: a `docker run --rm` per
 * conversion, with the input file and the output directory bind-mounted in.
 *
 * Why a one-shot container and not a long-lived Docling service: conversion
 * is a batch job already running under a retryable pg_boss worker, so
 * container startup is noise next to the conversion itself, and a crash
 * (Docling on a malformed PDF is not shy about those) takes down one job
 * attempt rather than a shared service. It also means there is no Python
 * toolchain to install on the host — which mattered here, since Docling's
 * `docling-parse` dependency has no macOS x86_64 wheels past 4.7.2.
 *
 * Why OCR is off, always: Docling's PDF pipeline turns OCR on by default and
 * initialises EasyOCR before looking at a single page, even for a PDF whose
 * text is already text — seconds of model loading, and memory this
 * pipeline cannot spare (a 540-page novel with OCR on was killed at Docker
 * Desktop's 8GB cap after 39 minutes). Every document is converted with
 * `--no-ocr`. A PDF that comes back with no text layer is a scan, and is
 * refused with an error that says so (see `looksScanned`) rather than
 * ingested as an empty Document. Supporting scans is a feature with its own
 * memory budget, not a flag.
 *
 * Why an output *file* and not stdout: Docling and its transitive Python
 * dependencies write warnings and progress to stdout, which would corrupt
 * the Markdown; and a file still holds the result if this process dies after
 * the container succeeded. This function never reads the container's stdout
 * for content — only to attach it to an error message.
 */
export function createDoclingConverter(options: DoclingOptions = {}): MarkdownConverter {
  const image = options.image ?? process.env.DOCLING_IMAGE ?? DOCLING_IMAGE;
  const docker = options.docker ?? process.env.DOCKER_BIN ?? 'docker';
  const timeoutMs = resolveDoclingTimeoutMs(options.timeoutMs);

  return async function convertWithDocling({
    inputPath,
    outputPath,
  }: MarkdownConversionRequest): Promise<void> {
    const inputName = basename(inputPath);
    const outputDir = dirname(outputPath);

    // The `docling` CLI names its output after the input stem and will not be
    // told otherwise, so it writes `<stem>.md` into the mounted output
    // directory and this function renames it to the path the caller asked
    // for. Keeping `(inputPath, outputPath)` as the seam means the Docker
    // details stay inside this function and the stub in tests stays trivial.
    const producedName = `${parse(inputName).name}.md`;
    const produced = join(outputDir, producedName);

    const args = [
      'run',
      '--rm',
      // No network: conversion is pure local computation, and every model
      // it needs is in the image (at DOCLING_ARTIFACTS_PATH). This also
      // makes a malformed document unable to reach anything.
      '--network',
      'none',
      // The input is mounted read-only and on its own, so the container can
      // neither modify the file the rest of the job still relies on nor see
      // any other document's scratch space.
      '--volume',
      `${inputPath}:${CONTAINER_INPUT_DIR}/${inputName}:ro`,
      '--volume',
      `${outputDir}:${CONTAINER_OUTPUT_DIR}`,
      // The image's entrypoint starts the docling-serve HTTP server; this
      // runs the CLI that ships in the same image instead and exits.
      '--entrypoint',
      'docling',
      image,
      '--artifacts-path',
      DOCLING_ARTIFACTS_PATH,
      '--no-ocr',
      '--to',
      'md',
      '--output',
      CONTAINER_OUTPUT_DIR,
      `${CONTAINER_INPUT_DIR}/${inputName}`,
    ];

    const diagnostics = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      // Captured only for error messages — never parsed as the conversion
      // result. Bounded so a chatty dependency can't make this process grow
      // without limit.
      const captured: string[] = [];
      let diagnosticsBytes = 0;
      const capture = (chunk: Buffer): void => {
        if (diagnosticsBytes >= 8_000) return;
        diagnosticsBytes += chunk.length;
        captured.push(chunk.toString('utf8'));
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Docling timed out after ${timeoutMs}ms converting ${inputName}.`));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Could not start Docling via ${docker}: ${err.message}. ` +
              'See docs/ingestion-docling.md for the setup step.',
          ),
        );
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const output = captured.join('').trim();
        if (code === 0) {
          resolvePromise(output);
          return;
        }
        reject(
          new Error(
            `Docling exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${output}`,
          ),
        );
      });
    });

    // A zero exit code is NOT evidence of success: the `docling` CLI logs
    // "failed to convert", writes no output file, and still exits 0 (verified
    // against the pinned image — see test/docling.converter.test.ts). The
    // produced file is therefore the only trustworthy signal, and its absence
    // has to be turned into a loud failure here. Otherwise a document that
    // Docling choked on would reach the job handler as a confusing ENOENT,
    // or — worse, if an output file ever pre-existed — as a silent success
    // carrying the wrong content.
    if (!(await fileExists(produced))) {
      throw new Error(
        `Docling exited 0 but produced no Markdown for ${inputName}. Diagnostics: ${diagnostics || '(none)'}`,
      );
    }

    // Only a PDF can be a scan. Everything else this pipeline accepts (Office
    // formats, Markdown, CSV, plain text) carries its text as text, and an
    // empty one is simply an empty document.
    if (
      extname(inputName).toLowerCase() === '.pdf' &&
      looksScanned(await readFile(produced, 'utf8'))
    ) {
      throw new Error(
        `${inputName} has no text layer (a scanned PDF), and OCR is disabled. ` +
          'Upload a PDF whose text is selectable.',
      );
    }

    if (produced !== outputPath) {
      // Rename rather than copy: same directory, so it is atomic, and the
      // caller never sees a partially written output file.
      await rename(produced, outputPath);
    }
  };
}

/** The filename the converter writes its Markdown to, inside a temp dir. */
export function markdownOutputPath(directory: string): string {
  return join(directory, 'converted.md');
}
