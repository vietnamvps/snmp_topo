import express from 'express';
import { z } from 'zod';
import { YAMLParseError } from 'yaml';
import { idSchema, DeviceConfigError } from './configuration.js';
import { deviceInput, parseDeviceYaml, type openDevices } from './devices.js';
import type { configureSecurity } from './security.js';

export function deviceRoutes(store: ReturnType<typeof openDevices>, security: ReturnType<typeof configureSecurity>,
  onChange: () => void) {
  const router = express.Router();
  const write = (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (process.env.DEVICES_READ_ONLY === 'true' || !request.headers.origin ||
      !security.originAllowed(request) || request.get('X-Device-Config') !== '1') {
      response.status(403).json({ error: 'Cấu hình thiết bị chỉ đọc hoặc yêu cầu bị từ chối.' });
      return;
    }
    next();
  };
  const json = express.json({ limit: '256kb' });
  const config = () => ({ devices: store.read() });
  const actor = (request: express.Request) => security.session(request)?.id ?? null;
  router.use((request, response, next) => {
    if (security.session(request)?.role !== 'admin') {
      response.status(403).json({ error: 'Cần quyền quản trị.' });
      return;
    }
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (_request, response) => response.json(config()));
  router.get('/export', (_request, response) => {
    response.attachment('devices.yaml').type('application/yaml').send(store.exportYaml());
  });
  router.post('/import', write, express.text({ type: ['application/yaml','text/yaml','text/plain'], limit: '256kb' }),
    (request, response) => {
      const dryRun = z.enum(['true','false']).default('true').parse(request.query.dryRun) === 'true';
      const devices = parseDeviceYaml(z.string().parse(request.body));
      const changes = store.commit(() => devices, actor(request), dryRun);
      if (!dryRun) onChange();
      response.json({ changes, ...config() });
    });
  router.post('/', write, json, (request, response) => {
    const device = deviceInput.parse(request.body);
    store.commit(devices => [...devices, device], actor(request));
    onChange();
    response.status(201).json(config());
  });
  const patchSchema = deviceInput.omit({ id: true }).partial();
  router.patch('/:id', write, json, (request, response) => {
    const id = idSchema.parse(request.params.id);
    const parsed = patchSchema.parse(request.body);
    const patch = Object.fromEntries(Object.keys(request.body).map(key => [key, parsed[key as keyof typeof parsed]])) as typeof parsed;
    store.commit(devices => {
      if (!devices.some(device => device.id === id)) throw new DeviceConfigError('Không tìm thấy thiết bị.');
      return devices.map(device => device.id === id ? deviceInput.parse({
        ...device, ...patch,
        parent_if_index: patch.parent_if_index ?? (patch.parent_if_index === null || patch.parent_id !== undefined && patch.parent_id !== device.parent_id
          ? null : device.parent_if_index),
      }) : device);
    }, actor(request));
    onChange();
    response.json(config());
  });
  router.delete('/:id', write, (request, response) => {
    const id = idSchema.parse(request.params.id);
    store.commit(devices => {
      if (!devices.some(device => device.id === id)) throw new DeviceConfigError('Không tìm thấy thiết bị.');
      if (devices.some(device => device.parent_id === id)) throw new DeviceConfigError('Hãy chuyển các thiết bị con trước khi xóa.');
      return devices.filter(device => device.id !== id);
    }, actor(request));
    onChange();
    response.json(config());
  });
  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof DeviceConfigError) response.status(400).json({ error: error.message });
    else if (error instanceof z.ZodError || error instanceof YAMLParseError) response.status(400).json({ error: 'Dữ liệu thiết bị không hợp lệ.' });
    else next(error);
  });
  return router;
}
