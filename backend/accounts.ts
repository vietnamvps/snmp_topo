import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { promisify } from 'node:util';
import { z } from 'zod';
import { migrateDevices, openDevices } from './devices.js';
import { projectRoot } from './configuration.js';

export const usernameSchema = z.string().trim().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
export const passwordSchema = z.string().min(12).max(256);
export const roleSchema = z.enum(['admin', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
type User = { id: number; username: string; role: Role; disabled: number; password_hash: string };
const derive = promisify(argon2);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const dummy = Buffer.alloc(48).toString('base64url');

async function passwordDigest(password: string, nonce: Buffer) {
  return derive('argon2id', { message: password, nonce, memory: 65536, passes: 3, parallelism: 1, tagLength: 32 });
}

async function hashPassword(password: string) {
  const nonce = randomBytes(16);
  return Buffer.concat([nonce, await passwordDigest(password, nonce)]).toString('base64url');
}

async function verifyPassword(password: string, encoded: string) {
  const stored = Buffer.from(encoded, 'base64url');
  return timingSafeEqual(await passwordDigest(password, stored.subarray(0, 16)), stored.subarray(16));
}

export function openAccounts(file = resolve(projectRoot, process.env.DATABASE_FILE || 'data/app.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version > 2) throw new Error('Account database schema is newer than this application');
    if (version === 0) db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
        disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER
      );
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, ip TEXT, user_agent TEXT
      );
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE user_layouts (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        layout_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `);
    if (version < 2) migrateDevices(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const byName = (name: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(name) as User | undefined;
  const revoke = (id: number) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  const hasUsers = () => Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  const userAudit = (actor: number | null, action: string, id: number | bigint, diff: object) =>
    db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,diff_json,at) VALUES(?,?,'user',?,?,?)")
      .run(actor, action, String(id), JSON.stringify(diff), Date.now());
  const insert = (username: string, hash: string, role: Role, actor: number | null = null) => {
    const result = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)')
      .run(username, hash, role, Date.now());
    userAudit(actor, 'create', result.lastInsertRowid, { after: { username, role, disabled: false } });
  };
  const keepAdmin = (id: number) => Boolean(db.prepare(
    "SELECT 1 FROM users WHERE role='admin' AND disabled=0 AND id<>? LIMIT 1").get(id));
  function transaction<T>(operation: () => T) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    devices: openDevices(db),
    db, hasUsers, byName,
    async bootstrap() {
      if (hasUsers() || (!process.env.ADMIN_USERNAME && !process.env.ADMIN_PASSWORD)) return;
      const username = usernameSchema.parse(process.env.ADMIN_USERNAME);
      const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);
      const hash = await hashPassword(password);
      transaction(() => { if (!hasUsers()) insert(username, hash, 'admin'); });
    },
    async create(username: string, password: string, role: Role, actor: number | null = null) {
      const hash = await hashPassword(password);
      return transaction(() => {
        if (byName(username)) return false;
        if (!hasUsers() && role !== 'admin') return false;
        insert(username, hash, role, actor);
        return true;
      });
    },
    async verify(username: string, password: string) {
      const user = byName(username);
      const valid = await verifyPassword(password, user?.password_hash ?? dummy);
      const current = byName(username);
      return valid && user && current && !current.disabled && current.password_hash === user.password_hash
        ? current : undefined;
    },
    issue(user: User, ttl: number, ip: string | undefined, userAgent: string | undefined) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      transaction(() => {
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
          .run(tokenHash(token), user.id, now + ttl, now, ip ?? null, userAgent?.slice(0, 512) ?? null);
        db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now, user.id);
      });
      return token;
    },
    session(token: string) {
      return db.prepare(`SELECT users.id, username, role, expires_at FROM sessions
        JOIN users ON users.id=sessions.user_id WHERE id_hash=? AND expires_at>? AND disabled=0`)
        .get(tokenHash(token), Date.now()) as { id: number; username: string; role: Role; expires_at: number } | undefined;
    },
    logout(token: string) { db.prepare('DELETE FROM sessions WHERE id_hash=?').run(tokenHash(token)); },
    prune() { db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now()); },
    async password(id: number, value: string, expectedHash?: string) {
      const hash = await hashPassword(value);
      return transaction(() => {
        const result = expectedHash === undefined
          ? db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id)
          : db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND disabled=0').run(hash, id, expectedHash);
        if (result.changes) {
          revoke(id);
          userAudit(expectedHash === undefined ? null : id, 'update', id, { passwordChanged: true });
        }
        return Boolean(result.changes);
      });
    },
    users() {
      return db.prepare('SELECT id,username,role,disabled,created_at,last_login_at FROM users ORDER BY username').all();
    },
    update(id: number, changes: { role?: Role; disabled?: boolean }, remove = false, actor: number | null = null) {
      return transaction(() => {
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(id) as User | undefined;
        if (!user) return 404;
        const role = changes.role ?? user.role;
        const disabled = changes.disabled ?? Boolean(user.disabled);
        if (user.role === 'admin' && !user.disabled && (remove || disabled || role !== 'admin') && !keepAdmin(id)) return 409;
        if (remove) db.prepare('DELETE FROM users WHERE id=?').run(id);
        else db.prepare('UPDATE users SET role=?, disabled=? WHERE id=?').run(role, Number(disabled), id);
        if (remove || disabled || role !== user.role) revoke(id);
        userAudit(actor, remove ? 'delete' : 'update', id, {
          before: { username: user.username, role: user.role, disabled: Boolean(user.disabled) },
          after: remove ? null : { username: user.username, role, disabled },
        });
        return 204;
      });
    },
    layout(id: number) {
      const row = db.prepare('SELECT layout_json FROM user_layouts WHERE user_id=?').get(id) as { layout_json: string } | undefined;
      return row ? JSON.parse(String(row.layout_json)) : null;
    },
    saveLayout(id: number, layout: unknown) {
      db.prepare(`INSERT INTO user_layouts VALUES(?,?,?) ON CONFLICT(user_id)
        DO UPDATE SET layout_json=excluded.layout_json, updated_at=excluded.updated_at`)
        .run(id, JSON.stringify(layout), Date.now());
    },
    close() { db.close(); },
  };
}

export type Accounts = ReturnType<typeof openAccounts>;
