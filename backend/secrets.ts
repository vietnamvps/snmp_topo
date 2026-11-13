import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { projectRoot, type Device } from './configuration.js';

const fields = ['community', 'auth_key', 'priv_key'] as const;
type Field = typeof fields[number];
type SecretRow = { device_id: string } & Record<`${Field}_enc`, Buffer | null>;
const secret = (min: number) => z.string().min(min).max(256).regex(/^[^\p{Cc}]+$/u).nullable().optional();
export const secretSchema = z.object({ community: secret(1), auth_key: secret(8), priv_key: secret(8) });
type SecretChanges = z.infer<typeof secretSchema>;

export function migrateSecrets(db: Database.Database) {
  db.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE device_secrets (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      community_enc BLOB, auth_key_enc BLOB, priv_key_enc BLOB, updated_at INTEGER NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    PRAGMA user_version=3;
  `);
}

const fingerprint = (key: Buffer) =>
  createHash('sha256').update(Buffer.from(hkdfSync('sha256', key, '', 'fingerprint', 32))).digest('hex');

export function encryptSecret(key: Buffer, id: string, field: Field, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id + ':' + field));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(key: Buffer, id: string, field: Field, blob: Buffer) {
  if (blob.length < 30 || blob[0] !== 1) throw new Error('Invalid encrypted SNMP record.');
  const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
  cipher.setAAD(Buffer.from(id + ':' + field));
  cipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([cipher.update(blob.subarray(29)), cipher.final()]).toString('utf8');
}

function decode(value: string) {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('SNMP master key must be canonical base64 encoding of 32 bytes.');
  return key;
}

export function openSecrets(db: Database.Database, path = resolve(projectRoot, 'data/.master.key'), env = process.env.SECRETS_MASTER_KEY) {
  const pending = path + '.next';
  const getFingerprint = () => (db.prepare("SELECT value FROM app_meta WHERE key='master_key_fingerprint'").get() as { value: string } | undefined)?.value;
  const setFingerprint = (key: Buffer) => db.prepare("INSERT OR REPLACE INTO app_meta VALUES('master_key_fingerprint',?)").run(fingerprint(key));
  function read(path: string) {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) {
      console.warn('SNMP master key file permissions are too broad. Set mode 0600.');
    }
    return decode(readFileSync(path, 'utf8').trim());
  }
  function write(path: string, key: Buffer) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, key.toString('base64') + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  let key: Buffer | undefined;
  let error: string | undefined;
  try {
    db.transaction(() => {
      const expected = getFingerprint();
      if (env !== undefined && env !== '') key = decode(env);
      else if (expected && existsSync(pending)) {
        const staged = read(pending);
        if (fingerprint(staged) === expected) renameSync(pending, path);
      }
      if (!key && existsSync(path)) key = read(path);
      if (!key && !expected) {
        key = randomBytes(32);
        write(path, key);
      }
      if (!key) throw new Error('SNMP master key is missing. Restore it from backup.');
      if (expected && expected !== fingerprint(key)) throw new Error('SNMP master key fingerprint does not match. Restore the matching key or check SECRETS_MASTER_KEY.');
      if (!expected) setFingerprint(key);
      if (existsSync(pending) && (!expected || fingerprint(key) === expected)) rmSync(pending);
    }).immediate();
  } catch (cause) {
    key = undefined;
    error = cause instanceof Error && cause.message.startsWith('SNMP master key')
      ? cause.message : 'SNMP master key could not be opened. Check file permissions and key backup.';
  }
  const get = db.prepare('SELECT * FROM device_secrets WHERE device_id=?');
  const save = db.prepare(`INSERT INTO device_secrets VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
    community_enc=excluded.community_enc, auth_key_enc=excluded.auth_key_enc, priv_key_enc=excluded.priv_key_enc,
    updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
  const row = (id: string) => get.get(id) as SecretRow | undefined;
  function resolveCredentials(device: Device) {
    const record = row(device.id);
    function value(field: Field, fallback?: string) {
      const blob = record?.[`${field}_enc`];
      if (!blob) return fallback ? process.env[fallback] : undefined;
      if (!key) return undefined;
      try { return decryptSecret(key, device.id, field, blob); } catch { return undefined; }
    }
    const community = value('community', device.community_env);
    const auth_key = value('auth_key', device.auth_env);
    const priv_key = value('priv_key', device.privacy_env);
    if (device.snmp === 'v2c' && community) return { community };
    if (device.snmp === 'v3' && device.username && auth_key && priv_key && auth_key.length >= 8 && priv_key.length >= 8) {
      return { auth_key, priv_key };
    }
    return undefined;
  }
  return {
    error,
    flags(id: string) {
      const record = row(id);
      return { has_community: Boolean(record?.community_enc), has_auth_key: Boolean(record?.auth_key_enc), has_priv_key: Boolean(record?.priv_key_enc) };
    },
    resolveCredentials,
    change(id: string, changes: SecretChanges, actor: number | null) {
      const changed = fields.filter(field => changes[field] !== undefined);
      if (!changed.length) return;
      if (!key || getFingerprint() !== fingerprint(key)) throw new SecretUnavailableError();
      const previous = row(id);
      const currentKey = key;
      const encrypted = fields.map(field => {
        const value = changes[field];
        return value === undefined ? previous?.[`${field}_enc`] ?? null
          : value === null ? null : encryptSecret(currentKey, id, field, value);
      });
      const now = Date.now();
      save.run(id, ...encrypted, now, actor);
      db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,diff_json,at) VALUES(?,'secret changed','device',?,?,?)")
        .run(actor, id, JSON.stringify({ fields: changed }), now);
    },
    rotate() {
      if (!key || getFingerprint() !== fingerprint(key)) throw new SecretUnavailableError();
      const old = key;
      const next = randomBytes(32);
      db.transaction(() => {
        if (getFingerprint() !== fingerprint(old)) throw new Error('Master key changed. Reopen the database.');
        write(pending, next);
        const rows = db.prepare('SELECT * FROM device_secrets').all() as SecretRow[];
        const update = db.prepare('UPDATE device_secrets SET community_enc=?,auth_key_enc=?,priv_key_enc=? WHERE device_id=?');
        for (const record of rows) {
          const id = record.device_id;
          update.run(...fields.map(field => {
            const blob = record[`${field}_enc`];
            return blob ? encryptSecret(next, id, field, decryptSecret(old, id, field, blob)) : null;
          }), id);
        }
        setFingerprint(next);
      }).immediate();
      db.transaction(() => {
        if (existsSync(pending)) renameSync(pending, path);
        if (fingerprint(read(path)) !== fingerprint(next)) throw new Error('Rotated key could not be confirmed.');
      }).immediate();
      key = next;
    },
  };
}

export class SecretUnavailableError extends Error {}
