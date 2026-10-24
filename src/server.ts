import { app } from './app';
import { connectDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import mongoose from 'mongoose';
import { startWorker } from './jobs/worker';
async function main() {
  await connectDatabase();
  const stopWorker = env.RUN_WORKER ? startWorker() : async () => {};
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const timeout = setTimeout(() => process.exit(1), 30000).unref();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    await stopWorker();
    await mongoose.disconnect();
    clearTimeout(timeout);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
main().catch(error => { logger.fatal({ errorType: error?.name }, 'Startup failed; check environment and dependencies'); process.exitCode = 1; });
