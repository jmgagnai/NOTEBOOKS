import { z } from "zod";

// A User as returned over the API. Never carries the password hash.
export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime({ offset: true }),
});
export type User = z.infer<typeof userSchema>;

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const errorResponseSchema = z.object({
  message: z.string(),
});
