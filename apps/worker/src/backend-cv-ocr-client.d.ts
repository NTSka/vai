declare module "@vai/backend/cv-ocr-client" {
  import type {
    CorrelationId,
    PdfMetadataResult,
    PdfRenderProfile,
    PdfRenderResult,
    PdfTextLayerResult,
    TechnicalStoredFileRef
  } from "@vai/domain-contracts";

  export class CvOcrClientError extends Error {
    readonly code: "cv_ocr_deadline_exceeded" | "cv_ocr_grpc_error";
    readonly retryable: boolean;
    readonly grpcCode?: number;
  }

  export type PdfTechnicalInput = {
    readonly file: TechnicalStoredFileRef;
    readonly content: Uint8Array;
    readonly correlationId?: CorrelationId;
  };

  export type CvOcrClient = {
    readonly checkHealth: () => Promise<{
      readonly status: string;
      readonly service: string;
      readonly version: string;
    }>;
    readonly extractPdfMetadata: (input: PdfTechnicalInput) => Promise<PdfMetadataResult>;
    readonly extractPdfTextLayer: (input: PdfTechnicalInput) => Promise<PdfTextLayerResult>;
    readonly renderPdfPages: (
      input: PdfTechnicalInput & { readonly profile: PdfRenderProfile }
    ) => Promise<PdfRenderResult>;
    readonly close: () => void;
  };

  export function createCvOcrGrpcClient(input: {
    readonly address: string;
    readonly protoPath?: string;
    readonly deadlineMs?: number;
  }): CvOcrClient;

  export function resolveProtoPath(start: string): string;
}
