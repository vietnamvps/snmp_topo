import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const ifIndex = z.coerce.number<string | number>().int().min(1).max(2147483647);
export const idSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/)
  .refine(value => !Object.hasOwn(Object.prototype, value) && value !== 'prototype', 'ID dành riêng.');
const snmpEnv = z.union([z.literal(''), z.string().regex(/^SNMP_[A-Z0-9_]+$/).max(64)]);
const managementAddress = z.string().trim().max(253).refine(value =>
  (isIP(value) !== 0 && !value.includes('%')) || (
    !/^[\d.]+$/.test(value) && value.split('.').every(label =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  ), 'Nhập địa chỉ IP hoặc hostname hợp lệ.');

export const deviceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  ip: managementAddress,
  kind: z.enum(['wan', 'firewall', 'core', 'switch', 'ap', 'camera', 'nas', 'home', 'server']),
  parent_id: idSchema.nullish().transform(value => value ?? null),
  parent_if_index: ifIndex.nullish().transform(value => value ?? null),
  interface_map: z.record(idSchema, ifIndex).default({}),
  wan_interface: ifIndex.nullish().transform(value => value ?? null),
  ports: z.coerce.number().int().positive().default(1),
  monitor_mode: z.enum(['snmp', 'icmp', 'none']).optional(),
  snmp: z.enum(['v2c', 'v3']).nullish().transform(value => value ?? null),
  port: z.coerce.number().int().min(1).max(65535).default(161),
  username: z.string().trim().max(32).nullish().transform(value => value ?? null),
  auth_protocol: z.enum(['sha', 'sha256', 'sha512']).default('sha256'),
  privacy_protocol: z.enum(['aes', 'aes256b', 'aes256r']).default('aes'),
  community_env: snmpEnv.default('SNMP_COMMUNITY'),
  auth_env: snmpEnv.default('SNMP_V3_AUTH_KEY'),
  privacy_env: snmpEnv.default('SNMP_V3_PRIV_KEY'),
  enabled: z.boolean().default(true),
});

export type Device = z.infer<typeof deviceSchema>;
export class DeviceConfigError extends Error {}
