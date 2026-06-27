import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createBaselineFactsRepository,
  createBaselineProcessingRepository,
  createDocumentIntakeRepository,
  createProjectStructureRepository
} from "../../infrastructure/persistence/repositories.js";
import { HttpError } from "../http-error.js";

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  documentVersionId: z.string().optional(),
  processingJobId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

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
  warnings: z.array(warningSchema),
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
          family: z.enum(["estimate", "drawing", "unknown"]),
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

const typedDataResponseSchema = z.object({
  organizationId: z.string(),
  documentVersionId: z.string(),
  state: z.enum(["available", "not_available"]),
  records: z.array(
    z.object({
      id: z.string(),
      family: z.enum(["estimate", "drawing", "unknown"]),
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

function sourceContentUrl(organizationId: string, documentVersionId: string): string {
  return `/organizations/${encodeURIComponent(
    organizationId
  )}/source-documents/${encodeURIComponent(documentVersionId)}/content`;
}
