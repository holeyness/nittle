<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import Layers from "@lucide/svelte/icons/layers";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { getAppState } from "$lib/state/context";
  import type { CommitRefBadge } from "$types";

  const { history, diff, prefs } = getAppState();

  function badgeClass(badge: CommitRefBadge): string {
    if (badge.kind === "head") return "bg-accent/15 text-accent border-accent/40";
    if (badge.kind === "branch") return "bg-add-bg text-add-text border-add-text/30";
    if (badge.kind === "tag") return "bg-surface-2 text-text border-border";
    return "bg-surface-2 text-dim border-border/70";
  }

  function shortBranchLabel(name: string): string {
    const slash = name.indexOf("/");
    return slash >= 0 && name.length > 22 ? name.slice(slash + 1) : name;
  }

  // strip any shared prefix across 2+ stack branches (e.g. "ian/commitment-alert-")
  // so every slice pill stays distinguishable without mid-word truncation.
  const stackPrefix = $derived.by(() => {
    const names = history.stack.map((b) => b.name);
    if (names.length < 2) return "";
    let prefix = names[0]!;
    for (const name of names.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
      prefix = prefix.slice(0, i);
    }
    // snap back to the last separator ("/" or "-" or "_") so we never slice mid-word
    const cut = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("-"), prefix.lastIndexOf("_"));
    const snapped = cut >= 0 ? prefix.slice(0, cut + 1) : "";
    return snapped.length >= 6 && names.every((n) => n.length > snapped.length + 2) ? snapped : "";
  });

  function stackPillLabel(name: string): string {
    if (stackPrefix && name.startsWith(stackPrefix)) return name.slice(stackPrefix.length);
    return shortBranchLabel(name);
  }

  // omit redundant origin/<branch> badges when the matching local branch badge is on the same commit.
  function visibleRefs(refs: CommitRefBadge[]): CommitRefBadge[] {
    const localNames = new Set(refs.filter((r) => r.kind === "head" || r.kind === "branch").map((r) => r.name));
    return refs.filter((r) => !(r.kind === "remote" && r.name.includes("/") && localNames.has(r.name.slice(r.name.indexOf("/") + 1))));
  }

  function onCommitClick(event: MouseEvent, index: number): void {
    event.preventDefault();
    void history.clickCommit(index, {
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    });
  }
</script>

