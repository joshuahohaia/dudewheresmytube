import { describe, it, expect } from 'vitest';
import { compassDirection, formatCountdown, formatSpeed, distanceMeters, estimateSpeed } from './followFormat';

describe('compassDirection', () => {
  it('maps cardinal and intercardinal headings', () => {
    expect(compassDirection(0)).toBe('N');
    expect(compassDirection(90)).toBe('E');
    expect(compassDirection(180)).toBe('S');
    expect(compassDirection(270)).toBe('W');
    expect(compassDirection(45)).toBe('NE');
    expect(compassDirection(225)).toBe('SW');
  });
  it('normalises out-of-range and negative headings', () => {
    expect(compassDirection(360)).toBe('N');
    expect(compassDirection(-90)).toBe('W');
    expect(compassDirection(725)).toBe('N');
  });
  it('rounds to the nearest point', () => {
    expect(compassDirection(20)).toBe('N');
    expect(compassDirection(30)).toBe('NE');
  });
});

describe('formatCountdown', () => {
  it('shows seconds under a minute', () => {
    expect(formatCountdown(42)).toBe('42s');
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(59.4)).toBe('59s');
  });
  it('shows minutes and seconds over a minute', () => {
    expect(formatCountdown(80)).toBe('1m 20s');
    expect(formatCountdown(120)).toBe('2m');
  });
  it('clamps negatives to zero', () => {
    expect(formatCountdown(-5)).toBe('0s');
  });
});

describe('formatSpeed', () => {
  it('converts m/s to whole km/h', () => {
    expect(formatSpeed(0)).toBe('0 km/h');
    expect(formatSpeed(10)).toBe('36 km/h');
    expect(formatSpeed(5.55)).toBe('20 km/h');
  });
});

describe('distanceMeters', () => {
  it('is zero for identical points', () => {
    expect(distanceMeters([-0.1276, 51.5074], [-0.1276, 51.5074])).toBe(0);
  });
  it('approximates a known London leg (Oxford Circus to Tottenham Court Rd ~ 850m ENE)', () => {
    const d = distanceMeters([-0.1418, 51.5152], [-0.1307, 51.5165]);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(950);
  });
});

describe('estimateSpeed', () => {
  it('returns null with too few samples', () => {
    expect(estimateSpeed([])).toBeNull();
    expect(estimateSpeed([[1000, -0.1, 51.5]])).toBeNull();
  });
  it('averages speed across the window', () => {
    const now = 100000;
    const start: [number, number] = [-0.1418, 51.5152];
    const end: [number, number] = [-0.1407, 51.5153];
    const d = distanceMeters(start, end);
    const speed = estimateSpeed([
      [now - 5000, start[0], start[1]],
      [now, end[0], end[1]],
    ]);
    expect(speed).not.toBeNull();
    expect(speed!).toBeCloseTo(d / 5, 1);
  });
  it('ignores samples older than the window', () => {
    const now = 100000;
    const speed = estimateSpeed([
      [now - 60000, -1.0, 51.0],
      [now - 4000, -0.1418, 51.5152],
      [now, -0.1413, 51.5152],
    ]);
    expect(speed).not.toBeNull();
    // only the last two samples count: ~31m over 4s
    expect(speed!).toBeGreaterThan(5);
    expect(speed!).toBeLessThan(12);
  });
});

it('suppresses speed across a feed correction instead of presenting a teleport as train speed',()=>{
 expect(estimateSpeed([[1000,-0.14,51.51],[2000,-0.13,51.51]])).toBeNull();
});
