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

function isSharedContext(line: DiffLine): boolean {
  return line.type === "context" && line.oldLine != null && line.newLine != null && line.oldContent === undefined;
}

function needsOldOutput(line: DiffLine): boolean {
  return line.type === "deletion" || line.newLine == null || line.oldContent !== undefined;
}

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

    // tokenize leading shared context once so both sides inherit its exact grammar state.
    let prefixEnd = 0;
    while (prefixEnd < hunk.lines.length && isSharedContext(hunk.lines[prefixEnd]!)) {
      prefixEnd++;
    }
    let midState = state;
    if (prefixEnd > 0) {
      const prefix = hunk.lines.slice(0, prefixEnd);
      const pre = highlightLines(hl, prefix.map((l) => l.content), lang, state);
      prefix.forEach((l, i) => html.set(l, pre.lines[i] ?? ""));
      midState = pre.state;
    }

    const rest = hunk.lines.slice(prefixEnd);
    const oldRest = rest.filter((l) => l.type === "deletion" || l.oldLine != null);
    const newRest = rest.filter((l) => l.type === "addition" || l.newLine != null);
    const hasNewSide = prefixEnd > 0 || newRest.length > 0;

    // stop tokenizing the old side after the last line whose old-side output is actually used.
    let lastOldIndex = -1;
    for (let i = oldRest.length - 1; i >= 0; i--) {
      if (needsOldOutput(oldRest[i]!)) {
        lastOldIndex = i;
        break;
      }
    }

    let oldState = midState;
    if (lastOldIndex >= 0) {
      const oldSlice = oldRest.slice(0, lastOldIndex + 1);
      const old = highlightLines(hl, oldSlice.map((l) => l.oldContent ?? l.content), lang, midState);
      oldSlice.forEach((l, i) => {
        const rendered = old.lines[i] ?? "";
        if (l.type === "deletion" || l.newLine == null) html.set(l, rendered);
        if (l.oldContent !== undefined) oldHtml.set(l, rendered);
      });
      oldState = old.state;
    }

    let nextState = midState;
    if (newRest.length > 0) {
      const next = highlightLines(hl, newRest.map((l) => l.content), lang, midState);
      newRest.forEach((l, i) => html.set(l, next.lines[i] ?? ""));
      nextState = next.state;
    }

    // without the file text, carry the state across hunks as a best effort.
    if (!source) state = hasNewSide ? nextState : oldState;
  }
  return { html, oldHtml };
}
