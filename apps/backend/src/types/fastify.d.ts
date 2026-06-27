import "fastify";

import type { BackendConfig } from "../config.js";
import type { DatabaseClient } from "../infrastructure/database/plugin.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";

declare module "fastify" {
  interface FastifyInstance {
    readonly config: BackendConfig;
    readonly db: DatabaseClient;
    readonly objectStorage: ObjectStorageClient;
  }
}
