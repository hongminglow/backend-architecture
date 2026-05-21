import type { FastifyReply, FastifyRequest } from "fastify";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { ApiContext } from "../types.js";

export function createAuthenticate(ctx: ApiContext) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } });
      return;
    }

    const token = authorization.slice("Bearer ".length);
    try {
      const decoded = jwt.verify(token, ctx.config.jwtAccessSecret) as JwtPayload;
      if (typeof decoded.sub !== "string" || typeof decoded.email !== "string") {
        reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Invalid token" } });
        return;
      }

      request.user = {
        id: decoded.sub,
        email: decoded.email,
      };
    } catch {
      reply
        .code(401)
        .send({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired token" } });
    }
  };
}
