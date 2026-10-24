import mongoose, { type ClientSession } from 'mongoose';
import { env } from './env';
import { allModels } from '../models';

mongoose.set('strictQuery', true);
export async function connectDatabase() {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: env.NODE_ENV !== 'production', serverSelectionTimeoutMS: 10000, maxPoolSize: 30 });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB replica set or mongos required for transactions');
  if (env.NODE_ENV !== 'production') await Promise.all(allModels.map(model => model.init()));
}
export async function transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
}
