import linesData from '../data/tfl_lines.json';
import stationsData from '../data/tfl_stations.json';
import type { FeatureCollection, LineString, Point, Position } from 'geojson';
import { normalizeStationName, getStationCoordinates } from './stationLookup';
import { getLineDisplayName } from './trackGeometry';

/**
 * Countdown-driven train motion.
 *
 * The TfL arrivals feed tells us which station a train is approaching and how
 * many seconds until it arrives; it does not publish positions between
 * stations. This module derives an estimated between-station position from
 * that countdown: the train is placed along the real track geometry at the
 * distance an average-speed train would cover in the remaining time, so it
 * glides toward the station. Corrections are limited to plausible speed.
 *
 * Everything between stations is an estimate. Arrival at the target station
 * is anchored to the feed's prediction; a train whose countdown has elapsed
 * waits at the station (dwell) until the feed moves it on, so the model never
 * invents a departure.
 */

// Average line speed including intermediate dwell (~32 km/h). Used only to
// spread the countdown over track distance; arrival stays anchored to tts=0.
const AVG_SPEED_MPS = 9;
// How far back from the target station we place a train when its countdown is
// long (the feed caps predictions at 300s out).
const MAX_BACKTRACK_LEGS = 6;
const MAX_BACKTRACK_METERS = 4000;
// Segment endpoints snap to the nearest station within this distance (degrees).
const SNAP_TOLERANCE_DEG = 0.006;
// Same-target countdown updates within this tolerance are treated as feed
// noise and ignored, so markers don't stutter on every poll.
const ARRIVAL_JITTER_SECONDS = 2;

export interface MotionTrain {
  id: string;
  lineId: string;
  currentStation: string;
  destination: string;
  timeToStation: number;
  expectedArrival?: string;
  naptanId?: string;
}

export interface MotionState {
  trainId: string;
  lineName: string;
  targetStation: string;
  targetCoords: [number, number];
  /** Track path the train is travelling along toward the target station. */
  path: Position[] | null;
  /** Cumulative metres at each path vertex (same length as path). */
  cumMeters: number[];
  totalMeters: number;
  /** Epoch ms when the countdown reaches zero (train at target station). */
  arrivalTime: number;
  receivedAt: number;
  destination: string;
  startedAt: number;
  startMeters: number;
  /** Furthest-back station of the estimated path (mainly for tests/debug). */
  originStation: string | null;
}

interface StationRef {
  name: string;
  coords: [number, number];
}

interface Edge {
  to: string;
  path: Position[];
  meters: number;
}

interface LineGraph {
  stations: StationRef[];
  adj: Map<string, Edge[]>;
}

