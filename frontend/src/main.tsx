import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, ViewportPortal, useNodesInitialized, useReactFlow } from '@xyflow/react';
import { Download, Eye, EyeOff, Focus, Lock, Maximize, Minus, Network, Plus, RefreshCw, Search, Settings, Unlock, Upload, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DeviceSettings } from './device-settings';
import { rate, useTopology } from './data';
import { ContextMenu, type MenuItem } from './context-menu';
import type { Device, Snapshot } from './data';
import { DeviceCard, TrafficEdge, makeGraph, TopologyHoverContext } from './graph';
import { layoutKey, loadLayout, parseLayout, type PositionMap, type Point, type AlignmentGuide, magneticSnap, snapToCenter } from './layout';
import { bladeHeight, bladeWidth } from './graph';
import type { TopologyEdge, TopologyNode } from './graph';
import '@xyflow/react/dist/style.css';
import './style.css';

const nodeTypes = { device: DeviceCard };
const edgeTypes = { traffic: TrafficEdge };
const clockFormat = new Intl.DateTimeFormat('vi-VN', { timeStyle: 'medium', hour12: false });

function uptime(seconds?: number | null) {
  if (seconds == null) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  return days ? days + 'd ' + hours + 'h' : hours + 'h ' + Math.floor(seconds / 60) % 60 + 'm';
}

