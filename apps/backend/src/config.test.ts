import { describe, expect, it } from "vitest";

import { loadBackendConfig } from "./config.js";

const requiredEnv = {
  DATABASE_URL: "postgres://vai2:vai2_password@localhost:5432/vai2",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "vai-local-files",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  JWT_ACCESS_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
  CV_OCR_SERVICE_URL: "localhost:50051"
};

describe("backend config", () => {
  it("rejects invalid boolean env values", () => {
    expect(() =>
      loadBackendConfig({
        ...requiredEnv,
        S3_FORCE_PATH_STYLE: "treu"
      })
    ).toThrow("Invalid backend configuration");
  });

  it("parses explicit false boolean env values", () => {
    const config = loadBackendConfig({
      ...requiredEnv,
      S3_FORCE_PATH_STYLE: "false"
    });

    expect(config.objectStorage.forcePathStyle).toBe(false);
  });

  it("parses CV/OCR processing limits", () => {
    const config = loadBackendConfig({
      ...requiredEnv,
      CV_OCR_DEADLINE_MS: "600000",
      CV_OCR_GRPC_MAX_MESSAGE_BYTES: "1073741824"
    });

    expect(config.cvOcrDeadlineMs).toBe(600_000);
    expect(config.cvOcrGrpcMaxMessageBytes).toBe(1_073_741_824);
  });

  it("defaults secure auth cookies to production only", () => {
    expect(loadBackendConfig(requiredEnv).authCookieSecure).toBe(false);
    expect(
      loadBackendConfig({
        ...requiredEnv,
        NODE_ENV: "production"
      }).authCookieSecure
    ).toBe(true);
  });

  it("allows overriding secure auth cookies", () => {
    expect(
      loadBackendConfig({
        ...requiredEnv,
        NODE_ENV: "production",
        AUTH_COOKIE_SECURE: "false"
      }).authCookieSecure
    ).toBe(false);
  });
});
