import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { ApiContext, ApiFastifyInstance } from "../types.js";
import { getClientIdentifier } from "../utils/client-identity.js";
import { validationError, normalizeZodError } from "../utils/http-errors.js";
import { hashToken, newRefreshToken, secondsFromNow } from "../utils/tokens.js";
import {
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from "../schemas/auth.schemas.js";
import type { createAuthenticate } from "../middleware/authenticate.js";

type AuthenticateHook = ReturnType<typeof createAuthenticate>;

async function createTokens(
  ctx: ApiContext,
  user: { id: string; email: string },
): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const accessToken = jwt.sign({ sub: user.id, email: user.email }, ctx.config.jwtAccessSecret, {
    algorithm: "HS256",
    expiresIn: ctx.config.accessTokenTtlSeconds,
  });
  const refreshToken = newRefreshToken();
  await ctx.pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      randomUUID(),
      user.id,
      hashToken(refreshToken),
      secondsFromNow(ctx.config.refreshTokenTtlSeconds),
    ],
  );

  return { accessToken, refreshToken };
}

export function registerAuthRoutes(
  app: ApiFastifyInstance,
  ctx: ApiContext,
  authenticate: AuthenticateHook,
): void {
  app.post("/v1/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const passwordHash = await argon2.hash(parsed.data.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    try {
      const result = await ctx.pool.query<{ id: string; email: string }>(
        `INSERT INTO users (id, email, password_hash)
         VALUES ($1, lower($2), $3)
         RETURNING id, email`,
        [randomUUID(), parsed.data.email, passwordHash],
      );
      const user = result.rows[0];
      const tokens = await createTokens(ctx, user);
      return reply.code(201).send({ user, ...tokens });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return reply.code(409).send({
          error: {
            code: "EMAIL_ALREADY_EXISTS",
            message: "Email already exists",
          },
        });
      }

      throw error;
    }
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const clientId = getClientIdentifier(request, ctx.config);
    const ipKey = `auth:failed-ip:${clientId}`;
    const ipFailures = Number.parseInt((await ctx.redis.get(ipKey)) ?? "0", 10);
    if (ipFailures > ctx.config.failedLoginIpLimit) {
      return reply.code(429).send({
        error: {
          code: "AUTH_RATE_LIMITED",
          message: "Too many failed login attempts",
        },
      });
    }

    const userResult = await ctx.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      locked_until: Date | null;
      failed_login_count: number;
    }>(
      `SELECT id, email, password_hash, locked_until, failed_login_count
       FROM users
       WHERE email = lower($1)`,
      [parsed.data.email],
    );
    const user = userResult.rows[0];

    if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
      return reply.code(423).send({
        error: {
          code: "ACCOUNT_LOCKED",
          message: "Account is temporarily locked",
        },
      });
    }

    const passwordMatches = user
      ? await argon2.verify(user.password_hash, parsed.data.password)
      : false;
    if (!user || !passwordMatches) {
      const failedCount = await ctx.redis.incr(ipKey);
      if (failedCount === 1) {
        await ctx.redis.expire(ipKey, ctx.config.failedLoginIpWindowSeconds);
      }

      if (user) {
        const nextCount = user.failed_login_count + 1;
        const lockedUntil =
          nextCount >= ctx.config.failedLoginAccountLimit
            ? secondsFromNow(ctx.config.accountLockSeconds)
            : null;
        await ctx.pool.query(
          `UPDATE users
           SET failed_login_count = $2,
               locked_until = $3,
               updated_at = now()
           WHERE id = $1`,
          [user.id, nextCount, lockedUntil],
        );
      }

      return reply.code(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid credentials",
        },
      });
    }

    await ctx.pool.query(
      `UPDATE users
       SET failed_login_count = 0,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [user.id],
    );
    const tokens = await createTokens(ctx, user);
    return { user: { id: user.id, email: user.email }, ...tokens };
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const tokenHash = hashToken(parsed.data.refreshToken);
    const tokenResult = await ctx.pool.query<{
      id: string;
      user_id: string;
      email: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT rt.id, rt.user_id, u.email, rt.revoked_at, rt.expires_at
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash],
    );
    const token = tokenResult.rows[0];

    if (!token || token.expires_at.getTime() <= Date.now()) {
      return reply
        .code(401)
        .send({ error: { code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token" } });
    }

    if (token.revoked_at) {
      await ctx.pool.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [token.user_id],
      );
      return reply
        .code(401)
        .send({ error: { code: "REFRESH_TOKEN_REUSED", message: "Invalid refresh token" } });
    }

    await ctx.pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [token.id]);
    const tokens = await createTokens(ctx, { id: token.user_id, email: token.email });
    return tokens;
  });

  app.post("/v1/auth/logout", { preHandler: authenticate }, async (request, reply) => {
    const parsed = logoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    await ctx.pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
      hashToken(parsed.data.refreshToken),
    ]);
    return reply.code(204).send();
  });
}
