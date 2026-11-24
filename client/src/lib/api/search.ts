import type { SearchResponse } from "$types";
import { apiGet } from "./http";

export type SearchScope = "diff" | "repo";

// GET /api/search → hits in changed files (default) or the whole repository (scope=repo).
export function searchAllFiles(
  query: string,
  regex: boolean,
  signal?: AbortSignal,
  scope: SearchScope = "diff",
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, regex: regex ? "1" : "0" });
  if (scope === "repo") params.set("scope", "repo");
  return apiGet<SearchResponse>(`/api/search?${params}`, signal);
}
