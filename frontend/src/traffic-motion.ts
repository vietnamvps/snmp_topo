const MIN_DURATION_SECONDS = 0.8;
const MAX_DURATION_SECONDS = 6;
const LOW_TRAFFIC_BPS = 1_000;
const HIGH_TRAFFIC_BPS = 1_000_000_000;
const DIRECTION_TOLERANCE = 0.1;

export function trafficMotion(status: string, downBps: number | null, upBps: number | null) {
  const down = downBps ?? 0;
  const up = upBps ?? 0;
  const total = down + up;
  if ((status !== 'online' && status !== 'warning') || !Number.isFinite(total) || total <= 0) return null;

  const low = Math.log10(LOW_TRAFFIC_BPS);
  const high = Math.log10(HIGH_TRAFFIC_BPS);
  const progress = Math.max(0, Math.min(1, (Math.log10(total) - low) / (high - low)));
  const duration = MAX_DURATION_SECONDS - progress * (MAX_DURATION_SECONDS - MIN_DURATION_SECONDS);
  return {
    duration,
    direction: up - down > Math.max(up, down) * DIRECTION_TOLERANCE ? 'reverse' : 'normal',
  };
}
