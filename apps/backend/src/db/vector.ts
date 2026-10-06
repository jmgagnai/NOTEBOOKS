/**
 * pgvector's text input format.
 *
 * `[1,2,3]` — square brackets and no spaces, which is *not* a Postgres array
 * literal (`{1,2,3}`). Every embedding crossing into SQL goes through here:
 * the three callers that write or query vectors (ingestion stage 3's inserts,
 * search, chat retrieval) had each spelled the same template literal out, and
 * a vector formatted the other way fails at the cast with an error that
 * blames the column rather than the caller.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
