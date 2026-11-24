// IntelliJ-style whitespace ignore modes: pure diff transformation preserving exact
// oldLine/newLine coordinates and both sides' original text for side-by-side rendering and LSP.

import type { DiffFile, DiffHunk, DiffLine, IgnoreWhitespace } from "$types";

export interface WhitespaceOption {
  value: IgnoreWhitespace;
  label: string;
  emptyBanner: string;
}

export const IGNORE_WHITESPACE_OPTIONS: readonly WhitespaceOption[] = [
  {
    value: "none",
    label: "Do not ignore",
    emptyBanner: "",
  },
  {
    value: "trim",
    label: "Ignore trim whitespaces",
    emptyBanner: "Contents have differences only in trim whitespaces",
  },
  {
    value: "all",
    label: "Ignore whitespaces",
    emptyBanner: "Contents have differences only in whitespaces",
  },
  {
    value: "all-and-empty",
    label: "Ignore whitespaces and empty lines",
    emptyBanner: "Contents have differences only in whitespaces and empty lines",
  },
] as const;

const VALID_MODES = new Set<string>(IGNORE_WHITESPACE_OPTIONS.map((o) => o.value));

export function isIgnoreWhitespace(value: string | null): value is IgnoreWhitespace {
  return value !== null && VALID_MODES.has(value);
}

export function whitespaceEmptyBanner(mode: IgnoreWhitespace): string {
  return IGNORE_WHITESPACE_OPTIONS.find((o) => o.value === mode)?.emptyBanner ?? "";
}

export function normalizeLine(content: string, mode: IgnoreWhitespace): string {
  if (mode === "trim") return content.trim();
  if (mode === "all" || mode === "all-and-empty") return content.replace(/\s+/g, "");
  return content;
}

// Guard against pathological O((N+M)*D) work on huge completely-rewritten files.
const MAX_MYERS_D = 2000;

