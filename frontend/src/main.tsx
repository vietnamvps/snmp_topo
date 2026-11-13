import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import { ArrowDown, ArrowUp, Bell, Eye, EyeOff, Focus, Gauge, Maximize, Minus, Network, Pencil, Plus, Power, RefreshCw, Search, Shield, Trash2, Wifi, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DeviceSettings } from './device-settings';
import { rate, useTopology } from './data';
import type { Snapshot } from './data';
import { DeviceCard, TrafficEdge, makeGraph } from './graph';
import type { TopologyEdge, TopologyNode } from './graph';
import '@xyflow/react/dist/style.css';
import './style.css';

const nodeTypes = { device: DeviceCard };
const edgeTypes = { traffic: TrafficEdge };
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full' });

function SystemBar({ snapshot, connected }: { snapshot?: Snapshot; connected: boolean }) {
  const [now, setNow] = useState(new Date());
  const [panel, setPanel] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const alerts = snapshot?.devices.filter(device => ['warning', 'offline'].includes(device.status)) ?? [];
  const controls = [
    { label: 'Thông báo', icon: Bell, value: alerts.length ? `${alerts.length} cảnh báo` : 'Bình thường' },
    { label: 'Mạng', icon: Wifi, value: rate(snapshot?.summary.down_bps) },
    { label: 'An ninh', icon: Shield, value: 'Firewall' },
    { label: 'Tất cả', icon: Power, value: `${snapshot?.devices.length ?? 0} thiết bị` },
  ];
  return (
    <header className="system-bar">
      <div className="clock"><time dateTime={now.toISOString()}>{timeFormat.format(now)}</time><span>{dateFormat.format(now)}</span></div>
      <nav className="system-controls" aria-label="Trạng thái hệ thống">
        {controls.map(({ label, icon: Icon, value }) => (
          <button type="button" key={label} aria-expanded={panel === label} onClick={() => setPanel(panel === label ? undefined : label)}>
            <span className="system-icon"><Icon size={17} />{label === 'Thông báo' && alerts.length > 0 && <i>{alerts.length}</i>}</span>
            <span><b>{label}</b><small>{value}</small></span>
          </button>
        ))}
      </nav>
      <div className="connection"><span className={connected ? 'indicator live' : 'indicator'} />{connected ? 'Trực tuyến' : 'REST'}{snapshot?.mock && <span className="mock">Mô phỏng</span>}</div>
      {panel && <section className="system-panel">
        <div className="panel-heading"><strong>{panel}</strong><button aria-label="Đóng" onClick={() => setPanel(undefined)}><X size={16} /></button></div>
        {panel === 'Mạng' ? <p>↓ {rate(snapshot?.summary.down_bps)} · ↑ {rate(snapshot?.summary.up_bps)}</p>
          : panel === 'An ninh' ? <p>OPNsense · {snapshot?.devices.find(device => device.kind === 'firewall')?.status ?? '—'}</p>
          : <ul>{(panel === 'Thông báo' ? alerts : snapshot?.devices ?? []).map(device => <li key={device.id}>{device.name} · {device.status}</li>)}
            {panel === 'Thông báo' && !alerts.length && <li>Không có cảnh báo thiết bị</li>}</ul>}
      </section>}
    </header>
  );
}

function Summary({ snapshot }: { snapshot?: Snapshot }) {
  const summary = snapshot?.summary;
  const speed = summary?.speedtest;
  return (
    <div className="summary">
      <div className="pill"><span className="indicator live" /><div><small>Cổng đang up</small><strong>{summary ? `${summary.ports_up} / ${summary.ports_total}` : '—'}</strong></div></div>
      <div className="pill down"><ArrowDown size={17} /><div><small>Tổng tải xuống</small><strong>{rate(summary?.down_bps)}</strong><progress aria-label="Tải xuống trên thang 1 Gbps" max={1e9} value={summary?.down_bps ?? 0} /></div></div>
      <div className="pill up"><ArrowUp size={17} /><div><small>Tổng tải lên</small><strong>{rate(summary?.up_bps)}</strong><progress aria-label="Tải lên trên thang 1 Gbps" max={1e9} value={summary?.up_bps ?? 0} /></div></div>
      <div className="pill"><Gauge size={18} /><div><small>Speedtest {speed && `· ${speed.ping_ms} ms`}</small><strong>{speed ? <><span className="down">↓ {rate(speed.down_bps)}</span> <span className="up">↑ {rate(speed.up_bps)}</span></> : '—'}</strong></div></div>
    </div>
  );
}

function Tool({ icon: Icon, label, action, pressed }: { icon: LucideIcon; label: string; action: () => void; pressed?: boolean }) {
  return <button className="tool" title={label} aria-label={label} aria-pressed={pressed} type="button" onClick={action}><Icon size={17} /></button>;
}

