# Raw SQL instead of an ORM

Postgres/pgvector access goes through raw SQL rather than an ORM (Drizzle, Prisma, Kysely). This is a deliberate choice, not an oversight — pgvector's `vector` column type and similarity operators (`<->`, `<=>`) are native SQL that ORMs wrap with varying levels of friction, and raw SQL keeps full control over query plans for retrieval, which is the app's core latency-sensitive path. The trade-off is losing an ORM's migration tooling and type-safe query building, both of which must be handled separately.
