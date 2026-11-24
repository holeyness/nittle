import { describe, it, expect } from "vitest";
import type { DiffFile, DiffHunk, DiffLine } from "$types";
import {
  applyWhitespacePolicy,
  applyWhitespaceToFile,
  isWhitespaceOnlyResult,
  myersLcs,
  transformHunk,
} from "./whitespace";
import { changeBlocksOf } from "./changeBlocks";

const ctx = (oldLine: number, newLine: number, content: string): DiffLine => ({
  type: "context",
  oldLine,
  newLine,
  content,
});
const del = (oldLine: number, content: string): DiffLine => ({
  type: "deletion",
  oldLine,
  newLine: null,
  content,
});
const add = (newLine: number, content: string): DiffLine => ({
  type: "addition",
  oldLine: null,
  newLine,
  content,
});

function makeFile(hunks: DiffHunk[], changeType: DiffFile["changeType"] = "modified"): DiffFile {
  const lines = hunks.flatMap((h) => h.lines);
  return {
    path: "app.py",
    oldPath: null,
    changeType,
    additions: lines.filter((l) => l.type === "addition").length,
    deletions: lines.filter((l) => l.type === "deletion").length,
    hunks,
  };
}

describe("myersLcs", () => {
  it("finds exact LCS across insertions, deletions, and edits", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["x", "a", "b", "y", "d"];
    expect(myersLcs(a, b)).toEqual([
      [0, 1],
      [1, 2],
      [3, 4],
    ]);
  });

  it("handles identical and disjoint inputs via prefix/suffix fast path", () => {
    expect(myersLcs(["a", "b"], ["a", "b"])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(myersLcs(["a", "b"], ["c", "d"])).toEqual([]);
  });

  it("degrades safely when edit distance exceeds maxD", () => {
    const a = ["same", "1", "2", "3", "4", "end"];
    const b = ["same", "a", "b", "c", "d", "end"];
    expect(myersLcs(a, b, 2)).toEqual([
      [0, 0],
      [5, 5],
    ]);
  });
});

