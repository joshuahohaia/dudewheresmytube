import type { VercelRequest, VercelResponse } from '@vercel/node';
import { selectNearestEligibleArrivals, type TflArrival } from './train-selection.js';

const LINE_IDS = [
  'bakerloo',
  'central',
  'circle',
  'district',
  'hammersmith-city',
  'jubilee',
  'metropolitan',
  'northern',
  'piccadilly',
  'victoria',
  'waterloo-city',
] as const;

const LINE_DISPLAY_NAMES: Record<string, string> = {
  'bakerloo': 'Bakerloo',
  'central': 'Central',
  'circle': 'Circle',
  'district': 'District',
  'hammersmith-city': 'Hammersmith & City',
  'jubilee': 'Jubilee',
  'metropolitan': 'Metropolitan',
  'northern': 'Northern',
  'piccadilly': 'Piccadilly',
  'victoria': 'Victoria',
  'waterloo-city': 'Waterloo & City',
};

interface Train {
  id: string;
  lineId: string;
  lineName: string;
  currentStation: string;
  destination: string;
  expectedArrival?: string;
  timestamp?: string;
  timeToStation: number;
  direction: string;
  vehicleId: string;
  naptanId: string;
}

interface LineResult {
  trains: Train[];
  failed: boolean;
}

async function fetchLineData(lineId: string): Promise<LineResult> {
  const url = `https://api.tfl.gov.uk/Line/${lineId}/Arrivals`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch line ${lineId}: ${response.status}`);
      return { trains: [], failed: true };
    }

    const arrivals = (await response.json()) as TflArrival[];
    const eligible = selectNearestEligibleArrivals(arrivals);

    const trains: Train[] = eligible.map((arrival) => ({
      id: `${lineId}-${arrival.vehicleId}`,
      lineId: lineId,
      lineName: LINE_DISPLAY_NAMES[lineId] || arrival.lineName,
      currentStation: (arrival.stationName || 'Unknown').replace(' Underground Station', ''),
      destination: (arrival.destinationName || 'Unknown').replace(' Underground Station', ''),
      timeToStation: arrival.timeToStation,
      expectedArrival: arrival.expectedArrival,
      timestamp: arrival.timestamp,
      direction: arrival.direction || '',
      vehicleId: arrival.vehicleId,
      naptanId: arrival.naptanId || '',
    }));

    return { trains, failed: false };
  } catch (error) {
    console.error(`Error fetching line ${lineId}:`, error);
    return { trains: [], failed: true };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate');

  const now = Date.now();

  console.log('Fetching train data from TfL Unified API...');
  const results = await Promise.all(
    LINE_IDS.map(lineId => fetchLineData(lineId))
  );

  const allTrains = results.flatMap(result => result.trains);
  const failedLines = LINE_IDS.filter((_, index) => results[index].failed);
  const uniqueTrains = Array.from(
    new Map(allTrains.map(t => [t.id, t])).values()
  );

  console.log(`Fetched ${uniqueTrains.length} trains (${failedLines.length} lines failed)`);

  // failedLines lets clients tell an upstream TfL failure apart from a
  // genuinely empty feed, instead of showing "no trains" for both.
  res.status(200).json({
    trains: uniqueTrains,
    timestamp: now,
    count: uniqueTrains.length,
    failedLines,
  });
}
