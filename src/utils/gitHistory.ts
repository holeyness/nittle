// reads commit history and stacked branch topology for the interactive commit picker.

import type { CommitRefBadge, HistoryCommit, HistoryResponse, StackBranch } from "../types";
import { runGit } from "./git";

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 300;
const STACK_SCAN_LIMIT = 200;
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const DEFAULT_BASE_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

function tryGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, cwd).trim();
  } catch {
    return null;
  }
}

function resolveDefaultBranch(cwd: string): string | null {
  for (const candidate of DEFAULT_BASE_CANDIDATES) {
    if (tryGit(["rev-parse", "--verify", "--quiet", candidate], cwd)) return candidate;
  }
  return null;
}

function parseRefs(raw: string, localNames: Set<string>): CommitRefBadge[] {
  if (!raw.trim()) return [];
  const badges: CommitRefBadge[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.startsWith("HEAD -> ")) {
      badges.push({ name: part.slice("HEAD -> ".length).trim(), kind: "head" });
    } else if (part === "HEAD") {
      badges.push({ name: "HEAD", kind: "head" });
    } else if (part.startsWith("tag: ")) {
      badges.push({ name: part.slice("tag: ".length).trim(), kind: "tag" });
    } else if (localNames.has(part)) {
      badges.push({ name: part, kind: "branch" });
    } else if (part.includes("/")) {
      if (!part.endsWith("/HEAD")) badges.push({ name: part, kind: "remote" });
    } else {
      badges.push({ name: part, kind: "branch" });
    }
  }
  return badges;
}

function readLocalBranches(cwd: string): Map<string, string[]> {
  const out = tryGit(["for-each-ref", "--format=%(objectname)\t%(refname:short)", "refs/heads"], cwd);
  const byHash = new Map<string, string[]>();
  if (!out) return byHash;
  for (const line of out.split("\n")) {
    const [hash, name] = line.split("\t");
    if (!hash || !name) continue;
    const list = byHash.get(hash) ?? [];
    list.push(name);
    byHash.set(hash, list);
  }
  return byHash;
}

// detects local branches stacked between merge-base(HEAD, defaultBranch) and HEAD.
function detectStack(
  cwd: string,
  head: string | null,
  currentBranch: string,
  defaultBranch: string | null,
  localBranches: Map<string, string[]>,
): { stack: StackBranch[]; stackHashes: Set<string> } {
  const stackHashes = new Set<string>();
  if (!head || !defaultBranch) return { stack: [], stackHashes };
  const mergeBase = tryGit(["merge-base", "HEAD", defaultBranch], cwd);
  if (!mergeBase || mergeBase === head) return { stack: [], stackHashes };

  // oldest-to-newest along first-parent lineage so stack slices order bottom-to-top
  const raw = tryGit(
    ["rev-list", "--first-parent", "--reverse", "--max-count", String(STACK_SCAN_LIMIT), `${mergeBase}..HEAD`],
    cwd,
  );
  if (!raw) return { stack: [], stackHashes };

  const lineage = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const hash of lineage) stackHashes.add(hash);

  const stack: StackBranch[] = [];
  let prevRef = defaultBranch;
  let countSincePrev = 0;

  for (const hash of lineage) {
    countSincePrev++;
    const names = localBranches.get(hash) ?? [];
    if (names.length === 0 && hash !== head) continue;
    // prefer currentBranch when multiple branch refs share HEAD
    const chosen = names.includes(currentBranch) ? currentBranch : names[0] ?? currentBranch;
    if (!chosen || chosen === "HEAD") continue;
    stack.push({
      name: chosen,
      hash,
      shortHash: hash.slice(0, 7),
      parentRef: prevRef,
      commitCount: countSincePrev,
      isHead: hash === head,
    });
    prevRef = chosen;
    countSincePrev = 0;
  }

  return { stack, stackHashes };
}

export function readGitHistory(cwd: string, activeSpec: string | null, requestedLimit = DEFAULT_LIMIT): HistoryResponse {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_LIMIT));
  const head = tryGit(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  const currentBranch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "HEAD";
  const defaultBranch = resolveDefaultBranch(cwd);
  const status = tryGit(["status", "--porcelain"], cwd) ?? "";
  const hasWorkingChanges = status.length > 0;
  const localBranches = readLocalBranches(cwd);
  const localNames = new Set<string>([...localBranches.values()].flat());
  const { stack, stackHashes } = detectStack(cwd, head, currentBranch, defaultBranch, localBranches);

  const fmt = ["%H", "%h", "%P", "%an", "%ar", "%D", "%s"].join(FIELD_SEP) + RECORD_SEP;
  const raw = tryGit(["log", `-n`, String(limit), `--format=${fmt}`], cwd) ?? "";
  const commits: HistoryCommit[] = [];

  for (const record of raw.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [hash = "", shortHash = "", parentsRaw = "", author = "", relativeDate = "", refsRaw = "", ...subjectParts] =
      trimmed.split(FIELD_SEP);
    if (!hash) continue;
    commits.push({
      hash,
      shortHash,
      parents: parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [],
      author,
      relativeDate,
      subject: subjectParts.join(FIELD_SEP).trim(),
      refs: parseRefs(refsRaw, localNames),
      onStack: stackHashes.has(hash),
    });
  }

  return { head, currentBranch, defaultBranch, hasWorkingChanges, activeSpec, stack, commits };
}
