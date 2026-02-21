import type { VercelRequest, VercelResponse } from '@vercel/node';

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
  timeToStation: number;
  direction: string;
  vehicleId: string;
  naptanId: string;
}

interface TflArrival {
  id: string;
  vehicleId: string;
  naptanId: string;
  stationName: string;
  lineId: string;
  lineName: string;
  platformName: string;
  direction: string;
  destinationName: string;
  timeToStation: number;
}

async function fetchLineData(lineId: string): Promise<Train[]> {
  const url = `https://api.tfl.gov.uk/Line/${lineId}/Arrivals`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch line ${lineId}: ${response.status}`);
      return [];
    }

    const arrivals = await response.json() as TflArrival[];
    const trains: Train[] = [];
    const seenVehicles = new Set<string>();

    for (const arrival of arrivals) {
      if (seenVehicles.has(arrival.vehicleId)) continue;
      seenVehicles.add(arrival.vehicleId);

      if (arrival.timeToStation > 300) continue;

      trains.push({
        id: `${lineId}-${arrival.vehicleId}`,
        lineId: lineId,
        lineName: LINE_DISPLAY_NAMES[lineId] || arrival.lineName,
        currentStation: (arrival.stationName || 'Unknown').replace(' Underground Station', ''),
        destination: (arrival.destinationName || 'Unknown').replace(' Underground Station', ''),
        timeToStation: arrival.timeToStation,
        direction: arrival.direction || '',
        vehicleId: arrival.vehicleId,
        naptanId: arrival.naptanId || '',
      });
    }

    return trains;
  } catch (error) {
    console.error(`Error fetching line ${lineId}:`, error);
    return [];
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

  const allTrains = results.flat();
  const uniqueTrains = Array.from(
    new Map(allTrains.map(t => [t.id, t])).values()
  );

  console.log(`Fetched ${uniqueTrains.length} trains`);

  res.status(200).json({
    trains: uniqueTrains,
    timestamp: now,
    count: uniqueTrains.length,
  });
}
