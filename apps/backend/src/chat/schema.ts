import { z } from 'zod';

// Who did something, as surfaced over the API. A Chat Thread's author and
// every message's asker are rendered next to prose in a shared Chat Thread,
// so the id alone is useless — the email is what a reader recognises.
//
// Deliberately not the full `userSchema`: `createdAt` (when that person
// registered) has nothing to do with a chat message.
export const chatParticipantSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});
export type ChatParticipant = z.infer<typeof chatParticipantSchema>;

// A Chat Thread as returned over the API. See GLOSSARY.md: "a named sequence
// of messages asked against a Notebook's Documents, started by one user (its
// author) but visible to every user who opens the Notebook."
//
// `author` is attribution only. Per ADR-0001 no route checks it, and the
// listing deliberately does not filter by it — a Thread someone else started
// is as readable and as continuable as your own.
export const chatThreadSchema = z.object({
  id: z.string().uuid(),
  notebookId: z.string().uuid(),
  title: z.string(),
  author: chatParticipantSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const listChatThreadsResponseSchema = z.array(chatThreadSchema);

export const createChatThreadRequestSchema = z.object({
  title: z.string().min(1),
});
export type CreateChatThreadRequest = z.infer<typeof createChatThreadRequestSchema>;

export const renameChatThreadRequestSchema = z.object({
  title: z.string().min(1),
});
export type RenameChatThreadRequest = z.infer<typeof renameChatThreadRequestSchema>;

// Who is speaking. 'user' is a question somebody asked; 'assistant' is the
// grounded answer it produced.
export const chatMessageRoleSchema = z.enum(['user', 'assistant']);
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;

// A Citation, as returned over the API. See GLOSSARY.md: "a pointer into one
// specific Document Version at one specific chunk, surfaced in a chat answer
// as a source reference. Following a Citation opens that exact Version at
// that location, even after newer Versions exist."
//
// `documentVersionId` + `chunkId` is the pinned pair, recorded when the
// answer was written. `documentId` and `versionNumber` ride along so a client
// can build the link and say *which* Version it is opening without a second
// round trip — they are read off the pinned Version, never off the Document's
// current one.
//
// There is no display-label field: per NBK-12 a Citation's name derives from
// the chunk's `headingPath` (plus the filename), which travels here as data
// so the client can render it the way it needs to.
//
// `charStart`/`charEnd` are the chunk's half-open character range in that
// Version's Converted Markdown — what "scrolled to that chunk's location"
// resolves to. Null when the text could not be located (a Version with no
// Converted Markdown), in which case following the Citation still opens the
// right Version, just not scrolled.
export const citationSchema = z.object({
  id: z.string().uuid(),
  // The marker as it appears in the answer text ("[2]"), so a client can
  // match a marker in the prose to the Citation it refers to.
  marker: z.number().int().positive(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  chunkId: z.string().uuid(),
  filename: z.string(),
  headingPath: z.array(z.string()),
  charStart: z.number().int().nonnegative().nullable(),
  charEnd: z.number().int().nonnegative().nullable(),
});
export type Citation = z.infer<typeof citationSchema>;

// One message in a Chat Thread.
//
// `askedBy` is present on *both* roles, per GLOSSARY.md ("every message in it
// records which user asked it"): for a question it is the person who typed
// it, and for an answer it is the person whose question produced it. In a
// Thread several people have contributed to, that is what lets a reader tell
// whose exchange they are looking at.
//
// `citations` is the answer's sources (NBK-12), always present and empty for
// a question — a question makes no claims. They are persisted with the
// message rather than recomputed, so re-reading a Thread months later gives
// back the same pinned Versions the answer was actually grounded in.
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  role: chatMessageRoleSchema,
  content: z.string(),
  askedBy: chatParticipantSchema,
  citations: z.array(citationSchema),
  createdAt: z.string().datetime({ offset: true }),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const listChatMessagesResponseSchema = z.array(chatMessageSchema);

export const sendChatMessageRequestSchema = z.object({
  content: z.string().min(1),
});
export type SendChatMessageRequest = z.infer<typeof sendChatMessageRequestSchema>;

// The result of asking a question: the question as it was recorded, and the
// one complete answer it produced.
//
// Both, not just the answer, because the client has to render the question
// with the same server-assigned id, attribution and ordering as every other
// message — otherwise an optimistically-rendered question and the one a
// reload fetches are two different objects.
//
// NBK-10 returns this synchronously; NBK-11 upgrades the *delivery* of
// `answer.content` to SSE paragraph/heading chunks. The shape is what the
// client stores either way, which is why the answer is a whole message here
// rather than a bare string.
export const sendChatMessageResponseSchema = z.object({
  question: chatMessageSchema,
  answer: chatMessageSchema,
});
export type SendChatMessageResponse = z.infer<typeof sendChatMessageResponseSchema>;

export const notebookIdParamsSchema = z.object({
  notebookId: z.string().uuid(),
});
export type NotebookIdParams = z.infer<typeof notebookIdParamsSchema>;

export const chatThreadIdParamsSchema = z.object({
  notebookId: z.string().uuid(),
  threadId: z.string().uuid(),
});
export type ChatThreadIdParams = z.infer<typeof chatThreadIdParamsSchema>;
