import './types';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { logger } from './config/logger';
import { openapi } from './config/openapi';
import { authenticate, correlation, enforceOrigin, rejectOperators, tenant } from './middlewares/security';
import { MongoRateLimitStore } from './middlewares/rate-limit';
import { errorHandler } from './middlewares/errors';
import { authRouter } from './routes/auth.routes';
import { organizationRouter } from './routes/organization.routes';
import { brandRouter } from './routes/brand.routes';
import { documentRouter } from './routes/document.routes';
import { contentRouter } from './routes/content.routes';
import { complianceRouter } from './routes/compliance.routes';
import { reportingRouter } from './routes/reporting.routes';
import { AppError } from './utils/errors';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (key: string, value: unknown) => key === '__v' ? undefined : value);
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.set('query parser', 'simple');
  app.use(correlation);
  app.use(pinoHttp({ logger, genReqId: req => (req as express.Request).correlationId,
    serializers: { req: req => ({ id: req.id, method: req.method, path: req.url?.split('?')[0] }), res: res => ({ statusCode: res.statusCode }), err: err => ({ type: err.type }) },
    customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  }));
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map(v => v.trim());
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || origins.includes(origin)), credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Correlation-ID', 'Idempotency-Key'], exposedHeaders: ['X-Correlation-ID'] }));
  app.use(enforceOrigin);
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(cookieParser());
  app.use(rejectOperators);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (_req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) throw new Error('not connected');
      await mongoose.connection.db!.command({ ping: 1 }, { timeoutMS: 2000 });
      res.json({ status: 'ready' });
    } catch { res.status(503).json({ status: 'not_ready' }); }
  });
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { swaggerOptions: { persistAuthorization: false } }));
  const limitMessage = { error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } };
  app.use('/api/v1', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/v1', rateLimit({ windowMs: 60000, limit: env.RATE_LIMIT_MAX, standardHeaders: 'draft-8', legacyHeaders: false, store: new MongoRateLimitStore('api'), message: limitMessage }));
  app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60000, limit: env.AUTH_RATE_LIMIT_MAX, standardHeaders: 'draft-8', legacyHeaders: false, store: new MongoRateLimitStore('auth'), message: limitMessage }), authRouter);
  app.use('/api/v1/organizations', authenticate, organizationRouter);
  const organizationModules = express.Router({ mergeParams: true });
  organizationModules.use(authenticate, tenant, brandRouter, documentRouter, contentRouter, complianceRouter, reportingRouter);
  app.use('/api/v1/organizations/:organizationId', organizationModules);
  app.use((_req, _res) => { throw new AppError(404, 'NOT_FOUND', 'Endpoint not found'); });
  app.use(errorHandler);
  return app;
}
export const app = createApp();
export default app;
