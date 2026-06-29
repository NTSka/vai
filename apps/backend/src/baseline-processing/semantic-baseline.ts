export type BaselineDocumentFamily =
  | "estimate"
  | "drawing"
  | "statement"
  | "unsupported"
  | "unknown";

export type DocumentIdentityParseStatus =
  | "parsed"
  | "invalid"
  | "missing"
  | "unsupported";

export type ContentArtifactLike = {
  readonly id?: string;
  readonly artifactType: string;
  readonly payload: Record<string, unknown>;
};

export type IdentityInput = {
  readonly role: "own_code" | "reference_code";
  readonly identityKey: string;
  readonly normalizedValue?: string;
  readonly parseStatus: DocumentIdentityParseStatus;
  readonly parsedParts: Record<string, unknown>;
  readonly sourceTypedDataRecordIds: readonly string[];
};

const gostSemanticParserVersion = "gost-semantic-baseline-1.0.0";
const gostStandard = { id: "gost-r-21.101", version: "2020-2026-baseline" };

type SourceReference = Record<string, unknown>;

type ExtractedCodeCandidate = {
  readonly value: string;
  readonly source: SourceReference;
};

export function inferFamily(originalName: string): BaselineDocumentFamily {
  const lower = originalName.toLowerCase();
  if (
    lower.includes("statement") ||
    lower.includes("register") ||
    lower.includes("vedomost") ||
    lower.includes("volume-list")
  ) {
    return "statement";
  }
  if (lower.includes("estimate") || lower.includes("smeta")) {
    return "estimate";
  }
  if (lower.includes("drawing") || lower.endsWith(".pdf")) return "drawing";
  return "unknown";
}

export function buildTypedDataPayload(input: {
  readonly family: BaselineDocumentFamily;
  readonly originalName: string;
  readonly stem: string;
  readonly contentArtifacts: readonly ContentArtifactLike[];
}): Record<string, unknown> {
  const filenameSource = { kind: "filename", value: input.originalName };
  const stage = inferDocumentationStage(input.stem);
  const filenameCode = extractCodeCandidate(input.stem);
  const filenameCodeCandidate = filenameCode
    ? { value: filenameCode, source: filenameSource }
    : undefined;
  const artifactCodeCandidates = extractCodesFromContentArtifacts(input.contentArtifacts);
  const artifactCodes = artifactCodeCandidates.map((candidate) => candidate.value);
  const estimateReferenceCandidates = uniqueCodeCandidates([
    ...(filenameCodeCandidate ? [filenameCodeCandidate] : []),
    ...artifactCodeCandidates
  ]);

  if (input.family === "estimate") {
    return {
      schema: { id: "estimate.semantic_baseline", version: "1.0.0" },
      standard: { id: "minstroy-421pr-2020" },
      parserVersion: gostSemanticParserVersion,
      form: inferEstimateForm(input.stem),
      source: "semantic_baseline",
      header: {
        estimateName: typedField(input.stem, [filenameSource]),
        basisText: artifactCodeCandidates[0]
          ? typedField(artifactCodeCandidates[0].value, [artifactCodeCandidates[0].source])
          : undefined
      },
      referenceCodeCandidates: estimateReferenceCandidates.map((candidate) => candidate.value),
      referenceCodeSources: estimateReferenceCandidates.map((candidate) => candidate.source),
      ownCodeCandidate: undefined,
      warnings: [
        {
          code: "estimate_basis_reference_used_for_placement",
          message: "Estimate basis/reference codes may be used as placement inputs for estimates.",
          severity: "info"
        }
      ]
    };
  }

  if (input.family === "statement") {
    return {
      schema: { id: "statement.semantic_baseline", version: "1.0.0" },
      standard: { id: "gost-21.111-84" },
      parserVersion: gostSemanticParserVersion,
      form: inferStatementForm(input.stem),
      source: "semantic_baseline",
      title: typedField(input.stem, [filenameSource]),
      ownCodeCandidate: filenameCodeCandidate?.value,
      ownCodeSource: filenameCodeCandidate?.source,
      rows: artifactCodeCandidates.map((candidate, index) => ({
        rowNumber: index + 1,
        referencedDesignation: typedField(candidate.value, [candidate.source])
      })),
      referenceCodeCandidates: artifactCodes,
      referenceCodeSources: artifactCodeCandidates.map((candidate) => candidate.source),
      warnings: []
    };
  }

  if (input.family === "drawing") {
    return {
      schema: { id: "drawing_document.gost_main_inscription_baseline", version: "1.0.0" },
      standard: gostStandard,
      parserVersion: gostSemanticParserVersion,
      form: "rd_drawing_sheet",
      source: "semantic_baseline",
      mainInscription: {
        documentDesignation: filenameCodeCandidate
          ? typedField(filenameCodeCandidate.value, [filenameCodeCandidate.source])
          : undefined,
        documentationStage: stage ? typedField(stage, [filenameSource]) : undefined,
        mark: typedField(parseCodeParts(filenameCodeCandidate?.value ?? "").mark, [
          filenameSource
        ])
      },
      packageContext: buildPackageContext(filenameCodeCandidate?.value, filenameSource),
      ownCodeCandidate: filenameCodeCandidate?.value,
      ownCodeSource: filenameCodeCandidate?.source,
      referenceCodeCandidates: [],
      warnings: filenameCodeCandidate
        ? []
        : [
            {
              code: "drawing_designation_missing",
              message: "Drawing designation was not found in available baseline sources.",
              severity: "warning"
            }
          ]
    };
  }

  return {
    schema: { id: "typed_data.not_available", version: "1.0.0" },
    parserVersion: gostSemanticParserVersion,
    source: "semantic_baseline",
    ownCodeCandidate: undefined,
    referenceCodeCandidates: [],
    warnings: [
      {
        code: "document_family_unknown",
        message: "Document family is unknown; typed data extraction produced no semantic fields.",
        severity: "warning"
      }
    ]
  };
}

