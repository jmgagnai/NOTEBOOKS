import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DOCLING_IMAGE,
  createDoclingConverter,
  markdownOutputPath,
} from '../src/ingestion/docling.js';

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
 * The one test that runs Docling for real. Everything else stubs the
 * `MarkdownConverter` seam, which means the `docker run` invocation itself —
 * the mount layout, the entrypoint override, and the rename from the CLI's
 * own output filename to the path the caller asked for — would otherwise
 * never be exercised.
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
