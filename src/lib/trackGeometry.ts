import linesData from '../data/tfl_lines.json';
import type { FeatureCollection, LineString, Position } from 'geojson';

interface LineSegment {
  lineName: string;
  coordinates: Position[];
}

// Build an index of line segments by line name
const lineSegments: Map<string, LineSegment[]> = new Map();

function initializeLineSegments() {
  const features = (linesData as FeatureCollection<LineString>).features;

  for (const feature of features) {
    const lines = feature.properties?.lines || [];
    const coords = feature.geometry?.coordinates || [];

    if (coords.length < 2) continue;

    for (const line of lines) {
      const lineName = line.name;
      if (!lineSegments.has(lineName)) {
        lineSegments.set(lineName, []);
      }
      lineSegments.get(lineName)!.push({
        lineName,
        coordinates: coords,
      });
    }
  }
}

initializeLineSegments();

// Calculate distance between two points
function distance(a: Position, b: Position): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Find the track path between two points for a given line
export function findTrackPath(
  from: [number, number],
  to: [number, number],
  lineName: string
): Position[] | null {
  const segments = lineSegments.get(lineName);
  if (!segments || segments.length === 0) return null;

  // Find the segment that contains both points (or is closest)
  let bestSegment: LineSegment | null = null;
  let bestFromIdx = -1;
  let bestToIdx = -1;
  let bestScore = Infinity;

  for (const segment of segments) {
    const coords = segment.coordinates;

    // Find closest point on this segment to 'from' and 'to'
    let fromIdx = -1;
    let toIdx = -1;
    let fromDist = Infinity;
    let toDist = Infinity;

    for (let i = 0; i < coords.length; i++) {
      const d1 = distance(coords[i], from);
      const d2 = distance(coords[i], to);

      if (d1 < fromDist) {
        fromDist = d1;
        fromIdx = i;
      }
      if (d2 < toDist) {
        toDist = d2;
        toIdx = i;
      }
    }

    // Score based on how close both points are to this segment
    const score = fromDist + toDist;
    if (score < bestScore && fromIdx !== toIdx) {
      bestScore = score;
      bestSegment = segment;
      bestFromIdx = fromIdx;
      bestToIdx = toIdx;
    }
  }

  if (!bestSegment || bestFromIdx === -1 || bestToIdx === -1) {
    return null;
  }

  // Extract the path between the two indices
  const coords = bestSegment.coordinates;
  const startIdx = Math.min(bestFromIdx, bestToIdx);
  const endIdx = Math.max(bestFromIdx, bestToIdx);

  let path = coords.slice(startIdx, endIdx + 1);

  // Reverse if needed so path goes from -> to
  if (bestFromIdx > bestToIdx) {
    path = path.reverse();
  }

  return path;
}

// Interpolate position along a path
export function interpolateAlongPath(
  path: Position[],
  progress: number // 0 to 1
): [number, number] {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return [path[0][0], path[0][1]];
  if (progress <= 0) return [path[0][0], path[0][1]];
  if (progress >= 1) return [path[path.length - 1][0], path[path.length - 1][1]];

  // Calculate total path length
  let totalLength = 0;
  const segmentLengths: number[] = [];

  for (let i = 1; i < path.length; i++) {
    const len = distance(path[i - 1], path[i]);
    segmentLengths.push(len);
    totalLength += len;
  }

  if (totalLength === 0) return [path[0][0], path[0][1]];

  // Find position at progress
  const targetDist = progress * totalLength;
  let currentDist = 0;

  for (let i = 0; i < segmentLengths.length; i++) {
    const segLen = segmentLengths[i];

    if (currentDist + segLen >= targetDist) {
      // Interpolate within this segment
      const segProgress = (targetDist - currentDist) / segLen;
      const p1 = path[i];
      const p2 = path[i + 1];

      return [
        p1[0] + (p2[0] - p1[0]) * segProgress,
        p1[1] + (p2[1] - p1[1]) * segProgress,
      ];
    }

    currentDist += segLen;
  }

  // Fallback to end
  return [path[path.length - 1][0], path[path.length - 1][1]];
}

// Map line IDs to display names for lookup
const LINE_ID_TO_NAME: Record<string, string> = {
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

export function getLineDisplayName(lineId: string): string {
  return LINE_ID_TO_NAME[lineId] || lineId;
}
