import { connectDatabase } from './config/database';
import { logger } from './config/logger';
import { startWorker } from './jobs/worker';
import mongoose from 'mongoose';
async function main() {
  await connectDatabase();
  const stop = startWorker();
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; const deadline = setTimeout(() => process.exit(1), 30000).unref(); await stop(); await mongoose.disconnect(); clearTimeout(deadline); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
}
main().catch(error => { logger.fatal({ errorType: error?.name }, 'Worker startup failed'); process.exitCode = 1; });
