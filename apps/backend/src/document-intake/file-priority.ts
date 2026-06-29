import path from "node:path";

export type IntakeFileCandidate = {
  readonly id: string;
  readonly originalName: string;
  readonly extension: string | null;
  readonly dedupeName?: string;
};

const parsePriorityByExtension = new Map([
  [".xlsx", 2],
  [".pdf", 1]
]);

export function selectAcceptedFileIdsByParsePriority(input: {
  readonly fileIds: readonly string[];
  readonly files: readonly IntakeFileCandidate[];
}): string[] {
  const filesById = new Map(input.files.map((file) => [file.id, file]));
  const orderedFiles = input.fileIds
    .map((id) => filesById.get(id))
    .filter((file): file is IntakeFileCandidate => file !== undefined);
  const selectedByBaseName = new Map<
    string,
    { readonly file: IntakeFileCandidate; readonly priority: number }
  >();

  for (const file of orderedFiles) {
    const priority = parsePriority(file);
    if (priority === 0) continue;

    const baseName = normalizedBaseName(file);
    const existing = selectedByBaseName.get(baseName);
    if (!existing || priority > existing.priority) {
      selectedByBaseName.set(baseName, { file, priority });
    }
  }

  const selectedPriorityFileIds = new Set(
    [...selectedByBaseName.values()].map((selection) => selection.file.id)
  );

  return orderedFiles
    .filter((file) => parsePriority(file) === 0 || selectedPriorityFileIds.has(file.id))
    .map((file) => file.id);
}

function parsePriority(file: IntakeFileCandidate): number {
  return parsePriorityByExtension.get(normalizeExtension(file)) ?? 0;
}

function normalizeExtension(file: IntakeFileCandidate): string {
  return (file.extension ?? path.extname(file.originalName)).toLowerCase();
}

function normalizedBaseName(file: IntakeFileCandidate): string {
  const name = file.dedupeName ?? path.basename(file.originalName);
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return stem.trim().replace(/\s+/g, " ").toLowerCase();
}
