import { describe, it, expect, vi } from 'vitest';
import {createFeedLoader, FeedError} from './tfl-feed';
const arrival={lineId:'central',vehicleId:'211',timeToStation:30};
function mockFetch(responses: Response[]) {return vi.fn(async()=>responses.shift()!) as unknown as typeof fetch;}
describe('batched feed reliability',()=>{
 it('requests all lines once, caches for30s, and coalesces concurrent requests',async()=>{
  let now=1000;const fetcher=mockFetch([Response.json([arrival]),Response.json([arrival])]);const load=createFeedLoader(fetcher,()=>now);
  const [a,b]=await Promise.all([load(),load()]);expect(a).toBe(b);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(fetcher).mock.calls[0][0])).toContain('bakerloo,central,circle,district');
  now+=29_000;await load();expect(fetcher).toHaveBeenCalledTimes(1);
  now+=2000;await load();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('honors429 Retry-After without hammering retries',async()=>{
  let now=1000;const fetcher=mockFetch([new Response('',{status:429,headers:{'Retry-After':'90'}}),Response.json([arrival])]);const load=createFeedLoader(fetcher,()=>now);
  await expect(load()).rejects.toMatchObject({retryAfterSeconds:90,upstreamStatus:429});
  now+=30_000;await expect(load()).rejects.toBeInstanceOf(FeedError);expect(fetcher).toHaveBeenCalledTimes(1);
  now+=60_000;await load();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('does not reuse an expired success after an upstream failure',async()=>{
  let now=1000;const fetcher=mockFetch([Response.json([arrival]),new Response('',{status:500})]);const load=createFeedLoader(fetcher,()=>now);
  await load();now+=31_000;await expect(load()).rejects.toMatchObject({upstreamStatus:500});await expect(load()).rejects.toBeInstanceOf(FeedError);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('accepts an empty service-hour feed without inventing line failures',async()=>{expect((await createFeedLoader(mockFetch([Response.json([])]))()).arrivals).toEqual([]);});
 it('rejects malformed data with bounded failure backoff',async()=>{const fetcher=mockFetch([Response.json({error:'bad'})]);const load=createFeedLoader(fetcher);await expect(load()).rejects.toBeInstanceOf(FeedError);await expect(load()).rejects.toBeInstanceOf(FeedError);expect(fetcher).toHaveBeenCalledTimes(1);});
 it('backs off network failures',async()=>{const fetcher=vi.fn().mockRejectedValue(new Error('network')) as typeof fetch;const load=createFeedLoader(fetcher);await expect(load()).rejects.toBeInstanceOf(FeedError);await expect(load()).rejects.toBeInstanceOf(FeedError);expect(fetcher).toHaveBeenCalledTimes(1);});
});
