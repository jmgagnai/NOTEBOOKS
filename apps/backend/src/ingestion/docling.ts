import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join, parse } from 'node:path';
import { withoutEmbeddedPictures } from './embedded-pictures.js';
import { IngestionFailure } from './stage.js';

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
  /** Docling's table-structure mode for PDFs. Defaults to `DOCLING_TABLE_MODE` or `fast`. */
  tableMode?: DoclingTableMode;
  /** Where a container it could not remove is reported (NBK-111). Defaults to the console. */
  log?: (message: string) => void;
}

/**
 * Docling's `--table-mode`: how hard its table-structure model works on each
 * table a PDF's layout model finds. Only PDFs go through that model; DOCX,
 * XLSX, HTML, CSV and Markdown tables are read straight from their markup.
 */
const DOCLING_TABLE_MODES = ['fast', 'accurate'] as const;

export type DoclingTableMode = (typeof DOCLING_TABLE_MODES)[number];

function isDoclingTableMode(value: string): value is DoclingTableMode {
  return (DOCLING_TABLE_MODES as readonly string[]).includes(value);
}

/**
 * The table mode conversions run under: `override` if given, else
 * `DOCLING_TABLE_MODE` from the env, else `fast`.
 *
 * Why `fast` by default (NBK-72): the table-structure model is part of what makes
 * stage 1 slow and memory-hungry on CPU, and on the PDFs checked so far
 * `fast` produced the same Markdown tables as `accurate`.
 *
 * Why an unknown value throws instead of falling back: this runs when the
 * backend builds its converter at boot, and a typo that silently changed how
 * every Document is converted is worse than a backend that refuses to start.
 */
