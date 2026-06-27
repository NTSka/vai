import type { paths } from "./generated/openapi";

type JsonContent<Response> = Response extends {
  content: { "application/json": infer Body };
}
  ? Body
  : never;

type Operation<Path extends keyof paths, Method extends keyof paths[Path]> = NonNullable<
  paths[Path][Method]
>;

type OperationResponses<Path extends keyof paths, Method extends keyof paths[Path]> =
  Operation<Path, Method> extends { responses: infer Responses } ? Responses : never;

type ResponseBody<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends keyof OperationResponses<Path, Method>
> = JsonContent<OperationResponses<Path, Method>[Status]>;

export type Session = ResponseBody<"/auth/session", "get", 200>;
export type User = Session["user"];
export type Organization = Session["organizations"][number];

export type UploadResponse = ResponseBody<"/document-sets/uploads", "post", 201>;

export type DocumentSetStatus = ResponseBody<
  "/organizations/{organizationId}/document-sets/{documentSetId}/status",
  "get",
  200
>;
export type Warning = DocumentSetStatus["warnings"][number];

export type ProcessingProgress = ResponseBody<
  "/organizations/{organizationId}/processing/progress",
  "get",
  200
>;

export type ProjectTree = ResponseBody<
  "/organizations/{organizationId}/project-structure/tree",
  "get",
  200
>;
export type ProjectTreeNode = ProjectTree["nodes"][number];
export type FallbackGroup = ProjectTree["fallbackGroups"][number];

export type NodeDocuments = ResponseBody<
  "/organizations/{organizationId}/project-structure/nodes/{nodeId}/documents",
  "get",
  200
>;
export type NodeDocument = NodeDocuments["documents"][number];

export type SourceDocumentMetadata = ResponseBody<
  "/organizations/{organizationId}/source-documents/{documentVersionId}",
  "get",
  200
>;
