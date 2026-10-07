import PgBoss from 'pg-boss';
import {
  CONVERT_TO_MARKDOWN_QUEUE,
  convertToMarkdownPayloadSchema,
  runConvertToMarkdownJob,
  type ConvertToMarkdownDeps,
  type ConvertToMarkdownPayload,
} from '../ingestion/convert-to-markdown.js';
import {
  SUMMARIZE_DOCUMENT_QUEUE,
  summarizeDocumentPayloadSchema,
  runSummarizeDocumentJob,
  type SummarizeDocumentDeps,
  type SummarizeDocumentPayload,
} from '../ingestion/summarize-document.js';
import {
  EMBED_CHUNKS_QUEUE,
  embedChunksPayloadSchema,
  runEmbedChunksJob,
  type EmbedChunksDeps,
  type EmbedChunksPayload,
} from '../ingestion/embed-chunks.js';
import { resolveDoclingTimeoutMs } from '../ingestion/docling.js';

/**
 * Background jobs run on pg_boss against the same Postgres instance as
 * everything else (NBK-6): the jobs live in a table, so a job enqueued before
 * a restart is still there afterwards, and a job can be enqueued inside the
 * same database the row it is about lives in. No extra broker to operate.
 *
 * The pipeline is one queue *per stage*, not one job that does everything. A
 * stage that fails is retried on its own, and on success a stage enqueues the
 * next — so a later stage's bug never re-runs an expensive earlier stage.
 * Stage 1 is Markdown conversion (NBK-6), stage 2 is metadata extraction
 * plus the three Generated document artifacts (NBK-7), and stage 3 is
 * chunking plus embeddings (NBK-8); each handler is handed the `enqueue` for
 * the stage after it.
 */
