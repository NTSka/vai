import { Client } from "pg";
import type { FastifyInstance } from "fastify";

export type DatabaseClient = {
  readonly query: Client["query"];
};

export async function registerDatabasePlugin(
  app: FastifyInstance
): Promise<void> {
  const client = new Client({ connectionString: app.config.databaseUrl });

  await client.connect();

  app.decorate("db", {
    query: client.query.bind(client)
  });

  app.addHook("onClose", async () => {
    await client.end();
  });
}
