import { useEffect, useLayoutEffect, useRef } from 'react';

export type MenuItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean };

export function ContextMenu({ x, y, items, close }: {
  x: number; y: number; items: MenuItem[]; close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const margin = 8;
    menu.style.left = Math.max(margin, Math.min(x, innerWidth - menu.offsetWidth - margin)) + 'px';
    menu.style.top = Math.max(margin, Math.min(y, innerHeight - menu.offsetHeight - margin)) + 'px';
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  return <div ref={ref} className="topology-menu" role="menu" aria-label="Thao tác sơ đồ"
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {items.map(item => <button key={item.label} type="button" role="menuitem"
      className={item.danger ? 'danger' : undefined} disabled={item.disabled}
      onClick={() => { close(); item.action(); }}>{item.label}</button>)}
  </div>;
}
