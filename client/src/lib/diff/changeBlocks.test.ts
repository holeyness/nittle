import { describe, it, expect } from "vitest";
import type { DiffFile, HistoryCommit } from "$types";
import { changeBlocksOf, commitRangeSpec } from "./changeBlocks";

function makeCommit(hash: string, parents: string[] = ["parent"]): HistoryCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: "Ian",
    relativeDate: "1h ago",
    subject: `commit ${hash}`,
    refs: [],
    onStack: true,
  };
}

describe("changeBlocksOf", () => {
  it("finds multiple change blobs inside a single full-file hunk", () => {
    const file: DiffFile = {
      path: "a.py",
      oldPath: null,
      changeType: "modified",
      additions: 3,
      deletions: 2,
      hunks: [
        {
          header: "@@ -1,10 +1,11 @@",
          lines: [
            { type: "context", oldLine: 1, newLine: 1, content: "line 1" },
            { type: "context", oldLine: 2, newLine: 2, content: "line 2" },
            { type: "deletion", oldLine: 3, newLine: null, content: "old 3" },
            { type: "addition", oldLine: null, newLine: 3, content: "new 3a" },
            { type: "addition", oldLine: null, newLine: 4, content: "new 3b" },
            { type: "context", oldLine: 4, newLine: 5, content: "line 4" },
            { type: "context", oldLine: 5, newLine: 6, content: "line 5" },
            { type: "deletion", oldLine: 6, newLine: null, content: "removed 6" },
            { type: "context", oldLine: 7, newLine: 7, content: "line 7" },
            { type: "addition", oldLine: null, newLine: 8, content: "added 8" },
          ],
        },
      ],
    };

    const blocks = changeBlocksOf(file);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ index: 0, side: "old", line: 3, additions: 2, deletions: 1 });
    expect(blocks[1]).toMatchObject({ index: 1, side: "old", line: 6, additions: 0, deletions: 1 });
    expect(blocks[2]).toMatchObject({ index: 2, side: "new", line: 8, additions: 1, deletions: 0 });
  });
});

describe("commitRangeSpec", () => {
  const commits = [
    makeCommit("aaaaaaa1", ["bbbbbbb2"]),
    makeCommit("bbbbbbb2", ["ccccccc3"]),
    makeCommit("ccccccc3", ["ddddddd4"]),
    makeCommit("ddddddd4", []), // root commit
  ];

  it("maps a single commit to <hash>^!", () => {
    expect(commitRangeSpec(commits, [1])).toEqual({
      spec: "bbbbbbb2^!",
      label: "commit bbbbbbb",
      mode: "single",
    });
  });

  it("maps a contiguous multi-commit selection to <oldest>^..<newest>", () => {
    expect(commitRangeSpec(commits, [0, 1, 2])).toEqual({
      spec: "ccccccc3^..aaaaaaa1",
      label: "3 commits · ccccccc^..aaaaaaa",
      mode: "combined",
    });
  });

  it("maps two non-adjacent commits to snapshot compare <older>..<newer>", () => {
    expect(commitRangeSpec(commits, [0, 2])).toEqual({
      spec: "ccccccc3..aaaaaaa1",
      label: "compare ccccccc..aaaaaaa",
      mode: "compare",
    });
  });

  it("handles a root commit without a parent safely", () => {
    expect(commitRangeSpec(commits, [2, 3])).toEqual({
      spec: "ddddddd4..ccccccc3",
      label: "2 commits · ddddddd..ccccccc",
      mode: "combined",
    });
  });
});
