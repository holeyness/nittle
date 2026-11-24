// syntax highlighting for a diff file. each hunk side is tokenized as one block (not per line) so
// multi-line constructs and embedded languages (a svelte <script>, a vue <style>) keep their
// context; the new-side file text, when given, seeds each hunk with the grammar state it starts in.
import type { DiffFile, DiffHunk, DiffLine } from "$types";
import { languageFor } from "./languages";
import { highlighterFor, highlightLines, stateAfter, type GrammarState } from "./highlighter";

export type LineHtml = Map<DiffLine, string>;

const PURE_DELETION = /\+(\d+),0\b/;
// seeding tokenizes every line before the deepest hunk on the main thread (~0.1ms/line); past
// this it isn't worth the stall or the fetch.
const MAX_CONTEXT_LINES = 4000;

// how many new-side lines come before the hunk.
function linesBefore(hunk: DiffHunk): number {
  const first = hunk.lines.find((l) => l.newLine != null)?.newLine;
  if (first != null) return first - 1;
  return Number(PURE_DELETION.exec(hunk.header)?.[1] ?? 0);
}

// modified files whose hunks start mid-file need the full text to know their starting context —
// decided before fetching, so files without a grammar or with hunks too deep to seed skip the request.
export function needsFileText(file: DiffFile): boolean {
  if (file.changeType !== "modified" && file.changeType !== "renamed") return false;
  if (!languageFor(file.path)) return false;
  const deepest = Math.max(0, ...file.hunks.map(linesBefore));
  return deepest > 0 && deepest <= MAX_CONTEXT_LINES;
}

export interface SideLineHtml {
  html: LineHtml;
  oldHtml: LineHtml;
}

// highlighted html per diff line for both sides; `oldHtml` holds old-side markup for
// whitespace-ignored context lines whose old text differs from `line.content`.
export async function highlightFile(file: DiffFile, newText: string | null): Promise<SideLineHtml> {
  const html: LineHtml = new Map();
  const oldHtml: LineHtml = new Map();
  const lang = languageFor(file.path);
  const hl = lang ? await highlighterFor(lang) : null;
  if (!lang || !hl) return { html, oldHtml };

  const source = newText?.split(/\r?\n/) ?? null;
  let state: GrammarState | undefined;
  let consumed = 0;
  for (const hunk of file.hunks) {
    if (source) {
      const start = linesBefore(hunk);
      state = stateAfter(hl, source.slice(consumed, start), lang, state);
      consumed = start;
    }
    const oldSide = hunk.lines.filter((l) => l.type === "deletion" || l.oldLine != null);
    const newSide = hunk.lines.filter((l) => l.type === "addition" || l.newLine != null);
    const old = highlightLines(hl, oldSide.map((l) => l.oldContent ?? l.content), lang, state);
    const next = highlightLines(hl, newSide.map((l) => l.content), lang, state);
    oldSide.forEach((l, i) => {
      const rendered = old.lines[i] ?? "";
      if (l.type === "deletion" || l.newLine == null) html.set(l, rendered);
      if (l.oldContent !== undefined) oldHtml.set(l, rendered);
    });
    newSide.forEach((l, i) => html.set(l, next.lines[i] ?? ""));
    // without the file text, carry the state across hunks as a best effort.
    if (!source) state = newSide.length ? next.state : old.state;
  }
  return { html, oldHtml };
}
