import { z } from "zod";

export const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
export const passwordSchema = z.string().min(12);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = registerSchema;

export const refreshSchema = z.object({
  refreshToken: z.string().min(32),
});

export const logoutSchema = refreshSchema;
