import { useLayoutEffect, useRef, useState } from 'react';
import { rate } from './data';

const HISTORY_POINTS = 15;
const SAMPLE_SPACING = 5;
const SCROLL_MS = 220;
const MIN_SCALE_BPS = 8_000;

export function TrafficRate({ bps }: { bps?: number | null }) {
  return <span>{rate(bps)}</span>;
}

export function TrafficHistoryPath({ history }: { history: (number | null)[] }) {
  const element = useRef<SVGPathElement>(null);
  const previous = useRef<(number | null)[]>();
  const peak = Math.max(MIN_SCALE_BPS, ...history.map(value => value ?? 0));
  const requiredScale = 2 ** Math.ceil(Math.log2(peak));
  const [scale, setScale] = useState(requiredScale);
  const nextScale = peak > scale || requiredScale <= scale / 4 ? requiredScale : scale;
  if (nextScale !== scale) setScale(nextScale);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = history;
    const overlap = before && Math.min(before.length, history.length - 1);
    const advanced = overlap && before.slice(-overlap).every((value, index) => value === history[index]);
    const identical = before?.length === history.length && before.every((value, index) => value === history[index]);
    if (!advanced || identical || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = element.current?.animate(
      [{ transform: 'translateX(' + SAMPLE_SPACING + 'px)' }, { transform: 'translateX(0)' }],
      { duration: SCROLL_MS, easing: 'ease-out' },
    );
    return () => animation?.cancel();
  }, [history]);

  let penDown = false;
  const path = history.map((value, index) => {
    if (value == null) {
      penDown = false;
      return '';
    }
    const command = penDown ? 'L' : 'M';
    penDown = true;
    return command + ((HISTORY_POINTS - history.length + index) * SAMPLE_SPACING + 2) + ' ' + (23 - 20 * value / nextScale);
  }).join(' ');
  return <path ref={element} d={path} className="spark-line" />;
}
