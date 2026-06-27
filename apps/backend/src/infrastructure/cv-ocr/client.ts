import path from "node:path";
import { existsSync } from "node:fs";

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type {
  CorrelationId,
  PdfMetadataResult,
  PdfRenderProfile,
  PdfRenderResult,
  PdfTextLayerResult,
  ProcessingDiagnostic,
  TechnicalStoredFileRef
} from "@vai/domain-contracts";

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

export type PdfTechnicalInput = {
  readonly file: TechnicalStoredFileRef;
  readonly content: Uint8Array;
  readonly correlationId?: CorrelationId;
};

export class CvOcrClientError extends Error {
  readonly code: "cv_ocr_deadline_exceeded" | "cv_ocr_grpc_error";
  readonly retryable: boolean;
  readonly grpcCode?: grpc.status;

  constructor(input: {
    readonly code: "cv_ocr_deadline_exceeded" | "cv_ocr_grpc_error";
    readonly message: string;
    readonly retryable: boolean;
    readonly grpcCode?: grpc.status;
  }) {
    super(input.message);
    this.name = "CvOcrClientError";
    this.code = input.code;
    this.retryable = input.retryable;
    if (input.grpcCode !== undefined) {
      this.grpcCode = input.grpcCode;
    }
  }
}

type GrpcCallback<T> = (error: grpc.ServiceError | null, response: T) => void;
type GrpcUnary<TRequest, TResponse> = (
  request: TRequest,
  options: grpc.CallOptions,
  callback: GrpcCallback<TResponse>
) => void;

type CvOcrGrpcClient = grpc.Client & {
  CheckHealth: GrpcUnary<Record<string, never>, HealthResponse>;
  ExtractPdfMetadata(
    request: ExtractPdfMetadataRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<ExtractPdfMetadataResponse>
  ): void;
  ExtractPdfTextLayer(
    request: ExtractPdfTextLayerRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<ExtractPdfTextLayerResponse>
  ): void;
  RenderPdfPages(
    request: RenderPdfPagesRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<RenderPdfPagesResponse>
  ): void;
};

