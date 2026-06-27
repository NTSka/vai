export type OrganizationId = string & { readonly __brand: "OrganizationId" };

export type CorrelationId = string & { readonly __brand: "CorrelationId" };

export type DocumentVersionId = string & {
  readonly __brand: "DocumentVersionId";
};

export type StoredFileId = string & { readonly __brand: "StoredFileId" };

export type SupportedFileFormat = "pdf" | "xlsx";

export type FileTechnicalOperation =
  | "format_detection"
  | "pdf_metadata_extraction"
  | "pdf_page_rendering"
  | "pdf_text_layer_extraction"
  | "xlsx_metadata_extraction"
  | "xlsx_workbook_extraction";

export type FileTechnicalAdapterRef = {
  readonly id: string;
  readonly version: string;
};

export type TechnicalStoredFileRef = {
  readonly documentVersionId: DocumentVersionId;
  readonly storedFileId: StoredFileId;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly checksumAlgorithm: string;
};

export type ProcessingDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
};

export type PdfPageMetadata = {
  readonly pageNumber: number;
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly rotationDegrees: number;
};

export type PdfMetadataResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly metadata: {
    readonly pageCount: number;
    readonly encrypted: boolean;
    readonly title: string;
    readonly author: string;
    readonly pages: readonly PdfPageMetadata[];
  };
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type ContentBoundingBox = {
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinateSystem: "page_points" | "page_px" | "normalized";
};

export type PdfTextWord = {
  readonly text: string;
  readonly bbox: ContentBoundingBox;
  readonly blockIndex: number;
  readonly lineIndex: number;
  readonly wordIndex: number;
};

export type PdfTextLayerResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly text: string;
    readonly words: readonly PdfTextWord[];
  }[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type PdfRenderProfile = {
  readonly dpi: number;
  readonly imageFormat: "png";
  readonly maxPagePixels: number;
};

export type PdfRenderedPage = {
  readonly pageNumber: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly imageFormat: "png";
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly content: Uint8Array;
};

export type PdfRenderResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly pages: readonly PdfRenderedPage[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type ContentLocation = {
  readonly bbox: ContentBoundingBox;
};

export type PdfLayoutRegionKind =
  | "drawing_area"
  | "stamp_candidate"
  | "table_candidate"
  | "text_block"
  | "other";

export type PdfLayoutRegion = {
  readonly localId: string;
  readonly regionKind: PdfLayoutRegionKind;
  readonly location: ContentLocation;
  readonly confidence: number;
  readonly source: string;
  readonly metadataJson?: string;
};

export type PdfLayoutResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly regions: readonly PdfLayoutRegion[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type OcrTargetKind =
  | "stamp_field"
  | "table_cell"
  | "text_region"
  | "other";

export type OcrCandidate = {
  readonly localId: string;
  readonly targetKind: OcrTargetKind;
  readonly sourceRegionId: string;
  readonly location: ContentLocation;
  readonly expectedValueKind?: string;
  readonly metadataJson?: string;
};

export type OcrCandidatePlanResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly candidates: readonly OcrCandidate[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type OcrText = {
  readonly localId: string;
  readonly sourceCandidateId: string;
  readonly text: string;
  readonly confidence: number;
  readonly engine: string;
  readonly engineVersion: string;
};

export type TargetedOcrResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly texts: readonly OcrText[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};

export type TableCellArtifact = {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly text: string;
  readonly location: ContentLocation;
  readonly confidence: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly rawText?: string;
  readonly sourceCandidateIds: readonly string[];
  readonly selectedCandidateId?: string;
  readonly ocrQualityStatus?: string;
  readonly qualityFlags: readonly string[];
  readonly metadataJson?: string;
};

export type PdfTableArtifact = {
  readonly localId: string;
  readonly sourceRegionId: string;
  readonly sourceRegionIds: readonly string[];
  readonly rows: readonly (readonly TableCellArtifact[])[];
  readonly coveragePolicy?: string;
  readonly qualityFlags: readonly string[];
  readonly missingOcrCandidateCount: number;
  readonly missingOcrTextCount: number;
  readonly lowConfidenceOcrCount: number;
  readonly emptyOcrTextCount: number;
  readonly metadataJson?: string;
};

export type PdfTableReconstructionResult = {
  readonly adapter: FileTechnicalAdapterRef;
  readonly tables: readonly PdfTableArtifact[];
  readonly diagnostics: readonly ProcessingDiagnostic[];
};
