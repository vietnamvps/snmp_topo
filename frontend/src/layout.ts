export const layoutKey = 'opnsense_topo_layout_v1';
export type PositionMap = Map<string, { x: number; y: number }>;

export function parseLayout(value: string): PositionMap {
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid layout');
  const entries = Object.entries(data);
  if (entries.length > 1024) throw new Error('Layout too large');
  const positions: PositionMap = new Map();
  for (const [id, point] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || !point ||
      typeof point.x !== 'number' || typeof point.y !== 'number' ||
      !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      Math.abs(point.x) > 1e7 || Math.abs(point.y) > 1e7) throw new Error('Invalid position');
    positions.set(id, { x: point.x, y: point.y });
  }
  return positions;
}

export function loadLayout(): PositionMap {
  try { return parseLayout(localStorage.getItem(layoutKey) ?? '{}'); }
  catch { return new Map(); }
}

export type Point = { x: number; y: number };

export function snapToCenter(center: Point, anchor: Point): Point {
  const dx = Math.abs(center.x - anchor.x);
  const dy = Math.abs(center.y - anchor.y);
  return dx < dy ? { x: anchor.x, y: center.y } : { x: center.x, y: anchor.y };
}

export const SNAP_THRESHOLD = 8;
export type NodeBox = Point & { width: number; height: number };
export type AlignmentGuide = { from: Point; to: Point; distance?: number };

export function magneticSnap(box: NodeBox, otherNodes: readonly NodeBox[]) {
  const position = { x: box.x, y: box.y };
  const guides: AlignmentGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const across = axis === 'x' ? 'y' : 'x';
    const acrossSize = axis === 'x' ? 'height' : 'width';
    let match: { offset: number; coordinate: number; other: NodeBox } | undefined;
    // Prefer centers, then choose the closest matching edge if no center is in range.
    for (const marks of [[0.5], [0, 1]]) {
      for (const other of otherNodes) {
        for (const mark of marks) {
          const coordinate = other[axis] + other[size] * mark;
          const offset = coordinate - (box[axis] + box[size] * mark);
          if (Math.abs(offset) < Math.abs(match?.offset ?? SNAP_THRESHOLD)) {
            match = { offset, coordinate, other };
          }
        }
      }
      if (match) break;
    }
    if (!match) continue;
    position[axis] += match.offset;
    const start = Math.min(box[across], match.other[across]);
    const end = Math.max(box[across] + box[acrossSize], match.other[across] + match.other[acrossSize]);
    const coordinate = match.coordinate;
    guides.push(axis === 'x'
      ? { from: { x: coordinate, y: start }, to: { x: coordinate, y: end } }
      : { from: { x: start, y: coordinate }, to: { x: end, y: coordinate } });
  }
  const spacing = equalSpacingSnap(box, otherNodes);
  for (const axis of ['x', 'y'] as const) {
    const match = spacing[axis];
    if (!match) continue;
    position[axis] = match.position;
    const oldGuide = guides.findIndex(guide => guide.from[axis] === guide.to[axis]);
    if (oldGuide >= 0) guides.splice(oldGuide, 1);
    guides.push(...match.guides);
  }
  return { position, guides };
}

function equalSpacingSnap(box: NodeBox, others: readonly NodeBox[]) {
  const result: Partial<Record<'x' | 'y', { position: number; guides: AlignmentGuide[] }>> = {};

  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const cross = axis === 'x' ? 'y' : 'x';
    const crossSize = axis === 'x' ? 'height' : 'width';
    const center = (node: NodeBox) => node[cross] + node[crossSize] / 2;
    const end = (node: NodeBox) => node[axis] + node[size];
    const peers = others.filter(node => Math.abs(center(node) - center(box)) < SNAP_THRESHOLD)
      .sort((a, b) => a[axis] - b[axis]);
    let bestShift = Infinity;

    for (let i = 1; i < peers.length; i += 1) {
      const left = peers[i - 1];
      const right = peers[i];
      const gap = right[axis] - end(left);
      if (gap < 0) continue;

      let position: number;
      let error: number;
      if (box[axis] < left[axis]) {
        position = left[axis] - gap - box[size];
        error = Math.abs(left[axis] - end(box) - gap);
      } else if (box[axis] >= right[axis]) {
        position = end(right) + gap;
        error = Math.abs(box[axis] - end(right) - gap);
      } else {
        if (gap < box[size]) continue;
        position = end(left) + (gap - box[size]) / 2;
        error = Math.abs((box[axis] - end(left)) - (right[axis] - end(box)));
      }
      const shift = Math.abs(position - box[axis]);
      if (error >= SNAP_THRESHOLD || shift >= bestShift) continue;
      if (peers.some(node => position < end(node) && position + box[size] > node[axis])) continue;

      const trio = [left, right, { ...box, [axis]: position }].sort((a, b) => a[axis] - b[axis]);
      const measureAt = Math.max(...trio.map(node => node[cross] + node[crossSize])) + 12;
      const point = (value: number): Point => axis === 'x'
        ? { x: value, y: measureAt } : { x: measureAt, y: value };
      const distance = trio[1][axis] - end(trio[0]);
      result[axis] = {
        position,
        guides: [0, 1].map(index => ({
          from: point(end(trio[index])), to: point(trio[index + 1][axis]), distance,
        })),
      };
      bestShift = shift;
    }
  }

  return result;
}
