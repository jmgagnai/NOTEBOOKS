import { z } from 'zod';

/**
 * An app event: one thing that happened somewhere in the backend and that
 * connected clients may want to know about immediately.
 *
 * This is deliberately generic (NBK-6). Ingestion stage transitions are its
 * first publisher, but chat answer chunks and other background-task events
 * ride the same channel, the same subscriber, and the same SSE endpoint —
 * so nothing here mentions Documents or ingestion.
 *
 * - `type`  — what happened, hyphen/dot-namespaced (e.g.
 *             "document-version-status-changed"). Clients switch on it.
 * - `topic` — who cares, as `<kind>:<id>` (e.g. `notebook:<uuid>`). An SSE
 *             client names the topics it wants and sees only those events.
 * - `data`  — the type-specific body. Kept to a JSON object so adding a
 *             field is never a breaking change for a client that ignores it.
 */
export const appEventSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  topic: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.record(z.unknown()),
});
export type AppEvent = z.infer<typeof appEventSchema>;

/** The fields a publisher supplies; `id` and `occurredAt` are stamped for it. */
export type AppEventDraft = Pick<AppEvent, 'type' | 'topic' | 'data'>;

/** Builds the `topic` every event about one Notebook's contents is published on. */
export function notebookTopic(notebookId: string): string {
  return `notebook:${notebookId}`;
}