function SystemBar({ snapshot, connected }: { snapshot?: Snapshot; connected: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const alerts = snapshot?.devices.filter(device => device.status === 'offline' || device.status === 'warning') ?? [];
  const host = snapshot?.devices.find(device => device.kind === 'firewall')?.host;
  const summary = snapshot?.summary;
  const percent = (value?: number | null) => value == null ? '—' : value + '%';
  const telemetry = [
    ['CPU', percent(host?.cpu_percent)], ['RAM', percent(host?.ram_percent)], ['UPTIME', uptime(host?.uptime_seconds)],
    ['ACTIVE PORTS', summary ? summary.ports_up + ' / ' + summary.ports_total : '—'],
    ['WAN RX', rate(summary?.down_bps)], ['WAN TX', rate(summary?.up_bps)],
    ['LATENCY', summary?.speedtest ? summary.speedtest.ping_ms + ' ms' : '—'],
  ];
  return <header className="command-bar">
    <div className="command-brand"><Network size={20} /><h1>OPNsense NOC</h1>
      <span className={connected ? 'stream-state streaming' : 'stream-state'}>{snapshot?.mock ? 'MOCK' : connected ? 'LIVE' : 'REST'}</span>
    </div>
    <dl className="telemetry-strip">{telemetry.map(([label, value]) =>
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <time>{clockFormat.format(now)}</time>
    <button className="tool" type="button" aria-expanded={drawerOpen} aria-controls="noc-drawer"
      aria-label="Cấu hình và cảnh báo" title="Cấu hình và cảnh báo" onClick={() => setDrawerOpen(!drawerOpen)}><Settings size={18} /></button>
    {drawerOpen && <aside className="command-drawer" id="noc-drawer" aria-label="Cấu hình và cảnh báo">
      <a className="config-button" href="/devices">Cấu hình thiết bị</a>
      <h2>Cảnh báo</h2>
      {alerts.length ? <ul>{alerts.map(device => <li key={device.id}>{device.name}
        <span>{device.status === 'offline' ? 'Offline' : 'Tải cao'}</span></li>)}</ul> : <p>Không có cảnh báo.</p>}
    </aside>}
  </header>;
}

function Tool({ icon: Icon, label, action, pressed }: { icon: LucideIcon; label: string; action: () => void; pressed?: boolean }) {
  return <button className="tool" title={label} aria-label={label} aria-pressed={pressed} type="button" onClick={action}><Icon size={17} /></button>;
}

type DialogAction = { mode: 'edit' | 'delete' | 'add'; device?: Device; position?: { x: number; y: number } };
type MenuAnchor = { x: number; y: number; device?: Device };

function NodeActions({ action, onClose, onSaved }: {
  action: DialogAction; onClose: () => void; onSaved: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const { mode, device } = action;
  const title = mode === 'add' ? device ? 'Thêm thiết bị con · ' + device.name : 'Thêm thiết bị'
    : (mode === 'edit' ? 'Sửa ' : 'Xóa ') + device?.name;

  useEffect(() => { dialog.current?.showModal(); }, []);

  function close() {
    if (busy || (dirty && !window.confirm('Bỏ các thay đổi chưa lưu?'))) return;
    dialog.current?.close();
  }

  return <dialog ref={dialog} className="node-dialog" aria-labelledby="node-dialog-title"
    onClose={onClose} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="node-dialog-heading">
      <h2 id="node-dialog-title">{title}</h2>
      <button className="tool" type="button" aria-label="Đóng" onClick={close} disabled={busy}><X size={19} /></button>
    </header>
    <DeviceSettings nodeId={mode === 'add' ? undefined : device?.id} parentId={mode === 'add' ? device?.id : undefined}
      mode={mode} onSaved={id => { onSaved(id); dialog.current?.close(); }}
      onStateChange={(changed, saving) => { setDirty(changed); setBusy(saving); }} />
  </dialog>;
}

function Dashboard() {
  const { snapshot, connected, error, refresh } = useTopology();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [positions, setPositions] = useState(loadLayout);
  const [dragging, setDragging] = useState<PositionMap>(new Map());
  const modifiers = useRef({ shiftKey: false, altKey: false });
  const dragSession = useRef<{ id: string; origin: Point; raw: Point; placed: Point; width: number; height: number }>();
  const [activeGuides, setActiveGuides] = useState<AlignmentGuide[]>([]);
  const [locked, setLocked] = useState(false);
  const [layoutMessage, setLayoutMessage] = useState('');
  const importFile = useRef<HTMLInputElement>(null);
  const fitRequested = useRef(false);
  const [labels, setLabels] = useState(true);
  const [action, setAction] = useState<DialogAction>();
  const [menu, setMenu] = useState<MenuAnchor>();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const hoverLeaveTimer = useRef<number>(0);
  const [dragged, setDragged] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number>(0);
  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    clearTimeout(hoverLeaveTimer.current);
  }, []);
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

  function toggleBranch(id: string) { setCollapsed(previous => {
    const next = new Set(previous);
    if (!next.delete(id)) next.add(id);
    return next;
  }); }

  const structure = JSON.stringify(snapshot?.devices.map(({ id, parent_id, name, ip, kind }) =>
    ({ id, parent_id, name, ip, kind })) ?? []);
  const graph = useMemo(() => makeGraph(JSON.parse(structure) as Parameters<typeof makeGraph>[0], collapsed, toggleBranch, labels, query),
    [structure, collapsed, labels, query]);
  const placedNodes = useMemo(() => graph.nodes.map(node => ({
    ...node, selected: selected === node.id,
    position: dragging.get(node.id) ?? positions.get(node.id) ?? node.position,
  })), [graph, selected, dragging, positions]);
  const telemetry = useMemo(() => new Map(snapshot?.devices.map(device => [device.id, device])), [snapshot]);
  const nodes = useMemo(() => placedNodes.map(node => ({
    ...node, data: { ...node.data, device: telemetry.get(node.id) ?? node.data.device },
  })), [placedNodes, telemetry]);
  const edges = useMemo(() => graph.edges.map(edge => edge.data ? ({
    ...edge, data: { ...edge.data, device: telemetry.get(edge.target) ?? edge.data.device },
  }) : edge), [graph.edges, telemetry]);

  const emphasis = useMemo(() => {
    const focused = [dragged, hoveredNodeId ?? undefined, selected].find(id => graph.nodes.some(node => node.id === id));
    const related = new Set([focused]);
    for (const edge of graph.edges) {
      if (edge.source === focused) related.add(edge.target);
      if (edge.target === focused) related.add(edge.source);
    }
    return { focused, related, dragged };
  }, [dragged, hoveredNodeId, selected, graph]);

  function updateDrag() {
    const session = dragSession.current;
    if (!session) return;
    const { shiftKey, altKey } = modifiers.current;
    let position = session.raw;
    let guides: AlignmentGuide[] = [];
    if (!altKey && shiftKey) {
      const node = flow.getNode(session.id);
      const parentId = node?.data.device.parent_id;
      const parent = parentId ? flow.getInternalNode(parentId) : undefined;
      const anchor = parent ? {
        x: parent.internals.positionAbsolute.x + (parent.measured.width ?? bladeWidth) / 2,
        y: parent.internals.positionAbsolute.y + (parent.measured.height ?? bladeHeight) / 2,
      } : session.origin;
      const center = { x: position.x + session.width / 2, y: position.y + session.height / 2 };
      const aligned = snapToCenter(center, anchor);
      position = { x: aligned.x - session.width / 2, y: aligned.y - session.height / 2 };
      guides = [{ from: anchor, to: aligned }];
    } else if (!altKey) {
      const others = flow.getNodes().filter(node => node.id !== session.id && !node.hidden).map(node => ({
        ...node.position, width: node.measured?.width ?? bladeWidth, height: node.measured?.height ?? bladeHeight,
      }));
      ({ position, guides } = magneticSnap({ ...position, width: session.width, height: session.height }, others));
    }
    session.placed = position;
    setDragging(new Map([[session.id, position]]));
    setActiveGuides(guides);
  }

  function updateModifiers({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) {
    const previous = modifiers.current;
    if (previous.shiftKey === shiftKey && previous.altKey === altKey) return;
    modifiers.current = { shiftKey, altKey };
    updateDrag();
  }

  useEffect(() => {
    const clearModifiers = () => {
      modifiers.current = { shiftKey: false, altKey: false };
      setActiveGuides([]);
    };
    window.addEventListener('keydown', updateModifiers);
    window.addEventListener('keyup', updateModifiers);
    window.addEventListener('blur', clearModifiers);
    return () => {
      window.removeEventListener('keydown', updateModifiers);
      window.removeEventListener('keyup', updateModifiers);
      window.removeEventListener('blur', clearModifiers);
    };
  }, [flow]);

  const match = nodes.find(node => node.data.matched);
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

  useEffect(() => {
    if (!fitRequested.current) return;
    fitRequested.current = false;
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.1, duration: 250, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [positions, flow]);

  function storeLayout(next: PositionMap) {
    setPositions(next);
    setLayoutMessage('');
    try {
      if (next.size) localStorage.setItem(layoutKey, JSON.stringify(Object.fromEntries(next)));
      else localStorage.removeItem(layoutKey);
    } catch {
      setLayoutMessage('Trình duyệt không lưu được bố cục.');
    }
  }

  async function importLayout(file?: File) {
    if (!file) return;
    try {
      if (file.size > 131072) throw new Error('Layout too large');
      const next = parseLayout(await file.text());
      const ids = new Set(snapshot?.devices.map(device => device.id));
      fitRequested.current = true;
      storeLayout(new Map([...next].filter(([id]) => ids.has(id))));
    } catch {
      setLayoutMessage('Tệp bố cục JSON không hợp lệ.');
    }
  }

  function exportLayout() {
    const current = new Map(positions);
    for (const node of nodes) current.set(node.id, node.position);
    const url = URL.createObjectURL(new Blob([JSON.stringify(Object.fromEntries(current), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'opnsense-layout.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function focusMatch() {
    if (match) void flow.setCenter(match.position.x + bladeWidth / 2, match.position.y + bladeHeight / 2, { zoom: Math.max(zoom, 0.85), duration: 250 });
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

  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3800);
  }

  async function runNetworkAction(device?: Device) {
    notify(device ? 'Đang kiểm tra SNMP…' : 'Đang làm mới SNMP…');
    try {
      const endpoint = device ? '/api/devices/' + encodeURIComponent(device.id) + '/probe' : '/api/poll';
      const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Device-Config': '1' } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Không thực hiện được yêu cầu (' + response.status + ').');
      if (device) {
        const status = { online: 'có phản hồi', warning: 'tải cao', offline: 'không phản hồi', unknown: 'chưa rõ' };
        notify(device.name + ': ' + (status[result.status as keyof typeof status] ?? 'chưa rõ') + (result.mock ? ' (mock)' : ''));
      } else {
        await refresh();
        notify('Đã làm mới dữ liệu SNMP.');
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Kiểm tra thất bại.');
    }
  }

  function arrange() {
    fitRequested.current = true;
    storeLayout(new Map());
  }

  function fit() { void flow.fitView({ padding: 0.08, duration: 250, maxZoom: 1 }); }

  function menuItems(anchor: MenuAnchor): MenuItem[] {
    const device = anchor.device;
    if (!device) return [
      { label: 'Thêm thiết bị mới', action: () => setAction({ mode: 'add', position: flow.screenToFlowPosition({ x: anchor.x, y: anchor.y }) }) },
      { label: 'Sắp xếp tự động', action: arrange },
      { label: 'Căn giữa toàn bộ sơ đồ', action: fit },
      { label: locked ? 'Mở khóa di chuyển node' : 'Khóa di chuyển node', action: () => setLocked(!locked) },
      { label: 'Làm mới dữ liệu SNMP ngay', action: () => void runNetworkAction() },
      { label: 'Xuất bố cục JSON', action: exportLayout },
    ];
    return [
      { label: 'Sửa thiết bị', action: () => setAction({ mode: 'edit', device }) },
      { label: 'Thêm thiết bị con', action: () => setAction({ mode: 'add', device }) },
      { label: 'Kiểm tra SNMP ngay', action: () => void runNetworkAction(device) },
      { label: 'Sao chép địa chỉ IP', action: () => {
        if (!navigator.clipboard) { notify('Trình duyệt không cấp quyền clipboard.'); return; }
        void navigator.clipboard.writeText(device.ip).then(() => notify('Đã sao chép địa chỉ IP.'),
          () => notify('Không sao chép được địa chỉ IP.'));
      } },
      { label: collapsed.has(device.id) ? 'Mở rộng nhánh con' : 'Thu gọn nhánh con',
        disabled: !snapshot?.devices.some(item => item.parent_id === device.id), action: () => toggleBranch(device.id) },
      { label: 'Xóa thiết bị', danger: true, action: () => setAction({ mode: 'delete', device }) },
    ];
  }

  return (
    <div className="dashboard" ref={root}>
      <SystemBar snapshot={snapshot} connected={connected} />
      <main>
        <section className="canvas" aria-label="Sơ đồ mạng">
          <div className="toolbar command-dock" aria-label="Công cụ sơ đồ">
            <Tool icon={locked ? Lock : Unlock} label={locked ? 'Mở khóa kéo thả' : 'Khóa kéo thả'} pressed={locked} action={() => setLocked(!locked)} />
            <Tool icon={Network} label="Tự sắp xếp" action={arrange} />
            <Tool icon={Download} label="Xuất bố cục JSON" action={exportLayout} />
            <Tool icon={Upload} label="Nhập bố cục JSON" action={() => importFile.current?.click()} />
            <input hidden ref={importFile} type="file" accept=".json,application/json" onChange={event => {
              void importLayout(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }} />
            <Tool icon={labels ? Eye : EyeOff} label="Nhãn lưu lượng trên dây" pressed={labels} action={() => setLabels(!labels)} />
            <Tool icon={Search} label="Tìm thiết bị" pressed={searchOpen} action={() => { setSearchOpen(!searchOpen); setSearch(''); }} />
            <Tool icon={Maximize} label="Toàn màn hình" pressed={fullscreen} action={() => void toggleFullscreen()} />
            <Tool icon={RefreshCw} label="Làm mới dữ liệu" action={() => void refresh()} />
            <Tool icon={Plus} label="Phóng to" action={() => void flow.zoomIn({ duration: 180 })} />
            <Tool icon={Minus} label="Thu nhỏ" action={() => void flow.zoomOut({ duration: 180 })} />
            <button className="tool zoom" title="Về 100%" aria-label="Về 100%" onClick={() => void flow.zoomTo(1, { duration: 180 })}>{Math.round(zoom * 100)}%</button>
            <Tool icon={Focus} label="Căn giữa sơ đồ" action={fit} />
          </div>
          {searchOpen && <form className="search-box" onSubmit={event => { event.preventDefault(); focusMatch(); }}>
            <input autoFocus placeholder="Tên thiết bị hoặc IP" aria-label="Tên thiết bị hoặc IP" value={search} onChange={event => setSearch(event.target.value)} />
            <button type="submit" disabled={!match}>Tìm</button>
            {query && !match && <small>Không thấy thiết bị trong các nhánh đang mở</small>}
          </form>}
          <TopologyHoverContext.Provider value={emphasis}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, device: node.data.device });
            }}
            onPaneContextMenu={event => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY });
            }}
            onPaneClick={() => setSelected(undefined)}
            onNodeMouseEnter={(_, node) => {
              clearTimeout(hoverLeaveTimer.current);
              setHoveredNodeId(node.id);
            }}
            onNodeMouseLeave={(_, node) => {
              clearTimeout(hoverLeaveTimer.current);
              hoverLeaveTimer.current = window.setTimeout(() => {
                setHoveredNodeId(current => current === node.id ? null : current);
              }, 50);
            }}
            onNodeDragStart={(event, node) => {
              const width = node.measured?.width ?? bladeWidth;
              const height = node.measured?.height ?? bladeHeight;
              const origin = nodes.find(item => item.id === node.id)?.position ?? node.position;
              dragSession.current = {
                id: node.id, width, height, raw: node.position, placed: node.position,
                origin: { x: origin.x + width / 2, y: origin.y + height / 2 },
              };
              modifiers.current = { shiftKey: event.shiftKey, altKey: event.altKey };
              setMenu(undefined);
              setDragged(node.id);
              updateDrag();
            }}
            onNodeDrag={event => updateModifiers(event)}
            onMoveStart={() => setMenu(undefined)}
            onNodesChange={changes => {
              for (const change of changes) {
                if (change.type === 'select' && change.selected) setSelected(change.id);
                const session = dragSession.current;
                if (session && change.type === 'position' && change.dragging === true &&
                    change.id === session.id && change.position) {
                  session.raw = change.position;
                  updateDrag();
                }
              }
            }}
            onNodeDragStop={(_, node) => {
              const final = dragSession.current?.placed ?? node.position;
              dragSession.current = undefined;
              setActiveGuides([]);
              setDragged(undefined);
              const next = new Map(positions);
              next.set(node.id, final);
              storeLayout(next);
              setDragging(new Map());
            }}
            nodesDraggable={!locked} nodesConnectable={false} elementsSelectable minZoom={0.15} maxZoom={2}
            onMove={(_, view) => setZoom(view.zoom)}
            colorMode="dark">
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="#1e293b" />
            {activeGuides.length > 0 && <ViewportPortal>
              <svg aria-hidden="true" className="shift-snap-guide">
                {activeGuides.map(({ from, to, distance }, index) => (
                  <g key={index}>
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                      stroke={distance === undefined ? '#22d3ee' : '#f43f5e'}
                      strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    {distance !== undefined && <>
                      {[from, to].map(({ x, y }, endpoint) => (
                        <line key={endpoint} x1={x - (from.y === to.y ? 0 : 3)} y1={y - (from.y === to.y ? 3 : 0)}
                          x2={x + (from.y === to.y ? 0 : 3)} y2={y + (from.y === to.y ? 3 : 0)}
                          stroke="#f43f5e" vectorEffect="non-scaling-stroke" />
                      ))}
                      <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4} textAnchor="middle"
                        fill="#fda4af" stroke="#070b14" strokeWidth="3" paintOrder="stroke" fontSize="11"
                        fontFamily="monospace">{Number(distance.toFixed(2))}px</text>
                    </>}
                  </g>
                ))}
              </svg>
            </ViewportPortal>}
          </ReactFlow>
          </TopologyHoverContext.Provider>
          {!snapshot && <p className="canvas-message" role="status">{error ? 'Không tải được dữ liệu. Hãy thử làm mới.' : 'Đang tải sơ đồ mạng…'}</p>}
          {snapshot && error && <p className="canvas-message" role="status">Đang hiển thị dữ liệu lần cập nhật trước.</p>}
          {layoutMessage && <p className="canvas-message" role="status">{layoutMessage}</p>}
          {fullscreenError && <p className="canvas-message" role="status">Trình duyệt không thể mở toàn màn hình.</p>}
          <div className="legend"><span><i className="indicator live" />Online</span><span><i className="indicator warn" />Tải cao</span><span><i className="indicator off" />Offline</span></div>
        </section>
      </main>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} close={() => setMenu(undefined)} />}
      {toast && <div className="topology-toast" role="status">{toast}</div>}
      {action && <NodeActions action={action} onClose={() => setAction(undefined)} onSaved={id => {
        if (action.mode === 'add') {
          if (action.position) storeLayout(new Map(positions).set(id, action.position));
          if (action.device) setCollapsed(previous => {
            const next = new Set(previous);
            next.delete(action.device!.id);
            return next;
          });
        } else if (action.mode === 'delete' && positions.has(id)) {
          const next = new Map(positions);
          next.delete(id);
          storeLayout(next);
        }
        void refresh();
      }} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(window.location.pathname === '/devices'
  ? <DeviceSettings /> : <ReactFlowProvider><Dashboard /></ReactFlowProvider>);
