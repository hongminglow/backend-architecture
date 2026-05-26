import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPaginationMeta, paginationOffset, paginationQueryFields } from "../dist/utils/pagination.js";

describe("paginationOffset", () => {
  it("returns 0 for the first page", () => {
    assert.equal(paginationOffset({ page: 1, pageSize: 20 }), 0);
  });

  it("scales offset linearly with page", () => {
    assert.equal(paginationOffset({ page: 2, pageSize: 20 }), 20);
    assert.equal(paginationOffset({ page: 5, pageSize: 50 }), 200);
  });
});

describe("buildPaginationMeta", () => {
  it("returns zeroed totalPages and disables next/prev when total is 0", () => {
    const meta = buildPaginationMeta(0, { page: 1, pageSize: 20 });
    assert.deepEqual(meta, {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
  });

  it("computes totalPages by ceiling and reflects single page correctly", () => {
    const meta = buildPaginationMeta(15, { page: 1, pageSize: 20 });
    assert.equal(meta.totalPages, 1);
    assert.equal(meta.hasNext, false);
    assert.equal(meta.hasPrev, false);
  });

  it("flags hasNext on a non-final page", () => {
    const meta = buildPaginationMeta(50, { page: 1, pageSize: 20 });
    assert.equal(meta.totalPages, 3);
    assert.equal(meta.hasNext, true);
    assert.equal(meta.hasPrev, false);
  });

  it("flags hasPrev on a non-first page", () => {
    const meta = buildPaginationMeta(50, { page: 2, pageSize: 20 });
    assert.equal(meta.hasNext, true);
    assert.equal(meta.hasPrev, true);
  });

  it("flags only hasPrev on the final page of a multi-page set", () => {
    const meta = buildPaginationMeta(50, { page: 3, pageSize: 20 });
    assert.equal(meta.hasNext, false);
    assert.equal(meta.hasPrev, true);
  });
});

describe("paginationQueryFields", () => {
  it("applies safe defaults when no query is provided", async () => {
    const { z } = await import("zod");
    const schema = z.object(paginationQueryFields);
    const parsed = schema.parse({});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.pageSize, 20);
  });

  it("coerces string query params (the shape Fastify hands us)", async () => {
    const { z } = await import("zod");
    const schema = z.object(paginationQueryFields);
    const parsed = schema.parse({ page: "3", pageSize: "50" });
    assert.equal(parsed.page, 3);
    assert.equal(parsed.pageSize, 50);
  });

  it("rejects pageSize > 100 to prevent unbounded scans", async () => {
    const { z } = await import("zod");
    const schema = z.object(paginationQueryFields);
    assert.throws(() => schema.parse({ pageSize: 101 }));
  });

  it("rejects page < 1", async () => {
    const { z } = await import("zod");
    const schema = z.object(paginationQueryFields);
    assert.throws(() => schema.parse({ page: 0 }));
  });
});
