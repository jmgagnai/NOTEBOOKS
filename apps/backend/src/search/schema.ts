import { z } from "zod";
import { documentSchema } from "../documents/schema.js";

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
    .describe("What to search for — keywords or a topic, matched semantically, not literally."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_SEARCH_LIMIT)
    .describe("How many Documents to return, best match first."),
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
export const searchResultSchema = documentSchema.extend({
  score: z
    .number()
    .describe(
      "Cosine similarity of this Document's best-matching Chunk to the query, 1 being identical. " +
        "Results are ordered by it, best first.",
    ),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchNotebookResponseSchema = z.array(searchResultSchema);
