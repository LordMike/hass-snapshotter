import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s) => createHash("sha256").update(s).digest();

// True when the request's Authorization header equals the expected value (null: no auth).
// Both sides are hashed so the comparison takes the same time whatever the length.
export function checkAuth(expected, received) {
  if (expected == null) return true;
  if (typeof received !== "string") return false;
  return timingSafeEqual(digest(expected), digest(received));
}
