import type { Pool, PoolClient } from "pg";
import type { ResolvedCitation } from "./citations.js";
import type { ChatMessage, ChatMessageRole, ChatThread, Citation } from "./schema.js";

interface ChatThreadRow {
  id: string;
  notebook_id: string;
  title: string;
  created_at: Date;
  author_id: string;
  author_email: string;
}

interface ChatMessageRow {
  id: string;
  chat_thread_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: Date;
  asked_by_id: string;
  asked_by_email: string;
}

// Threads always come back with their author's email joined in: attribution
// is the point of the column (ADR-0001), and a bare uuid tells a reader
// nothing.
const SELECT_THREAD = `
  SELECT t.id, t.notebook_id, t.title, t.created_at,
         u.id AS author_id, u.email AS author_email
  FROM chat_threads t
  JOIN users u ON u.id = t.created_by
`;

const SELECT_MESSAGE = `
  SELECT m.id, m.chat_thread_id, m.role, m.content, m.created_at,
         u.id AS asked_by_id, u.email AS asked_by_email
  FROM chat_messages m
  JOIN users u ON u.id = m.asked_by
`;

function toChatThread(row: ChatThreadRow): ChatThread {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    author: { id: row.author_id, email: row.author_email },
    createdAt: row.created_at.toISOString(),
  };
}

interface CitationRow {
  id: string;
  chat_message_id: string;
  marker: number;
  document_id: string;
  document_version_id: string;
  version_number: number;
  chunk_id: string;
  filename: string;
  heading_path: string[];
  char_start: number | null;
  char_end: number | null;
}

/**
 * A message's Citations, with everything a reader needs to recognise and
 * open the source.
 *
 * Note what is joined and what is not: `version_number`, `filename` and
 * `heading_path` are read off the *pinned* Version and chunk — the ones whose
 * ids are stored on the row — never off the Document's current Version. That
 * is the difference between "the source this answer used" and "whatever that
 * file says now", and GLOSSARY.md requires the former ("even after newer
 * Versions exist"). The join deliberately does not filter on `deleted_at`
 * either: a soft-deleted Document's past answers stay checkable.
 *
 * Raw SQL per ADR-0003.
 */
const SELECT_CITATIONS = `
  SELECT ci.id, ci.chat_message_id, ci.marker,
         v.document_id, ci.document_version_id, v.version_number,
         ci.chunk_id, d.filename, c.heading_path,
         ci.char_start, ci.char_end
  FROM citations ci
  JOIN chunks c ON c.id = ci.chunk_id
  JOIN document_versions v ON v.id = ci.document_version_id
  JOIN documents d ON d.id = v.document_id
  WHERE ci.chat_message_id = ANY($1::uuid[])
  ORDER BY ci.chat_message_id, ci.marker
`;

function toCitation(row: CitationRow): Citation {
  return {
    id: row.id,
    marker: row.marker,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    versionNumber: row.version_number,
    chunkId: row.chunk_id,
    filename: row.filename,
    headingPath: row.heading_path,
    charStart: row.char_start,
    charEnd: row.char_end,
  };
}

/** Groups Citations by the message they belong to, ordered by marker. */
async function citationsByMessage(
  db: Pool | PoolClient,
  messageIds: string[],
): Promise<Map<string, Citation[]>> {
  const grouped = new Map<string, Citation[]>();
  if (messageIds.length === 0) return grouped;

  const { rows } = await db.query<CitationRow>(SELECT_CITATIONS, [messageIds]);
  for (const row of rows) {
    const list = grouped.get(row.chat_message_id) ?? [];
    list.push(toCitation(row));
    grouped.set(row.chat_message_id, list);
  }
  return grouped;
}

function toChatMessage(row: ChatMessageRow, citations: Citation[] = []): ChatMessage {
  return {
    id: row.id,
    threadId: row.chat_thread_id,
    role: row.role,
    content: row.content,
    askedBy: { id: row.asked_by_id, email: row.asked_by_email },
    citations,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Lists every Chat Thread in a Notebook, newest first.
 *
 * Deliberately unfiltered by author. Per GLOSSARY.md a Thread is "visible to
 * every user who opens the Notebook", and NBK-10 asks for "every thread in a
 * Notebook regardless of who started it" — so the asking user is not even a
 * parameter here. Raw SQL per ADR-0003.
 */
export async function listChatThreads(pool: Pool, notebookId: string): Promise<ChatThread[]> {
  const { rows } = await pool.query<ChatThreadRow>(
    `${SELECT_THREAD} WHERE t.notebook_id = $1 ORDER BY t.created_at DESC, t.id DESC`,
    [notebookId],
  );
  return rows.map(toChatThread);
}

/** Creates a Chat Thread, recording `authorId` as its author. */
export async function createChatThread(
  pool: Pool,
  notebookId: string,
  title: string,
  authorId: string,
): Promise<ChatThread> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO chat_threads (notebook_id, title, created_by) VALUES ($1, $2, $3) RETURNING id",
    [notebookId, title, authorId],
  );
  const thread = await findChatThread(pool, notebookId, rows[0].id);
  if (!thread) throw new Error("Chat Thread vanished immediately after it was created.");
  return thread;
}

