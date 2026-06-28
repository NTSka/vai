import { z } from "zod";

export const baselineWarningCodeRegistry = {
  unsupported_file_format: {
    message: "Document version uses an unsupported file format"
  },
  document_version_processing_failed: {
    message: "Document version processing failed"
  },
  document_identity_unplaced: {
    message: "Document identity could not be parsed for placement"
  },
  project_structure_placement_ambiguous: {
    message: "Document placement is ambiguous and requires review"
  }
} as const;

export type BaselineWarningCode = keyof typeof baselineWarningCodeRegistry;

export type BaselineProcessingWarning = {
  readonly code: BaselineWarningCode;
  readonly message: string;
  readonly documentVersionId?: string;
  readonly processingJobId?: string;
  readonly details?: Record<string, unknown>;
};

export const baselineWarningSchema = z.object({
  code: z.enum(Object.keys(baselineWarningCodeRegistry) as [BaselineWarningCode, ...BaselineWarningCode[]]),
  message: z.string(),
  documentVersionId: z.string().optional(),
  processingJobId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export function createBaselineWarning(
  code: BaselineWarningCode,
  input: Omit<BaselineProcessingWarning, "code" | "message"> & {
    readonly message?: string;
  } = {}
): BaselineProcessingWarning {
  return {
    code,
    message: input.message ?? baselineWarningCodeRegistry[code].message,
    ...(input.documentVersionId ? { documentVersionId: input.documentVersionId } : {}),
    ...(input.processingJobId ? { processingJobId: input.processingJobId } : {}),
    ...(input.details ? { details: input.details } : {})
  };
}

export function normalizeBaselineWarnings(
  warnings: readonly unknown[]
): BaselineProcessingWarning[] {
  return warnings.map((warning) => {
    const parsed = baselineWarningSchema.parse(warning);
    return createBaselineWarning(parsed.code, {
      message: parsed.message,
      ...(parsed.documentVersionId ? { documentVersionId: parsed.documentVersionId } : {}),
      ...(parsed.processingJobId ? { processingJobId: parsed.processingJobId } : {}),
      ...(parsed.details ? { details: parsed.details } : {})
    });
  });
}
