import type { FallbackGroup, ProjectTree, ProjectTreeNode } from "$lib/api/types";

export type TreeRow = {
  id: string;
  parentId: string | null;
  title: string;
  detail: string;
  pathCode: string;
  documentCount: number;
  depth: number;
  fallback: boolean;
  hasChildren: boolean;
};

export function buildProjectTreeRows(input: {
  tree: ProjectTree | null;
  expanded: ReadonlySet<string>;
  search: string;
}): TreeRow[] {
  if (!input.tree) {
    return [];
  }

  const filter = input.search.trim().toLowerCase();
  const children = groupChildren(input.tree.nodes);
  const rows: TreeRow[] = [];
  const includeAllAncestors = filter.length > 0;

  function nodeMatches(
    node: ProjectTreeNode,
    pathKeys: readonly string[],
    pathTitles: readonly string[]
  ): boolean {
    const pathCode = pathKeys.join(".");
    const pathText = pathTitles.join(".");
    const value = [
      node.title,
      node.key,
      node.subject ?? "",
      node.kind,
      pathCode,
      pathText
    ]
      .join(" ")
      .toLowerCase();
    return value.includes(filter);
  }

  function walk(
    node: ProjectTreeNode,
    depth: number,
    parentKeys: readonly string[],
    parentTitles: readonly string[]
  ): boolean {
    const childNodes = children.get(node.id) ?? [];
    const pathKeys = [...parentKeys, node.key];
    const pathTitles = [...parentTitles, treeTitle(node.title)];
    const pathCode = pathKeys.join(".");
    const ownMatch = filter.length === 0 || nodeMatches(node, pathKeys, pathTitles);
    const shouldShowChildren = includeAllAncestors || input.expanded.has(node.id);
    let childRows: TreeRow[] = [];
    let descendantMatch = false;

    if (shouldShowChildren || filter.length > 0) {
      const before = rows.length;
      for (const child of childNodes) {
        descendantMatch = walk(child, depth + 1, pathKeys, pathTitles) || descendantMatch;
      }
      childRows = rows.splice(before);
    }

    const visible = ownMatch || descendantMatch;
    if (visible) {
      rows.push({
        id: node.id,
        parentId: node.parentId,
        title: treeTitle(node.title),
        detail: buildTreeDetail(node, pathCode),
        pathCode,
        documentCount: node.documentCount,
        depth,
        fallback: false,
        hasChildren: childNodes.length > 0
      });
      rows.push(...childRows);
    }

    return visible;
  }

  for (const root of children.get(null) ?? []) {
    walk(root, 0, [], []);
  }

  for (const group of input.tree.fallbackGroups) {
    if (fallbackMatches(group, filter)) {
      rows.push({
        id: group.id,
        parentId: null,
        title: fallbackTitle(group),
        detail: "Группа без размещения",
        pathCode: group.id,
        documentCount: group.documentCount,
        depth: 0,
        fallback: true,
        hasChildren: false
      });
    }
  }

  return rows;
}

function groupChildren(nodes: readonly ProjectTreeNode[]): Map<string | null, ProjectTreeNode[]> {
  const children = new Map<string | null, ProjectTreeNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }

  for (const list of children.values()) {
    list.sort((left, right) => left.title.localeCompare(right.title, "ru"));
  }

  return children;
}

function fallbackMatches(group: FallbackGroup, filter: string): boolean {
  return filter.length === 0 || `${group.id} ${group.title}`.toLowerCase().includes(filter);
}

function treeTitle(value: string): string {
  const labels: Record<string, string> = {
    "Unplaced documents": "Неразмещенные документы",
    "Unsupported documents": "Неподдерживаемые документы"
  };
  return labels[value] ?? value;
}

function treeDetail(value: string): string {
  const labels: Record<string, string> = {
    project: "Проект",
    complex_kind: "Площадка",
    complex_part_kind: "Объект",
    complex_part_number: "Подобъект",
    building: "Здание",
    documentation_section: "Раздел",
    documentation_subsection: "Подраздел",
    documentation_volume: "Том",
    stage: "Стадия",
    mark: "Марка",
    document_group: "Группа документов",
    object: "Объект",
    subobject: "Подобъект",
    discipline_or_mark: "Марка",
    document_package: "Комплект",
    fallback_group: "Группа без размещения"
  };
  return labels[value] ?? value;
}

function buildTreeDetail(node: ProjectTreeNode, pathCode: string): string {
  const detail = treeDetail(node.subject ?? node.kind);
  return pathCode ? `${detail} · ${pathCode}` : detail;
}

function fallbackTitle(group: FallbackGroup): string {
  const labels: Record<string, string> = {
    unplaced: "Неразмещенные документы",
    unsupported: "Неподдерживаемые документы"
  };
  return labels[group.id] ?? treeTitle(group.title);
}