export function buildEmbeddedStatementPayload(input: {
  readonly sourceTypedDataRecordId: string;
  readonly originalName: string;
  readonly stem: string;
  readonly contentArtifacts: readonly ContentArtifactLike[];
}): Record<string, unknown> | undefined {
  const artifactCodeCandidates = extractCodesFromContentArtifacts(input.contentArtifacts);
  if (artifactCodeCandidates.length === 0 || !hasStatementLikeArtifact(input.contentArtifacts)) {
    return undefined;
  }

  const source = { kind: "embedded_statement", typedDataRecordId: input.sourceTypedDataRecordId };
  return {
    schema: { id: "statement.semantic_baseline", version: "1.0.0" },
    standard: { id: "gost-21.111-84" },
    parserVersion: gostSemanticParserVersion,
    form: inferStatementForm(input.stem),
    source: "semantic_baseline",
    embeddedInTypedDataRecordId: input.sourceTypedDataRecordId,
    title: typedField(input.stem, [source]),
    ownCodeCandidate: undefined,
    rows: artifactCodeCandidates.map((candidate, index) => ({
      rowNumber: index + 1,
      referencedDesignation: typedField(candidate.value, [source, candidate.source])
    })),
    referenceCodeCandidates: artifactCodeCandidates.map((candidate) => candidate.value),
    referenceCodeSources: artifactCodeCandidates.map((candidate) => ({
      ...candidate.source,
      embeddedInTypedDataRecordId: input.sourceTypedDataRecordId
    })),
    warnings: [
      {
        code: "embedded_statement_does_not_change_document_family",
        message: "Embedded statement/register rows are relationship inputs and do not change the source document family.",
        severity: "info"
      }
    ]
  };
}

export function buildIdentityInputs(
  data: Record<string, unknown>,
  sourceTypedDataRecordId: string
): IdentityInput[] {
  const identities: IdentityInput[] = [];
  const ownCode = normalizeCodeValue(data["ownCodeCandidate"]);
  if (ownCode) {
    const parsed = parseSupportedGostCode(ownCode);
    const ownCodeSource = readRecord(data["ownCodeSource"]);
    identities.push({
      role: "own_code",
      identityKey: identityKey("own_code", ownCode, parsed.status),
      normalizedValue: ownCode,
      parseStatus: parsed.status,
      parsedParts: {
        ...parsed.parts,
        sourceReferences: ownCodeSource ? [ownCodeSource] : [],
        sourceTypedDataRecordIds: [sourceTypedDataRecordId]
      },
      sourceTypedDataRecordIds: [sourceTypedDataRecordId]
    });
  }

  const referenceSources = readRecordArray(data["referenceCodeSources"]);
  for (const [index, referenceCode] of readStringArray(data["referenceCodeCandidates"]).entries()) {
    const normalizedReference = normalizeCodeValue(referenceCode);
    if (!normalizedReference) continue;
    const parsed = parseSupportedGostCode(normalizedReference);
    const referenceSource = referenceSources[index];
    identities.push({
      role: "reference_code",
      identityKey: identityKey("reference_code", normalizedReference, parsed.status, index),
      normalizedValue: normalizedReference,
      parseStatus: parsed.status,
      parsedParts: {
        ...parsed.parts,
        sourceReferences: referenceSource ? [referenceSource] : [],
        sourceTypedDataRecordIds: [sourceTypedDataRecordId]
      },
      sourceTypedDataRecordIds: [sourceTypedDataRecordId]
    });
  }

  return identities;
}

