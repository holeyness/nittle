// commit history & interactive target switching for PyCharm-style multi-commit review.

import type { SwitchTargetRequest } from "../types";
import { isFullContextRequest, type ServerContext } from "./handlers";
import { loadReviewTarget } from "../core/reviewTarget";
import { FULL_FILE_CONTEXT } from "../utils/git";
import { readGitHistory } from "../utils/gitHistory";
import { apiError, json } from "./respond";

export function handleGetHistory(ctx: ServerContext, url: URL): Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number(rawLimit) : undefined;
  return json(readGitHistory(ctx.cwd, ctx.activeSpec ?? null, limit, ctx.historyTipRef ?? ctx.newRef, ctx.historyBaseRef));
}

export async function handlePostTarget(ctx: ServerContext, req: Request, url: URL): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid json body", 400);
  }
  const spec = typeof (body as Partial<SwitchTargetRequest>)?.spec === "string" ? (body as SwitchTargetRequest).spec.trim() : "";
  if (!spec) return apiError("spec must be a non-empty string", 400);

  const contextLines = isFullContextRequest(url, req) ? FULL_FILE_CONTEXT : undefined;
  try {
    const loaded = loadReviewTarget(ctx.cwd, spec, undefined, false, contextLines);
    // preserve PR metadata in the top bar while browsing commits inside a PR review
    const existingPr = ctx.meta?.pr;
    if (existingPr && loaded.meta) {
      loaded.meta = { ...loaded.meta, pr: existingPr };
      loaded.diff = { ...loaded.diff, meta: loaded.meta };
    }
    ctx.diff = loaded.diff;
    ctx.diffArgs = loaded.diffArgs;
    ctx.newRef = loaded.newRef;
    ctx.includeUntracked = loaded.includeUntracked;
    ctx.meta = loaded.meta;
    ctx.mode = loaded.mode;
    ctx.scope = loaded.scope;
    ctx.activeSpec = loaded.pinnedSpec ?? spec;
    ctx.served = true;
    ctx.diffGeneration = (ctx.diffGeneration ?? 0) + 1;
    return json(ctx.diff);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(message, 400);
  }
}
