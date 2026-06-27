import "fastify";

import type { FastifyRequest } from "fastify";
import type { BackendConfig } from "../config.js";
import type { JwtIssuer } from "../auth/jwt.js";
import type {
  AuthenticatedOrganization,
  AuthService,
  AuthSession
} from "../auth/types.js";
import type { DatabaseClient } from "../infrastructure/database/plugin.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";

declare module "fastify" {
  interface FastifyInstance {
    readonly config: BackendConfig;
    readonly db: DatabaseClient;
    readonly objectStorage: ObjectStorageClient;
    readonly authService: AuthService;
    readonly jwtIssuer: JwtIssuer;
    requireAuthenticatedUser(request: FastifyRequest): Promise<void>;
    requireOrganizationContext(request: FastifyRequest): Promise<void>;
    requirePermission(
      permissionKey: string
    ): (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    auth: AuthSession | null;
    organization: AuthenticatedOrganization | null;
  }
}
