import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { type Accounts, usernameSchema, passwordSchema, roleSchema } from './accounts.js';

const credentials = z.object({ username: usernameSchema, password: passwordSchema });
const login = credentials.extend({ remember: z.boolean().default(false) });
const userInput = credentials.extend({ role: roleSchema });
const userChanges = z.object({ role: roleSchema.optional(), disabled: z.boolean().optional() }).strict()
  .refine(value => Object.keys(value).length > 0);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const layoutSchema = z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  z.object({ x: coordinate, y: coordinate })).refine(value => Object.keys(value).length <= 1024);
const hour = 3600_000;
const wrongCredentials = { error: 'Sai tài khoản hoặc mật khẩu' };

export function mountAccountRoutes(app: Express, accounts: Accounts, cookieName: string,
  sessionToken: (request: Request) => string | undefined, secureCookie: (request: Request) => boolean,
  originAllowed: (request: Request) => boolean) {
  const session = (request: Request) => {
    const token = sessionToken(request);
    return token ? accounts.session(token) : undefined;
  };
  const json = express.json({ limit: '4kb' });
  const router = express.Router();
  let windowStart = Date.now();
  let failures = 0;
  let pending = 0;
  const cookieOptions = (request: Request) => ({
    httpOnly: true, secure: secureCookie(request), sameSite: 'strict' as const, path: '/',
  });

  router.use(['/auth', '/users', '/layout'], (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method) &&
        (!request.headers.origin || !originAllowed(request) || !request.is('application/json'))) {
      response.sendStatus(403);
      return;
    }
    next();
  });

  router.post('/auth/login', json, async (request, response) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; failures = 0; }
    if (failures + pending >= 10 || pending >= 4) {
      response.set('Retry-After', '60').sendStatus(429);
      return;
    }
    const input = login.safeParse(request.body);
    if (!input.success) { failures++; response.status(401).json(wrongCredentials); return; }
    pending++;
    try {
      const user = await accounts.verify(input.data.username, input.data.password);
      if (!user) { failures++; response.status(401).json(wrongCredentials); return; }
      const ttl = input.data.remember ? 30 * 24 * hour : 8 * hour;
      const old = sessionToken(request);
      if (old) accounts.logout(old);
      const token = accounts.issue(user, ttl, request.ip, request.get('user-agent'));
      response.cookie(cookieName, token, { ...cookieOptions(request), ...(input.data.remember ? { maxAge: ttl } : {}) });
      response.json({ id: user.id, username: user.username, role: user.role });
    } finally { pending--; }
  });
  router.post('/auth/logout', json, (request, response) => {
    const token = sessionToken(request);
    if (token) accounts.logout(token);
    response.clearCookie(cookieName, cookieOptions(request)).sendStatus(204);
  });
  router.get('/auth/me', (request, response) => {
    const user = session(request);
    if (!user) { response.sendStatus(401); return; }
    response.json({ id: user.id, username: user.username, role: user.role });
  });
  router.post('/auth/change-password', json, async (request, response) => {
    const user = session(request);
    if (!user) { response.sendStatus(401); return; }
    const input = z.object({ currentPassword: passwordSchema, password: passwordSchema }).safeParse(request.body);
    if (!input.success) { response.sendStatus(400); return; }
    if (pending >= 4) { response.sendStatus(429); return; }
    pending++;
    try {
      const verified = await accounts.verify(user.username, input.data.currentPassword);
      if (!verified || verified.id !== user.id || !session(request) ||
          !await accounts.password(user.id, input.data.password, verified.password_hash)) {
        response.status(401).json(wrongCredentials);
        return;
      }
      response.clearCookie(cookieName, cookieOptions(request)).sendStatus(204);
    } finally { pending--; }
  });

  router.use('/users', (request: Request, response: Response, next: NextFunction) => {
    const user = session(request);
    if (!user) { response.sendStatus(401); return; }
    if (user.role !== 'admin') { response.sendStatus(403); return; }
    next();
  });
  router.get('/users', (_request, response) => response.json(accounts.users()));
  router.post('/users', json, async (request, response) => {
    const input = userInput.safeParse(request.body);
    if (!input.success) { response.sendStatus(400); return; }
    if (pending >= 4) { response.sendStatus(429); return; }
    pending++;
    try {
      response.sendStatus(await accounts.create(input.data.username, input.data.password, input.data.role) ? 201 : 409);
    } finally { pending--; }
  });
  router.patch('/users/:id', json, (request, response) => {
    const id = z.coerce.number().int().positive().safeParse(request.params.id);
    const changes = userChanges.safeParse(request.body);
    if (!id.success || !changes.success) { response.sendStatus(400); return; }
    response.sendStatus(accounts.update(id.data, changes.data));
  });
  router.delete('/users/:id', (request, response) => {
    const id = z.coerce.number().int().positive().safeParse(request.params.id);
    response.sendStatus(id.success ? accounts.update(id.data, {}, true) : 400);
  });

  router.get('/layout', (request, response) => {
    const user = session(request);
    if (!user) { response.sendStatus(401); return; }
    response.json({ layout: accounts.layout(user.id) });
  });
  router.put('/layout', express.json({ limit: '128kb' }), (request, response) => {
    const user = session(request);
    if (!user) { response.sendStatus(401); return; }
    const input = z.object({ layout: layoutSchema }).safeParse(request.body);
    if (!input.success) { response.sendStatus(400); return; }
    accounts.saveLayout(user.id, input.data.layout);
    response.sendStatus(204);
  });
  app.use('/api', router);
}
