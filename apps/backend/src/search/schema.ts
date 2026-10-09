import { z } from 'zod';

export const searchNotebookParamsSchema = z.object({
  notebookId: z.string().uuid(),
});
export type SearchNotebookParams = z.infer<typeof searchNotebookParamsSchema>;

/**
 * `exact=true` searches the words as typed (NBK-105). Otherwise a word the
 * Notebook does not hold is corrected to its closest word.
 */
const exactSchema = z
  .enum(['true', 'false'])
  .default('false')
  .describe("'true' to search the words as typed, with no correction of misspelt words.");

export const searchNotebookQuerySchema = z.object({
  q: z
    .string()
    .max(1000)
    .default('')
    .describe(
      'Keywords, matched literally in the Chunks of each latest ready Version, accents and ' +
        'case ignored; web-search syntax ("a phrase", -word, or). Blank returns no results.',
    ),
  exact: exactSchema,
});
export type SearchNotebookQuery = z.infer<typeof searchNotebookQuerySchema>;

/** What both searches answer with: the results, and the query searched when it was corrected. */
function searchResponse<T extends z.ZodTypeAny>(result: T) {
  return z.object({
    correctedQuery: z
      .string()
      .nullable()
      .describe(
        'The query actually searched, its misspelt words corrected to words the Notebook ' +
          'holds; null when it was searched as typed.',
      ),
    words: z
      .array(z.string())
      .describe(
        'The words searched for — as corrected, without `or` or excluded words — to mark ' +
          'where a result opens.',
      ),
    results: z.array(result),
  });
}

/** A run of an Excerpt, `match` when it is one of the searched words. Text, never markup. */
export const textSegmentSchema = z.object({ text: z.string(), match: z.boolean() });
export type TextSegment = z.infer<typeof textSegmentSchema>;

// Where a matching Chunk sits (NBK-96): the same pin a Citation carries, so a
// result links to the Document page the way a Citation does and opens its
// Converted Markdown at that Chunk.
export const searchMatchSchema = z
  .object({
    versionId: z.string().uuid().describe('The Document Version the Chunk belongs to.'),
    chunkId: z.string().uuid().describe('The matching Chunk.'),
    charStart: z
      .number()
      .int()
      .nullable()
      .describe(
        "Start of the Chunk in the Version's Converted Markdown; null when it could not be located.",
      ),
    charEnd: z.number().int().nullable().describe('End of that range, exclusive.'),
  })
  .describe('Where the matching Chunk sits — what opening the result shows.');

// One search hit (NBK-104): a Chunk, not a Document — a reader looks for the
// places a word occurs, so a Document appears once per Chunk that holds it.
export const documentSearchResultSchema = z
  .object({
    documentId: z.string().uuid(),
    filename: z.string(),
    title: z
      .string()
      .nullable()
      .describe('The title Stage 2 extracted from the Version, or null when it stated none.'),
    headingPath: z
      .array(z.string())
      .describe('The Markdown headings the Chunk sits under, outermost first.'),
    match: searchMatchSchema,
    excerpt: z
      .array(textSegmentSchema)
      .describe(
        'An Excerpt (GLOSSARY.md): about two lines of the Chunk around its matches, Markdown ' +
          'markers stripped, the matched words flagged.',
      ),
  })
  .describe('A Chunk of a Document that matches the query.');
export type DocumentSearchResult = z.infer<typeof documentSearchResultSchema>;

export const searchNotebookResponseSchema = searchResponse(documentSearchResultSchema);

// Chat Thread search (NBK-97): one result per matching Exchange (GLOSSARY.md).

export const searchThreadsQuerySchema = z.object({
  q: z
    .string()
    .max(1000)
    .default('')
    .describe(
      'Keywords, matched literally in questions and answers, accents and case ignored; blank ' +
        'returns no results.',
    ),
  exact: exactSchema,
});

export const exchangeSearchResultSchema = z
  .object({
    threadId: z.string().uuid(),
    threadTitle: z.string(),
    askedBy: z.object({ id: z.string().uuid(), email: z.string() }),
    askedAt: z.string().describe('When the question was asked.'),
    questionId: z.string().uuid(),
    answerId: z.string().uuid().describe('Where a result opens the Chat Thread.'),
    question: z.array(textSegmentSchema).describe('The question, whole, its matches flagged.'),
    answer: z
      .array(textSegmentSchema)
      .describe('Up to two excerpts of the answer around its matches, flagged.'),
  })
  .describe('An Exchange of a Chat Thread that matches the query.');
export type ExchangeSearchResult = z.infer<typeof exchangeSearchResultSchema>;

export const searchThreadsResponseSchema = searchResponse(exchangeSearchResultSchema);
