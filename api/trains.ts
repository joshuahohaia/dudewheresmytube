import type { VercelRequest, VercelResponse } from '@vercel/node';
import { selectNearestEligibleArrivals } from './train-selection.js';
import { createFeedLoader, FeedError, LINE_IDS } from './tfl-feed.js';

const loadFeed = createFeedLoader();
const LINE_DISPLAY_NAMES: Record<string, string> = {
  bakerloo: 'Bakerloo', central: 'Central', circle: 'Circle', district: 'District',
  'hammersmith-city': 'Hammersmith & City', jubilee: 'Jubilee', metropolitan: 'Metropolitan',
  northern: 'Northern', piccadilly: 'Piccadilly', victoria: 'Victoria', 'waterloo-city': 'Waterloo & City',
};

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const feed = await loadFeed();
    // Deduplication must be per line: vehicle numbers can overlap across lines.
    const trains = LINE_IDS.flatMap(lineId => selectNearestEligibleArrivals(feed.arrivals.filter(a => a.lineId === lineId)).map(arrival => ({
      id: `${lineId}-${arrival.vehicleId}`, lineId,
      lineName: LINE_DISPLAY_NAMES[lineId] || arrival.lineName,
      currentStation: (arrival.stationName || 'Unknown').replace(' Underground Station', ''),
      destination: (arrival.destinationName || 'Unknown').replace(' Underground Station', ''),
      timeToStation: arrival.timeToStation,
      // Compatible with the motion follow-up without requiring that PR first.
      expectedArrival: arrival.expectedArrival,
      timestamp: arrival.timestamp,
      direction: arrival.direction || '', vehicleId: arrival.vehicleId, naptanId: arrival.naptanId || '',
    })));
    // Bounded CDN staleness. Never cache an error as a successful empty feed.
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=15');
    res.status(200).json({ trains, timestamp: feed.timestamp, count: trains.length, failedLines: [] });
  } catch (error) {
    const failure = error instanceof FeedError ? error : new FeedError('Train feed unavailable', 15);
    console.error(failure.message);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(failure.retryAfterSeconds));
    res.status(503).json({ trains: [], timestamp: Date.now(), count: 0, failedLines: LINE_IDS, error: failure.message });
  }
}
