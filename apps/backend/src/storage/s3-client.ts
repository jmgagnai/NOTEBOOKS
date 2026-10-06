import { Agent as HttpAgent } from 'node:http';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface S3Config {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Builds an S3 client pointed at MinIO. Per NBK-5, raw Document bytes are
 * stored in MinIO, which speaks the S3 API — `forcePathStyle` is required
 * because MinIO (unlike AWS S3) doesn't support virtual-hosted-style
 * addressing by default.
 */
export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    // Against a local/dev MinIO (including the Testcontainers one seam-1
    // tests use — see test/support/minio-container.ts) the connection
    // occasionally resets mid-request ("socket hang up" / ECONNRESET) even
    // on a fresh, non-keep-alive socket. `retryRequest` below adds a second,
    // belt-and-suspenders retry layer on top of this.
    maxAttempts: 5,
    requestHandler: new NodeHttpHandler({
      httpAgent: new HttpAgent({ keepAlive: false }),
    }),
  });
}

const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

interface PossibleS3Error {
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const RETRYABLE_S3_CODES = new Set([
  // MinIO (particularly a single-node instance that just started, as in
  // tests — see test/support/minio-container.ts) can report its health
  // endpoint live/ready slightly before its object layer is actually ready
  // to serve requests, returning this transiently.
  'XMinioServerNotInitialized',
  // Observed sporadically against the same local/test MinIO even once it's
  // fully up — the connection drops mid-request for reasons outside the
  // application (e.g. Docker Desktop's port-forwarding layer). Every body
  // this client sends is an in-memory Buffer, so a PUT is always safe to
  // retry byte-for-byte; a GET is naturally idempotent.
  'ClientDisconnected',
]);
const RETRYABLE_HTTP_STATUS_CODES = new Set([499, 503]);

function isRetryableError(err: unknown): boolean {
  const { code, Code, $metadata } = (err ?? {}) as PossibleS3Error;
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) return true;
  if (typeof Code === 'string' && RETRYABLE_S3_CODES.has(Code)) return true;
  if (
    typeof $metadata?.httpStatusCode === 'number' &&
    RETRYABLE_HTTP_STATUS_CODES.has($metadata.httpStatusCode)
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `operation` a few times on connection-level failures. The AWS SDK
 * already retries internally (see `maxAttempts` above), but has been
 * observed to still exhaust those retries against a local MinIO under test
 * load; this adds a slower, longer-backoff layer on top.
 */
async function retryRequest<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      await sleep(200 * attempt);
    }
  }
  throw lastError;
}

/** Creates `bucket` if it doesn't already exist. Idempotent. */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await retryRequest(() => client.send(new HeadBucketCommand({ Bucket: bucket })));
  } catch {
    await retryRequest(() => client.send(new CreateBucketCommand({ Bucket: bucket })));
  }
}

/** Stores raw bytes at `key` within `bucket`. */
export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await retryRequest(() =>
    client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    ),
  );
}

export interface StoredObject {
  body: Readable;
  contentLength?: number;
}

/** Reads back the raw bytes stored at `key` within `bucket`. */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<StoredObject> {
  const result = await retryRequest(() =>
    client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
  );
  return {
    body: result.Body as Readable,
    contentLength: result.ContentLength,
  };
}
