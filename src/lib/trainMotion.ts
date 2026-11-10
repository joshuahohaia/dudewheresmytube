import type { StationPrediction } from '../types/train';
import { motionLines as linesData, motionStations as stationsData } from './motionData';
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
 * waits at the station unless the same feed includes a directly connected
 * downstream prediction. In that case a labelled estimated dwell precedes
 * onward motion; this is not an observed departure.
 */

// Average line speed including intermediate dwell (~32 km/h). Used only to
// spread the countdown over track distance; arrival stays anchored to tts=0.
const AVG_SPEED_MPS = 9;
// How far back from the target station we place a train when its countdown is
// long (the feed caps predictions at 300s out).
const MAX_BACKTRACK_LEGS = 6;
const MAX_BACKTRACK_METERS = 4000;
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
  timestamp?: string;
  predictions?: StationPrediction[];
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
  future?: MotionState[];
  sourceAt?: number;
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


const lineGraphs = new Map<string, LineGraph>();

function buildLineGraphs() {
  const lineFeatures = (linesData as FeatureCollection<LineString>).features;
  const stationFeatures = (stationsData as FeatureCollection<Point>).features;
  const stationsById = new Map(stationFeatures.map(f => [f.properties?.id as string, {
    name: f.properties?.name as string, coords: f.geometry.coordinates as [number, number],
  }]));
  const byLine = new Map<string, { path: Position[]; from: string; to: string }[]>();
  for (const feature of lineFeatures) {
    const path = feature.geometry?.coordinates;
    if (!path || path.length < 2) continue;
    for (const line of feature.properties?.lines || []) {
      // No nearest-station guesses for proposed tracks or unidentified branches.
      if (!stationsById.has(line.start_sid) || !stationsById.has(line.end_sid)) continue;
      const list = byLine.get(line.name) || [];
      list.push({ path, from: line.start_sid, to: line.end_sid });
      byLine.set(line.name, list);
    }
  }

  for (const [lineName, fragments] of byLine) {
    // A feature is a geometry fragment, not necessarily an entire station leg.
    // Several fragments can share the same (possibly reversed) station IDs.
    // Join only nearly coincident geometry endpoints, then find the complete
    // track path between the endpoints associated with each declared station.
    const points: Position[] = [];
    const fragmentNodes = fragments.map(f => f.path.map(point => { points.push(point); return points.length - 1; }));
    const links: { to: number; meters: number; path: Position[] }[][] = points.map(() => []);
    const connect = (a: number, b: number) => {
      const meters = metersBetween(points[a], points[b]);
      links[a].push({ to: b, meters, path: [points[a], points[b]] });
      links[b].push({ to: a, meters, path: [points[b], points[a]] });
    };
    for (const nodes of fragmentNodes) for (let i = 1; i < nodes.length; i++) connect(nodes[i - 1], nodes[i]);
    // A branch endpoint can meet an existing segment between its vertices.
    // Attach only when its projection is within the small drawing tolerance.
    for (const nodes of fragmentNodes) for (const endpoint of [nodes[0], nodes[nodes.length - 1]]) {
      const p = points[endpoint];
      const cos = Math.cos(p[1] * Math.PI / 180);
      for (const otherNodes of fragmentNodes) {
        if (otherNodes === nodes) continue;
        for (let i = 1; i < otherNodes.length; i++) {
          const ai = otherNodes[i - 1], bi = otherNodes[i];
          const a = points[ai], b = points[bi];
          const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, (((p[0] - a[0]) * cos) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          const projected = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
          if (metersBetween(p, projected) > 10) continue;
          for (const node of [ai, bi]) {
            const path = [p, projected, points[node]];
            const meters = pathLengthMeters(path);
            links[endpoint].push({ to: node, meters, path });
            links[node].push({ to: endpoint, meters, path: [...path].reverse() });
          }
        }
      }
    }
    const candidates = new Map<string, number[]>();
    for (let i = 0; i < fragments.length; i++) for (const id of [fragments[i].from, fragments[i].to]) {
      const nodes = fragmentNodes[i];
      candidates.set(id, [...(candidates.get(id) || []), nodes[0], nodes[nodes.length - 1]]);
    }
    // TfL Metropolitan Route/Sequence/outbound lists Willesden Green on
    // the Amersham-Aldgate stopping route (checked 2026-11-10). Its point
    // already sits on the stored Metropolitan track geometry. Keep both
    // the existing express leg and these explicitly supported stopping legs.
    const additionalPairs: { from: string; to: string }[] = [];
    if (lineName === 'Metropolitan') {
      const id = '940GZZLUWIG';
      const station = stationsById.get(id)!;
      const nodes = points.flatMap((point, i) => metersBetween(station.coords, point) <= 10 ? [i] : []);
      if (nodes.length) {
        candidates.set(id, nodes);
        additionalPairs.push({ from: '940GZZLUWYP', to: id }, { from: id, to: '940GZZLUFYR' });
      }
    }
    const anchors = new Map<string, number>();
    for (const [id, nodes] of candidates) {
      const station = stationsById.get(id)!;
      const nearest = nodes.reduce((a, b) => metersBetween(station.coords, points[a]) < metersBetween(station.coords, points[b]) ? a : b);
      anchors.set(id, nearest);
      // Multiple source fragments can end at different sides of the same
      // station symbol. Join only its explicitly tagged nearby endpoints.
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        if (metersBetween(points[nodes[i]], points[nodes[j]]) <= 40) connect(nodes[i], nodes[j]);
      }
    }
    const graph: LineGraph = { stations: [...anchors.keys()].map(id => stationsById.get(id)!), adj: new Map() };
    lineGraphs.set(lineName, graph);
    const pairs = new Set<string>();
    for (const fragment of [...fragments, ...additionalPairs]) {
      const key = [fragment.from, fragment.to].sort().join('|');
      if (pairs.has(key)) continue;
      pairs.add(key);
      const start = anchors.get(fragment.from)!;
      const end = anchors.get(fragment.to)!;
      const dist = new Map<number, number>([[start, 0]]);
      const prev = new Map<number, { from: number; path: Position[] }>();
      const queue = [{ node: start, meters: 0 }];
      while (queue.length) {
        queue.sort((a, b) => b.meters - a.meters);
        const current = queue.pop()!;
        if (current.meters !== dist.get(current.node)) continue;
        if (current.node === end) break;
        for (const edge of links[current.node]) {
          const next = current.meters + edge.meters;
          if (next < (dist.get(edge.to) ?? Infinity)) {
            dist.set(edge.to, next);
            prev.set(edge.to, { from: current.node, path: edge.path });
            queue.push({ node: edge.to, meters: next });
          }
        }
      }
      if (!dist.has(end) || start === end) continue;
      const parts: Position[][] = [];
      let cursor = end;
      while (cursor !== start) {
        const step = prev.get(cursor)!;
        parts.unshift(step.path);
        cursor = step.from;
      }
      const path = parts.flatMap((part, i) => i ? part.slice(1) : part);
      const from = stationsById.get(fragment.from)!;
      const to = stationsById.get(fragment.to)!;
      const meters = pathLengthMeters(path);
      graph.adj.set(from.name, [...(graph.adj.get(from.name) || []), { to: to.name, path, meters }]);
      graph.adj.set(to.name, [...(graph.adj.get(to.name) || []), { to: from.name, path: [...path].reverse(), meters }]);
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
function updateSingleMotion(
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
    const route = routeStations(lineName, existing.targetStation, targetStation);
    const onward = route && route.length > 1 ? routePath(lineGraphs.get(lineName)!, route) : null;
    if (onward) {
      originStation = existing.originStation || existing.targetStation;
      // Keep the previous approach as a prefix. Shortest origin-to-new-target
      // routes can skip the train's actual displayed position at junctions.
      const previousProgress = progressMeters(existing, now);
      const index = existing.cumMeters.findIndex(m => m > previousProgress);
      const suffix = existing.path && index >= 0 ? existing.path.slice(index) : [];
      const previousPosition = motionTarget(existing, now).position;
      const joined = existing.path ? [previousPosition, ...suffix, ...onward.path.slice(1)] : onward.path;
      const cumulative = [0];
      for(let i=1;i<joined.length;i++) cumulative.push(cumulative[i-1]+metersBetween(joined[i-1],joined[i]));
      built = snapEndpoints({path:joined,cumMeters:cumulative,totalMeters:cumulative[cumulative.length-1]},null,targetCoords);
    }
  }
  // An arrival prediction is not an observed station position. Unsupported
  // line/station combinations must not snap a train to a future target.
  // Return unavailable rather than interpolate a route we cannot establish.
  if (!built) return null;
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

/** Plan only immediate, explicitly predicted next stops. A 20s dwell is an
 * estimate, never a claim that TfL reported a departure. Unknown branches stop. */
export function updateMotion(existing: MotionState | undefined, train: MotionTrain, now: number): MotionState | null {
  const sourceAt = Date.parse(train.timestamp || '');
  // An identical source snapshot must not restart dwell or undo its own plan.
  if (existing && Number.isFinite(sourceAt) && existing.sourceAt !== undefined && sourceAt <= existing.sourceAt) return existing;
  const active = existing ? activeMotion(existing, now).state : undefined;
  // A cached nearest-stop record can lag behind our already active predicted
  // leg. Do not reverse to that old stop if the same feed confirms this leg.
  const continuing = active && Date.parse(train.expectedArrival || '') < now
    ? train.predictions?.find(p => p.naptanId && (stationsData as FeatureCollection<Point>).features.some(f => f.properties?.id === p.naptanId && f.properties?.name === active.targetStation)) : undefined;
  if (continuing) train = {...train, currentStation:continuing.station, naptanId:continuing.naptanId,
    expectedArrival:continuing.expectedArrival, predictions:train.predictions?.filter(p => Date.parse(p.expectedArrival) > Date.parse(continuing.expectedArrival))};
  const base = updateSingleMotion(active ? {...active, future: undefined} : undefined, train, now);
  if (!base) return null;
  base.sourceAt = Number.isFinite(sourceAt) ? sourceAt : undefined;
  base.future = [];
  if (!Number.isFinite(sourceAt) || now - sourceAt > 180_000 || sourceAt > now + 5000) return base;
  let previous = base;
  for (const prediction of (train.predictions || []).slice(0, 3)) {
    const station = (stationsData as FeatureCollection<Point>).features.find(f => f.properties?.id === prediction.naptanId);
    const name = station?.properties?.name as string | undefined;
    const arrival = Date.parse(prediction.expectedArrival);
    const route = name ? routeStations(base.lineName, previous.targetStation, name) : null;
    // Require a directly connected next station. No skipped stops or inferred fork.
    if (!name || !route || route.length !== 2 || !Number.isFinite(arrival)) break;
    // A speed-limited late approach must finish before dwell begins.
    const reachedAt = previous.startedAt + Math.max(1000, previous.arrivalTime - previous.startedAt, (previous.totalMeters - previous.startMeters) / 25 * 1000);
    const departure = Math.max(now, reachedAt + 20_000);
    if (arrival <= departure || arrival > now + 300_000) break;
    const next = updateSingleMotion({...previous, future:undefined}, {...train,currentStation:name,naptanId:prediction.naptanId,expectedArrival:prediction.expectedArrival,predictions:undefined}, departure);
    if (!next?.path) break;
    next.sourceAt = sourceAt;
    base.future.push(next);
    previous = next;
  }
  return base;
}

// Experimental bounded estimate window, not a freshness assertion. Our
// 2026-11-10 capture saw source ages of 61-135s and ~60s upstream batches.
// 180s covers that observed delivery window with a small margin. Accuracy is
// still unknown; data older than 90s is visibly marked as an older estimate.
// Never keep moving for 180s after receipt: the cutoff is SOURCE time + 180s.
const EXTRAPOLATION_CAP_MS = 180_000;

function motionCutoff(state: MotionState): number {
  if (state.sourceAt === undefined) return state.receivedAt + 90_000;
  // A malformed future timestamp must not buy indefinite extrapolation.
  if (state.sourceAt > state.receivedAt + 5000) return state.receivedAt;
  return state.sourceAt + EXTRAPOLATION_CAP_MS;
}

function activeMotion(state: MotionState, now: number): {state: MotionState; at: number} {
  const cutoff = motionCutoff(state);
  const at = Math.min(now, cutoff);
  let active = state;
  for (const next of state.future || []) {
    if (next.startedAt <= at) active = next;
    else break;
  }
  return {state:active, at};
}

export function motionStatus(state: MotionState, now: number) {
  const active = activeMotion(state, now).state;
  const sourceAgeSeconds = state.sourceAt === undefined || state.sourceAt > now + 5000
    ? undefined : Math.max(0, Math.floor((now - state.sourceAt) / 1000));
  return {target:active.targetStation, arrivalTime:active.arrivalTime,
    sourceAgeSeconds, held:now >= motionCutoff(state),
    stale:sourceAgeSeconds === undefined || now - state.sourceAt! > 90_000};
}

function progressMeters(state: MotionState, now: number): number {
  // Do not keep fabricating motion indefinitely if updates stop.
  const at = Math.min(now, motionCutoff(state));
  const duration = Math.max(1000, state.arrivalTime - state.startedAt, (state.totalMeters-state.startMeters)/25*1000);
  const progress = Math.max(0, Math.min(1, (at - state.startedAt) / duration));
  return state.startMeters + (state.totalMeters - state.startMeters) * progress;
}

/**
 * Estimated position and heading at a moment in time. Between stations this
 * is a countdown-based estimate; at the end of the countdown the train holds
 * at the station unless an explicit downstream prediction supplies an onward leg.
 */
export function motionTarget(
  state: MotionState,
  now: number
): { position: [number, number]; heading: number } {
  const active = activeMotion(state, now);
  state = active.state;
  now = active.at;
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
