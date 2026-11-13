import type Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { deviceSchema, projectRoot, DeviceConfigError } from './configuration.js';

const legacySchema = z.object({ devices: z.array(deviceSchema).max(256) });
export const deviceInput = deviceSchema.omit({ interface_map: true }).extend({ monitor_mode: z.enum(['snmp','icmp','none']).default('snmp') }).strict();
export type DeviceRow = z.infer<typeof deviceInput>;
const columns = ['id','name','ip','kind','parent_id','parent_if_index','wan_interface','ports','monitor_mode',
  'snmp_version','udp_port','username','auth_protocol','privacy_protocol','community_env','auth_env','privacy_env','enabled'] as const;

export function migrateDevices(db: Database.Database) {
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, ip TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('wan','firewall','core','switch','ap','camera','nas','home','server')),
      parent_id TEXT REFERENCES devices(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
      parent_if_index INTEGER, wan_interface INTEGER, ports INTEGER NOT NULL,
      monitor_mode TEXT NOT NULL DEFAULT 'snmp' CHECK(monitor_mode IN ('snmp','icmp','none')),
      snmp_version TEXT CHECK(snmp_version IN ('v2c','v3')), udp_port INTEGER NOT NULL,
      username TEXT, auth_protocol TEXT NOT NULL, privacy_protocol TEXT NOT NULL,
      community_env TEXT NOT NULL, auth_env TEXT NOT NULL, privacy_env TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX devices_parent ON devices(parent_id);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, diff_json TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE device_seed (completed INTEGER PRIMARY KEY CHECK(completed=1));
    PRAGMA user_version=2;
  `);
}

export function parseDeviceYaml(source: string) {
  const legacy = legacySchema.parse(parse(source, { maxAliasCount: 0 }));
  const byId = new Map(legacy.devices.map(device => [device.id, device]));
  for (const device of legacy.devices) {
    for (const childId of Object.keys(device.interface_map)) {
      if (byId.get(childId)?.parent_id !== device.id) throw new DeviceConfigError('Cổng nối phải trỏ đến thiết bị con trực tiếp.');
    }
  }
  return legacy.devices.map(({ interface_map: _map, ...device }) => deviceInput.parse({
    ...device, monitor_mode: device.monitor_mode ?? (device.snmp ? 'snmp' : 'icmp'), parent_if_index: device.parent_if_index ??
      (device.parent_id ? byId.get(device.parent_id)?.interface_map[device.id] : null),
  }));
}

function validate(devices: DeviceRow[]) {
  if (devices.length > 256) throw new DeviceConfigError('Tối đa 256 thiết bị.');
  const byId = new Map(devices.map(device => [device.id, device]));
  if (byId.size !== devices.length) throw new DeviceConfigError('ID thiết bị phải duy nhất.');
  for (const device of devices) {
    if (device.monitor_mode === 'snmp' && (!device.snmp || (device.snmp === 'v3' && !device.username))) {
      throw new DeviceConfigError('Chế độ SNMP cần phiên bản và tên người dùng khi dùng SNMPv3.');
    }
    if (!device.parent_id && device.parent_if_index) throw new DeviceConfigError('Cổng nối cần thiết bị cha.');
    const seen = new Set([device.id]);
    let parent = device.parent_id;
    while (parent) {
      const ancestor = byId.get(parent);
      if (!ancestor || seen.has(parent)) throw new DeviceConfigError('Thiết bị cha không tồn tại hoặc tạo vòng lặp.');
      seen.add(parent);
      parent = ancestor.parent_id;
    }
  }
}

export function openDevices(db: Database.Database) {
  const list = () => (db.prepare('SELECT * FROM devices ORDER BY id').all() as Record<string, unknown>[])
    .map(row => deviceInput.parse(Object.fromEntries([
      ...columns.filter(key => !['enabled','snmp_version','udp_port'].includes(key)).map(key => [key, row[key]]),
      ['enabled', Boolean(row.enabled)], ['snmp', row.snmp_version], ['port', row.udp_port],
    ])));
  function read() {
    const devices = list().map(device => ({ ...device, interface_map: Object.create(null) as Record<string, number> }));
    const byId = new Map(devices.map(device => [device.id, device]));
    for (const device of devices) {
      const parent = device.parent_id && byId.get(device.parent_id);
      if (parent && device.parent_if_index) parent.interface_map[device.id] = device.parent_if_index;
    }
    return devices;
  }
  const upsert = db.prepare(`INSERT INTO devices (${columns.join(',')},created_at,updated_at,updated_by)
    VALUES (${columns.map(() => '?').join(',')},?,?,?) ON CONFLICT(id) DO UPDATE SET
    ${columns.slice(1).map(key => key + '=excluded.' + key).join(',')},updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
  const audit = db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,diff_json,at) VALUES(?,?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM devices WHERE id=?');
  const seeded = db.prepare('INSERT OR IGNORE INTO device_seed VALUES(1)');
  const commit = db.transaction((update: (before: DeviceRow[]) => DeviceRow[], actor: number | null, dryRun = false) => {
    const before = list();
    const after = update(before);
    validate(after);
    const old = new Map(before.map(device => [device.id, device]));
    const next = new Map(after.map(device => [device.id, device]));
    const changes = [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
      const previous = old.get(id);
      const current = next.get(id);
      if (JSON.stringify(previous) === JSON.stringify(current)) return [];
      const action = previous ? current ? 'update' : 'delete' : 'create';
      return [{ id, action, before: previous ?? null, after: current ?? null }];
    });
    if (!dryRun) {
      const now = Date.now();
      for (const change of changes) {
        const device = change.after;
        if (!device) continue;
        upsert.run(...columns.map(key => {
          if (key === 'snmp_version') return device.snmp ?? null;
          if (key === 'udp_port') return device.port;
          if (key === 'enabled') return Number(device.enabled);
          return device[key] ?? null;
        }), now, now, actor);
      }
      for (const change of changes) {
        if (!change.after) remove.run(change.id);
        audit.run(actor, change.action, 'device', change.id, JSON.stringify({ before: change.before, after: change.after }), now);
      }
      seeded.run();
    }
    return changes;
  });
  const seed = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM device_seed').get() || list().length) return;
    const path = resolve(projectRoot, process.env.DEVICES_FILE || 'config/devices.yaml');
    if (!existsSync(path)) return;
    if (statSync(path).size > 256 * 1024) throw new DeviceConfigError('Tệp seed vượt quá 256 KiB.');
    const devices = parseDeviceYaml(readFileSync(path, 'utf8'));
    commit(() => devices, null);
    console.log(`Imported ${devices.length} devices into SQLite`);
  });
  return { read, seed: () => seed.immediate(), commit: (update: (before: DeviceRow[]) => DeviceRow[],
    actor: number | null, dryRun = false) => commit.immediate(update, actor, dryRun),
    exportYaml: () => stringify({ devices: list() }) };
}
