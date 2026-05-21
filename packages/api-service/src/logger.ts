import pino from "pino";

const service = "api-service";

export function createLogger(): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "*.password",
        "*.passwordHash",
        "*.accessToken",
        "*.refreshToken",
        "*.token",
        "*.secret",
        "*.authorization",
      ],
      censor: "[REDACTED]",
    },
  });
}
