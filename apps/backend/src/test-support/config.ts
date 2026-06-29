import type { BackendConfig } from "../config.js";

export function createTestConfig(
  overrides: Partial<BackendConfig> = {}
): BackendConfig {
  return {
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
      accessSecret: "test-access-secret",
      refreshSecret: "test-refresh-secret"
    },
    authCookieSecure: false,
    cvOcrServiceUrl: "localhost:50051",
    cvOcrDeadlineMs: 300_000,
    cvOcrGrpcMaxMessageBytes: 512 * 1024 * 1024,
    processingWorkerConcurrency: 8,
    archiveUnpackUploadConcurrency: 8,
    ...overrides
  };
}
