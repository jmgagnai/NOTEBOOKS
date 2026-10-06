import PgBoss from "pg-boss";
import {
  CONVERT_TO_MARKDOWN_QUEUE,
  convertToMarkdownPayloadSchema,
  runConvertToMarkdownJob,
  type ConvertToMarkdownDeps,
  type ConvertToMarkdownPayload,
} from "../ingestion/convert-to-markdown.js";

/**
 * Background jobs run on pg_boss against the same Postgres instance as
 * everything else (NBK-6): the jobs live in a table, so a job enqueued before
 * a restart is still there afterwards, and a job can be enqueued inside the
 * same database the row it is about lives in. No extra broker to operate.
 *
 * The pipeline is one queue *per stage*, not one job that does everything. A
 * stage that fails is retried on its own, and on success a stage enqueues the
 * next — so a later stage's bug never re-runs an expensive earlier stage.
 * This ticket implements the first stage only (convert to Markdown); the
 * chaining hook is `JobQueue.enqueue*` being callable from inside a handler.
 */
export interface JobQueue {
  /** Enqueues ingestion stage 1 for one Document Version. */
  enqueueConvertToMarkdown(payload: ConvertToMarkdownPayload): Promise<void>;
  stop(): Promise<void>;
}

export interface StartJobQueueOptions {
  connectionString: string;
  /**
   * Dependencies for the convert-to-Markdown worker. Omit to start a
   * producer-only queue (one that enqueues but works nothing) — which is what
   * makes the "enqueued before the backend started" case testable, and would
   * let a deployment separate web and worker processes later.
   */
  worker?: ConvertToMarkdownDeps;
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
  boss.on("error", (error) => {
    if (options.onError) {
      options.onError(error);
      return;
    }
    // eslint-disable-next-line no-console
    console.error("pg-boss error", error);
  });

  await boss.start();
  // pg_boss v10 requires a queue to exist before send/work. Creating it on
  // every start keeps its retry policy declared in code rather than in
  // whatever state the database was left in.
  await boss.createQueue(CONVERT_TO_MARKDOWN_QUEUE, {
    name: CONVERT_TO_MARKDOWN_QUEUE,
    retryLimit,
    retryDelay,
    retryBackoff: retryDelay > 0,
  });
  await boss.updateQueue(CONVERT_TO_MARKDOWN_QUEUE, {
    name: CONVERT_TO_MARKDOWN_QUEUE,
    retryLimit,
    retryDelay,
    retryBackoff: retryDelay > 0,
  });

  if (options.worker) {
    const deps = options.worker;
    await boss.work<ConvertToMarkdownPayload>(
      CONVERT_TO_MARKDOWN_QUEUE,
      {
        includeMetadata: true,
        batchSize: 1,
        ...(options.pollingIntervalSeconds === undefined
          ? {}
          : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
      },
      async (jobs) => {
        for (const job of jobs) {
          // `retryCount` is 0 on the first attempt, so a retry is still
          // pending whenever it hasn't caught up with the limit. The handler
          // uses this to decide whether a failure is terminal.
          const willRetry = job.retryCount < job.retryLimit;
          await runConvertToMarkdownJob(deps, {
            payload: convertToMarkdownPayloadSchema.parse(job.data),
            willRetry,
          });
        }
      },
    );
  }

  return {
    async enqueueConvertToMarkdown(payload: ConvertToMarkdownPayload): Promise<void> {
      await boss.send(CONVERT_TO_MARKDOWN_QUEUE, convertToMarkdownPayloadSchema.parse(payload));
    },
    async stop(): Promise<void> {
      await boss.stop({ wait: true });
    },
  };
}
