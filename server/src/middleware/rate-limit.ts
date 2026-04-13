import type { RequestHandler } from "express";

interface RateLimitOptions {
  /** Maximum number of requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Optional message returned in the 429 response body. */
  message?: string;
}

interface RequestRecord {
  timestamps: number[];
}

/**
 * Returns the client IP from the request, honoring X-Forwarded-For for
 * deployments behind a proxy.
 */
function resolveClientIp(req: Parameters<RequestHandler>[0]): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Creates a sliding-window rate-limiter Express middleware.
 *
 * Requests that exceed `maxRequests` within the last `windowMs` milliseconds
 * are rejected with HTTP 429. The standard `Retry-After` and
 * `X-RateLimit-*` headers are included in every response.
 *
 * The store is in-memory and per-process. Entries for IPs that have no
 * recent activity are pruned lazily to avoid unbounded growth.
 */
export function rateLimitMiddleware(opts: RateLimitOptions): RequestHandler {
  const { maxRequests, windowMs, message = "Too many requests, please try again later." } = opts;
  const store = new Map<string, RequestRecord>();

  return (req, res, next) => {
    const ip = resolveClientIp(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    const record = store.get(ip) ?? { timestamps: [] };
    // Prune timestamps outside the current window.
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    const remaining = maxRequests - record.timestamps.length;
    const resetAt = record.timestamps[0] !== undefined ? record.timestamps[0] + windowMs : now + windowMs;

    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

    if (remaining <= 0) {
      const retryAfterSec = Math.ceil((resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: message });
      return;
    }

    record.timestamps.push(now);
    store.set(ip, record);
    next();
  };
}
