import { useQuery } from '@tanstack/react-query';
import type { TrainsResponse } from '../types/train';

async function fetchTrains(): Promise<TrainsResponse> {
  const response = await fetch('/api/trains');
  if (!response.ok) {
    throw new Error(`Failed to fetch trains: ${response.status}`);
  }
  return response.json();
}

export function useTrains() {
  return useQuery({
    queryKey: ['trains'],
    queryFn: fetchTrains,
    refetchInterval: 10000, // Poll every 10 seconds (Vercel caches for 10s)
    staleTime: 8000, // Consider data fresh for 8 seconds
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}
