// resolves `nittle pr [number|url]` by querying `gh` and fetching the PR head & base into local
// refs without touching the user's working tree, HEAD, or origin branches.

import type { PrInfo } from "../types";
import { runGit } from "./git";

interface GhPrPayload {
  number: number;
  title: string;
  url: string;
  state: string;
  baseRefName: string;
  baseRefOid?: string;
  headRefName: string;
  mergeCommit?: { oid?: string } | null;
  author?: { login?: string };
}

export interface ResolvedPrTarget {
  spec: string;
  refLabel: string;
  pr: PrInfo;
}

function runGh(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["gh", ...args], { cwd });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(stderr || `gh ${args.join(" ")} failed (is GitHub CLI installed and logged in?)`);
  }
  return proc.stdout.toString();
}

function commitExists(rev: string, cwd: string): boolean {
  return Bun.spawnSync(["git", "cat-file", "-e", `${rev}^{commit}`], { cwd }).exitCode === 0;
}

function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  return Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant], { cwd }).exitCode === 0;
}

// match the remote whose fetch URL contains the PR's owner/repo (fallback: origin).
function resolveRemoteForPr(prUrl: string, cwd: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(prUrl);
  const slug = match?.[1]?.toLowerCase();
  if (!slug) return "origin";
  try {
    const lines = runGit(["remote", "-v"], cwd).split("\n");
    for (const line of lines) {
      const [name, url] = line.trim().split(/\s+/);
      if (name && url && url.toLowerCase().replace(/\.git$/, "").includes(slug)) return name;
    }
  } catch {
    // fall back to origin
  }
  return "origin";
}

export function resolvePrTarget(prArg: string | undefined, cwd: string): ResolvedPrTarget {
  const viewArgs = [
    "pr",
    "view",
    ...(prArg ? [prArg] : []),
    "--json",
    "number,title,url,author,state,baseRefName,baseRefOid,headRefName,mergeCommit",
  ];
  const parsed = JSON.parse(runGh(viewArgs, cwd)) as GhPrPayload;
  if (!parsed?.number || !parsed.baseRefName) {
    throw new Error("could not read pull request metadata from gh");
  }

  const remote = resolveRemoteForPr(parsed.url, cwd);
  const localPrRef = `refs/nittle/pr-${parsed.number}`;
  const localBaseRef = `refs/nittle/pr-${parsed.number}-base`;

  // fetch PR head + fresh remote base branch into dedicated refs without touching HEAD or origin/*
  runGit(
    [
      "fetch",
      "--quiet",
      "--force",
      remote,
      `refs/pull/${parsed.number}/head:${localPrRef}`,
      `refs/heads/${parsed.baseRefName}:${localBaseRef}`,
    ],
    cwd,
  );

  // for merged PRs, `base...head` is empty if head is now an ancestor of base (merge-commit/rebase);
  // prefer the exact pre-merge baseRefOid...head when available, else the mergeCommit diff.
  let spec = `${localBaseRef}...${localPrRef}`;
  if (parsed.state === "MERGED" || isAncestor(localPrRef, localBaseRef, cwd)) {
    const baseOid = parsed.baseRefOid;
    const mergeOid = parsed.mergeCommit?.oid;
    if (baseOid && commitExists(baseOid, cwd) && !isAncestor(localPrRef, baseOid, cwd)) {
      spec = `${baseOid}...${localPrRef}`;
    } else if (mergeOid && commitExists(mergeOid, cwd)) {
      spec = `${mergeOid}^1..${mergeOid}`;
    }
  }

  const pr: PrInfo = {
    number: parsed.number,
    title: parsed.title,
    url: parsed.url,
    author: parsed.author?.login ?? "unknown",
    state: parsed.state,
    baseRef: parsed.baseRefName,
    headRef: parsed.headRefName,
  };

  return {
    spec,
    refLabel: `PR #${pr.number} · ${pr.headRef} → ${pr.baseRef}`,
    pr,
  };
}
