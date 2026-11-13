import { useLanguage, LanguageSwitch, apiErrorKey, type TranslationKey } from './language';
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
  auth_protocol?: 'sha' | 'sha256' | 'sha512';
  privacy_env: string;
  privacy_protocol?: 'aes' | 'aes256b' | 'aes256r';
};

type Config = { devices: Device[]; revision: string };
type Interface = { index: number; name: string; up: boolean };
type Observed = { id: string; ip: string; interfaces: Interface[] };

const kinds: Kind[] = ['wan', 'firewall', 'core', 'switch', 'ap', 'camera', 'nas', 'home', 'server'];

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
  if (!response.ok) throw new Error(apiErrorKey(response.status, 'configError'));
  return data;
}

type SettingsProps = {
  nodeId?: string;
  mode?: 'edit' | 'delete' | 'add';
  parentId?: string;
  onSaved?: (id: string) => void;
  onStateChange?: (dirty: boolean, busy: boolean) => void;
};

function translationError(value: string, fallback: TranslationKey): TranslationKey {
  return ['missingParent', 'configError', 'invalidConfig', 'authRequired', 'readOnly', 'conflict', 'rateLimited'].includes(value)
    ? value as TranslationKey : fallback;
}

function newDevice(parent_id: string | null): Device {
  return {
    id: 'node-' + crypto.randomUUID(), name: '', ip: '', kind: 'switch', parent_id, interface_map: {},
    ports: 1, port: 161, community_env: 'SNMP_COMMUNITY',
    auth_env: 'SNMP_V3_AUTH_KEY', privacy_env: 'SNMP_V3_PRIV_KEY',
  };
}