function metersBetween(a: Position, b: Position): number {
  const lat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (a[0] - b[0]) * 111320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

function pathLengthMeters(path: Position[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += metersBetween(path[i - 1], path[i]);
  return total;
}

function distanceDeg(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

const lineGraphs = new Map<string, LineGraph>();

function buildLineGraphs() {
  const lineFeatures = (linesData as FeatureCollection<LineString>).features;
  const stationFeatures = (stationsData as FeatureCollection<Point>).features;

  const stationsById = new Map(stationFeatures.map(f => [f.properties?.id, { name: f.properties?.name as string, coords: f.geometry.coordinates as [number, number] }]));
  const stationsByLine = new Map<string, StationRef[]>();
  for (const feature of stationFeatures) {
    const name = feature.properties?.name;
    const coords = feature.geometry?.coordinates as [number, number] | undefined;
    if (!name || !coords) continue;
    for (const line of feature.properties?.lines || []) {
      const list = stationsByLine.get(line.name) || [];
      if (!list.some((s) => s.name === name)) list.push({ name, coords });
      stationsByLine.set(line.name, list);
    }
  }

  function nearestStation(stations: StationRef[], pt: Position): { name: string; dist: number } | null {
    let best: { name: string; dist: number } | null = null;
    for (const s of stations) {
      const d = distanceDeg(s.coords, pt);
      if (!best || d < best.dist) best = { name: s.name, dist: d };
    }
    return best;
  }

  for (const feature of lineFeatures) {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    for (const line of feature.properties?.lines || []) {
      const stations = stationsByLine.get(line.name);
      if (!stations) continue;
      let graph = lineGraphs.get(line.name);
      if (!graph) {
        graph = { stations, adj: new Map() };
        lineGraphs.set(line.name, graph);
      }
      // The GeoJSON includes authoritative endpoint IDs. Nearest-coordinate
      // guesses confuse nearby interchange stations and disconnect whole branches.
      const start = stationsById.get(line.start_sid);
      const end = stationsById.get(line.end_sid);
      const firstIsStart = start && end && distanceDeg(start.coords, coords[0]) <= distanceDeg(end.coords, coords[0]);
      const a = start && end ? { name: firstIsStart ? start.name : end.name, dist: 0 } : nearestStation(stations, coords[0]);
      const b = start && end ? { name: firstIsStart ? end.name : start.name, dist: 0 } : nearestStation(stations, coords[coords.length - 1]);
      if (!a || !b) continue;
      if (a.dist > SNAP_TOLERANCE_DEG || b.dist > SNAP_TOLERANCE_DEG) continue;
      if (a.name === b.name) continue;
      const meters = pathLengthMeters(coords);
      for (const [from, to] of [
        [a.name, b.name],
        [b.name, a.name],
      ] as const) {
        const edges = graph.adj.get(from) || [];
        const reversed = from === b.name;
        const existing = edges.find((e) => e.to === to);
        if (existing) {
          if (meters < existing.meters) {
            existing.meters = meters;
            existing.path = reversed ? [...coords].reverse() : coords;
          }
        } else {
          edges.push({ to, path: reversed ? [...coords].reverse() : coords, meters });
        }
        graph.adj.set(from, edges);
      }
    }
  }
}

buildLineGraphs();

/** Shortest station-to-station route (by track metres) within one line. */
export function routeStations(
  lineName: string,
  fromName: string,
  toName: string
): string[] | null {
  const graph = lineGraphs.get(lineName);
  if (!graph) return null;
  const norm = (n: string) => normalizeStationName(n);
  const byNorm = new Map(graph.stations.map((s) => [norm(s.name), s.name]));
  const from = byNorm.get(norm(fromName));
  const to = byNorm.get(norm(toName));
  if (!from || !to) return null;
  if (from === to) return [from];

  // Dijkstra over the station graph.
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    let curDist = Infinity;
    for (const [name, d] of dist) {
      if (!done.has(name) && d < curDist) {
        cur = name;
        curDist = d;
      }
    }
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const edge of graph.adj.get(cur) || []) {
      const nd = curDist + edge.meters;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur);
      }
    }
  }

  const route = [to];
  let cursor = to;
  while (cursor !== from) {
    const p = prev.get(cursor);
    if (!p) return null;
    route.unshift(p);
    cursor = p;
  }
  return route;
}

function routePath(graph: LineGraph, route: string[]): { path: Position[]; cumMeters: number[]; totalMeters: number } | null {
  let path: Position[] = [];
  let totalMeters = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const edge = (graph.adj.get(route[i]) || []).find((e) => e.to === route[i + 1]);
    if (!edge) return null;
    path = path.length === 0 ? [...edge.path] : path.concat(edge.path.slice(1));
    totalMeters += edge.meters;
  }
  if (path.length < 2) return null;
  const cumMeters: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cumMeters.push(cumMeters[i - 1] + metersBetween(path[i - 1], path[i]));
  }
  return { path, cumMeters, totalMeters };
}

