import type { Device } from './configuration.js';
import { counterRate, hostMetrics, type Sample } from './snmp.js';

export type Speedtest = { ping_ms: number; down_bps: number; up_bps: number };
type Status = 'online' | 'offline' | 'warning' | 'unknown' | 'unconfigured';
type Rates = { down_bps: number | null; up_bps: number | null; status: Status };

const MOCK_PORTS_UP = new Map([['firewall', 4], ['core', 11], ['cisco', 8], ['sw1', 6], ['sw2', 4]]);
const MOCK_SPEEDTEST: Speedtest = { ping_ms: 18, down_bps: 150_500_000, up_bps: 100_800_000 };
const MOCK_DOWNLOAD: Partial<Record<Device['kind'], number>> = {
  wan: 180, firewall: 180, core: 132, switch: 24, nas: 79, camera: 0.24,
};

function interfaceData(sample: Sample | undefined, previous: Sample | undefined) {
  return new Map([...(sample?.tables.status ?? [])].map(([index, status]) => {
    const up = status === 1;
    return [Number(index), {
      index: Number(index),
      name: String(sample?.tables.name?.get(index) ?? index),
      up,
      rx_bps: up && sample ? counterRate(sample, previous, 'rx', index) : null,
      tx_bps: up && sample ? counterRate(sample, previous, 'tx', index) : null,
    }] as const;
  }));
}

function mockRates(device: Device, now: number): Rates {
  if (device.id === 'cam2') return { down_bps: 0, up_bps: 0, status: 'offline' };
  const phase = [...device.id].reduce((sum, char) => sum + char.codePointAt(0)!, 0);
  const down = (MOCK_DOWNLOAD[device.kind] ?? 7 + phase % 9) * (1 + 0.13 * Math.sin(now / 8 + phase));
  return {
    down_bps: down * 1e6,
    up_bps: (device.kind === 'camera' ? 4.3 : down * 0.31) * 1e6,
    status: device.kind === 'nas' ? 'warning' : 'online',
  };
}

function liveRates(device: Device, parent: Device | undefined,
  ports: Map<string, ReturnType<typeof interfaceData>>, sampled: boolean): Rates {
  if (device.kind === 'wan') return { down_bps: null, up_bps: null, status: 'unknown' };
  if (device.kind === 'firewall') {
    const port = ports.get(device.id)?.get(device.wan_interface ?? -1);
    if (port) return { down_bps: port.rx_bps, up_bps: port.tx_bps, status: port.up ? 'online' : 'offline' };
  } else if (parent) {
    const port = ports.get(parent.id)?.get(parent.interface_map[device.id]);
    if (port) {
      const status = !port.up ? 'offline' : device.monitor_mode === 'snmp' && !sampled ? 'unknown' : 'online';
      return { down_bps: port.tx_bps, up_bps: port.rx_bps, status };
    }
  }
  return { down_bps: null, up_bps: null, status: sampled ? 'online' : device.monitor_mode === 'snmp' ? 'offline' : 'unknown' };
}

export type TrafficHistory = Map<string, (number | null)[]>;

export function buildTopology(devices: Device[], samples: Map<string, Sample>,
  previous: Map<string, Sample>, mock: boolean, speedtest: Speedtest | null, history: TrafficHistory = new Map(), record = false, reachable = new Map<string, boolean>(), unconfigured = new Set<string>()) {
  const byId = new Map(devices.map(device => [device.id, device]));
  const ports = new Map(devices.map(({ id }) => [id, interfaceData(samples.get(id), previous.get(id))]));
  const now = performance.now() / 1000;
  const nodes = devices.map(device => {
    const { id, name, ip, kind, parent_id } = device;
    const parent = parent_id === null ? undefined : byId.get(parent_id);
    const sample = samples.get(id);
    const rates = mock ? mockRates(device, now) : liveRates(device, parent, ports, Boolean(sample));
    const host = mock ? { cpu_percent: Math.round(220 + 80 * Math.sin(now / 9)) / 10, ram_percent: 48.2, uptime_seconds: 2_073_600 + Math.floor(now) }
      : sample ? { ...hostMetrics(sample), uptime_seconds: sample.uptime == null ? null : Math.floor(sample.uptime / 100) } : null;
    const index = kind === 'firewall' ? device.wan_interface : parent?.interface_map[id];
    const portSample = kind === 'firewall' ? sample : parent ? samples.get(parent.id) : undefined;
    const speed = index == null ? undefined : portSample?.tables.speed?.get(String(index));
    const capacity = typeof speed === 'number' && speed > 0 ? speed * 1e6 : null;
    const monitoredStatus = unconfigured.has(id) ? 'unconfigured' : !mock && device.enabled && device.monitor_mode === 'icmp'
      ? reachable.has(id) ? reachable.get(id) ? 'online' : 'offline' : 'unknown'
      : !device.enabled ? 'unknown' : rates.status;
    const status = device.monitor_mode !== 'icmp' && capacity && monitoredStatus === 'online' &&
      Math.max(rates.down_bps ?? 0, rates.up_bps ?? 0) > capacity * 0.75 ? 'warning' : monitoredStatus;
    const port = index == null ? undefined : ports.get(kind === 'firewall' ? id : parent?.id ?? '')?.get(index);
    return {
      id, name, ip, kind, parent_id, ...rates, status,
      uplink: index == null ? null : { index, name: port?.name ?? null, capacity_bps: capacity },
      interfaces: [...(ports.get(id)?.values() ?? [])],
      neighbors: [...(sample?.tables.lldp?.values() ?? [])].filter(value => typeof value === 'string'),
      host: kind === 'firewall' ? host : null,
    };
  });
  const firewall = nodes.find(node => node.kind === 'firewall');
  const wan = nodes.find(node => node.kind === 'wan' && node.id === firewall?.parent_id);
  if (!mock && wan && firewall) {
    wan.down_bps = firewall.down_bps;
    wan.up_bps = firewall.up_bps;
    wan.status = firewall.status;
  }
  const withHistory = nodes.map(node => {
    let points = history.get(node.id) ?? [];
    if (record) {
      const traffic = node.down_bps == null && node.up_bps == null ? null
        : (node.down_bps ?? 0) + (node.up_bps ?? 0);
      points = [...points.slice(-14), traffic];
      history.set(node.id, points);
    }
    return { ...node, traffic_history: points };
  });
  const interfaces = nodes.flatMap(node => node.interfaces);
  return {
    updated_at: new Date().toISOString(),
    mock,
    devices: withHistory,
    summary: {
      ports_up: mock ? devices.reduce((sum, device) => sum + (MOCK_PORTS_UP.get(device.id) ?? 0), 0)
        : interfaces.filter(port => port.up).length,
      ports_total: mock ? devices.reduce((sum, device) => sum + (MOCK_PORTS_UP.has(device.id) ? device.ports : 0), 0)
        : interfaces.length,
      down_bps: firewall?.down_bps ?? null,
      up_bps: firewall?.up_bps ?? null,
      speedtest: mock ? MOCK_SPEEDTEST : speedtest,
    },
  };
}
