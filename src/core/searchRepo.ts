// whole-repository text search via `git grep`, respecting .gitignore and the reviewed revision.

import type { SearchCase, SearchHit, SearchResponse } from "../types";
import { compilePattern, matchRanges, windowed } from "./search";

const MAX_REPO_RESULTS = 200;
const GIT_GREP_TIMEOUT_MS = 4000;
const MAX_LINE_BYTES = 8000;

function isCaseInsensitive(query: string, caseMode: SearchCase): boolean {
  if (caseMode === "insensitive") return true;
  if (caseMode === "sensitive") return false;
  return !/[A-Z]/.test(query);
}

// parses one `git grep -n --no-color -I` line; ref-prefixed lines look like `<ref>:<path>:<line>:<text>`.
function parseGrepLine(raw: string, hasRefPrefix: boolean): { path: string; line: number; text: string } | null {
  let rest = raw;
  if (hasRefPrefix) {
    const colon = rest.indexOf(":");
    if (colon < 0) return null;
    rest = rest.slice(colon + 1);
  }
  const first = rest.indexOf(":");
  if (first <= 0) return null;
  const second = rest.indexOf(":", first + 1);
  if (second <= first + 1) return null;
  const path = rest.slice(0, first);
  const line = Number(rest.slice(first + 1, second));
  if (!Number.isInteger(line) || line < 1) return null;
  const text = rest.slice(second + 1).replace(/\r$/, "");
  return { path, line, text };
}

export function searchRepo(
  cwd: string,
  newRef: string | null,
  diffPaths: Set<string>,
  query: string,
  isRegex: boolean,
  caseMode: SearchCase,
): SearchResponse {
  // validate pattern with the same compiler so bad regex errors stay consistent
  const pattern = compilePattern(query, isRegex, caseMode);

  const args = ["grep", "-n", "--no-color", "-I", "--max-count", "30"];
  if (isCaseInsensitive(query, caseMode)) args.push("-i");
  args.push(isRegex ? "-E" : "-F");
  args.push("-e", query);

  const rev = newRef && newRef.trim() ? newRef.trim() : null;
  if (rev) args.push(rev);

  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    timeout: GIT_GREP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });

  // git grep exits 1 when there are zero matches (not an error)
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(stderr || "repository search failed");
  }

  const stdout = proc.stdout.toString();
  if (!stdout) return { results: [], truncated: false };

  const inDiff: SearchHit[] = [];
  const other: SearchHit[] = [];
  let truncated = false;

  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const parsed = parseGrepLine(raw, rev !== null);
    if (!parsed) continue;
    const text = parsed.text.length > MAX_LINE_BYTES ? parsed.text.slice(0, MAX_LINE_BYTES) : parsed.text;
    const matches = matchRanges(pattern.regex, text);
    const { preview, ranges } = matches.length > 0 ? windowed(text, matches) : { preview: text.slice(0, 200), ranges: [] };
    const hit: SearchHit = { path: parsed.path, side: "new", line: parsed.line, preview, ranges };

    if (diffPaths.has(parsed.path)) {
      inDiff.push(hit);
    } else {
      other.push(hit);
    }
    if (inDiff.length + other.length >= MAX_REPO_RESULTS + 50) {
      truncated = true;
      break;
    }
  }

  const combined = [...inDiff, ...other];
  if (combined.length > MAX_REPO_RESULTS) {
    truncated = true;
    return { results: combined.slice(0, MAX_REPO_RESULTS), truncated: true };
  }
  return { results: combined, truncated };
}
