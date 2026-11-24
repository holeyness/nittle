import type { DiffResult, HistoryResponse } from "$types";
import { apiGet, apiPost } from "./http";

export interface DiffRequestOpts {
  full?: boolean;
}

function diffHeaders(opts?: DiffRequestOpts): HeadersInit | undefined {
  return opts?.full ? { "X-Nittle-Full-File": "1" } : undefined;
}

// GET /api/diff → the current DiffResult; the server re-runs git diff on each call.
export function getDiff(signal?: AbortSignal, opts?: DiffRequestOpts): Promise<DiffResult> {
  return apiGet<DiffResult>("/api/diff", signal, diffHeaders(opts));
}

// GET /api/history → commits, branches, and detected stack slices.
export function getHistory(limit = 120, signal?: AbortSignal): Promise<HistoryResponse> {
  return apiGet<HistoryResponse>(`/api/history?limit=${limit}`, signal);
}

// POST /api/target → switch the active git diff target (commit, commit range, branch, or working tree).
export function switchTarget(spec: string, opts?: DiffRequestOpts, signal?: AbortSignal): Promise<DiffResult> {
  return apiPost<DiffResult>("/api/target", { spec }, signal, diffHeaders(opts));
}
