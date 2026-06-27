import type { FallbackGroup, ProjectTree, ProjectTreeNode } from "$lib/api/types";

export type TreeRow = {
  id: string;
  parentId: string | null;
  title: string;
  detail: string;
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

  function nodeMatches(node: ProjectTreeNode): boolean {
    const value = `${node.title} ${node.key} ${node.subject ?? ""}`.toLowerCase();
    return value.includes(filter);
  }

  function walk(node: ProjectTreeNode, depth: number): boolean {
    const childNodes = children.get(node.id) ?? [];
    const ownMatch = filter.length === 0 || nodeMatches(node);
    const shouldShowChildren =
      includeAllAncestors || input.expanded.has(node.id) || depth === 0;
    let childRows: TreeRow[] = [];
    let descendantMatch = false;

    if (shouldShowChildren || filter.length > 0) {
      const before = rows.length;
      for (const child of childNodes) {
        descendantMatch = walk(child, depth + 1) || descendantMatch;
      }
      childRows = rows.splice(before);
    }

    const visible = ownMatch || descendantMatch;
    if (visible) {
      rows.push({
        id: node.id,
        parentId: node.parentId,
        title: node.title,
        detail: node.subject ?? node.kind,
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
    walk(root, 0);
  }

  for (const group of input.tree.fallbackGroups) {
    if (fallbackMatches(group, filter)) {
      rows.push({
        id: group.id,
        parentId: null,
        title: group.title,
        detail: "Fallback group",
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
    list.sort((left, right) => left.title.localeCompare(right.title));
  }

  return children;
}

function fallbackMatches(group: FallbackGroup, filter: string): boolean {
  return filter.length === 0 || `${group.id} ${group.title}`.toLowerCase().includes(filter);
}
