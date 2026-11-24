import type { DiffResult, DiffFile, DiffMeta } from "$types";
import { getDiff, switchTarget as switchTargetApi, type DiffRequestOpts } from "$lib/api/diff";
import { treeOrder } from "$lib/diff/tree";

// diff loading state machine. load() is the initial fetch; refresh() re-fetches
// and keeps the last good diff on failure, mirroring the server's behavior.
export type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; diff: DiffResult }
  | { status: "error"; message: string };

type Deps = {
  getDiff: (signal?: AbortSignal, opts?: DiffRequestOpts) => Promise<DiffResult>;
  switchTarget?: (spec: string, opts?: DiffRequestOpts, signal?: AbortSignal) => Promise<DiffResult>;
  full?: () => boolean;
};

const isAbort = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "AbortError";

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function createDiffStore(deps: Deps = { getDiff, switchTarget: switchTargetApi }) {
  let state = $state<DiffState>({ status: "idle" });
  let refreshFailed = $state(false);
  let refreshing = $state(false);
  let switching = $state(false);
  let switchError = $state<string | null>(null);
  let inflight: AbortController | null = null;

  const ready = $derived(state.status === "ready" ? state.diff : undefined);
  // sidebar tree order, so the diff pane and j/k walk files the way the tree lists them.
  const files = $derived<DiffFile[]>(treeOrder(ready?.files ?? []));
  const ref = $derived<string>(ready?.ref ?? "");
  const meta = $derived<DiffMeta | undefined>(ready?.meta);

  function requestOpts(): DiffRequestOpts | undefined {
    return deps.full?.() ? { full: true } : undefined;
  }

  // start a fresh request, cancelling any in-flight one; returns its signal.
  function begin(): AbortSignal {
    inflight?.abort();
    inflight = new AbortController();
    return inflight.signal;
  }

  return {
    get state(): DiffState {
      return state;
    },
    get files(): DiffFile[] {
      return files;
    },
    get ref(): string {
      return ref;
    },
    get meta(): DiffMeta | undefined {
      return meta;
    },
    get refreshFailed(): boolean {
      return refreshFailed;
    },
    get refreshing(): boolean {
      return refreshing;
    },
    get switching(): boolean {
      return switching;
    },
    get switchError(): string | null {
      return switchError;
    },
    async load(): Promise<void> {
      const signal = begin();
      state = { status: "loading" };
      refreshFailed = false;
      switchError = null;
      try {
        state = { status: "ready", diff: await deps.getDiff(signal, requestOpts()) };
      } catch (err) {
        if (isAbort(err)) return;
        state = { status: "error", message: messageOf(err) };
      }
    },
    // re-fetch; adopt on success, otherwise keep the last good diff if we have one.
    async refresh(): Promise<void> {
      const signal = begin();
      refreshing = true;
      try {
        state = { status: "ready", diff: await deps.getDiff(signal, requestOpts()) };
        refreshFailed = false;
      } catch (err) {
        if (isAbort(err)) return;
        if (state.status === "ready") {
          refreshFailed = true;
          return;
        }
        state = { status: "error", message: messageOf(err) };
      } finally {
        refreshing = false;
      }
    },
    // switch the active git comparison (commit, commit range, stack slice, or working tree).
    async switchTarget(spec: string): Promise<boolean> {
      const runSwitch = deps.switchTarget ?? switchTargetApi;
      const signal = begin();
      switching = true;
      switchError = null;
      try {
        state = { status: "ready", diff: await runSwitch(spec, requestOpts(), signal) };
        refreshFailed = false;
        return true;
      } catch (err) {
        if (isAbort(err)) return false;
        switchError = messageOf(err);
        return false;
      } finally {
        switching = false;
      }
    },
  };
}

export type DiffStore = ReturnType<typeof createDiffStore>;
