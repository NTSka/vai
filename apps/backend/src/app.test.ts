import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "./app.js";
import { createJwtIssuer } from "./auth/jwt.js";
import type { AuthService, AuthSession } from "./auth/types.js";
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

const testSession: AuthSession = {
  user: {
    id: "user-1",
    email: "mvp.user@example.test",
    fullName: "MVP User"
  },
  organizations: [
    {
      id: "organization-1",
      name: "MVP Organization",
      membershipId: "membership-1",
      roleIds: ["role-1"],
      permissionKeys: ["document.upload"]
    }
  ]
};

const authService: AuthService = {
  async login(input) {
    return input.login === "mvp.user@example.test" && input.password === "correct"
      ? testSession
      : undefined;
  },
  async loadSession(input) {
    return input.userId === testSession.user.id ? testSession : undefined;
  }
};

function createTestJwtIssuer() {
  return createJwtIssuer({
    accessSecret: "test-access-secret",
    refreshSecret: "test-refresh-secret"
  });
}

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

  it("logs in seeded users and sets httpOnly JWT cookies", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer: createTestJwtIssuer()
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        login: "mvp.user@example.test",
        password: "correct"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(testSession);
    const cookies = response.headers["set-cookie"];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vai_access_token="),
        expect.stringContaining("vai_refresh_token=")
      ])
    );
    expect(String(cookies)).toContain("HttpOnly");

    await app.close();
  });

  it("rejects failed login without exposing which field failed", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer: createTestJwtIssuer()
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        login: "mvp.user@example.test",
        password: "wrong"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_credentials",
        message: "Invalid login or password"
      }
    });

    await app.close();
  });

  it("returns current session from the access cookie and clears cookies on logout", async () => {
    const jwtIssuer = createTestJwtIssuer();
    const tokens = jwtIssuer.issuePair(testSession.user.id);
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer
      }
    });

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`
      }
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toEqual(testSession);

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout"
    });

    expect(logoutResponse.statusCode).toBe(204);
    expect(String(logoutResponse.headers["set-cookie"])).toContain("Max-Age=0");

    await app.close();
  });

  it("registers session and logout endpoints outside the test environment", async () => {
    const app = await buildApp({
      config: createTestConfig({ nodeEnv: "development" }),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer: createTestJwtIssuer()
      }
    });

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/auth/session"
    });
    expect(sessionResponse.statusCode).toBe(401);
    expect(sessionResponse.json()).toMatchObject({
      error: {
        code: "unauthorized"
      }
    });

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout"
    });
    expect(logoutResponse.statusCode).toBe(204);
    expect(String(logoutResponse.headers["set-cookie"])).toContain("Max-Age=0");

    await app.close();
  });

  it("protects authenticated, organization, and permission guards", async () => {
    const jwtIssuer = createTestJwtIssuer();
    const tokens = jwtIssuer.issuePair(testSession.user.id);
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer
      }
    });

    const anonymous = await app.inject({
      method: "GET",
      url: "/auth/test/protected"
    });
    expect(anonymous.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: "GET",
      url: "/auth/test/protected",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`
      }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual({ userId: testSession.user.id });

    const missingMembership = await app.inject({
      method: "GET",
      url: "/auth/test/organization",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": "unknown-organization"
      }
    });
    expect(missingMembership.statusCode).toBe(403);

    const organization = await app.inject({
      method: "GET",
      url: "/auth/test/organization",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": testSession.organizations[0]?.id
      }
    });
    expect(organization.statusCode).toBe(200);
    expect(organization.json()).toEqual({
      organizationId: testSession.organizations[0]?.id,
      membershipId: testSession.organizations[0]?.membershipId
    });

    const permission = await app.inject({
      method: "GET",
      url: "/auth/test/permission",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": testSession.organizations[0]?.id
      }
    });
    expect(permission.statusCode).toBe(200);
    expect(permission.json()).toEqual({ ok: true });

    await app.close();
  });
});
