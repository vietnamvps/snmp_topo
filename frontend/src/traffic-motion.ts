const PARTICLE_COUNT = 4;
const RADIUS_MIN = 1.5;
const RADIUS_MAX = 2.5;
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 7;
const LOW_TRAFFIC_BPS = 1_000;
const HIGH_TRAFFIC_BPS = 1_000_000_000;
const SMOOTH_SECONDS = 1.5;
const HYSTERESIS = 0.2;
const FADE_ZONE = 0.1;
const UPLOAD_OFFSET = 3;
export const PARTICLE_DIRECTION = 'parent-to-child';
export const PARTICLE_MODE = 'dual' as 'single' | 'dual';

export function trafficBps(status: string, down: number | null, up: number | null) {
  const total = (down ?? 0) + (up ?? 0);
  return (status === 'online' || status === 'warning') && Number.isFinite(total) && total > 0 ? total : null;
}

function speed(bps: number) {
  const progress = Math.max(0, Math.min(1, Math.log10(bps / LOW_TRAFFIC_BPS) / Math.log10(HIGH_TRAFFIC_BPS / LOW_TRAFFIC_BPS)));
  return 1 / (MAX_DURATION_SECONDS - progress * (MAX_DURATION_SECONDS - MIN_DURATION_SECONDS));
}

export function createMotion(id: string, bps: number | null) {
  let hash = 0;
  for (const char of id) hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0;
  return { phase: (hash >>> 0) % 1009 / 1009, rate: speed(bps ?? LOW_TRAFFIC_BPS), target: speed(bps ?? LOW_TRAFFIC_BPS), bps, opacity: bps === null ? 0 : 1 };
}

export function updateMotion(motion: ReturnType<typeof createMotion>, bps: number | null) {
  if (bps !== null && motion.bps !== null && Math.abs(bps - motion.bps) <= motion.bps * HYSTERESIS) return;
  motion.bps = bps;
  if (bps !== null) motion.target = speed(bps);
}

const wrap = (phase: number) => (phase % 1 + 1) % 1;

export function advanceMotion(motion: ReturnType<typeof createMotion>, dt: number) {
  motion.rate += (motion.target - motion.rate) * -Math.expm1(-dt / SMOOTH_SECONDS);
  const opacity = motion.bps === null ? 0 : 1;
  motion.opacity += (opacity - motion.opacity) * -Math.expm1(-dt / 0.25);
  motion.phase = wrap(motion.phase + motion.rate * dt);
}

export const particleSizes = Array.from({ length: PARTICLE_COUNT }, (_, index) =>
  RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * index / (PARTICLE_COUNT - 1));

export function positionParticles(path: SVGPathElement, particles: SVGGElement[], phase: number, upload: boolean, length: number) {
  if (!length) return;
  particles.forEach((particle, index) => {
    const progress = wrap(phase + index / PARTICLE_COUNT);
    const forward = PARTICLE_DIRECTION === 'parent-to-child' && !upload;
    const distance = (forward ? progress : 1 - progress) * length;
    const point = path.getPointAtLength(distance);
    const tangent = path.getPointAtLength(distance < length - 1 ? distance + 1 : distance - 1);
    const sign = distance < length - 1 ? 1 : -1;
    const dx = (tangent.x - point.x) * sign;
    const dy = (tangent.y - point.y) * sign;
    const norm = Math.hypot(dx, dy) || 1;
    const offset = upload ? UPLOAD_OFFSET : 0;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI + (forward ? 0 : 180);
    const fade = Math.min(1, progress / FADE_ZONE, (1 - progress) / FADE_ZONE);
    particle.setAttribute('transform', `translate(${point.x - dy / norm * offset} ${point.y + dx / norm * offset}) rotate(${angle})`);
    particle.setAttribute('opacity', String(fade * fade * (3 - 2 * fade)));
  });
}

const frames = new Set<(dt: number) => void>();
let handle: number | undefined;
let previous: number | undefined;
let media: MediaQueryList | undefined;
function schedule() {
  if (frames.size && !document.hidden && !media?.matches && handle === undefined) {
    handle = requestAnimationFrame(frame);
  }
}
function frame(now: number) {
  handle = undefined;
  const dt = previous === undefined ? 0 : Math.min(0.1, (now - previous) / 1000);
  previous = now;
  for (const draw of frames) draw(dt);
  schedule();
}
function syncPlayback() {
  if (!frames.size || document.hidden || media?.matches) {
    if (handle !== undefined) cancelAnimationFrame(handle);
    handle = previous = undefined;
  } else schedule();
}

export function subscribeTrafficFrames(draw: (dt: number) => void) {
  if (!frames.size) {
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', syncPlayback);
    document.addEventListener('visibilitychange', syncPlayback);
  }
  frames.add(draw);
  schedule();
  return () => {
    frames.delete(draw);
    if (!frames.size) {
      document.removeEventListener('visibilitychange', syncPlayback);
      media?.removeEventListener('change', syncPlayback);
      syncPlayback();
      media = undefined;
    }
  };
}