/**
 * One Chat Thread, scoped to its Notebook. Per ADR-0001 there is no author
 * check: any authenticated user may open any Thread. Returns `null` if no
 * match (caller maps this to 404).
 */
export async function findChatThread(
  pool: Pool,
  notebookId: string,
  threadId: string,
): Promise<ChatThread | null> {
  const { rows } = await pool.query<ChatThreadRow>(
    `${SELECT_THREAD} WHERE t.id = $1 AND t.notebook_id = $2`,
    [threadId, notebookId],
  );
  return rows[0] ? toChatThread(rows[0]) : null;
}

/**
 * Renames a Chat Thread. Per ADR-0001 there is no author check — a Thread
 * someone else started is renameable, the same way any user may rename any
 * Notebook. Returns `null` if no match (caller maps this to 404).
 */
export async function renameChatThread(
  pool: Pool,
  notebookId: string,
  threadId: string,
  title: string,
): Promise<ChatThread | null> {
  const { rowCount } = await pool.query(
    "UPDATE chat_threads SET title = $3 WHERE id = $1 AND notebook_id = $2",
    [threadId, notebookId, title],
  );
  if (rowCount !== 1) return null;
  return findChatThread(pool, notebookId, threadId);
}

/**
 * Every message in a Thread, in conversation order.
 *
 * Ordered by `seq`, not `created_at`: a question and its answer are written
 * in one transaction and so share a timestamp (see migration 0009).
 */
export async function listChatMessages(pool: Pool, threadId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query<ChatMessageRow>(
    `${SELECT_MESSAGE} WHERE m.chat_thread_id = $1 ORDER BY m.seq ASC`,
    [threadId],
  );
  // One extra query for the whole Thread's Citations rather than one per
  // message: a long Thread is read on every page load.
  const citations = await citationsByMessage(
    pool,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toChatMessage(row, citations.get(row.id) ?? []));
}

const INSERT_MESSAGE = `
  WITH inserted AS (
    INSERT INTO chat_messages (chat_thread_id, asked_by, role, content)
    VALUES ($1, $2, $3, $4)
    RETURNING id, chat_thread_id, role, content, created_at, asked_by
  )
  SELECT i.id, i.chat_thread_id, i.role, i.content, i.created_at,
         u.id AS asked_by_id, u.email AS asked_by_email
  FROM inserted i
  JOIN users u ON u.id = i.asked_by
`;

/**
 * Appends a question, the answer it produced, and that answer's Citations,
 * in one transaction.
 *
 * One transaction because a Thread must never hold a question with no answer
 * or an answer with no question — a reader of a shared Thread would have no
 * way to tell a half-written exchange from one where the model said nothing.
 * The Citations join that same transaction for the same reason, one step
 * stronger: an answer whose sources are missing *looks* ungrounded, and the
 * markers in its prose would point at nothing. "Persisted alongside the
 * message" (NBK-12) means atomically with it, not merely soon after.
 * Both rows record `askerId`: for the question that is who typed it, for the
 * answer it is whose question produced it (see migration 0009).
 *
 * Two statements rather than one two-row `VALUES`, so the `seq` the question
 * gets is unambiguously lower than the answer's — a conversation's order is
 * read back from that column, not from a timestamp the two rows share.
 */
export async function appendQuestionAndAnswer(
  pool: Pool,
  threadId: string,
  askerId: string,
  question: string,
  answer: string,
  citations: ResolvedCitation[] = [],
): Promise<{ question: ChatMessage; answer: ChatMessage }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const questionRows = await client.query<ChatMessageRow>(INSERT_MESSAGE, [
      threadId,
      askerId,
      "user",
      question,
    ]);
    const answerRows = await client.query<ChatMessageRow>(INSERT_MESSAGE, [
      threadId,
      askerId,
      "assistant",
      answer,
    ]);
    const answerId = answerRows.rows[0].id;

    for (const citation of citations) {
      await client.query(
        `INSERT INTO citations
           (chat_message_id, document_version_id, chunk_id, marker, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          answerId,
          // The Version id as retrieved, written down rather than looked up
          // later: this is the pin that keeps an old answer checkable after a
          // re-upload (GLOSSARY.md, Citation).
          citation.chunk.documentVersionId,
          citation.chunk.chunkId,
          citation.marker,
          citation.charStart,
          citation.charEnd,
        ],
      );
    }

    // Read the Citations back through the same query the list endpoint uses,
    // inside the transaction, so the answer returned from an ask and the one
    // a later reload fetches are the same object rather than two shapes
    // assembled in two places.
    const written = await citationsByMessage(client, [answerId]);
    await client.query("COMMIT");

    return {
      question: toChatMessage(questionRows.rows[0]),
      answer: toChatMessage(answerRows.rows[0], written.get(answerId) ?? []),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