function buildChain(
  lineName: string,
  targetName: string,
  destinationName: string,
  neededMeters: number
): { path: Position[]; cumMeters: number[]; totalMeters: number; originStation: string } | null {
  const graph = lineGraphs.get(lineName);
  if (!graph) return null;
  const norm = (n: string) => normalizeStationName(n);
  const byNorm = new Map(graph.stations.map((s) => [norm(s.name), s.name]));
  const target = byNorm.get(norm(targetName));
  if (!target) return null;

  // Walk backwards from the target: at each step pick the neighbour that is
  // furthest from the destination (i.e. upstream of the current station).
  const chain = [target];
  let totalMeters = 0;
  let cursor = target;
  for (let leg = 0; leg < MAX_BACKTRACK_LEGS; leg++) {
    const onward = routeStations(lineName, cursor, destinationName);
    const nextHop = onward && onward.length > 1 ? onward[1] : null;
    let best: Edge | null = null;
    let bestDist = -1;
    for (const edge of graph.adj.get(cursor) || []) {
      if (edge.to === nextHop) continue;
      if (chain.includes(edge.to)) continue;
      const r = routeStations(lineName, edge.to, destinationName);
      if (!r) continue;
      const rp = routePath(graph, r);
      if (!rp) continue;
      if (rp.totalMeters > bestDist) {
        bestDist = rp.totalMeters;
        best = edge;
      }
    }
    if (!best) break;
    chain.unshift(best.to);
    totalMeters += best.meters;
    cursor = best.to;
    if (totalMeters >= Math.max(neededMeters, best.meters)) break;
    if (totalMeters >= MAX_BACKTRACK_METERS) break;
  }

  const route = routeStations(lineName, chain[0], target);
  if (!route || route.length < 2) return null;
  const built = routePath(graph, route);
  if (!built) return null;
  return { ...built, originStation: chain[0] };
}

/**
 * Pin a path's ends to the exact station coordinates (track vertices sit a
 * few metres off the station point) and recompute cumulative lengths.
 */
function snapEndpoints(
  built: { path: Position[]; cumMeters: number[]; totalMeters: number },
  originCoords: [number, number] | null,
  targetCoords: [number, number]
): { path: Position[]; cumMeters: number[]; totalMeters: number } {
  const path = [...built.path];
  if (originCoords) path[0] = originCoords;
  path[path.length - 1] = targetCoords;
  const cumMeters: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cumMeters.push(cumMeters[i - 1] + metersBetween(path[i - 1], path[i]));
  }
  return { path, cumMeters, totalMeters: cumMeters[cumMeters.length - 1] };
}

function interpolateAtMeters(path: Position[], cumMeters: number[], meters: number): [number, number] {
  const total = cumMeters[cumMeters.length - 1];
  if (meters <= 0) return [path[0][0], path[0][1]];
  if (meters >= total) {
    const last = path[path.length - 1];
    return [last[0], last[1]];
  }
  let i = 1;
  while (i < cumMeters.length - 1 && cumMeters[i] < meters) i++;
  const segStart = cumMeters[i - 1];
  const segLen = cumMeters[i] - segStart;
  const t = segLen === 0 ? 0 : (meters - segStart) / segLen;
  return [
    path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
    path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
  ];
}

