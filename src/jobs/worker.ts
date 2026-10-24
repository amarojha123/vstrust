import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { claimJob, completeJob, deferJob, extendLease, failJob } from './queue';
import { handleJob } from './handlers';

/** Bounded Mongo-backed worker. All leases are fenced again before result persistence. */
export function startWorker(): () => Promise<void> {
  const workerId = randomUUID();
  const running = new Set<Promise<void>>();
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (job: any) => {
    let leaseLost = false;
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || leaseLost) return;
      heartbeatRunning = true;
      void extendLease(String(job._id), workerId).then(extended => { if (!extended) leaseLost = true; }).catch(() => { leaseLost = true; }).finally(() => { heartbeatRunning = false; });
    }, Math.max(250, Math.floor(env.JOB_LEASE_MS / 3)));
    heartbeat.unref();
    try {
      await handleJob(job);
      if (!leaseLost) await completeJob(String(job._id), workerId);
    } catch (error) {
      if (!leaseLost) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'JOB_PROCESSING_FAILED';
        try {
          if (code === 'AI_SCAN_PENDING') { await deferJob(String(job._id), workerId, 2000); return; }
          const terminal = error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === false;
          const final = await failJob(String(job._id), workerId, code, terminal);
          logger.warn({ jobId: String(job._id), kind: job.kind, code, final }, 'Background job attempt failed');
        } catch { logger.error({ jobId: String(job._id), code: 'JOB_PERSISTENCE_FAILED' }, 'Background job state could not be persisted'); }
      }
    } finally { clearInterval(heartbeat); }
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      while (!stopped && running.size < 2) {
        const job = await claimJob(workerId);
        if (!job) break;
        if (stopped) { await deferJob(String(job._id), workerId, 0); break; }
        const pending = run(job).finally(() => running.delete(pending));
        running.add(pending);
      }
    } catch { logger.error({ code: 'JOB_POLL_FAILED' }, 'Background job polling failed'); }
    finally {
      polling = false;
      if (!stopped) { timer = setTimeout(() => { void poll(); }, env.JOB_POLL_MS); timer.unref(); }
    }
  };
  void poll();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    // A claim in flight finishes before the final wait; no new work starts after stop.
    while (polling) await new Promise(resolve => setTimeout(resolve, 10));
    await Promise.allSettled([...running]);
  };
}
