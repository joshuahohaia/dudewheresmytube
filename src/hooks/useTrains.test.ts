import {it,expect,vi,afterEach} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();});
it('honors Retry-After without another network request during cooldown',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1800000000000);
 const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:503,headers:{'Retry-After':'60'}})).mockResolvedValueOnce(Response.json({trains:[]}));
 vi.stubGlobal('fetch',fetcher);const {fetchTrains,TrainFeedError}=await import('./useTrains');
 await expect(fetchTrains()).rejects.toBeInstanceOf(TrainFeedError);
 vi.advanceTimersByTime(10_000);await expect(fetchTrains()).rejects.toBeInstanceOf(TrainFeedError);expect(fetcher).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(50_000);await fetchTrains();expect(fetcher).toHaveBeenCalledTimes(2);
});
