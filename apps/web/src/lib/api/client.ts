import type { z } from "zod";

import {
  documentSetStatusSchema,
  nodeDocumentsSchema,
  processingProgressSchema,
  projectTreeSchema,
  sessionSchema,
  sourceDocumentMetadataSchema,
  sourceDocumentViewerSchema,
  typedDataSchema,
  uploadResponseSchema
} from "./schemas";
import type {
  DocumentSetStatus,
  NodeDocuments,
  ProcessingProgress,
  ProjectTree,
  Session,
  SourceDocumentMetadata,
  SourceDocumentViewer,
  TypedData,
  UploadResponse
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
  }
}

type ApiFetch = typeof fetch;

const emptyResponseSchema = {
  safeParse: () => ({ success: true, data: undefined }) as const
} satisfies Pick<z.ZodType<void>, "safeParse">;

async function request<T>(
  fetcher: ApiFetch,
  path: string,
  schema: Pick<z.ZodType<T>, "safeParse">,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetcher(path, {
    ...init,
    credentials: "include",
    headers:
      init.body instanceof FormData
        ? init.headers
        : {
            "content-type": "application/json",
            ...init.headers
          }
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError({
      status: response.status,
      code: "invalid_api_response",
      message: `Ответ backend для ${path} не соответствует frontend-контракту`
    });
  }

  return parsed.data;
}

async function toApiError(response: Response): Promise<ApiError> {
  const fallback = {
    code: `http_${response.status}`,
    message: response.statusText || "Request failed"
  };

  try {
    const body = (await response.json()) as Partial<{
      error: { code?: string; message?: string };
      code: string;
      message: string;
    }>;
    const nested = body.error;
    return new ApiError({
      status: response.status,
      code: nested?.code ?? body.code ?? fallback.code,
      message: nested?.message ?? body.message ?? fallback.message
    });
  } catch {
    return new ApiError({ status: response.status, ...fallback });
  }
}

export const api = {
  login(fetcher: ApiFetch, input: { login: string; password: string }) {
    return request<Session>(fetcher, "/auth/login", sessionSchema, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  session(fetcher: ApiFetch) {
    return request<Session>(fetcher, "/auth/session", sessionSchema);
  },

  logout(fetcher: ApiFetch) {
    return request<void>(fetcher, "/auth/logout", emptyResponseSchema, {
      method: "POST"
    });
  },

  upload(
    fetcher: ApiFetch,
    input: { organizationId: string; files: FileList | File[] }
  ) {
    const form = new FormData();
    for (const file of Array.from(input.files)) {
      form.append("files", file);
    }

    return request<UploadResponse>(
      fetcher,
      "/document-sets/uploads",
      uploadResponseSchema,
      {
        method: "POST",
        body: form,
        headers: {
          "x-organization-id": input.organizationId
        }
      }
    );
  },

  documentSetStatus(
    fetcher: ApiFetch,
    input: { organizationId: string; documentSetId: string }
  ) {
    return request<DocumentSetStatus>(
      fetcher,
      `/organizations/${encodeURIComponent(
        input.organizationId
      )}/document-sets/${encodeURIComponent(input.documentSetId)}/status`,
      documentSetStatusSchema
    );
  },

  progress(fetcher: ApiFetch, organizationId: string) {
    return request<ProcessingProgress>(
      fetcher,
      `/organizations/${encodeURIComponent(organizationId)}/processing/progress`,
      processingProgressSchema
    );
  },

  projectTree(fetcher: ApiFetch, organizationId: string) {
    return request<ProjectTree>(
      fetcher,
      `/organizations/${encodeURIComponent(organizationId)}/project-structure/tree`,
      projectTreeSchema
    );
  },

  nodeDocuments(
    fetcher: ApiFetch,
    input: { organizationId: string; nodeId: string }
  ) {
    return request<NodeDocuments>(
      fetcher,
      `/organizations/${encodeURIComponent(
        input.organizationId
      )}/project-structure/nodes/${encodeURIComponent(input.nodeId)}/documents`,
      nodeDocumentsSchema
    );
  },

  sourceDocument(
    fetcher: ApiFetch,
    input: { organizationId: string; documentVersionId: string }
  ) {
    return request<SourceDocumentMetadata>(
      fetcher,
      `/organizations/${encodeURIComponent(
        input.organizationId
      )}/source-documents/${encodeURIComponent(input.documentVersionId)}`,
      sourceDocumentMetadataSchema
    );
  },

  sourceDocumentViewer(
    fetcher: ApiFetch,
    input: { organizationId: string; documentVersionId: string }
  ) {
    return request<SourceDocumentViewer>(
      fetcher,
      `/organizations/${encodeURIComponent(
        input.organizationId
      )}/source-documents/${encodeURIComponent(input.documentVersionId)}/viewer`,
      sourceDocumentViewerSchema
    );
  },

  typedData(
    fetcher: ApiFetch,
    input: { organizationId: string; documentVersionId: string }
  ) {
    return request<TypedData>(
      fetcher,
      `/organizations/${encodeURIComponent(
        input.organizationId
      )}/document-versions/${encodeURIComponent(input.documentVersionId)}/typed-data`,
      typedDataSchema
    );
  }
};
