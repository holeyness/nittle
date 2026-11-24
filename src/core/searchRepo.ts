// async whole-repository text search via `git grep -z`, respecting .gitignore and the active revision.

import type { SearchCase, SearchHit, SearchResponse } from "../types";
import { compilePattern, isCaseInsensitive, matchRanges, windowed } from "./search";

const MAX_REPO_RESULTS = 200;
const GIT_GREP_TIMEOUT_MS = 4000;
const MAX_LINE_BYTES = 8000;

// parses one `git grep -z -n --no-color -I` line:
// without ref: `<path>\0<line>\0<text>`; with ref: `<ref>:<path>\0<line>\0<text>`.
function parseNullGrepLine(raw: string, rev: string | null): { path: string; line: number; text: string } | null {
  const parts = raw.split("\0");
  let path = parts[0];
  const lineStr = parts[1];
  if (!path || !lineStr) return null;
  if (rev !== null) {
    const prefix = `${rev}:`;
    if (!path.startsWith(prefix)) return null;
    path = path.slice(prefix.length);
  }
  const line = Number(lineStr);
  if (!path || !Number.isInteger(line) || line < 1) return null;
  const text = parts.slice(2).join("\0").replace(/\r$/, "");
  return { path, line, text };
}

export async function searchRepo(
  cwd: string,
  newRef: string | null,
  diffPaths: Set<string>,
  query: string,
  isRegex: boolean,
  caseMode: SearchCase,
): Promise<SearchResponse> {
  // validate pattern with the same compiler so bad regex errors stay consistent
  const pattern = compilePattern(query, isRegex, caseMode);

  const args = ["grep", "-z", "-n", "--no-color", "-I", "--max-count", "30"];
  if (isCaseInsensitive(query, caseMode, isRegex)) args.push("-i");
  args.push(isRegex ? "-E" : "-F");

  const isStaged = newRef === "";
  const rev = newRef && newRef.trim() ? newRef.trim() : null;
  if (isStaged) args.push("--cached");
  args.push("-e", query);
  if (rev) args.push(rev);

  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, GIT_GREP_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  // git grep exits 1 when there are zero matches (not an error)
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(stderr.trim() || "repository search failed");
  }
  if (!stdout) return { results: [], truncated: false };

  const inDiff: SearchHit[] = [];
  const other: SearchHit[] = [];
  let truncated = false;

  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const parsed = parseNullGrepLine(raw, rev);
    if (!parsed) continue;
    const isInDiff = diffPaths.has(parsed.path);
    // keep collecting inDiff hits even after non-diff hits fill the cap
    if (!isInDiff && other.length >= MAX_REPO_RESULTS) {
      truncated = true;
      continue;
    }
    if (isInDiff && inDiff.length >= MAX_REPO_RESULTS) {
      truncated = true;
      continue;
    }
    const text = parsed.text.length > MAX_LINE_BYTES ? parsed.text.slice(0, MAX_LINE_BYTES) : parsed.text;
    const matches = matchRanges(pattern.regex, text);
    const { preview, ranges } = matches.length > 0 ? windowed(text, matches) : { preview: text.slice(0, 200), ranges: [] };
    const hit: SearchHit = { path: parsed.path, side: "new", line: parsed.line, preview, ranges };
    if (isInDiff) inDiff.push(hit);
    else other.push(hit);
  }

  const combined = [...inDiff, ...other];
  if (combined.length > MAX_REPO_RESULTS) {
    return { results: combined.slice(0, MAX_REPO_RESULTS), truncated: true };
  }
  return { results: combined, truncated };
}
