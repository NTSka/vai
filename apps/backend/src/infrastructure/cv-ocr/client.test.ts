import path from "node:path";

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";

import { CvOcrClientError, createCvOcrGrpcClient, resolveProtoPath } from "./client.js";

describe("CV/OCR gRPC client", () => {
  it("calls a local service using the shared proto contract", async () => {
    const server = new grpc.Server();
    const packageDefinition = protoLoader.loadSync(protoPath(), {
      defaults: true,
      keepCase: false,
      longs: Number
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as TestProtoRoot;
    server.addService(loaded.vai.cv_ocr.v1.CvOcrService.service, {
      CheckHealth: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, { status: "ok", service: "test-cv-ocr", version: "test" });
      },
      ExtractPdfMetadata: (
        call: grpc.ServerUnaryCall<
          { readonly context: { readonly file: { readonly documentVersionId: string } } },
          unknown
        >,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "test-adapter",
          adapterVersion: "1.0.0",
          metadata: {
            pageCount: 1,
            encrypted: false,
            title: call.request.context.file.documentVersionId,
            author: "",
            pages: [
              {
                pageNumber: 1,
                widthPoints: 200,
                heightPoints: 100,
                rotationDegrees: 0
              }
            ]
          },
          diagnostics: []
        });
      }
    });

    const address = await bindServer(server);
    const client = createCvOcrGrpcClient({ address, protoPath: protoPath() });
    try {
      const health = await client.checkHealth();
      const metadata = await client.extractPdfMetadata({
        file: {
          documentVersionId: "document-version-1" as never,
          storedFileId: "stored-file-1" as never,
          originalName: "example.pdf",
          mimeType: "application/pdf",
          sizeBytes: 12,
          checksum: "abc",
          checksumAlgorithm: "sha256"
        },
        content: new Uint8Array([1, 2, 3])
      });

      expect(health).toEqual({ status: "ok", service: "test-cv-ocr", version: "test" });
      expect(metadata.adapter).toEqual({ id: "test-adapter", version: "1.0.0" });
      expect(metadata.metadata.title).toBe("document-version-1");
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  });

  it("fails stuck service calls with a retryable deadline error", async () => {
    const server = new grpc.Server();
    const packageDefinition = protoLoader.loadSync(protoPath(), {
      defaults: true,
      keepCase: false,
      longs: Number
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as TestProtoRoot;
    server.addService(loaded.vai.cv_ocr.v1.CvOcrService.service, {
      ExtractPdfMetadata: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        setTimeout(() => {
          callback(null, {
            adapterId: "late-adapter",
            adapterVersion: "1.0.0",
            metadata: { pageCount: 0, encrypted: false, title: "", author: "", pages: [] },
            diagnostics: []
          });
        }, 100);
      }
    });

    const address = await bindServer(server);
    const client = createCvOcrGrpcClient({
      address,
      protoPath: protoPath(),
      deadlineMs: 10
    });
    try {
      await expect(
        client.extractPdfMetadata({
          file: {
            documentVersionId: "document-version-1" as never,
            storedFileId: "stored-file-1" as never,
            originalName: "example.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
            checksum: "abc",
            checksumAlgorithm: "sha256"
          },
          content: new Uint8Array([1, 2, 3])
        })
      ).rejects.toMatchObject({
        code: "cv_ocr_deadline_exceeded",
        retryable: true,
        grpcCode: grpc.status.DEADLINE_EXCEEDED
      } satisfies Partial<CvOcrClientError>);
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
});

function protoPath(): string {
  return resolveProtoPath(path.resolve(process.cwd()));
}

function bindServer(server: grpc.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`127.0.0.1:${port}`);
    });
  });
}

type TestProtoRoot = {
  readonly vai: {
    readonly cv_ocr: {
      readonly v1: {
        readonly CvOcrService: grpc.ServiceClientConstructor;
      };
    };
  };
};
