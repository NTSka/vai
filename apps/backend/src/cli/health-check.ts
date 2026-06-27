import { checkDatabaseHealth } from "../infrastructure/health/database.js";
import { checkObjectStorageHealth } from "../infrastructure/health/object-storage.js";

function envWithDefault(name: string, defaultValue: string): string {
  const value = process.env[name];

  return value && value.length > 0 ? value : defaultValue;
}

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }

  return value === "true";
}

async function main(): Promise<void> {
  const database = await checkDatabaseHealth(
    envWithDefault(
      "DATABASE_URL",
      "postgres://vai2:vai2_password@localhost:5432/vai2"
    )
  );
  const objectStorage = await checkObjectStorageHealth({
    endpoint: envWithDefault("S3_ENDPOINT", "http://localhost:9000"),
    region: envWithDefault("S3_REGION", "us-east-1"),
    bucket: envWithDefault("S3_BUCKET", "vai-local-files"),
    accessKeyId: envWithDefault("S3_ACCESS_KEY_ID", "minioadmin"),
    secretAccessKey: envWithDefault("S3_SECRET_ACCESS_KEY", "minioadmin"),
    forcePathStyle: booleanEnv("S3_FORCE_PATH_STYLE", true)
  });

  const result = {
    database,
    objectStorage
  };

  console.log(JSON.stringify(result, null, 2));

  if (!database.ok || !objectStorage.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unknown health check failure"
  );
  process.exitCode = 1;
});
