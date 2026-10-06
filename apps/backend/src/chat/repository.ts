import type { Pool, PoolClient } from "pg";
import type { ChatMessage, ChatMessageRole, ChatThread } from "./schema.js";

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

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.chat_thread_id,
    role: row.role,
    content: row.content,
    askedBy: { id: row.asked_by_id, email: row.asked_by_email },
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
  return rows.map(toChatMessage);
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
 * Appends a question and the answer it produced, in one transaction.
 *
 * One transaction because a Thread must never hold a question with no answer
 * or an answer with no question — a reader of a shared Thread would have no
 * way to tell a half-written exchange from one where the model said nothing.
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
    await client.query("COMMIT");

    return {
      question: toChatMessage(questionRows.rows[0]),
      answer: toChatMessage(answerRows.rows[0]),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
