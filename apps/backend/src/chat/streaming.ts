import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { publishAppEvent } from '../events/bus.js';
import { notebookTopic } from '../events/schema.js';
import type { Citation } from './schema.js';

/**
 * The three app-event types a streamed answer travels as (NBK-11).
 *
 * They ride the generic channel built in NBK-6 — one `pg_notify` channel, one
 * `GET /events` endpoint, one envelope — which ADR-0004 set up for exactly
 * this: "Later features — chat answer streaming, other background-task
 * progress — publish onto it without new transport."
 *
 * Hyphen-namespaced like `document-version-status-changed`, and published on
 * the Notebook's topic rather than a per-request one, because a Chat Thread
 * is shared (GLOSSARY.md): everyone with the Notebook open watches the same
 * answer arrive, and a client that cares about only one Thread filters on the
 * `threadId` in the payload.
 */
export const CHAT_ANSWER_CHUNK = 'chat-answer-chunk';
export const CHAT_ANSWER_COMPLETED = 'chat-answer-completed';
export const CHAT_ANSWER_FAILED = 'chat-answer-failed';

/**
 * The ceiling on one chunk's characters.
 *
 * Two jobs. First, progressive delivery has to survive a model that writes
 * one enormous unbroken paragraph — without a cap that answer would arrive as
 * a single chunk at the very end, which is the behaviour NBK-11 exists to
 * replace. Second, and harder, every chunk becomes a Postgres NOTIFY payload,
 * which ADR-0004 caps at {@link MAX_APP_EVENT_PAYLOAD_BYTES} (7000 bytes);
 * 1200 characters leaves room for the envelope even if every one of them is a
 * 4-byte emoji, so no legitimate answer can ever fail to publish.
 *
 * It is a backstop, not the granularity: paragraph and heading boundaries
 * come first and are what a reader actually sees.
 */
export const MAX_CHUNK_CHARS = 1200;

/** A Markdown ATX heading line: `## Revenue`. Its own chunk, always. */
const HEADING_LINE = /^[ \t]{0,3}#{1,6}([ \t]|$)/;

