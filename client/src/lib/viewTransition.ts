import { reduced } from "./motion";

// smooth crossfade for state changes (theme swap), feature-detected + reduced-motion gated.
export function withViewTransition(update: () => void): void {
  if (typeof document.startViewTransition === "function" && !reduced()) document.startViewTransition(update);
  else update();
}
