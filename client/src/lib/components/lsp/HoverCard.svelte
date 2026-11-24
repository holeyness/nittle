<script lang="ts">
  import { tick } from "svelte";
  import { getAppState } from "$lib/state/context";
  import { highlightCodeBlocks } from "$lib/lsp/highlightCode";
  import Markdown from "../Markdown.svelte";

  // hover docs next to the word. Markdown sanitizes (DOMPurify); fenced code is then colored with
  // the diff's syntax theme. the card sits just below the word, or above it when the page ends.
  const { lsp } = getAppState();
  const hover = lsp.hover;
  const card = $derived(hover.card);

  const GAP_PX = 4;
  const MARGIN_PX = 8;
  const MAX_WIDTH_PX = 560;
  const MAX_HEIGHT_PX = 320;

  let el: HTMLDivElement | undefined = $state();
  let body: HTMLDivElement | undefined = $state();
  let placement = $state({ left: 0, top: 0 });

  function place(): void {
    if (!card || !el) return;
    const width = Math.min(MAX_WIDTH_PX, window.innerWidth - MARGIN_PX * 2);
    const height = el.offsetHeight;
    const left = Math.max(MARGIN_PX, Math.min(card.anchor.left, window.innerWidth - width - MARGIN_PX));
    const below = card.anchor.bottom + GAP_PX;
    const fitsBelow = below + height + MARGIN_PX <= window.innerHeight;
    placement = { left, top: fitsBelow ? below : Math.max(MARGIN_PX, card.anchor.top - GAP_PX - height) };
  }

  $effect(() => {
    if (!card || !body) return;
    const container = body;
    void tick().then(async () => {
      place();
      await highlightCodeBlocks(container);
      place();
    });
  });
</script>

{#if card}
  <div
    bind:this={el}
    role="region"
    aria-label="Hover documentation"
    data-hover-card
    class="fixed z-30 overflow-auto rounded-md border border-border bg-surface px-3 py-2 text-sm text-text shadow-xl"
    style="left:{placement.left}px;top:{placement.top}px;max-width:min({MAX_WIDTH_PX}px,calc(100vw - {MARGIN_PX * 2}px));max-height:{MAX_HEIGHT_PX}px"
    onpointerenter={() => hover.cardEnter()}
    onpointerleave={() => hover.cardLeave()}
  >
    <div bind:this={body} class="hover-doc">
      {#key card.key}<Markdown text={card.contents} />{/key}
    </div>
    <div class="mt-2 flex items-center gap-1.5 border-t border-divider pt-1.5">
      <button
        type="button"
        class="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text hover:border-accent hover:text-accent"
        onclick={() => lsp.definitionAtHit(card.hit)}
      >Go to Definition</button>
      <button
        type="button"
        class="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text hover:border-accent hover:text-accent"
        onclick={() => lsp.referencesAtHit(card.hit)}
      >Find References</button>
    </div>
  </div>
{/if}
