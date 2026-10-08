import type { DocumentFailure } from '../api/models';

/** Why a Document's latest Version failed Ingestion, as the backend classified it (NBK-63). */
export type FailureReason = DocumentFailure['reason'];

/**
 * One plain sentence per failure reason, saying what went wrong and what the
 * user can do about it (spec NBK-63). The one place this wording lives, for
 * the Documents panel's warning and the Document page alike (NBK-68).
 *
 * A `Record` over the generated contract's union, so a reason the backend
 * adds fails the typecheck here after `pnpm run openapi:generate` instead of
 * reaching a user as a blank tooltip.
 */
export const FAILURE_SENTENCES: Record<FailureReason, string> = {
  'no-text-layer':
    'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
  unreadable: 'This file could not be read. Check that it opens correctly, then upload it again.',
  'timed-out': 'Converting this file took too long. Try a smaller file, or split it.',
  'service-unavailable':
    'A service Copycat Notebooks relies on was unavailable. Try uploading a New Version later.',
  unexpected: 'Something went wrong on our side while ingesting this Document.',
};

/**
 * The sentence for a failed Document. Falls back to `unexpected` when there
 * is no reason to read — a status App Event can mark a row failed before it
 * carries one (NBK-67), and a reason newer than this build is still a
 * failure — so a failed row never shows an empty tooltip.
 */
export function failureSentence(failure: DocumentFailure | null): string {
  return (failure && FAILURE_SENTENCES[failure.reason]) ?? FAILURE_SENTENCES.unexpected;
}
