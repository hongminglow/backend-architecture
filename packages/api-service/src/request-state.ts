import type { RequestLifecycleState } from "./types.js";

export function createRequestLifecycleState(): RequestLifecycleState {
  return {
    shuttingDown: false,
    activeRequests: 0,
    requestStart: new WeakMap(),
  };
}
