import type { Action } from "svelte/action";

function setPaneScrollWidths(panes: HTMLElement[]): void {
  // clear --split-code-width before reading scrollWidth so panes can shrink after edits/re-renders;
  // batch writes, then reads, then writes to avoid layout thrashing.
  for (const pane of panes) {
    pane.style.removeProperty("--split-code-width");
  }
  const widths = panes.map((pane) => pane.scrollWidth);
  panes.forEach((pane, index) => {
    // short rows must span the full scroll width so their sticky gutters cannot scroll away.
    pane.style.setProperty("--split-code-width", `${widths[index]}px`);
  });
}

function clearRowHeights(panes: HTMLElement[]): void {
  for (const pane of panes) {
    for (const child of Array.from(pane.children) as HTMLElement[]) {
      if (child.style.height) child.style.height = "";
    }
  }
}

function matchRowHeights(oldRows: HTMLElement[], newRows: HTMLElement[]): void {
  // clear assigned heights before measuring; reads and writes happen in separate batches.
  for (const row of oldRows) row.style.height = "";
  for (const row of newRows) row.style.height = "";

  const heights = oldRows.map((oldRow, index) => {
    const oldHeight = oldRow.getBoundingClientRect().height;
    const newHeight = newRows[index]!.getBoundingClientRect().height;
    return Math.ceil(Math.max(oldHeight, newHeight));
  });

  for (const [index, height] of heights.entries()) {
    oldRows[index]!.style.height = `${height}px`;
    newRows[index]!.style.height = `${height}px`;
  }
}

export const alignSplitRows: Action<HTMLElement, boolean> = (node, initialWrap = false) => {
  let wrap = initialWrap;
  let hadWrappedHeights = false;
  let pendingFrame = 0;
  let disposed = false;
  const observedContent = new Set<Element>();
  const paneWidths = new WeakMap<Element, number>();

  function scheduleAlignment(): void {
    if (pendingFrame || disposed) return;
    pendingFrame = requestAnimationFrame(align);
  }

  // observe natural content sizes (.split-pane widths and .comment-box heights), not assigned
  // row or slot heights, to avoid resize feedback loops.
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const isPane = entry.target.classList.contains("split-pane");
      const widthChanged = paneWidths.get(entry.target) !== entry.contentRect.width;
      if (!isPane || widthChanged) {
        scheduleAlignment();
      }
      paneWidths.set(entry.target, entry.contentRect.width);
    }
  });

  function updateObservedContent(): void {
    const currentContent = new Set(node.querySelectorAll(".split-pane, .comment-box"));
    for (const element of observedContent) {
      if (currentContent.has(element)) continue;
      resizeObserver.unobserve(element);
      observedContent.delete(element);
    }
    for (const element of currentContent) {
      if (observedContent.has(element)) continue;
      resizeObserver.observe(element);
      observedContent.add(element);
    }
  }

  function align(): void {
    pendingFrame = 0;
    const panes = Array.from(node.querySelectorAll<HTMLElement>(".split-pane"));
    if (panes.length !== 2) return;
    const [oldPane, newPane] = panes as [HTMLElement, HTMLElement];

    updateObservedContent();

    if (wrap) {
      const oldRows = Array.from(oldPane.children) as HTMLElement[];
      const newRows = Array.from(newPane.children) as HTMLElement[];
      if (oldRows.length === newRows.length) {
        matchRowHeights(oldRows, newRows);
        hadWrappedHeights = true;
      }
      return;
    }

    if (hadWrappedHeights) {
      clearRowHeights(panes);
      hadWrappedHeights = false;
    }
    setPaneScrollWidths(panes);

    // unwrapped code rows share a fixed CSS height; only paired comment slots can vary in height.
    const oldComments = Array.from(oldPane.querySelectorAll<HTMLElement>(".split-comment-slot"));
    if (oldComments.length > 0) {
      const newComments = Array.from(newPane.querySelectorAll<HTMLElement>(".split-comment-slot"));
      if (oldComments.length === newComments.length) {
        matchRowHeights(oldComments, newComments);
      }
    }
  }

  const mutationObserver = new MutationObserver(scheduleAlignment);
  mutationObserver.observe(node, { subtree: true, childList: true, characterData: true });
  void document.fonts?.ready.then(scheduleAlignment);
  scheduleAlignment();

  return {
    update(nextWrap: boolean): void {
      if (nextWrap === wrap) return;
      wrap = nextWrap;
      scheduleAlignment();
    },
    destroy(): void {
      disposed = true;
      cancelAnimationFrame(pendingFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    },
  };
};