{#if history.data || history.error}
<section
  class="flex flex-col border-b border-border bg-surface {prefs.commitsOpen ? 'min-h-0 flex-1 basis-0 overflow-hidden' : 'shrink-0'}"
  data-history-panel
>
  <header class="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-semibold text-text hover:bg-surface-2"
      aria-expanded={prefs.commitsOpen}
      onclick={() => prefs.toggleCommitsOpen()}
    >
      <ChevronDown size={13} class="shrink-0 text-muted transition-transform duration-150 {prefs.commitsOpen ? '' : '-rotate-90'}" />
      <GitCommitHorizontal size={13} class="shrink-0 text-accent" />
      <span class="truncate">Commits &amp; Stack</span>
      {#if diff.switching}
        <RefreshCw size={11} class="ml-auto shrink-0 animate-spin text-accent" />
      {:else if history.selectedHashes.length > 0}
        <span class="ml-auto shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent">
          {history.selectedHashes.length} sel
        </span>
      {/if}
    </button>
    <button
      type="button"
      class="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
      title="Reload commits & branches"
      aria-label="Reload commits and branches"
      onclick={() => history.load()}
    >
      <RefreshCw size={12} class={history.loading ? "animate-spin" : ""} />
    </button>
  </header>

  {#if prefs.commitsOpen}
    {#if history.error}
      <p class="px-3 pb-2 text-xs text-destructive">{history.error}</p>
    {:else if diff.switchError}
      <p class="px-3 pb-2 text-xs text-destructive">{diff.switchError}</p>
    {/if}

    {#if history.data}
      {#if history.stack.length > 0 || history.data.hasWorkingChanges}
        <div class="flex max-h-36 shrink-0 flex-col gap-1 overflow-auto border-t border-divider/60 px-2 py-1.5">
          <div class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-dim">
            <Layers size={11} />
            <span>Stack slices</span>
          </div>
          <div class="flex flex-wrap gap-1">
            {#if history.data.hasWorkingChanges}
              <button
                type="button"
                class="rounded border px-1.5 py-0.5 font-mono text-[11px] {history.activeChip === 'working' ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-surface-2 text-text hover:border-accent/60'}"
                onclick={() => history.selectWorking()}
              >working tree</button>
            {/if}
            {#each [...history.stack].reverse() as branch (branch.name)}
              <button
                type="button"
                class="inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] {history.activeChip === `branch:${branch.name}` ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-surface-2 text-text hover:border-accent/60'}"
                title="{branch.parentRef}..{branch.name} ({branch.commitCount} {branch.commitCount === 1 ? 'commit' : 'commits'})"
                onclick={() => history.selectStackBranch(branch)}
              >
                <GitBranch size={10} class="shrink-0 opacity-70" />
                <span class="truncate">{stackPillLabel(branch.name)}</span>
                <span class="shrink-0 text-[10px] text-dim">{branch.commitCount}c</span>
              </button>
            {/each}
            {#if history.data.defaultBranch && history.stack.length > 1}
              <button
                type="button"
                class="rounded border px-1.5 py-0.5 font-mono text-[11px] {history.activeChip === 'stack-all' ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-surface-2 text-muted hover:border-accent/60 hover:text-text'}"
                title="Compare entire stack against {history.data.defaultBranch}"
                onclick={() => history.selectWholeStack()}
              >whole stack vs {history.data.defaultBranch}</button>
            {/if}
          </div>
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-auto border-t border-divider/60" role="listbox" aria-label="Commit history" aria-multiselectable="true">
        {#each history.commits as commit, i (commit.hash)}
          {@const selected = history.selectedSet.has(commit.hash)}
          {@const badges = visibleRefs(commit.refs)}
          <button
            type="button"
            role="option"
            aria-selected={selected}
            class="flex w-full select-none flex-col gap-0.5 border-b border-divider/40 px-2.5 py-1.5 text-left transition-colors {selected ? 'bg-accent/15 text-text' : 'hover:bg-surface-2/80 text-text'}"
            title="{commit.shortHash} — {commit.subject} ({commit.author}, {commit.relativeDate})"
            onclick={(e) => onCommitClick(e, i)}
          >
            <div class="flex items-center gap-1.5">
              <span
                class="size-1.5 shrink-0 rounded-full {selected ? 'bg-accent' : commit.onStack ? 'bg-add-text' : 'bg-dim/50'}"
                aria-hidden="true"
              ></span>
              <span class="shrink-0 font-mono text-[10px] text-dim">{commit.shortHash}</span>
              <span class="ml-auto shrink-0 font-mono text-[9px] text-dim">{commit.relativeDate}</span>
            </div>
            {#if badges.length > 0}
              <div class="flex flex-wrap items-center gap-1 pl-3">
                {#each badges.slice(0, 3) as badge (badge.name)}
                  <span class="max-w-full truncate rounded border px-1 py-px font-mono text-[9px] leading-tight {badgeClass(badge)}" title={badge.name}>
                    {stackPillLabel(badge.name)}
                  </span>
                {/each}
              </div>
            {/if}
            <div class="truncate pl-3 text-[11px] leading-snug {selected ? 'font-medium text-text' : 'text-muted'}">
              {commit.subject}
            </div>
          </button>
        {/each}
      </div>

      <div class="flex shrink-0 items-center justify-between gap-2 border-t border-divider/60 bg-surface-2/40 px-2.5 py-1 text-[10px] text-dim">
        {#if history.selectionLabel}
          <span class="truncate font-mono text-text" title={history.selectionLabel}>{history.selectionLabel}</span>
        {:else}
          <span class="truncate">Click commit · ⌘/⇧-click for combined diff</span>
        {/if}
      </div>
    {:else if history.loading}
      <p class="px-3 py-2 text-xs text-dim">Loading commits…</p>
    {/if}
  {/if}
</section>
{/if}
