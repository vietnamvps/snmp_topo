import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath } from '@xyflow/react';
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react';
import { Camera, Database, Globe2, House, Minus, Network, Plus, Router, Server, Shield, Wifi } from 'lucide-react';
import type { Device, Kind } from './data';
import { rate } from './data';

const kinds = {
  wan: ['WAN / ISP', Globe2],
  firewall: ['FIREWALL', Shield],
  core: ['CORE SWITCH', Network],
  switch: ['SWITCH', Router],
  ap: ['ACCESS POINT', Wifi],
  camera: ['IP CAMERA', Camera],
  nas: ['LƯU TRỮ', Database],
  home: ['NHÀ THÔNG MINH', House],
  server: ['MÁY CHỦ', Server],
} as const satisfies Record<Kind, readonly [string, typeof Wifi]>;

const statusNames = { online: 'Online', offline: 'Offline', warning: 'Tải cao', unknown: 'Chưa rõ' };

export type TopologyNode = Node<{
  device: Device;
  children: number;
  collapsed: boolean;
  toggle: (id: string) => void;
  matched: boolean;
}, 'device'>;

export type TopologyEdge = Edge<{ device: Device; labels: boolean }, 'traffic'>;

export function DeviceCard({ data }: NodeProps<TopologyNode>) {
  const { device, children, collapsed, toggle, matched } = data;
  const [kind, Icon] = kinds[device.kind];
  const color = device.status === 'online' && ['wan', 'core', 'switch'].includes(device.kind) ? 'core' : device.status;
  return (
    <article tabIndex={0} aria-label={`Thao tác cho ${device.name}`}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.currentTarget.click();
      }} className={`device-card ${color} ${matched ? 'matched' : ''}`}>
      {device.parent_id && <Handle type="target" position={Position.Left} isConnectable={false} />}
      {children > 0 && !collapsed && <Handle type="source" position={Position.Right} isConnectable={false} />}
      <div className="device-heading">
        <span className="device-icon"><Icon size={19} /></span>
        <div className="device-title">
          <div className="device-kind">{kind}</div>
          <strong title={device.name}>{device.name}</strong>
        </div>
        <span className="device-dot" aria-label={statusNames[device.status]} title={statusNames[device.status]} />
      </div>
      <div className="device-meta">
        <span>{device.ip}</span>
        {device.host?.cpu_percent != null && <span>CPU {device.host.cpu_percent}%</span>}
        {device.host?.ram_percent != null && <span>RAM {device.host.ram_percent}%</span>}
      </div>
      <div className="device-rates">
        <span className="down">↓ {rate(device.down_bps)}</span>
        <span className="up">↑ {rate(device.up_bps)}</span>
      </div>
      {children > 0 && <button className="branch nodrag nopan" type="button" onClick={event => { event.stopPropagation(); toggle(device.id); }}
        aria-label={`${collapsed ? 'Mở' : 'Thu gọn'} nhánh ${device.name}`} aria-expanded={!collapsed}>
        {collapsed ? <Plus size={12} /> : <Minus size={12} />}
      </button>}
    </article>
  );
}

export function TrafficEdge({ id, data, ...props }: EdgeProps<TopologyEdge>) {
  const [path, x, y] = getBezierPath(props);
  if (!data) return null;
  const { device, labels } = data;
  const active = device.status === 'online' || device.status === 'warning';
  return (
    <>
      <BaseEdge id={id} path={path} className={`traffic-line ${device.status}`} />
      {active && <path d={path} className="traffic-particles" />}
      {labels && <EdgeLabelRenderer>
        <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
          <span className="down">↓ {rate(device.down_bps, true)}</span>
          <span className="up">↑ {rate(device.up_bps, true)}</span>
        </div>
      </EdgeLabelRenderer>}
    </>
  );
}

export function makeGraph(
  devices: Device[], collapsed: Set<string>, toggle: (id: string) => void, labels: boolean, query: string,
) {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const children = new Map<string | null, Device[]>();
  for (const device of devices) {
    const group = children.get(device.parent_id) ?? [];
    group.push(device);
    children.set(device.parent_id, group);
  }

  let row = 0;
  function place(device: Device, depth: number): number {
    const branches = children.get(device.id) ?? [];
    const closed = collapsed.has(device.id);
    const childRows = closed ? [] : branches.map(child => place(child, depth + 1));
    const y = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : row++ * 125;
    nodes.push({
      id: device.id, type: 'device', position: { x: depth * 365, y },
      data: {
        device, collapsed: closed, toggle, children: branches.length,
        matched: Boolean(query && `${device.name} ${device.ip}`.toLocaleLowerCase().includes(query)),
      },
    });
    if (device.parent_id) {
      edges.push({ id: `${device.parent_id}:${device.id}`, source: device.parent_id, target: device.id, type: 'traffic', data: { device, labels } });
    }
    return y;
  }
  for (const root of children.get(null) ?? []) place(root, 0);
  return { nodes, edges };
}
