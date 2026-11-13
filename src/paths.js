// Guards which pages may be rendered. A render path is always resolved against
// the configured HA origin, and anything that could escape it is rejected, so
// the service can never be used to screenshot an arbitrary site.

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

// HA paths that are never dashboards and should not be rendered.
const BLOCKED_PREFIXES = ["api", "auth", "local", "static", "frontend_latest", "frontend_es5", "hacsfiles"];

export class PathError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} rawPath  path after /render/, still percent-encoded
 * @param {{haOrigin: string, allowedPaths: string[]}} config
 * @returns {{path: string, url: string}}
 */
export function resolveRenderPath(rawPath, { haOrigin, allowedPaths }) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new PathError(400, "Path is not valid percent-encoding");
  }

  // Only a single trailing slash is tolerated. A leading slash (i.e. "//host")
  // or any empty segment is rejected below rather than silently rewritten.
  const path = decoded.endsWith("/") ? decoded.slice(0, -1) : decoded;
  if (!path) throw new PathError(400, "Path is empty");

  const segments = path.split("/");
  for (const segment of segments) {
    // Rejects "", ".", "..", "//", backslashes, ":", "@", "?", "#", spaces and control characters.
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new PathError(400, `Path segment not allowed: ${JSON.stringify(segment)}`);
    }
  }

  if (BLOCKED_PREFIXES.includes(segments[0].toLowerCase())) {
    throw new PathError(403, `Path not allowed: /${path}`);
  }

  if (allowedPaths.length > 0) {
    const ok = allowedPaths.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
    if (!ok) throw new PathError(403, `Path not in allowed_paths: /${path}`);
  }

  return { path, url: new URL("/" + path, haOrigin).toString() };
}
