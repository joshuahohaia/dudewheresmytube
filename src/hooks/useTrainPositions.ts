import { useEffect, useRef, useState, useCallback } from 'react';
import type { Train, TrainWithPosition } from '../types/train';
import { getStationCoordinates } from '../lib/stationLookup';

interface TrainKeyframe {
  position: [number, number];
  timestamp: number;
  timeToStation: number;
}

interface TrainState {
  current: TrainKeyframe;
  previous: TrainKeyframe | null;
  train: Train;
  trail: [number, number][];
  velocity: [number, number]; // Direction of movement
}

// Smooth easing
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

// Linear interpolation
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Calculate heading (bearing) between two points
function calculateHeading(from: [number, number], to: [number, number]): number {
  const dLng = to[0] - from[0];
  const dLat = to[1] - from[1];
  const angle = Math.atan2(dLng, dLat) * (180 / Math.PI);
  return (angle + 360) % 360;
}

const INTERPOLATION_DURATION = 15000; // 15 seconds between updates
const TRAIL_LENGTH = 15;
const PREDICTION_SPEED = 0.00001; // Speed for predictive movement

export function useTrainPositions(trains: Train[] | undefined) {
  const [positions, setPositions] = useState<TrainWithPosition[]>([]);
  const trainStates = useRef<Map<string, TrainState>>(new Map());
  const animationRef = useRef<number>();

  // Update train states when new data arrives
  useEffect(() => {
    if (!trains) return;

    const now = Date.now();

    trains.forEach((train) => {
      const coords = getStationCoordinates(train.currentStation);
      if (!coords) return;

      const existing = trainStates.current.get(train.id);

      if (existing) {
        // Calculate velocity from movement
        const dx = coords[0] - existing.current.position[0];
        const dy = coords[1] - existing.current.position[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Normalize velocity
        const velocity: [number, number] = dist > 0.0001
          ? [dx / dist * PREDICTION_SPEED, dy / dist * PREDICTION_SPEED]
          : existing.velocity;

        trainStates.current.set(train.id, {
          previous: existing.current,
          current: { position: coords, timestamp: now, timeToStation: train.timeToStation },
          train,
          trail: existing.trail,
          velocity,
        });
      } else {
        trainStates.current.set(train.id, {
          previous: null,
          current: { position: coords, timestamp: now, timeToStation: train.timeToStation },
          train,
          trail: [coords],
          velocity: [0, 0],
        });
      }
    });

    // Remove stale trains (not seen for 60 seconds)
    const currentIds = new Set(trains.map((t) => t.id));
    for (const [id, state] of trainStates.current.entries()) {
      if (!currentIds.has(id) && now - state.current.timestamp > 60000) {
        trainStates.current.delete(id);
      }
    }
  }, [trains]);

  // Animation loop
  const animate = useCallback(() => {
    const now = Date.now();
    const result: TrainWithPosition[] = [];

    trainStates.current.forEach((state) => {
      const { current, previous, train, trail, velocity } = state;

      let position: [number, number];
      let heading = 0;

      if (previous) {
        const elapsed = now - current.timestamp;
        const rawProgress = Math.min(elapsed / INTERPOLATION_DURATION, 1);
        const progress = easeOutQuad(rawProgress);

        // Interpolate between previous and current
        position = [
          lerp(previous.position[0], current.position[0], progress),
          lerp(previous.position[1], current.position[1], progress),
        ];

        // After reaching target, continue with predictive movement
        if (rawProgress >= 1 && (velocity[0] !== 0 || velocity[1] !== 0)) {
          const extraTime = (elapsed - INTERPOLATION_DURATION) / 1000;
          position = [
            position[0] + velocity[0] * extraTime * 0.3,
            position[1] + velocity[1] * extraTime * 0.3,
          ];
        }

        // Calculate heading
        heading = calculateHeading(previous.position, current.position);

        // Update trail
        const lastTrailPos = trail[trail.length - 1];
        const dist = Math.abs(position[0] - lastTrailPos[0]) + Math.abs(position[1] - lastTrailPos[1]);
        if (dist > 0.00005) {
          state.trail = [...trail, position].slice(-TRAIL_LENGTH);
        }
      } else {
        position = current.position;
      }

      result.push({
        ...train,
        position,
        heading,
      });
    });

    setPositions(result);
    animationRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    animationRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [animate]);

  const getTrails = useCallback(() => {
    const trails: Array<{
      id: string;
      lineId: string;
      lineName: string;
      coordinates: [number, number][];
    }> = [];

    trainStates.current.forEach((state, id) => {
      if (state.trail.length > 1) {
        trails.push({
          id,
          lineId: state.train.lineId,
          lineName: state.train.lineName,
          coordinates: state.trail,
        });
      }
    });

    return trails;
  }, []);

  return { positions, getTrails };
}
