import type { ClientSession } from 'mongoose';
import { Membership, Notification } from '../models';
import type { Actor, Role } from '../types';
export async function notifyRole(actor: Actor, role: Role, type: string, title: string, resourceId: string, session: ClientSession) {
  const members = await Membership.find({ organizationId: actor.organizationId, role, status: 'active', userId: { $ne: actor.userId } }).session(session).select('userId');
  if (members.length) await Notification.create(members.map(m => ({ organizationId: actor.organizationId, userId: m.userId, type, title, resourceId })), { session });
}
