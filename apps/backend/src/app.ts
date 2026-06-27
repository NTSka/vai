import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
  jsonSchemaTransform
} from "fastify-type-provider-zod";
import swagger from "@fastify/swagger";

import { loadBackendConfig, type BackendConfig } from "./config.js";
import {
  registerDatabasePlugin,
  type DatabaseClient
} from "./infrastructure/database/plugin.js";
import {
  registerObjectStoragePlugin,
  type ObjectStorageClient
} from "./infrastructure/object-storage/plugin.js";
import { registerErrorHandler } from "./http/errors.js";
import { registerHealthRoutes } from "./http/routes/health.js";

export type BuildAppOptions = {
  readonly config?: BackendConfig;
  readonly logger?: boolean | FastifyBaseLogger;
  readonly database?: DatabaseClient;
  readonly objectStorage?: ObjectStorageClient;
};

export async function buildApp(
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const config = options.config ?? loadBackendConfig();
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== "test",
    genReqId: (request) => {
      const incoming = request.headers["x-correlation-id"];
      return Array.isArray(incoming)
        ? incoming[0] ?? randomUUID()
        : incoming ?? randomUUID();
    }
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("config", config);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-correlation-id", request.id);
  });

  registerErrorHandler(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "VAI Backend API",
        version: "0.0.0"
      }
    },
    transform: jsonSchemaTransform
  });

  app.get("/openapi.json", async () => app.swagger());

  if (options.database) {
    app.decorate("db", options.database);
  } else {
    await registerDatabasePlugin(app);
  }

  if (options.objectStorage) {
    app.decorate("objectStorage", options.objectStorage);
  } else {
    await registerObjectStoragePlugin(app);
  }

  await registerHealthRoutes(app);

  return app;
}
