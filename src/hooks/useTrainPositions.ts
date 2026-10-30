import { useEffect, useRef, useState, useCallback } from 'react';
import type { Train, TrainWithPosition } from '../types/train';
import { updateMotion, motionTarget, type MotionState } from '../lib/trainMotion';

interface TrainState {
  motion: MotionState;
  train: Train;
  trail: [number, number][];
  lastInterpolatedPosition: [number, number] | null;
  velocity: [number, number];
}

// Spring-like interpolation toward a moving target. The motion model decides
// where the train should be; this only absorbs small corrections (a few
// seconds of prediction drift, a station flip) so they don't visibly snap.
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

const TRAIL_LENGTH = 20;
const SMOOTH_TIME = 0.8; // seconds to absorb a correction

export function useTrainPositions(trains: Train[] | undefined) {
  const [positions, setPositions] = useState<TrainWithPosition[]>([]);
  const trainStates = useRef<Map<string, TrainState>>(new Map());
  const lastFrameTime = useRef<number>(0);

  // Update motion models when new data arrives
  useEffect(() => {
    if (!trains) return;

    const now = Date.now();

    trains.forEach((train) => {
      const existing = trainStates.current.get(train.id);
      const motion = updateMotion(existing?.motion, train, now);

      if (!motion) {
        // Target station not mappable; drop the marker rather than show a
        // wrong position.
        if (existing) trainStates.current.delete(train.id);
        return;
      }

      if (existing) {
        existing.motion = motion;
        existing.train = train;
      } else {
        trainStates.current.set(train.id, {
          motion,
          train,
          trail: [motion.targetCoords],
          lastInterpolatedPosition: null,
          velocity: [0, 0],
        });
      }
    });

    // Remove trains that dropped out of the feed
    const currentIds = new Set(trains.map((t) => t.id));
    for (const [id] of trainStates.current.entries()) {
      if (!currentIds.has(id)) {
        trainStates.current.delete(id);
      }
    }
  }, [trains]);

  // Animation loop - runs at 60fps
  useEffect(() => {
    let raf = 0;
    lastFrameTime.current = Date.now();

    const animate = () => {
      const now = Date.now();
    const deltaTime = Math.min((now - lastFrameTime.current) / 1000, 0.1); // Cap delta to prevent jumps
    lastFrameTime.current = now;

    const result: TrainWithPosition[] = [];

    trainStates.current.forEach((state) => {
      const { position: target, heading } = motionTarget(state.motion, now);

      let position: [number, number];
      const currentPos = state.lastInterpolatedPosition;
      if (!currentPos) {
        position = target;
        state.velocity = [0, 0];
      } else {
        const smoothX = smoothDamp(currentPos[0], target[0], state.velocity[0], SMOOTH_TIME, deltaTime);
        const smoothY = smoothDamp(currentPos[1], target[1], state.velocity[1], SMOOTH_TIME, deltaTime);
        position = [smoothX.value, smoothY.value];
        state.velocity = [smoothX.velocity, smoothY.velocity];
      }

      state.lastInterpolatedPosition = position;

      // Update trail
      const lastTrailPos = state.trail[state.trail.length - 1];
      const dist = Math.abs(position[0] - lastTrailPos[0]) + Math.abs(position[1] - lastTrailPos[1]);
      if (dist > 0.00003) {
        state.trail = [...state.trail, position].slice(-TRAIL_LENGTH);
      }

      result.push({
        ...state.train,
        position,
        heading,
      });
    });

      setPositions(result);
      raf = requestAnimationFrame(animate);
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []);

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
