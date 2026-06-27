import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { loadBackendConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadBackendConfig();
  let app: FastifyInstance | undefined;

  try {
    app = await buildApp({ config });

    await app.listen({
      host: config.host,
      port: config.port
    });
  } catch (error) {
    if (app) {
      await app.close().catch((closeError: unknown) => {
        console.error(
          closeError instanceof Error
            ? closeError.message
            : "Unknown backend shutdown error"
        );
      });
    }

    console.error(
      error instanceof Error ? error.message : "Unknown backend startup error"
    );
    process.exitCode = 1;
  }
}

void main();
