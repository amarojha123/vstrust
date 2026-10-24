import { createHmac } from 'node:crypto';
import type { Options, Store } from 'express-rate-limit';
import { RateLimitBucket } from '../models';
import { env } from '../config/env';
// Shared by all API replicas. Raw IPs are never stored in limiter collections.
export class MongoRateLimitStore implements Store {
  localKeys = false;
  readonly prefix: string;
  private windowMs = 60000;
  constructor(private scope: string) { this.prefix = `${scope}:`; }
  init(options: Options) { this.windowMs = options.windowMs; }
  private id(key: string) { return `${this.scope}:${createHmac('sha256', env.JWT_SECRET).update(key).digest('hex')}`; }
  async increment(key: string) {
    const now = new Date(), reset = new Date(now.getTime() + this.windowMs);
    const expired = { $lte: [{ $ifNull: ['$resetTime', new Date(0)] }, now] };
    let record;
    try {
      record = await RateLimitBucket.findOneAndUpdate({ _id: this.id(key) }, [{ $set: {
        hits: { $cond: [expired, 1, { $add: ['$hits', 1] }] }, resetTime: { $cond: [expired, reset, '$resetTime'] },
      } }], { upsert: true, new: true });
    } catch (error: any) {
      if (error.code !== 11000) throw error;
      record = await RateLimitBucket.findOneAndUpdate({ _id: this.id(key) }, { $inc: { hits: 1 } }, { new: true });
    }
    if (!record) throw new Error('Rate limiter unavailable');
    return { totalHits: record.hits!, resetTime: record.resetTime! };
  }
  async decrement(key: string) { await RateLimitBucket.updateOne({ _id: this.id(key), hits: { $gt: 0 } }, { $inc: { hits: -1 } }); }
  async resetKey(key: string) { await RateLimitBucket.deleteOne({ _id: this.id(key) }); }
}
