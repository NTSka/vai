import { describe, expect, test } from "vitest";

import type { ProjectTree } from "$lib/api/types";
import { buildProjectTreeRows } from "./tree-presenter";

const tree: ProjectTree = {
  organizationId: "org-1",
  nodes: [
    node({ id: "root", title: "Project", key: "P" }),
    node({ id: "b", parentId: "root", title: "Beta", key: "B" }),
    node({ id: "a", parentId: "root", title: "Alpha", key: "A", documentCount: 2 }),
    node({ id: "a-1", parentId: "a", title: "Sheet A1", key: "A1" })
  ],
  fallbackGroups: [{ id: "unplaced", title: "Unplaced documents", documentCount: 1 }]
};

describe("buildProjectTreeRows", () => {
  test("sorts siblings and includes root-level children by default", () => {
    const rows = buildProjectTreeRows({
      tree,
      expanded: new Set(),
      search: ""
    });

    expect(rows.map((row) => row.id)).toEqual(["root", "a", "b", "unplaced"]);
    expect(rows.find((row) => row.id === "a")?.hasChildren).toBe(true);
  });

  test("includes descendants for expanded nodes", () => {
    const rows = buildProjectTreeRows({
      tree,
      expanded: new Set(["a"]),
      search: ""
    });

    expect(rows.map((row) => row.id)).toEqual(["root", "a", "a-1", "b", "unplaced"]);
  });

  test("search shows ancestors and matching descendants", () => {
    const rows = buildProjectTreeRows({
      tree,
      expanded: new Set(),
      search: "A1"
    });

    expect(rows.map((row) => row.id)).toEqual(["root", "a", "a-1"]);
  });

  test("search matches the full dotted key chain", () => {
    const rows = buildProjectTreeRows({
      tree,
      expanded: new Set(),
      search: "P.A.A1"
    });

    expect(rows.map((row) => row.id)).toEqual(["root", "a", "a-1"]);
    expect(rows.find((row) => row.id === "a-1")?.pathCode).toBe("P.A.A1");
  });
});

function node(input: {
  id: string;
  parentId?: string | null;
  title: string;
  key: string;
  documentCount?: number;
}) {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    kind: "project_node",
    key: input.key,
    title: input.title,
    subject: null,
    documentCount: input.documentCount ?? 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
