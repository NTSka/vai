import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  accessTokenCookieName,
  refreshTokenCookieName,
  serializeAuthCookie,
  serializeClearedCookie
} from "../../auth/cookies.js";
import { HttpError } from "../http-error.js";

const loginBodySchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1)
});

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string()
});

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  membershipId: z.string(),
  roleIds: z.array(z.string()),
  permissionKeys: z.array(z.string())
});

const sessionResponseSchema = z.object({
  user: userSchema,
  organizations: z.array(organizationSchema)
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/login",
    {
      schema: {
        body: loginBodySchema,
        response: {
          200: sessionResponseSchema
        }
      }
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof loginBodySchema>;
      const session = await app.authService.login(body);

      if (!session) {
        throw new HttpError(401, "invalid_credentials", "Invalid login or password");
      }

      const tokens = app.jwtIssuer.issuePair(session.user.id);
      const secureCookies = app.config.authCookieSecure;

      reply.header("set-cookie", [
        serializeAuthCookie({
          name: accessTokenCookieName,
          value: tokens.accessToken,
          maxAgeSeconds: tokens.accessMaxAgeSeconds,
          secure: secureCookies
        }),
        serializeAuthCookie({
          name: refreshTokenCookieName,
          value: tokens.refreshToken,
          maxAgeSeconds: tokens.refreshMaxAgeSeconds,
          secure: secureCookies
        })
      ]);

      return session;
    }
  );

  app.get(
    "/auth/session",
    {
      schema: {
        response: {
          200: sessionResponseSchema
        }
      },
      preHandler: app.requireAuthenticatedUser
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpError(500, "internal_error", "Authenticated context missing");
      }

      return request.auth;
    }
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        response: {
          204: z.null()
        }
      }
    },
    async (_request, reply) => {
      const secureCookies = app.config.authCookieSecure;
      reply.header("set-cookie", [
        serializeClearedCookie({
          name: accessTokenCookieName,
          secure: secureCookies
        }),
        serializeClearedCookie({
          name: refreshTokenCookieName,
          secure: secureCookies
        })
      ]);

      return reply.status(204).send();
    }
  );

  if (app.config.nodeEnv !== "test") {
    return;
  }

  app.get(
    "/auth/test/protected",
    {
      schema: {
        response: {
          200: z.object({
            userId: z.string()
          })
        }
      },
      preHandler: app.requireAuthenticatedUser
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpError(500, "internal_error", "Authenticated context missing");
      }

      return { userId: request.auth.user.id };
    }
  );

  app.get(
    "/auth/test/organization",
    {
      schema: {
        response: {
          200: z.object({
            organizationId: z.string(),
            membershipId: z.string()
          })
        }
      },
      preHandler: app.requireOrganizationContext
    },
    async (request) => {
      if (!request.organization) {
        throw new HttpError(500, "internal_error", "Organization context missing");
      }

      return {
        organizationId: request.organization.id,
        membershipId: request.organization.membershipId
      };
    }
  );

  app.get(
    "/auth/test/permission",
    {
      schema: {
        response: {
          200: z.object({
            ok: z.literal(true)
          })
        }
      },
      preHandler: app.requirePermission("document.upload")
    },
    async () => ({ ok: true as const })
  );
}
