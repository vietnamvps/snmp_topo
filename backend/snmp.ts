import snmp from 'net-snmp';
import type { Device } from './configuration.js';

const OIDS = {
  name: '1.3.6.1.2.1.2.2.1.2',
  status: '1.3.6.1.2.1.2.2.1.8',
  rx: '1.3.6.1.2.1.31.1.1.1.6',
  tx: '1.3.6.1.2.1.31.1.1.1.10',
  speed: '1.3.6.1.2.1.31.1.1.1.15',
  discontinuity: '1.3.6.1.2.1.31.1.1.1.19',
  cpu: '1.3.6.1.2.1.25.3.3.1.2',
  storageType: '1.3.6.1.2.1.25.2.3.1.2',
  storageSize: '1.3.6.1.2.1.25.2.3.1.5',
  storageUsed: '1.3.6.1.2.1.25.2.3.1.6',
  lldp: '1.0.8802.1.1.2.1.4.1.1.9',
};

type TableName = keyof typeof OIDS;
type Table = Map<string, number | bigint | string>;
export type Sample = {
  timestamp: number;
  counterTimestamps?: Partial<Record<'rx' | 'tx', Map<string, number>>>;
  tables: Partial<Record<TableName, Table>>;
  uptime?: number;
};

type Credentials = { community?: string; auth_key?: string; priv_key?: string };

function createSession(device: Device, credentials: Credentials) {
  const options = { port: device.port, timeout: 800, retries: 0,
    transport: device.ip.includes(':') ? 'udp6' as const : 'udp4' as const };
  if (device.snmp === 'v2c') {
    const community = credentials.community;
    if (!community) throw new Error('Missing SNMPv2c community');
    return snmp.createSession(device.ip, community, { ...options, version: snmp.Version2c });
  }

  const authKey = credentials.auth_key;
  const privKey = credentials.priv_key;
  if (!device.username || !authKey || !privKey || authKey.length < 8 || privKey.length < 8) {
    throw new Error('SNMPv3 authPriv requires username and both passphrases');
  }

  return snmp.createV3Session(device.ip, {
    name: device.username,
    level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols[device.auth_protocol],
    privProtocol: snmp.PrivProtocols[device.privacy_protocol],
    authKey,
    privKey,
  }, options);
}

function getUptime(session: snmp.Session): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    session.get(['1.3.6.1.2.1.1.3.0'], (error, bindings) => {
      if (error) return reject(error);
      const binding = bindings?.[0];
      resolve(binding && !snmp.isVarbindError(binding) && typeof binding.value === 'number'
        ? binding.value : undefined);
    });
  });
}

export async function probeSnmp(device: Device, credentials: Credentials) {
  const session = createSession(device, credentials);
  session.on('error', () => {});
  try {
    return (await getUptime(session)) !== undefined;
  } finally {
    session.close();
  }
}

function walk(session: snmp.Session, oid: string, timestamps?: Map<string, number>): Promise<Table> {
  return new Promise((resolve, reject) => {
    const rows: Table = new Map();
    session.subtree(oid, 20, bindings => {
      const receivedAt = performance.now();
      for (const binding of bindings) {
        if (snmp.isVarbindError(binding)) continue;
        const index = binding.oid.slice(oid.length + 1);
        const value = binding.value;
        if (Buffer.isBuffer(value)) {
          if (binding.type === snmp.ObjectType.Counter64) {
            let counter = 0n;
            for (const byte of value) counter = (counter << 8n) | BigInt(byte);
            rows.set(index, counter);
            timestamps?.set(index, receivedAt);
          } else {
            rows.set(index, value.toString('utf8'));
          }
        } else if (typeof value === 'number' || typeof value === 'string') {
          rows.set(index, value);
        }
      }
    }, error => error ? reject(error) : resolve(rows));
  });
}

export async function pollSnmp(device: Device, metadata: boolean, credentials: Credentials): Promise<Sample> {
  const session = createSession(device, credentials);
  // Socket failures also surface through request callbacks or their timeout.
  session.on('error', () => {});
  try {
    const uptime = await getUptime(session);
    const names: TableName[] = ['status', 'rx', 'tx', 'discontinuity', 'speed'];
    if (metadata) names.push('name', 'lldp');
    if (device.kind === 'firewall') names.push('cpu', 'storageType', 'storageSize', 'storageUsed');
    const counterTimestamps = { rx: new Map<string, number>(), tx: new Map<string, number>() };
    const results = await Promise.allSettled(names.map(name => walk(session, OIDS[name],
      name === 'rx' || name === 'tx' ? counterTimestamps[name] : undefined)));
    const tables: Sample['tables'] = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') tables[names[index]] = result.value;
    });
    return { timestamp: performance.now(), tables, uptime, counterTimestamps };
  } finally {
    session.close();
  }
}

export function counterRate(current: Sample, previous: Sample | undefined, direction: 'rx' | 'tx', index: string) {
  if (!previous) return null;
  const currentTime = current.counterTimestamps?.[direction]?.get(index) ?? current.timestamp;
  const previousTime = previous.counterTimestamps?.[direction]?.get(index) ?? previous.timestamp;
  const elapsedMs = currentTime - previousTime;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (current.uptime !== undefined && previous.uptime !== undefined && current.uptime < previous.uptime) return null;
  if (current.tables.discontinuity?.get(index) !== previous.tables.discontinuity?.get(index)) return null;
  const newest = current.tables[direction]?.get(index);
  const oldest = previous.tables[direction]?.get(index);
  if (typeof newest !== 'bigint' || typeof oldest !== 'bigint') return null;
  // Treat a decrease as a reset even if the agent omits the discontinuity marker.
  if (newest < oldest) return null;
  return Number(newest - oldest) * 8000 / elapsedMs;
}

export function hostMetrics({ tables }: Sample) {
  const loads = [...(tables.cpu?.values() ?? [])].filter(value => typeof value === 'number');
  const ram = [...(tables.storageType ?? [])].find(([, value]) => value === '1.3.6.1.2.1.25.2.1.2');
  const size = ram && tables.storageSize?.get(ram[0]);
  const used = ram && tables.storageUsed?.get(ram[0]);
  return {
    cpu_percent: loads.length ? Math.round(10 * loads.reduce((sum, value) => sum + value, 0) / loads.length) / 10 : null,
    ram_percent: typeof size === 'number' && size > 0 && typeof used === 'number'
      ? Math.round(1000 * used / size) / 10 : null,
  };
}
