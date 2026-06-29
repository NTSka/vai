import { describe, expect, it } from "vitest";

import { selectAcceptedFileIdsByParsePriority } from "./file-priority.js";

describe("selectAcceptedFileIdsByParsePriority", () => {
  it("keeps XLSX instead of PDF for the same document stem", () => {
    expect(
      selectAcceptedFileIdsByParsePriority({
        fileIds: ["pdf", "xlsx"],
        files: [
          { id: "pdf", originalName: "drawing.pdf", extension: ".pdf" },
          { id: "xlsx", originalName: "drawing.xlsx", extension: ".xlsx" }
        ]
      })
    ).toEqual(["xlsx"]);
  });

  it("uses archive-relative paths when they are provided", () => {
    expect(
      selectAcceptedFileIdsByParsePriority({
        fileIds: ["left-pdf", "right-pdf", "right-xlsx"],
        files: [
          {
            id: "left-pdf",
            originalName: "drawing.pdf",
            extension: ".pdf",
            dedupeName: "left/drawing.pdf"
          },
          {
            id: "right-pdf",
            originalName: "drawing.pdf",
            extension: ".pdf",
            dedupeName: "right/drawing.pdf"
          },
          {
            id: "right-xlsx",
            originalName: "drawing.xlsx",
            extension: ".xlsx",
            dedupeName: "right/drawing.xlsx"
          }
        ]
      })
    ).toEqual(["left-pdf", "right-xlsx"]);
  });
});
