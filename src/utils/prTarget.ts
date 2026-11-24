// resolves `nittle pr [number|url]` by querying `gh` and fetching the PR head into a local ref
// without touching the user's working tree or checked-out branch.

import type { PrInfo } from "../types";
import { runGit } from "./git";

interface GhPrPayload {
  number: number;
  title: string;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
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

function hasMergeBase(base: string, head: string, cwd: string): boolean {
  return Bun.spawnSync(["git", "merge-base", base, head], { cwd }).exitCode === 0;
}

export function resolvePrTarget(prArg: string | undefined, cwd: string): ResolvedPrTarget {
  const viewArgs = [
    "pr",
    "view",
    ...(prArg ? [prArg] : []),
    "--json",
    "number,title,url,author,state,baseRefName,headRefName",
  ];
  const raw = runGh(viewArgs, cwd);
  const parsed = JSON.parse(raw) as GhPrPayload;
  if (!parsed?.number || !parsed.baseRefName) {
    throw new Error("could not read pull request metadata from gh");
  }

  const localPrRef = `refs/nittle/pr-${parsed.number}`;
  // force-fetch the PR head into a dedicated ref; never touches HEAD or the working tree
  runGit(["fetch", "--quiet", "--force", "origin", `refs/pull/${parsed.number}/head:${localPrRef}`], cwd);

  const baseRef = `origin/${parsed.baseRefName}`;
  if (!hasMergeBase(baseRef, localPrRef, cwd)) {
    runGit(["fetch", "--quiet", "origin", `${parsed.baseRefName}:refs/remotes/${baseRef}`], cwd);
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
    spec: `${baseRef}...${localPrRef}`,
    refLabel: `PR #${pr.number} · ${pr.headRef} → ${pr.baseRef}`,
    pr,
  };
}
