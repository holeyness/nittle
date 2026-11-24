// intra-line word diff: pairs deletion/addition runs and computes the changed char range
// inside each modified line pair. pure — no dom, unit-testable.

import type { DiffLine } from "$types";
import type { IgnoreWhitespace } from "./whitespace";

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

// pair deletions with additions for side-by-side rows; context spans both columns
// (one-sided context lines from ignored empty lines occupy only the side they exist on).
export function pairLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({
        left: line.oldLine != null ? line : null,
        right: line.newLine != null ? line : null,
      });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "deletion") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === "addition") adds.push(lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

export interface CharRange {
  start: number;
  end: number;
}
export interface PairRange {
  old: CharRange;
  new: CharRange;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN = /\w+|\s+|[^\w\s]/g;
const NON_WS_TOKEN = /\w+|[^\w\s]/g;
const IS_WS = /^\s+$/;

function tokenize(s: string, ignoreWhitespace: IgnoreWhitespace): Token[] {
  const pattern = ignoreWhitespace === "all" || ignoreWhitespace === "all-and-empty" ? NON_WS_TOKEN : TOKEN;
  const tokens: Token[] = [];
  for (const m of s.matchAll(pattern)) {
    const start = m.index ?? 0;
    tokens.push({ text: m[0], start, end: start + m[0].length });
  }
  if (ignoreWhitespace === "trim") {
    const lo = tokens.length > 0 && IS_WS.test(tokens[0]!.text) ? 1 : 0;
    const hi = tokens.length > lo && IS_WS.test(tokens[tokens.length - 1]!.text) ? tokens.length - 1 : tokens.length;
    return tokens.slice(lo, hi);
  }
  return tokens;
}

function tokenSpan(tokens: Token[], pre: number, end: number): CharRange {
  if (pre < end) return { start: tokens[pre]!.start, end: tokens[end - 1]!.end };
  const pos = pre > 0 ? tokens[pre - 1]!.end : (tokens[0]?.start ?? 0);
  return { start: pos, end: pos };
}

// char ranges [start, end) of the differing middle of a deletion/addition pair, via common
// token prefix + suffix. null when the lines are identical or share no tokens at all.
export function diffRange(oldText: string, newText: string, ignoreWhitespace: IgnoreWhitespace = "none"): PairRange | null {
  const a = tokenize(oldText, ignoreWhitespace);
  const b = tokenize(newText, ignoreWhitespace);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre]!.text === b[pre]!.text) pre++;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1]!.text === b[endB - 1]!.text) {
    endA--;
    endB--;
  }
  if (pre === endA && pre === endB) return null; // identical
  if (pre === 0 && endA === a.length && endB === b.length) return null; // nothing in common
  return {
    old: tokenSpan(a, pre, endA),
    new: tokenSpan(b, pre, endB),
  };
}

// per-line marks for a hunk's lines: Map<line, {start,end}> covering both sides.
export function hunkMarks(lines: DiffLine[], ignoreWhitespace: IgnoreWhitespace = "none"): Map<DiffLine, CharRange> {
  const marks = new Map<DiffLine, CharRange>();
  for (const { left, right } of pairLines(lines)) {
    if (!left || !right || left.type !== "deletion" || right.type !== "addition") continue;
    const range = diffRange(left.content, right.content, ignoreWhitespace);
    if (!range) continue;
    if (range.old.end > range.old.start) marks.set(left, range.old);
    if (range.new.end > range.new.start) marks.set(right, range.new);
  }
  return marks;
}

// wraps the [start, end) text range of highlighted html in <mark class="cls">, closing +
// reopening across tag boundaries so nesting stays valid. entities count as one rendered char;
// a literal "<" only opens tags because the highlighter escapes every "<" in code as &lt;.
const PIECE = /<[^>]*>|&[a-zA-Z]+;|&#x?[0-9a-fA-F]+;|[\s\S]/g;

export function markRange(html: string, start: number, end: number, cls: string): string {
  if (start >= end) return html;
  const open = `<mark class="${cls}">`;
  let out = "";
  let pos = 0;
  let marking = false;
  for (const piece of html.match(PIECE) ?? []) {
    if (piece[0] === "<" && piece.length > 1) {
      if (marking) out += "</mark>";
      out += piece;
      if (marking) out += open;
      continue;
    }
    if (pos === start) {
      out += open;
      marking = true;
    }
    if (pos === end && marking) {
      out += "</mark>";
      marking = false;
    }
    out += piece;
    pos++;
  }
  if (marking) out += "</mark>";
  // reopening at a tag boundary can leave an empty mark behind
  return out.replaceAll(`${open}</mark>`, "");
}
