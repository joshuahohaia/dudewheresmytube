import { XMLParser } from 'fast-xml-parser';

export const config = {
  runtime: 'edge',
};

// TfL line codes for Underground
const LINE_CODES = ['B', 'C', 'D', 'H', 'J', 'M', 'N', 'P', 'V', 'W', 'L'] as const;

const LINE_NAMES: Record<string, string> = {
  'B': 'Bakerloo',
  'C': 'Central',
  'D': 'District',
  'H': 'Hammersmith & City',
  'J': 'Jubilee',
  'M': 'Metropolitan',
  'N': 'Northern',
  'P': 'Piccadilly',
  'V': 'Victoria',
  'W': 'Waterloo & City',
  'L': 'Circle',
};

interface Train {
  id: string;
  lineId: string;
  lineName: string;
  currentStation: string;
  destination: string;
  timeToStation: number; // seconds
  direction: string;
  trackCode: string;
}

interface TrackerNetPlatform {
  Name?: string;
  Num?: string;
  TrackCode?: string;
  Train?: TrackerNetTrain | TrackerNetTrain[];
}

interface TrackerNetTrain {
  SetNumber?: string;
  TripNumber?: string;
  SecondsTo?: string;
  TimeTo?: string;
  Location?: string;
  Destination?: string;
  DestCode?: string;
  TrackCode?: string;
}

interface TrackerNetStation {
  Code?: string;
  Name?: string;
  Platform?: TrackerNetPlatform | TrackerNetPlatform[];
}

interface TrackerNetResponse {
  ROOT?: {
    S?: TrackerNetStation | TrackerNetStation[];
  };
}

async function fetchLineData(lineCode: string, apiKey: string): Promise<Train[]> {
  const url = `https://api.tfl.gov.uk/TrackerNet/PredictionSummary/${lineCode}?app_key=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch line ${lineCode}: ${response.status}`);
      return [];
    }

    const xmlText = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    });

    const data: TrackerNetResponse = parser.parse(xmlText);
    const trains: Train[] = [];

    // Navigate the XML structure
    const stations = data.ROOT?.S;
    if (!stations) return [];

    const stationArray = Array.isArray(stations) ? stations : [stations];

    for (const station of stationArray) {
      const platforms = station.Platform;
      if (!platforms) continue;

      const platformArray = Array.isArray(platforms) ? platforms : [platforms];

      for (const platform of platformArray) {
        const platformTrains = platform.Train;
        if (!platformTrains) continue;

        const trainArray = Array.isArray(platformTrains) ? platformTrains : [platformTrains];

        for (const train of trainArray) {
          if (!train.SetNumber || train.SetNumber === '0') continue;

          const timeToStation = parseInt(train.SecondsTo || '0', 10);

          // Only include trains that are approaching (within 5 minutes)
          if (timeToStation > 300) continue;

          trains.push({
            id: `${lineCode}-${train.SetNumber}-${train.TripNumber || '0'}`,
            lineId: lineCode,
            lineName: LINE_NAMES[lineCode] || lineCode,
            currentStation: station.Name || 'Unknown',
            destination: train.Destination || 'Unknown',
            timeToStation,
            direction: train.DestCode || '',
            trackCode: platform.TrackCode || train.TrackCode || '',
          });
        }
      }
    }

    return trains;
  } catch (error) {
    console.error(`Error fetching line ${lineCode}:`, error);
    return [];
  }
}

// Simple in-memory cache
let cache: { data: Train[]; timestamp: number } | null = null;
const CACHE_TTL = 15000; // 15 seconds

export default async function handler(request: Request): Promise<Response> {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // Check cache
  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL) {
    return new Response(JSON.stringify({
      trains: cache.data,
      timestamp: cache.timestamp,
      cached: true,
    }), { headers });
  }

  // Get API key from environment
  const apiKey = process.env.TFL_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'TFL_API_KEY not configured',
      trains: [],
      timestamp: now,
    }), { status: 500, headers });
  }

  // Fetch all lines in parallel
  const results = await Promise.all(
    LINE_CODES.map(code => fetchLineData(code, apiKey))
  );

  // Flatten results and deduplicate by train ID
  const allTrains = results.flat();
  const uniqueTrains = Array.from(
    new Map(allTrains.map(t => [t.id, t])).values()
  );

  // Update cache
  cache = { data: uniqueTrains, timestamp: now };

  return new Response(JSON.stringify({
    trains: uniqueTrains,
    timestamp: now,
    cached: false,
    count: uniqueTrains.length,
  }), { headers });
}
