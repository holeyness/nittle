// pure helpers for PyCharm-style change-block ("blob") navigation and multi-commit selection.

import type { DiffFile, HistoryCommit } from "$types";
import type { Side } from "./threads";

export interface ChangeBlock {
  index: number;
  side: Side;
  line: number;
  oldLine: number | null;
  newLine: number | null;
  additions: number;
  deletions: number;
}

// contiguous runs of addition/deletion lines across a file's hunks.
// works identically in full-file mode (1 hunk with many blocks) and standard hunk mode.
export function changeBlocksOf(file: DiffFile): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of file.hunks) {
    let active: ChangeBlock | null = null;
    for (const line of hunk.lines) {
      if (line.type === "context") {
        active = null;
        continue;
      }
      if (!active) {
        const side: Side = line.newLine != null ? "new" : "old";
        const num = side === "new" ? line.newLine! : line.oldLine!;
        active = {
          index: blocks.length,
          side,
          line: num,
          oldLine: line.oldLine,
          newLine: line.newLine,
          additions: 0,
          deletions: 0,
        };
        blocks.push(active);
      }
      if (line.type === "addition") active.additions++;
      else active.deletions++;
    }
  }
  return blocks;
}

export interface CommitSelectionSpec {
  spec: string;
  label: string;
  mode: "single" | "combined" | "compare";
}

// maps selected commit indices (in newest-first git log order) to a git diff spec:
// - 1 commit -> `<hash>^!` (single commit changes)
// - contiguous range (Shift-click or adjacent Cmd-click) -> `<oldest>^..<newest>` (combined diff)
// - 2 non-adjacent commits (Cmd-click two branch tips/commits) -> `<older>..<newer>` (snapshot compare)
// - 3+ non-adjacent commits -> `<oldest>^..<newest>` (spanning range)
export function commitRangeSpec(commits: HistoryCommit[], selectedIndices: number[]): CommitSelectionSpec | null {
  const unique = [...new Set(selectedIndices)].filter((i) => i >= 0 && i < commits.length).sort((a, b) => a - b);
  if (unique.length === 0) return null;

  if (unique.length === 1) {
    const commit = commits[unique[0]!]!;
    return {
      spec: `${commit.hash}^!`,
      label: `commit ${commit.shortHash}`,
      mode: "single",
    };
  }

  const newestIdx = unique[0]!;
  const oldestIdx = unique[unique.length - 1]!;
  const newest = commits[newestIdx]!;
  const oldest = commits[oldestIdx]!;
  const contiguous = oldestIdx - newestIdx + 1 === unique.length;

  if (!contiguous && unique.length === 2) {
    return {
      spec: `${oldest.hash}..${newest.hash}`,
      label: `compare ${oldest.shortHash}..${newest.shortHash}`,
      mode: "compare",
    };
  }

  const hasParent = oldest.parents.length > 0;
  const from = hasParent ? `${oldest.hash}^` : oldest.hash;
  const count = oldestIdx - newestIdx + 1;
  return {
    spec: `${from}..${newest.hash}`,
    label: `${count} commits · ${oldest.shortHash}${hasParent ? "^" : ""}..${newest.shortHash}`,
    mode: "combined",
  };
}
