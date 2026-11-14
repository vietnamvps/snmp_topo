import { useLayoutEffect, useRef } from 'react';
import { rate } from './data';
import { subscribeTrafficFrames } from './traffic-motion';

const TRANSITION_SECONDS = 0.65;
const HISTORY_POINTS = 15;

function useAnimatedTraffic<T>(target: T, interpolate: (from: T, to: T, progress: number) => T, paint: (value: T) => void) {
  const current = useRef(target);
  useLayoutEffect(() => {
    const from = current.current;
    let elapsed = 0;
    if (Object.is(from, target) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      current.current = target;
      paint(target);
      return;
    }

    const unsubscribe = subscribeTrafficFrames(dt => {
      elapsed = Math.min(TRANSITION_SECONDS, elapsed + dt);
      const progress = elapsed / TRANSITION_SECONDS;
      current.current = interpolate(from, target, 1 - (1 - progress) ** 3);
      paint(current.current);
      if (progress === 1) unsubscribe();
    });
    return unsubscribe;
  }, [target, interpolate, paint]);
}

function interpolateSample(from: number | null, to: number | null, progress: number) {
  if (from == null || to == null || progress === 1) return to;
  return from + (to - from) * progress;
}

export function TrafficRate({ bps }: { bps?: number | null }) {
  const element = useRef<HTMLSpanElement>(null);
  const paint = useRef((value: number | null) => {
    const next = rate(value);
    if (element.current && element.current.textContent !== next) element.current.textContent = next;
  });
  useAnimatedTraffic(bps ?? null, interpolateSample, paint.current);
  return <span ref={element} />;
}

function interpolateHistory(from: (number | null)[], to: (number | null)[], progress: number) {
  if (progress === 1) return to;
  const offset = from.length - to.length;
  return to.map((value, index) => interpolateSample(from[index + offset] ?? null, value, progress));
}

export function TrafficHistoryPath({ history }: { history: (number | null)[] }) {
  const element = useRef<SVGPathElement>(null);
  const paint = useRef((values: (number | null)[]) => {
    const scale = Math.max(1, ...values.map(value => value ?? 0));
    let penDown = false;
    const path = values.map((value, index) => {
      if (value == null) {
        penDown = false;
        return '';
      }
      const command = penDown ? 'L' : 'M';
      penDown = true;
      return command + ((HISTORY_POINTS - values.length + index) * 5 + 2) + ' ' + (23 - 20 * value / scale);
    }).join(' ');
    element.current?.setAttribute('d', path);
  });
  useAnimatedTraffic(history, interpolateHistory, paint.current);
  return <path ref={element} className="spark-line" />;
}
