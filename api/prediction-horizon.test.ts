import {it,expect} from 'vitest';import {predictionHorizon} from './prediction-horizon';import type {TflArrival} from './train-selection';
const now=1800000000000;
const base={lineId:'bakerloo',vehicleId:'211',naptanId:'a',expectedArrival:new Date(now+10000).toISOString(),timestamp:new Date(now).toISOString(),destinationName:'Elephant & Castle',direction:'inbound',stationName:'A',timeToStation:10} as TflArrival;
it('retains only sorted same-service future stations, capped at3',()=>{
 const rows=[50,30,70,90,110].map((t,i)=>({...base,naptanId:String(i),stationName:String(i),expectedArrival:new Date(now+t*1000).toISOString()}));
 expect(predictionHorizon(rows,base,now).map(p=>p.naptanId)).toEqual(['1','0','2']);
 expect(predictionHorizon([{...rows[0],vehicleId:'212'},{...rows[0],direction:'outbound'},{...rows[0],destinationName:'Other'}],base,now)).toEqual([]);
});
it('does not extend stale or untimed predictions',()=>{expect(predictionHorizon([{...base,naptanId:'b'}],{...base,timestamp:new Date(now-91000).toISOString()},now)).toEqual([]);expect(predictionHorizon([base],{...base,expectedArrival:undefined},now)).toEqual([]);});
it('deduplicates station IDs',()=>{const a={...base,naptanId:'b',expectedArrival:new Date(now+30000).toISOString()};expect(predictionHorizon([a,a],base,now)).toHaveLength(1);});