// Myers O((N+M)*D) longest common subsequence returning strictly increasing [ai, bi] index pairs.
export function myersLcs(a: string[], b: string[], maxD = MAX_MYERS_D): Array<[number, number]> {
  const n = a.length;
  const m = b.length;

  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;

  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;

  const prefix: Array<[number, number]> = [];
  for (let i = 0; i < pre; i++) prefix.push([i, i]);

  const suffix: Array<[number, number]> = [];
  for (let i = 0; i < suf; i++) suffix.push([n - suf + i, m - suf + i]);

  const N = n - pre - suf;
  const M = m - pre - suf;
  if (N === 0 || M === 0) return [...prefix, ...suffix];

  const limit = Math.min(N + M, maxD);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[pre + x] === b[pre + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        foundD = d;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (foundD >= 0) break;
  }

  if (foundD < 0) return [...prefix, ...suffix];

  const mid: Array<[number, number]> = [];
  let x = N;
  let y = M;
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d - 1]!;
    const prevOffset = d - 1;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[prevOffset + k - 1]! < prev[prevOffset + k + 1]!)
        ? k + 1
        : k - 1;
    const prevX = prev[prevOffset + prevK]!;
    const prevY = prevX - prevK;
    const midX = prevK === k + 1 ? prevX : prevX + 1;
    const midY = midX - k;
    while (x > midX && y > midY) {
      x--;
      y--;
      mid.push([pre + x, pre + y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    mid.push([pre + x, pre + y]);
  }
  mid.reverse();

  return [...prefix, ...mid, ...suffix];
}

function makeMatchedContext(oldLine: number | null, oldContent: string, newLine: number | null, newContent: string): DiffLine {
  return oldContent !== newContent
    ? { type: "context", oldLine, newLine, content: newContent, oldContent }
    : { type: "context", oldLine, newLine, content: newContent };
}

function diffChangeRun(dels: DiffLine[], adds: DiffLine[], mode: "trim" | "all"): DiffLine[] {
  if (dels.length === 0 || adds.length === 0) return [...dels, ...adds];

  const delKeys = dels.map((l) => normalizeLine(l.content, mode));
  const addKeys = adds.map((l) => normalizeLine(l.content, mode));
  const matches = myersLcs(delKeys, addKeys);
  if (matches.length === 0) return [...dels, ...adds];

  const out: DiffLine[] = [];
  let di = 0;
  let ai = 0;
  for (const [md, ma] of matches) {
    while (di < md) out.push(dels[di++]!);
    while (ai < ma) out.push(adds[ai++]!);
    const d = dels[md]!;
    const a = adds[ma]!;
    out.push(makeMatchedContext(d.oldLine, d.content, a.newLine, a.content));
    di = md + 1;
    ai = ma + 1;
  }
  while (di < dels.length) out.push(dels[di++]!);
  while (ai < adds.length) out.push(adds[ai++]!);
  return out;
}

interface SideEntry {
  lineNum: number | null;
  content: string;
  key: string;
}

function emitAllAndEmptyGap(oldGap: SideEntry[], newGap: SideEntry[], out: DiffLine[]): void {
  let oi = 0;
  let ni = 0;
  while (oi < oldGap.length || ni < newGap.length) {
    const o = oi < oldGap.length ? oldGap[oi]! : null;
    const n = ni < newGap.length ? newGap[ni]! : null;
    const oBlank = o !== null && o.key === "";
    const nBlank = n !== null && n.key === "";

    if (oBlank && nBlank) {
      out.push(makeMatchedContext(o.lineNum, o.content, n.lineNum, n.content));
      oi++;
      ni++;
      continue;
    }
    if (oBlank) {
      out.push({ type: "context", oldLine: o.lineNum, newLine: null, content: o.content });
      oi++;
      continue;
    }
    if (nBlank) {
      out.push({ type: "context", oldLine: null, newLine: n.lineNum, content: n.content });
      ni++;
      continue;
    }

    // Emit contiguous non-blank deletions followed by contiguous non-blank additions
    // so split-view pairing aligns edits side-by-side.
    while (oi < oldGap.length && oldGap[oi]!.key !== "") {
      const entry = oldGap[oi++]!;
      out.push({ type: "deletion", oldLine: entry.lineNum, newLine: null, content: entry.content });
    }
    while (ni < newGap.length && newGap[ni]!.key !== "") {
      const entry = newGap[ni++]!;
      out.push({ type: "addition", oldLine: null, newLine: entry.lineNum, content: entry.content });
    }
  }
}

function diffAllAndEmptySpan(span: DiffLine[]): DiffLine[] {
  const oldEntries: SideEntry[] = [];
  const newEntries: SideEntry[] = [];

  for (const line of span) {
    if (line.oldLine != null) {
      const text = line.oldContent ?? line.content;
      oldEntries.push({ lineNum: line.oldLine, content: text, key: normalizeLine(text, "all-and-empty") });
    }
    if (line.newLine != null) {
      newEntries.push({ lineNum: line.newLine, content: line.content, key: normalizeLine(line.content, "all-and-empty") });
    }
  }

  const oldNonBlankIdx: number[] = [];
  const oldNonBlankKeys: string[] = [];
  oldEntries.forEach((e, idx) => {
    if (e.key !== "") {
      oldNonBlankIdx.push(idx);
      oldNonBlankKeys.push(e.key);
    }
  });

  const newNonBlankIdx: number[] = [];
  const newNonBlankKeys: string[] = [];
  newEntries.forEach((e, idx) => {
    if (e.key !== "") {
      newNonBlankIdx.push(idx);
      newNonBlankKeys.push(e.key);
    }
  });

  const matches = myersLcs(oldNonBlankKeys, newNonBlankKeys);
  const out: DiffLine[] = [];
  let prevO = 0;
  let prevN = 0;

  for (const [mO, mN] of matches) {
    const oi = oldNonBlankIdx[mO]!;
    const ni = newNonBlankIdx[mN]!;
    emitAllAndEmptyGap(oldEntries.slice(prevO, oi), newEntries.slice(prevN, ni), out);
    const o = oldEntries[oi]!;
    const n = newEntries[ni]!;
    out.push(makeMatchedContext(o.lineNum, o.content, n.lineNum, n.content));
    prevO = oi + 1;
    prevN = ni + 1;
  }

  emitAllAndEmptyGap(oldEntries.slice(prevO), newEntries.slice(prevN), out);
  return out;
}

export function transformHunk(hunk: DiffHunk, mode: IgnoreWhitespace): DiffHunk {
  if (mode === "none") return hunk;

  if (mode === "all-and-empty") {
    const out: DiffLine[] = [];
    let span: DiffLine[] = [];
    let spanHasChanges = false;

    const flush = () => {
      if (span.length === 0) return;
      if (spanHasChanges) out.push(...diffAllAndEmptySpan(span));
      else out.push(...span);
      span = [];
      spanHasChanges = false;
    };

    for (const line of hunk.lines) {
      if (line.type === "context" && line.content.trim().length > 0) {
        flush();
        out.push(line);
      } else {
        span.push(line);
        if (line.type !== "context") spanHasChanges = true;
      }
    }
    flush();
    return { header: hunk.header, lines: out };
  }

  const out: DiffLine[] = [];
  let i = 0;
  const lines = hunk.lines;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      out.push(line);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "deletion") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === "addition") adds.push(lines[i++]!);
    out.push(...diffChangeRun(dels, adds, mode));
  }
  return { header: hunk.header, lines: out };
}

export function applyWhitespaceToFile(file: DiffFile, mode: IgnoreWhitespace, dropEmptyHunks: boolean): DiffFile {
  if (mode === "none" || file.binary || file.changeType === "added" || file.changeType === "deleted") {
    return file;
  }

  let hunks = file.hunks.map((h) => transformHunk(h, mode));
  if (dropEmptyHunks) {
    hunks = hunks.filter((h) => h.lines.some((l) => l.type !== "context"));
  }

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "addition") additions++;
      else if (line.type === "deletion") deletions++;
    }
  }

  const hadChanges = file.additions > 0 || file.deletions > 0 || file.hunks.some((h) => h.lines.some((l) => l.type !== "context"));
  const whitespaceOnly = hadChanges && additions === 0 && deletions === 0;

  return { ...file, additions, deletions, ...(whitespaceOnly ? { whitespaceOnly: true } : {}), hunks };
}

export function applyWhitespacePolicy(files: DiffFile[], mode: IgnoreWhitespace, dropEmptyHunks: boolean): DiffFile[] {
  if (mode === "none") return files;
  return files.map((file) => applyWhitespaceToFile(file, mode, dropEmptyHunks));
}

export function isWhitespaceOnlyResult(file: DiffFile, mode: IgnoreWhitespace): boolean {
  return mode !== "none" && file.whitespaceOnly === true;
}
