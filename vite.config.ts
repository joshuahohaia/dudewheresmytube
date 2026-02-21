import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// TfL line IDs for Underground (used in Unified API)
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

// Simple cache
let cache: { data: Train[]; timestamp: number } | null = null;
const CACHE_TTL = 10000; // 10 seconds cache

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
  // Unified API works without authentication (50 req/min limit)
  const url = `https://api.tfl.gov.uk/Line/${lineId}/Arrivals`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch line ${lineId}: ${response.status}`);
      return [];
    }

    const arrivals: TflArrival[] = await response.json();
    const trains: Train[] = [];
    const seenVehicles = new Set<string>();

    for (const arrival of arrivals) {
      // Only include each vehicle once (closest arrival)
      if (seenVehicles.has(arrival.vehicleId)) continue;
      seenVehicles.add(arrival.vehicleId);

      // Only include trains arriving within 5 minutes
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

// Vite plugin to handle /api/trains locally
function apiPlugin(): Plugin {
  return {
    name: 'api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/trains') {
          return next();
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const now = Date.now();

        // Check cache
        if (cache && now - cache.timestamp < CACHE_TTL) {
          res.end(JSON.stringify({
            trains: cache.data,
            timestamp: cache.timestamp,
            cached: true,
          }));
          return;
        }

        console.log('Fetching train data from TfL Unified API...');
        const results = await Promise.all(
          LINE_IDS.map(lineId => fetchLineData(lineId))
        );

        const allTrains = results.flat();
        const uniqueTrains = Array.from(
          new Map(allTrains.map(t => [t.id, t])).values()
        );

        cache = { data: uniqueTrains, timestamp: now };
        console.log(`Fetched ${uniqueTrains.length} trains`);

        res.end(JSON.stringify({
          trains: uniqueTrains,
          timestamp: now,
          cached: false,
          count: uniqueTrains.length,
        }));
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), apiPlugin()],
  envPrefix: 'TFL_',
})
