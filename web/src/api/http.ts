/**
 * A tiny JSON-over-fetch helper for the REST clients in this folder.
 * Requests go through `getPlatform().fetch` (auth, CSRF and idle handling are added there).
 */
import { getPlatform } from '../platform';

/** A failed request: `status` is the HTTP status (0 when the network failed), `message` the server's `detail`. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** FastAPI sends `detail` as a string, or as a list of `{msg}` for validation errors. */
function detailOf(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : '')).filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  }
  return fallback;
}

export async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await getPlatform().fetch(path, init);
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'Network error');
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new ApiError(res.status, detailOf(data, `Request failed (HTTP ${res.status})`));
  return data as T;
}