export function buildMissingOwnIdentityInput(sourceTypedDataRecordId: string): IdentityInput {
  return {
    role: "own_code",
    identityKey: "own_code:missing",
    parseStatus: "missing",
    sourceTypedDataRecordIds: [sourceTypedDataRecordId],
    parsedParts: {
      sourceTypedDataRecordIds: [sourceTypedDataRecordId],
      warnings: [
        {
          code: "own_code_missing",
          message: "No own-code source field was available for placement.",
          severity: "warning"
        }
      ]
    }
  };
}

export function parseSupportedGostCode(value: string): {
  readonly status: DocumentIdentityParseStatus;
  readonly parts: Record<string, unknown>;
} {
  const parts = parseCodeParts(value);
  if (!parts.projectCode || !/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9]*$/u.test(String(parts.projectCode))) {
    return {
      status: "invalid",
      parts: {
        ...parts,
        warnings: [
          {
            code: "project_code_invalid",
            message: "Parsed document code does not contain a supported project code.",
            severity: "warning"
          }
        ]
      }
    };
  }
  if (isUnsupportedStandardCode(parts)) {
    return {
      status: "unsupported",
      parts: {
        ...parts,
        warnings: [
          {
            code: "unsupported_standard",
            message: "Document code appears to use a standard unsupported by the Phase 12 baseline parser.",
            severity: "warning"
          }
        ]
      }
    };
  }
  return { status: "parsed", parts };
}

export function parseCodeParts(value: string): Record<string, unknown> {
  if (!value) return {};
  const segments = splitCodeSegments(value);
  const stageIndex = segments.findIndex((segment) => isDocumentationStage(segment));
  const stage =
    stageIndex >= 0 ? normalizeDocumentationStage(segments[stageIndex]) : undefined;
  const afterStage = stageIndex >= 0 ? segments.slice(stageIndex + 1) : [];
  const hasPhysicalHierarchy = isPhysicalHierarchyCode(segments, stageIndex);
  const mark = inferMarkSegment(segments, stageIndex);
  const sectionNumber = readPrefixedSegment(segments, "SEC");
  const subsectionTitle = readPrefixedSegment(segments, "SUBSEC");
  const volumeNumber = readPrefixedSegment(segments, "VOL");
  const revision = readPrefixedSegment(segments, "REV");
  const placementAmbiguityCode =
    mark && !stage ? "mark_without_documentation_stage" : undefined;

  return {
    raw: value,
    projectCode: segments[0],
    siteCode: hasPhysicalHierarchy ? segments[1] : undefined,
    stage,
    mark,
    sectionNumber: sectionNumber ?? inferSectionSegment(afterStage),
    subsectionTitle,
    volumeNumber: volumeNumber ?? inferVolumeSegment(afterStage),
    revision,
    documentGroup: inferDocumentGroupSegment(afterStage, mark),
    documentNumber: inferDocumentNumberSegment(afterStage),
    workCode: hasPhysicalHierarchy ? inferWorkCodeSegment(afterStage) : undefined,
    subobjectCode: hasPhysicalHierarchy ? inferSubobjectCodeSegment(afterStage) : undefined,
    partNumber: hasPhysicalHierarchy ? inferPartNumberSegment(afterStage) : undefined,
    placementAmbiguityCode,
    warnings: placementAmbiguityCode
      ? [
          {
            code: placementAmbiguityCode,
            message: "A mark was parsed without a documentation stage; placement target is ambiguous.",
            severity: "warning"
          }
        ]
      : undefined,
    segments
  };
}

