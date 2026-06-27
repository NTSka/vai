import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { schema } from "../schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function requireRow<T>(row: T | undefined, entityName: string): T {
  if (!row) {
    throw new Error(`Expected ${entityName} row to be returned`);
  }

  return row;
}