export function createCvOcrGrpcClient(input: {
  readonly address: string;
  readonly protoPath?: string;
  readonly deadlineMs?: number;
}): CvOcrClient {
  const packageDefinition = protoLoader.loadSync(input.protoPath ?? defaultProtoPath(), {
    defaults: true,
    keepCase: false,
    longs: Number,
    oneofs: true
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as ProtoRoot;
  const client = new loaded.vai.cv_ocr.v1.CvOcrService(
    input.address,
    grpc.credentials.createInsecure()
  ) as CvOcrGrpcClient;
  const deadlineMs = input.deadlineMs ?? 30_000;

  return {
    checkHealth: () =>
      unary((callback) => client.CheckHealth({}, callOptions(deadlineMs), callback)),

    async extractPdfMetadata(request) {
      const response = await unary<ExtractPdfMetadataResponse>((callback) =>
        client.ExtractPdfMetadata(
          {
            context: buildContext(request, "pdf_metadata_extraction")
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        metadata: {
          pageCount: response.metadata.pageCount,
          encrypted: response.metadata.encrypted,
          title: response.metadata.title,
          author: response.metadata.author,
          pages: response.metadata.pages.map((page) => ({
            pageNumber: page.pageNumber,
            widthPoints: page.widthPoints,
            heightPoints: page.heightPoints,
            rotationDegrees: page.rotationDegrees
          }))
        },
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    async extractPdfTextLayer(request) {
      const response = await unary<ExtractPdfTextLayerResponse>((callback) =>
        client.ExtractPdfTextLayer(
          {
            context: buildContext(request, "pdf_text_layer_extraction")
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        pages: response.pages.map((page) => ({
          pageNumber: page.pageNumber,
          text: page.text,
          words: page.words.map((word) => ({
            text: word.text,
            bbox: {
              pageNumber: word.bbox.pageNumber,
              x: word.bbox.x,
              y: word.bbox.y,
              width: word.bbox.width,
              height: word.bbox.height,
              coordinateSystem: mapCoordinateSystem(word.bbox.coordinateSystem)
            },
            blockIndex: word.blockIndex,
            lineIndex: word.lineIndex,
            wordIndex: word.wordIndex
          }))
        })),
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    async renderPdfPages(request) {
      const response = await unary<RenderPdfPagesResponse>((callback) =>
        client.RenderPdfPages(
          {
            context: buildContext(request, "pdf_page_rendering"),
            profile: request.profile
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        pages: response.pages.map((page) => ({
          pageNumber: page.pageNumber,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
          dpi: page.dpi,
          imageFormat: "png",
          sha256: page.sha256,
          sizeBytes: page.sizeBytes,
          content: page.content
        })),
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    close: () => client.close()
  };
}

function unary<T>(
  call: (callback: GrpcCallback<T>) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    call((error, response) => {
      if (error) {
        reject(mapGrpcError(error));
        return;
      }
      resolve(response);
    });
  });
}

function callOptions(deadlineMs: number): grpc.CallOptions {
  return {
    deadline: new Date(Date.now() + deadlineMs)
  };
}

function mapGrpcError(error: grpc.ServiceError): CvOcrClientError {
  if (error.code === grpc.status.DEADLINE_EXCEEDED) {
    return new CvOcrClientError({
      code: "cv_ocr_deadline_exceeded",
      message: "CV/OCR service call exceeded its deadline",
      retryable: true,
      grpcCode: error.code
    });
  }

  return new CvOcrClientError({
    code: "cv_ocr_grpc_error",
    message: error.message,
    retryable: isRetryableGrpcStatus(error.code),
    grpcCode: error.code
  });
}

function isRetryableGrpcStatus(code: grpc.status): boolean {
  return [
    grpc.status.CANCELLED,
    grpc.status.UNKNOWN,
    grpc.status.RESOURCE_EXHAUSTED,
    grpc.status.ABORTED,
    grpc.status.UNAVAILABLE,
    grpc.status.DATA_LOSS
  ].includes(code);
}

function buildContext(input: PdfTechnicalInput, operation: string): PdfOperationContext {
  return {
    file: {
      documentVersionId: input.file.documentVersionId,
      storedFileId: input.file.storedFileId,
      originalName: input.file.originalName,
      mimeType: input.file.mimeType,
      sizeBytes: input.file.sizeBytes,
      checksum: input.file.checksum,
      checksumAlgorithm: input.file.checksumAlgorithm
    },
    source: { content: input.content },
    operation,
    correlationId: input.correlationId ?? ""
  };
}

function mapDiagnostic(input: DiagnosticMessage): ProcessingDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity:
      input.severity === "info" || input.severity === "warning" || input.severity === "error"
        ? input.severity
        : "warning"
  };
}

function mapCoordinateSystem(input: string): "page_points" | "page_px" | "normalized" {
  if (input === "page_px" || input === "normalized") {
    return input;
  }
  return "page_points";
}

function defaultProtoPath(): string {
  return resolveProtoPath(process.cwd());
}

export function resolveProtoPath(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(
      current,
      "packages/proto/proto/vai/cv_ocr/v1/cv_ocr_service.proto"
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return candidate;
    }
    current = parent;
  }
}

type ProtoRoot = {
  readonly vai: {
    readonly cv_ocr: {
      readonly v1: {
        readonly CvOcrService: typeof grpc.Client;
      };
    };
  };
};

type HealthResponse = {
  readonly status: string;
  readonly service: string;
  readonly version: string;
};

type TechnicalFileRefMessage = {
  readonly documentVersionId: string;
  readonly storedFileId: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly checksumAlgorithm: string;
};

type PdfOperationContext = {
  readonly file: TechnicalFileRefMessage;
  readonly source: { readonly content: Uint8Array };
  readonly operation: string;
  readonly correlationId: string;
};

type ExtractPdfMetadataRequest = {
  readonly context: PdfOperationContext;
};

type ExtractPdfTextLayerRequest = {
  readonly context: PdfOperationContext;
};

type RenderPdfPagesRequest = {
  readonly context: PdfOperationContext;
  readonly profile: PdfRenderProfile;
};

type DiagnosticMessage = {
  readonly code: string;
  readonly message: string;
  readonly severity: string;
};

type ExtractPdfMetadataResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly metadata: {
    readonly pageCount: number;
    readonly encrypted: boolean;
    readonly title: string;
    readonly author: string;
    readonly pages: readonly {
      readonly pageNumber: number;
      readonly widthPoints: number;
      readonly heightPoints: number;
      readonly rotationDegrees: number;
    }[];
  };
  readonly diagnostics: readonly DiagnosticMessage[];
};

type ExtractPdfTextLayerResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly text: string;
    readonly words: readonly {
      readonly text: string;
      readonly bbox: {
        readonly pageNumber: number;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly coordinateSystem: string;
      };
      readonly blockIndex: number;
      readonly lineIndex: number;
      readonly wordIndex: number;
    }[];
  }[];
  readonly diagnostics: readonly DiagnosticMessage[];
};

type RenderPdfPagesResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly dpi: number;
    readonly imageFormat: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly content: Uint8Array;
  }[];
  readonly diagnostics: readonly DiagnosticMessage[];
};
