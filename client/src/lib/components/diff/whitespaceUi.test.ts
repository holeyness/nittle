import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { DiffResult } from "$types";
import App from "../../../App.svelte";
import { WHATS_NEW } from "$lib/whatsNew";

const diffFixture: DiffResult = {
  ref: "feature/ws → origin/main",
  files: [
    {
      path: "a_mixed.py",
      oldPath: null,
      changeType: "modified",
      additions: 5,
      deletions: 4,
      hunks: [
        {
          header: "@@ -1,5 +1,6 @@",
          lines: [
            { type: "context", oldLine: 1, newLine: 1, content: "def f():" },
            { type: "deletion", oldLine: 2, newLine: null, content: "x = 1" },
            { type: "deletion", oldLine: 3, newLine: null, content: "  y = a + b" },
            { type: "deletion", oldLine: 4, newLine: null, content: "  keep = 1" },
            { type: "addition", oldLine: null, newLine: 2, content: "if cond:" },
            { type: "addition", oldLine: null, newLine: 3, content: "    x = 1" },
            { type: "addition", oldLine: null, newLine: 4, content: "    y = a+b" },
            { type: "addition", oldLine: null, newLine: 5, content: "" },
            { type: "addition", oldLine: null, newLine: 6, content: "    keep = 2" },
          ],
        },
      ],
    },
    {
      path: "b_wsonly.py",
      oldPath: null,
      changeType: "modified",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { type: "deletion", oldLine: 1, newLine: null, content: "only_indent = 1" },
            { type: "addition", oldLine: null, newLine: 1, content: "    only_indent = 1" },
          ],
        },
      ],
    },
    {
      path: "c_real.py",
      oldPath: null,
      changeType: "modified",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { type: "deletion", oldLine: 1, newLine: null, content: "value = 1" },
            { type: "addition", oldLine: null, newLine: 1, content: "value = 2" },
          ],
        },
      ],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  delete (Element.prototype as Partial<Element>).animate;
});

describe("IntelliJ-style ignore whitespace UI", () => {
  it("switches all 4 whitespace modes, updates highlights/banners, and skips ws-only files on Next change", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/diff") return jsonResponse(diffFixture);
        if (path === "/api/comments") return jsonResponse({ meta: { ref: "HEAD", createdAt: "", updatedAt: "" }, viewed: [], comments: [] });
        if (path === "/api/state") return jsonResponse({ seenVersion: WHATS_NEW.version });
        return jsonResponse({}, 404);
      }),
    );

    const { container } = render(App);
    const select = (await screen.findByLabelText("Ignore whitespace")) as HTMLSelectElement;
    expect(select.value).toBe("none");

    // Default ("none"): all 5 additions & 4 deletions are highlighted as 1 change block
    await waitFor(() => {
      expect(container.querySelectorAll(".split-pane-new .row-addition")).toHaveLength(5);
      expect(container.querySelectorAll(".split-pane-old .row-deletion")).toHaveLength(3);
    });

    // Switch to "trim": `x = 1` <-> `    x = 1` becomes unhighlighted context with exact old/new text
    await fireEvent.change(select, { target: { value: "trim" } });
    await waitFor(() => {
      const oldCtx = container.querySelector('.split-pane-old .row-context[data-oldline="2"] .code-inner');
      const newCtx = container.querySelector('.split-pane-new .row-context[data-newline="3"] .code-inner');
      expect(oldCtx?.textContent).toBe("x = 1");
      expect(oldCtx?.getAttribute("data-lsp-side")).toBe("old");
      expect(oldCtx?.getAttribute("data-lsp-line")).toBe("2");
      expect(newCtx?.textContent).toBe("    x = 1");
      expect(newCtx?.getAttribute("data-lsp-side")).toBe("new");
      expect(newCtx?.getAttribute("data-lsp-line")).toBe("3");
      // `y = a + b` vs `    y = a+b` is still highlighted under trim, marking only ` + ` vs `+` (not leading indent)
      expect(container.querySelector('.split-pane-new .row-addition[data-newline="4"]')).toBeTruthy();
      const trimOldMark = container.querySelector('.split-pane-old .row-deletion[data-oldline="3"] mark.wd');
      const trimNewMark = container.querySelector('.split-pane-new .row-addition[data-newline="4"] mark.wd');
      expect(trimOldMark?.textContent).toBe(" + ");
      expect(trimNewMark?.textContent).toBe("+");
    });

    // Switch to "all": `y = a + b` <-> `    y = a+b` also becomes context; blank line 5 stays highlighted
    await fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() => {
      expect(container.querySelector('.split-pane-new .row-context[data-newline="4"]')).toBeTruthy();
      expect(container.querySelector('.split-pane-new .row-addition[data-newline="5"]')).toBeTruthy();
    });

    // Switch to "all-and-empty": blank line 5 becomes unhighlighted context with empty left filler
    await fireEvent.change(select, { target: { value: "all-and-empty" } });
    await waitFor(() => {
      expect(container.querySelector('.split-pane-new .row-context[data-newline="5"]')).toBeTruthy();
      expect(container.querySelectorAll(".split-pane-new .row-addition")).toHaveLength(2); // if cond:, keep = 2
      expect(container.querySelectorAll(".split-pane-old .row-deletion")).toHaveLength(1); // keep = 1
      // `keep = 1` -> `    keep = 2` marks only `1` and `2`, not leading indentation
      expect(container.querySelector('.split-pane-old .row-deletion[data-oldline="4"] mark.wd')?.textContent).toBe("1");
      expect(container.querySelector('.split-pane-new .row-addition[data-newline="6"] mark.wd')?.textContent).toBe("2");
    });

    // Sidebar shows `ws` badge for b_wsonly.py
    expect(screen.getByTitle("Only whitespace differences")).toHaveTextContent("ws");

    // Next change steps through a_mixed.py's 2 blocks, then skips b_wsonly.py directly to c_real.py!
    const nextChangeBtn = screen.getByRole("button", { name: /Next change/i });
    await fireEvent.click(nextChangeBtn); // block 2 in a_mixed.py
    await fireEvent.click(nextChangeBtn); // skips b_wsonly.py -> lands on c_real.py
    await waitFor(() => {
      expect(container.querySelector('[data-file-path="c_real.py"]')).toBeTruthy();
    });

    // Clicking b_wsonly.py directly opens it with IntelliJ's whitespace-only banner and Show all button
    await fireEvent.click(screen.getByRole("button", { name: /b_wsonly\.py/i }));
    const banner = await waitFor(() => {
      const el = container.querySelector("[data-whitespace-only-banner]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(banner.textContent).toContain("Contents have differences only in whitespaces and empty lines");

    await fireEvent.click(screen.getByRole("button", { name: "Show all differences" }));
    await waitFor(() => {
      expect(select.value).toBe("none");
      expect(container.querySelector("[data-whitespace-only-banner]")).toBeNull();
      expect(container.querySelectorAll(".split-pane-new .row-addition")).toHaveLength(1);
    });
  });
});
