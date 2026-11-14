import { useLanguage } from './language';
import { createContext, memo, useContext } from 'react';
import dagre from '@dagrejs/dagre';
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, getBezierPath, useInternalNode } from '@xyflow/react';
import type { Edge, EdgeProps, InternalNode, Node, NodeProps } from '@xyflow/react';
import { Camera, Database, Globe2, House, Minus, Network, Plus, Router, Server, Shield, Wifi } from 'lucide-react';
import type { Device, Kind } from './data';
import { rate } from './data';
import { trafficBps, PARTICLE_MODE } from './traffic-motion';
import { TrafficParticles } from './traffic-particles';

const kinds = {
  wan: Globe2,
  firewall: Shield,
  core: Network,
  switch: Router,
  ap: Wifi,
  camera: Camera,
  nas: Database,
  home: House,
  server: Server,
} as const satisfies Record<Kind, typeof Wifi>;


export type TopologyNode = Node<{
  device: Device;
  children: number;
  collapsed: boolean;
  toggle: (id: string) => void;
  matched: boolean;
}, 'device'>;

export type TopologyEdge = Edge<{ device: Device; labels: boolean; trunk: boolean }, 'traffic'>;

export const bladeWidth = 228;
export const bladeHeight = 118;

function Sparkline({ history }: { history: (number | null)[] }) {
  const { t } = useLanguage();
  const scale = Math.max(1, ...history.map(value => value ?? 0));
  let penDown = false;
  const path = history.map((value, i) => {
    if (value == null) {
      penDown = false;
      return '';
    }
    const command = penDown ? 'L' : 'M';
    penDown = true;
    return command + ((15 - history.length + i) * 5 + 2) + ' ' + (23 - 20 * value / scale);
  }).join(' ');
  return <svg className="blade-spark" viewBox="0 0 74 26" role="img" aria-label={t('sparkline')}>
    <path d="M2 23H72 M2 13H72 M2 3H72" className="spark-grid" />
    <path d={path} className="spark-line" />
  </svg>;
}

const anchorSides = [Position.Top, Position.Bottom, Position.Left, Position.Right];

export const TopologyHoverContext = createContext<{
  focused?: string; related: ReadonlySet<string | undefined>; dragged?: string; mock?: boolean;
}>({ related: new Set() });

export const DeviceCard = memo(function DeviceCard({ id, data }: NodeProps<TopologyNode>) {
  const { focused, related, mock } = useContext(TopologyHoverContext);
  const muted = focused && !related.has(id) ? ' topology-muted' : '';
  const { device, children, collapsed, toggle, matched } = data;
  const { t, deviceName } = useLanguage();
  const name = deviceName(device, mock);
  const Icon = kinds[device.kind];
  const color = device.status === 'online' && ['firewall', 'core'].includes(device.kind) ? 'core' : device.status;
  return (
    <article className={`device-card ${color} ${matched ? 'matched' : ''}${muted}`}>
      {anchorSides.map(side => (
        <Handle key={'target-' + side} id={'target-' + side} type="target" position={side} isConnectable={false} />
      ))}
      {anchorSides.map(side => (
        <Handle key={'source-' + side} id={'source-' + side} type="source" position={side} isConnectable={false} />
      ))}
      <div className="device-heading">
        <span className="device-icon"><Icon size={19} /></span>
        <div className="device-title">
          <div className="device-kind">{t(device.kind)}</div>
          <strong title={name}>{name}</strong>
        </div>
        <span className="blade-state" title={t(device.status)}>
          {{ online: t('up'), offline: t('down'), warning: t('load'), unknown: '—', unconfigured: t('unconfigured') }[device.status]}
        </span>
      </div>
      <div className="device-meta">
        <span title={device.ip}>{device.ip}</span>
        <span title={device.uplink ? (device.uplink.name ?? 'ifIndex ' + device.uplink.index) + (device.uplink.capacity_bps ? ' · ' + rate(device.uplink.capacity_bps) : '') : undefined}>
          {device.uplink ? '↥ ' + (device.uplink.name ?? '#' + device.uplink.index) + (device.uplink.capacity_bps ? ' · ' + rate(device.uplink.capacity_bps) : '') : '↥ —'}
        </span>
      </div>
      <div className="device-rates">
        <div><span className="down">▼ {rate(device.down_bps)}</span>
          <span className="up">▲ {rate(device.up_bps)}</span></div>
        <Sparkline history={device.traffic_history ?? []} />
      </div>
      {children > 0 && <button className="branch nodrag nopan" type="button" onClick={event => { event.stopPropagation(); toggle(device.id); }}
        aria-label={t(collapsed ? 'expand' : 'collapse') + ' · ' + name} aria-expanded={!collapsed}>
        {collapsed ? <Plus size={12} /> : <Minus size={12} />}
      </button>}
    </article>
  );
});

function nodeBounds(node: InternalNode<TopologyNode>) {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? bladeWidth;
  const height = node.measured.height ?? node.height ?? bladeHeight;
  return { centerX: x + width / 2, centerY: y + height / 2, width, height };
}

