import { z } from "zod";

/**
 * Reusable Zod schema fields for paginated list endpoints.
 *
 * Spread these into a resource-specific list query schema so every list API
 * uses the same `page` / `pageSize` validation, defaults, and limits:
 *
 *   export const listOrdersQuerySchema = z.object({
 *     ...paginationQueryFields,
 *     status: z.enum(orderStatuses).optional(),
 *   });
 */
export const paginationQueryFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export interface PaginationParams {
  page: number;
  pageSize: number;
}

/** SQL OFFSET for the requested page. */
export function paginationOffset(params: PaginationParams): number {
  return (params.page - 1) * params.pageSize;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Build the standard pagination metadata that every list response should embed.
 *
 * Use it like:
 *
 *   return {
 *     ...buildPaginationMeta(total, query),
 *     orders: rows,
 *   };
 */
export function buildPaginationMeta(total: number, params: PaginationParams): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / params.pageSize);
  return {
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages,
    hasNext: params.page < totalPages,
    hasPrev: params.page > 1,
  };
}
