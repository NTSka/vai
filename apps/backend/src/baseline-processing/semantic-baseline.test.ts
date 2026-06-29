import { describe, expect, it } from "vitest";

import {
  buildEmbeddedStatementPayload,
  buildIdentityInputs,
  buildMissingOwnIdentityInput,
  buildTypedDataPayload,
  inferFamily,
  parseSupportedGostCode
} from "./semantic-baseline.js";

describe("semantic baseline", () => {
  it("classifies initial phase 12 document families from source names", () => {
    expect(inferFamily("PRJ-001-R-AR-drawing.pdf")).toBe("drawing");
    expect(inferFamily("local-estimate.xlsx")).toBe("estimate");
    expect(inferFamily("drawing-register.xlsx")).toBe("statement");
    expect(inferFamily("notes.txt")).toBe("unknown");
  });

  it("does not use drawing filename codes as placement identities", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "PRJ-001-R-AR-drawing.pdf",
      stem: "PRJ-001-R-AR-drawing",
      contentArtifacts: []
    });

    expect(typedData).toMatchObject({
      schema: { id: "drawing_document.gost_main_inscription_baseline" },
      ownCodeCandidate: undefined,
      referenceCodeCandidates: []
    });
    expect(buildIdentityInputs(typedData, "drawing-typed-record")).toEqual([]);
  });

  it("does not promote drawing filename-like content artifact hints to identity", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "drawing.pdf",
      stem: "drawing",
      contentArtifacts: [
        {
          id: "artifact-1",
          artifactType: "content_placeholder",
          payload: {
            originalName: "PRJ-009-R-AR-drawing.pdf",
            textHint: "PRJ-010-R-OV-REV2"
          }
        }
      ]
    });

    expect(typedData).toMatchObject({
      ownCodeCandidate: undefined,
      referenceCodeCandidates: []
    });
    expect(buildIdentityInputs(typedData, "drawing-content-record")).toEqual([]);
  });

  it("persists unsupported-standard identity outcomes instead of forcing placement parsing", () => {
    expect(parseSupportedGostCode("ISO-19650-R-AR")).toMatchObject({
      status: "unsupported",
      parts: {
        projectCode: "ISO",
        warnings: [expect.objectContaining({ code: "unsupported_standard" })]
      }
    });
  });

  it("emits embedded statement data for statement-like tables inside drawings", () => {
    const statement = buildEmbeddedStatementPayload({
      sourceTypedDataRecordId: "drawing-typed-record",
      originalName: "PRJ-020-R-AR-drawing.pdf",
      stem: "PRJ-020-R-AR-drawing",
      contentArtifacts: [
        {
          id: "table-artifact-1",
          artifactType: "table",
          payload: {
            title: "drawing register",
            rows: [{ value: "PRJ-021-R-KR" }, { value: "PRJ-022-R-OV" }]
          }
        }
      ]
    });

    expect(statement).toMatchObject({
      schema: { id: "statement.semantic_baseline" },
      embeddedInTypedDataRecordId: "drawing-typed-record",
      ownCodeCandidate: undefined,
      referenceCodeCandidates: ["PRJ-21-R-KR", "PRJ-22-R-OV"]
    });
    expect(buildIdentityInputs(statement ?? {}, "statement-typed-record")).toEqual([
      expect.objectContaining({
        role: "reference_code",
        normalizedValue: "PRJ-21-R-KR",
        sourceTypedDataRecordIds: ["statement-typed-record"],
        parsedParts: expect.objectContaining({
          sourceReferences: [
            expect.objectContaining({
              artifactId: "table-artifact-1",
              rowNumber: 1,
              field: "value"
            })
          ]
        })
      }),
      expect.objectContaining({
        role: "reference_code",
        normalizedValue: "PRJ-22-R-OV",
        sourceTypedDataRecordIds: ["statement-typed-record"]
      })
    ]);
  });

  it("does not derive project-documentation package context from filename", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "PRJ-P-SEC05-VOL2-project.pdf",
      stem: "PRJ-P-SEC05-VOL2-project",
      contentArtifacts: []
    });

    expect(typedData).toMatchObject({
      packageContext: undefined,
      ownCodeCandidate: undefined
    });
    expect(buildIdentityInputs(typedData, "pd-typed-record")).toEqual([]);
  });

  it("extracts estimate basis codes as reference placement inputs", () => {
    const typedData = buildTypedDataPayload({
      family: "estimate",
      originalName: "estimate.xlsx",
      stem: "estimate",
      contentArtifacts: [
        {
          id: "cells-artifact-1",
          artifactType: "xlsx_cells",
          payload: {
            cells: [{ value: "Basis" }, { value: "PRJ-002-R-KR" }, { value: "not a code" }]
          }
        }
      ]
    });

    expect(typedData).toMatchObject({
      schema: { id: "estimate.semantic_baseline" },
      ownCodeCandidate: undefined,
      referenceCodeCandidates: ["PRJ-2-R-KR"]
    });
    expect(buildIdentityInputs(typedData, "estimate-typed-record")).toEqual([
      expect.objectContaining({
        role: "reference_code",
        identityKey: "reference_code:parsed:PRJ-2-R-KR:0",
        normalizedValue: "PRJ-2-R-KR",
        parseStatus: "parsed",
        sourceTypedDataRecordIds: ["estimate-typed-record"],
        parsedParts: expect.objectContaining({
          sourceReferences: [
            expect.objectContaining({
              artifactId: "cells-artifact-1",
              artifactType: "xlsx_cells",
              kind: "content_artifact_cell",
              cellIndex: 1
            })
          ]
        })
      })
    ]);
  });

  it("does not use estimate filename codes as reference placement inputs", () => {
    const typedData = buildTypedDataPayload({
      family: "estimate",
      originalName: "PRJ-002-R-KR-estimate.xlsx",
      stem: "PRJ-002-R-KR-estimate",
      contentArtifacts: []
    });

    expect(typedData).toMatchObject({
      ownCodeCandidate: undefined,
      referenceCodeCandidates: []
    });
    expect(buildIdentityInputs(typedData, "estimate-filename-record")).toEqual([]);
  });

  it("preserves statement row designations as references without filename own identity", () => {
    const typedData = buildTypedDataPayload({
      family: "statement",
      originalName: "PRJ-003-R-AR-drawing-register.xlsx",
      stem: "PRJ-003-R-AR-drawing-register",
      contentArtifacts: [
        {
          id: "statement-cells-artifact",
          artifactType: "xlsx_cells",
          payload: {
            cells: [{ value: "PRJ-004-R-KR" }, { value: "PRJ-005-R-OV" }]
          }
        }
      ]
    });
    const identities = buildIdentityInputs(typedData, "statement-typed-record");

    expect(typedData).toMatchObject({
      schema: { id: "statement.semantic_baseline" },
      ownCodeCandidate: undefined,
      referenceCodeCandidates: ["PRJ-4-R-KR", "PRJ-5-R-OV"]
    });
    expect(identities.map((identity) => identity.role)).toEqual([
      "reference_code",
      "reference_code"
    ]);
    expect(identities[0]).toMatchObject({
      normalizedValue: "PRJ-4-R-KR",
      parsedParts: {
        sourceReferences: [
          expect.objectContaining({
            artifactId: "statement-cells-artifact",
            kind: "content_artifact_cell",
            cellIndex: 0
          })
        ]
      }
    });
  });

  it("represents missing and invalid identities as domain outcomes", () => {
    expect(buildMissingOwnIdentityInput("typed-record-id")).toMatchObject({
      role: "own_code",
      identityKey: "own_code:missing",
      parseStatus: "missing",
      sourceTypedDataRecordIds: ["typed-record-id"],
      parsedParts: {
        sourceTypedDataRecordIds: ["typed-record-id"]
      }
    });
    expect(parseSupportedGostCode("001-R-AR")).toMatchObject({
      status: "parsed",
      parts: {
        projectCode: "1",
        stage: "Р",
        mark: "AR"
      }
    });
  });

  it("normalizes leading zeros in numeric code segments", () => {
    const identities = buildIdentityInputs(
      {
        ownCodeCandidate: "0471-022-П-12/01-0003-КС-009-4512-016-03-КМ",
        referenceCodeCandidates: ["471-22-П-12/1-3-КС-9-4512-16-3-КМ"]
      },
      "zero-normalization-record"
    );

    expect(identities[0]).toMatchObject({
      identityKey: "own_code:parsed:471-22-П-12/1-3-КС-9-4512-16-3-КМ:0",
      normalizedValue: "471-22-П-12/1-3-КС-9-4512-16-3-КМ",
      parsedParts: {
        projectCode: "471",
        siteCode: "22",
        stage: "П",
        sectionNumber: "12/1",
        volumeNumber: "3",
        documentGroup: "КС",
        documentNumber: "9",
        subobjectCode: "16",
        partNumber: "3",
        mark: "КМ"
      }
    });
    expect(identities[1]).toMatchObject({
      identityKey: "reference_code:parsed:471-22-П-12/1-3-КС-9-4512-16-3-КМ:0",
      normalizedValue: "471-22-П-12/1-3-КС-9-4512-16-3-КМ"
    });
  });

  it("parses numeric project codes, Cyrillic stages, and organization-defined physical parts", () => {
    expect(
      parseSupportedGostCode("0471-022-П-12/1-0003-КС-009-4512-016-3-КМ")
    ).toMatchObject({
      status: "parsed",
      parts: {
        projectCode: "471",
        siteCode: "22",
        stage: "П",
        sectionNumber: "12/1",
        volumeNumber: "3",
        documentGroup: "КС",
        documentNumber: "9",
        workCode: "4512",
        subobjectCode: "16",
        partNumber: "3",
        mark: "КМ",
        segments: ["471", "22", "П", "12/1", "3", "КС", "9", "4512", "16", "3", "КМ"]
      }
    });
  });
});
