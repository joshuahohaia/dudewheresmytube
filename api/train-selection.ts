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
  maxTimeToStation: number = MAX_TIME_TO_STATION_SECONDS
): TflArrival[] {
  const nearestByVehicle = new Map<string, TflArrival>();

  for (const arrival of arrivals) {
    if (arrival.timeToStation > maxTimeToStation) continue;

    const current = nearestByVehicle.get(arrival.vehicleId);
    if (!current || arrival.timeToStation < current.timeToStation) {
      nearestByVehicle.set(arrival.vehicleId, arrival);
    }
  }

  return Array.from(nearestByVehicle.values());
}
