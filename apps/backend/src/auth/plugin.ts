import type { FastifyInstance, FastifyRequest } from "fastify";

import { createDbAuthService } from "./db-auth-service.js";
import { createJwtIssuer, type JwtIssuer } from "./jwt.js";
import { createArgon2PasswordVerifier } from "./password.js";
import type { AuthService, AuthSession, AuthenticatedOrganization } from "./types.js";
import { forbidden, unauthorized } from "../http/http-error.js";
import { accessTokenCookieName, readCookie } from "./cookies.js";

export type AuthPluginOptions = {
  readonly authService?: AuthService;
  readonly jwtIssuer?: JwtIssuer;
};

export type AuthenticatedRequest = FastifyRequest & {
  auth: AuthSession;
};

export type OrganizationRequest = AuthenticatedRequest & {
  organization: AuthenticatedOrganization;
};

export function registerAuthPlugin(
  app: FastifyInstance,
  options: AuthPluginOptions = {}
): void {
  const jwtIssuer =
    options.jwtIssuer ??
    createJwtIssuer({
      accessSecret: app.config.jwt.accessSecret,
      refreshSecret: app.config.jwt.refreshSecret,
      accessMaxAgeSeconds: app.config.jwt.accessMaxAgeSeconds,
      refreshMaxAgeSeconds: app.config.jwt.refreshMaxAgeSeconds
    });
  const authService = options.authService ?? createDefaultAuthService(app);

  app.decorate("authService", authService);
  app.decorate("jwtIssuer", jwtIssuer);

  app.decorateRequest("auth", null);
  app.decorateRequest("organization", null);

  app.decorate("requireAuthenticatedUser", async (request) => {
    const token = readCookie(request.headers.cookie, accessTokenCookieName);
    if (!token) {
      throw unauthorized();
    }

    const tokenSession = jwtIssuer.verifyAccess(token);
    if (!tokenSession) {
      throw unauthorized();
    }

    const session = await authService.loadSession({ userId: tokenSession.userId });
    if (!session) {
      throw unauthorized();
    }

    request.auth = session;
  });

  app.decorate("requireOrganizationContext", async (request) => {
    await app.requireAuthenticatedUser(request);

    const organizationId = readOrganizationId(request);
    if (!organizationId) {
      throw forbidden("Organization context is required");
    }

    const session = request.auth;
    if (!session) {
      throw unauthorized();
    }

    const organization = session.organizations.find(
      (candidate) => candidate.id === organizationId
    );
    if (!organization) {
      throw forbidden("Organization membership is required");
    }

    request.organization = organization;
  });

  app.decorate(
    "requirePermission",
    (permissionKey) =>
      async (request): Promise<void> => {
        await app.requireOrganizationContext(request);

        const organization = request.organization;
        if (!organization) {
          throw forbidden("Organization context is required");
        }

        if (!organization.permissionKeys.includes(permissionKey)) {
          throw forbidden("Permission is required");
        }
      }
  );
}

function createDefaultAuthService(app: FastifyInstance): AuthService {
  const db = app.db.drizzle;
  if (!db) {
    return {
      async login() {
        throw new Error("Drizzle database is required for authentication");
      },
      async loadSession() {
        throw new Error("Drizzle database is required for authentication");
      }
    };
  }

  return createDbAuthService({
    db,
    passwordVerifier: createArgon2PasswordVerifier()
  });
}

function readOrganizationId(request: FastifyRequest): string | undefined {
  const header = request.headers["x-organization-id"];
  if (Array.isArray(header)) {
    return header[0];
  }
  if (header) {
    return header;
  }

  const params = request.params;
  if (params && typeof params === "object" && "organizationId" in params) {
    const value = (params as { readonly organizationId?: unknown }).organizationId;
    return typeof value === "string" ? value : undefined;
  }

  const query = request.query;
  if (query && typeof query === "object" && "organizationId" in query) {
    const value = (query as { readonly organizationId?: unknown }).organizationId;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}
