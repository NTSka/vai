import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";

import {
  createBaselineFactsRepository,
  createBaselineProcessingRepository,
  createDocumentIntakeRepository,
  createProjectStructureRepository
} from "../../infrastructure/persistence/repositories.js";
import { baselineWarningSchema } from "../../baseline-processing/warnings.js";
import { HttpError } from "../http-error.js";

const organizationParamsSchema = z.object({
  organizationId: z.string().min(1)
});

const documentSetStatusResponseSchema = z.object({
  organizationId: z.string(),
  documentSetId: z.string(),
  intakeStatus: z.enum(["uploaded", "intake_processing", "accepted", "failed"]),
  baselineStatus: z
    .enum(["not_started", "processing", "completed", "completed_with_warnings", "failed"])
    .default("not_started"),
  warnings: z.array(baselineWarningSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
  baselineUpdatedAt: z.date().nullable()
});

const projectTreeNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.string(),
  key: z.string(),
  title: z.string(),
  subject: z.string().nullable(),
  documentCount: z.number(),
  createdAt: z.date(),
  updatedAt: z.date()
});

const projectTreeResponseSchema = z.object({
  organizationId: z.string(),
  nodes: z.array(projectTreeNodeSchema),
  fallbackGroups: z.array(
    z.object({
      id: z.enum(["unplaced", "unsupported"]),
      title: z.string(),
      documentCount: z.number()
    })
  )
});

const nodeDocumentsResponseSchema = z.object({
  organizationId: z.string(),
  nodeId: z.string(),
  documents: z.array(
    z.object({
      documentId: z.string(),
      documentVersionId: z.string(),
      sourceFileName: z.string(),
      status: z.enum(["registered", "processing", "ready", "failed", "unsupported"]),
      placementStatus: z.enum(["placed", "ambiguous", "unplaced"]).nullable(),
      typeResolution: z
        .object({
          family: z.enum(["estimate", "drawing", "statement", "unsupported", "unknown"]),
          confidence: z.string()
        })
        .nullable()
    })
  )
});

const sourceDocumentMetadataResponseSchema = z.object({
  organizationId: z.string(),
  documentId: z.string(),
  documentVersionId: z.string(),
  status: z.enum(["registered", "processing", "ready", "failed", "unsupported"]),
  sourceFile: z.object({
    id: z.string(),
    originalName: z.string(),
    mimeType: z.string().nullable(),
    extension: z.string().nullable(),
    sizeBytes: z.number(),
    checksum: z.string(),
    checksumAlgorithm: z.literal("sha256"),
    createdAt: z.date()
  }),
  actions: z.object({
    view: z
      .object({
        available: z.boolean(),
        url: z.string().nullable()
      })
      .readonly(),
    download: z.object({
      available: z.boolean(),
      url: z.string()
    })
  })
});

const sourceDocumentAccessResponseSchema = z.object({
  organizationId: z.string(),
  documentVersionId: z.string(),
  mode: z.literal("proxied"),
  viewUrl: z.string().nullable(),
  downloadUrl: z.string()
});

const sourceDocumentViewerResponseSchema = z.discriminatedUnion("viewer", [
  z.object({
    viewer: z.literal("pdf"),
    organizationId: z.string(),
    documentVersionId: z.string(),
    sourceFileName: z.string(),
    downloadUrl: z.string(),
    pages: z.array(
      z.object({
        pageNumber: z.number(),
        widthPx: z.number(),
        heightPx: z.number(),
        dpi: z.number(),
        imageUrl: z.string(),
        text: z.string().optional()
      })
    )
  }),
  z.object({
    viewer: z.literal("xlsx"),
    organizationId: z.string(),
    documentVersionId: z.string(),
    sourceFileName: z.string(),
    downloadUrl: z.string(),
    sheets: z.array(
      z.object({
        name: z.string(),
        rowCount: z.number(),
        columnCount: z.number()
      })
    ),
    cells: z.array(
      z.object({
        sheetName: z.string(),
        cellAddress: z.string(),
        rowNumber: z.number(),
        columnNumber: z.number(),
        value: z.string(),
        valueType: z.string()
      })
    )
  }),
  z.object({
    viewer: z.literal("fallback"),
    organizationId: z.string(),
    documentVersionId: z.string(),
    sourceFileName: z.string(),
    downloadUrl: z.string(),
    reason: z.string()
  })
]);

