import { performance } from "node:perf_hooks";

type ProcessingJobLike = {
  readonly id: string;
  readonly organizationId: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly correlationId: string | null;
  readonly causationId: string | null;
};

type ProcessingLogLevel = "info" | "error";

export type ProcessingLogger = {
  info(input: Record<string, unknown>, message?: string): void;
  error(input: Record<string, unknown>, message?: string): void;
};

export function createJsonProcessingLogger(): ProcessingLogger {
  return {
    info(fields, message) {
      writeProcessingLog("info", fields, message);
    },
    error(fields, message) {
      writeProcessingLog("error", fields, message);
    }
  };
}

export function processingJobLogFields(job: ProcessingJobLike): Record<string, unknown> {
  return {
    jobId: job.id,
    processorId: job.processorId,
    processorVersion: job.processorVersion,
    jobType: job.jobType,
    organizationId: job.organizationId,
    correlationId: job.correlationId,
    causationId: job.causationId,
    attempt: job.attempts,
    ...processingPayloadLogFields(job.payload)
  };
}

export async function withProcessingSpan<T>(
  input: {
    readonly job: ProcessingJobLike;
    readonly span: string;
    readonly attributes?: Record<string, unknown>;
  },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  const baseFields = {
    event: "processing.span",
    span: input.span,
    ...processingJobLogFields(input.job),
    ...(input.attributes ?? {})
  };

  writeProcessingLog("info", { ...baseFields, status: "started" }, "processing span started");

  try {
    const result = await operation();
    writeProcessingLog(
      "info",
      {
        ...baseFields,
        status: "completed",
        durationMs: elapsedMs(startedAt)
      },
      "processing span completed"
    );
    return result;
  } catch (error) {
    writeProcessingLog(
      "error",
      {
        ...baseFields,
        status: "failed",
        durationMs: elapsedMs(startedAt),
        errorCode: errorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error)
      },
      "processing span failed"
    );
    throw error;
  }
}

function writeProcessingLog(
  level: ProcessingLogLevel,
  fields: Record<string, unknown>,
  message?: string
): void {
  const payload = {
    level,
    time: new Date().toISOString(),
    ...(message ? { msg: message } : {}),
    ...fields
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.info(line);
}

function processingPayloadLogFields(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    documentSetId: stringField(payload["documentSetId"]),
    documentId: stringField(payload["documentId"]),
    documentVersionId: stringField(payload["documentVersionId"]),
    documentIdentityId: stringField(payload["documentIdentityId"]),
    acceptedFileCount: Array.isArray(payload["acceptedFileIds"])
      ? payload["acceptedFileIds"].length
      : undefined
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return error instanceof Error ? error.name : "unknown_error";
}
