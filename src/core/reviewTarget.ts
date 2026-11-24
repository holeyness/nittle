import type { DiffMeta, DiffResult } from "../types";
import { collectDiff, repoName, resolveRef } from "../utils/git";
import { parseDiff } from "./diffParser";
import { excludeReviewFile } from "./reviewFilter";
import { scanProject } from "./projectScan";

export interface LoadedReviewTarget {
  diff: DiffResult;
  newRef: string | null;
  diffArgs: string[];
  includeUntracked: boolean;
  meta?: DiffMeta;
  mode: "diff" | "browse";
  scope?: string;
  pinnedSpec?: string; // stable spec for the review record (full commit hash)
}

export function buildDiff(
  diffArgs: string[],
  cwd: string,
  includeUntracked: boolean,
  refLabel: string,
  meta: DiffMeta | undefined,
  showReviewFile = false,
  contextLines?: number,
): DiffResult {
  const raw = collectDiff(diffArgs, cwd, includeUntracked, showReviewFile, contextLines);
  return excludeReviewFile({ ...parseDiff(raw, refLabel), meta }, showReviewFile);
}

export function loadReviewTarget(
  cwd: string,
  spec?: string,
  scope?: string,
  showReviewFile = false,
  contextLines?: number,
): LoadedReviewTarget {
  if (spec === "browse") {
    const diff = excludeReviewFile(scanProject(cwd, scope), showReviewFile);
    return { diff, newRef: null, diffArgs: [], includeUntracked: false, meta: diff.meta, mode: "browse", scope };
  }
  const plan = resolveRef(spec === "working" || spec === "working-tree" ? undefined : spec, cwd);
  const meta = { repo: repoName(cwd), mode: plan.mode, source: plan.source, target: plan.target, ...(plan.commit ? { commit: plan.commit } : {}) };
  const diff = buildDiff(plan.diffArgs, cwd, plan.includeUntracked, plan.refLabel, meta, showReviewFile, contextLines);
  return { diff, newRef: plan.newRef, diffArgs: plan.diffArgs, includeUntracked: plan.includeUntracked, meta, mode: "diff", ...(plan.pinnedSpec ? { pinnedSpec: plan.pinnedSpec } : {}) };
}
