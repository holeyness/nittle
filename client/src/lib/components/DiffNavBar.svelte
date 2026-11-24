<script lang="ts">
  import { tick } from "svelte";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Columns2 from "@lucide/svelte/icons/columns-2";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Pilcrow from "@lucide/svelte/icons/pilcrow";
  import Rows3 from "@lucide/svelte/icons/rows-3";
  import { getAppState } from "$lib/state/context";
  import { useOrderedFiles } from "$lib/state/orderedFiles.svelte";
  import { changeBlocksOf, type ChangeBlock } from "$lib/diff/changeBlocks";
  import { IGNORE_WHITESPACE_OPTIONS, isIgnoreWhitespace } from "$lib/diff/whitespace";
  import { isEditable } from "$lib/keymap/editable";
  import type { DiffFile } from "$types";

  const { diff, ui, prefs, cursor, lsp, search, searchAll } = getAppState();
  const ordered = useOrderedFiles();

  const files = $derived(ordered.files);
  const activeIndex = $derived.by(() => {
    if (files.length === 0) return -1;
    const idx = ui.activeFile ? files.findIndex((f) => f.path === ui.activeFile) : 0;
    return idx >= 0 ? idx : 0;
  });
  const activeFile = $derived<DiffFile | null>(activeIndex >= 0 ? files[activeIndex]! : null);
  const blocks = $derived<ChangeBlock[]>(activeFile ? changeBlocksOf(activeFile) : []);

  let activeBlockIdx = $state(0);
  let lastAutoScrolledKey = "";

  function scrollToBlock(path: string, block: ChangeBlock, moveCursor = true): void {
    const placed = moveCursor && cursor.placeAt(path, block.side, block.line);
    // when cursor.placeAt succeeds, DiffView's revealCursor already scrolls the row into view.
    if (placed) return;
    void tick().then(() => {
      const section = document.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(path)}"]`);
      if (!section) return;
      const primaryAttr = block.side === "new" ? "data-newline" : "data-oldline";
      const row =
        section.querySelector<HTMLElement>(`.diff-row[${primaryAttr}="${block.line}"]`) ??
        (block.newLine != null ? section.querySelector<HTMLElement>(`.diff-row[data-newline="${block.newLine}"]`) : null) ??
        (block.oldLine != null ? section.querySelector<HTMLElement>(`.diff-row[data-oldline="${block.oldLine}"]`) : null);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function autoScrollKey(path: string, blockCount: number): string {
    return `${diff.ref}\0${path}\0${prefs.fullFile ? "full" : "hunk"}\0${prefs.fileView}\0${prefs.ignoreWhitespace}\0${blockCount}`;
  }

  // when opening a file in full-file + single-file mode, land directly on its first change block.
  $effect(() => {
    const file = activeFile;
    const list = blocks;
    const full = prefs.fullFile;
    const single = prefs.fileView === "single";
    if (!file) return;
    const key = autoScrollKey(file.path, list.length);
    if (key === lastAutoScrolledKey) return;
    lastAutoScrolledKey = key;
    activeBlockIdx = 0;
    if (full && single && list.length > 0) {
      const first = list[0]!;
      // small delay lets SplitDiff finish mounting its rows before scrolling to the first change
      void tick().then(() => requestAnimationFrame(() => scrollToBlock(file.path, first, false)));
    }
  });

  function selectFileByIndex(nextIdx: number, jumpTo: "first" | "last" = "first"): void {
    const target = files[nextIdx];
    if (!target) return;
    ui.requestOpen(target.path);
    ui.selectFile(target.path);
    const targetBlocks = changeBlocksOf(target);
    const idx = targetBlocks.length === 0 ? 0 : jumpTo === "last" ? targetBlocks.length - 1 : 0;
    activeBlockIdx = idx;
    lastAutoScrolledKey = autoScrollKey(target.path, targetBlocks.length);
    const block = targetBlocks[idx];
    if (block) {
      void tick().then(() => requestAnimationFrame(() => scrollToBlock(target.path, block)));
    }
  }

  function prevFile(): void {
    if (activeIndex > 0) selectFileByIndex(activeIndex - 1, "first");
  }

  function nextFile(): void {
    if (activeIndex >= 0 && activeIndex < files.length - 1) selectFileByIndex(activeIndex + 1, "first");
  }

  function blockLine(block: ChangeBlock, side: "old" | "new"): number {
    return (side === "new" ? block.newLine : block.oldLine) ?? block.line;
  }

  function findFileWithChanges(fromIndex: number, step: 1 | -1): number {
    for (let i = fromIndex + step; i >= 0 && i < files.length; i += step) {
      const f = files[i]!;
      if (f.additions > 0 || f.deletions > 0) return i;
    }
    return -1;
  }

  const prevChangedFile = $derived(activeIndex > 0 ? findFileWithChanges(activeIndex, -1) : -1);
  const nextChangedFile = $derived(activeIndex >= 0 ? findFileWithChanges(activeIndex, 1) : -1);

  function nextChange(): void {
    if (!activeFile) return;
    const pos = cursor.pos?.path === activeFile.path && cursor.pos.line > 0 ? cursor.pos : null;
    if (blocks.length > 0) {
      const nextIdx = pos
        ? blocks.findIndex((b) => blockLine(b, pos.side) > pos.line)
        : activeBlockIdx < blocks.length - 1
          ? activeBlockIdx + 1
          : -1;
      if (nextIdx >= 0) {
        activeBlockIdx = nextIdx;
        scrollToBlock(activeFile.path, blocks[nextIdx]!);
        return;
      }
    }
    if (nextChangedFile >= 0) {
      selectFileByIndex(nextChangedFile, "first");
    } else if (blocks.length > 0) {
      activeBlockIdx = blocks.length - 1;
      scrollToBlock(activeFile.path, blocks[blocks.length - 1]!);
    }
  }

  function prevChange(): void {
    if (!activeFile) return;
    const pos = cursor.pos?.path === activeFile.path && cursor.pos.line > 0 ? cursor.pos : null;
    if (blocks.length > 0) {
      let prevIdx = -1;
      if (pos) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blockLine(blocks[i]!, pos.side) < pos.line) {
            prevIdx = i;
            break;
          }
        }
      } else if (activeBlockIdx > 0) {
        prevIdx = activeBlockIdx - 1;
      }
      if (prevIdx >= 0) {
        activeBlockIdx = prevIdx;
        scrollToBlock(activeFile.path, blocks[prevIdx]!);
        return;
      }
    }
    if (prevChangedFile >= 0) {
      selectFileByIndex(prevChangedFile, "last");
    } else if (blocks.length > 0) {
      activeBlockIdx = 0;
      scrollToBlock(activeFile.path, blocks[0]!);
    }
  }

  function onWhitespaceChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isIgnoreWhitespace(value)) prefs.setIgnoreWhitespace(value);
  }

  function toggleFullFile(): void {
    prefs.toggleFullFile();
    void diff.refresh();
  }

  function onShortcut(event: KeyboardEvent): void {
    if (ui.activeOverlay) return;

    // Cmd+Shift+F / Ctrl+Shift+F: global repository search (works even from read-only viewer)
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      search.close();
      lsp.references.close();
      searchAll.start("repo");
      return;
    }

    // PyCharm-style Back / Forward (Opt+Cmd+Left / Opt+Cmd+Right), works in diff & read-only viewer
    if (event.altKey && event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (!lsp.navBack()) cursor.back(activeFile?.path);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!lsp.navForward()) cursor.forward(activeFile?.path);
        return;
      }
    }

    if (isEditable(event.target) || lsp.viewer) return;

    // PyCharm F7 / Shift+F7 for next/prev change
    if (event.key === "F7" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey) prevChange();
      else nextChange();
      return;
    }

    // Option + Arrow keys: Up/Down = Prev/Next Change, Left/Right = Prev/Next File
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        nextChange();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        prevChange();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        nextFile();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prevFile();
      }
    }
  }

  const canPrevFile = $derived(activeIndex > 0);
  const canNextFile = $derived(activeIndex >= 0 && activeIndex < files.length - 1);
  const canPrevChange = $derived(activeBlockIdx > 0 || prevChangedFile >= 0);
  const canNextChange = $derived((blocks.length > 0 && activeBlockIdx < blocks.length - 1) || nextChangedFile >= 0);
  const ignoringWhitespace = $derived(prefs.ignoreWhitespace !== "none");
