import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const MINIO_PORT = 9000;

export interface StartedMinio {
  container: StartedTestContainer;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Starts a disposable MinIO container for tests (NBK-5's seam-1 tests need a
 * real S3-compatible store, the same way they need a real Postgres).
 *
 * This deliberately does NOT use the published `@testcontainers/minio`
 * module: that module's `MinioContainer` always overrides the image's
 * command with `server --console-address :9001 /data`, which bypasses the
 * Bitnami entrypoint script this repo's `bitnamilegacy/minio` image (see the
 * root `docker-compose.yml` for why — the official `minio/minio` image now
 * requires a Docker Hub login to pull) relies on to fix up file permissions
 * before starting MinIO; overriding the command makes it fail with "Unable
 * to initialize backend: file access denied". Using a plain `GenericContainer`
 * with the image's own default entrypoint/command avoids that.
 */
export async function startMinio(): Promise<StartedMinio> {
  const accessKeyId = 'rag_notebook';
  const secretAccessKey = 'rag_notebook_secret';

  const container = await new GenericContainer('bitnamilegacy/minio:latest')
    .withExposedPorts(MINIO_PORT)
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withWaitStrategy(Wait.forHttp('/minio/health/live', MINIO_PORT))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(MINIO_PORT)}`;
  return { container, endpoint, accessKeyId, secretAccessKey };
}
