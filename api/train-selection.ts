export interface TflArrival {
  id: string;
  vehicleId: string;
  naptanId: string;
  stationName: string;
  lineId: string;
  lineName: string;
  platformName: string;
  direction: string;
  destinationName: string;
  expectedArrival?: string;
  timestamp?: string;
  timeToStation: number;
}

export const MAX_TIME_TO_STATION_SECONDS = 300;

/**
 * Pick the nearest eligible arrival per vehicle.
 *
 * The filter is applied BEFORE deduplication: a vehicle whose first-listed
 * prediction is over the limit must not cause its nearer predictions to be
 * dropped. The result is independent of the order TfL returns predictions in.
 */
export function selectNearestEligibleArrivals(
  arrivals: TflArrival[],
  maxTimeToStation: number = MAX_TIME_TO_STATION_SECONDS,
  now: number = Date.now()
): TflArrival[] {
  const nearestByVehicle = new Map<string, TflArrival>();

  for (const arrival of arrivals) {
    if (!arrival.vehicleId || /^0+$/.test(arrival.vehicleId)) continue;
    const expected = Date.parse(arrival.expectedArrival || '');
    const remaining = Number.isFinite(expected) ? (expected - now) / 1000 : arrival.timeToStation;
    // Cached feeds can still list a station the train was due to pass a minute
    // ago. Prefer its next future station, not that expired prediction.
    if (remaining < -15 || remaining > maxTimeToStation) continue;
    const candidate = { ...arrival, timeToStation: Math.max(0, remaining) };

    const current = nearestByVehicle.get(arrival.vehicleId);
    if (!current || candidate.timeToStation < current.timeToStation) {
      nearestByVehicle.set(arrival.vehicleId, candidate);
    }
  }

  return Array.from(nearestByVehicle.values());
}
