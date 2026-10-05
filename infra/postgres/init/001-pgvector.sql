-- Enable the pgvector extension so `vector` columns/operators are available
-- to every migration that follows (chunks.embedding, etc.).
CREATE EXTENSION IF NOT EXISTS vector;
