import { memo, useLayoutEffect, useRef } from 'react';
import { advanceMotion, createMotion, particleSizes, positionParticles, subscribeTrafficFrames, updateMotion } from './traffic-motion';

export const TrafficParticles = memo(function TrafficParticles({ id, path, bps, upload = false }: {
  id: string; path: string; bps: number | null; upload?: boolean;
}) {
  const geometry = useRef<SVGPathElement>(null);
  const group = useRef<SVGGElement>(null);
  const motion = useRef<ReturnType<typeof createMotion>>();
  if (!motion.current) motion.current = createMotion(id, bps);

  useLayoutEffect(() => {
    const state = motion.current!;
    updateMotion(state, bps);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      state.opacity = bps === null ? 0 : 1;
      group.current!.setAttribute('opacity', String(state.opacity));
    }
  }, [bps]);
  useLayoutEffect(() => {
    const curve = geometry.current!;
    const length = curve.getTotalLength();
    const particles = Array.from(group.current!.children) as SVGGElement[];
    function draw(dt: number) {
      const state = motion.current!;
      advanceMotion(state, dt);
      group.current!.setAttribute('opacity', String(state.opacity));
      if (state.opacity > 0.001) positionParticles(curve, particles, state.phase, upload, length);
    }
    draw(0);
    return subscribeTrafficFrames(draw);
  }, [path, upload]);

  return <>
    <path ref={geometry} d={path} visibility="hidden" pointerEvents="none" />
    <g ref={group} className={upload ? 'traffic-particles traffic-particles-upload' : 'traffic-particles'} aria-hidden="true">
      {particleSizes.map((radius, index) => <g key={index} opacity={0}>
        <ellipse cx={-radius} rx={radius * 1.65} ry={radius * 0.55} opacity={0.32} />
        <circle r={radius} />
      </g>)}
    </g>
  </>;
});
