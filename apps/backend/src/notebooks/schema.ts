import { z } from "zod";

// A Notebook as returned over the API. See GLOSSARY.md: "a shared collection
// of Documents together with the Chat Threads asked against them."
export const notebookSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Notebook = z.infer<typeof notebookSchema>;

export const listNotebooksResponseSchema = z.array(notebookSchema);

export const createNotebookRequestSchema = z.object({
  title: z.string().min(1),
});
export type CreateNotebookRequest = z.infer<typeof createNotebookRequestSchema>;

export const renameNotebookRequestSchema = z.object({
  title: z.string().min(1),
});
export type RenameNotebookRequest = z.infer<typeof renameNotebookRequestSchema>;

export const notebookIdParamsSchema = z.object({
  id: z.string().uuid(),
});
export type NotebookIdParams = z.infer<typeof notebookIdParamsSchema>;
