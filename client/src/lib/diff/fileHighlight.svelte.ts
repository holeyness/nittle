import type { DiffFile, DiffLine } from "$types";
import { getFile } from "$lib/api/meta";
import { escapeHtml } from "./html";
import { highlightFile, needsFileText, type SideLineHtml } from "./highlight";

// new-side text for seeding hunk context; null when not needed or unavailable (highlighting
// still works, just without the file's leading context).
function loadText(file: DiffFile, signal: AbortSignal): Promise<string | null> {
  if (!needsFileText(file)) return Promise.resolve(null);
  return getFile(file.path, signal).then((r) => r.content, () => null);
}

// reactive per-line html for the current file: escaped plain text until its highlight lands.
export function createFileHighlight(current: () => DiffFile): (line: DiffLine, side?: "old" | "new") => string {
  let result = $state.raw<{ file: DiffFile; sides: SideLineHtml } | null>(null);

  $effect(() => {
    const file = current();
    const controller = new AbortController();
    loadText(file, controller.signal)
      .then((text) => highlightFile(file, text))
      .then((sides) => {
        if (!controller.signal.aborted) result = { file, sides };
      })
      .catch(() => {});
    return () => controller.abort();
  });

  return (line, side) => {
    const active = result?.file === current() ? result.sides : null;
    if (side === "old" && line.oldContent !== undefined) {
      return active?.oldHtml.get(line) ?? escapeHtml(line.oldContent);
    }
    return active?.html.get(line) ?? escapeHtml(line.content);
  };
}
