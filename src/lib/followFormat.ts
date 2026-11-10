/** Formatting helpers for the follow-a-train detail panel. */

/** Compass label for a heading in degrees from north. */
export function compassDirection(heading: number): string {
  const normalized = ((heading % 360) + 360) % 360;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(normalized / 45) % 8];
}

/** "42s", "1m 20s" - countdown phrasing for the next-station estimate. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** "12 km/h" from metres/second, rounded to a stable whole number. */
export function formatSpeed(metersPerSecond: number): string {
  return `${Math.round(metersPerSecond * 3.6)} km/h`;
}

/** Approximate metres between two [lng, lat] points (London-scale distances). */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const lat = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (a[0] - b[0]) * 111320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * Rolling estimated speed: average over the last windowMs of samples so one
 * correction step does not flash a huge number. Samples are [epochMs, lng, lat].
 */
export function estimateSpeed(
  samples: Array<[number, number, number]>,
  windowMs = 5000
): number | null {
  if (samples.length < 2) return null;
  const newest = samples[samples.length - 1];
  let oldest = samples[0];
  for (const s of samples) {
    if (newest[0] - s[0] <= windowMs) {
      oldest = s;
      break;
    }
  }
  const dt = (newest[0] - oldest[0]) / 1000;
  if (dt < 0.5) return null;
  // A feed re-location is not a train travelling at that apparent speed.
  // Hide the estimate until the rolling window no longer contains a jump.
  const window = samples.filter(s => s[0] >= oldest[0]);
  for (let i = 1; i < window.length; i++) {
    const elapsed = (window[i][0] - window[i - 1][0]) / 1000;
    const metres = distanceMeters([window[i - 1][1], window[i - 1][2]], [window[i][1], window[i][2]]);
    if (elapsed > 0 && metres / elapsed > 25.5) return null;
  }
  return distanceMeters([oldest[1], oldest[2]], [newest[1], newest[2]]) / dt;
}