export interface JobQueue {
  /** Enqueues ingestion stage 1 for one Document Version. */
  enqueueConvertToMarkdown(payload: ConvertToMarkdownPayload): Promise<void>;
  /**
   * Enqueues ingestion stage 2 for one Document Version. Normally called by
   * stage 1 on success rather than from outside the pipeline; exposed so a
   * Version stuck at "converted" can be re-driven without re-converting it.
   */
  enqueueSummarizeDocument(payload: SummarizeDocumentPayload): Promise<void>;
  /**
   * Enqueues ingestion stage 3 for one Document Version. Normally called by
   * stage 2 on success; exposed for the same reason — so a Version stuck at
   * "summarized" can be re-chunked and re-embedded without paying for its
   * summaries again.
   */
  enqueueEmbedChunks(payload: EmbedChunksPayload): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The dependencies a worker process needs for the whole pipeline. Stage 2's
 * and stage 3's are optional so a deployment (or a test) can work stage 1
 * alone — a backend with no OpenRouter key converts documents and stops.
 *
 * Note what is NOT here: the chaining callbacks each stage uses to hand over
 * to the next. `startJobQueue` supplies those itself, closing over the
 * pg_boss instance it just created — a caller cannot know them, and
 * shouldn't have to.
 */
export interface PipelineWorkerDeps extends Omit<
  ConvertToMarkdownDeps,
  'enqueueSummarizeDocument'
> {
  /** The OpenRouter boundary for stage 2. Omitted, stage 2 isn't worked. */
  complete?: SummarizeDocumentDeps['complete'];
  /** Fixed model per task type for stage 2. Defaults to the server config. */
  models?: SummarizeDocumentDeps['models'];
  /** The OpenRouter embeddings boundary for stage 3. Omitted, stage 3 isn't worked. */
  embed?: EmbedChunksDeps['embed'];
}

export interface StartJobQueueOptions {
  connectionString: string;
  /**
   * Dependencies for the ingestion workers. Omit to start a producer-only
   * queue (one that enqueues but works nothing) — which is what makes the
   * "enqueued before the backend started" case testable, and would let a
   * deployment separate web and worker processes later.
   */
  worker?: PipelineWorkerDeps;
  /** Extra attempts after the first. Defaults to 3. */
  retryLimit?: number;
  /** Seconds between attempts. Defaults to 10. */
  retryDelaySeconds?: number;
  /** How often a worker polls for new jobs. Defaults to pg_boss's own default. */
  pollingIntervalSeconds?: number;
  /**
   * Postgres schema pg_boss keeps its own tables in. Defaults to pg_boss's
   * `pgboss`. Set it to run independent queues against one database — which
   * is how the job-queue tests keep one test's worker from stealing
   * another's jobs.
   */
  schema?: string;
  /** Called when pg_boss itself (not a job) errors; defaults to a console warning. */
  onError?: (error: Error) => void;
}

const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 10;

/**
 * How much longer than a conversion's own timeout a job may stay active
 * before pg_boss declares it dead: enough for the download from object
 * storage, the Markdown write and the hand-over to stage 2 around it.
 */
const JOB_EXPIRY_MARGIN_SECONDS = 5 * 60;

/**
 * How long a job may stay active before pg_boss expires it and schedules a
 * retry (NBK-22). pg_boss's default is 15 minutes, which a book-length PDF
 * exceeds: the handler is not cancelled, so the Docling container runs on
 * and the Version is eventually written "converted" — but the retry pg_boss
 * already scheduled then converts the same book again, up to `retryLimit`
 * times, each one holding up the one-at-a-time worker. The expiry therefore
 * sits above the Docling timeout, derived from the same setting so the two
 * cannot drift apart. The other stages get the same value: they have no
 * hard timeout of their own, and a stage 2 summarising a 500-page book
 * makes a great many OpenRouter calls.
 */
export function jobExpirySeconds(): number {
  return Math.ceil(resolveDoclingTimeoutMs() / 1000) + JOB_EXPIRY_MARGIN_SECONDS;
}

/**
 * Starts pg_boss, ensures the stage queues exist, and (if `worker` is given)
 * registers the stage handlers.
 *
 * pg_boss owns its own `pgboss` schema and migrates it on `start()`, so this
 * deliberately sits outside the app's `src/db/migrations` chain — there is no
 * hand-written migration for the job tables to drift from pg_boss's
 * expectations.
 */
export async function startJobQueue(options: StartJobQueueOptions): Promise<JobQueue> {
  const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const retryDelay = options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;

  const boss = new PgBoss({
    connectionString: options.connectionString,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  boss.on('error', (error) => {
    if (options.onError) {
      options.onError(error);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('pg-boss error', error);
  });

  await boss.start();

  // pg_boss v10 requires a queue to exist before send/work. Creating it on
  // every start keeps each stage's retry policy declared in code rather than
  // in whatever state the database was left in. Each stage gets its own queue
  // precisely so these policies can diverge later (stage 2 is rate-limit
  // bound, stage 1 is CPU bound).
  const policy = {
    retryLimit,
    retryDelay,
    retryBackoff: retryDelay > 0,
    expireInSeconds: jobExpirySeconds(),
  };
  for (const queue of [CONVERT_TO_MARKDOWN_QUEUE, SUMMARIZE_DOCUMENT_QUEUE, EMBED_CHUNKS_QUEUE]) {
    await boss.createQueue(queue, { name: queue, ...policy });
    await boss.updateQueue(queue, { name: queue, ...policy });
  }

  const workOptions = {
    includeMetadata: true as const,
    batchSize: 1,
    ...(options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
  };

  async function enqueueSummarizeDocument(payload: SummarizeDocumentPayload): Promise<void> {
    await boss.send(SUMMARIZE_DOCUMENT_QUEUE, summarizeDocumentPayloadSchema.parse(payload));
  }

  async function enqueueEmbedChunks(payload: EmbedChunksPayload): Promise<void> {
    await boss.send(EMBED_CHUNKS_QUEUE, embedChunksPayloadSchema.parse(payload));
  }

  if (options.worker) {
    const { complete, models, embed, ...convertDeps } = options.worker;

    await boss.work<ConvertToMarkdownPayload>(
      CONVERT_TO_MARKDOWN_QUEUE,
      workOptions,
      async (jobs) => {
        for (const job of jobs) {
          // `retryCount` is 0 on the first attempt, so a retry is still
          // pending whenever it hasn't caught up with the limit. The handler
          // uses this to decide whether a failure is terminal.
          const willRetry = job.retryCount < job.retryLimit;
          await runConvertToMarkdownJob(
            // Stage 1 hands over to stage 2 through this closure — the queue
            // can't be passed into its own worker deps, so it is injected here
            // where `boss` is in scope.
            { ...convertDeps, enqueueSummarizeDocument },
            { payload: convertToMarkdownPayloadSchema.parse(job.data), willRetry },
          );
        }
      },
    );

    if (complete) {
      await boss.work<SummarizeDocumentPayload>(
        SUMMARIZE_DOCUMENT_QUEUE,
        workOptions,
        async (jobs) => {
          for (const job of jobs) {
            const willRetry = job.retryCount < job.retryLimit;
            await runSummarizeDocumentJob(
              {
                pool: convertDeps.pool,
                complete,
                ...(models === undefined ? {} : { models }),
                // Stage 2 hands over to stage 3 through this closure, for the
                // same reason stage 1 hands over to stage 2 here.
                enqueueEmbedChunks,
              },
              { payload: summarizeDocumentPayloadSchema.parse(job.data), willRetry },
            );
          }
        },
      );
    }

    if (embed) {
      await boss.work<EmbedChunksPayload>(EMBED_CHUNKS_QUEUE, workOptions, async (jobs) => {
        for (const job of jobs) {
          const willRetry = job.retryCount < job.retryLimit;
          await runEmbedChunksJob(
            { pool: convertDeps.pool, embed },
            { payload: embedChunksPayloadSchema.parse(job.data), willRetry },
          );
        }
      });
    }
  }

  return {
    async enqueueConvertToMarkdown(payload: ConvertToMarkdownPayload): Promise<void> {
      await boss.send(CONVERT_TO_MARKDOWN_QUEUE, convertToMarkdownPayloadSchema.parse(payload));
    },
    enqueueSummarizeDocument,
    enqueueEmbedChunks,
    async stop(): Promise<void> {
      await boss.stop({ wait: true });
    },
  };
}
