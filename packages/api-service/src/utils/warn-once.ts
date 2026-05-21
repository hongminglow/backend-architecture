import type { Logger } from "pino";

export type WarnOncePerMinute = (key: string, message: string, error: unknown) => void;

export function createWarnOncePerMinute(logger: Logger): WarnOncePerMinute {
  const warnTimestamps = new Map<string, number>();

  return (key, message, error) => {
    const now = Date.now();
    const last = warnTimestamps.get(key) ?? 0;
    if (now - last < 60_000) {
      return;
    }

    warnTimestamps.set(key, now);
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, message);
  };
}
