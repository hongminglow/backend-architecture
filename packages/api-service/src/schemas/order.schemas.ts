import { orderStatuses } from "@backend-architect/shared";
import { z } from "zod";
import { paginationQueryFields } from "../utils/pagination.js";
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

export const listOrdersQuerySchema = z
  .object({
    ...paginationQueryFields,
    status: z.enum(orderStatuses).optional(),
    customerEmail: emailSchema.optional(),
    createdAfter: z.string().datetime({ offset: true }).optional(),
    createdBefore: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (value) =>
      !value.createdAfter ||
      !value.createdBefore ||
      new Date(value.createdAfter).getTime() <= new Date(value.createdBefore).getTime(),
    {
      path: ["createdBefore"],
      message: "createdBefore must be greater than or equal to createdAfter",
    },
  );

export const patchOrderSchema = z.object({
  status: z.enum(orderStatuses),
});
