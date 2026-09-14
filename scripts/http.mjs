import { setTimeout } from 'node:timers/promises';

export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
  }
}

// Bounded retries also cover network errors. Callers handle expected 401/404s;
// authentication failures must never be interpreted as missing images.
export async function request(url, options = {}, {
  fetchImpl = fetch, sleep = setTimeout, attempts = 4,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options, signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === attempts - 1) throw new HttpError(url, response.status);
    const retryAfter = response.headers.get('retry-after');
    const delay = /^\d+$/.test(retryAfter ?? '')
      ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
    await response.body?.cancel();
    await sleep(Math.min(delay, 30_000));
  }
}

export async function json(url, http = request) {
  const response = await http(url);
  if (!response.ok) throw new HttpError(url, response.status);
  return response.json();
}
