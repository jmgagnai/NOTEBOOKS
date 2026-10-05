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
