import { z } from "zod";

// Who did something, as surfaced over the API. A Chat Thread's author and
// every message's asker are rendered next to prose in a shared conversation,
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
export const chatMessageRoleSchema = z.enum(["user", "assistant"]);
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;

// One message in a Chat Thread.
//
// `askedBy` is present on *both* roles, per GLOSSARY.md ("every message in it
// records which user asked it"): for a question it is the person who typed
// it, and for an answer it is the person whose question produced it. In a
// Thread several people have contributed to, that is what lets a reader tell
// whose exchange they are looking at.
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  role: chatMessageRoleSchema,
  content: z.string(),
  askedBy: chatParticipantSchema,
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
