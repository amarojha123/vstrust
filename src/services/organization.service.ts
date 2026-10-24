import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../config/env';
import { transaction } from '../config/database';
import { Invitation, Membership, Organization, User } from '../models';
import { enqueue } from '../jobs/queue';
import { AppError } from '../utils/errors';
import type { Actor, Role } from '../types';
import { recordAudit } from './audit.service';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function lockOrganization(actor: Actor, session: ClientSession) {
  const org = await Organization.findOneAndUpdate({ _id: actor.organizationId, status: 'active' }, { $inc: { membershipVersion: 1 } }, { new: true, session });
  if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found.');
  if (!await Membership.exists({ organizationId: actor.organizationId, userId: actor.userId, role: 'admin', status: 'active' }).session(session)) throw new AppError(403, 'FORBIDDEN', 'Organization administrator access required.');
  return org;
}

export async function createOrganization(userId: string, input: { name: string; slug: string }, correlationId: string) {
  return transaction(async session => {
    const user = await User.findOne({ _id: userId, status: 'active', emailVerifiedAt: { $exists: true } }).session(session);
    if (!user) throw new AppError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before creating an organization.');
    const [organization] = await Organization.create([{ ...input, status: 'active', membershipVersion: 0 }], { session });
    await Membership.create([{ organizationId: organization!._id, userId, role: 'admin', status: 'active' }], { session });
    await recordAudit({ userId, organizationId: String(organization!._id), role: 'admin', correlationId }, 'organization.created', 'Organization', organization!._id, {}, session);
    return organization;
  });
}

export async function listOrganizations(userId: string, page: number, limit: number) {
  const memberships = await Membership.find({ userId, status: 'active' }).select('organizationId role').lean();
  const organizationIds = memberships.map(item => item.organizationId);
  const predicate = { _id: { $in: organizationIds }, status: 'active' };
  const [organizations, total] = await Promise.all([Organization.find(predicate).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(), Organization.countDocuments(predicate)]);
  return { items: organizations.map(item => ({ ...item, role: memberships.find(member => String(member.organizationId) === String(item._id))?.role })), page, limit, total };
}

export async function organizationDetails(actor: Actor) {
  const organization = await Organization.findOne({ _id: actor.organizationId, status: 'active' });
  if (!organization) throw new AppError(404, 'NOT_FOUND', 'Organization not found.');
  return organization;
}

export async function updateOrganization(actor: Actor, input: { name?: string; slug?: string }) {
  return transaction(async session => {
    await lockOrganization(actor, session);
    const organization = await Organization.findOneAndUpdate({ _id: actor.organizationId, status: 'active' }, { $set: input }, { new: true, runValidators: true, session });
    await recordAudit(actor, 'organization.updated', 'Organization', actor.organizationId, {}, session);
    return organization;
  });
}

export async function listMembers(actor: Actor, page: number, limit: number) {
  const predicate = { organizationId: actor.organizationId, status: 'active' };
  const [items, total] = await Promise.all([Membership.find(predicate).select('_id userId role status createdAt').populate('userId', 'name email').sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit), Membership.countDocuments(predicate)]);
  return { items, total, page, limit };
}

export async function inviteMember(actor: Actor, input: { email: string; role: Role }) {
  const token = randomBytes(32).toString('hex');
  return transaction(async session => {
    await lockOrganization(actor, session);
    const existingUser = await User.findOne({ email: input.email }).session(session);
    if (existingUser && await Membership.exists({ organizationId: actor.organizationId, userId: existingUser._id, status: 'active' }).session(session)) throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member.');
    await Invitation.updateMany({ organizationId: actor.organizationId, email: input.email, acceptedAt: { $exists: false }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session });
    const [invitation] = await Invitation.create([{ organizationId: actor.organizationId, ...input, tokenHash: digest(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000), invitedBy: actor.userId }], { session });
    const link = new URL('accept-invitation', `${env.APP_URL.replace(/\/$/, '')}/`);
    link.searchParams.set('token', token);
    await enqueue('email', { to: input.email, subject: 'You have been invited to TRUST MARK', text: `Accept your organization invitation: ${link.toString()}\nThis invitation expires in seven days and requires a verified account with this email address.` }, actor.organizationId, session);
    await recordAudit(actor, 'member.invited', 'Invitation', invitation!._id, { role: input.role }, session);
    return { id: String(invitation!._id), email: input.email, role: input.role, expiresAt: invitation!.expiresAt };
  });
}

