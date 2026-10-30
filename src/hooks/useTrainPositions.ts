import { useEffect, useRef, useState, useCallback } from 'react';
import type { Train, TrainWithPosition } from '../types/train';
import { updateMotion, motionTarget, type MotionState } from '../lib/trainMotion';

const TRAIL_LENGTH = 20;

interface TrainState {
  motion: MotionState;
  train: Train;
  trail: [number, number][];
  lastInterpolatedPosition: [number, number] | null;
  velocity: [number, number];
}

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
    lastFrameTime.current = now;

    const result: TrainWithPosition[] = [];

    trainStates.current.forEach((state) => {
      const { position: target, heading } = motionTarget(state.motion, now);

      const position = target;

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