export function DeviceSettings({ nodeId, mode, parentId, onSaved, onStateChange }: SettingsProps = {}) {
  const { t, deviceName } = useLanguage();
  const [mock, setMock] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState('');
  const [observed, setObserved] = useState<Observed[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<TranslationKey | ''>('');
  const [message, setMessage] = useState<TranslationKey | ''>('');
  const device = devices.find(item => item.id === selected);
  const parent = devices.find(item => item.id === device?.parent_id);
  const blocked = descendants(devices, selected);

  useEffect(() => {
    const controller = new AbortController();
    requestConfig({ signal: controller.signal }).then(config => {
      if (mode === 'add') {
        if (parentId && !config.devices.some(item => item.id === parentId)) {
          throw new Error('missingParent');
        }
        const draft = newDevice(parentId ?? null);
        setDevices([...config.devices, draft]);
        setSelected(draft.id);
        setRevision(config.revision);
        return;
      }
      setDevices(config.devices);
      setSelected(nodeId ?? config.devices[0]?.id ?? '');
      setRevision(config.revision);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? translationError(cause.message, 'loadConfigError') : 'loadConfigError');
    });
    async function refreshPorts() {
      try {
        const response = await fetch('/api/topology', { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        setMock(data.mock);
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
  }, [nodeId, mode, parentId]);

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
    const draft = newDevice(null);
    edit([...devices, draft]);
    setSelected(draft.id);
  }

  function removeDevice() {
    if (!device || busy || devices.length <= 1) return;
    const hasChildren = devices.some(item => item.parent_id === device.id);
    if (!mode && !window.confirm(hasChildren
      ? t('deleteChildren')
      : t('deleteConfirm'))) return;
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
      setError('requiredFields');
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
      setMessage('saved');
      onSaved?.(selected);
    } catch (cause) {
      setError(cause instanceof Error ? translationError(cause.message, 'saveError') : 'saveError');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'delete') {
    return <section className="config-delete-panel">
      {!device && !error && <p>{revision ? t('missingDevice') : t('loadingDevice')}</p>}
      {device && <p>{t('delete')} · <strong>{deviceName(device, mock)}</strong>?
        {devices.some(item => item.parent_id === device.id) && ' ' + t('childrenBecomeRoots')}
      </p>}
      {device && devices.length === 1 && <p>{t('minimumDevices')}</p>}
      {error && <p className="config-error" role="alert">{t(error)}</p>}
      <button className="config-button config-delete" type="button" onClick={removeDevice}
        disabled={busy || !device || devices.length <= 1}>
        <Trash2 size={16} /> {busy ? t('deleting') : t('confirmDelete')}
      </button>
    </section>;
  }

  return (
    <div className={mode ? 'device-settings node-settings' : 'device-settings'}>
      {!mode && <>
      <a className="config-back" href="/"><ArrowLeft size={17} /> {t('topology')}</a>
      <LanguageSwitch />
      <header className="config-heading">
        <div><h1>{t('settings')}</h1><p>{t('settingsHint')}</p></div>
        <button className="config-button" onClick={addDevice} disabled={!revision || busy}><Plus size={17} /> {t('add')}</button>
      </header>
      </>}
      <div className="config-layout">
        {!mode && <aside className="config-list" aria-label={t('deviceList')}>
          <h2>{t('devices')} <span>{devices.length}</span></h2>
          {devices.map(item => (
            <button key={item.id} className="config-item" aria-current={item.id === selected}
              disabled={busy} onClick={() => setSelected(item.id)}>
              <strong>{deviceName(item, mock) || t('untitled')}</strong>
              <small>{t(item.kind)} · {item.ip || t('noAddress')}</small>
            </button>
          ))}
        </aside>}
        <form className="config-form" onSubmit={save}>
          <fieldset disabled={busy || !device}>
            {device && <>
              <h2>{t('deviceInfo')}</h2>
              <div className="config-fields">
                <label>{t('deviceName')}<input required value={device.name} onChange={event => patch({ name: event.target.value })} /></label>
                <label>{t('managementIp')}<input required value={device.ip} onChange={event => patch({ ip: event.target.value })} /></label>
                <label>{t('deviceKind')}<select value={device.kind} onChange={event => patch({ kind: event.target.value as Kind })}>
                  {kinds.map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}
                </select></label>
                <label>{t('mockPorts')}<input type="number" min="1" required value={device.ports || ''}
                  onChange={event => patch({ ports: Number(event.target.value) })} /></label>
              </div>
              <h2><Cable size={18} /> {t('ports')}</h2>
              <div className="config-fields">
                <label>{t('parent')}<select value={device.parent_id ?? ''} onChange={event => connect(event.target.value || null)}>
                  <option value="">{t('root')}</option>
                  {devices.filter(item => !blocked.has(item.id)).map(item => (
                    <option key={item.id} value={item.id}>{deviceName(item, mock) || item.id} · {item.ip}</option>
                  ))}
                </select></label>
                <label>{t('parentPort')}
                  <input type="number" min="1" list="parent-interfaces" disabled={!parent}
                    placeholder="ifIndex" value={parent?.interface_map[device.id] ?? ''}
                    onChange={event => connect(parent?.id ?? null, event.target.value ? Number(event.target.value) : undefined)} />
                  <datalist id="parent-interfaces">{interfaceOptions(observed, parent).map(port => (
                    <option key={port.index} value={port.index}>{port.name} · {port.up ? t('up') : t('down')}</option>
                  ))}</datalist>
                  <small>{t('portHint')}</small>
                </label>
                {device.kind === 'firewall' && <label>{t('wanPort')}
                  <input type="number" min="1" list="wan-interfaces" placeholder="ifIndex" value={device.wan_interface ?? ''}
                    onChange={event => patch({ wan_interface: event.target.value ? Number(event.target.value) : null })} />
                  <datalist id="wan-interfaces">{interfaceOptions(observed, device).map(port => (
                    <option key={port.index} value={port.index}>{port.name}</option>
                  ))}</datalist>
                </label>}
              </div>
              <h2>SNMP</h2>
              <div className="config-fields">
                <label>{t('version')}<select value={device.snmp ?? ''} onChange={event => patch({ snmp: event.target.value as Device['snmp'] || null })}>
                  <option value="">{t('disabled')}</option><option value="v2c">SNMP v2c</option><option value="v3">SNMP v3</option>
                </select></label>
                {device.snmp && <label>{t('udpPort')}<input type="number" min="1" max="65535" required value={device.port || ''}
                  onChange={event => patch({ port: Number(event.target.value) })} /></label>}
                {device.snmp === 'v2c' && <label>{t('communityVar')}<input required value={device.community_env}
                  onChange={event => patch({ community_env: event.target.value })} /></label>}
                {device.snmp === 'v3' && <>
                  <label>{t('username')}<input required value={device.username ?? ''} onChange={event => patch({ username: event.target.value })} /></label>
                  <label>{t('authAlgorithm')}<select value={device.auth_protocol ?? 'sha256'}
                    onChange={event => patch({ auth_protocol: event.target.value as 'sha' | 'sha256' | 'sha512' })}>
                    <option value="sha256">SHA-256</option><option value="sha512">SHA-512</option><option value="sha">SHA-1</option>
                  </select></label>
                  <label>{t('authVar')}<input required value={device.auth_env} onChange={event => patch({ auth_env: event.target.value })} /></label>
                  <label>{t('privacyAlgorithm')}<select value={device.privacy_protocol ?? 'aes'}
                    onChange={event => patch({ privacy_protocol: event.target.value as Device['privacy_protocol'] })}>
                    <option value="aes">AES-128</option><option value="aes256b">AES-256 Blumenthal</option><option value="aes256r">AES-256 Reeder</option>
                  </select></label>
                  <label>{t('privacyVar')}<input required value={device.privacy_env} onChange={event => patch({ privacy_env: event.target.value })} /></label>
                </>}
              </div>
              {device.snmp && <p className="config-hint">{t('secretHint')}</p>}
            </>}
          </fieldset>
          {!device && <p>{revision ? (nodeId ? t('missingDevice') : t('addToStart')) : t('loadingConfig')}</p>}
          {error && <p className="config-error" role="alert">{t(error)}</p>}
          {message && <p className="config-success" role="status">{t(message)}</p>}
          <footer className="config-actions">
            {!mode && <button className="config-button config-delete" type="button" disabled={busy || !device || devices.length <= 1}
              onClick={removeDevice}><Trash2 size={16} /> {t('delete')}</button>}
            <button className="config-button config-save" type="submit" disabled={busy || !dirty}><Save size={16} />
              {busy ? t('saving') : t('save')}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
