import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Cable, Plus, Save, Trash2 } from 'lucide-react';
import type { Kind } from './data';
import './device-settings.css';

type Device = {
  id: string;
  name: string;
  ip: string;
  kind: Kind;
  parent_id: string | null;
  interface_map: Record<string, number>;
  wan_interface?: number | null;
  ports: number;
  snmp?: 'v2c' | 'v3' | null;
  port: number;
  username?: string | null;
  community_env: string;
  auth_env: string;
  auth_protocol?: 'sha' | 'sha256';
  privacy_env: string;
};

type Config = { devices: Device[]; revision: string };
type Interface = { index: number; name: string; up: boolean };
type Observed = { id: string; ip: string; interfaces: Interface[] };

const kinds: Record<Kind, string> = {
  wan: 'Internet / WAN', firewall: 'Firewall', core: 'Switch core', switch: 'Switch',
  ap: 'Wi-Fi AP', camera: 'Camera', nas: 'NAS', home: 'Home Assistant', server: 'Máy chủ',
};

function descendants(devices: Device[], id: string): Set<string> {
  const blocked = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const next = queue.pop()!;
    if (blocked.has(next)) continue;
    blocked.add(next);
    for (const device of devices) {
      if (device.parent_id === next) queue.push(device.id);
    }
  }
  return blocked;
}

function interfaceOptions(observed: Observed[], device: Device | undefined) {
  return observed.find(item => item.id === device?.id && item.ip === device.ip)?.interfaces ?? [];
}