/** A fenced code block's delimiter, ``` or ~~~. */
const FENCE_LINE = /^[ \t]{0,3}(```|~~~)/;

/** A line with nothing on it: the Markdown paragraph break. */
const BLANK_LINE = /^[ \t]*$/;

/**
 * Turns a model's token stream into the pieces a reader is shown.
 *
 * This is the whole product decision NBK-1 records twice — "answers stream
 * back in paragraph/heading-sized increments", "without a jarring word-by-word
 * flicker" — and it lives here rather than in the OpenRouter client because
 * it is about reading, not about transport.
 *
 * Deltas go in; chunks come out, each one a complete block of Markdown:
 *
 * - a heading is released on its own, as soon as its line is complete;
 * - a paragraph is released when the blank line after it arrives — or when
 *   the next heading starts, since models are inconsistent about leaving a
 *   blank line before one;
 * - a fenced code block is held until its closing fence, because half a
 *   fence renders as garbage;
 * - anything that outgrows {@link MAX_CHUNK_CHARS} is released at the last
 *   word boundary under the cap.
 *
 * Nothing is ever released early, so a chunk never has to be corrected or
 * re-sent — which is what lets the client append blindly and what keeps an
 * App Event a statement about something that already happened.
 */
export interface AnswerChunker {
  /** Takes one provider delta; returns whatever chunks it completed. */
  push(delta: string): string[];
  /** Releases the final, unterminated block. Call once, at end of stream. */
  flush(): string[];
}

/** Drops leading whitespace-only lines, which belong to no block. */
function dropLeadingBlankLines(text: string): string {
  let at = 0;
  for (;;) {
    const newline = text.indexOf('\n', at);
    if (newline === -1) break;
    if (!BLANK_LINE.test(text.slice(at, newline))) break;
    at = newline + 1;
  }
  return at === 0 ? text : text.slice(at);
}

/** A chunk as it goes on the wire: no trailing blank space, never empty. */
function present(block: string): string | null {
  const trimmed = block.replace(/\s+$/, '');
  return trimmed === '' ? null : trimmed;
}

export function createAnswerChunker(maxChars = MAX_CHUNK_CHARS): AnswerChunker {
  let buffer = '';
  // Fence state spans deltas *and* chunks: a code block that survives a
  // forced cap-cut is still open on the next line.
  let insideFence = false;

  /**
   * The index to cut `buffer` at, or null while no block is complete.
   *
   * Scans only *terminated* lines: an unfinished last line could still turn
   * out to be a heading or a fence, and cutting before knowing that is how a
   * half-written block escapes.
   */
  function boundary(): number | null {
    let at = 0;
    for (;;) {
      const newline = buffer.indexOf('\n', at);
      if (newline === -1) break;
      const line = buffer.slice(at, newline);
      const end = newline + 1;

      if (FENCE_LINE.test(line)) {
        insideFence = !insideFence;
        // A closed fence is a finished block, so it is also a boundary.
        if (!insideFence) return end;
        at = end;
        continue;
      }
      if (insideFence) {
        at = end;
        continue;
      }
      if (HEADING_LINE.test(line)) {
        // At the front it is its own chunk; further in it terminates
        // whatever came before it.
        return at === 0 ? end : at;
      }
      if (BLANK_LINE.test(line)) {
        // Can only happen past the start: leading blanks are dropped before
        // this runs.
        if (at > 0) return at;
      }
      at = end;
    }

    // No block boundary in sight. Hold on unless the cap forces a cut, and
    // then cut at the last word boundary under it, so no word is split in
    // half. The cut lands *after* that whitespace, so the run is trimmed off
    // the chunk being released rather than left leading the next one.
    if (buffer.length < maxChars) return null;
    const lastGap = /\s+\S*$/.exec(buffer.slice(0, maxChars));
    if (!lastGap || lastGap.index === 0) return maxChars;
    return lastGap.index + /^\s+/.exec(lastGap[0])![0].length;
  }

  function drain(): string[] {
    const chunks: string[] = [];
    for (;;) {
      buffer = dropLeadingBlankLines(buffer);
      const at = boundary();
      if (at === null) return chunks;
      const chunk = present(buffer.slice(0, at));
      buffer = buffer.slice(at);
      if (chunk) chunks.push(chunk);
    }
  }

  return {
    push(delta: string): string[] {
      // Normalised so the line scanning above only has to know about "\n";
      // a \r surviving into a chunk would also be noise on the wire.
      buffer += delta.replace(/\r\n/g, '\n');
      return drain();
    },

    flush(): string[] {
      // The last line has no newline, so the scanner cannot see it. Ending
      // the buffer with one makes the final block complete and lets the same
      // rules apply to it as to every block before it — including a closing
      // fence the model never wrote.
      if (buffer !== '' && !buffer.endsWith('\n')) buffer += '\n';
      insideFence = false;
      const chunks = drain();
      const last = present(buffer);
      buffer = '';
      if (last) chunks.push(last);
      return chunks;
    },
  };
}

/**
 * Publishes one answer's progress onto the app-event channel.
 *
 * `streamId` is minted here, before the answer exists, because the thing
 * being streamed has no `chat_messages` row until it is finished — the row is
 * written once, at the end (NBK-11). Clients group chunks by it and learn the
 * row's id from the completion event.
 */
export interface AnswerStream {
  readonly streamId: string;
  /** Announces one rendered chunk. Index is the chunk's position, from 0. */
  chunk(text: string): Promise<void>;
  /** Announces the persisted answer, with the Citations resolved for it. */
  completed(answer: {
    messageId: string;
    questionId: string;
    citations: Citation[];
  }): Promise<void>;
  /** Announces that the answer will never arrive, so a preview can be dropped. */
  failed(reason: string): Promise<void>;
}

export interface AnswerStreamTarget {
  notebookId: string;
  threadId: string;
}

export function createAnswerStream(
  pool: Pool,
  { notebookId, threadId }: AnswerStreamTarget,
): AnswerStream {
  const streamId = randomUUID();
  let index = 0;

  /** The fields every one of this answer's events carries. */
  const identity = { notebookId, threadId, streamId };
  const topic = notebookTopic(notebookId);

  return {
    streamId,

    async chunk(text: string): Promise<void> {
      await publishAppEvent(pool, {
        type: CHAT_ANSWER_CHUNK,
        topic,
        // `index` so a client can order chunks and, more importantly, notice
        // that it joined mid-answer (a first chunk whose index isn't 0) and
        // re-read the Thread instead of rendering a mutilated answer.
        data: { ...identity, index: index++, text },
      });
    },

    async completed({ messageId, questionId, citations }): Promise<void> {
      // Citations ride the completion event because they can only be
      // resolved from the *complete* text (NBK-12 resolves the markers the
      // model wrote), so there was no earlier event they could have
      // travelled on — and a client rendering chunks would otherwise show a
      // finished answer whose markers link nowhere.
      try {
        await publishAppEvent(pool, {
          type: CHAT_ANSWER_COMPLETED,
          topic,
          data: { ...identity, messageId, questionId, citations },
        });
      } catch {
        // A dozen Citations with long filenames and deep heading paths can
        // in principle outgrow the NOTIFY cap ADR-0004 sets. The event
        // itself must still arrive — it is what tells clients the answer is
        // final — so it goes out without them, and the client falls back on
        // the rule the ADR states anyway: an event is a hint, the REST
        // routes are the truth.
        await publishAppEvent(pool, {
          type: CHAT_ANSWER_COMPLETED,
          topic,
          data: { ...identity, messageId, questionId },
        });
      }
    },

    async failed(reason: string): Promise<void> {
      await publishAppEvent(pool, {
        type: CHAT_ANSWER_FAILED,
        topic,
        // No prose: the half-written answer is not a message and never will
        // be, so there is nothing for a client to keep. The reason is for a
        // human reading logs or a banner, not for reassembly.
        data: { ...identity, reason },
      });
    },
  };
}
