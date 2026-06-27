import { Client } from "pg";
import type { FastifyInstance } from "fastify";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../persistence/schema/index.js";

export type DatabaseClient = {
  readonly query: Client["query"];
  readonly drizzle?: NodePgDatabase<typeof schema.schema>;
};

export async function registerDatabasePlugin(
  app: FastifyInstance
): Promise<void> {
  const client = new Client({ connectionString: app.config.databaseUrl });

  await client.connect();
  const db = drizzle(client, { schema: schema.schema });

  app.decorate("db", {
    query: client.query.bind(client),
    drizzle: db
  });

  app.addHook("onClose", async () => {
    await client.end();
  });
}
