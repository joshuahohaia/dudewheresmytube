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
    refetchInterval: 15000, // Poll every 15 seconds (44 req/min, under 50 limit)
    staleTime: 12000, // Consider data fresh for 12 seconds
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}