function NodeActions({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'edit' | 'delete'>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function close() {
    if (busy || (dirty && !window.confirm('Bỏ các thay đổi chưa lưu?'))) return;
    dialog.current?.close();
  }

  return (
    <dialog ref={dialog} className="node-dialog" aria-labelledby="node-dialog-title"
      onClose={onClose} onCancel={event => { event.preventDefault(); close(); }}>
      <header className="node-dialog-heading">
        <h2 id="node-dialog-title">{mode === 'edit' ? 'Sửa ' : mode === 'delete' ? 'Xóa ' : ''}{name}</h2>
        <button className="tool" type="button" aria-label="Đóng" onClick={close} disabled={busy}><X size={19} /></button>
      </header>
      {mode ? (
        <DeviceSettings nodeId={id} mode={mode} onSaved={() => dialog.current?.close()}
          onStateChange={(changed, saving) => { setDirty(changed); setBusy(saving); }} />
      ) : (
        <div className="node-dialog-actions">
          <button className="config-button" type="button" onClick={() => setMode('edit')}><Pencil size={17} /> Sửa thiết bị</button>
          <button className="config-button config-delete" type="button" onClick={() => setMode('delete')}><Trash2 size={17} /> Xóa thiết bị</button>
        </div>
      )}
    </dialog>
  );
}

function Dashboard() {
  const { snapshot, connected, error, refresh } = useTopology();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState(true);
  const [activeNode, setActiveNode] = useState<{ id: string; name: string }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const fitted = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const flow = useReactFlow<TopologyNode, TopologyEdge>();
  const initialized = useNodesInitialized();
  const query = search.trim().toLocaleLowerCase();

  const graph = useMemo(() => makeGraph(snapshot?.devices ?? [], collapsed, id => setCollapsed(previous => {
    const next = new Set(previous);
    if (!next.delete(id)) next.add(id);
    return next;
  }), labels, query), [snapshot, collapsed, labels, query]);

  const match = graph.nodes.find(node => node.data.matched);
  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!initialized || fitted.current) return;
    fitted.current = true;
    void flow.fitView({ padding: 0.08, maxZoom: 1 });
  }, [flow, initialized]);

  function focusMatch() {
    if (match) void flow.setCenter(match.position.x + 100, match.position.y + 52, { zoom: Math.max(zoom, 0.85), duration: 250 });
  }

  async function toggleFullscreen() {
    setFullscreenError(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      setFullscreenError(true);
    }
  }

  return (
    <div className="dashboard" ref={root}>
      <SystemBar snapshot={snapshot} connected={connected} />
      <main>
        <section className="lan-bar" aria-label="Điều khiển mạng LAN">
          <div className="lan-title"><span><Network size={23} /></span><div><h1>Mạng LAN</h1><small>LAN Topology</small></div></div>
          <Summary snapshot={snapshot} />
          <div className="toolbar" aria-label="Công cụ sơ đồ">
            <a className="config-button" href="/devices">Cấu hình thiết bị</a>
            <Tool icon={labels ? Eye : EyeOff} label="Nhãn lưu lượng trên dây" pressed={labels} action={() => setLabels(!labels)} />
            <Tool icon={Search} label="Tìm thiết bị" pressed={searchOpen} action={() => { setSearchOpen(!searchOpen); setSearch(''); }} />
            <Tool icon={Maximize} label="Toàn màn hình" pressed={fullscreen} action={() => void toggleFullscreen()} />
            <Tool icon={RefreshCw} label="Làm mới dữ liệu" action={() => void refresh()} />
            <Tool icon={Plus} label="Phóng to" action={() => void flow.zoomIn({ duration: 180 })} />
            <Tool icon={Minus} label="Thu nhỏ" action={() => void flow.zoomOut({ duration: 180 })} />
            <button className="tool zoom" title="Về 100%" aria-label="Về 100%" onClick={() => void flow.zoomTo(1, { duration: 180 })}>{Math.round(zoom * 100)}%</button>
            <Tool icon={Focus} label="Căn giữa sơ đồ" action={() => void flow.fitView({ padding: 0.08, duration: 250, maxZoom: 1 })} />
          </div>
        </section>
        <section className="canvas" aria-label="Sơ đồ mạng">
          {searchOpen && <form className="search-box" onSubmit={event => { event.preventDefault(); focusMatch(); }}>
            <input autoFocus placeholder="Tên thiết bị hoặc IP" aria-label="Tên thiết bị hoặc IP" value={search} onChange={event => setSearch(event.target.value)} />
            <button type="submit" disabled={!match}>Tìm</button>
            {query && !match && <small>Không thấy thiết bị trong các nhánh đang mở</small>}
          </form>}
          <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodeClick={(_, node) => setActiveNode(node.data.device)}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} minZoom={0.15} maxZoom={2}
            onMove={(_, view) => setZoom(view.zoom)}
            colorMode="dark">
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#233149" />
          </ReactFlow>
          {!snapshot && <p className="canvas-message" role="status">{error ? 'Không tải được dữ liệu. Hãy thử làm mới.' : 'Đang tải sơ đồ mạng…'}</p>}
          {snapshot && error && <p className="canvas-message" role="status">Đang hiển thị dữ liệu lần cập nhật trước.</p>}
          {fullscreenError && <p className="canvas-message" role="status">Trình duyệt không thể mở toàn màn hình.</p>}
          <div className="legend"><span><i className="indicator live" />Online</span><span><i className="indicator warn" />Tải cao</span><span><i className="indicator off" />Offline</span></div>
        </section>
      </main>
      {activeNode && <NodeActions id={activeNode.id} name={activeNode.name} onClose={() => setActiveNode(undefined)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(window.location.pathname === '/devices'
  ? <DeviceSettings /> : <ReactFlowProvider><Dashboard /></ReactFlowProvider>);