const typedDataResponseSchema = z.object({
  organizationId: z.string(),
  documentVersionId: z.string(),
  state: z.enum(["available", "not_available"]),
  records: z.array(
    z.object({
      id: z.string(),
      family: z.enum(["estimate", "drawing", "statement", "unsupported", "unknown"]),
      data: z.record(z.string(), z.unknown()),
      producedByJobId: z.string().nullable(),
      createdAt: z.date(),
      updatedAt: z.date()
    })
  )
});

export async function registerBackendReadApiRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get(
    "/organizations/:organizationId/document-sets/:documentSetId/status",
    {
      schema: {
        description: "Read intake and baseline status for one document set.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentSetId: z.string().min(1)
        }),
        response: {
          200: documentSetStatusResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentSetId = (request.params as { documentSetId: string }).documentSetId;
      const db = requireDrizzle(app);
      const documentIntake = createDocumentIntakeRepository(db);
      const baseline = createBaselineProcessingRepository(db);
      const documentSet = await documentIntake.findDocumentSet({
        organizationId: params.organizationId,
        id: documentSetId
      });

      if (!documentSet) {
        throw new HttpError(404, "not_found", "Document set not found");
      }

      const baselineResult = await baseline.findResultForDocumentSet({
        organizationId: params.organizationId,
        documentSetId
      });

      return {
        organizationId: params.organizationId,
        documentSetId,
        intakeStatus: documentSet.status,
        baselineStatus: baselineResult?.status ?? "not_started",
        warnings: baselineResult?.warnings ?? [],
        createdAt: documentSet.createdAt,
        updatedAt: documentSet.updatedAt,
        baselineUpdatedAt: baselineResult?.updatedAt ?? null
      };
    }
  );

  app.get(
    "/organizations/:organizationId/project-structure/tree",
    {
      schema: {
        description: "Read the organization project structure tree.",
        tags: ["backend-read"],
        params: organizationParamsSchema,
        response: {
          200: projectTreeResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const tree = await createProjectStructureRepository(
        requireDrizzle(app)
      ).listOrganizationTree({
        organizationId: params.organizationId
      });

      return {
        organizationId: params.organizationId,
        nodes: tree.nodes.map((node) => ({
          id: node.id,
          parentId: node.parentId ?? null,
          kind: node.kind,
          key: node.key,
          title: node.title,
          subject: node.subject ?? null,
          documentCount: node.documentCount,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt
        })),
        fallbackGroups: [
          ...(tree.fallbackGroups.unplacedCount > 0
            ? [
                {
                  id: "unplaced" as const,
                  title: "Unplaced documents",
                  documentCount: tree.fallbackGroups.unplacedCount
                }
              ]
            : []),
          ...(tree.fallbackGroups.unsupportedCount > 0
            ? [
                {
                  id: "unsupported" as const,
                  title: "Unsupported documents",
                  documentCount: tree.fallbackGroups.unsupportedCount
                }
              ]
            : [])
        ]
      };
    }
  );

  app.get(
    "/organizations/:organizationId/project-structure/nodes/:nodeId/documents",
    {
      schema: {
        description: "Read documents attached to a project structure node.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          nodeId: z.string().min(1)
        }),
        response: {
          200: nodeDocumentsResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const nodeId = (request.params as { nodeId: string }).nodeId;
      const projectStructure = createProjectStructureRepository(requireDrizzle(app));
      const documents =
        nodeId === "unplaced" || nodeId === "unsupported"
          ? await projectStructure.listFallbackDocuments({
              organizationId: params.organizationId,
              group: nodeId
            })
          : await projectStructure.listDocumentsForNode({
              organizationId: params.organizationId,
              nodeId
            });

      return {
        organizationId: params.organizationId,
        nodeId,
        documents
      };
    }
  );

  app.get(
    "/organizations/:organizationId/source-documents/:documentVersionId",
    {
      schema: {
        description: "Read source document metadata and available actions.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1)
        }),
        response: {
          200: sourceDocumentMetadataResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const source = await loadSourceDocument(app, params.organizationId, documentVersionId);
      const contentUrl = sourceContentUrl(params.organizationId, documentVersionId);
      const canView = canInlineView(source.storedFile.mimeType);

      return {
        organizationId: params.organizationId,
        documentId: source.version.documentId,
        documentVersionId,
        status: source.version.status,
        sourceFile: {
          id: source.storedFile.id,
          originalName: source.storedFile.originalName,
          mimeType: source.storedFile.mimeType ?? null,
          extension: source.storedFile.extension ?? null,
          sizeBytes: source.storedFile.sizeBytes,
          checksum: source.storedFile.checksum,
          checksumAlgorithm: source.storedFile.checksumAlgorithm,
          createdAt: source.storedFile.createdAt
        },
        actions: {
          view: {
            available: canView,
            url: canView ? `${contentUrl}?disposition=inline` : null
          },
          download: {
            available: true,
            url: `${contentUrl}?disposition=attachment`
          }
        }
      };
    }
  );

  app.get(
    "/organizations/:organizationId/source-documents/:documentVersionId/access",
    {
      schema: {
        description: "Read proxied source document view/download URLs.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1)
        }),
        response: {
          200: sourceDocumentAccessResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const source = await loadSourceDocument(app, params.organizationId, documentVersionId);
      const contentUrl = sourceContentUrl(params.organizationId, documentVersionId);

      return {
        organizationId: params.organizationId,
        documentVersionId,
        mode: "proxied" as const,
        viewUrl: canInlineView(source.storedFile.mimeType)
          ? `${contentUrl}?disposition=inline`
          : null,
        downloadUrl: `${contentUrl}?disposition=attachment`
      };
    }
  );

  app.get(
    "/organizations/:organizationId/source-documents/:documentVersionId/content",
    {
      schema: {
        description: "Proxy source document content after organization authorization.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1)
        }),
        querystring: z.object({
          disposition: z.enum(["inline", "attachment"]).default("attachment")
        }),
        response: {
          200: z.any().describe("Binary source document stream.")
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request, reply) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const query = request.query as { disposition: "inline" | "attachment" };
      const source = await loadSourceDocument(app, params.organizationId, documentVersionId);
      const { bucket, key } = source.storedFile.storage;
      if (!bucket) {
        throw new HttpError(409, "source_unavailable", "Source file bucket is missing");
      }

      const stream = await app.objectStorage.getObject({ bucket, key });
      reply
        .type(source.storedFile.mimeType ?? "application/octet-stream")
        .header(
          "content-disposition",
          `${query.disposition}; filename="${source.storedFile.originalName.replaceAll('"', "")}"`
        );

      return reply.send(stream);
    }
  );

  app.get(
    "/organizations/:organizationId/source-documents/:documentVersionId/viewer",
    {
      schema: {
        description: "Read dedicated source viewer data for PDF and XLSX documents.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1)
        }),
        response: {
          200: sourceDocumentViewerResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const source = await loadSourceDocument(app, params.organizationId, documentVersionId);
      const baselineFacts = createBaselineFactsRepository(requireDrizzle(app));
      const artifacts = await baselineFacts.listContentArtifacts({
        organizationId: params.organizationId,
        documentVersionId
      });
      const downloadUrl = `${sourceContentUrl(
        params.organizationId,
        documentVersionId
      )}?disposition=attachment`;
      const format = normalizedSourceFormat(source.storedFile);

      if (format === "pdf") {
        const renderedPages = artifacts.find(
          (artifact) => artifact.artifactType === "pdf_rendered_pages"
        );
        if (!renderedPages) {
          return fallbackViewer(params.organizationId, documentVersionId, source.storedFile.originalName, downloadUrl, "PDF render artifacts are not available yet");
        }
        const textLayer = artifacts.find((artifact) => artifact.artifactType === "pdf_text_layer");
        return {
          viewer: "pdf" as const,
          organizationId: params.organizationId,
          documentVersionId,
          sourceFileName: source.storedFile.originalName,
          downloadUrl,
          pages: parsePdfRenderedPages(renderedPages.payload).map((page) => ({
            pageNumber: page.pageNumber,
            widthPx: page.widthPx,
            heightPx: page.heightPx,
            dpi: page.dpi,
            imageUrl: `${sourceContentUrl(
              params.organizationId,
              documentVersionId
            )}/viewer-artifacts/pdf-rendered-pages/${page.pageNumber}`,
            ...(findPdfPageText(textLayer?.payload, page.pageNumber)
              ? { text: findPdfPageText(textLayer?.payload, page.pageNumber) }
              : {})
          }))
        };
      }

      if (format === "xlsx") {
        const workbook = artifacts.find((artifact) => artifact.artifactType === "xlsx_workbook");
        const cells = artifacts.find((artifact) => artifact.artifactType === "xlsx_cells");
        if (!workbook || !cells) {
          return fallbackViewer(params.organizationId, documentVersionId, source.storedFile.originalName, downloadUrl, "XLSX workbook artifacts are not available yet");
        }

        return {
          viewer: "xlsx" as const,
          organizationId: params.organizationId,
          documentVersionId,
          sourceFileName: source.storedFile.originalName,
          downloadUrl,
          sheets: parseXlsxSheets(workbook.payload),
          cells: await parseXlsxCells(app, cells.payload)
        };
      }

      return fallbackViewer(
        params.organizationId,
        documentVersionId,
        source.storedFile.originalName,
        downloadUrl,
        "Dedicated viewer is not available for this source format"
      );
    }
  );

  app.get(
    "/organizations/:organizationId/source-documents/:documentVersionId/content/viewer-artifacts/pdf-rendered-pages/:pageNumber",
    {
      schema: {
        description: "Proxy one generated PDF rendered page after organization authorization.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1),
          pageNumber: z.coerce.number().int().positive()
        }),
        response: {
          200: z.any().describe("Binary rendered PDF page stream.")
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request, reply) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const pageNumber = (request.params as { pageNumber: number }).pageNumber;
      await loadSourceDocument(app, params.organizationId, documentVersionId);
      const artifact = await createBaselineFactsRepository(requireDrizzle(app)).findContentArtifact({
        organizationId: params.organizationId,
        documentVersionId,
        artifactType: "pdf_rendered_pages"
      });
      if (!artifact) {
        throw new HttpError(404, "not_found", "Rendered PDF page not found");
      }
      const page = parsePdfRenderedPages(artifact.payload).find(
        (candidate) => candidate.pageNumber === pageNumber
      );
      if (!page) {
        throw new HttpError(404, "not_found", "Rendered PDF page not found");
      }

      const stream = await app.objectStorage.getObject({
        bucket: page.payloadRef.bucket,
        key: page.payloadRef.key
      });
      reply.type(page.payloadRef.contentType);

      return reply.send(stream);
    }
  );

  app.get(
    "/organizations/:organizationId/document-versions/:documentVersionId/typed-data",
    {
      schema: {
        description: "Read placeholder typed document data for a document version.",
        tags: ["backend-read"],
        params: organizationParamsSchema.extend({
          documentVersionId: z.string().min(1)
        }),
        response: {
          200: typedDataResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      const params = assertOrganizationParam(request.params as { organizationId: string }, request);
      const documentVersionId = (request.params as { documentVersionId: string })
        .documentVersionId;
      const baselineFacts = createBaselineFactsRepository(requireDrizzle(app));
      const version = await baselineFacts.findDocumentVersion({
        organizationId: params.organizationId,
        id: documentVersionId
      });
      if (!version) {
        throw new HttpError(404, "not_found", "Document version not found");
      }

      const records = await baselineFacts.listTypedDataRecords({
        organizationId: params.organizationId,
        documentVersionId
      });

      return {
        organizationId: params.organizationId,
        documentVersionId,
        state: records.length > 0 ? "available" : "not_available",
        records: records.map((record) => ({
          id: record.id,
          family: record.family,
          data: record.data,
          producedByJobId: record.producedByJobId ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        }))
      };
    }
  );
}

function assertOrganizationParam(
  params: { readonly organizationId: string },
  request: { readonly organization?: { readonly id: string } | null }
): { readonly organizationId: string } {
  if (!request.organization) {
    throw new HttpError(500, "internal_error", "Organization context missing");
  }
  if (params.organizationId !== request.organization.id) {
    throw new HttpError(403, "forbidden", "Organization membership is required");
  }

  return { organizationId: request.organization.id };
}

function requireDrizzle(app: FastifyInstance) {
  const db = app.db.drizzle;
  if (!db) {
    throw new Error("Drizzle database is required for backend read APIs");
  }

  return db;
}

async function loadSourceDocument(
  app: FastifyInstance,
  organizationId: string,
  documentVersionId: string
) {
  const source = await createBaselineFactsRepository(
    requireDrizzle(app)
  ).findDocumentVersionWithStoredFile({
    organizationId,
    documentVersionId
  });
  if (!source) {
    throw new HttpError(404, "not_found", "Source document not found");
  }
  if (source.storedFile.purpose !== "original_upload") {
    throw new HttpError(404, "not_found", "Source document not found");
  }

  return source;
}

function canInlineView(mimeType: string | null): boolean {
  return mimeType === "application/pdf" || mimeType?.startsWith("image/") === true;
}

function normalizedSourceFormat(storedFile: {
  readonly extension: string | null;
  readonly mimeType: string | null;
}): "pdf" | "xlsx" | "other" {
  const extension = storedFile.extension?.toLowerCase();
  if (extension === ".pdf" || storedFile.mimeType === "application/pdf") {
    return "pdf";
  }
  if (
    extension === ".xlsx" ||
    storedFile.mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  return "other";
}

function fallbackViewer(
  organizationId: string,
  documentVersionId: string,
  sourceFileName: string,
  downloadUrl: string,
  reason: string
) {
  return {
    viewer: "fallback" as const,
    organizationId,
    documentVersionId,
    sourceFileName,
    downloadUrl,
    reason
  };
}

function parsePdfRenderedPages(payload: Record<string, unknown>): Array<{
  readonly pageNumber: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
  readonly payloadRef: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string;
  };
}> {
  const pages = Array.isArray(payload["pages"]) ? payload["pages"] : [];
  return pages.flatMap((page) => {
    if (!isRecord(page)) {
      return [];
    }
    const payloadRef = isRecord(page["payloadRef"]) ? page["payloadRef"] : undefined;
    const pageNumber = readNumber(page["pageNumber"]);
    const widthPx = readNumber(page["widthPx"]);
    const heightPx = readNumber(page["heightPx"]);
    const dpi = readNumber(page["dpi"]);
    const bucket = payloadRef ? readString(payloadRef["bucket"]) : undefined;
    const key = payloadRef ? readString(payloadRef["key"]) : undefined;
    const contentType = payloadRef ? readString(payloadRef["contentType"]) : undefined;
    if (!pageNumber || !widthPx || !heightPx || !dpi || !bucket || !key || !contentType) {
      return [];
    }
    return [{ pageNumber, widthPx, heightPx, dpi, payloadRef: { bucket, key, contentType } }];
  });
}

function findPdfPageText(payload: Record<string, unknown> | undefined, pageNumber: number) {
  const pages = payload && Array.isArray(payload["pages"]) ? payload["pages"] : [];
  const page = pages.find(
    (candidate) => isRecord(candidate) && readNumber(candidate["pageNumber"]) === pageNumber
  );
  return isRecord(page) ? readString(page["text"]) : undefined;
}

function parseXlsxSheets(payload: Record<string, unknown>) {
  const workbook = isRecord(payload["workbook"]) ? payload["workbook"] : {};
  const sheets = Array.isArray(workbook["sheets"]) ? workbook["sheets"] : [];
  return sheets.flatMap((sheet) => {
    if (!isRecord(sheet)) {
      return [];
    }
    const name = readString(sheet["name"]);
    if (!name) {
      return [];
    }
    return [
      {
        name,
        rowCount: readNumber(sheet["rowCount"]) ?? 0,
        columnCount: readNumber(sheet["columnCount"]) ?? 0
      }
    ];
  });
}

async function parseXlsxCells(app: FastifyInstance, payload: Record<string, unknown>) {
  const cellPayload =
    payload["storage"] === "payload_ref" ? await readPayloadRef(app, payload) : payload;
  const cells = Array.isArray(cellPayload["cells"]) ? cellPayload["cells"] : [];
  return cells.flatMap((cell) => {
    if (!isRecord(cell)) {
      return [];
    }
    const location = isRecord(cell["location"]) ? cell["location"] : undefined;
    const sheetName = location ? readString(location["sheetName"]) : undefined;
    const cellAddress = location ? readString(location["cellAddress"]) : undefined;
    if (!sheetName || !cellAddress) {
      return [];
    }
    return [
      {
        sheetName,
        cellAddress,
        rowNumber: readNumber(location?.["rowNumber"]) ?? 0,
        columnNumber: readNumber(location?.["columnNumber"]) ?? 0,
        value: stringifyCellValue(cell["value"]),
        valueType: readString(cell["valueType"]) ?? "unknown"
      }
    ];
  });
}

async function readPayloadRef(app: FastifyInstance, payload: Record<string, unknown>) {
  const payloadRef = isRecord(payload["payloadRef"]) ? payload["payloadRef"] : undefined;
  const bucket = payloadRef ? readString(payloadRef["bucket"]) : undefined;
  const key = payloadRef ? readString(payloadRef["key"]) : undefined;
  if (!bucket || !key) {
    throw new HttpError(409, "viewer_artifact_unavailable", "Viewer artifact payload is missing");
  }
  const stream = await app.objectStorage.getObject({ bucket, key });
  const bytes = await readStream(stream);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceContentUrl(organizationId: string, documentVersionId: string): string {
  return `/organizations/${encodeURIComponent(
    organizationId
  )}/source-documents/${encodeURIComponent(documentVersionId)}/content`;
}