describe("transformHunk & IntelliJ whitespace policies", () => {
  // Wrapping an existing block in `if cond:`, editing one line, changing internal spacing on one,
  // adding trailing space on one, and inserting a blank line.
  const wrappedBlock: DiffHunk = {
    header: "@@ -1,5 +1,7 @@",
    lines: [
      ctx(1, 1, "def f():"),
      del(2, "x = 1"),
      del(3, "  y = a + b"),
      del(4, '  z = "hi"'),
      del(5, "  keep = 1"),
      add(2, "if cond:"),
      add(3, "    x = 1"),
      add(4, "    y = a+b"),
      add(5, ""),
      add(6, '    z = "hi"   '),
      add(7, "    keep = 2"),
    ],
  };

  it("mode 'none' returns the hunk unchanged", () => {
    expect(transformHunk(wrappedBlock, "none")).toBe(wrappedBlock);
  });

  it("mode 'trim' ignores leading/trailing whitespace but keeps internal whitespace and blank lines", () => {
    const out = transformHunk(wrappedBlock, "trim");
    // Matched via trim: x = 1 (old 2 -> new 3) and z = "hi" (old 4 -> new 6)
    const xLine = out.lines.find((l) => l.newLine === 3);
    expect(xLine).toEqual({
      type: "context",
      oldLine: 2,
      newLine: 3,
      content: "    x = 1",
      oldContent: "x = 1",
    });
    const zLine = out.lines.find((l) => l.newLine === 6);
    expect(zLine).toEqual({
      type: "context",
      oldLine: 4,
      newLine: 6,
      content: '    z = "hi"   ',
      oldContent: '  z = "hi"',
    });

    // `y = a + b` vs `y = a+b` differs internally -> still deletion + addition under trim
    expect(out.lines.find((l) => l.oldLine === 3)?.type).toBe("deletion");
    expect(out.lines.find((l) => l.newLine === 4)?.type).toBe("addition");

    // Blank line added at newLine 5 -> still addition under trim
    expect(out.lines.find((l) => l.newLine === 5)?.type).toBe("addition");

    // `if cond:` and `keep = 1 -> keep = 2` remain real changes
    expect(out.lines.find((l) => l.newLine === 2)?.type).toBe("addition");
    expect(out.lines.find((l) => l.oldLine === 5)?.type).toBe("deletion");
    expect(out.lines.find((l) => l.newLine === 7)?.type).toBe("addition");
  });

  it("mode 'all' ignores internal whitespace too, while still showing added blank lines", () => {
    const out = transformHunk(wrappedBlock, "all");
    // `y = a + b` vs `    y = a+b` now matches as context with preserved oldContent
    expect(out.lines.find((l) => l.newLine === 4)).toEqual({
      type: "context",
      oldLine: 3,
      newLine: 4,
      content: "    y = a+b",
      oldContent: "  y = a + b",
    });
    // Blank line at newLine 5 is still an addition
    expect(out.lines.find((l) => l.newLine === 5)?.type).toBe("addition");
    // Only `if cond:`, blank line, and `keep` remain changed
    const file = applyWhitespaceToFile(makeFile([wrappedBlock]), "all", false);
    expect(file.additions).toBe(3); // if cond:, blank, keep = 2
    expect(file.deletions).toBe(1); // keep = 1
  });

  it("mode 'all-and-empty' ignores all whitespace and blank lines while preserving exact line numbers", () => {
    const out = transformHunk(wrappedBlock, "all-and-empty");
    // Blank line at newLine 5 becomes an unhighlighted one-sided context line
    expect(out.lines.find((l) => l.newLine === 5)).toEqual({
      type: "context",
      oldLine: null,
      newLine: 5,
      content: "",
    });
    // Strictly increasing oldLine and newLine coordinates with zero gaps
    const oldNums = out.lines.map((l) => l.oldLine).filter((n): n is number => n != null);
    const newNums = out.lines.map((l) => l.newLine).filter((n): n is number => n != null);
    expect(oldNums).toEqual([1, 2, 3, 4, 5]);
    expect(newNums).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const file = applyWhitespaceToFile(makeFile([wrappedBlock]), "all-and-empty", false);
    expect(file.additions).toBe(2); // if cond:, keep = 2
    expect(file.deletions).toBe(1); // keep = 1
    expect(changeBlocksOf(file)).toHaveLength(2);
  });

  it("mode 'all-and-empty' matches reindented lines even when git placed a blank context line between them", () => {
    // Old: foo(), bar(), "", baz()
    // New: if cond:,     foo(), "",     bar(),     baz()
    // Git greedily matches "" (old 3 <-> new 3) as a context line, splitting `bar()` across two blocks.
    const splitByBlank: DiffHunk = {
      header: "@@ -1,4 +1,5 @@",
      lines: [
        del(1, "foo()"),
        del(2, "bar()"),
        add(1, "if cond:"),
        add(2, "    foo()"),
        ctx(3, 3, ""),
        del(4, "baz()"),
        add(4, "    bar()"),
        add(5, "    baz()"),
      ],
    };

    const out = transformHunk(splitByBlank, "all-and-empty");
    const changed = out.lines.filter((l) => l.type !== "context");
    expect(changed).toEqual([add(1, "if cond:")]);

    // Line numbers remain strictly monotonic on both sides
    expect(out.lines.map((l) => l.oldLine).filter((n): n is number => n != null)).toEqual([1, 2, 3, 4]);
    expect(out.lines.map((l) => l.newLine).filter((n): n is number => n != null)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("applyWhitespacePolicy", () => {
  const wsOnlyHunk: DiffHunk = {
    header: "@@ -1,2 +1,2 @@",
    lines: [del(1, "foo()"), add(1, "    foo()"), ctx(2, 2, "bar()")],
  };
  const realHunk: DiffHunk = {
    header: "@@ -10,2 +10,2 @@",
    lines: [del(10, "x = 1"), add(10, "x = 2"), ctx(11, 11, "y = 3")],
  };

  it("drops whitespace-only hunks in hunk mode but preserves the file hunk in full-file mode", () => {
    const wsOnlyFile = makeFile([wsOnlyHunk]);
    const fullResult = applyWhitespacePolicy([wsOnlyFile], "trim", false)[0]!;
    expect(fullResult.additions).toBe(0);
    expect(fullResult.deletions).toBe(0);
    expect(fullResult.hunks).toHaveLength(1);
    expect(isWhitespaceOnlyResult(fullResult, "trim")).toBe(true);

    const hunkResult = applyWhitespacePolicy([wsOnlyFile], "trim", true)[0]!;
    expect(hunkResult.additions).toBe(0);
    expect(hunkResult.deletions).toBe(0);
    expect(hunkResult.hunks).toHaveLength(0);
    expect(isWhitespaceOnlyResult(hunkResult, "trim")).toBe(true);

    const mixedFile = makeFile([wsOnlyHunk, realHunk]);
    const mixedHunkMode = applyWhitespacePolicy([mixedFile], "trim", true)[0]!;
    expect(mixedHunkMode.hunks).toHaveLength(1);
    expect(mixedHunkMode.hunks[0]!.header).toBe("@@ -10,2 +10,2 @@");
    expect(isWhitespaceOnlyResult(mixedHunkMode, "trim")).toBe(false);
  });

  it("leaves added, deleted, and binary files untouched", () => {
    const added = makeFile([{ header: "@@ -0,0 +1,2 @@", lines: [add(1, ""), add(2, "x = 1")] }], "added");
    const deleted = makeFile([{ header: "@@ -1,2 +0,0 @@", lines: [del(1, ""), del(2, "x = 1")] }], "deleted");
    const binary: DiffFile = {
      path: "img.png",
      oldPath: null,
      changeType: "modified",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: [],
    };
    expect(applyWhitespaceToFile(added, "all-and-empty", false)).toBe(added);
    expect(applyWhitespaceToFile(deleted, "all-and-empty", false)).toBe(deleted);
    expect(applyWhitespaceToFile(binary, "all-and-empty", false)).toBe(binary);
    expect(isWhitespaceOnlyResult(binary, "all-and-empty")).toBe(false);
  });

  it("does not mislabel a pure 100%-identical rename or mode-only change as whitespace-only", () => {
    const pureRename: DiffFile = {
      path: "new_name.py",
      oldPath: "old_name.py",
      changeType: "renamed",
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    const out = applyWhitespaceToFile(pureRename, "trim", false);
    expect(out.whitespaceOnly).toBeUndefined();
    expect(isWhitespaceOnlyResult(out, "trim")).toBe(false);
  });
});
