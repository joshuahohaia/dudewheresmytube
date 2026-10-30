import { describe, it, expect } from 'vitest';
import { selectNearestEligibleArrivals, type TflArrival } from './train-selection';

function arrival(vehicleId: string, timeToStation: number): TflArrival {
  return {
    id: `${vehicleId}-${timeToStation}`,
    vehicleId,
    naptanId: '940GZZLUTEST',
    stationName: 'Test Underground Station',
    lineId: 'central',
    lineName: 'Central',
    platformName: 'Platform 1',
    direction: 'eastbound',
    destinationName: 'Epping Underground Station',
    timeToStation,
  };
}

describe('selectNearestEligibleArrivals', () => {
  it('keeps a near prediction even when a far prediction for the same vehicle is listed first', () => {
    // Regression: previously the first prediction per vehicle was kept and
    // filtered, so [600, 60] dropped the vehicle entirely while [60, 600]
    // kept it.
    const result = selectNearestEligibleArrivals([arrival('v1', 600), arrival('v1', 60)]);
    expect(result).toHaveLength(1);
    expect(result[0].timeToStation).toBe(60);
  });

  it('is independent of prediction order', () => {
    const forward = selectNearestEligibleArrivals([arrival('v1', 600), arrival('v1', 60)]);
    const reversed = selectNearestEligibleArrivals([arrival('v1', 60), arrival('v1', 600)]);
    expect(forward).toEqual(reversed);
  });

  it('keeps the nearest eligible prediction when several are under the limit', () => {
    const result = selectNearestEligibleArrivals([arrival('v1', 240), arrival('v1', 60)]);
    expect(result).toHaveLength(1);
    expect(result[0].timeToStation).toBe(60);
  });

  it('keeps distinct vehicles separately', () => {
    const result = selectNearestEligibleArrivals([arrival('v1', 30), arrival('v2', 45)]);
    expect(result.map((a) => a.vehicleId).sort()).toEqual(['v1', 'v2']);
  });

  it('drops a vehicle entirely when all its predictions are over the limit', () => {
    const result = selectNearestEligibleArrivals([arrival('v1', 301), arrival('v1', 900)]);
    expect(result).toHaveLength(0);
  });

  it('keeps a prediction exactly at the limit', () => {
    const result = selectNearestEligibleArrivals([arrival('v1', 300)]);
    expect(result).toHaveLength(1);
  });

  it('handles an empty feed', () => {
    expect(selectNearestEligibleArrivals([])).toEqual([]);
  });
});
