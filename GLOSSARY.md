# RAG Notebook Application

A multi-user application for uploading documents into Notebooks and chatting with an LLM grounded in those documents.

## Language

### Core entities

**Notebook**:
A shared collection of Documents together with the Chat Threads asked against them. Any authenticated user may view and edit any Notebook — Notebooks are not owned by or restricted to the user who created them.
_Avoid_: workspace, project.

**Document**:
A source file uploaded into a Notebook, tracked through successive Document Versions. Uploading a file under a name that already exists within the same Notebook creates a new Version of that Document rather than a separate one.
_Avoid_: file (reserve "file" for the raw upload itself, not the tracked entity), attachment.

**Document Version**:
A specific revision of a Document. Only a Document's latest Version is searched in chat; older Versions stay retrievable through Citations that point to them.
_Avoid_: revision, snapshot.

**Citation**:
A pointer into one specific Document Version at one specific chunk, surfaced in a chat answer as a source reference. Following a Citation opens that exact Version at that location, even after newer Versions exist.
_Avoid_: source, reference.

**Chat Thread**:
A named sequence of messages asked against a Notebook's Documents, started by one user (its author) but visible to every user who opens the Notebook, the same as Documents. Every message in it records which user asked it — this is attribution, not an access restriction: any user may read or continue any Chat Thread regardless of who started it or who asked a given message.
_Avoid_: conversation, session.

### Ingestion

**Ingestion**:
The background pipeline that turns an uploaded Document Version into something chat can be grounded in. It runs as a chain of independently retryable **Stages**, each one enqueuing the next on success; stage 1 is conversion to Markdown and stage 2 is metadata extraction plus the three Generated document artifacts. A Document Version's progress through it is its status: `queued` → `converting` → `converted` → `summarizing` → `summarized`, or `failed` for whichever Stage exhausted its retries. A Stage whose failure will still be retried returns the Version to the status it consumes, not to `failed`.
_Avoid_: processing, indexing (reserve "indexing" for the embedding/retrieval stage specifically), import.

**Converted Markdown**:
The Markdown rendering of a Document Version's original file, produced by stage 1 of Ingestion and stored on that Version. The single input every later Stage and every Generated document artifact reads from — nothing downstream re-reads the original upload.
_Avoid_: extracted text, plain text, content.

**App Event**:
One thing that happened on the backend and that connected clients are told about immediately — an Ingestion stage transition, and later chat answer chunks and other background-task progress. App Events are notifications, not state: they carry what changed, and a client that missed one re-reads the truth over the normal API.
_Avoid_: message, notification (reserve "notification" for something addressed to a user), update.

### Generated document artifacts

Every ingested document produces three distinct generated summaries, each sized and consumed differently. They are not interchangeable.

**Chat Snippet**:
A 150–300 word summary of a document, written to be injected into the LLM's chat context as grounding about that source. Optimized for a model to read, not a human.
_Avoid_: short summary, context summary.

**Executive Summary**:
A 1–2 page human-facing summary of a document's key points. Shown first when a user opens a document, before they choose to view the full converted content (which may run past 200 pages).
_Avoid_: long summary, detailed summary.

**Abstract**:
A 50–100 word human-facing summary, used in search results, search-result previews, and document cards. Shorter and more surface-level than the Executive Summary; written to be skimmed in a list, not to stand in for the full document.
_Avoid_: blurb, teaser, preview text.
