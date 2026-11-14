import { useLanguage, LanguageSwitch, apiErrorKey, type TranslationKey } from './language';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Cable, Plus, Save, Trash2 } from 'lucide-react';
import type { Kind } from './data';
import './device-settings.css';

type SecretField = 'community' | 'auth_key' | 'priv_key';
type SecretDraft = Partial<Record<SecretField, string>>;

type Device = {
  has_community?: boolean;
  has_auth_key?: boolean;
  has_priv_key?: boolean;
  id: string;
  name: string;
  ip: string;
  kind: Kind;
  parent_id: string | null;
  interface_map?: Record<string, number>;
  parent_if_index?: number | null;
  monitor_mode: 'snmp' | 'icmp' | 'none';
  enabled?: boolean;
  wan_interface?: number | null;
  metrics_if_index?: number | null;
  ports: number;
  snmp?: 'v2c' | 'v3' | null;
  port: number;
  username?: string | null;
  community_env?: string;
  auth_env?: string;
  auth_protocol?: 'sha' | 'sha256' | 'sha512';
  privacy_env?: string;
  privacy_protocol?: 'aes' | 'aes256b' | 'aes256r';
};

type Config = { devices: Device[]; changes?: { action: string; id: string }[] };
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

async function requestConfig(options: RequestInit = {}, path = ''): Promise<Config> {
  const response = await fetch('/api/devices' + path, options);
  if (!response.ok) throw new Error(apiErrorKey(response.status, 'configError'));
  return response.json();
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
    id: 'node-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join(''), name: '', ip: '', kind: 'switch', parent_id, monitor_mode: 'icmp',
    ports: 1, port: 161, auth_protocol: 'sha', privacy_protocol: 'aes',
  };
}

function SecretInput({ field, configured, value, onChange, onClear }: {
  field: SecretField; configured?: boolean; value?: string; onChange: (value: string | undefined) => void; onClear: () => void;
}) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const minLength = field === 'community' ? 1 : 8;
  return <div>
    <label>{t(field === 'community' ? 'communitySecret' : field === 'auth_key' ? 'authSecret' : 'privSecret')}
      <input type="password" autoComplete="new-password" minLength={minLength} maxLength={256}
        value={value ?? ''} disabled={configured && !editing}
        onChange={event => onChange(event.target.value || undefined)} />
    </label>
    {configured && <small>{t('secretConfigured')}</small>}
    {configured && <div className="config-actions">
      <button type="button" className="config-button" onClick={() => setEditing(true)}>{t('secretReplace')}</button>
      <button type="button" className="config-button" onClick={onClear}>{t('secretClear')}</button>
    </div>}
  </div>;
}

