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
      },
      DetectPdfLayout: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "test-content-adapter",
          adapterVersion: "1.0.0",
          regions: [
            {
              localId: "region-1",
              regionKind: "text_block",
              location: {
                bbox: {
                  pageNumber: 1,
                  x: 10,
                  y: 20,
                  width: 30,
                  height: 40,
                  coordinateSystem: "page_points"
                }
              },
              confidence: 0.8,
              source: "fixture"
            }
          ],
          diagnostics: []
        });
      },
      PlanPdfOcrCandidates: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "test-content-adapter",
          adapterVersion: "1.0.0",
          candidates: [
            {
              localId: "candidate-1",
              targetKind: "text_region",
              sourceRegionId: "region-1",
              location: {
                bbox: {
                  pageNumber: 1,
                  x: 10,
                  y: 20,
                  width: 30,
                  height: 40,
                  coordinateSystem: "page_points"
                }
              },
              expectedValueKind: "text"
            }
          ],
          diagnostics: []
        });
      },
      RunPdfTargetedOcr: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "test-content-adapter",
          adapterVersion: "1.0.0",
          texts: [
            {
              localId: "ocr-text-1",
              sourceCandidateId: "candidate-1",
              text: "fixture text",
              confidence: 1,
              engine: "pdf-text-layer",
              engineVersion: "1.0.0"
            }
          ],
          diagnostics: []
        });
      },
      ReconstructPdfTables: (
        _call: grpc.ServerUnaryCall<unknown, unknown>,
        callback: (error: grpc.ServiceError | null, response: unknown) => void
      ) => {
        callback(null, {
          adapterId: "test-content-adapter",
          adapterVersion: "1.0.0",
          tables: [
            {
              localId: "table-1",
              sourceRegionId: "region-1",
              sourceRegionIds: ["region-1", "region-2"],
              coveragePolicy: "cv_grid_cells_with_ocr_evidence",
              qualityFlags: ["ok"],
              missingOcrCandidateCount: 0,
              missingOcrTextCount: 1,
              lowConfidenceOcrCount: 2,
              emptyOcrTextCount: 3,
              metadataJson: "{\"legacy\":true}",
              rows: [
                {
                  cells: [
                    {
                      rowIndex: 0,
                      columnIndex: 0,
                      text: "fixture text",
                      rawText: "raw fixture text",
                      location: {
                        bbox: {
                          pageNumber: 1,
                          x: 10,
                          y: 20,
                          width: 30,
                          height: 40,
                          coordinateSystem: "page_points"
                        }
                      },
                      confidence: 1,
                      rowSpan: 2,
                      columnSpan: 3,
                      sourceCandidateIds: ["candidate-1"],
                      selectedCandidateId: "candidate-1",
                      ocrQualityStatus: "recognized",
                      qualityFlags: ["ok"],
                      metadataJson: "{\"cell\":true}"
                    }
                  ]
                }
              ]
            }
          ],
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
      const layout = await client.detectPdfLayout({
        renderedPages: [
          {
            pageNumber: 1,
            widthPx: 200,
            heightPx: 100,
            dpi: 144,
            imageFormat: "png",
            sha256: "sha",
            sizeBytes: 12,
            content: new Uint8Array([1, 2, 3])
          }
        ],
        textPages: []
      });
      const candidates = await client.planPdfOcrCandidates({
        regions: layout.regions,
        renderedPages: []
      });
      const ocr = await client.runPdfTargetedOcr({
        renderedPages: [
          {
            pageNumber: 1,
            widthPx: 200,
            heightPx: 100,
            dpi: 144,
            imageFormat: "png",
            sha256: "sha",
            sizeBytes: 12,
            content: new Uint8Array([1, 2, 3])
          }
        ],
        candidates: candidates.candidates,
        textPages: [],
        tesseractBinary: "fixture-tesseract"
      });
      const tables = await client.reconstructPdfTables({
        regions: layout.regions,
        ocrTexts: ocr.texts,
        candidates: candidates.candidates,
        renderedPages: []
      });

      expect(health).toEqual({ status: "ok", service: "test-cv-ocr", version: "test" });
      expect(metadata.adapter).toEqual({ id: "test-adapter", version: "1.0.0" });
      expect(metadata.metadata.title).toBe("document-version-1");
      expect(layout.regions[0]).toMatchObject({ regionKind: "text_block" });
      expect(candidates.candidates[0]).toMatchObject({ targetKind: "text_region" });
      expect(ocr.texts[0]).toMatchObject({ engine: "pdf-text-layer" });
      expect(tables.tables[0]?.rows[0]?.[0]).toMatchObject({
        rowIndex: 0,
        columnIndex: 0,
        text: "fixture text",
        rowSpan: 2,
        columnSpan: 3,
        rawText: "raw fixture text",
        sourceCandidateIds: ["candidate-1"],
        selectedCandidateId: "candidate-1",
        ocrQualityStatus: "recognized",
        qualityFlags: ["ok"]
      });
      expect(tables.tables[0]).toMatchObject({
        sourceRegionIds: ["region-1", "region-2"],
        coveragePolicy: "cv_grid_cells_with_ocr_evidence",
        missingOcrTextCount: 1,
        lowConfidenceOcrCount: 2,
        emptyOcrTextCount: 3,
        qualityFlags: ["ok"]
      });
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
