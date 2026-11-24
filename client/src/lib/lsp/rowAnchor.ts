// which side and line a language server should be asked about for a diff row: removed lines
// (and old-pane whitespace-differing context lines) use the old file so character offsets match;
// everything else uses the new file.

import type { DiffLine, LspSide } from "$types";

export function lspAnchor(line: DiffLine, pane?: LspSide): { side: LspSide; line: number } | null {
  if (line.type === "deletion") return line.oldLine == null ? null : { side: "old", line: line.oldLine };
  if (pane === "old" && (line.oldContent !== undefined || line.newLine == null)) {
    return line.oldLine == null ? null : { side: "old", line: line.oldLine };
  }
  return line.newLine == null ? null : { side: "new", line: line.newLine };
}
