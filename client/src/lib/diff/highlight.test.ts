import { describe, it, expect } from "vitest";
import type { DiffFile, DiffLine } from "$types";
import { highlightFile, needsFileText } from "./highlight";

const KEYWORD = "var(--syn-keyword)";

const ctx = (oldLine: number, newLine: number, content: string): DiffLine => ({ type: "context", oldLine, newLine, content });
const add = (newLine: number, content: string): DiffLine => ({ type: "addition", oldLine: null, newLine, content });
const del = (oldLine: number, content: string): DiffLine => ({ type: "deletion", oldLine, newLine: null, content });

function file(path: string, lines: DiffLine[], changeType: DiffFile["changeType"] = "modified", header = "@@ -3,2 +3,2 @@"): DiffFile {
  return { path, oldPath: null, changeType, additions: 0, deletions: 0, hunks: [{ header, lines }] };
}

// a svelte hunk that starts inside <script>, two lines below the tag.
const SVELTE_TEXT = ['<script lang="ts">', "  import x from './x';", "  let count = $state(0);", "</script>", "<p>{count}</p>"].join("\n");
const svelteHunk = () => [ctx(3, 3, "  let count = $state(0);"), ctx(4, 4, "</script>")];

describe("highlightFile", () => {
  it("seeds a mid-file hunk with the file's context so embedded script highlights", async () => {
    const f = file("App.svelte", svelteHunk());
    const { html } = await highlightFile(f, SVELTE_TEXT);
    expect(html.get(f.hunks[0]!.lines[0]!)).toContain(KEYWORD);
    // without the file text the same line reads as markup text
    const bare = await highlightFile(f, null);
    expect(bare.html.get(f.hunks[0]!.lines[0]!)).not.toContain(KEYWORD);
  });

  it("highlights old-side deletions and new-side additions separately", async () => {
    const lines = [ctx(1, 1, "const a = 1;"), del(2, "let b = 'old';"), add(2, "let b = 'new';")];
    const f = file("a.ts", lines, "modified", "@@ -1,2 +1,2 @@");
    const { html } = await highlightFile(f, null);
    expect(html.get(lines[1]!)).toContain("old");
    expect(html.get(lines[2]!)).toContain("new");
    expect(html.get(lines[0]!)).toContain(KEYWORD);
  });

  it("escapes markup inside tokens", async () => {
    const line = add(1, "const s = '<b>&';");
    const { html } = await highlightFile(file("a.ts", [line], "added", "@@ -0,0 +1 @@"), null);
    expect(html.get(line)).toContain("&lt;b&gt;&amp;");
    expect(html.get(line)).not.toContain("<b>");
  });

  it("returns nothing for files without a grammar", async () => {
    const { html } = await highlightFile(file("notes.unknownext", [add(1, "hello")], "added"), null);
    expect(html.size).toBe(0);
  });

  it("highlights oldContent separately from new content for whitespace-ignored context lines", async () => {
    const reindented: DiffLine = {
      type: "context",
      oldLine: 1,
      newLine: 2,
      content: "    const a = 1;",
      oldContent: "const a = 1;",
    };
    const blankNew: DiffLine = { type: "context", oldLine: null, newLine: 1, content: "" };
    const f = file("a.ts", [blankNew, reindented], "modified", "@@ -1,1 +1,2 @@");
    const { html, oldHtml } = await highlightFile(f, null);
    expect(html.get(reindented)).toContain("    ");
    expect(html.get(reindented)).toContain(KEYWORD);
    expect(oldHtml.get(reindented)).toContain(KEYWORD);
    expect(oldHtml.get(reindented)).not.toContain("    ");
  });

  it("carries leading shared-context grammar state into both old deletions and new additions", async () => {
    const lines = [
      ctx(1, 1, '<script lang="ts">'),
      ctx(2, 2, "  const shared = 1;"),
      del(3, "  let oldVal = 2;"),
      add(3, "  let newVal = 3;"),
      ctx(4, 4, "  const after = 4;"),
      ctx(5, 5, "</script>"),
      ctx(6, 6, "<p>{after}</p>"),
    ];
    const f = file("App.svelte", lines, "modified", "@@ -1,6 +1,6 @@");
    const { html } = await highlightFile(f, null);
    expect(html.get(lines[1]!)).toContain(KEYWORD);
    expect(html.get(lines[2]!)).toContain(KEYWORD);
    expect(html.get(lines[3]!)).toContain(KEYWORD);
    expect(html.get(lines[4]!)).toContain(KEYWORD);
    expect(html.get(lines[6]!)).not.toContain(KEYWORD);
  });

  it("highlights pure-addition hunks without old-side lines", async () => {
    const lines = [ctx(1, 1, "const a = 1;"), add(2, "const b = 2;"), ctx(2, 3, "const c = 3;")];
    const f = file("a.ts", lines, "modified", "@@ -1,2 +1,3 @@");
    const { html, oldHtml } = await highlightFile(f, null);
    expect(html.get(lines[0]!)).toContain(KEYWORD);
    expect(html.get(lines[1]!)).toContain(KEYWORD);
    expect(html.get(lines[2]!)).toContain(KEYWORD);
    expect(oldHtml.size).toBe(0);
  });

  it("retains oldHtml for whitespace-ignored context lines appearing after the last deletion", async () => {
    const reindented: DiffLine = {
      type: "context",
      oldLine: 4,
      newLine: 4,
      content: "    const after = 2;",
      oldContent: "  const after = 2;",
    };
    const lines = [
      ctx(1, 1, '<script lang="ts">'),
      del(2, "  let gone = 1;"),
      add(2, "  let kept = 1;"),
      ctx(3, 3, "  const mid = 0;"),
      reindented,
      ctx(5, 5, "</script>"),
    ];
    const f = file("App.svelte", lines, "modified", "@@ -1,5 +1,5 @@");
    const { html, oldHtml } = await highlightFile(f, null);
    expect(oldHtml.get(reindented)).toContain(KEYWORD);
    expect(oldHtml.get(reindented)).not.toContain("    ");
    expect(html.get(reindented)).toContain("    ");
    expect(html.get(reindented)).toContain(KEYWORD);
  });

  it("carries grammar state across hunks when a pure-deletion hunk precedes another hunk without file text", async () => {
    const firstHunkLine = del(1, '<script lang="ts">');
    const secondHunkLine = ctx(2, 1, "  const x = 1;");
    const f: DiffFile = {
      path: "App.svelte",
      oldPath: null,
      changeType: "modified",
      additions: 0,
      deletions: 1,
      hunks: [
        { header: "@@ -1,1 +0,0 @@", lines: [firstHunkLine] },
        { header: "@@ -2,1 +1,1 @@", lines: [secondHunkLine] },
      ],
    };
    const { html } = await highlightFile(f, null);
    expect(html.get(secondHunkLine)).toContain(KEYWORD);
  });
});

describe("needsFileText", () => {
  it("wants the file text only for modified files with mid-file hunks", () => {
    expect(needsFileText(file("App.svelte", svelteHunk()))).toBe(true);
    expect(needsFileText(file("a.ts", [add(1, "x")], "added"))).toBe(false);
    expect(needsFileText(file("a.ts", [ctx(1, 1, "x")]))).toBe(false);
  });

  it("skips the fetch when there's no grammar or the hunk is too deep to seed", () => {
    expect(needsFileText(file("notes.unknownext", svelteHunk()))).toBe(false);
    expect(needsFileText(file("gen.ts", [ctx(9001, 9001, "x")]))).toBe(false);
  });

  it("reads a pure-deletion hunk's position from its header", () => {
    expect(needsFileText(file("a.ts", [del(5, "x")], "modified", "@@ -5 +4,0 @@"))).toBe(true);
  });
});
