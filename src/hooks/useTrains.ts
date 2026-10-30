import { useQuery } from '@tanstack/react-query';
import type { TrainsResponse } from '../types/train';

export class TrainFeedError extends Error {
  retryAt: number;
  constructor(message: string, retryAt: number) { super(message); this.retryAt = retryAt; }
}
let nextAttemptAt = 0;

export async function fetchTrains(): Promise<TrainsResponse> {
  if (Date.now() < nextAttemptAt) throw new TrainFeedError('TfL is rate-limiting requests. Retrying shortly.', nextAttemptAt);
  const response = await fetch('/api/trains');
  if (!response.ok) {
    const delay = Number(response.headers.get('Retry-After'));
    if(response.status === 503 || response.status === 429) {
      nextAttemptAt = Date.now() + Math.max(1, Math.min(300, delay || 15)) * 1000;
      throw new TrainFeedError('TfL feed temporarily unavailable. Retrying shortly.', nextAttemptAt);
    }
    throw new Error(`Failed to fetch trains: ${response.status}`);
  }
  nextAttemptAt = 0;
  return response.json();
}

export function useTrains() {
  return useQuery({
    queryKey: ['trains'],
    queryFn: fetchTrains,
    refetchInterval: 10000, // UI cadence unchanged; successful batched feed cached for 30s
    staleTime: 8000, // Consider data fresh for 8 seconds
    refetchOnWindowFocus: true,
    retry: (count, error) => !(error instanceof TrainFeedError) && count < 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}
