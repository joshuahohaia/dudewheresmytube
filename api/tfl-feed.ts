import type { TflArrival } from './train-selection.js';

export const LINE_IDS = ['bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee', 'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city'] as const;
const TTL_MS = 30_000;
const TIMEOUT_MS = 8_000;

export class FeedError extends Error {
  constructor(message: string, public retryAfterSeconds: number, public upstreamStatus?: number) { super(message); }
}

function retryDelay(header: string | null, now: number): number {
  if (!header) return 60;
  const seconds = Number(header);
  const parsed = Number.isFinite(seconds) ? seconds : (Date.parse(header) - now) / 1000;
  return Math.max(1, Math.min(300, Number.isFinite(parsed) ? Math.ceil(parsed) : 60));
}

/** Instance-local cache and singleflight. The CDN handles sharing across visitors;
 * separate serverless instances can still refresh independently. */
export function createFeedLoader(fetcher: typeof fetch = fetch, clock: () => number = Date.now) {
  let cached: { arrivals: TflArrival[]; timestamp: number } | undefined;
  let pending: Promise<{ arrivals: TflArrival[]; timestamp: number }> | undefined;
  let retryAt = 0;
  let lastStatus: number | undefined;
  return async () => {
    const now = clock();
    if (cached && now - cached.timestamp < TTL_MS) return cached;
    if (now < retryAt) throw new FeedError('TfL feed is cooling down after a failed request', Math.ceil((retryAt - now) / 1000), lastStatus);
    if (pending) return pending;
    pending = (async () => {
      try {
        // TfL accepts comma-separated line IDs: one call, not eleven bursts.
        const response = await fetcher(`https://api.tfl.gov.uk/Line/${LINE_IDS.join(',')}/Arrivals`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
          const delay = response.status === 429 ? retryDelay(response.headers.get('retry-after'), clock()) : 15;
          lastStatus = response.status;
          retryAt = clock() + delay * 1000;
          throw new FeedError(`TfL arrivals returned ${response.status}`, delay, response.status);
        }
        const payload: unknown = await response.json();
        if (!Array.isArray(payload) || !payload.every(item => item && typeof item.lineId === 'string' && typeof item.vehicleId === 'string' && Number.isFinite(item.timeToStation))) {
          throw new FeedError('TfL returned invalid arrivals data', 15);
        }
        // Empty is valid outside service hours. Missing lines in a successful
        // batch are not evidence that those lines failed.
        cached = { arrivals: payload as TflArrival[], timestamp: clock() };
        retryAt = 0;
        lastStatus = undefined;
        return cached;
      } catch (error) {
        if (error instanceof FeedError) {
          retryAt = Math.max(retryAt, clock() + error.retryAfterSeconds * 1000);
          throw error;
        }
        retryAt = clock() + 15_000;
        throw new FeedError('TfL arrivals request failed or timed out', 15);
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
