import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    await sendError(reply, request, 404, "not_found", "Route not found");
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      await sendError(reply, request, 400, "validation_error", "Invalid request", {
        issues: error.validation
      });
      return;
    }

    const normalizedError =
      error instanceof Error ? error : new Error("Unknown request failure");
    const maybeStatusError = normalizedError as Error & {
      readonly statusCode?: number;
    };
    const statusCode =
      typeof maybeStatusError.statusCode === "number" &&
      maybeStatusError.statusCode >= 400
        ? maybeStatusError.statusCode
        : 500;

    const code = statusCode === 500 ? "internal_error" : "http_error";
    const message =
      statusCode === 500 ? "Internal server error" : normalizedError.message;

    request.log.error({ error: normalizedError }, "request failed");
    await sendError(reply, request, statusCode, code, message);
  });
}

async function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): Promise<void> {
  const body: ErrorResponse = {
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details })
    }
  };

  await reply.status(statusCode).send(body);
}