function smartAnchors(source: InternalNode<TopologyNode>, target: InternalNode<TopologyNode>) {
  const a = nodeBounds(source);
  const b = nodeBounds(target);
  const dx = b.centerX - a.centerX;
  const dy = b.centerY - a.centerY;
  const deltaX = Math.abs(dx);
  const deltaY = Math.abs(dy);
  const horizontal = deltaX > deltaY;
  const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1;

  if (horizontal) {
    const sourceX = a.centerX + direction * a.width / 2;
    const targetX = b.centerX - direction * b.width / 2;
    return {
      sourceX, targetX,
      sourceY: a.centerY,
      targetY: b.centerY,
      sourcePosition: direction > 0 ? Position.Right : Position.Left,
      targetPosition: direction > 0 ? Position.Left : Position.Right,
    };
  }

  const sourceY = a.centerY + direction * a.height / 2;
  const targetY = b.centerY - direction * b.height / 2;
  return {
    sourceY, targetY,
    sourceX: a.centerX,
    targetX: b.centerX,
    sourcePosition: direction > 0 ? Position.Bottom : Position.Top,
    targetPosition: direction > 0 ? Position.Top : Position.Bottom,
  };
}

export const EdgeTelemetryContext = createContext<ReadonlyMap<string, Device>>(new Map());

export const TrafficEdge = memo(function TrafficEdge({ id, source, target, markerEnd, data }: EdgeProps<TopologyEdge>) {
  const { focused, dragged } = useContext(TopologyHoverContext);
  const telemetry = useContext(EdgeTelemetryContext);
  const sourceNode = useInternalNode<TopologyNode>(source);
  const targetNode = useInternalNode<TopologyNode>(target);
  if (!data || !sourceNode || !targetNode) return null;
  const { labels, trunk } = data;
  const device = telemetry.get(target) ?? data.device;
  const highlighted = source === focused || target === focused;
  const dimmed = focused && !highlighted ? ' topology-muted' : '';
  const anchors = smartAnchors(sourceNode, targetNode);
  const [path, labelX, labelY] = getBezierPath({
    ...anchors,
    curvature: 0.22,
  });
  const dual = PARTICLE_MODE === 'dual';
  const bps = trafficBps(device.status, device.down_bps, device.up_bps);
  const upload = dual ? trafficBps(device.status, null, device.up_bps) : null;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`traffic-line ${device.status} ${trunk ? 'trunk' : ''} ${highlighted ? 'highlighted' : ''}${dimmed}`} />
      <circle cx={anchors.sourceX} cy={anchors.sourceY} r={3} className={`traffic-anchor${dimmed}`} />
      <circle cx={anchors.targetX} cy={anchors.targetY} r={3} className={`traffic-anchor${dimmed}`} />
      <g className={dimmed ? 'topology-muted' : undefined}>
        {bps !== null && <TrafficParticles id={id} path={path} bps={bps} />}
        {upload !== null && <TrafficParticles id={id + ':upload'} path={path} bps={upload} upload />}
      </g>
      {labels && (!dragged || source === dragged || target === dragged) && <EdgeLabelRenderer>
        <div className={`edge-label${dimmed}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          <span className="down">↓ {rate(device.down_bps, true)}</span>
          <span className="up">↑ {rate(device.up_bps, true)}</span>
        </div>
      </EdgeLabelRenderer>}
    </>
  );
});

export function makeGraph(
  devices: Pick<Device, 'id' | 'parent_id' | 'name' | 'ip' | 'kind'>[], collapsed: Set<string>, toggle: (id: string) => void, labels: boolean, query: string,
) {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const children = new Map<string | null, typeof devices>();
  for (const device of devices) {
    const group = children.get(device.parent_id) ?? [];
    group.push(device);
    children.set(device.parent_id, group);
  }

  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'TB', nodesep: 34, ranksep: 76, marginx: 24, marginy: 24 });
  layout.setDefaultEdgeLabel(() => ({}));
  function place(device: typeof devices[number]) {
    const branches = children.get(device.id) ?? [];
    const closed = collapsed.has(device.id);
    layout.setNode(device.id, { width: bladeWidth, height: bladeHeight });
    const initialDevice: Device = { ...device, status: 'unknown', down_bps: null, up_bps: null, host: null };
    nodes.push({
      id: device.id, type: 'device', position: { x: 0, y: 0 }, zIndex: 10,
      data: {
        device: initialDevice, collapsed: closed, toggle, children: branches.length,
        matched: Boolean(query && `${device.name} ${device.ip}`.toLocaleLowerCase().includes(query)),
      },
    });
    if (device.parent_id) {
      const trunk = ['firewall', 'core', 'switch'].includes(device.kind);
      edges.push({ zIndex: 1, markerEnd: trunk ? { type: MarkerType.ArrowClosed, color: '#67a9cf' } : undefined, id: `${device.parent_id}:${device.id}`, source: device.parent_id, target: device.id, sourceHandle: 'source-bottom', targetHandle: 'target-top', type: 'traffic', data: { device: initialDevice, labels, trunk } });
    }
    if (device.parent_id) layout.setEdge(device.parent_id, device.id);
    if (!closed) branches.forEach(place);
  }
  (children.get(null) ?? []).forEach(place);
  if (nodes.length) dagre.layout(layout);
  for (const node of nodes) {
    const { x, y } = layout.node(node.id);
    node.position = { x: x - bladeWidth / 2, y: y - bladeHeight / 2 };
  }
  return { nodes, edges };
}
