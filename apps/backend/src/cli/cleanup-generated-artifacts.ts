import { Client } from "pg";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";

import { loadBackendConfig } from "../config.js";
import { createObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import * as schema from "../infrastructure/persistence/schema/index.js";
import { cleanupUnreferencedGeneratedArtifacts } from "../storage/generated-artifact-cleanup.js";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const config = loadBackendConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  const objectStorage = createObjectStorageClient(config.objectStorage);

  await client.connect();
  try {
    const db = drizzle(client, { schema: schema.schema });
    const result = await cleanupUnreferencedGeneratedArtifacts({
      db,
      objectStorage,
      bucket: config.objectStorage.bucket,
      execute
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    objectStorage.destroy();
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unknown cleanup failure");
    process.exitCode = 1;
  });
}
