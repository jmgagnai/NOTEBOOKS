import { z } from 'zod';
import { documentSchema } from '../documents/schema.js';

export const searchNotebookParamsSchema = z.object({
  notebookId: z.string().uuid(),
});
export type SearchNotebookParams = z.infer<typeof searchNotebookParamsSchema>;

/** How many Documents a search returns when the caller doesn't say. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** The most a caller can ask for. */
export const MAX_SEARCH_LIMIT = 50;

export const searchNotebookQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('What to search for — keywords or a topic, matched semantically, not literally.'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_SEARCH_LIMIT)
    .describe('How many Documents to return, best match first.'),
});
export type SearchNotebookQuery = z.infer<typeof searchNotebookQuerySchema>;

// One search hit. It is a *Document*, not a Chunk: retrieval ranks Chunks,
// but per NBK-9 results are rolled up to their parent Document, so the same
// Document never appears twice however many of its Chunks matched.
//
// The payload is `documentSchema` — which already carries the `abstract`,
// the 50-100 word artifact GLOSSARY.md assigns to "search results,
// search-result previews, and document cards" — plus the score. Reusing that
// shape is deliberate: a search result and a document card show the same
// thing, so the frontend renders one type in both places.
// `match` is where that best Chunk sits (NBK-96): the same pin a Citation
// carries, so a result links to the Document page the way a Citation does
// and opens its Converted Markdown at that Chunk.
export const searchMatchSchema = z
  .object({
    versionId: z.string().uuid().describe('The Document Version the Chunk belongs to.'),
    chunkId: z.string().uuid().describe("The Document's best-matching Chunk."),
    charStart: z
      .number()
      .int()
      .nullable()
      .describe(
        "Start of the Chunk in the Version's Converted Markdown; null when it could not be located.",
      ),
    charEnd: z.number().int().nullable().describe('End of that range, exclusive.'),
  })
  .describe("Where the Document's best-matching Chunk sits — what opening the result shows.");

export const searchResultSchema = documentSchema.extend({
  title: z
    .string()
    .nullable()
    .describe(
      "The title Stage 2 extracted from the Document's latest Version, or null when it stated none — what a result is headed by (NBK-96).",
    ),
  match: searchMatchSchema,
  score: z
    .number()
    .describe(
      "Cosine similarity of this Document's best-matching Chunk to the query, 1 being identical. " +
        'Results are ordered by it, best first.',
    ),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchNotebookResponseSchema = z.array(searchResultSchema);
