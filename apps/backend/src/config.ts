import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .optional()
  .default("true")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  BACKEND_HOST: z.string().min(1).default("127.0.0.1"),
  BACKEND_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString,
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  CV_OCR_SERVICE_URL: z.string().min(1),
  CV_OCR_DEADLINE_MS: z.coerce.number().int().positive().default(300_000),
  CV_OCR_GRPC_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024)
});

export type BackendConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly objectStorage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly jwt: {
    readonly accessSecret: string;
    readonly refreshSecret: string;
  };
  readonly authCookieSecure: boolean;
  readonly cvOcrServiceUrl: string;
  readonly cvOcrDeadlineMs: number;
  readonly cvOcrGrpcMaxMessageBytes: number;
};

export function loadBackendConfig(
  env: NodeJS.ProcessEnv = process.env
): BackendConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid backend configuration: ${message}`);
  }

  const value = parsed.data;

  return {
    nodeEnv: value.NODE_ENV,
    host: value.BACKEND_HOST,
    port: value.BACKEND_PORT,
    databaseUrl: value.DATABASE_URL,
    objectStorage: {
      endpoint: value.S3_ENDPOINT,
      region: value.S3_REGION,
      bucket: value.S3_BUCKET,
      accessKeyId: value.S3_ACCESS_KEY_ID,
      secretAccessKey: value.S3_SECRET_ACCESS_KEY,
      forcePathStyle: value.S3_FORCE_PATH_STYLE
    },
    jwt: {
      accessSecret: value.JWT_ACCESS_SECRET,
      refreshSecret: value.JWT_REFRESH_SECRET
    },
    authCookieSecure:
      value.AUTH_COOKIE_SECURE === undefined
        ? value.NODE_ENV === "production"
        : value.AUTH_COOKIE_SECURE === "true",
    cvOcrServiceUrl: value.CV_OCR_SERVICE_URL,
    cvOcrDeadlineMs: value.CV_OCR_DEADLINE_MS,
    cvOcrGrpcMaxMessageBytes: value.CV_OCR_GRPC_MAX_MESSAGE_BYTES
  };
}
