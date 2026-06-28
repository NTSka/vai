import path from "node:path";
import { existsSync } from "node:fs";

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type {
  CorrelationId,
  PdfMetadataResult,
  OcrCandidatePlanResult,
  PdfRenderProfile,
  PdfRenderResult,
  PdfLayoutRegion,
  PdfLayoutResult,
  PdfTableReconstructionResult,
  PdfTextLayerResult,
  ProcessingDiagnostic,
  TargetedOcrResult,
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
  readonly detectPdfLayout: (input: DetectPdfLayoutInput) => Promise<PdfLayoutResult>;
  readonly planPdfOcrCandidates: (
    input: PlanPdfOcrCandidatesInput
  ) => Promise<OcrCandidatePlanResult>;
  readonly runPdfTargetedOcr: (input: RunPdfTargetedOcrInput) => Promise<TargetedOcrResult>;
  readonly reconstructPdfTables: (
    input: ReconstructPdfTablesInput
  ) => Promise<PdfTableReconstructionResult>;
  readonly close: () => void;
};

export type PdfTechnicalInput = {
  readonly file: TechnicalStoredFileRef;
  readonly content: Uint8Array;
  readonly correlationId?: CorrelationId;
};

export type DetectPdfLayoutInput = {
  readonly renderedPages: PdfRenderResult["pages"];
  readonly textPages?: PdfTextLayerResult["pages"];
};

export type PlanPdfOcrCandidatesInput = {
  readonly regions: PdfLayoutResult["regions"];
  readonly renderedPages: PdfRenderResult["pages"];
};

export type RunPdfTargetedOcrInput = {
  readonly renderedPages: PdfRenderResult["pages"];
  readonly candidates: OcrCandidatePlanResult["candidates"];
  readonly textPages?: PdfTextLayerResult["pages"];
  readonly tesseractBinary?: string;
};

export type ReconstructPdfTablesInput = {
  readonly regions: PdfLayoutResult["regions"];
  readonly ocrTexts: TargetedOcrResult["texts"];
  readonly candidates?: OcrCandidatePlanResult["candidates"];
  readonly renderedPages: PdfRenderResult["pages"];
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
  DetectPdfLayout(
    request: DetectPdfLayoutRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<DetectPdfLayoutResponse>
  ): void;
  PlanPdfOcrCandidates(
    request: PlanPdfOcrCandidatesRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<PlanPdfOcrCandidatesResponse>
  ): void;
  RunPdfTargetedOcr(
    request: RunPdfTargetedOcrRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<RunPdfTargetedOcrResponse>
  ): void;
  ReconstructPdfTables(
    request: ReconstructPdfTablesRequest,
    options: grpc.CallOptions,
    callback: GrpcCallback<ReconstructPdfTablesResponse>
  ): void;
};

