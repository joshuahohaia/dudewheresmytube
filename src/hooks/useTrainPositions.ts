import { useEffect, useRef, useState, useCallback } from 'react';
import type { Train, TrainWithPosition } from '../types/train';
import { getStationCoordinates } from '../lib/stationLookup';
import { findTrackPath, interpolateAlongPath, getLineDisplayName } from '../lib/trackGeometry';
import type { Position } from 'geojson';

interface TrainKeyframe {
  position: [number, number];
  timestamp: number;
}

interface TrainState {
  current: TrainKeyframe;
  previous: TrainKeyframe | null;
  train: Train;
  trail: [number, number][];
  trackPath: Position[] | null; // Path along the actual track geometry
  lastInterpolatedPosition: [number, number] | null; // Current visual position for smooth transitions
  velocity: [number, number]; // Current velocity for momentum-based easing
}

// Smooth easing - slow start and end, fast middle
function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

// Ease out cubic - fast start, slow end (good for momentum)
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Smooth start with momentum preservation
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Linear interpolation
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Smooth damp - spring-like interpolation with velocity
function smoothDamp(
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  deltaTime: number
): { value: number; velocity: number } {
  // Based on Game Programming Gems 4 smooth damp
  const omega = 2 / smoothTime;
  const x = omega * deltaTime;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * deltaTime;
  const newVelocity = (velocity - omega * temp) * exp;
  const newValue = target + (change + temp) * exp;

  // Prevent overshooting
  if ((target - current > 0) === (newValue > target)) {
    return { value: target, velocity: 0 };
  }

  return { value: newValue, velocity: newVelocity };
}

// Calculate heading between two points
function calculateHeading(from: [number, number], to: [number, number]): number {
  const dLng = to[0] - from[0];
  const dLat = to[1] - from[1];
  const angle = Math.atan2(dLng, dLat) * (180 / Math.PI);
  return (angle + 360) % 360;
}

const ANIMATION_DURATION = 14000; // Animate over 14 seconds (just under 15s refresh)
const TRAIL_LENGTH = 20;
const SMOOTH_TIME = 0.5; // Smoothing factor for velocity-based movement (seconds)
let lastFrameTime = Date.now();

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
        // Only update if station changed or it's a new position
        const posChanged =
          coords[0] !== existing.current.position[0] ||
          coords[1] !== existing.current.position[1];

        if (posChanged) {
          // Use the current interpolated position as starting point for smooth transition
          // This prevents the train from jumping back to the previous station
          const startPosition = existing.lastInterpolatedPosition || existing.current.position;

          // Find the track path between current visual position and new station
          const lineName = getLineDisplayName(train.lineId);
          const trackPath = findTrackPath(
            startPosition,
            coords,
            lineName
          );

          trainStates.current.set(train.id, {
            previous: { position: startPosition, timestamp: existing.current.timestamp },
            current: { position: coords, timestamp: now },
            train,
            trail: existing.trail,
            trackPath,
            lastInterpolatedPosition: startPosition,
            velocity: existing.velocity, // Preserve momentum
          });
        } else {
          // Same position, just update train data
          existing.train = train;
        }
      } else {
        // New train
        trainStates.current.set(train.id, {
          previous: null,
          current: { position: coords, timestamp: now },
          train,
          trail: [coords],
          trackPath: null,
          lastInterpolatedPosition: coords,
          velocity: [0, 0],
        });
      }
    });

    // Remove stale trains
    const currentIds = new Set(trains.map((t) => t.id));
    for (const [id, state] of trainStates.current.entries()) {
      if (!currentIds.has(id)) {
        trainStates.current.delete(id);
      }
    }
  }, [trains]);

  // Animation loop - runs at 60fps
  const animate = useCallback(() => {
    const now = Date.now();
    const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.1); // Cap delta to prevent jumps
    lastFrameTime = now;

    const result: TrainWithPosition[] = [];

    trainStates.current.forEach((state) => {
      const { current, previous, train, trail, trackPath, velocity } = state;

      let position: [number, number];
      let heading = 0;

      if (previous) {
        // Calculate animation progress
        const elapsed = now - current.timestamp;
        const rawProgress = Math.min(elapsed / ANIMATION_DURATION, 1);
        const progress = easeInOutQuad(rawProgress);

        // Calculate target position along track or straight line
        let targetPosition: [number, number];

        if (trackPath && trackPath.length >= 2) {
          // Target is along the actual track geometry
          targetPosition = interpolateAlongPath(trackPath, progress);

          // Calculate heading from nearby points on the path
          const prevProgress = Math.max(0, progress - 0.05);
          const nextProgress = Math.min(1, progress + 0.05);
          const prevPos = interpolateAlongPath(trackPath, prevProgress);
          const nextPos = interpolateAlongPath(trackPath, nextProgress);
          heading = calculateHeading(prevPos, nextPos);
        } else {
          // Fallback to straight line
          targetPosition = [
            lerp(previous.position[0], current.position[0], progress),
            lerp(previous.position[1], current.position[1], progress),
          ];

          if (previous.position[0] !== current.position[0] ||
              previous.position[1] !== current.position[1]) {
            heading = calculateHeading(previous.position, current.position);
          }
        }

        // Apply velocity-based smooth damping for fluid motion
        const currentPos = state.lastInterpolatedPosition || previous.position;

        const smoothX = smoothDamp(
          currentPos[0],
          targetPosition[0],
          velocity[0],
          SMOOTH_TIME,
          deltaTime
        );

        const smoothY = smoothDamp(
          currentPos[1],
          targetPosition[1],
          velocity[1],
          SMOOTH_TIME,
          deltaTime
        );

        position = [smoothX.value, smoothY.value];
        state.velocity = [smoothX.velocity, smoothY.velocity];

        // Store current position for smooth transitions when new data arrives
        state.lastInterpolatedPosition = position;

        // Update trail
        const lastTrailPos = trail[trail.length - 1];
        const dist = Math.abs(position[0] - lastTrailPos[0]) + Math.abs(position[1] - lastTrailPos[1]);
        if (dist > 0.00003) {
          state.trail = [...trail, position].slice(-TRAIL_LENGTH);
        }
      } else {
        // New train, no animation yet
        position = current.position;
        state.lastInterpolatedPosition = position;
        state.velocity = [0, 0];
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

  // Start animation loop
  useEffect(() => {
    animationRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [animate]);

  // Get trails for rendering
  const getTrails = useCallback(() => {
    const trails: Array<{
      id: string;
      lineId: string;
      lineName: string;
      coordinates: [number, number][];
    }> = [];

    trainStates.current.forEach((state, id) => {
      if (state.trail.length > 2) {
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
