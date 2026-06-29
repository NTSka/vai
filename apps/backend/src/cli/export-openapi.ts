import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DatabaseClient } from "../infrastructure/database/plugin.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import { buildApp } from "../app.js";
import type { BackendConfig } from "../config.js";
import type { AuthService } from "../auth/types.js";
import { createJwtIssuer } from "../auth/jwt.js";

const outputPath = path.resolve(
  process.cwd(),
  "..",
  "..",
  "packages",
  "api-contracts",
  "openapi.json"
);

const exportConfig: BackendConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://vai2:vai2_password@localhost:5432/vai2",
  objectStorage: {
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "vai-local-files",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    forcePathStyle: true
  },
  jwt: {
    accessSecret: "openapi-export-access-secret",
    refreshSecret: "openapi-export-refresh-secret"
  },
  authCookieSecure: false,
  cvOcrServiceUrl: "localhost:50051",
  cvOcrDeadlineMs: 300_000,
  cvOcrGrpcMaxMessageBytes: 512 * 1024 * 1024,
  processingWorkerConcurrency: 8,
  archiveUnpackUploadConcurrency: 8
};

const database: DatabaseClient = {
  query: async () => ({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] })
};

const objectStorage: ObjectStorageClient = {
  headBucket: async () => undefined,
  putObject: async () => undefined,
  deleteObject: async () => undefined,
  getObject: async () => {
    throw new Error("OpenAPI export does not read object storage");
  },
  listObjects: async () => [],
  destroy: () => undefined
};

const authService: AuthService = {
  async login() {
    throw new Error("OpenAPI export does not authenticate users");
  },
  async loadSession() {
    throw new Error("OpenAPI export does not load sessions");
  }
};

async function main(): Promise<void> {
  const app = await buildApp({
    config: exportConfig,
    logger: false,
    database,
    objectStorage,
    auth: {
      authService,
      jwtIssuer: createJwtIssuer(exportConfig.jwt)
    }
  });

  try {
    await app.ready();
    const openapi = app.swagger();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(openapi, null, 2)}\n`, "utf8");
    console.log(`Wrote ${outputPath}`);
  } finally {
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unknown OpenAPI export failure");
    process.exitCode = 1;
  });
}