export function DeviceSettings({ nodeId, mode, parentId, onSaved, onStateChange }: SettingsProps = {}) {
  const { t, deviceName } = useLanguage();
  const [secretDraft, setSecretDraft] = useState<SecretDraft>({});
  const [mock, setMock] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [observed, setObserved] = useState<Observed[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<TranslationKey | ''>('');
  const [message, setMessage] = useState<TranslationKey | ''>('');
  const device = devices.find(item => item.id === selected);
  const parent = devices.find(item => item.id === device?.parent_id);
  const blocked = descendants(devices, selected);
  const insecurePage = location.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  function secretInput(field: SecretField) {
    return <SecretInput key={selected + ':' + field} field={field} configured={device?.[`has_${field}`]}
      value={secretDraft[field]} onClear={() => void clearSecret(field)} onChange={value => {
        setSecretDraft(previous => ({ ...previous, [field]: value }));
        setDirty(true);
      }} />;
  }

  useEffect(() => {
    setSecretDraft({});
    const controller = new AbortController();
    requestConfig({ signal: controller.signal }).then(config => {
      setSavedIds(config.devices.map(item => item.id));
      setLoaded(true);
      if (mode === 'add') {
        if (parentId && !config.devices.some(item => item.id === parentId)) {
          throw new Error('missingParent');
        }
        const draft = newDevice(parentId ?? null);
        setDevices([...config.devices, draft]);
        setSelected(draft.id);

        return;
      }
      setDevices(config.devices);
      setSelected(nodeId ?? config.devices[0]?.id ?? '');

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
    patch({ parent_id: parentId, parent_if_index: index ?? null });
  }

  function addDevice() {
    const draft = newDevice(null);
    edit([...devices, draft]);
    setSelected(draft.id);
  }

  const hasChildren = devices.some(item => item.parent_id === selected);
  const headers = { 'Content-Type': 'application/json', 'X-Device-Config': '1' };

  async function clearSecret(field: SecretField) {
    if (!device || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await requestConfig({
        method: 'PATCH', headers, body: JSON.stringify({ [field]: null }),
      }, '/' + device.id);
      const updated = saved.devices.find(item => item.id === device.id);
      setDevices(current => current.map(item => item.id === device.id
        ? { ...item, [`has_${field}`]: updated?.[`has_${field}`] } : item));
      setSecretDraft(current => ({ ...current, [field]: undefined }));
      setMessage('secretCleared');
    } catch (cause) {
      setError(cause instanceof Error ? translationError(cause.message, 'saveError') : 'saveError');
    } finally {
      setBusy(false);
    }
  }

  function removeDevice() {
    if (!device || busy || hasChildren || (!mode && !window.confirm(t('deleteConfirm')))) return;
    if (!savedIds.includes(device.id)) {
      const next = devices.filter(item => item.id !== device.id);
      setDevices(next);
      setSelected(next[0]?.id ?? '');
      setSecretDraft({});
      setDirty(false);
      return;
    }
    void persist(() => requestConfig({ method: 'DELETE', headers }, '/' + device.id), true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty || !device) return;
    const { id, interface_map: _map, has_community, has_auth_key, has_priv_key, community_env, auth_env, privacy_env, ...fields } = device;
    const exists = savedIds.includes(id);
    await persist(() => requestConfig({
      method: exists ? 'PATCH' : 'POST', headers, body: JSON.stringify({ ...(exists ? fields : { id, ...fields }), ...secretDraft }),
    }, exists ? '/' + id : ''));
  }

  async function importYaml(file: File) {
    await persist(async () => {
      if (file.size > 256 * 1024) throw new Error('invalidConfig');
      const options = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/yaml' }, body: await file.text() };
      const preview = await requestConfig(options, '/import?dryRun=true');
      const changes = preview.changes ?? [];
      if (!changes.length || !window.confirm(t('importConfirm') + '\n' +
        changes.map(change => t(change.action === 'create' ? 'add' : change.action === 'update' ? 'edit' : 'delete') + ' · ' + change.id).join('\n'))) return;
      return requestConfig(options, '/import?dryRun=false');
    }, true);
  }

  async function persist(operation: () => Promise<Config | undefined>, resetSelection = false) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await operation();
      if (!saved) return;
      setDevices(saved.devices);
      setSavedIds(saved.devices.map(item => item.id));
      if (resetSelection) setSelected(saved.devices[0]?.id ?? '');
      setSecretDraft({});
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
      {!device && !error && <p>{loaded ? t('missingDevice') : t('loadingDevice')}</p>}
      {device && <p>{t('delete')} · <strong>{deviceName(device, mock)}</strong>?
        {hasChildren && ' ' + t('moveChildrenFirst')}
      </p>}
      {error && <p className="config-error" role="alert">{t(error)}</p>}
      <button className="config-button config-delete" type="button" onClick={removeDevice}
        disabled={busy || !device || hasChildren}>
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
        <button className="config-button" onClick={addDevice} disabled={!loaded || busy || dirty}><Plus size={17} /> {t('add')}</button>
        {loaded && <a className="config-button" href="/api/devices/export">{t('exportYaml')}</a>}
        <label className="config-button">{t('importYaml')}
          <input type="file" accept=".yaml,.yml" disabled={!loaded || busy || dirty} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importYaml(file);
          }} />
        </label>
      </header>
      </>}
      <div className="config-layout">
        {!mode && <aside className="config-list" aria-label={t('deviceList')}>
          <h2>{t('devices')} <span>{devices.length}</span></h2>
          {devices.map(item => (
            <button key={item.id} className="config-item" aria-current={item.id === selected}
              disabled={busy || dirty} onClick={() => setSelected(item.id)}>
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
                    placeholder="ifIndex" value={device.parent_if_index ?? ''}
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
                <label>{t('monitorMode')}<select value={device.monitor_mode} onChange={event => {
                  const monitor_mode = event.target.value as Device['monitor_mode'];
                  patch({ monitor_mode, snmp: monitor_mode === 'snmp' ? device.snmp ?? 'v2c' : null });
                }}>
                  <option value="snmp">SNMP</option><option value="icmp">ICMP</option>
                  <option value="none">{t('disabled')}</option>
                </select></label>
                {device.monitor_mode === 'snmp' && <label>{t('ownMetricsPort')}
                  <input type="number" min="1" max="2147483647" step="1" list="metrics-interfaces"
                    placeholder="ifIndex" value={device.metrics_if_index ?? ''}
                    onChange={event => patch({ metrics_if_index: event.target.value ? event.target.valueAsNumber : null })} />
                  <datalist id="metrics-interfaces">{interfaceOptions(observed, device).map(port => (
                    <option key={port.index} value={port.index}>{port.name}</option>
                  ))}</datalist>
                </label>}
                {device.monitor_mode === 'snmp' && <label>{t('version')}<select value={device.snmp ?? ''} onChange={event => patch({ snmp: event.target.value as Device['snmp'] || null })}>
                  <option value="v2c">SNMP v2c</option><option value="v3">SNMP v3</option>
                </select></label>}
                {device.monitor_mode === 'snmp' && device.snmp && <label>{t('udpPort')}<input type="number" min="1" max="65535" required value={device.port || ''}
                  onChange={event => patch({ port: Number(event.target.value) })} /></label>}
                {device.monitor_mode === 'snmp' && device.snmp === 'v2c' && secretInput('community')}
                {device.monitor_mode === 'snmp' && device.snmp === 'v3' && <>
                  <label className="config-field-wide">{t('username')}<input required value={device.username ?? ''} onChange={event => patch({ username: event.target.value })} /></label>
                  <label>{t('authAlgorithm')}<select value={device.auth_protocol ?? 'sha256'}
                    onChange={event => patch({ auth_protocol: event.target.value as 'sha' | 'sha256' | 'sha512' })}>
                    <option value="sha">SHA-1</option><option value="sha256">SHA-256</option><option value="sha512">SHA-512</option>
                  </select><small>{t('snmpAlgorithmHint')}</small></label>
                  {secretInput('auth_key')}
                  <label>{t('privacyAlgorithm')}<select value={device.privacy_protocol ?? 'aes'}
                    onChange={event => patch({ privacy_protocol: event.target.value as Device['privacy_protocol'] })}>
                    <option value="aes">AES-128</option><option value="aes256b">AES-256 Blumenthal</option><option value="aes256r">AES-256 Reeder</option>
                  </select><small>{t('snmpAlgorithmHint')}</small></label>
                  {secretInput('priv_key')}
                </>}
              </div>
              {device.monitor_mode === 'snmp' && insecurePage && <p className="config-error" role="alert">{t('secretHttpWarning')}</p>}
              {device.snmp && <p className="config-hint">{t('secretHint')}</p>}
            </>}
          </fieldset>
          {!device && <p>{loaded ? (nodeId ? t('missingDevice') : t('addToStart')) : t('loadingConfig')}</p>}
          {error && <p className="config-error" role="alert">{t(error)}</p>}
          {message && <p className="config-success" role="status">{t(message)}</p>}
          <footer className="config-actions">
            {!mode && <button className="config-button config-delete" type="button" disabled={busy || !device || hasChildren}
              onClick={removeDevice}><Trash2 size={16} /> {t('delete')}</button>}
            <button className="config-button config-save" type="submit" disabled={busy || !dirty}><Save size={16} />
              {busy ? t('saving') : t('save')}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
