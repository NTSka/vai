export * from "./access-control.js";
export * from "./baseline-processing.js";
export * from "./document-intake.js";
export * from "./document-registry.js";
export * from "./eventing.js";
export * from "./identity.js";
export * from "./organization-member-roles.js";
export * from "./organizations.js";
export * from "./processing-orchestration.js";
export * from "./project-structure.js";

import { roles } from "./access-control.js";
import { baselineProcessingResults } from "./baseline-processing.js";
import { documentSets, storedFileProvenance, storedFiles } from "./document-intake.js";
import { documentVersions, documents } from "./document-registry.js";
import { domainEvents, eventConsumerCheckpoints } from "./eventing.js";
import { userCredentials, users } from "./identity.js";
import { organizationMemberRoles } from "./organization-member-roles.js";
import { organizationMembers, organizations } from "./organizations.js";
import { processingJobDependencies, processingJobs } from "./processing-orchestration.js";
import { projectStructureNodes, projectStructurePlacements } from "./project-structure.js";

export const schema = {
  users,
  userCredentials,
  organizations,
  organizationMembers,
  organizationMemberRoles,
  roles,
  storedFiles,
  documentSets,
  storedFileProvenance,
  documents,
  documentVersions,
  processingJobs,
  processingJobDependencies,
  domainEvents,
  eventConsumerCheckpoints,
  baselineProcessingResults,
  projectStructureNodes,
  projectStructurePlacements
};
