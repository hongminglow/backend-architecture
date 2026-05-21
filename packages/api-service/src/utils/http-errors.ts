import type { FastifyReply } from "fastify";
import type { z } from "zod";

export function validationError(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message,
    },
  });
}

export function normalizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
