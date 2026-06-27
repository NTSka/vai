import { Client } from "pg";

export type DatabaseHealth =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function checkDatabaseHealth(
  databaseUrl: string
): Promise<DatabaseHealth> {
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    await client.query("select 1");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "unknown database error"
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
