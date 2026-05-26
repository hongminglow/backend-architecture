import { optionalBoolEnv, optionalIntEnv, requiredEnv } from "@backend-architect/shared";

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  cacheTimeoutMs: number;
  cacheListCountTtlSeconds: number;
  rateLimitRequests: number;
  rateLimitWindowSeconds: number;
  failedLoginIpLimit: number;
  failedLoginIpWindowSeconds: number;
  failedLoginAccountLimit: number;
  failedLoginAccountWindowSeconds: number;
  accountLockSeconds: number;
  shutdownDrainMs: number;
  allowLoadTestClientIdentity: boolean;
  loadTestClientIdHeader: string;
  corsAllowedOrigins: string[];
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  dbIdleInTransactionTimeoutMs: number;
  dbConnectionTimeoutMs: number;
}

export function loadConfig(): ApiConfig {
  return {
    port: optionalIntEnv("API_PORT", 3000),
    databaseUrl: requiredEnv("DATABASE_URL"),
    redisUrl: requiredEnv("REDIS_URL"),
    jwtAccessSecret: requiredEnv("JWT_ACCESS_SECRET"),
    jwtRefreshSecret: requiredEnv("JWT_REFRESH_SECRET"),
    accessTokenTtlSeconds: optionalIntEnv("ACCESS_TOKEN_TTL_SECONDS", 900),
    refreshTokenTtlSeconds: optionalIntEnv("REFRESH_TOKEN_TTL_SECONDS", 604800),
    cacheEnabled: optionalBoolEnv("CACHE_ENABLED", true),
    cacheTtlSeconds: optionalIntEnv("CACHE_TTL_SECONDS", 60),
    cacheTimeoutMs: optionalIntEnv("CACHE_TIMEOUT_MS", 200),
    cacheListCountTtlSeconds: optionalIntEnv("CACHE_LIST_COUNT_TTL_SECONDS", 300),
    rateLimitRequests: optionalIntEnv("RATE_LIMIT_REQUESTS", 100),
    rateLimitWindowSeconds: optionalIntEnv("RATE_LIMIT_WINDOW_SECONDS", 60),
    failedLoginIpLimit: optionalIntEnv("AUTH_FAILED_LOGIN_IP_LIMIT", 10),
    failedLoginIpWindowSeconds: optionalIntEnv("AUTH_FAILED_LOGIN_IP_WINDOW_SECONDS", 60),
    failedLoginAccountLimit: optionalIntEnv("AUTH_FAILED_LOGIN_ACCOUNT_LIMIT", 5),
    failedLoginAccountWindowSeconds: optionalIntEnv(
      "AUTH_FAILED_LOGIN_ACCOUNT_WINDOW_SECONDS",
      900,
    ),
    accountLockSeconds: optionalIntEnv("AUTH_ACCOUNT_LOCK_SECONDS", 900),
    shutdownDrainMs: optionalIntEnv("SHUTDOWN_DRAIN_MS", 30_000),
    allowLoadTestClientIdentity: optionalBoolEnv("ALLOW_LOAD_TEST_CLIENT_IDENTITY", true),
    loadTestClientIdHeader: (
      process.env.LOAD_TEST_CLIENT_ID_HEADER ?? "x-load-test-client-id"
    ).toLowerCase(),
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    dbPoolMax: optionalIntEnv("DB_POOL_MAX", 20),
    dbStatementTimeoutMs: optionalIntEnv("DB_STATEMENT_TIMEOUT_MS", 5_000),
    dbIdleInTransactionTimeoutMs: optionalIntEnv("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 10_000),
    dbConnectionTimeoutMs: optionalIntEnv("DB_CONNECTION_TIMEOUT_MS", 5_000),
  };
}
