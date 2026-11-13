import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ping from 'ping';
import type { Device } from './configuration.js';

export async function probeIcmp(device: Device) {
  const address = isIP(device.ip) ? device.ip : (await lookup(device.ip)).address;
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  const options: { v6: boolean; timeout?: number; deadline?: number } = ['darwin', 'freebsd'].includes(process.platform) && family === 6
    ? { v6: true, deadline: 2 } : { v6: family === 6, timeout: 2, deadline: 3 };
  if (process.platform === 'win32') delete options.deadline;
  return (await ping.promise.probe(address, options)).alive;
}
