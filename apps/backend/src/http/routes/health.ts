import type { FastifyInstance } from "fastify";
import { z } from "zod";

const healthReasonSchema = z.enum(["unreachable", "unauthorized", "timeout"]);

const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      reason: healthReasonSchema.optional()
    }),
    objectStorage: z.object({
      ok: z.boolean(),
      reason: healthReasonSchema.optional()
    })
  })
});

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok") })
        }
      }
    },
    async () => ({ status: "ok" as const })
  );

  app.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema
        }
      }
    },
    async (_request, reply) => {
      const [database, objectStorage] = await Promise.all([
        checkDatabase(app),
        checkObjectStorage(app)
      ]);
      const ok = database.ok && objectStorage.ok;

      return reply.status(ok ? 200 : 503).send({
        status: ok ? "ok" : "degraded",
        checks: {
          database,
          objectStorage
        }
      });
    }
  );

}

async function checkDatabase(
  app: FastifyInstance
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unreachable" | "unauthorized" | "timeout" }
> {
  try {
    await app.db.query("select 1");
    return { ok: true };
  } catch (error) {
    app.log.warn({ error }, "database readiness check failed");
    return {
      ok: false,
      reason: classifyReadinessFailure(error)
    };
  }
}

async function checkObjectStorage(
  app: FastifyInstance
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unreachable" | "unauthorized" | "timeout" }
> {
  try {
    await app.objectStorage.headBucket();
    return { ok: true };
  } catch (error) {
    app.log.warn({ error }, "object storage readiness check failed");
    return {
      ok: false,
      reason: classifyReadinessFailure(error)
    };
  }
}

function classifyReadinessFailure(
  error: unknown
): "unreachable" | "unauthorized" | "timeout" {
  if (!(error instanceof Error)) {
    return "unreachable";
  }

  const metadata = (error as Error & {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly code?: string;
  }).$metadata;
  const statusCode = metadata?.httpStatusCode;

  if (statusCode === 401 || statusCode === 403) {
    return "unauthorized";
  }

  const code = (error as Error & { readonly code?: string }).code;
  const message = error.message.toLowerCase();

  if (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    code === "ConnectionTimeout" ||
    message.includes("timeout")
  ) {
    return "timeout";
  }

  return "unreachable";
}
