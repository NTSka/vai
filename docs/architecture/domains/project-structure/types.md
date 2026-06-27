# Project Structure Domain Types

This document captures the navigation and grouping projection built from parsed
document identities.

Project structure is intentionally separate from document identity. Document
identity owns code normalization and parsing. Project structure owns stable
navigation nodes, document placement, and grouping documents from different
document sets under the same project branch.

A project-structure node represents a meaningful part of a project: the project
itself, an object, subobject, building, stage, mark, section, or document
grouping derived from the code parts. It is not the same thing as a `Document`
or `DocumentSet`. One node may have no documents yet, one document, or many
document versions attached to it.

## Principles

- Project structure is built from parsed `DocumentIdentity` records.
- Project structure does not parse document codes itself.
- A document set is not a project. A project appears as a project-structure node
  derived from `DocumentCodeParts.projectCode`.
- Parsed `own_code` identities place the source document version into the
  structure.
- Parsed `reference_code` identities may create relationships to project
  branches or other documents, but they do not place the source document by
  themselves.
- Nodes should be stable for a given organization, node kind, parent, and key so
  documents from different uploads can be grouped together.
- Any project-structure node may act as a bucket where one or more documents are
  shown. Some document types, such as estimates, may naturally attach to a
  higher-level project, object, subobject, or stage node instead of the deepest
  parsed branch.
- A node-to-document relationship is many-to-many over time: one node can contain
  multiple document versions, and one document version may later appear in more
  than one projection if explicit domain rules require it.
- Project structure is a projection/read model. Its source of truth is document
  identities plus placement rules.

## Why Separate Domain

Project structure should be modeled separately when it becomes more than a
temporary view over one document code. In this product it is separate because it
needs to:

- group documents from different document sets under the same branch;
- provide a stable navigation model for users;
- support document placement and unplaced-document states;
- represent project objects and subobjects independently from upload batches;
- act as an input for later capabilities such as completeness checks,
  comparison, reporting, and review workflows;
- evolve placement rules without changing document identity parsing.

If the product only needed to display parsed code parts for a single document,
this could stay inside document identity. Because the structure is shared,
persistent, navigable, and capability-facing, it deserves its own domain model.

## Identifiers

```ts
type ProjectStructureNodeID = string;
type ProjectStructurePlacementID = string;
type DocumentIdentityID = string;
type DocumentVersionID = string;
type DocumentID = string;
type OrganizationID = string;
type ProcessingJobID = string;
```

## ProjectStructureNode

`ProjectStructureNode` represents one node in the generated project navigation
tree. The node is a structural bucket, not a document record.

```ts
interface ProjectStructureNode {
  id: ProjectStructureNodeID;

  organizationId: OrganizationID;

  kind: ProjectStructureNodeKind;
  key: string;
  title: string;

  subject?: ProjectStructureNodeSubject;

  parentId?: ProjectStructureNodeID;

  sourceIdentityIds: DocumentIdentityID[];

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type ProjectStructureNodeKind =
  | "project"
  | "complex_kind"
  | "complex_part_kind"
  | "complex_part_number"
  | "building"
  | "stage"
  | "mark"
  | "document_group";
```

```ts
type ProjectStructureNodeSubject =
  | "project"
  | "object"
  | "subobject"
  | "discipline_or_mark"
  | "document_package"
  | "document_group";
```

`key` is the normalized segment value used for identity and grouping at this
level. `title` is the display value and may later include names resolved from
dictionaries or user corrections.

`subject` describes what the node represents in project terms. It is optional at
the initial stage because the exact subject may depend on the applicable
standard and organization-specific coding rules.

## ProjectStructurePlacement

`ProjectStructurePlacement` connects a document version to the project-structure
node where it should be shown. Multiple placements may point to the same node,
which is how a node represents a package or group of documents.

```ts
interface ProjectStructurePlacement {
  id: ProjectStructurePlacementID;

  organizationId: OrganizationID;
  documentId: DocumentID;
  documentVersionId: DocumentVersionID;

  placedByIdentityId: DocumentIdentityID;
  nodeId: ProjectStructureNodeID;

  status: ProjectStructurePlacementStatus;

  producedByJobId?: ProcessingJobID;

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type ProjectStructurePlacementStatus =
  | "placed"
  | "ambiguous"
  | "unplaced";
```

`placed` means the document version has a parsed own-code identity and a target
node. `ambiguous` means multiple possible placements were found. `unplaced`
means the system could not place the document version, usually because its own
code is missing, invalid, or unsupported.

## Document Grouping

Documents are attached to project structure through placements, not stored inside
nodes.

This preserves two separate concepts:

- the project node, such as a project, building, subobject, stage, mark, or
  document group;
- the documents currently known for that node, which may come from different
  document sets and processing runs.

For any node, the practical user-facing meaning may be "this node has a document
package" or "this node has related documents". The domain still models this as
one node with many placements instead of one node per upload, because uploads are
intake facts and should not define the project hierarchy.

## Placement Rules

Initial placement uses only parsed `own_code` identities.

The initial node path is derived from `DocumentCodeParts`:

```text
projectCode
  -> complexKind
  -> complexPartKind
  -> complexPartNumber
  -> buildingNumber
  -> stage
  -> mark
  -> document_group
```

Missing optional parts are skipped unless the applicable standard or
organization-specific rules require an explicit placeholder.

`projectCode` is required for a parsed identity and becomes the root
`project` node key.

The placement target is not always the deepest parsed node. It should be chosen
by the placement rules for the applicable standard and document type. For
example, a drawing may attach to a mark or document group, while an estimate may
attach to a project, object, subobject, or stage node.

## Relationship Inputs

Parsed `reference_code` identities may point to existing or future project
structure branches. They are useful for cross-document matching, comparison, and
review workflows.

They should not place the source document version into the tree unless a
separate domain rule explicitly promotes a reference to a placement.

## Out of Scope

- Parsing, validating, or normalizing document codes.
- Extracting code candidates from content.
- Document type detection.
- Business capability execution.
- User-facing tree sorting and filtering rules.
- Manual corrections to structure and placements.

## Open Questions

- Should project structure nodes be rebuilt from identities or updated
  incrementally as processing jobs complete?
- Which node should each document type attach to for each supported standard?
- Which code levels correspond to object/subobject/package semantics for each
  supported standard?
- Should reference-code relationships be modeled here or in a later document
  relationship domain?
- How should user-corrected identity parts affect existing nodes and placements?
