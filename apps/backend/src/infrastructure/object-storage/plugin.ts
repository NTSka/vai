import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";

export type ObjectStorageClient = {
  readonly headBucket: () => Promise<void>;
  readonly destroy: () => void;
};

export async function registerObjectStoragePlugin(
  app: FastifyInstance
): Promise<void> {
  const client = new S3Client({
    endpoint: app.config.objectStorage.endpoint,
    region: app.config.objectStorage.region,
    forcePathStyle: app.config.objectStorage.forcePathStyle,
    credentials: {
      accessKeyId: app.config.objectStorage.accessKeyId,
      secretAccessKey: app.config.objectStorage.secretAccessKey
    }
  });

  app.decorate("objectStorage", {
    headBucket: async () => {
      await client.send(
        new HeadBucketCommand({ Bucket: app.config.objectStorage.bucket })
      );
    },
    destroy: () => client.destroy()
  });

  app.addHook("onClose", async () => {
    client.destroy();
  });
}
