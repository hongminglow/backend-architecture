import { orderStatuses } from "@backend-architect/shared";
import { z } from "zod";
import { emailSchema } from "./auth.schemas.js";

const orderItemSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(1000),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
});

export const createOrderSchema = z.object({
  customerEmail: emailSchema,
  items: z.array(orderItemSchema).min(1).max(100),
});

export const orderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const patchOrderSchema = z.object({
  status: z.enum(orderStatuses),
});
