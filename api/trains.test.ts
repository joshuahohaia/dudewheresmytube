import {it,expect,vi,beforeEach} from 'vitest';
import { FeedError } from './tfl-feed';
const load=vi.hoisted(()=>vi.fn());
vi.mock('./tfl-feed.js',async(importOriginal)=>({...await importOriginal<typeof import('./tfl-feed')>(),createFeedLoader:()=>load}));
import handler from './trains';
import type {VercelRequest,VercelResponse} from '@vercel/node';
function response(){const headers:Record<string,string>={};const res={setHeader:vi.fn((k:string,v:string)=>headers[k]=v),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return {res:res as unknown as VercelResponse,headers,mock:res};}
beforeEach(()=>{load.mockReset();});
it('returns a non-cacheable503 with Retry-After on total failure',async()=>{vi.spyOn(console,'error').mockImplementation(()=>{});load.mockImplementation(async()=>{throw new FeedError('TfL arrivals returned429',60,429)});const r=response();await handler({} as VercelRequest,r.res);expect(r.mock.status).toHaveBeenCalledWith(503);expect(r.headers['Cache-Control']).toBe('no-store');expect(r.headers['Retry-After']).toBe('60');});
it('caches successful batches with a bounded stale window and dedups per line',async()=>{load.mockResolvedValue({timestamp:1000,arrivals:[{vehicleId:'211',lineId:'central',timeToStation:30},{vehicleId:'211',lineId:'victoria',timeToStation:20}]});const r=response();await handler({} as VercelRequest,r.res);expect(r.headers['Cache-Control']).toBe('public, s-maxage=30, stale-while-revalidate=15');expect(r.mock.json.mock.calls[0][0].trains).toHaveLength(2);expect(r.mock.json.mock.calls[0][0].failedLines).toEqual([]);});
