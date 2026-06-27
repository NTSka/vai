import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "./app.js";
import { createJwtIssuer } from "./auth/jwt.js";
import type { AuthService, AuthSession } from "./auth/types.js";
import { createTestConfig } from "./test-support/config.js";
import type { DatabaseClient } from "./infrastructure/database/plugin.js";
import type { ObjectStorageClient } from "./infrastructure/object-storage/plugin.js";
import type { UploadDocumentSetService } from "./document-intake/upload-service.js";

const healthyDatabase: DatabaseClient = {
  query: async () => ({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] })
};

const healthyObjectStorage: ObjectStorageClient = {
  headBucket: async () => undefined,
  putObject: async () => undefined,
  deleteObject: async () => undefined,
  getObject: async () => {
    throw new Error("not used");
  },
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
      permissionKeys: ["document.upload", "document.view"]
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
        putObject: async () => undefined,
        deleteObject: async () => undefined,
        getObject: async () => {
          throw new Error("not used");
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
    const openapi = response.json();

    expect(response.statusCode).toBe(200);
    expect(openapi).toMatchObject({
      openapi: "3.0.3",
      paths: {
        "/health/live": {},
        "/health/ready": {},
        "/organizations/{organizationId}/document-sets/{documentSetId}/status": {},
        "/organizations/{organizationId}/processing/progress": {},
        "/organizations/{organizationId}/project-structure/tree": {},
        "/organizations/{organizationId}/project-structure/nodes/{nodeId}/documents": {},
        "/organizations/{organizationId}/source-documents/{documentVersionId}": {},
        "/organizations/{organizationId}/source-documents/{documentVersionId}/access": {},
        "/organizations/{organizationId}/source-documents/{documentVersionId}/content":
          {},
        "/organizations/{organizationId}/document-versions/{documentVersionId}/typed-data":
          {}
      }
    });
    expect(openapi.paths).not.toHaveProperty("/sample/echo");
    expect(
      openapi.paths["/organizations/{organizationId}/document-sets/{documentSetId}/status"]
        .get.responses["200"].content["application/json"].schema.properties
    ).toHaveProperty("baselineStatus");
    expect(
      openapi.paths[
        "/organizations/{organizationId}/project-structure/nodes/{nodeId}/documents"
      ].get.responses["200"].content["application/json"].schema.properties
    ).toHaveProperty("documents");
    const sourceContentResponse =
      openapi.paths[
        "/organizations/{organizationId}/source-documents/{documentVersionId}/content"
      ].get.responses["200"];
    expect(sourceContentResponse.content).not.toHaveProperty("application/json");
    expect(sourceContentResponse.content).toMatchObject({
      "application/pdf": {
        schema: {
          type: "string",
          format: "binary"
        }
      },
      "application/octet-stream": {
        schema: {
          type: "string",
          format: "binary"
        }
      }
    });

    await app.close();
  });

  it("rejects read API requests for a different organization path", async () => {
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

    const response = await app.inject({
      method: "GET",
      url: "/organizations/other-organization/document-sets/document-set-1/status",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": testSession.organizations[0]?.id
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "forbidden",
        message: "Organization membership is required"
      }
    });

    await app.close();
  });

  it("resolves organization context from route params for direct browser links", async () => {
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

    app.get(
      "/auth/test/organizations/:organizationId/context",
      {
        schema: {
          params: z.object({
            organizationId: z.string()
          }),
          response: {
            200: z.object({
              organizationId: z.string()
            })
          }
        },
        preHandler: app.requireOrganizationContext
      },
      async (request) => ({
        organizationId: request.organization?.id ?? "missing"
      })
    );

    const response = await app.inject({
      method: "GET",
      url: `/auth/test/organizations/${testSession.organizations[0]?.id}/context`,
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      organizationId: testSession.organizations[0]?.id
    });

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

  it("rejects anonymous document set uploads", async () => {
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage
    });

    const response = await app.inject({
      method: "POST",
      url: "/document-sets/uploads",
      headers: {
        ...multipartHeaders("boundary")
      },
      payload: multipartBody({
        boundary: "boundary",
        files: [{ fieldName: "files", filename: "source.pdf", content: "pdf" }]
      })
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("rejects empty document set uploads", async () => {
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
      },
      documentIntake: {
        uploadService: {
          async upload() {
            throw new Error("upload service should not be called");
          }
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/document-sets/uploads",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": testSession.organizations[0]?.id,
        ...multipartHeaders("boundary")
      },
      payload: multipartBody({ boundary: "boundary", files: [] })
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "At least one file is required"
      }
    });

    await app.close();
  });

  it("uploads document sets for authenticated organization members", async () => {
    const jwtIssuer = createTestJwtIssuer();
    const tokens = jwtIssuer.issuePair(testSession.user.id);
    const uploadCalls: Parameters<UploadDocumentSetService["upload"]>[0][] = [];
    const uploadService: UploadDocumentSetService = {
      async upload(input) {
        uploadCalls.push(input);
        return {
          documentSetId: "document-set-1",
          storedFileIds: ["stored-file-1"],
          validationJobId: "job-1",
          status: "uploaded"
        };
      }
    };
    const app = await buildApp({
      config: createTestConfig(),
      logger: false,
      database: healthyDatabase,
      objectStorage: healthyObjectStorage,
      auth: {
        authService,
        jwtIssuer
      },
      documentIntake: {
        uploadService
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/document-sets/uploads",
      headers: {
        cookie: `vai_access_token=${tokens.accessToken}`,
        "x-organization-id": testSession.organizations[0]?.id,
        "x-correlation-id": "upload-correlation-id",
        ...multipartHeaders("boundary")
      },
      payload: multipartBody({
        boundary: "boundary",
        files: [
          {
            fieldName: "files",
            filename: "source.pdf",
            contentType: "application/pdf",
            content: "pdf-content"
          }
        ]
      })
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      documentSetId: "document-set-1",
      storedFileIds: ["stored-file-1"],
      validationJobId: "job-1",
      status: "uploaded"
    });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).toMatchObject({
      organizationId: testSession.organizations[0]?.id,
      uploadedBy: testSession.user.id,
      correlationId: "upload-correlation-id"
    });
    expect(uploadCalls[0]?.files).toEqual([
      expect.objectContaining({
        filename: "source.pdf",
        mimeType: "application/pdf",
        sizeBytes: Buffer.byteLength("pdf-content"),
        checksum: "3c41d3835155c97d51a836c887be9c0063b7b45f61e14017a9d653fa4c655802"
      })
    ]);

    await app.close();
  });
});

function multipartHeaders(boundary: string): Record<string, string> {
  return {
    "content-type": `multipart/form-data; boundary=${boundary}`
  };
}

function multipartBody(input: {
  readonly boundary: string;
  readonly files: readonly {
    readonly fieldName: string;
    readonly filename: string;
    readonly content: string;
    readonly contentType?: string;
  }[];
}): Buffer {
  const lines: string[] = [];
  for (const file of input.files) {
    lines.push(`--${input.boundary}`);
    lines.push(
      `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"`
    );
    if (file.contentType) {
      lines.push(`Content-Type: ${file.contentType}`);
    }
    lines.push("");
    lines.push(file.content);
  }
  lines.push(`--${input.boundary}--`);
  lines.push("");

  return Buffer.from(lines.join("\r\n"));
}
