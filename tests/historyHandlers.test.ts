import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitHistory } from "../src/utils/gitHistory";
import { handleGetDiff } from "../src/server/handlers";
import { handleGetHistory, handlePostTarget } from "../src/server/historyHandlers";
import { loadReviewTarget } from "../src/core/reviewTarget";
import type { ServerContext } from "../src/server/handlers";
import type { DiffResult, HistoryResponse } from "../src/types";

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

describe("history & full-file diff handlers", () => {
  let dir = "";
  let c1 = "";
  let c2 = "";
  let c3 = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nittle-hist-"));
    git(["init", "-b", "main"], dir);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "app.py"), lines.join("\n") + "\n");
    git(["add", "."], dir);
    git(["commit", "-m", "initial"], dir);

    git(["checkout", "-b", "stack-1"], dir);
    lines[2] = "line 3 edited in stack-1";
    writeFileSync(join(dir, "app.py"), lines.join("\n") + "\n");
    git(["commit", "-am", "stack-1 change"], dir);
    c1 = git(["rev-parse", "HEAD"], dir);

    git(["checkout", "-b", "stack-2"], dir);
    lines[15] = "line 16 edited in stack-2a";
    writeFileSync(join(dir, "app.py"), lines.join("\n") + "\n");
    git(["commit", "-am", "stack-2 first"], dir);
    c2 = git(["rev-parse", "HEAD"], dir);

    lines[25] = "line 26 edited in stack-2b";
    writeFileSync(join(dir, "app.py"), lines.join("\n") + "\n");
    git(["commit", "-am", "stack-2 second"], dir);
    c3 = git(["rev-parse", "HEAD"], dir);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("detects stacked branches and commits in order", () => {
    const history = readGitHistory(dir, "stack-1..HEAD");
    expect(history.currentBranch).toBe("stack-2");
    expect(history.defaultBranch).toBe("main");
    expect(history.stack.map((b) => [b.name, b.parentRef, b.commitCount])).toEqual([
      ["stack-1", "main", 1],
      ["stack-2", "stack-1", 2],
    ]);
    expect(history.commits[0]?.hash).toBe(c3);
    expect(history.commits[0]?.onStack).toBe(true);
    expect(history.commits[3]?.onStack).toBe(false);
  });

  it("serves full-file diffs with ?full=1 and switches targets via POST /api/target", async () => {
    const loaded = loadReviewTarget(dir, "stack-1..HEAD", undefined, false);
    const ctx: ServerContext = {
      ...loaded,
      cwd: dir,
      assets: { read: () => null },
      productRoot: dir,
      served: false,
      activeSpec: "stack-1..HEAD",
      host: "cli",
    };

    // ?full=1 returns the entire 30-line file in 1 hunk
    const fullRes = handleGetDiff(ctx, new URL("http://127.0.0.1/api/diff?full=1"));
    const fullDiff = (await fullRes.json()) as DiffResult;
    expect(fullDiff.files).toHaveLength(1);
    expect(fullDiff.files[0]!.hunks).toHaveLength(1);
    expect(fullDiff.files[0]!.hunks[0]!.lines.length).toBeGreaterThanOrEqual(30);

    // switch target to single commit c1^!
    const switchReq = new Request("http://127.0.0.1/api/target?full=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: `${c1}^!` }),
    });
    const switchRes = await handlePostTarget(ctx, switchReq, new URL(switchReq.url));
    expect(switchRes.status).toBe(200);
    const singleDiff = (await switchRes.json()) as DiffResult;
    expect(singleDiff.meta?.mode).toBe("commit");
    expect(singleDiff.meta?.commit?.hash).toBe(c1);
    expect(singleDiff.files[0]!.additions).toBe(1);

    // switch target to combined multi-commit range c2^..c3
    const multiReq = new Request("http://127.0.0.1/api/target?full=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: `${c2}^..${c3}` }),
    });
    const multiRes = await handlePostTarget(ctx, multiReq, new URL(multiReq.url));
    expect(multiRes.status).toBe(200);
    const multiDiff = (await multiRes.json()) as DiffResult;
    expect(multiDiff.files[0]!.additions).toBe(2);

    // history endpoint reflects updated activeSpec
    const histRes = handleGetHistory(ctx, new URL("http://127.0.0.1/api/history"));
    const hist = (await histRes.json()) as HistoryResponse;
    expect(hist.activeSpec).toBe(`${c2}^..${c3}`);
  });

  it("uses three-dot merge-base diff for stack slices so newer main commits are excluded", async () => {
    // advance main independently after stack-1 forked
    git(["checkout", "main"], dir);
    writeFileSync(join(dir, "unrelated.py"), "only on main\n");
    git(["add", "unrelated.py"], dir);
    git(["commit", "-m", "unrelated main commit"], dir);
    git(["checkout", "stack-2"], dir);

    const loaded = loadReviewTarget(dir, "main...stack-1", undefined, false);
    expect(loaded.diff.files.map((f) => f.path)).toEqual(["app.py"]);
  });

  it("searches the whole repository via scope=repo", async () => {
    const { handleGetSearch } = await import("../src/server/searchHandlers");
    writeFileSync(join(dir, "unchanged.py"), "def global_needle():\n    return 42\n");
    git(["add", "unchanged.py"], dir);
    git(["commit", "-m", "add unchanged file"], dir);
    // diff only touches app.py (stack-1..stack-2^), while unchanged.py is outside that diff
    const loaded = loadReviewTarget(dir, `${c1}..${c2}`, undefined, false);
    const ctx: ServerContext = {
      ...loaded,
      cwd: dir,
      assets: { read: () => null },
      productRoot: dir,
      served: true,
      host: "cli",
    };
    // switch to HEAD so unchanged.py exists in newRef
    ctx.newRef = "HEAD";
    const res = await handleGetSearch(ctx, new URL("http://127.0.0.1/api/search?q=global_needle&scope=repo"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { path: string; line: number }[]; truncated: boolean };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ path: "unchanged.py", line: 1 });
  });
});
