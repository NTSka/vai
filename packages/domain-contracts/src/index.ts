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
