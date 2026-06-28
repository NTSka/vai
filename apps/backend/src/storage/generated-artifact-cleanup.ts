import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import * as schema from "../infrastructure/persistence/schema/index.js";
import type { Db } from "../infrastructure/persistence/repositories/common.js";

export type GeneratedArtifactCleanupResult = {
  readonly bucket: string;
  readonly scannedKeys: readonly string[];
  readonly referencedKeys: readonly string[];
  readonly deletedKeys: readonly string[];
  readonly dryRun: boolean;
};

export async function cleanupUnreferencedGeneratedArtifacts(input: {
  readonly db: Db;
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string;
  readonly execute?: boolean;
}): Promise<GeneratedArtifactCleanupResult> {
  const organizationIds = await input.db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .then((rows) => rows.map((row) => row.id));
  const referencedKeys = await collectReferencedObjectKeys(input.db, input.bucket);
  const scannedKeys = new Set<string>();
  const deletedKeys: string[] = [];

  for (const organizationId of organizationIds) {
    for (const prefix of generatedArtifactPrefixes(organizationId)) {
      const objects = await input.objectStorage.listObjects({
        bucket: input.bucket,
        prefix
      });
      for (const object of objects) {
        scannedKeys.add(object.key);
        if (referencedKeys.has(object.key)) {
          continue;
        }
        if (input.execute === true) {
          await input.objectStorage.deleteObject({
            bucket: input.bucket,
            key: object.key
          });
        }
        deletedKeys.push(object.key);
      }
    }
  }

  return {
    bucket: input.bucket,
    scannedKeys: [...scannedKeys].sort(),
    referencedKeys: [...referencedKeys].sort(),
    deletedKeys: deletedKeys.sort(),
    dryRun: input.execute !== true
  };
}

async function collectReferencedObjectKeys(db: Db, bucket: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const storedFiles = await db
    .select({ storage: schema.storedFiles.storage })
    .from(schema.storedFiles);
  for (const storedFile of storedFiles) {
    if (storedFile.storage.bucket === bucket) {
      keys.add(storedFile.storage.key);
    }
  }

  const artifacts = await db
    .select({ payload: schema.contentArtifacts.payload })
    .from(schema.contentArtifacts);
  for (const artifact of artifacts) {
    for (const ref of findPayloadRefs(artifact.payload)) {
      if (ref.bucket === bucket) {
        keys.add(ref.key);
      }
    }
  }

  return keys;
}

function generatedArtifactPrefixes(organizationId: string): string[] {
  return [
    `organizations/${organizationId}/generated-artifacts/`,
    `organizations/${organizationId}/content-artifacts/`
  ];
}

function findPayloadRefs(value: unknown): Array<{ readonly bucket: string; readonly key: string }> {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      return value.flatMap(findPayloadRefs);
    }
    return [];
  }

  const refs: Array<{ readonly bucket: string; readonly key: string }> = [];
  const payloadRef = value["payloadRef"];
  if (isRecord(payloadRef)) {
    const bucket = readString(payloadRef["bucket"]);
    const key = readString(payloadRef["key"]);
    if (bucket && key) {
      refs.push({ bucket, key });
    }
  }

  for (const child of Object.values(value)) {
    refs.push(...findPayloadRefs(child));
  }

  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
