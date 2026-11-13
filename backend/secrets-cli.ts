import { openAccounts } from './accounts.js';
import { openSecrets } from './secrets.js';

const accounts = openAccounts();
try {
  const secrets = openSecrets(accounts.db);
  if (secrets.error) throw new Error(secrets.error);
  if (process.argv[2] === 'rotate') {
    secrets.rotate();
    console.log('SNMP secrets rotated. Use data/.master.key and remove SECRETS_MASTER_KEY before restarting.');
  } else if (process.argv[2] === 'check') {
    const missing = accounts.devices.read().filter(device =>
      device.enabled && device.monitor_mode === 'snmp' && !secrets.resolveCredentials(device));
    for (const device of missing) console.log(device.id + ': missing or unreadable SNMP credentials');
    console.log(missing.length + ' SNMP devices need credentials.');
    if (missing.length) process.exitCode = 1;
  } else throw new Error('Expected rotate or check.');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('SNMP master key')
    ? error.message : 'SNMP secret operation failed. Check key permissions, backup and pending rotation file.');
  process.exitCode = 1;
} finally {
  accounts.close();
}