export function resolveDoclingTableMode(override?: DoclingTableMode): DoclingTableMode {
  if (override) return override;
  const configured = process.env.DOCLING_TABLE_MODE;
  if (configured === undefined) return 'fast';
  if (isDoclingTableMode(configured)) return configured;
  const accepted = DOCLING_TABLE_MODES.map((mode) => `"${mode}"`).join(' or ');
  throw new Error(`DOCLING_TABLE_MODE must be ${accepted}, got "${configured}".`);
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
 * be refused rather than let through: Docling's layout model still finds the
 * pictures — embedded as base64 by the CLI's default image export mode
 * (NBK-108) — and on a scanned page they are all it finds, so the Document
 * would otherwise reach stage 2 as pictures summarised and indexed as if
 * they were text. "Scanned" here means: once the pictures, any
 * `<!-- image -->` placeholders and Markdown punctuation are gone,
 * essentially no letters or digits remain — base64 being nothing but letters
 * and digits, the pictures have to go first. The threshold is low on
 * purpose, so a sparse but genuine text PDF is not refused.
 */
export function looksScanned(markdown: string): boolean {
  const textual = withoutEmbeddedPictures(markdown)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
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
 * Why tables are never off, only `fast` or `accurate` (NBK-72): the CLI has
 * no switch to skip table structure, and skipping it through Docling's
 * Python API does not degrade a table to plain text — the layout model still
 * claims the region and the table comes out empty, so every figure in it is
 * silently missing from the Converted Markdown and from everything
 * downstream. `--table-mode fast` is the cheap setting that keeps the text;
 * see `resolveDoclingTableMode`.
 *
 * Why an output *file* and not stdout: Docling and its transitive Python
 * dependencies write warnings and progress to stdout, which would corrupt
 * the Markdown; and a file still holds the result if this process dies after
 * the container succeeded. This function never reads the container's stdout
 * for content — only to attach it to an error message.
 */
export function createDoclingConverter(options: DoclingOptions = {}): MarkdownConverter {
  const image = options.image ?? process.env.DOCLING_IMAGE ?? DOCLING_IMAGE;
  const docker = resolveDockerBinary(options.docker);
  const log = options.log ?? warn;
  const timeoutMs = resolveDoclingTimeoutMs(options.timeoutMs);
  const tableMode = resolveDoclingTableMode(options.tableMode);

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

    // Named and labelled so a container the backend gives up on can be
    // stopped (NBK-111): killing `docker run` leaves its container running.
    const containerName = `notebooks-docling-${randomUUID()}`;
    const args = [
      'run',
      '--rm',
      // An init process as PID 1 forwards signals to Docling and reaps it, so
      // a killed conversion goes away instead of lingering as a zombie.
      '--init',
      '--name',
      containerName,
      '--label',
      DOCLING_CONTAINER_LABEL,
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
      '--table-mode',
      tableMode,
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
        void runDocker(docker, ['rm', '-f', containerName]).then((removed) => {
          if (!removed.ok) {
            log(
              `Could not remove timed-out Docling container ${containerName}: ${removed.output.trim()}`,
            );
          }
        });
        reject(
          new IngestionFailure(
            'timed-out',
            `Docling timed out after ${timeoutMs}ms converting ${inputName}.`,
          ),
        );
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        // NBK-65: a converter that never ran says nothing about the Document,
        // so the user is told the service was unavailable, not that their
        // upload is at fault.
        reject(
          new IngestionFailure(
            'service-unavailable',
            `Could not start Docling via ${docker}: ${err.message}. ` +
              'See docs/ingestion-docling.md for the setup step.',
            { cause: err },
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
        // NBK-65: Docling crashing on a Document is the Document being
        // unreadable to it; the diagnostics stay in the message, for
        // operators, and never decide the reason. A conversion killed from
        // outside is not (NBK-112): out of memory, its container removed
        // (NBK-111), Docker stopped — the file may be fine, and a Retry may
        // succeed. 137 and 143 are 128 + SIGKILL and SIGTERM, which is how
        // `docker run` reports its container killed. Migration 0020 finds
        // the killed failures recorded before this by the message below:
        // reword it and that migration no longer describes it.
        const killed = signal !== null || code === 137 || code === 143;
        reject(
          new IngestionFailure(
            killed ? 'unexpected' : 'unreadable',
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
      throw new IngestionFailure(
        'unreadable',
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
      throw new IngestionFailure(
        'no-text-layer',
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

/**
 * The label every Docling container this app starts carries (NBK-111), so
 * the ones a stopped backend left converting can be found and removed.
 */
export const DOCLING_CONTAINER_LABEL = 'notebooks.role=docling';

/** Runs one `docker` command to completion; never throws, so a cleanup cannot fail its caller. */
function runDocker(docker: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/**
 * Removes every Docling container this app started that is still there
 * (NBK-111). A worker starting up calls it before it re-runs the jobs its
 * predecessor left active: that predecessor's conversions are still running
 * in their containers, and a re-run beside one doubles the memory a large
 * Document needs. Only safe where one worker process owns the conversions —
 * the same assumption as reclaiming those jobs.
 *
 * Never throws: Docker being unreachable here is reported, and the
 * conversion that needs it reports it again in its own terms.
 */
export async function removeDoclingContainers(
  options: Pick<DoclingOptions, 'docker' | 'log'> = {},
): Promise<void> {
  const docker = resolveDockerBinary(options.docker);
  const log = options.log ?? warn;
  const listed = await runDocker(docker, [
    'ps',
    '-aq',
    '--filter',
    `label=${DOCLING_CONTAINER_LABEL}`,
  ]);
  if (!listed.ok) {
    log(`Could not list leftover Docling containers: ${listed.output.trim()}`);
    return;
  }
  const ids = listed.output.split(/\s+/).filter((id) => id !== '');
  // One at a time: a container already on its way out (its `--rm` running)
  // refuses removal, and must not make the others look as if they failed.
  for (const id of ids) {
    const removed = await runDocker(docker, ['rm', '-f', id]);
    if (!removed.ok)
      log(`Could not remove leftover Docling container ${id}: ${removed.output.trim()}`);
  }
}

/** The `docker` binary: as given, else `DOCKER_BIN`, else `docker` on the PATH. */
function resolveDockerBinary(docker?: string): string {
  return docker ?? process.env.DOCKER_BIN ?? 'docker';
}

// eslint-disable-next-line no-console
const warn = (message: string): void => console.warn(message);
