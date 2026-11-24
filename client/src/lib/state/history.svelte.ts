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

interface PendingSelection {
  selectedHashes: string[];
  anchorIndex: number | null;
  chip: string | null;
  label: string;
}

export function createHistoryStore(deps: HistoryDeps) {
  let data = $state.raw<HistoryResponse | null>(null);
  let initialSpec = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selectedHashes = $state<string[]>([]);
  let anchorIndex = $state<number | null>(null);
  let activeChip = $state<string | null>(null); // "working" | "stack-all" | "pr-all" | `branch:${name}` | null
  let selectionLabel = $state<string | null>(null);
  let inflight: AbortController | null = null;

  const commits = $derived<HistoryCommit[]>(data?.commits ?? []);
  const stack = $derived<StackBranch[]>(data?.stack ?? []);
  const selectedSet = $derived(new Set(selectedHashes));

  // commit selection state only after switchTarget succeeds so failed/aborted switches never drift.
  async function applySpec(spec: string, next: PendingSelection): Promise<void> {
    const ok = await deps.switchTarget(spec);
    if (!ok) return;
    selectedHashes = next.selectedHashes;
    anchorIndex = next.anchorIndex;
    activeChip = next.chip;
    selectionLabel = next.label;
    deps.onSwitched?.();
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
    get initialSpec(): string | null {
      return initialSpec;
    },
    async load(limit = 120): Promise<void> {
      inflight?.abort();
      inflight = new AbortController();
      loading = true;
      error = null;
      try {
        const fetched = await deps.fetchHistory(limit, inflight.signal);
        data = fetched;
        if (!initialSpec && fetched.activeSpec) initialSpec = fetched.activeSpec;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // ignore missing history route in minimal test harnesses
        if (typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 404) return;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
    },
    async selectInitial(): Promise<void> {
      if (!initialSpec) return;
      const hashes = commits.filter((c) => c.onStack).map((c) => c.hash);
      await applySpec(initialSpec, {
        selectedHashes: hashes,
        anchorIndex: hashes.length > 0 ? 0 : null,
        chip: "pr-all",
        label: "all PR changes",
      });
    },
    async selectWorking(): Promise<void> {
      await applySpec("working", {
        selectedHashes: [],
        anchorIndex: null,
        chip: "working",
        label: "working tree",
      });
    },
    async selectStackBranch(branch: StackBranch): Promise<void> {
      const tipIdx = commits.findIndex((c) => c.hash === branch.hash);
      let hashes: string[] = [];
      let anchor: number | null = null;
      if (tipIdx >= 0) {
        const parentIdx = commits.findIndex(
          (c, i) => i > tipIdx && (!c.onStack || c.refs.some((r) => r.name === branch.parentRef)),
        );
        const endIdx = parentIdx > tipIdx ? parentIdx : Math.min(commits.length, tipIdx + branch.commitCount);
        hashes = commits.slice(tipIdx, endIdx).map((c) => c.hash);
        anchor = tipIdx;
      }
      await applySpec(`${branch.parentRef}...${branch.name}`, {
        selectedHashes: hashes,
        anchorIndex: anchor,
        chip: `branch:${branch.name}`,
        label: `${branch.name} vs ${branch.parentRef}`,
      });
    },
    async selectWholeStack(): Promise<void> {
      if (!data?.defaultBranch) return;
      const hashes = commits.filter((c) => c.onStack).map((c) => c.hash);
      await applySpec(data.defaultBranch, {
        selectedHashes: hashes,
        anchorIndex: hashes.length > 0 ? 0 : null,
        chip: "stack-all",
        label: `entire stack vs ${data.defaultBranch}`,
      });
    },
    async clickCommit(index: number, mods: ClickModifiers): Promise<void> {
      const clicked = commits[index];
      if (!clicked) return;

      let nextIndices: number[];
      let nextAnchor = anchorIndex;
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
        nextAnchor = index;
      } else {
        nextIndices = [index];
        nextAnchor = index;
      }

      const resolved = commitRangeSpec(commits, nextIndices);
      if (!resolved) return;

      const hashes = [...new Set(nextIndices)]
        .sort((a, b) => a - b)
        .map((i) => commits[i]!.hash);

      await applySpec(resolved.spec, {
        selectedHashes: hashes,
        anchorIndex: nextAnchor,
        chip: null,
        label: resolved.label,
      });
    },
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
export { getHistory };
