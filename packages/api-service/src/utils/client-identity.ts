import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "../config.js";

export function getClientIdentifier(request: FastifyRequest, config: ApiConfig): string {
  if (config.allowLoadTestClientIdentity) {
    const loadTestClientId = request.headers[config.loadTestClientIdHeader];
    if (typeof loadTestClientId === "string" && loadTestClientId.trim()) {
      return `load-test:${loadTestClientId.trim().slice(0, 128)}`;
    }
  }

  const xForwardedFor = request.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return xForwardedFor.split(",")[0]?.trim() || request.ip;
  }

  return request.ip;
}
