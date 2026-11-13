import { openAccounts, usernameSchema, passwordSchema, roleSchema } from './accounts.js';

const [command, rawName, rawRole = 'viewer'] = process.argv.slice(2);
const username = usernameSchema.parse(rawName);
const accounts = openAccounts();
try {
  if (command === 'create') {
    if (!await accounts.create(username, passwordSchema.parse(process.env.USER_PASSWORD), roleSchema.parse(rawRole))) {
      throw new Error('Username already exists or the first account must be an admin');
    }
  } else {
    const user = accounts.byName(username);
    if (!user) throw new Error('User not found');
    if (command === 'passwd') {
      if (!await accounts.password(user.id, passwordSchema.parse(process.env.USER_PASSWORD))) throw new Error('User not found');
    } else if (command === 'disable') {
      if (accounts.update(user.id, { disabled: true }) !== 204) throw new Error('Cannot disable the last active admin');
    } else throw new Error('Use create, passwd or disable');
  }
  console.log('Account updated.');
} finally { accounts.close(); }