async function requestConfig(options: RequestInit = {}): Promise<Config> {
  const response = await fetch('/api/device-config', options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Không thể tải hoặc lưu cấu hình.');
  return data;
}

type SettingsProps = {
  nodeId?: string;
  mode?: 'edit' | 'delete';
  onSaved?: () => void;
  onStateChange?: (dirty: boolean, busy: boolean) => void;
};

export function DeviceSettings({ nodeId, mode, onSaved, onStateChange }: SettingsProps = {}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState('');
  const [observed, setObserved] = useState<Observed[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const device = devices.find(item => item.id === selected);
  const parent = devices.find(item => item.id === device?.parent_id);
  const blocked = descendants(devices, selected);

  useEffect(() => {
    const controller = new AbortController();
    requestConfig({ signal: controller.signal }).then(config => {
      setDevices(config.devices);
      setSelected(nodeId ?? config.devices[0]?.id ?? '');
      setRevision(config.revision);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Không tải được cấu hình thiết bị.');
    });
    async function refreshPorts() {
      try {
        const response = await fetch('/api/topology', { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        setObserved(data.mock ? [] : data.devices);
      } catch {
        // Keep the last observed interface list during reconnects.
      }
    }
    void refreshPorts();
    const timer = setInterval(refreshPorts, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [nodeId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    onStateChange?.(dirty, busy);
  }, [dirty, busy, onStateChange]);

  function edit(next: Device[]) {
    setDevices(next);
    setDirty(true);
    setError('');
    setMessage('');
  }

  function patch(changes: Partial<Device>) {
    edit(devices.map(item => item.id === selected ? { ...item, ...changes } : item));
  }

  function connect(parentId: string | null, index?: number) {
    edit(devices.map(item => {
      if (item.id === selected) return { ...item, parent_id: parentId };
      const interface_map = { ...item.interface_map };
      if (item.id === parentId && index !== undefined) interface_map[selected] = index;
      else delete interface_map[selected];
      return { ...item, interface_map };
    }));
  }

  function addDevice() {
    const id = 'node-' + crypto.randomUUID();
    edit([...devices, {
      id, name: '', ip: '', kind: 'switch', parent_id: null, interface_map: {},
      ports: 1, port: 161, community_env: 'SNMP_COMMUNITY',
      auth_env: 'SNMP_V3_AUTH_KEY', privacy_env: 'SNMP_V3_PRIV_KEY',
    }]);
    setSelected(id);
  }

  function removeDevice() {
    if (!device || busy || devices.length <= 1) return;
    const hasChildren = devices.some(item => item.parent_id === device.id);
    if (!mode && !window.confirm(hasChildren
      ? 'Xóa thiết bị này? Các thiết bị con sẽ chuyển thành node gốc.'
      : 'Xóa thiết bị này khỏi sơ đồ?')) return;
    const next = devices.filter(item => item.id !== device.id).map(item => {
      const interface_map = { ...item.interface_map };
      delete interface_map[device.id];
      return { ...item, interface_map, parent_id: item.parent_id === device.id ? null : item.parent_id };
    });
    if (mode === 'delete') {
      void persist(next);
      return;
    }
    edit(next);
    setSelected(next[0]?.id ?? '');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    const invalid = devices.find(item => !item.name.trim() || !item.ip.trim());
    if (invalid) {
      setSelected(invalid.id);
      setError('Nhập tên và địa chỉ quản trị cho từng thiết bị.');
      return;
    }
    await persist(devices);
  }

  async function persist(next: Device[]) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await requestConfig({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Device-Config': '1' },
        body: JSON.stringify({ revision, devices: next.map(item => ({
          ...item, name: item.name.trim(), ip: item.ip.trim(), username: item.username?.trim(),
        })) }),
      });
      setDevices(saved.devices);
      setRevision(saved.revision);
      setDirty(false);
      setMessage('Đã lưu và cập nhật sơ đồ mạng.');
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không lưu được cấu hình.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'delete') {
    return <section className="config-delete-panel">
      {!device && !error && <p>{revision ? 'Thiết bị không còn trong cấu hình.' : 'Đang tải thiết bị…'}</p>}
      {device && <p>Xóa <strong>{device.name}</strong> khỏi sơ đồ?
        {devices.some(item => item.parent_id === device.id) && ' Các thiết bị con sẽ chuyển thành node gốc.'}
      </p>}
      {device && devices.length === 1 && <p>Cần giữ ít nhất một thiết bị trong sơ đồ.</p>}
      {error && <p className="config-error" role="alert">{error}</p>}
      <button className="config-button config-delete" type="button" onClick={removeDevice}
        disabled={busy || !device || devices.length <= 1}>
        <Trash2 size={16} /> {busy ? 'Đang xóa…' : 'Xác nhận xóa'}
      </button>
    </section>;
  }

  return (
    <div className={nodeId ? 'device-settings node-settings' : 'device-settings'}>
      {!nodeId && <>
      <a className="config-back" href="/"><ArrowLeft size={17} /> Sơ đồ mạng</a>
      <header className="config-heading">
        <div><h1>Cấu hình thiết bị</h1><p>Chọn thiết bị cha và cổng nối để cập nhật sơ đồ mạng.</p></div>
        <button className="config-button" onClick={addDevice} disabled={!revision || busy}><Plus size={17} /> Thêm thiết bị</button>
      </header>
      </>}
      <div className="config-layout">
        {!nodeId && <aside className="config-list" aria-label="Thiết bị mạng">
          <h2>Thiết bị <span>{devices.length}</span></h2>
          {devices.map(item => (
            <button key={item.id} className="config-item" aria-current={item.id === selected}
              disabled={busy} onClick={() => setSelected(item.id)}>
              <strong>{item.name || 'Thiết bị mới'}</strong>
              <small>{kinds[item.kind]} · {item.ip || 'Chưa có địa chỉ'}</small>
            </button>
          ))}
        </aside>}
        <form className="config-form" onSubmit={save}>
          <fieldset disabled={busy || !device}>
            {device && <>
              <h2>Thông tin thiết bị</h2>
              <div className="config-fields">
                <label>Tên thiết bị<input required value={device.name} onChange={event => patch({ name: event.target.value })} /></label>
                <label>IP / tên máy quản trị<input required value={device.ip} onChange={event => patch({ ip: event.target.value })} /></label>
                <label>Loại thiết bị<select value={device.kind} onChange={event => patch({ kind: event.target.value as Kind })}>
                  {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select></label>
                <label>Số cổng (chế độ mock)<input type="number" min="1" required value={device.ports || ''}
                  onChange={event => patch({ ports: Number(event.target.value) })} /></label>
              </div>
              <h2><Cable size={18} /> Cổng nối</h2>
              <div className="config-fields">
                <label>Thiết bị cha<select value={device.parent_id ?? ''} onChange={event => connect(event.target.value || null)}>
                  <option value="">Không có · Node gốc</option>
                  {devices.filter(item => !blocked.has(item.id)).map(item => (
                    <option key={item.id} value={item.id}>{item.name || item.id} · {item.ip}</option>
                  ))}
                </select></label>
                <label>Cổng trên thiết bị cha
                  <input type="number" min="1" list="parent-interfaces" disabled={!parent}
                    placeholder="ifIndex" value={parent?.interface_map[device.id] ?? ''}
                    onChange={event => connect(parent?.id ?? null, event.target.value ? Number(event.target.value) : undefined)} />
                  <datalist id="parent-interfaces">{interfaceOptions(observed, parent).map(port => (
                    <option key={port.index} value={port.index}>{port.name} · {port.up ? 'Up' : 'Down'}</option>
                  ))}</datalist>
                  <small>Chọn cổng đã đọc qua SNMP hoặc nhập ifIndex.</small>
                </label>
                {device.kind === 'firewall' && <label>Cổng WAN trên firewall
                  <input type="number" min="1" list="wan-interfaces" placeholder="ifIndex" value={device.wan_interface ?? ''}
                    onChange={event => patch({ wan_interface: event.target.value ? Number(event.target.value) : null })} />
                  <datalist id="wan-interfaces">{interfaceOptions(observed, device).map(port => (
                    <option key={port.index} value={port.index}>{port.name}</option>
                  ))}</datalist>
                </label>}
              </div>
              <h2>SNMP</h2>
              <div className="config-fields">
                <label>Phiên bản<select value={device.snmp ?? ''} onChange={event => patch({ snmp: event.target.value as Device['snmp'] || null })}>
                  <option value="">Tắt</option><option value="v2c">SNMP v2c</option><option value="v3">SNMP v3</option>
                </select></label>
                {device.snmp && <label>Cổng UDP<input type="number" min="1" max="65535" required value={device.port || ''}
                  onChange={event => patch({ port: Number(event.target.value) })} /></label>}
                {device.snmp === 'v2c' && <label>Tên biến community<input required value={device.community_env}
                  onChange={event => patch({ community_env: event.target.value })} /></label>}
                {device.snmp === 'v3' && <>
                  <label>Tên người dùng<input required value={device.username ?? ''} onChange={event => patch({ username: event.target.value })} /></label>
                  <label>Thuật toán xác thực<select value={device.auth_protocol ?? 'sha256'}
                    onChange={event => patch({ auth_protocol: event.target.value as 'sha' | 'sha256' })}>
                    <option value="sha256">SHA-256</option><option value="sha">SHA-1</option>
                  </select></label>
                  <label>Tên biến khóa xác thực<input required value={device.auth_env} onChange={event => patch({ auth_env: event.target.value })} /></label>
                  <label>Tên biến khóa mã hóa<input required value={device.privacy_env} onChange={event => patch({ privacy_env: event.target.value })} /></label>
                </>}
              </div>
              {device.snmp && <p className="config-hint">Giá trị community và khóa SNMP được đọc từ biến môi trường của máy chủ.</p>}
            </>}
          </fieldset>
          {!device && <p>{revision ? (nodeId ? 'Thiết bị không còn trong cấu hình.' : 'Thêm thiết bị để bắt đầu.') : 'Đang tải cấu hình…'}</p>}
          {error && <p className="config-error" role="alert">{error}</p>}
          {message && <p className="config-success" role="status">{message}</p>}
          <footer className="config-actions">
            {!nodeId && <button className="config-button config-delete" type="button" disabled={busy || !device || devices.length <= 1}
              onClick={removeDevice}><Trash2 size={16} /> Xóa thiết bị</button>}
            <button className="config-button config-save" type="submit" disabled={busy || !dirty}><Save size={16} />
              {busy ? 'Đang lưu…' : 'Lưu cấu hình'}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
