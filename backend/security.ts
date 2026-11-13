import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Express } from 'express';
import express from 'express';

const sessionSeconds = 8 * 60 * 60;
const cookieName = 'dashboard_session';
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

export function configureSecurity(app: Express, mock: boolean, host: string) {
  const token = process.env.DASHBOARD_TOKEN ?? '';
  if (!mock && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('Live mode requires a random DASHBOARD_TOKEN (32–256 URL-safe characters)');
  }
  const configuredOrigin = process.env.DASHBOARD_ORIGIN;
  if (configuredOrigin) {
    const url = new URL(configuredOrigin);
    if (url.origin !== configuredOrigin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('DASHBOARD_ORIGIN must be an exact HTTP(S) origin');
    }
  }

  if (!mock && !['127.0.0.1', '::1', 'localhost'].includes(host) && !configuredOrigin?.startsWith('https:')) {
    throw new Error('Live mode on a non-loopback bind requires an HTTPS DASHBOARD_ORIGIN');
  }

  const sessionKey = randomBytes(32);
  const signature = (expires: string) => createHmac('sha256', sessionKey).update(expires).digest('base64url');

  function originAllowed(request: IncomingMessage) {
    const { origin, host } = request.headers;
    if (!origin) return true;
    if (configuredOrigin) return origin === configuredOrigin;
    return origin === 'http://' + host || origin === 'https://' + host;
  }

  function authenticated(request: IncomingMessage) {
    if (mock) return true;
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') && equal(authorization.slice(7), token)) return true;
    const cookie = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='));
    const value = cookie?.slice(cookieName.length + 1);
    if (!value || !/^\d{10}\.[\w-]{43}$/.test(value)) return false;
    const [expires, mac] = value.split('.');
    return Number(expires) > Math.floor(Date.now() / 1000) && equal(mac, signature(expires));
  }

  app.use((request, response, next) => {
    const authority = request.headers.host ?? '';
    const wsOrigin = configuredOrigin
      ? configuredOrigin.replace(/^http/, 'ws')
      : /^[a-z0-9.:[\]-]+$/i.test(authority) ? ' ws://' + authority + ' wss://' + authority : '';
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' " + wsOrigin + "; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (configuredOrigin?.startsWith('https:')) response.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  if (!mock) {
    const loginForm = '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Đăng nhập dashboard</title><main><h1>Đăng nhập dashboard</h1><form method="post" action="/login"><label>Token quản trị <input name="token" type="password" autocomplete="current-password" required maxlength="256"></label> <button>Đăng nhập</button></form></main></html>';
    let windowStart = Date.now();
    let attempts = 0;

    app.get('/login', (_request, response) => response.set('Cache-Control', 'no-store').send(loginForm));
    app.post('/login', express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 2 }), (request, response) => {
      response.set('Cache-Control', 'no-store');
      if (!request.headers.origin || !originAllowed(request)) {
        response.sendStatus(403);
        return;
      }
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        attempts = 0;
      }
      if (attempts >= 10) {
        response.set('Retry-After', String(Math.ceil((60_000 - (now - windowStart)) / 1000))).sendStatus(429);
        return;
      }
      const supplied = request.body?.token;
      if (typeof supplied !== 'string' || !equal(supplied, token)) {
        attempts += 1;
        response.status(401).send(loginForm);
        return;
      }
      const expires = String(Math.floor(now / 1000) + sessionSeconds);
      const loopbackHttp = !configuredOrigin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.origin);
      response.cookie(cookieName, expires + '.' + signature(expires), {
        httpOnly: true, secure: !loopbackHttp, sameSite: 'strict', maxAge: sessionSeconds * 1000, path: '/',
      });
      response.redirect(303, '/');
    });
  }

  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!originAllowed(request)) {
      response.status(403).json({ error: 'Origin không hợp lệ.' });
    } else if (!authenticated(request)) {
      response.status(401).json({ error: 'Cần đăng nhập.' });
    } else {
      next();
    }
  });

  app.get(['/', '/devices', '/index.html'], (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (authenticated(request)) next();
    else response.redirect('/login');
  });

  return { authenticated, originAllowed };
}
