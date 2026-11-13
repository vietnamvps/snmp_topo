import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

const ifIndex = z.coerce.number<string | number>().int().min(1).max(2147483647);
const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine(value => !Object.hasOwn(Object.prototype, value) && value !== 'prototype', 'ID dành riêng.');
const snmpEnv = z.string().regex(/^SNMP_[A-Z0-9_]{1,59}$/, 'Tên biến phải bắt đầu bằng SNMP_.');
const managementAddress = z.string().trim().max(253).refine(value =>
  isIP(value) !== 0 || (
    !/^[\d.]+$/.test(value) && value.split('.').every(label =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  ), 'Nhập địa chỉ IP hoặc hostname hợp lệ.');
const deviceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  ip: managementAddress,
  kind: z.enum(['wan', 'firewall', 'core', 'switch', 'ap', 'camera', 'nas', 'home', 'server']),
  parent_id: idSchema.nullish().transform(value => value ?? null),
  interface_map: z.record(idSchema, ifIndex).default({}),
  wan_interface: ifIndex.nullish(),
  ports: z.coerce.number().int().positive().default(1),
  snmp: z.enum(['v2c', 'v3']).nullish(),
  port: z.coerce.number().int().min(1).max(65535).default(161),
  username: z.string().trim().max(32).nullish(),
  auth_protocol: z.enum(['sha', 'sha256', 'sha512']).default('sha256'),
  privacy_protocol: z.enum(['aes', 'aes256b', 'aes256r']).default('aes'),
  community_env: snmpEnv.default('SNMP_COMMUNITY'),
  auth_env: snmpEnv.default('SNMP_V3_AUTH_KEY'),
  privacy_env: snmpEnv.default('SNMP_V3_PRIV_KEY'),
});

export type Device = z.infer<typeof deviceSchema>;

const devicesPath = resolve(projectRoot, process.env.DEVICES_FILE || 'config/devices.yaml');
const configSchema = z.object({ devices: z.array(deviceSchema).min(1, 'Cần ít nhất một thiết bị.').max(256) });

export function loadDevices(): Device[] {
  return validateDevices(parse(readFileSync(devicesPath, 'utf8')));
}

export function saveDevices(input: unknown): Device[] {
  const devices = validateDevices(input);
  const temporary = devicesPath + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, stringify({ devices }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, devicesPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return devices;
}

export class DeviceConfigError extends Error {}

function validateDevices(input: unknown): Device[] {
  if (input && typeof input === 'object' && 'devices' in input && Array.isArray(input.devices)) {
    for (const device of input.devices) {
      if (device?.interface_map && Object.keys(device.interface_map).some(key => !idSchema.safeParse(key).success)) {
        throw new DeviceConfigError('ID cổng nối không hợp lệ.');
      }
    }
  }
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DeviceConfigError(issue.path.join('.') + ' — ' + issue.message);
  }
  const { devices } = result.data;
  const byId = new Map(devices.map(device => [device.id, device]));
  if (byId.size !== devices.length) throw new DeviceConfigError('ID thiết bị phải duy nhất.');

  for (const device of devices) {
    if (device.snmp === 'v3' && !device.username?.trim()) {
      throw new DeviceConfigError(`Thiết bị ${device.name} cần tên người dùng SNMPv3.`);
    }
    for (const child of Object.keys(device.interface_map)) {
      if (byId.get(child)?.parent_id !== device.id) {
        throw new DeviceConfigError(`Cổng nối trên ${device.id} phải trỏ đến thiết bị con trực tiếp.`);
      }
    }

    const seen = new Set([device.id]);
    let parent = device.parent_id;
    while (parent !== null) {
      const ancestor = byId.get(parent);
      if (!ancestor || seen.has(parent)) throw new DeviceConfigError(`Thiết bị cha của ${device.id} không tồn tại hoặc tạo vòng lặp.`);
      seen.add(parent);
      parent = ancestor.parent_id;
    }
  }
  return devices;
}