function extractCodeCandidate(value: string): string | undefined {
  const normalized = normalizeCodeValue(value);
  if (!normalized || !/[0-9]/.test(normalized) || !normalized.includes("-")) {
    return undefined;
  }
  const semanticStopWords = new Set([
    "DRAWING",
    "ESTIMATE",
    "SMETA",
    "STATEMENT",
    "REGISTER",
    "VEDOMOST",
    "PROJECT",
    "PD",
    "RD",
    "PDF",
    "XLSX"
  ]);
  const segments = normalized.split("-").filter((segment) => !semanticStopWords.has(segment));
  return segments.length > 0 ? segments.join("-") : undefined;
}

function normalizeCodeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[_.\s]+/g, "-").replace(/-+/g, "-").toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function inferDocumentationStage(value: string): "П" | "Р" | "И" | "ИИ" | undefined {
  const segments = normalizeCodeValue(value)?.split("-") ?? [];
  const explicit = segments.find((segment) => isDocumentationStage(segment));
  if (explicit) return normalizeDocumentationStage(explicit);
  const lower = value.toLowerCase();
  if (lower.includes("rd") || lower.includes("working")) return "Р";
  if (lower.includes("pd") || lower.includes("project")) return "П";
  return undefined;
}

function normalizeDocumentationStage(value: string | undefined): "П" | "Р" | "И" | "ИИ" | undefined {
  if (value === "P" || value === "П") return "П";
  if (value === "R" || value === "Р") return "Р";
  if (value === "I" || value === "И") return "И";
  if (value === "ИИ") return "ИИ";
  return undefined;
}

function isDocumentationStage(value: string | undefined): boolean {
  return normalizeDocumentationStage(value) !== undefined;
}

function splitCodeSegments(value: string): string[] {
  return value
    .trim()
    .toUpperCase()
    .split(/[-.\s]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function inferMarkSegment(
  segments: readonly string[],
  stageIndex: number
): string | undefined {
  const candidates = stageIndex >= 0 ? segments.slice(stageIndex + 1) : segments.slice(1);
  return [...candidates]
    .reverse()
    .find((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment) && !isDocumentationStage(segment));
}

function isPhysicalHierarchyCode(segments: readonly string[], stageIndex: number): boolean {
  return (
    stageIndex >= 2 &&
    typeof segments[0] === "string" &&
    typeof segments[1] === "string" &&
    /^\d+$/.test(segments[0]) &&
    /^\d+$/.test(segments[1])
  );
}

function inferSectionSegment(segmentsAfterStage: readonly string[]): string | undefined {
  return segmentsAfterStage.find((segment) => /^\d+(?:\/\d+)?$/.test(segment));
}

function inferVolumeSegment(segmentsAfterStage: readonly string[]): string | undefined {
  return segmentsAfterStage.find((segment) => /^\d{4}$/.test(segment));
}

function inferDocumentGroupSegment(
  segmentsAfterStage: readonly string[],
  mark: string | undefined
): string | undefined {
  return segmentsAfterStage.find(
    (segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment) && segment !== mark
  );
}

function inferDocumentNumberSegment(segmentsAfterStage: readonly string[]): string | undefined {
  const groupIndex = segmentsAfterStage.findIndex((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment));
  return groupIndex >= 0 ? segmentsAfterStage[groupIndex + 1] : undefined;
}

function inferWorkCodeSegment(segmentsAfterStage: readonly string[]): string | undefined {
  const groupIndex = segmentsAfterStage.findIndex((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment));
  return groupIndex >= 0 ? segmentsAfterStage[groupIndex + 2] : undefined;
}

function inferSubobjectCodeSegment(segmentsAfterStage: readonly string[]): string | undefined {
  const groupIndex = segmentsAfterStage.findIndex((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment));
  return groupIndex >= 0 ? segmentsAfterStage[groupIndex + 3] : undefined;
}

function inferPartNumberSegment(segmentsAfterStage: readonly string[]): string | undefined {
  const groupIndex = segmentsAfterStage.findIndex((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment));
  return groupIndex >= 0 ? segmentsAfterStage[groupIndex + 4] : undefined;
}

function readPrefixedSegment(
  segments: readonly string[],
  prefix: "SEC" | "SUBSEC" | "VOL" | "REV"
): string | undefined {
  const segment = segments.find((candidate) => candidate.startsWith(prefix));
  return segment ? segment.slice(prefix.length) || segment : undefined;
}

function buildPackageContext(
  normalizedCode: string | undefined,
  source: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!normalizedCode) return undefined;
  const parts = parseCodeParts(normalizedCode);
  if (parts.stage !== "П") return undefined;
  return {
    stage: typedField("П", [source]),
    projectDesignation: typedField(parts.projectCode, [source]),
    sectionNumber: typedField(parts.sectionNumber, [source]),
    subsectionTitle: typedField(parts.subsectionTitle, [source]),
    volumeNumber: typedField(parts.volumeNumber, [source])
  };
}

function inferEstimateForm(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("object")) return "object_estimate";
  if (lower.includes("summary")) return "summary_estimate_calculation";
  return "local_estimate";
}

