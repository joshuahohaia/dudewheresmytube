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


it('drops missing/placeholder vehicle IDs rather than moving one marker between unrelated trains',()=>{
 expect(selectNearestEligibleArrivals([arrival('000',30),arrival('',10),arrival('211',40)]).map(a=>a.vehicleId)).toEqual(['211']);
});
it('skips expired cached stations in favour of the next future arrival',()=>{
 const now=1800000000000;
 const expired={...arrival('211',10),expectedArrival:new Date(now-60_000).toISOString()};
 const future={...arrival('211',100),expectedArrival:new Date(now+40_000).toISOString()};
 const result=selectNearestEligibleArrivals([expired,future],300,now);
 expect(result).toHaveLength(1);expect(result[0].expectedArrival).toBe(future.expectedArrival);expect(result[0].timeToStation).toBe(40);
});