export function createCvOcrGrpcClient(input: {
  readonly address: string;
  readonly protoPath?: string;
  readonly deadlineMs?: number;
  readonly maxMessageBytes?: number;
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
    grpc.credentials.createInsecure(),
    {
      "grpc.max_send_message_length": input.maxMessageBytes ?? 512 * 1024 * 1024,
      "grpc.max_receive_message_length": input.maxMessageBytes ?? 512 * 1024 * 1024
    }
  ) as CvOcrGrpcClient;
  const deadlineMs = input.deadlineMs ?? 300_000;

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

    async detectPdfLayout(request) {
      const response = await unary<DetectPdfLayoutResponse>((callback) =>
        client.DetectPdfLayout(
          {
            renderedPages: request.renderedPages.map(mapRenderedPageMessage),
            textPages: (request.textPages ?? []).map(mapTextPageMessage)
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        regions: response.regions.map(mapLayoutRegion),
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    async planPdfOcrCandidates(request) {
      const response = await unary<PlanPdfOcrCandidatesResponse>((callback) =>
        client.PlanPdfOcrCandidates(
          {
            regions: request.regions.map(mapLayoutRegionMessage),
            renderedPages: request.renderedPages.map(mapRenderedPageMessage)
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        candidates: response.candidates.map((candidate) => ({
          localId: candidate.localId,
          targetKind: mapOcrTargetKind(candidate.targetKind),
          sourceRegionId: candidate.sourceRegionId,
          location: mapLocation(candidate.location),
          ...(candidate.expectedValueKind
            ? { expectedValueKind: candidate.expectedValueKind }
            : {}),
          ...(candidate.metadataJson ? { metadataJson: candidate.metadataJson } : {})
        })),
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    async runPdfTargetedOcr(request) {
      const response = await unary<RunPdfTargetedOcrResponse>((callback) =>
        client.RunPdfTargetedOcr(
          {
            renderedPages: request.renderedPages.map(mapRenderedPageMessage),
            candidates: request.candidates.map(mapOcrCandidateMessage),
            textPages: (request.textPages ?? []).map(mapTextPageMessage),
            tesseractBinary: request.tesseractBinary ?? ""
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        texts: response.texts.map((text) => ({
          localId: text.localId,
          sourceCandidateId: text.sourceCandidateId,
          text: text.text,
          confidence: text.confidence,
          engine: text.engine,
          engineVersion: text.engineVersion
        })),
        diagnostics: response.diagnostics.map(mapDiagnostic)
      };
    },

    async reconstructPdfTables(request) {
      const response = await unary<ReconstructPdfTablesResponse>((callback) =>
        client.ReconstructPdfTables(
          {
            regions: request.regions.map(mapLayoutRegionMessage),
            ocrTexts: request.ocrTexts.map((text) => ({
              localId: text.localId,
              sourceCandidateId: text.sourceCandidateId,
              text: text.text,
              confidence: text.confidence,
              engine: text.engine,
              engineVersion: text.engineVersion
            })),
            candidates: (request.candidates ?? []).map(mapOcrCandidateMessage),
            renderedPages: request.renderedPages.map(mapRenderedPageMessage)
          },
          callOptions(deadlineMs),
          callback
        )
      );
      return {
        adapter: { id: response.adapterId, version: response.adapterVersion },
        tables: response.tables.map((table) => ({
          localId: table.localId,
          sourceRegionId: table.sourceRegionId,
          sourceRegionIds: table.sourceRegionIds,
          rows: table.rows.map((row) =>
            row.cells.map((cell) => ({
              rowIndex: cell.rowIndex,
              columnIndex: cell.columnIndex,
              text: cell.text,
              location: mapLocation(cell.location),
              confidence: cell.confidence,
              rowSpan: cell.rowSpan,
              columnSpan: cell.columnSpan,
              ...(cell.rawText ? { rawText: cell.rawText } : {}),
              sourceCandidateIds: cell.sourceCandidateIds,
              ...(cell.selectedCandidateId
                ? { selectedCandidateId: cell.selectedCandidateId }
                : {}),
              ...(cell.ocrQualityStatus ? { ocrQualityStatus: cell.ocrQualityStatus } : {}),
              qualityFlags: cell.qualityFlags,
              ...(cell.metadataJson ? { metadataJson: cell.metadataJson } : {})
            }))
          ),
          ...(table.coveragePolicy ? { coveragePolicy: table.coveragePolicy } : {}),
          qualityFlags: table.qualityFlags,
          missingOcrCandidateCount: table.missingOcrCandidateCount,
          missingOcrTextCount: table.missingOcrTextCount,
          lowConfidenceOcrCount: table.lowConfidenceOcrCount,
          emptyOcrTextCount: table.emptyOcrTextCount,
          ...(table.metadataJson ? { metadataJson: table.metadataJson } : {})
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

function mapLayoutRegion(input: LayoutRegionMessage): PdfLayoutRegion {
  return {
    localId: input.localId,
    regionKind: mapLayoutRegionKind(input.regionKind),
    location: mapLocation(input.location),
    confidence: input.confidence,
    source: input.source,
    ...(input.metadataJson ? { metadataJson: input.metadataJson } : {})
  };
}

function mapLayoutRegionKind(input: string): PdfLayoutRegion["regionKind"] {
  if (
    input === "drawing_area" ||
    input === "stamp_candidate" ||
    input === "table_candidate" ||
    input === "text_block"
  ) {
    return input;
  }
  return "other";
}

function mapOcrTargetKind(input: string): "stamp_field" | "table_cell" | "text_region" | "other" {
  if (input === "stamp_field" || input === "table_cell" || input === "text_region") {
    return input;
  }
  return "other";
}

function mapLocation(input: LocationMessage): { readonly bbox: ReturnType<typeof mapBbox> } {
  return { bbox: mapBbox(input.bbox) };
}

function mapBbox(input: BboxMessage) {
  return {
    pageNumber: input.pageNumber,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    coordinateSystem: mapCoordinateSystem(input.coordinateSystem)
  };
}

function mapRenderedPageMessage(page: PdfRenderResult["pages"][number]): RenderedPageMessage {
  return {
    pageNumber: page.pageNumber,
    widthPx: page.widthPx,
    heightPx: page.heightPx,
    dpi: page.dpi,
    imageFormat: page.imageFormat,
    sha256: page.sha256,
    sizeBytes: page.sizeBytes,
    content: page.content
  };
}

function mapTextPageMessage(page: PdfTextLayerResult["pages"][number]): TextPageMessage {
  return {
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
        coordinateSystem: word.bbox.coordinateSystem
      },
      blockIndex: word.blockIndex,
      lineIndex: word.lineIndex,
      wordIndex: word.wordIndex
    }))
  };
}

function mapLayoutRegionMessage(region: PdfLayoutResult["regions"][number]): LayoutRegionMessage {
  return {
    localId: region.localId,
    regionKind: region.regionKind,
    location: { bbox: region.location.bbox },
    confidence: region.confidence,
    source: region.source,
    metadataJson: region.metadataJson ?? ""
  };
}

function mapOcrCandidateMessage(
  candidate: OcrCandidatePlanResult["candidates"][number]
): OcrCandidateMessage {
  return {
    localId: candidate.localId,
    targetKind: candidate.targetKind,
    sourceRegionId: candidate.sourceRegionId,
    location: { bbox: candidate.location.bbox },
    expectedValueKind: candidate.expectedValueKind ?? "",
    metadataJson: candidate.metadataJson ?? ""
  };
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

type BboxMessage = {
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinateSystem: string;
};

type LocationMessage = {
  readonly bbox: BboxMessage;
};

type RenderedPageMessage = RenderPdfPagesResponse["pages"][number];

type TextPageMessage = ExtractPdfTextLayerResponse["pages"][number];

type LayoutRegionMessage = {
  readonly localId: string;
  readonly regionKind: string;
  readonly location: LocationMessage;
  readonly confidence: number;
  readonly source: string;
  readonly metadataJson?: string;
};

type OcrCandidateMessage = {
  readonly localId: string;
  readonly targetKind: string;
  readonly sourceRegionId: string;
  readonly location: LocationMessage;
  readonly expectedValueKind: string;
  readonly metadataJson: string;
};

type OcrTextMessage = {
  readonly localId: string;
  readonly sourceCandidateId: string;
  readonly text: string;
  readonly confidence: number;
  readonly engine: string;
  readonly engineVersion: string;
};

type DetectPdfLayoutRequest = {
  readonly renderedPages: readonly RenderedPageMessage[];
  readonly textPages: readonly TextPageMessage[];
};

type DetectPdfLayoutResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly regions: readonly LayoutRegionMessage[];
  readonly diagnostics: readonly DiagnosticMessage[];
};

type PlanPdfOcrCandidatesRequest = {
  readonly regions: readonly LayoutRegionMessage[];
  readonly renderedPages: readonly RenderedPageMessage[];
};

type PlanPdfOcrCandidatesResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly candidates: readonly OcrCandidateMessage[];
  readonly diagnostics: readonly DiagnosticMessage[];
};

type RunPdfTargetedOcrRequest = {
  readonly renderedPages: readonly RenderedPageMessage[];
  readonly candidates: readonly OcrCandidateMessage[];
  readonly textPages: readonly TextPageMessage[];
  readonly tesseractBinary: string;
};

type RunPdfTargetedOcrResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly texts: readonly OcrTextMessage[];
  readonly diagnostics: readonly DiagnosticMessage[];
};

type ReconstructPdfTablesRequest = {
  readonly regions: readonly LayoutRegionMessage[];
  readonly ocrTexts: readonly OcrTextMessage[];
  readonly candidates: readonly OcrCandidateMessage[];
  readonly renderedPages: readonly RenderedPageMessage[];
};

type ReconstructPdfTablesResponse = {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly tables: readonly {
    readonly localId: string;
    readonly sourceRegionId: string;
    readonly sourceRegionIds: readonly string[];
    readonly rows: readonly {
      readonly cells: readonly {
        readonly rowIndex: number;
        readonly columnIndex: number;
        readonly text: string;
        readonly location: LocationMessage;
        readonly confidence: number;
        readonly rowSpan: number;
        readonly columnSpan: number;
        readonly rawText: string;
        readonly sourceCandidateIds: readonly string[];
        readonly selectedCandidateId: string;
        readonly ocrQualityStatus: string;
        readonly qualityFlags: readonly string[];
        readonly metadataJson: string;
      }[];
    }[];
    readonly coveragePolicy: string;
    readonly qualityFlags: readonly string[];
    readonly missingOcrCandidateCount: number;
    readonly missingOcrTextCount: number;
    readonly lowConfidenceOcrCount: number;
    readonly emptyOcrTextCount: number;
    readonly metadataJson: string;
  }[];
  readonly diagnostics: readonly DiagnosticMessage[];
};
