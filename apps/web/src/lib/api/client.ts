import type { z } from "zod";

import {
  documentSetStatusSchema,
  documentSetsSchema,
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
  DocumentSets,
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

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

interface UploadInput {
  organizationId: string;
  files: FileList | File[];
  onProgress?: (progress: UploadProgress) => void;
}

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

function uploadWithProgress(input: UploadInput): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of Array.from(input.files)) {
    form.append("files", file);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${uploadOrigin()}/document-sets/uploads`);
    xhr.withCredentials = true;
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader("x-organization-id", input.organizationId);

    xhr.upload.onprogress = (event) => {
      const totalBytes = event.lengthComputable ? event.total : null;
      input.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes,
        percent: totalBytes ? Math.round((event.loaded / totalBytes) * 100) : null
      });
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(toXhrApiError(xhr));
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(
          new ApiError({
            status: xhr.status,
            code: "invalid_api_response",
            message:
              "Ответ backend для /document-sets/uploads не соответствует frontend-контракту"
          })
        );
        return;
      }

      const parsed = uploadResponseSchema.safeParse(body);
      if (!parsed.success) {
        reject(
          new ApiError({
            status: xhr.status,
            code: "invalid_api_response",
            message:
              "Ответ backend для /document-sets/uploads не соответствует frontend-контракту"
          })
        );
        return;
      }

      resolve(parsed.data);
    };

    xhr.onerror = () => {
      reject(
        new ApiError({
          status: xhr.status || 0,
          code: "network_error",
          message: "Не удалось отправить файлы"
        })
      );
    };

    xhr.ontimeout = () => {
      reject(
        new ApiError({
          status: 0,
          code: "upload_timeout",
          message: "Загрузка заняла слишком много времени"
        })
      );
    };

    xhr.onabort = () => {
      reject(
        new ApiError({
          status: 0,
          code: "upload_aborted",
          message: "Загрузка отменена"
        })
      );
    };

    xhr.send(form);
  });
}

function uploadOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const configuredOrigin = window.localStorage.getItem("vai_upload_origin");
  if (configuredOrigin) {
    return configuredOrigin;
  }

  return `${window.location.protocol}//${window.location.hostname}:3000`;
}

function toXhrApiError(xhr: XMLHttpRequest): ApiError {
  const fallback = {
    code: `http_${xhr.status}`,
    message: xhr.statusText || "Request failed"
  };

  try {
    const body = JSON.parse(xhr.responseText) as Partial<{
      error: { code?: string; message?: string };
      code: string;
      message: string;
    }>;
    const nested = body.error;
    return new ApiError({
      status: xhr.status,
      code: nested?.code ?? body.code ?? fallback.code,
      message: nested?.message ?? body.message ?? fallback.message
    });
  } catch {
    return new ApiError({ status: xhr.status, ...fallback });
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

  upload(_fetcher: ApiFetch, input: UploadInput) {
    return uploadWithProgress(input);
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

  documentSets(fetcher: ApiFetch, organizationId: string) {
    return request<DocumentSets>(
      fetcher,
      `/organizations/${encodeURIComponent(organizationId)}/document-sets`,
      documentSetsSchema
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
