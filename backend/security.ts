import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { Express } from 'express';
import { resolve } from 'node:path';
import { projectRoot } from './configuration.js';
import type { Accounts } from './accounts.js';
import { mountAccountRoutes } from './account-routes.js';

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

export function configureSecurity(app: Express, mock: boolean, host: string, accounts: Accounts) {
  const token = process.env.DASHBOARD_TOKEN ?? '';
  if (token && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('Invalid DASHBOARD_TOKEN (32–256 URL-safe characters)');
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

  function originAllowed(request: IncomingMessage) {
    const { origin, host } = request.headers;
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    if (configuredOrigin) return false;
    return origin === 'http://' + host || origin === 'https://' + host;
  }

  function sessionToken(request: IncomingMessage) {
    const cookie = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='));
    const value = cookie?.slice(cookieName.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  function session(request: IncomingMessage) {
    const value = sessionToken(request);
    return value ? accounts.session(value) : undefined;
  }
  function authenticated(request: IncomingMessage) {
    const authorization = request.headers.authorization;
    return Boolean(mock || session(request) ||
      (token && authorization?.startsWith('Bearer ') && equal(authorization.slice(7), token)));
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

  app.get('/login', (_request, response) => response
    .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' })
    .sendFile(resolve(projectRoot, 'frontend/dist/index.html')));

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
        'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Config',
      }).sendStatus(204);
    } else {
      next();
    }
  });

  mountAccountRoutes(app, accounts, cookieName, sessionToken, request =>
    !(allowHttp && httpOrigin && request.headers.origin === configuredOrigin), originAllowed);

  app.use('/api', (request, response, next) => {
    if (!authenticated(request)) {
      response.status(401).json({ error: 'Cần đăng nhập.' });
    } else {
      if (request.headers.origin && allowedOrigins.has(request.headers.origin)) {
        response.vary('Origin').set('Access-Control-Allow-Origin', request.headers.origin);
      }
      next();
    }
  });

  app.get(['/', '/devices', '/users', '/index.html'], (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (mock || session(request)) next();
    else response.redirect('/login');
  });

  return { authenticated, session, sessionToken, originAllowed, withinRateLimit };
}
