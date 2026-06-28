import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { BackendConfig } from "../../config.js";

export type ObjectStorageClient = {
  readonly headBucket: () => Promise<void>;
  readonly putObject: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Readable | Uint8Array;
    readonly contentType?: string;
    readonly contentLength: number;
  }) => Promise<void>;
  readonly deleteObject: (input: {
    readonly bucket: string;
    readonly key: string;
  }) => Promise<void>;
  readonly getObject: (input: {
    readonly bucket: string;
    readonly key: string;
  }) => Promise<Readable>;
  readonly listObjects: (input: {
    readonly bucket: string;
    readonly prefix: string;
  }) => Promise<ReadonlyArray<{ readonly key: string }>>;
  readonly destroy: () => void;
};

export function createObjectStorageClient(
  config: BackendConfig["objectStorage"]
): ObjectStorageClient {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  return {
    headBucket: async () => {
      await client.send(
        new HeadBucketCommand({ Bucket: config.bucket })
      );
    },
    putObject: async (input) => {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength
        })
      );
    },
    deleteObject: async (input) => {
      await client.send(
        new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key
        })
      );
    },
    getObject: async (input) => {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key
        })
      );
      if (!response.Body || !("pipe" in response.Body)) {
        throw new Error("Object storage response body is not a readable stream");
      }
      return response.Body as Readable;
    },
    listObjects: async (input) => {
      const objects: Array<{ readonly key: string }> = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: input.bucket,
            Prefix: input.prefix,
            ContinuationToken: continuationToken
          })
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) {
            objects.push({ key: object.Key });
          }
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return objects;
    },
    destroy: () => client.destroy()
  };
}

export async function registerObjectStoragePlugin(
  app: FastifyInstance
): Promise<void> {
  const objectStorage = createObjectStorageClient(app.config.objectStorage);

  app.decorate("objectStorage", objectStorage);

  app.addHook("onClose", async () => {
    objectStorage.destroy();
  });
}
