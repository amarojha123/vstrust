import pino from 'pino';
import { env } from './env';
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'trust-mark' },
  redact: {
    paths: ['password', 'passwordHash', 'token', 'tokenHash', 'csrfHash', 'authorization', 'cookie', 'req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'SMTP_URL', 'JWT_SECRET', 'AI_SERVICE_TOKEN'],
    censor: '[REDACTED]',
  },
});
