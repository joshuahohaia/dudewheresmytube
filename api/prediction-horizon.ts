import type { TflArrival } from './train-selection.js';

/** Keep only same-service downstream predictions with real absolute times.
 * No new request is made: these records already arrived in the batched feed. */
export function predictionHorizon(arrivals: TflArrival[], nearest: TflArrival, now = Date.now()) {
  const start = Date.parse(nearest.expectedArrival || '');
  const sourceAt = Date.parse(nearest.timestamp || '');
  if (!Number.isFinite(start) || !Number.isFinite(sourceAt) || now - sourceAt > 90_000 || sourceAt > now + 5000) return [];
  const seen = new Set([nearest.naptanId]);
  return arrivals.filter(a => a.lineId === nearest.lineId && a.vehicleId === nearest.vehicleId
    && a.destinationName === nearest.destinationName && a.direction === nearest.direction
    && a.naptanId && a.expectedArrival && a.timestamp === nearest.timestamp
    && Date.parse(a.expectedArrival) > start && Date.parse(a.expectedArrival) <= now + 300_000)
    .sort((a,b) => Date.parse(a.expectedArrival!) - Date.parse(b.expectedArrival!))
    .filter(a => { if(seen.has(a.naptanId)) return false; seen.add(a.naptanId); return true; })
    .slice(0, 3).map(a => ({station: a.stationName.replace(' Underground Station',''), naptanId:a.naptanId, expectedArrival:a.expectedArrival!}));
}
