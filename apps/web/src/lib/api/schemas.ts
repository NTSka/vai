import { z } from "zod";

const dateStringSchema = z.string();

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string()
});

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  membershipId: z.string(),
  roleIds: z.array(z.string()),
  permissionKeys: z.array(z.string())
});

export const sessionSchema = z.object({
  user: userSchema,
  organizations: z.array(organizationSchema)
});

export const uploadResponseSchema = z.object({
  documentSetId: z.string(),
  storedFileIds: z.array(z.string()),
  validationJobId: z.string(),
  status: z.literal("uploaded")
});

export const warningSchema = z.object({
  code: z.enum([
    "unsupported_file_format",
    "document_version_processing_failed",
    "document_identity_unplaced",
    "project_structure_placement_ambiguous"
  ]),
  message: z.string(),
  documentVersionId: z.string().optional(),
  processingJobId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const documentSetStatusSchema = z.object({
  organizationId: z.string(),
  documentSetId: z.string(),
  intakeStatus: z.enum(["uploaded", "intake_processing", "accepted", "failed"]),
  baselineStatus: z.enum([
    "not_started",
    "processing",
    "completed",
    "completed_with_warnings",
    "failed"
  ]),
  warnings: z.array(warningSchema),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema,
  baselineUpdatedAt: dateStringSchema.nullable()
});

export const processingProgressSchema = z.object({
  organizationId: z.string(),
  totalDocumentVersions: z.number(),
  completedDocumentVersions: z.number(),
  failedDocumentVersions: z.number(),
  processingDocumentVersions: z.number(),
  totalJobs: z.number(),
  completedJobs: z.number(),
  failedJobs: z.number(),
  runningJobs: z.number(),
  percent: z.number(),
  updatedAt: dateStringSchema
});

export const projectTreeNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.string(),
  key: z.string(),
  title: z.string(),
  subject: z.string().nullable(),
  documentCount: z.number(),
  createdAt: dateStringSchema,
  updatedAt: dateStringSchema
});

export const fallbackGroupSchema = z.object({
  id: z.enum(["unplaced", "unsupported"]),
  title: z.string(),
  documentCount: z.number()
});

export const projectTreeSchema = z.object({
  organizationId: z.string(),
  nodes: z.array(projectTreeNodeSchema),
  fallbackGroups: z.array(fallbackGroupSchema)
});

export const nodeDocumentSchema = z.object({
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
});

export const nodeDocumentsSchema = z.object({
  organizationId: z.string(),
  nodeId: z.string(),
  documents: z.array(nodeDocumentSchema)
});

export const sourceDocumentMetadataSchema = z.object({
  organizationId: z.string(),
  documentId: z.string(),
  documentVersionId: z.string(),
  status: nodeDocumentSchema.shape.status,
  sourceFile: z.object({
    id: z.string(),
    originalName: z.string(),
    mimeType: z.string().nullable(),
    extension: z.string().nullable(),
    sizeBytes: z.number(),
    checksum: z.string(),
    checksumAlgorithm: z.literal("sha256"),
    createdAt: dateStringSchema
  }),
  actions: z.object({
    view: z.object({
      available: z.boolean(),
      url: z.string().nullable()
    }),
    download: z.object({
      available: z.boolean(),
      url: z.string()
    })
  })
});

export const sourceDocumentViewerSchema = z.discriminatedUnion("viewer", [
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
        columnCount: z.number(),
        columns: z.array(
          z.object({
            index: z.number(),
            widthPx: z.number(),
            hidden: z.boolean()
          })
        ),
        rows: z.array(
          z.object({
            index: z.number(),
            heightPx: z.number(),
            hidden: z.boolean()
          })
        ),
        merges: z.array(
          z.object({
            range: z.string(),
            startRow: z.number(),
            startColumn: z.number(),
            endRow: z.number(),
            endColumn: z.number(),
            rowSpan: z.number(),
            columnSpan: z.number()
          })
        )
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

export const typedDataSchema = z.object({
  organizationId: z.string(),
  documentVersionId: z.string(),
  state: z.enum(["available", "not_available"]),
  records: z.array(
    z.object({
      id: z.string(),
      family: z.enum(["estimate", "drawing", "statement", "unsupported", "unknown"]),
      data: z.record(z.string(), z.unknown()),
      producedByJobId: z.string().nullable(),
      createdAt: dateStringSchema,
      updatedAt: dateStringSchema
    })
  )
});
