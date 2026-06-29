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

  it("extracts drawing own-code typed data and parses GOST placement parts", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "PRJ-001-R-AR-drawing.pdf",
      stem: "PRJ-001-R-AR-drawing",
      contentArtifacts: []
    });
    const identities = buildIdentityInputs(typedData, "drawing-typed-record");

    expect(typedData).toMatchObject({
      schema: { id: "drawing_document.gost_main_inscription_baseline" },
      ownCodeCandidate: "PRJ-001-R-AR"
    });
    expect(identities).toEqual([
      expect.objectContaining({
        role: "own_code",
        identityKey: "own_code:parsed:PRJ-001-R-AR:0",
        normalizedValue: "PRJ-001-R-AR",
        parseStatus: "parsed",
        sourceTypedDataRecordIds: ["drawing-typed-record"],
        parsedParts: expect.objectContaining({
          projectCode: "PRJ",
          stage: "Р",
          mark: "AR"
        })
      })
    ]);
  });

  it("does not promote drawing content artifact references to own identity", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "drawing.pdf",
      stem: "drawing",
      contentArtifacts: [
        {
          id: "artifact-1",
          artifactType: "content_placeholder",
          payload: { textHint: "PRJ-010-R-OV-REV2" }
        }
      ]
    });
    const identities = buildIdentityInputs(typedData, "drawing-content-record");

    expect(typedData).toMatchObject({
      ownCodeCandidate: undefined,
      referenceCodeCandidates: []
    });
    expect(identities).toEqual([]);
  });

  it("marks parsed own-code parts ambiguous when mark is present without documentation stage", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "PRJ-001-AR-drawing.pdf",
      stem: "PRJ-001-AR-drawing",
      contentArtifacts: []
    });
    const identities = buildIdentityInputs(typedData, "ambiguous-typed-record");

    expect(identities[0]).toMatchObject({
      role: "own_code",
      parseStatus: "parsed",
      parsedParts: {
        projectCode: "PRJ",
        mark: "AR",
        placementAmbiguityCode: "mark_without_documentation_stage",
        warnings: [expect.objectContaining({ code: "mark_without_documentation_stage" })]
      }
    });
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
      referenceCodeCandidates: ["PRJ-021-R-KR", "PRJ-022-R-OV"],
      referenceCodeSources: [
        expect.objectContaining({
          artifactId: "table-artifact-1",
          artifactType: "table",
          embeddedInTypedDataRecordId: "drawing-typed-record",
          rowNumber: 1,
          field: "value"
        }),
        expect.objectContaining({
          artifactId: "table-artifact-1",
          artifactType: "table",
          embeddedInTypedDataRecordId: "drawing-typed-record",
          rowNumber: 2,
          field: "value"
        })
      ]
    });
    expect(buildIdentityInputs(statement ?? {}, "statement-typed-record")).toEqual([
      expect.objectContaining({
        role: "reference_code",
        normalizedValue: "PRJ-021-R-KR",
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
        normalizedValue: "PRJ-022-R-OV",
        sourceTypedDataRecordIds: ["statement-typed-record"]
      })
    ]);
  });

  it("extracts project-documentation package context separately from document family", () => {
    const typedData = buildTypedDataPayload({
      family: "drawing",
      originalName: "PRJ-P-SEC05-VOL2-project.pdf",
      stem: "PRJ-P-SEC05-VOL2-project",
      contentArtifacts: []
    });
    const identities = buildIdentityInputs(typedData, "pd-typed-record");

    expect(typedData).toMatchObject({
      packageContext: {
        stage: expect.objectContaining({ value: "П" }),
        sectionNumber: expect.objectContaining({ value: "05" }),
        volumeNumber: expect.objectContaining({ value: "2" })
      },
      ownCodeCandidate: "PRJ-P-SEC05-VOL2"
    });
    expect(identities[0]).toMatchObject({
      role: "own_code",
      parsedParts: {
        projectCode: "PRJ",
        stage: "П",
        sectionNumber: "05",
        volumeNumber: "2"
      }
    });
    expect(identities[0]?.parsedParts["mark"]).toBeUndefined();
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
            cells: [
              { value: "Basis" },
              { value: "PRJ-002-R-KR" },
              { value: "not a code" }
            ]
          }
        }
      ]
    });
    const identities = buildIdentityInputs(typedData, "estimate-typed-record");

    expect(typedData).toMatchObject({
      schema: { id: "estimate.semantic_baseline" },
      ownCodeCandidate: undefined,
      referenceCodeCandidates: ["PRJ-002-R-KR"]
    });
    expect(identities).toEqual([
      expect.objectContaining({
        role: "reference_code",
        identityKey: "reference_code:parsed:PRJ-002-R-KR:0",
        normalizedValue: "PRJ-002-R-KR",
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

  it("preserves statement row designations as references and only uses explicit own designation", () => {
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
      ownCodeCandidate: "PRJ-003-R-AR",
      referenceCodeCandidates: ["PRJ-004-R-KR", "PRJ-005-R-OV"]
    });
    expect(identities.map((identity) => identity.role)).toEqual([
      "own_code",
      "reference_code",
      "reference_code"
    ]);
    expect(identities[1]).toMatchObject({
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

  it("does not promote standalone statement rows to own identity without filename designation", () => {
    const typedData = buildTypedDataPayload({
      family: "statement",
      originalName: "statement.xlsx",
      stem: "statement",
      contentArtifacts: [
        {
          id: "statement-row-artifact",
          artifactType: "xlsx_cells",
          payload: {
            cells: [{ value: "PRJ-004-R-KR" }, { value: "PRJ-005-R-OV" }]
          }
        }
      ]
    });
    const identities = buildIdentityInputs(typedData, "statement-typed-record");

    expect(typedData).toMatchObject({
      ownCodeCandidate: undefined,
      referenceCodeCandidates: ["PRJ-004-R-KR", "PRJ-005-R-OV"]
    });
    expect(identities.map((identity) => identity.role)).toEqual([
      "reference_code",
      "reference_code"
    ]);
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
        projectCode: "001",
        stage: "Р",
        mark: "AR"
      }
    });
  });

  it("parses numeric project codes, Cyrillic stages, and organization-defined physical parts", () => {
    expect(
      parseSupportedGostCode("0471-022-П-12/1-0003-КС-009-4512-016-3-КМ")
    ).toMatchObject({
      status: "parsed",
      parts: {
        projectCode: "0471",
        siteCode: "022",
        stage: "П",
        sectionNumber: "12/1",
        volumeNumber: "0003",
        documentGroup: "КС",
        documentNumber: "009",
        workCode: "4512",
        subobjectCode: "016",
        partNumber: "3",
        mark: "КМ",
        segments: ["0471", "022", "П", "12/1", "0003", "КС", "009", "4512", "016", "3", "КМ"]
      }
    });
  });
});
