import type { DiffFile, DiffLine } from "$types";
import { getFile } from "$lib/api/meta";
import { escapeHtml } from "./html";
import { highlightFile, needsFileText, type SideLineHtml } from "./highlight";

// completed highlights keyed by DiffFile identity; auto-evicts when a diff refreshes or switches
// target, and stays valid across theme swaps because SYNTAX_THEME uses CSS custom properties.
const highlightCache = new WeakMap<DiffFile, SideLineHtml>();

// new-side text for seeding hunk context; `cacheable` is false if the fetch failed transiently
// so a degraded highlight isn't cached for the lifetime of the DiffFile.
function loadText(file: DiffFile, signal: AbortSignal): Promise<{ text: string | null; cacheable: boolean }> {
  if (!needsFileText(file)) return Promise.resolve({ text: null, cacheable: true });
  return getFile(file.path, signal).then(
    (r) => ({ text: r.content, cacheable: true }),
    () => ({ text: null, cacheable: false }),
  );
}

// reactive per-line html for the current file: synchronous on cache hit, escaped plain text
// until its highlight lands on first visit.
export function createFileHighlight(current: () => DiffFile): (line: DiffLine, side?: "old" | "new") => string {
  let result = $state.raw<{ file: DiffFile; sides: SideLineHtml } | null>(null);

  $effect(() => {
    const file = current();
    // cache hits are served synchronously by the getter below; avoid triggering a second render.
    if (highlightCache.has(file)) return;
    const controller = new AbortController();
    loadText(file, controller.signal)
      .then(async ({ text, cacheable }) => {
        if (controller.signal.aborted) return;
        const sides = await highlightFile(file, text);
        if (cacheable) highlightCache.set(file, sides);
        if (!controller.signal.aborted) result = { file, sides };
      })
      .catch(() => {});
    return () => controller.abort();
  });

  return (line, side) => {
    const file = current();
    const active = result?.file === file ? result.sides : (highlightCache.get(file) ?? null);
    if (side === "old" && line.oldContent !== undefined) {
      return active?.oldHtml.get(line) ?? escapeHtml(line.oldContent);
    }
    return active?.html.get(line) ?? escapeHtml(line.content);
  };
}
