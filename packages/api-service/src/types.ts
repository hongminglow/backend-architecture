import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { ApiConfig } from "./config.js";
import type { ApiMetrics } from "./metrics.js";
import type { WarnOncePerMinute } from "./utils/warn-once.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export type ApiFastifyInstance = FastifyInstance<
  Server<typeof IncomingMessage, typeof ServerResponse>,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    correlationId?: string;
  }
}

export interface RequestLifecycleState {
  shuttingDown: boolean;
  activeRequests: number;
  requestStart: WeakMap<FastifyRequest, bigint>;
}

export interface ApiContext {
  config: ApiConfig;
  logger: Logger;
  pool: Pool;
  redis: Redis;
  metrics: ApiMetrics;
  state: RequestLifecycleState;
  warnOncePerMinute: WarnOncePerMinute;
}
