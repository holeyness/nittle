// cross-file & whole-repo search (g/ and Cmd+Shift+F): debounced fetch of /api/search
// with scope switching between changed files and the entire repository.

import type { SearchHit } from "$types";
import { searchAllFiles, type SearchScope } from "$lib/api/search";

export const SEARCH_DEBOUNCE_MS = 200;

export type SearchAllStatus = "idle" | "loading" | "ready" | "error";

export interface SearchAllDeps {
  jump: (hit: SearchHit) => void;
  fetchHits?: (query: string, regex: boolean, signal?: AbortSignal, scope?: SearchScope) => Promise<{ results: SearchHit[]; truncated: boolean }>;
  debounceMs?: number;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

export function createSearchAllStore(deps: SearchAllDeps) {
  const fetchHits = deps.fetchHits ?? searchAllFiles;
  const debounceMs = deps.debounceMs ?? SEARCH_DEBOUNCE_MS;
  let open = $state(false);
  let query = $state("");
  let regex = $state(false);
  let scope = $state<SearchScope>("diff");
  let status = $state<SearchAllStatus>("idle");
  let hits = $state.raw<SearchHit[]>([]);
  let truncated = $state(false);
  let error = $state<string | null>(null);
  let selected = $state(0);
  let focusSeq = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;

  function cancel(): void {
    clearTimeout(timer);
    inflight?.abort();
    inflight = undefined;
  }

  function reset(): void {
    hits = [];
    truncated = false;
    error = null;
    selected = 0;
    status = "idle";
  }

  async function run(): Promise<void> {
    cancel();
    if (query.trim() === "") return reset();
    const controller = new AbortController();
    inflight = controller;
    status = "loading";
    try {
      const response = await fetchHits(query, regex, controller.signal, scope);
      if (inflight !== controller) return;
      hits = response.results;
      truncated = response.truncated;
      error = null;
      selected = 0;
      status = "ready";
    } catch (e) {
      if (inflight !== controller || isAbort(e)) return;
      hits = [];
      truncated = false;
      selected = 0;
      error = e instanceof Error ? e.message : "search failed";
      status = "error";
    }
  }

  function schedule(): void {
    cancel();
    if (query.trim() === "") return reset();
    // old hits answer an old query: drop them so Enter cannot jump to one
    hits = [];
    truncated = false;
    error = null;
    selected = 0;
    status = "loading";
    timer = setTimeout(() => void run(), debounceMs);
  }

  return {
    get open(): boolean {
      return open;
    },
    get query(): string {
      return query;
    },
    get regex(): boolean {
      return regex;
    },
    get scope(): SearchScope {
      return scope;
    },
    get status(): SearchAllStatus {
      return status;
    },
    get hits(): SearchHit[] {
      return hits;
    },
    get truncated(): boolean {
      return truncated;
    },
    get error(): string | null {
      return error;
    },
    get selected(): number {
      return selected;
    },
    get focusSeq(): number {
      return focusSeq;
    },

    // open the panel with the last query still in place; optionally switch scope ("diff" | "repo")
    start(nextScope?: SearchScope): void {
      const scopeChanged = nextScope !== undefined && nextScope !== scope;
      if (nextScope) scope = nextScope;
      open = true;
      focusSeq++;
      if ((status === "idle" || scopeChanged) && query.trim() !== "") schedule();
    },
    setScope(next: SearchScope): void {
      if (scope === next) return;
      scope = next;
      if (query.trim() !== "") schedule();
      else reset();
    },
    setQuery(next: string): void {
      query = next;
      schedule();
    },
    toggleRegex(): void {
      regex = !regex;
      schedule();
    },
    move(delta: number): void {
      if (hits.length === 0) return;
      selected = Math.max(0, Math.min(hits.length - 1, selected + delta));
    },
    select(index: number): void {
      if (index >= 0 && index < hits.length) selected = index;
    },
    // jump to the selected hit; the panel stays open so the next one is a keypress away
    activate(index = selected): void {
      const hit = hits[index];
      if (!hit) return;
      selected = index;
      deps.jump(hit);
    },
    close(): void {
      cancel();
      open = false;
      if (status === "loading") status = "idle";
    },
  };
}

export type SearchAllStore = ReturnType<typeof createSearchAllStore>;
