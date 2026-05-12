export const orderStatuses = ["pending", "confirmed", "shipped", "delivered", "cancelled"] as const;

export type OrderStatus = (typeof orderStatuses)[number];

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderCreatedEvent {
  eventId: string;
  eventType: "order.created";
  orderId: string;
  occurredAt: string;
  correlationId?: string;
}

export const serviceNames = {
  api: "api-service",
  outbox: "outbox-publisher",
  worker: "worker-service",
} as const;

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer environment variable: ${name}`);
  }

  return parsed;
}

export function optionalBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return defaultValue;
  }

  return raw.toLowerCase() === "true";
}
