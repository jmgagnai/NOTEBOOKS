import { z } from 'zod';
import type { AppEventDraft } from '../events/bus.js';
import { notebookTopic } from '../events/schema.js';
import type {
  DocumentFailure,
  DocumentStatus,
  FailedAt,
  FailureReason,
} from '../documents/schema.js';

/**
 * What the three ingestion Stages have genuinely in common, and nothing else.
 *
 * Per GLOSSARY.md, Ingestion "runs as a chain of independently retryable
 * Stages" — and the emphasis is on *independently*. Their handlers look alike
 * at a glance, and most of that resemblance is real duplication worth
 * removing; but the part that differs is the part that matters, so it is worth
 * being explicit about which is which.
 *
 * **Shared, and here:**
 *
 * - the job payload, `{documentId, versionId}`, which all three carry and
 *   nothing else. Three identical Zod schemas is three places for a fourth
 *   stage to get subtly wrong.
 * - the App Event a status change is announced as. That envelope is a
 *   *published contract* — `documents.store.ts` parses it — so three copies of
 *   it is three ways for one of them to drift out of what the frontend reads.
 * - turning a caught error into a failure reason (`IngestionFailure`,
 *   `attemptFailed`, NBK-64). Users see that reason, so three ways of
 *   deciding it would be three ways to tell them different things about the
 *   same failure.
 *
 * **Not shared, deliberately:**
 *
 * - **Which status each Stage moves a Version to**, on success and on
 *   failure. Stage 1 returns a retryable failure to `queued`, stage 2 to
 *   `converted`, stage 3 to `summarized` — each to the status it *consumes*,
 *   so a retry finds exactly the state it expects. That is three different
 *   answers to the same question, each one correct only for its own Stage,
 *   and getting one wrong is silent: the pipeline stalls or re-runs an
 *   expensive earlier Stage. Each Stage names its consumed status at its own
 *   call site, where a reader of that handler can see it; only the
 *   retry-or-`failed` choice between that status and `failed` is shared
 *   (`attemptFailed`), since it is the same `willRetry` that also decides
 *   whether a reason is recorded, and two readings of it could disagree.
 * - **Each Stage's `UPDATE`**, which writes that Stage's own output columns
 *   and stamps its own completion timestamp (`converted_at`,
 *   `summarized_at`, `embedded_at`). Sharing it would mean passing SQL
 *   fragments and hand-counted placeholder offsets between modules — trading
 *   three honest statements for one that has to be read twice.
 * - **Each Stage's `SELECT`**, for the same reason: they differ in exactly
 *   the columns that Stage consumes (`storage_key` for stage 1, `markdown`
 *   for stages 2 and 3, plus the resumable summary cache for stage 2), which
 *   is the most useful thing those queries tell a reader.
 */

/**
 * The payload every ingestion job carries: ids only, never the file or its
 * bytes.
 *
 * The job table is not a place to park a 200-page document, and ids re-read
 * the current truth on every retry — which is what makes a retry safe after
 * an earlier attempt partly changed the row.
 */
export const documentVersionRefSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});

/** One Document Version, named by id. The unit of work of every Stage. */
export type DocumentVersionRef = z.infer<typeof documentVersionRefSchema>;

/** The app-event type every Document Version lifecycle change is published as. */
export const DOCUMENT_VERSION_STATUS_CHANGED = 'document-version-status-changed';

/**
 * The context a Stage needs in order to announce a transition: the Version it
 * is working on, plus the two things a client needs to recognise it.
 *
 * `notebookId` is the event's topic — a client watches one Notebook — and
 * `filename` is there because an event saying only "version 3f2a… is now
 * failed" is unusable in a notification.
 */
export interface IngestionVersion extends DocumentVersionRef {
  notebookId: string;
  filename: string;
}

/**
 * The App Event announcing that a Document Version reached `status`.
 *
 * Published inside the same transaction as the `UPDATE` it describes:
 * `pg_notify` is transactional, so a status nobody committed is never
 * announced, and an announcement is never lost after a commit.
 *
 * `failure` is included only on a final failure, so a client can treat its
 * presence as meaningful rather than having to test for null; a client that
 * sees an event without it clears whatever reason it showed before, which is
 * what a New Version leaving `failed` needs (NBK-67).
 *
 * The raw error text is deliberately not here (NBK-67). It is written for
 * developers, can carry a subprocess's whole captured output, and no client
 * read it; the user is told the `failure` reason instead, and the full text
 * stays on the Version row (`ingestion_error`). Per ADR-0004 an event carries
 * *what changed* and never bulk data — a NOTIFY payload has to stay well
 * inside Postgres's 8000-byte cap — which is also why nothing here carries
 * Markdown, a summary, or metadata. Carrying the raw text once let a
 * Docling traceback blow that cap inside the transaction recording the
 * failure, so the failure was never recorded; a reason cannot.
 */
export function versionStatusChanged(
  version: IngestionVersion,
  status: DocumentStatus,
  failure?: DocumentFailure | null,
): AppEventDraft {
  return {
    type: DOCUMENT_VERSION_STATUS_CHANGED,
    topic: notebookTopic(version.notebookId),
    data: {
      notebookId: version.notebookId,
      documentId: version.documentId,
      versionId: version.versionId,
      filename: version.filename,
      status,
      ...(failure ? { failure } : {}),
    },
  };
}

/**
 * A Stage's error that knows why, in user terms, the work could not be done
 * (NBK-63).
 *
 * Raised where the cause is recognised — the converter seeing a scan, a
 * provider call failing — so the reason is decided at the source instead of
 * guessed later from the message, which is written for developers and free
 * to change. Anything thrown that is not one of these is recorded as
 * `unexpected`.
 */
export class IngestionFailure extends Error {
  override readonly name = 'IngestionFailure';

  constructor(
    readonly reason: FailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * What a Stage writes when an attempt throws: the status to move the Version
 * to, the full error for operators, and the failure reason for users.
 */
export interface AttemptFailure {
  /** The Stage's consumed status while a retry is pending, `failed` once none is. */
  status: DocumentStatus;
  error: string;
  /** Null while a retry is pending: only the final transition to `failed` carries a reason. */
  failure: DocumentFailure | null;
}

/**
 * Turns what a Stage caught into what it records, given whether pg_boss will
 * retry, the Stage's consumed status (where a retry has to find the Version)
 * and the step it was working in.
 *
 * The one place a thrown error becomes a failure reason, shared by all three
 * Stages so a new classification is a new `IngestionFailure` at its source and
 * nothing here. It also picks the status, from the same `willRetry`, so the
 * status and the reason cannot disagree — a reason on a Version that is not
 * `failed` is exactly what migration 0012 refuses. Each Stage writes the
 * result in its own `UPDATE`, setting the reason columns on every transition,
 * so moving to any status but `failed` clears them.
 */
export function attemptFailed(
  err: unknown,
  {
    willRetry,
    retryStatus,
    failedAt,
  }: { willRetry: boolean; retryStatus: DocumentStatus; failedAt: FailedAt },
): AttemptFailure {
  const error = err instanceof Error ? err.message : String(err);
  if (willRetry) return { status: retryStatus, error, failure: null };
  const reason = err instanceof IngestionFailure ? err.reason : 'unexpected';
  return { status: 'failed', error, failure: { reason, failedAt } };
}