function inferStatementForm(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("quantity") || lower.includes("volume")) return "work_quantity_statement";
  if (lower.includes("drawing")) return "drawing_sheet_register";
  if (lower.includes("specification")) return "specification_register";
  return "unknown_statement";
}

function extractCodesFromContentArtifacts(
  artifacts: readonly ContentArtifactLike[]
): ExtractedCodeCandidate[] {
  const candidates: ExtractedCodeCandidate[] = [];
  for (const artifact of artifacts) {
    candidates.push(...extractCodesFromPayload(artifact.payload, artifactSource(artifact)));
  }
  return candidates;
}

function hasStatementLikeArtifact(artifacts: readonly ContentArtifactLike[]): boolean {
  return artifacts.some((artifact) => {
    const marker = [
      artifact.artifactType,
      readString(artifact.payload["kind"]),
      readString(artifact.payload["tableKind"]),
      readString(artifact.payload["title"]),
      readString(artifact.payload["textHint"])
    ]
      .filter(isString)
      .join(" ")
      .toLowerCase();
    return (
      marker.includes("statement") ||
      marker.includes("register") ||
      marker.includes("vedomost") ||
      marker.includes("table")
    );
  });
}

function extractCodesFromPayload(
  payload: Record<string, unknown>,
  baseSource: SourceReference
): ExtractedCodeCandidate[] {
  const directValues = [
    ["textHint", payload["textHint"]],
    ["text", payload["text"]],
    ["value", payload["value"]],
    ["rawValue", payload["rawValue"]],
    ["originalName", payload["originalName"]]
  ] as const;
  const directCodes = directValues.flatMap(([field, value]) => {
    const code = extractCodeCandidate(readString(value) ?? "");
    return code
      ? [
          {
            value: code,
            source: {
              ...baseSource,
              kind: "content_artifact_field",
              field
            }
          }
        ]
      : [];
  });
  const cells = readRecordArray(payload["cells"]);
  const cellCodes = cells.flatMap((cell, index) => {
    const code = extractCodeCandidate(readString(cell["value"]) ?? "");
    return code
      ? [
          {
            value: code,
            source: {
              ...baseSource,
              kind: "content_artifact_cell",
              cellIndex: index,
              location: cell["location"]
            }
          }
        ]
      : [];
  });
  const rows = readRecordArray(payload["rows"]);
  const rowCodes = rows.flatMap((row, index) =>
    extractCodesFromPayload(row, {
      ...baseSource,
      kind: "content_artifact_row",
      rowIndex: index,
      rowNumber: index + 1
    })
  );

  return [...directCodes, ...cellCodes, ...rowCodes];
}

function artifactSource(artifact: ContentArtifactLike): SourceReference {
  return {
    kind: "content_artifact",
    artifactId: artifact.id,
    artifactType: artifact.artifactType
  };
}

function typedField<T>(value: T | undefined, source: readonly Record<string, unknown>[]) {
  if (value === undefined) return undefined;
  return {
    raw: String(value),
    value,
    normalized: String(value),
    confidence: 0.7,
    source
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueCodeCandidates(
  candidates: readonly ExtractedCodeCandidate[]
): ExtractedCodeCandidate[] {
  const seen = new Set<string>();
  const result: ExtractedCodeCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    result.push(candidate);
  }
  return result;
}

function identityKey(
  role: "own_code" | "reference_code",
  normalizedValue: string,
  parseStatus: DocumentIdentityParseStatus,
  occurrence?: number
): string {
  return [role, parseStatus, normalizedValue, occurrence ?? 0].join(":");
}

function isUnsupportedStandardCode(parts: Record<string, unknown>): boolean {
  const segments = Array.isArray(parts["segments"]) ? parts["segments"] : [];
  return segments.some(
    (segment) =>
      typeof segment === "string" &&
      ["ISO", "IFC", "BS", "DIN", "UNSUPPORTED"].includes(segment)
  );
}
