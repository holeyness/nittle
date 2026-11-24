// interactive commit & stacked-branch history store (PyCharm-style multi-commit selection).

import type { HistoryCommit, HistoryResponse, StackBranch } from "$types";
import { getHistory } from "$lib/api/diff";
import { commitRangeSpec } from "$lib/diff/changeBlocks";

export interface HistoryDeps {
  fetchHistory: (limit?: number, signal?: AbortSignal) => Promise<HistoryResponse>;
  switchTarget: (spec: string) => Promise<boolean>;
  onSwitched?: () => void;
}

export interface ClickModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export function createHistoryStore(deps: HistoryDeps) {
  let data = $state.raw<HistoryResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selectedHashes = $state<string[]>([]);
  let anchorIndex = $state<number | null>(null);
  let activeChip = $state<string | null>(null); // "working" | "stack-all" | `branch:${name}` | null
  let selectionLabel = $state<string | null>(null);
  let inflight: AbortController | null = null;

  const commits = $derived<HistoryCommit[]>(data?.commits ?? []);
  const stack = $derived<StackBranch[]>(data?.stack ?? []);
  const selectedSet = $derived(new Set(selectedHashes));

  async function applySpec(spec: string, label: string, chip: string | null): Promise<void> {
    activeChip = chip;
    selectionLabel = label;
    const ok = await deps.switchTarget(spec);
    if (ok) deps.onSwitched?.();
  }

  return {
    get data(): HistoryResponse | null {
      return data;
    },
    get commits(): HistoryCommit[] {
      return commits;
    },
    get stack(): StackBranch[] {
      return stack;
    },
    get loading(): boolean {
      return loading;
    },
    get error(): string | null {
      return error;
    },
    get selectedHashes(): string[] {
      return selectedHashes;
    },
    get selectedSet(): Set<string> {
      return selectedSet;
    },
    get activeChip(): string | null {
      return activeChip;
    },
    get selectionLabel(): string | null {
      return selectionLabel;
    },
    async load(limit = 120): Promise<void> {
      inflight?.abort();
      inflight = new AbortController();
      loading = true;
      error = null;
      try {
        data = await deps.fetchHistory(limit, inflight.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // ignore missing history route in minimal test harnesses
        if (typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 404) return;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
    },
    async selectWorking(): Promise<void> {
      selectedHashes = [];
      anchorIndex = null;
      await applySpec("working", "working tree", "working");
    },
    async selectStackBranch(branch: StackBranch): Promise<void> {
      // highlight the commits belonging to this stack slice when present in the commit list
      const tipIdx = commits.findIndex((c) => c.hash === branch.hash);
      if (tipIdx >= 0) {
        selectedHashes = commits.slice(tipIdx, tipIdx + branch.commitCount).map((c) => c.hash);
        anchorIndex = tipIdx;
      } else {
        selectedHashes = [];
        anchorIndex = null;
      }
      await applySpec(`${branch.parentRef}...${branch.name}`, `${branch.name} vs ${branch.parentRef}`, `branch:${branch.name}`);
    },
    async selectWholeStack(): Promise<void> {
      if (!data?.defaultBranch) return;
      selectedHashes = commits.filter((c) => c.onStack).map((c) => c.hash);
      anchorIndex = selectedHashes.length > 0 ? 0 : null;
      await applySpec(data.defaultBranch, `entire stack vs ${data.defaultBranch}`, "stack-all");
    },
    async clickCommit(index: number, mods: ClickModifiers): Promise<void> {
      const clicked = commits[index];
      if (!clicked) return;

      let nextIndices: number[];
      if (mods.shiftKey && anchorIndex !== null) {
        const start = Math.min(anchorIndex, index);
        const end = Math.max(anchorIndex, index);
        nextIndices = [];
        for (let i = start; i <= end; i++) nextIndices.push(i);
      } else if (mods.metaKey || mods.ctrlKey) {
        const current = commits
          .map((c, i) => (selectedSet.has(c.hash) ? i : -1))
          .filter((i) => i >= 0);
        if (current.includes(index)) {
          nextIndices = current.filter((i) => i !== index);
          if (nextIndices.length === 0) nextIndices = [index];
        } else {
          nextIndices = [...current, index];
        }
        anchorIndex = index;
      } else {
        nextIndices = [index];
        anchorIndex = index;
      }

      const resolved = commitRangeSpec(commits, nextIndices);
      if (!resolved) return;

      selectedHashes = [...new Set(nextIndices)]
        .sort((a, b) => a - b)
        .map((i) => commits[i]!.hash);

      await applySpec(resolved.spec, resolved.label, null);
    },
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
export { getHistory };
