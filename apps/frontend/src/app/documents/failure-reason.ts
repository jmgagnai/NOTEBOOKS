import type { DocumentFailure } from '../api/models';

/** Why a Document's latest Version failed Ingestion, as the backend classified it (NBK-63). */
export type FailureReason = DocumentFailure['reason'];

/**
 * The Ingestion step a Version failed in, or null when that was not recorded.
 * Its values are GLOSSARY's status names, so they read as the step in a
 * sentence as they are.
 */
type FailedAt = DocumentFailure['failedAt'];

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One plain sentence per failure reason, saying what went wrong and what the
 * user can do about it (spec NBK-63). The one place this wording lives, for
 * the Documents panel's warning and the Document page alike (NBK-68).
 *
 * Two of them name the step that failed, because spec NBK-63 asks for which
 * part of Ingestion failed "when that helps": for `unexpected` it tells the
 * user (and anyone they report it to) how far their Document got, and a
 * timeout is only "too long" relative to the step that ran out of time. The
 * others are about the file or the service, whichever step met them. A null
 * `failedAt` — a failure recorded before reasons existed — keeps the older
 * wording: no step for `unexpected`, and converting for a timeout, the only
 * step that had one then.
 *
 * A `Record` over the generated contract's union, so a reason the backend
 * adds fails the typecheck here after `pnpm run openapi:generate` instead of
 * reaching a user as a blank tooltip.
 */
const FAILURE_SENTENCES: Record<FailureReason, (failedAt: FailedAt) => string> = {
  'no-text-layer': () =>
    'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
  unreadable: () =>
    'This file could not be read. Check that it opens correctly, then upload it again.',
  'timed-out': (failedAt) =>
    `${capitalized(failedAt ?? 'converting')} this file took too long. Try a smaller file, or split it.`,
  'service-unavailable': () =>
    'A service Copycat Notebooks relies on was unavailable. Try uploading a New Version later.',
  unexpected: (failedAt) =>
    failedAt
      ? `Something went wrong on our side while ${failedAt} this Document.`
      : 'Something went wrong on our side while ingesting this Document.',
};

/**
 * The sentence for a failed Document. Falls back to `unexpected` when there
 * is no reason to read — a status App Event can mark a row failed before it
 * carries one (NBK-67), and a reason newer than this build is still a
 * failure — so a failed row never shows an empty tooltip.
 */
export function failureSentence(failure: DocumentFailure | null): string {
  const sentence = failure && FAILURE_SENTENCES[failure.reason];
  return sentence ? sentence(failure.failedAt) : FAILURE_SENTENCES.unexpected(null);
}
