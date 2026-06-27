import path from "node:path";

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";

import { createCvOcrGrpcClient, resolveProtoPath } from "@vai/backend/cv-ocr-client";

describe("worker CV/OCR service integration", () => {
  it("can call a CV/OCR service test double through the backend client adapter", async () => {
    const server = new grpc.Server();
    const packageDefinition = protoLoader.loadSync(protoPath(), {
      defaults: true,
      keepCase: false,
      longs: Number
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as TestProtoRoot;
    server.addService(loaded.vai.cv_ocr.v1.CvOcrService.service, {
      ExtractPdfMetadata: (
        call: grpc.ServerUnaryCall<
          { readonly context: { readonly file: { readonly documentVersionId: string } } },
          unknown
        >,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "worker-test-adapter",
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
    const client = createCvOcrGrpcClient({
      address,
      protoPath: protoPath(),
      deadlineMs: 500
    });
    try {
      const result = await client.extractPdfMetadata({
        file: {
          documentVersionId: "worker-document-version-1" as never,
          storedFileId: "stored-file-1" as never,
          originalName: "example.pdf",
          mimeType: "application/pdf",
          sizeBytes: 12,
          checksum: "abc",
          checksumAlgorithm: "sha256"
        },
        content: new Uint8Array([1, 2, 3])
      });

      expect(result.adapter).toEqual({ id: "worker-test-adapter", version: "1.0.0" });
      expect(result.metadata.title).toBe("worker-document-version-1");
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
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