</script>

<svelte:window onkeydown={onShortcut} />

<div
  class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-divider bg-surface px-3 py-1.5 text-xs"
  data-diff-nav-bar
>
  <div class="flex items-center gap-0.5" role="group" aria-label="Jump history">
    <button
      type="button"
      class="inline-flex items-center rounded border border-border bg-surface-2 p-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-35"
      disabled={!lsp.canGoBack}
      aria-label="Jump back"
      title="Jump back (⌥⌘← / Ctrl+o / browser Back)"
      onclick={() => {
        if (!lsp.navBack()) cursor.back(activeFile?.path);
      }}
    >
      <ChevronLeft size={14} />
    </button>
    <button
      type="button"
      class="inline-flex items-center rounded border border-border bg-surface-2 p-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-35"
      disabled={!lsp.canGoForward}
      aria-label="Jump forward"
      title="Jump forward (⌥⌘→ / Ctrl+i / browser Forward)"
      onclick={() => {
        if (!lsp.navForward()) cursor.forward(activeFile?.path);
      }}
    >
      <ChevronRight size={14} />
    </button>
  </div>

  <div class="h-4 w-px bg-divider" aria-hidden="true"></div>

  <div class="flex items-center gap-1" role="group" aria-label="File navigation">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canPrevFile}
      title="Previous file (⌥←)"
      onclick={prevFile}
    >
      <ArrowLeft size={13} />
      <span>Prev file</span>
      <kbd class="hidden font-mono text-[10px] text-dim sm:inline">⌥←</kbd>
    </button>
    <span class="min-w-[3rem] text-center font-mono text-[11px] text-muted" title="Current file">
      {files.length > 0 ? `${activeIndex + 1} / ${files.length}` : "0 / 0"}
    </span>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canNextFile}
      title="Next file (⌥→)"
      onclick={nextFile}
    >
      <span>Next file</span>
      <kbd class="hidden font-mono text-[10px] text-dim sm:inline">⌥→</kbd>
      <ArrowRight size={13} />
    </button>
  </div>

  <div class="h-4 w-px bg-divider" aria-hidden="true"></div>

  <div class="flex items-center gap-1" role="group" aria-label="Change navigation">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canPrevChange}
      title="Previous change (⌥↑ or Shift+F7)"
      onclick={prevChange}
    >
      <ArrowUp size={13} />
      <span>Prev change</span>
      <kbd class="hidden font-mono text-[10px] text-dim sm:inline">⌥↑</kbd>
    </button>
    <span class="min-w-[4.2rem] text-center font-mono text-[11px] text-muted" title="Change blocks in this file">
      {blocks.length > 0 ? `${Math.min(activeBlockIdx + 1, blocks.length)} / ${blocks.length} chg` : "0 chg"}
    </span>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!canNextChange}
      title="Next change (⌥↓ or F7)"
      onclick={nextChange}
    >
      <span>Next change</span>
      <kbd class="hidden font-mono text-[10px] text-dim sm:inline">⌥↓</kbd>
      <ArrowDown size={13} />
    </button>
  </div>

  <div class="ml-auto flex flex-wrap items-center gap-1.5">
    <label
      class="inline-flex items-center gap-1 rounded border px-2 py-1 font-medium {ignoringWhitespace ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border bg-surface-2 text-muted hover:text-text'}"
      title="Whitespace ignore policy (IntelliJ style)"
    >
      <Pilcrow size={13} class="shrink-0" aria-hidden="true" />
      <select
        class="cursor-pointer bg-transparent text-xs font-medium text-inherit outline-none"
        aria-label="Ignore whitespace"
        data-ignore-whitespace
        value={prefs.ignoreWhitespace}
        onchange={onWhitespaceChange}
      >
        {#each IGNORE_WHITESPACE_OPTIONS as option (option.value)}
          <option class="bg-surface text-text" value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border px-2 py-1 font-medium {prefs.fullFile ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border bg-surface-2 text-muted hover:text-text'}"
      aria-pressed={prefs.fullFile}
      title="Show entire file with all unchanged lines (PyCharm style)"
      onclick={toggleFullFile}
    >
      <FileCode size={13} />
      <span>{prefs.fullFile ? "Full file" : "Hunks only"}</span>
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border px-2 py-1 font-medium {prefs.split ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border bg-surface-2 text-muted hover:text-text'}"
      aria-pressed={prefs.split}
      title="Toggle side-by-side vs unified diff"
      onclick={() => prefs.toggleSplit()}
    >
      <Columns2 size={13} />
      <span>{prefs.split ? "Side-by-side" : "Unified"}</span>
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border px-2 py-1 font-medium {prefs.fileView === 'single' ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border bg-surface-2 text-muted hover:text-text'}"
      aria-pressed={prefs.fileView === "single"}
      title="Show one file at a time vs all files stacked"
      onclick={() => prefs.setFileView(prefs.fileView === "single" ? "all" : "single")}
    >
      <Rows3 size={13} />
      <span>{prefs.fileView === "single" ? "Single file" : "All files"}</span>
    </button>
  </div>
</div>
