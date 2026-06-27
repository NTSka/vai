import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "./app.js";
import { createTestConfig } from "./test-support/config.js";
import type { DatabaseClient } from "./infrastructure/database/plugin.js";
import type { ObjectStorageClient } from "./infrastructure/object-storage/plugin.js";

const healthyDatabase: DatabaseClient = {
  query: async () => ({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] })
};

const healthyObjectStorage: ObjectStorageClient = {
  headBucket: async () => undefined,
  destroy: () => undefined
};

describe("backend app", () => {
  it("serves liveness health", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        "x-correlation-id": "test-correlation-id"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("test-correlation-id");
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("returns validation errors with a stable envelope", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage
    });

    app.get(
      "/test/echo",
      {
        schema: {
          querystring: z.object({
            value: z.string().min(1)
          }),
          response: {
            200: z.object({
              value: z.string()
            })
          }
        }
      },
      async (request) => {
        const query = request.query as { readonly value: string };
        return { value: query.value };
      }
    );

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/test/echo"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid request"
      }
    });
    await app.close();
  });

  it("returns stable readiness reason codes", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: {
        query: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
            code: "ECONNREFUSED"
          });
        }
      },
      objectStorage: {
        headBucket: async () => {
          throw Object.assign(new Error("forbidden"), {
            $metadata: { httpStatusCode: 403 }
          });
        },
        destroy: () => undefined
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: {
        database: { ok: false, reason: "unreachable" },
        objectStorage: { ok: false, reason: "unauthorized" }
      }
    });

    await app.close();
  });

  it("emits OpenAPI including Zod-backed routes", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage
    });

    const response = await app.inject({
      method: "GET",
      url: "/openapi.json"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: "3.0.3",
      paths: {
        "/health/live": {},
        "/health/ready": {}
      }
    });
    expect(response.json().paths).not.toHaveProperty("/sample/echo");

    await app.close();
  });
});
