import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { loadBotUser, loadSessionUser, SESSION_COOKIE } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import { findConfidentialKeys, stripConfidential } from './lib/confidential.js';
import { can } from './lib/auth.js';
import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { backupRoutes } from './modules/backup/routes.js';
import { partyRoutes } from './modules/parties/routes.js';
import { locationRoutes } from './modules/parties/locations.js';
import { contractRoutes } from './modules/contracts/routes.js';
import { productRoutes } from './modules/products/routes.js';
import { dieRoutes } from './modules/dies/routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import { productionRoutes } from './modules/production/routes.js';
import { bundleRoutes } from './modules/bundles/routes.js';
import { coatingRoutes } from './modules/coating/routes.js';
import { logisticsRoutes } from './modules/logistics/routes.js';
import { materialRoutes } from './modules/materials/routes.js';
import { stockRoutes } from './modules/stock/routes.js';
import { moneyRoutes } from './modules/money/routes.js';
import { dailyRoutes } from './modules/daily/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { pdfRoutes } from './modules/pdf/routes.js';
import { botRoutes } from './modules/bot/routes.js';
import { importRoutes } from './modules/import/routes.js';
import { publicRoutes } from './modules/daily/public.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeList: Array<{ method: string; url: string }>;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Personal data never reaches the logs: no headers, no cookies, no bodies.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: ['req.headers', 'err.config'],
    },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // Registry of API routes, used by the T36 sweep so no endpoint escapes the confidentiality check.
  const routeList: Array<{ method: string; url: string }> = [];
  app.decorate('routeList', routeList);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) if (route.url.startsWith('/api/')) routeList.push({ method, url: route.url });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'blob:', 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'media-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'worker-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'object-src': ["'none'"],
      },
    },
    hsts: config.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(multipart, { attachFieldsToBody: false });
  await app.register(rateLimit, { global: false });

  // Session → request.user, for every request.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    // Telegram bot service acts on behalf of a linked user: service key + user id headers (spec §16), never a session.
    const botKey = req.headers['x-bot-key'];
    if (typeof botKey === 'string' && config.BOT_SERVICE_KEY && botKey.length === config.BOT_SERVICE_KEY.length && timingSafeEqual(Buffer.from(botKey), Buffer.from(config.BOT_SERVICE_KEY))) {
      const uid = req.headers['x-bot-user'];
      req.user = typeof uid === 'string' ? await loadBotUser(ctx.db, uid) : null;
      return;
    }
    req.user = await loadSessionUser(ctx.db, config.SESSION_SECRET, req.cookies[SESSION_COOKIE]);
  });

  // CSRF: a mutating API call must come from our own origin (SameSite=Lax covers the cookie; this covers the rest).
  app.addHook('onRequest', async (req) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    const host = req.headers.host;
    if (!origin) {
      // Non-browser clients send no Origin; browsers always do on cross-site POST. Require the custom header then.
      if (req.headers['x-requested-with'] !== 'vitral') throw new AppError('forbidden', 'درخواست از مبدأ نامعتبر');
      return;
    }
    const allowed = new Set<string>();
    if (host) {
      allowed.add(`https://${host}`);
      if (!config.COOKIE_SECURE) allowed.add(`http://${host}`);
    }
    if (config.APP_ORIGIN) allowed.add(config.APP_ORIGIN);
    if (!allowed.has(origin)) throw new AppError('forbidden', 'درخواست از مبدأ نامعتبر');
  });

  // Principle 6 safety net: the serializers already omit confidential keys for users without finance.view;
  // this hook guarantees none can slip through by any route.
  app.addHook('preSerialization', async (req, reply, payload) => {
    if (!req.url.startsWith('/api/') || reply.statusCode >= 400) return payload;
    if (can(req.user, 'finance.view')) return payload;
    const leaks = findConfidentialKeys(payload);
    if (leaks.length) {
      req.log.error({ leaks, url: req.url.split('?')[0] }, 'confidential key stripped from response');
      return stripConfidential(payload);
    }
    return payload;
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
    const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.fields) body.fields = err.fields;
      if (err.current !== undefined) body.current = err.current;
      return reply.status(err.status).send({ error: body });
    }
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const i of err.issues) fields[i.path.join('.') || '_'] = i.message;
      return reply.status(400).send({ error: { code: 'validation', message: 'اطلاعات واردشده درست نیست', fields } });
    }
    const e = err as { statusCode?: number; code?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'درخواست‌ها زیاد است؛ کمی بعد تلاش کنید' } });
    if (e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(400).send({ error: { code: 'validation', message: 'حجم فایل بیش از ۲۰ مگابایت است', fields: { file: 'حداکثر ۲۰ مگابایت' } } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'validation', message: 'درخواست نامعتبر است' } });
    }
    req.log.error({ err: { message: err.message, stack: err.stack, code: e.code }, reqId: req.id }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'validation', message: `خطای داخلی؛ شناسه درخواست ${req.id}` } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'پیدا نشد' } });
    return reply.status(404).send('Not found');
  });

  await app.register(
    async (api) => {
      await healthRoutes(api, ctx);
      await authRoutes(api, ctx);
      await userRoutes(api, ctx);
      await settingsRoutes(api, ctx);
      await fileRoutes(api, ctx);
      await backupRoutes(api, ctx);
      await partyRoutes(api, ctx);
      await locationRoutes(api, ctx);
      await contractRoutes(api, ctx);
      await productRoutes(api, ctx);
      await dieRoutes(api, ctx);
      await orderRoutes(api, ctx);
      productionRoutes(api, ctx);
      bundleRoutes(api, ctx);
      coatingRoutes(api, ctx);
      logisticsRoutes(api, ctx);
      materialRoutes(api, ctx);
      stockRoutes(api, ctx);
      moneyRoutes(api, ctx);
      dailyRoutes(api, ctx);
      reportRoutes(api, ctx);
      pdfRoutes(api, ctx);
      botRoutes(api, ctx);
      importRoutes(api, ctx);
      publicRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );

  // The built web app (fonts, icons and scripts all served from here — no CDN).
  if (config.WEB_DIST_DIR) {
    // `serve: false`: files are resolved per request (a rebuilt bundle is served without a restart);
    // the catch-all below sends the file when it exists and index.html otherwise (SPA routes such as /s/:token).
    await app.register(fastifyStatic, { root: config.WEB_DIST_DIR, serve: false, index: false });
    const distRoot = config.WEB_DIST_DIR;
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.callNotFound();
      const rel = decodeURIComponent(req.url.split('?')[0] ?? '/').replace(/^\/+/, '');
      const abs = path.resolve(distRoot, rel);
      if (rel && abs.startsWith(distRoot + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return reply.header('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache').sendFile(rel);
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  return app;
}