function calculateHeading(from: [number, number], to: [number, number]): number {
  const angle = (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI;
  return (angle + 360) % 360;
}

/**
 * Create or update the motion model for a train when a feed poll arrives.
 * Returns null when the target station can't be placed on the map.
 */
export function updateMotion(
  existing: MotionState | undefined,
  train: MotionTrain,
  now: number
): MotionState | null {
  const lineName = getLineDisplayName(train.lineId);
  const station = (stationsData as FeatureCollection<Point>).features.find(f => f.properties?.id === train.naptanId);
  const targetStation = station?.properties?.name as string || train.currentStation;
  const targetCoords = station?.geometry.coordinates as [number, number] || getStationCoordinates(targetStation);
  if (!targetCoords) return null;
  const absolute = Date.parse(train.expectedArrival || '');
  const arrivalTime = Number.isFinite(absolute) ? absolute : now + Math.max(0, train.timeToStation) * 1000;
  const tts = Math.max(0, (arrivalTime - now) / 1000);

  if (existing && existing.targetStation === targetStation && existing.lineName === lineName) {
    // Keep the already displayed progress. Delayed trains slow/hold rather than
    // reverse along the track; early predictions adjust the remaining journey.
    const progress = progressMeters(existing, now);
    const corrected = Math.abs(arrivalTime - existing.arrivalTime) > ARRIVAL_JITTER_SECONDS * 1000;
    return { ...existing, arrivalTime: corrected ? arrivalTime : existing.arrivalTime,
      startMeters: corrected ? progress : existing.startMeters,
      startedAt: corrected ? now : existing.startedAt, receivedAt: now, destination: train.destination };
  }

  const chain = buildChain(lineName, targetStation, train.destination, tts * AVG_SPEED_MPS);
  let built = chain ? snapEndpoints(chain, getStationCoordinates(chain.originStation), targetCoords) : null;
  let originStation = chain?.originStation || null;
  if (existing && existing.lineName === lineName) {
    // Include the old route, so an early station flip need not teleport a train
    // to the old target. It may still be approaching that station.
    const route = routeStations(lineName, existing.originStation || existing.targetStation, targetStation);
    const routed = route && route.length > 1 ? routePath(lineGraphs.get(lineName)!, route) : null;
    if (routed) {
      originStation = route![0];
      built = snapEndpoints(routed, getStationCoordinates(originStation), targetCoords);
    }
  }
  const path = built?.path || null;
  const cumMeters = built?.cumMeters || [];
  const totalMeters = built?.totalMeters || 0;
  let startMeters = Math.max(0, totalMeters - tts * AVG_SPEED_MPS);
  if (existing && path) {
    const previous = motionTarget(existing, now).position;
    let best = Infinity;
    // Project onto the track, never interpolate a straight chord across town.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const cos = Math.cos(previous[1] * Math.PI / 180);
      const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, (((previous[0]-a[0])*cos)*dx + (previous[1]-a[1])*dy) / (dx*dx+dy*dy || 1)));
      const projected: Position = [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
      const distance = metersBetween(previous, projected);
      if(distance < best) { best = distance; startMeters = cumMeters[i-1] + t*(cumMeters[i]-cumMeters[i-1]); }
    }
    // A different branch/direction is a re-location, not a 1000m/s journey.
    // Reset the estimate at its new plausible position rather than fly off-track.
    if(best > 150) startMeters = Math.max(0, totalMeters-tts*AVG_SPEED_MPS);
  }
  return {trainId: train.id, lineName, targetStation, targetCoords, path, cumMeters,
    totalMeters, arrivalTime, receivedAt: now, destination: train.destination,
    originStation, startMeters, startedAt: now};
}

function progressMeters(state: MotionState, now: number): number {
  // Do not keep fabricating motion indefinitely if updates stop.
  const at = Math.min(now, state.receivedAt + 90_000);
  const duration = Math.max(1000, state.arrivalTime - state.startedAt, (state.totalMeters-state.startMeters)/25*1000);
  const progress = Math.max(0, Math.min(1, (at - state.startedAt) / duration));
  return state.startMeters + (state.totalMeters - state.startMeters) * progress;
}

/**
 * Estimated position and heading at a moment in time. Between stations this
 * is a countdown-based estimate; at the end of the countdown the train holds
 * at the station until the feed advances it.
 */
export function motionTarget(
  state: MotionState,
  now: number
): { position: [number, number]; heading: number } {
  if (!state.path || state.totalMeters <= 0) {
    return { position: state.targetCoords, heading: 0 };
  }
  const clamped = progressMeters(state, now);
  const position = interpolateAtMeters(state.path, state.cumMeters, clamped);
  const before = interpolateAtMeters(state.path, state.cumMeters, Math.max(0, clamped - 15));
  const after = interpolateAtMeters(state.path, state.cumMeters, Math.min(state.totalMeters, clamped + 15));
  const heading =
    before[0] === after[0] && before[1] === after[1] ? 0 : calculateHeading(before, after);
  return { position, heading };
        }
