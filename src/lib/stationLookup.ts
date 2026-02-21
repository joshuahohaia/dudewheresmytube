import stationsData from '../data/tfl_stations.json';
import type { FeatureCollection, Point } from 'geojson';

// Build a lookup map from station name to coordinates
const stationMap = new Map<string, [number, number]>();

// Normalize station names for matching
function normalizeStationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, '') // Remove parenthetical info
    .replace(/\s*underground\s*station\s*/gi, '')
    .replace(/\s*station\s*/gi, '')
    .replace(/\s*rail\s*/gi, '')
    .replace(/st\./g, 'st')
    .replace(/&/g, 'and')
    .trim();
}

// Initialize the station map
const features = (stationsData as FeatureCollection<Point>).features;
for (const feature of features) {
  const name = feature.properties?.name;
  if (name && feature.geometry?.coordinates) {
    const coords = feature.geometry.coordinates as [number, number];
    const normalizedName = normalizeStationName(name);
    stationMap.set(normalizedName, coords);

    // Also add the original name
    stationMap.set(name.toLowerCase(), coords);
  }
}

// Common aliases and variations
const aliases: Record<string, string> = {
  "king's cross st. pancras": "kings cross st pancras",
  "kings cross": "kings cross st pancras",
  "hammersmith (h&c line)": "hammersmith",
  "hammersmith (district line)": "hammersmith",
  "edgware road (bakerloo)": "edgware road",
  "edgware road (circle)": "edgware road",
  "paddington (h&c line)": "paddington",
  "shepherd's bush market": "shepherds bush market",
  "shepherd's bush": "shepherds bush",
  "st. james's park": "st jamess park",
  "st james's park": "st jamess park",
  "highbury & islington": "highbury and islington",
  "earls court": "earl's court",
};

export function getStationCoordinates(stationName: string): [number, number] | null {
  if (!stationName) return null;

  const normalized = normalizeStationName(stationName);

  // Try direct lookup
  let coords = stationMap.get(normalized);
  if (coords) return coords;

  // Try alias
  const alias = aliases[normalized];
  if (alias) {
    coords = stationMap.get(alias);
    if (coords) return coords;
  }

  // Try partial match
  for (const [key, value] of stationMap.entries()) {
    if (key.includes(normalized) || normalized.includes(key)) {
      return value;
    }
  }

  return null;
}

export function getAllStations(): Map<string, [number, number]> {
  return stationMap;
}
