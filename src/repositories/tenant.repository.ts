import type { Model, ClientSession } from 'mongoose';
import { objectId } from '../utils/http';
import { AppError } from '../utils/errors';

// No caller-supplied MongoDB filters enter this boundary. Both identifiers are
// checked even in jobs; a resource ID alone is never sufficient authority.
export async function tenantById(model: Model<any>, organizationId: string, id: string, session?: ClientSession) {
  objectId.parse(organizationId); objectId.parse(id);
  const item = await model.findOne({ _id: id, organizationId }).session(session ?? null);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  return item;
}
export async function compareAndSet(model: Model<any>, organizationId: string, id: string, expectedVersion: number, fields: Record<string, unknown>, session: ClientSession) {
  objectId.parse(organizationId); objectId.parse(id);
  const item = await model.findOneAndUpdate({ _id: id, organizationId, version: expectedVersion }, { $set: fields, $inc: { version: 1 } }, { new: true, runValidators: true, session });
  if (!item) throw new AppError(409, 'VERSION_CONFLICT', 'Resource changed; reload before saving');
  return item;
}
