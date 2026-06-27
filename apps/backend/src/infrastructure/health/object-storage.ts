import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export type ObjectStorageHealth =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ObjectStorageHealthConfig = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
};

export async function checkObjectStorageHealth(
  config: ObjectStorageHealthConfig
): Promise<ObjectStorageHealth> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "unknown object storage error"
    };
  } finally {
    client.destroy();
  }
}
