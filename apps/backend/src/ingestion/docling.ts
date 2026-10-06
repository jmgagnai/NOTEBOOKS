import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * (test/convert-to-markdown.job.test.ts) stub the subprocess at exactly this
 * boundary — real Postgres, real MinIO, no Python.
 */
export type MarkdownConverter = (request: MarkdownConversionRequest) => Promise<void>;

export interface DoclingOptions {
  /**
   * Python interpreter to run the entry script with. Defaults to
   * `DOCLING_PYTHON`, then the repo's `.venv-docling` virtualenv (see
   * docs/ingestion-docling.md for how that's created), then `python3`.
   */
  python?: string;
  /** The entry script; defaults to the committed `scripts/docling_convert.py`. */
  script?: string;
  /** Hard cap on one conversion, in ms. Defaults to `DOCLING_TIMEOUT_MS` or 10 minutes. */
  timeoutMs?: number;
}

/** `apps/backend/scripts/docling_convert.py`, resolved from this module. */
const DEFAULT_SCRIPT = resolve(__dirname, "..", "..", "scripts", "docling_convert.py");

/** The repo-root virtualenv the documented install step creates. */
const DEFAULT_VENV_PYTHON = resolve(__dirname, "..", "..", "..", "..", ".venv-docling", "bin", "python");

function defaultPython(): string {
  return process.env.DOCLING_PYTHON ?? DEFAULT_VENV_PYTHON;
}

/**
 * Builds the real Docling-backed converter: a spawned Python subprocess, one
 * per conversion.
 *
 * Why a subprocess and not a long-lived sidecar service: conversion is a
 * batch job already running under a retryable pg_boss worker, so process
 * startup is noise next to the conversion itself, and a crash (Docling on a
 * malformed PDF is not shy about those) takes down one job attempt rather
 * than a shared service.
 *
 * Why an output *file* and not stdout: Docling and its transitive Python
 * dependencies write warnings and progress to stdout, which would corrupt
 * the Markdown; and a file still holds the result if this process dies after
 * the subprocess succeeded. The script writes nothing but the Markdown to
 * that path, and this function never reads the child's stdout for content —
 * only to attach it to an error message.
 */
export function createDoclingConverter(options: DoclingOptions = {}): MarkdownConverter {
  const python = options.python ?? defaultPython();
  const script = options.script ?? process.env.DOCLING_SCRIPT ?? DEFAULT_SCRIPT;
  const timeoutMs = options.timeoutMs ?? Number(process.env.DOCLING_TIMEOUT_MS ?? 600_000);

  return function convertWithDocling({ inputPath, outputPath }: MarkdownConversionRequest): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, [script, "--input", inputPath, "--output", outputPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Captured only for diagnostics on a non-zero exit — never parsed as
      // the conversion result. Bounded so a chatty dependency can't make
      // this process grow without limit.
      const diagnostics: string[] = [];
      let diagnosticsBytes = 0;
      const capture = (chunk: Buffer): void => {
        if (diagnosticsBytes >= 8_000) return;
        diagnosticsBytes += chunk.length;
        diagnostics.push(chunk.toString("utf8"));
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Docling timed out after ${timeoutMs}ms converting ${inputPath}.`));
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Could not start Docling (${python} ${script}): ${err.message}. ` +
              "See docs/ingestion-docling.md for the install step.",
          ),
        );
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(
          new Error(
            `Docling exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${diagnostics.join("").trim()}`,
          ),
        );
      });
    });
  };
}

/** The filename the converter writes its Markdown to, inside a temp dir. */
export function markdownOutputPath(directory: string): string {
  return join(directory, "converted.md");
}