export async function listInvitations(actor: Actor, page: number, limit: number) {
  const predicate = { organizationId: actor.organizationId, acceptedAt: { $exists: false }, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } };
  const [items, total] = await Promise.all([Invitation.find(predicate).select('_id email role invitedBy createdAt expiresAt').sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit), Invitation.countDocuments(predicate)]);
  return { items, total, page, limit };
}

export async function revokeInvitation(actor: Actor, invitationId: string) {
  await transaction(async session => {
    await lockOrganization(actor, session);
    const invitation = await Invitation.findOneAndUpdate({ _id: invitationId, organizationId: actor.organizationId, acceptedAt: { $exists: false }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session });
    if (!invitation) throw new AppError(404, 'NOT_FOUND', 'Invitation not found.');
    await recordAudit(actor, 'member.invitation.revoked', 'Invitation', invitationId, {}, session);
  });
}

export async function acceptInvitation(userId: string, token: string, correlationId: string) {
  return transaction(async session => {
    const user = await User.findOne({ _id: userId, status: 'active', emailVerifiedAt: { $exists: true } }).session(session);
    if (!user) throw new AppError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before accepting an invitation.');
    const invitation = await Invitation.findOne({ tokenHash: digest(token), email: user.email, acceptedAt: { $exists: false }, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).session(session);
    if (!invitation) throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid or expired.');
    const organization = await Organization.findOneAndUpdate({ _id: invitation.organizationId, status: 'active' }, { $inc: { membershipVersion: 1 } }, { session });
    if (!organization) throw new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid or expired.');
    if (await Membership.exists({ organizationId: invitation.organizationId, userId, status: 'active' }).session(session)) throw new AppError(409, 'ALREADY_MEMBER', 'You are already a member.');
    const membership = await Membership.findOneAndUpdate({ organizationId: invitation.organizationId, userId }, { $set: { role: invitation.role, status: 'active' } }, { session, upsert: true, new: true, runValidators: true });
    const changed = await Invitation.updateOne({ _id: invitation._id, acceptedAt: { $exists: false }, revokedAt: { $exists: false } }, { $set: { acceptedAt: new Date() } }, { session });
    if (changed.modifiedCount !== 1) throw new AppError(409, 'INVITATION_CONSUMED', 'Invitation has already been used.');
    await recordAudit({ userId, organizationId: String(invitation.organizationId), role: invitation.role, correlationId }, 'member.invitation.accepted', 'Membership', membership!._id, { role: invitation.role }, session);
    return membership;
  });
}

async function protectLastAdmin(actor: Actor, membership: any, nextRole: Role | undefined, session: ClientSession) {
  if (membership.role !== 'admin' || nextRole === 'admin') return;
  const remaining = await Membership.countDocuments({ organizationId: actor.organizationId, status: 'active', role: 'admin', _id: { $ne: membership._id } }).session(session);
  if (remaining === 0) throw new AppError(409, 'LAST_ADMIN', 'An organization must retain an administrator.');
}

export async function updateRole(actor: Actor, memberId: string, role: Role) {
  return transaction(async session => {
    await lockOrganization(actor, session);
    const member = await Membership.findOne({ _id: memberId, organizationId: actor.organizationId, status: 'active' }).session(session);
    if (!member) throw new AppError(404, 'NOT_FOUND', 'Member not found.');
    await protectLastAdmin(actor, member, role, session);
    const previousRole = member.role;
    member.role = role;
    await member.save({ session });
    await recordAudit(actor, 'member.role.updated', 'Membership', memberId, { role, previousRole }, session);
    return member;
  });
}

export async function removeMember(actor: Actor, memberId: string) {
  await transaction(async session => {
    await lockOrganization(actor, session);
    const member = await Membership.findOne({ _id: memberId, organizationId: actor.organizationId, status: 'active' }).session(session);
    if (!member) throw new AppError(404, 'NOT_FOUND', 'Member not found.');
    await protectLastAdmin(actor, member, undefined, session);
    member.status = 'removed';
    await member.save({ session });
    await recordAudit(actor, 'member.removed', 'Membership', memberId, {}, session);
  });
}
