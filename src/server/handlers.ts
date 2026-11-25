// route handlers + the in-memory server context. all /api responses are json.

import type { DiffResult, DiffMeta, ReviewFile, Comment, CompilePromptResponse } from "../types";
import type { AssetSource } from "./assetSource";
import type { SessionHost } from "../core/sessions";
import type { LspHandle } from "../core/lsp/pool";
import { readReview, writeReview } from "../core/reviewStore";
import { excludeReviewFile } from "../core/reviewFilter";
import { compileReviewPrompt } from "../core/promptCompiler";
import { badgeUpdateStatus } from "../core/updateNotice";
import { scanProject } from "../core/projectScan";
import { buildDiff } from "../core/reviewTarget";
import { FULL_FILE_CONTEXT } from "../utils/git";
import { apiError, json } from "./respond";
import { readReviewRecord, updateReviewRecord } from "../core/reviewRecords";
import { mergeReviewerComments } from "../core/commentMerge";
import type { Presence } from "./presence";

export interface ServerContext {
  diff: DiffResult; // seeded at launch, re-run on each GET /api/diff for live review
  cwd: string; // directory where the .review file lives
  assets: AssetSource; // source for the built client (index.html + assets)
  productRoot: string; // nittle's own repo root, for the release-update check
  newRef: string | null; // ref for new-side file content; null = read working tree from disk
  diffGeneration?: number; // bumped each time diff is replaced; lsp answers computed under an older one are stale
  diffArgs: string[]; // git args to re-run the diff on demand (refresh)
  includeUntracked: boolean; // working-tree mode also surfaces untracked files
  meta?: DiffMeta; // stable review context (repo + refs); reused across refreshes
  mode?: "diff" | "browse"; // browse re-scans the codebase on refresh instead of re-diffing
  scope?: string; // browse path scope, reused on refresh
  served: boolean; // true once the launch-computed diff has been handed to the client
  diffFull?: boolean; // whether ctx.diff was computed with FULL_FILE_CONTEXT
  activeSpec?: string; // current ref spec (updated when switching commits/branches in the UI)
  historyTipRef?: string | null; // stable tip ref for the commit sidebar (e.g. a PR ref when launched via `nittle pr`)
  historyBaseRef?: string | null; // stable base ref for stack/PR commit highlighting
  reviewId?: string; // durable Review Record selected by the MCP/CLI integration
  host: SessionHost; // which integration launched this server; read by /api/session/stop
  sessionId?: string; // this server's session registry id; set by reviewLaunch, checked by /api/session/stop
  presence?: Presence; // open browser tabs; `--wait` watches it to notice the last tab closing
  exitCodeOnStop?: () => number; // `--wait` sets this so a remote stop exits non-zero instead of looking like approval
  lsp?: LspHandle; // language server pool; absent in tests that don't exercise it
  shutdown?: () => void | Promise<void>; // set by reviewLaunch once the server exists; mutable by design
}

// stamps a legacy review and persists it outside the rendered diff.
function saveReview(ctx: ServerContext, review: ReviewFile): void {
  review.meta.updatedAt = new Date().toISOString();
  writeReview(ctx.cwd, review, true);
}

// load the current .review, or build a fresh empty one. used by both posts + compile.
function loadOrInit(ctx: ServerContext): ReviewFile {
  const existing = readReview(ctx.cwd);
  if (existing) return existing;
  const now = new Date().toISOString();
  return {
    meta: { ref: ctx.diff.ref, createdAt: now, updatedAt: now },
    viewed: [],
    comments: [],
  };
}

export function isFullContextRequest(url?: URL, req?: Request): boolean {
  return url?.searchParams.get("full") === "1" || req?.headers.get("x-nittle-full-file") === "1";
}

// re-runs git diff so the view reflects the repo's current state (refresh / live review),
// keeping the last good diff if git errors transiently. the first call reuses the diff already
// computed at launch when the requested context mode matches — no point running git twice.
export function handleGetDiff(ctx: ServerContext, url?: URL, req?: Request): Response {
  const full = isFullContextRequest(url, req);
  if (!ctx.served && (ctx.mode === "browse" || full === Boolean(ctx.diffFull))) {
    ctx.served = true;
    return json(ctx.diff);
  }
  ctx.served = true;
  try {
    const contextLines = full ? FULL_FILE_CONTEXT : undefined;
    ctx.diff =
      ctx.mode === "browse"
        ? excludeReviewFile(scanProject(ctx.cwd, ctx.scope), false)
        : buildDiff(ctx.diffArgs, ctx.cwd, ctx.includeUntracked, ctx.diff.ref, ctx.meta, false, contextLines);
    ctx.diffFull = full;
    ctx.diffGeneration = (ctx.diffGeneration ?? 0) + 1;
  } catch {
    // keep the previous diff
  }
  return json(ctx.diff);
}

export function handleGetComments(ctx: ServerContext): Response {
  if (ctx.reviewId) return json(readReviewRecord(ctx.reviewId) ?? {});
  return json(readReview(ctx.cwd) ?? {});
}

function currentReview(ctx: ServerContext): ReviewFile {
  if (!ctx.reviewId) return loadOrInit(ctx);
  const record = readReviewRecord(ctx.reviewId);
  if (!record) return loadOrInit(ctx);
  return {
    meta: { ref: record.target.ref, createdAt: record.createdAt, updatedAt: record.updatedAt },
    viewed: record.viewed,
    comments: record.comments,
  };
}

export async function handlePostComments(ctx: ServerContext, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid json body", 400);
  }
  const comments = (body as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) {
    return apiError("comments must be an array", 400);
  }
  if (ctx.reviewId) {
    const incoming = comments as Comment[];
    return json(
      updateReviewRecord(ctx.reviewId, (record) => ({ comments: mergeReviewerComments(record.comments, incoming) }))
    );
  }
  const review = currentReview(ctx);
  review.comments = comments as Comment[];
  saveReview(ctx, review);
  return json(review);
}

export async function handlePostViewed(ctx: ServerContext, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid json body", 400);
  }
  const viewed = (body as { viewed?: unknown }).viewed;
  if (!Array.isArray(viewed)) {
    return apiError("viewed must be an array", 400);
  }
  const review = currentReview(ctx);
  review.viewed = viewed as string[];
  if (ctx.reviewId) return json(updateReviewRecord(ctx.reviewId, { viewed: review.viewed }));
  saveReview(ctx, review);
  return json(review);
}

// summary precedence: an explicit ?summary= query param, else the persisted record's
// summary for the selected Review Record, else none.
export function handleGetCompile(ctx: ServerContext, url: URL): Response {
  const review = currentReview(ctx);
  const querySummary = url.searchParams.get("summary");
  const summary = querySummary?.trim() ? querySummary : ctx.reviewId ? readReviewRecord(ctx.reviewId)?.summary : undefined;
  return json({ prompt: compileReviewPrompt(ctx.diff, review, summary) } satisfies CompilePromptResponse);
}

// reports whether a newer nittle release is published (best-effort, never throws).
export async function handleGetUpdate(ctx: ServerContext): Promise<Response> {
  return json(await badgeUpdateStatus(ctx.productRoot));
}
