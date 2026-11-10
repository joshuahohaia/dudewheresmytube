import type { TflArrival } from './train-selection.js';

/** Keep only same-service downstream predictions with real absolute times.
 * No new request is made: these records already arrived in the batched feed. */

// Onward predictions carry absolute expectedArrival times, so they stay usable
// while the batch is moderately old. The TfL batch timestamp regularly reaches
// the client at 80-140s of age (measured 2026-11-10); a 90s gate discarded
// every onward leg on a healthy feed and froze the map between batches. 180s
// keeps the window bounded without pretending old data is live: the client
// still marks older estimates after 90s and stops motion at source age 180s. Never relabel
// receipt time as freshness - sourceAt remains the truth.
const MAX_PREDICTION_SOURCE_AGE_MS = 180_000;
export function predictionHorizon(arrivals: TflArrival[], nearest: TflArrival, now = Date.now()) {
  const start = Date.parse(nearest.expectedArrival || '');
  const sourceAt = Date.parse(nearest.timestamp || '');
  if (!Number.isFinite(start) || !Number.isFinite(sourceAt) || now - sourceAt > MAX_PREDICTION_SOURCE_AGE_MS || sourceAt > now + 5000) return [];
  const seen = new Set([nearest.naptanId]);
  return arrivals.filter(a => a.lineId === nearest.lineId && a.vehicleId === nearest.vehicleId
    && a.destinationName === nearest.destinationName && a.direction === nearest.direction
    && a.naptanId && a.expectedArrival && a.timestamp === nearest.timestamp
    && Date.parse(a.expectedArrival) > start && Date.parse(a.expectedArrival) <= now + 300_000)
    .sort((a,b) => Date.parse(a.expectedArrival!) - Date.parse(b.expectedArrival!))
    .filter(a => { if(seen.has(a.naptanId)) return false; seen.add(a.naptanId); return true; })
    .slice(0, 3).map(a => ({station: a.stationName.replace(' Underground Station',''), naptanId:a.naptanId, expectedArrival:a.expectedArrival!}));
}
