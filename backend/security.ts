import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { Express } from 'express';
import express from 'express';

const sessionSeconds = 8 * 60 * 60;
const cookieName = 'dashboard_session';
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

const allowInsecureLanHttp = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
const lanAddresses = new BlockList();
lanAddresses.addSubnet('10.0.0.0', 8);
lanAddresses.addSubnet('172.16.0.0', 12);
lanAddresses.addSubnet('192.168.0.0', 16);
lanAddresses.addSubnet('127.0.0.0', 8);
lanAddresses.addSubnet('fc00::', 7, 'ipv6');
lanAddresses.addAddress('::1', 'ipv6');

function isLanIp(hostname: string) {
  const address = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const version = isIP(address);
  return version !== 0 && lanAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

export function configureSecurity(app: Express, mock: boolean, host: string) {
  const token = process.env.DASHBOARD_TOKEN ?? '';
  if (!mock && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('Live mode requires a random DASHBOARD_TOKEN (32–256 URL-safe characters)');
  }
  const allowHttp = allowInsecureLanHttp.parse(process.env.ALLOW_INSECURE_LAN_HTTP);
  const configuredOrigin = process.env.DASHBOARD_ORIGIN;
  const dashboardUrl = configuredOrigin ? new URL(configuredOrigin) : undefined;
  const httpOrigin = dashboardUrl?.protocol === 'http:';
  if (httpOrigin && (!allowHttp || !isLanIp(dashboardUrl.hostname))) {
    throw new Error('HTTP DASHBOARD_ORIGIN requires ALLOW_INSECURE_LAN_HTTP=true and a private or loopback IP address');
  }
  const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  if (configuredOrigin) allowedOrigins.add(configuredOrigin);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Allowed origins must be exact HTTP(S) origins');
    }
  }

  if (!mock && !['127.0.0.1', '::1', 'localhost'].includes(host) && !httpOrigin && dashboardUrl?.protocol !== 'https:') {
    throw new Error('Live mode on a non-loopback bind requires HTTPS DASHBOARD_ORIGIN unless LAN HTTP is explicitly enabled');
  }

  if (httpOrigin) {
    console.warn('ALLOW_INSECURE_LAN_HTTP enabled: dashboard credentials and session traffic are unencrypted.');
  }

  const sessionKey = randomBytes(32);
  const signature = (expires: string) => createHmac('sha256', sessionKey).update(expires).digest('base64url');

  function originAllowed(request: IncomingMessage) {
    const { origin, host } = request.headers;
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    if (configuredOrigin) return false;
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

    app.get('/login', (_request, response) => response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' }).send(loginForm));
    app.post('/login', express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 2 }), (request, response) => {
      response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
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
      response.cookie(cookieName, expires + '.' + signature(expires), {
        httpOnly: true, secure: !(allowHttp && httpOrigin && request.headers.origin === configuredOrigin), sameSite: 'strict', maxAge: sessionSeconds * 1000, path: '/',
      });
      response.redirect(303, '/');
    });
  }

  let rateWindow = Date.now();
  let apiRequests = 0;
  let upgrades = 0;
  function withinRateLimit(kind: 'api' | 'ws') {
    const now = Date.now();
    if (now - rateWindow >= 60_000) {
      rateWindow = now;
      apiRequests = upgrades = 0;
    }
    return kind === 'api' ? ++apiRequests <= 1200 : ++upgrades <= 240;
  }

  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!originAllowed(request)) {
      response.status(403).json({ error: 'Origin không hợp lệ.' });
    } else if (!withinRateLimit('api')) {
      response.set('Retry-After', '60').status(429).json({ error: 'Quá nhiều yêu cầu.' });
    } else if (request.method === 'OPTIONS' && request.headers.origin && allowedOrigins.has(request.headers.origin)) {
      response.vary('Origin').set({
        'Access-Control-Allow-Origin': request.headers.origin,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Config',
      }).sendStatus(204);
    } else if (!authenticated(request)) {
      response.status(401).json({ error: 'Cần đăng nhập.' });
    } else {
      if (request.headers.origin && allowedOrigins.has(request.headers.origin)) {
        response.vary('Origin').set('Access-Control-Allow-Origin', request.headers.origin);
      }
      next();
    }
  });

  app.get(['/', '/devices', '/index.html'], (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (authenticated(request)) next();
    else response.redirect('/login');
  });

  return { authenticated, originAllowed, withinRateLimit };
}
