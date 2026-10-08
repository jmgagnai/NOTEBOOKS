import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in `docker` binary whose whole behaviour is `body`, a POSIX shell
 * script. It lets the converter's failure paths — a crash, a hang, an exit 0
 * with nothing written — be driven without the 4.5GB Docling image, both in
 * the converter's own tests and in the stage-1 job tests that run the real
 * converter against it (NBK-65).
 */
export async function scriptedDocker(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nbk-scripted-docker-'));
  const script = join(directory, 'docker');
  await writeFile(script, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

/** A `docker` path that does not exist, so spawning it fails before anything runs. */
export function missingDocker(): string {
  return join(tmpdir(), 'nbk-no-such-docker', 'docker');
}
