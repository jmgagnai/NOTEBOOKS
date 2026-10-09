import type { Pool } from 'pg';
import { notebookIsActive } from '../notebooks/active-notebooks.js';
import {
  headlineOptions,
  namesAWord,
  segments,
  TEXT_SEARCH_CONFIG,
  withoutTags,
} from './keywords.js';
import type { ExchangeSearchResult } from './schema.js';

/** The most Exchanges one Chat Thread search returns (NBK-97). */
export const EXCHANGE_RESULT_LIMIT = 20;

/**
 * Keyword search over a Notebook's Chat Threads (NBK-97), one result per
 * matching **Exchange** (GLOSSARY.md): a hit on a question pairs with the
 * answer after it, a hit on an answer with the question before it, and an
 * Exchange both halves of which match is one result, ranked by the two
 * together. Full-text on `simple_unaccent` (accents and case ignored), on
 * the expression migration 0015 indexes. Deleted Chat Threads and Notebooks
 * are left out.
 */
const SEARCH_EXCHANGES_SQL = `
  WITH q AS (SELECT websearch_to_tsquery('${TEXT_SEARCH_CONFIG}', $2) AS query),
  hits AS (
    SELECT m.id, m.chat_thread_id, m.role, m.seq,
           ts_rank(to_tsvector('${TEXT_SEARCH_CONFIG}', m.content), q.query) AS rank
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.chat_thread_id
    CROSS JOIN q
    WHERE t.notebook_id = $1 AND t.deleted_at IS NULL
      AND ${notebookIsActive('t.notebook_id')}
      AND to_tsvector('${TEXT_SEARCH_CONFIG}', m.content) @@ q.query
  ),
  pairs AS (
    SELECT h.chat_thread_id, h.rank,
      CASE WHEN h.role = 'user' THEN h.id ELSE (
        SELECT p.id FROM chat_messages p
        WHERE p.chat_thread_id = h.chat_thread_id AND p.role = 'user' AND p.seq < h.seq
        ORDER BY p.seq DESC LIMIT 1
      ) END AS question_id,
      CASE WHEN h.role = 'assistant' THEN h.id ELSE (
        SELECT n.id FROM chat_messages n
        WHERE n.chat_thread_id = h.chat_thread_id AND n.role = 'assistant' AND n.seq > h.seq
        ORDER BY n.seq ASC LIMIT 1
      ) END AS answer_id
    FROM hits h
  ),
  exchanges AS (
    SELECT chat_thread_id, question_id, answer_id, SUM(rank) AS rank
    FROM pairs
    WHERE question_id IS NOT NULL AND answer_id IS NOT NULL
    GROUP BY chat_thread_id, question_id, answer_id
  )
  SELECT
    e.chat_thread_id, t.title AS thread_title,
    e.question_id, e.answer_id, qm.created_at AS asked_at,
    u.id AS asker_id, u.email AS asker_email,
    ts_headline('${TEXT_SEARCH_CONFIG}', ${withoutTags('qm.content')}, q.query, $4) AS question,
    ts_headline('${TEXT_SEARCH_CONFIG}', ${withoutTags('am.content')}, q.query, $5) AS answer
  FROM exchanges e
  JOIN chat_threads t ON t.id = e.chat_thread_id
  JOIN chat_messages qm ON qm.id = e.question_id
  JOIN chat_messages am ON am.id = e.answer_id
  JOIN users u ON u.id = qm.asked_by
  CROSS JOIN q
  ORDER BY e.rank DESC, qm.seq DESC
  LIMIT $3
`;

// The question is short and shown whole; the answer as up to two fragments
// around the matches, about two lines.
const QUESTION_HEADLINE = headlineOptions('HighlightAll=true');
const ANSWER_HEADLINE = headlineOptions(
  'MaxFragments=2, MaxWords=24, MinWords=10, FragmentDelimiter=" … "',
);

interface ExchangeRow {
  chat_thread_id: string;
  thread_title: string;
  question_id: string;
  answer_id: string;
  asked_at: Date;
  asker_id: string;
  asker_email: string;
  question: string;
  answer: string;
}

export async function searchExchanges(
  pool: Pool,
  notebookId: string,
  query: string,
): Promise<ExchangeSearchResult[]> {
  if (!(await namesAWord(pool, query))) return [];
  const { rows } = await pool.query<ExchangeRow>(SEARCH_EXCHANGES_SQL, [
    notebookId,
    query,
    EXCHANGE_RESULT_LIMIT,
    QUESTION_HEADLINE,
    ANSWER_HEADLINE,
  ]);
  return rows.map((row) => ({
    threadId: row.chat_thread_id,
    threadTitle: row.thread_title,
    askedBy: { id: row.asker_id, email: row.asker_email },
    askedAt: row.asked_at.toISOString(),
    questionId: row.question_id,
    answerId: row.answer_id,
    question: segments(row.question),
    answer: segments(row.answer),
  }));
}
