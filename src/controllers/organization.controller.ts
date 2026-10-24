import type { Request, Response } from 'express';
import { z } from 'zod';
import * as organizations from '../services/organization.service';
import { actor } from '../utils/http';
import { invitationSchema, organizationSchema, roleUpdateSchema, tokenSchema } from '../validators/auth.validators';

const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) });
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const organizationUpdate = organizationSchema.partial().refine(value => Boolean(value.name || value.slug), 'Provide at least one field.');

export const organizationController = {
  create: async (req: Request, res: Response) => { res.status(201).json({ data: await organizations.createOrganization(req.auth!.userId, organizationSchema.parse(req.body), req.correlationId) }); },
  list: async (req: Request, res: Response) => {
    const { page, limit } = pagination.parse(req.query);
    const { items, total } = await organizations.listOrganizations(req.auth!.userId, page, limit);
    res.json({ data: items, pagination: { page, limit, total } });
  },
  details: async (req: Request, res: Response) => { res.json({ data: await organizations.organizationDetails(actor(req)) }); },
  update: async (req: Request, res: Response) => { res.json({ data: await organizations.updateOrganization(actor(req), organizationUpdate.parse(req.body)) }); },
  members: async (req: Request, res: Response) => {
    const { page, limit } = pagination.parse(req.query);
    const { items, total } = await organizations.listMembers(actor(req), page, limit);
    res.json({ data: items, pagination: { page, limit, total } });
  },
  invite: async (req: Request, res: Response) => { res.status(201).json({ data: await organizations.inviteMember(actor(req), invitationSchema.parse(req.body)) }); },
  invitations: async (req: Request, res: Response) => {
    const { page, limit } = pagination.parse(req.query);
    const { items, total } = await organizations.listInvitations(actor(req), page, limit);
    res.json({ data: items, pagination: { page, limit, total } });
  },
  revokeInvitation: async (req: Request, res: Response) => {
    await organizations.revokeInvitation(actor(req), objectId.parse(req.params.invitationId));
    res.status(204).send();
  },
  acceptInvitation: async (req: Request, res: Response) => {
    const { token } = tokenSchema.parse(req.body);
    res.json({ data: await organizations.acceptInvitation(req.auth!.userId, token, req.correlationId) });
  },
  updateRole: async (req: Request, res: Response) => {
    const { role } = roleUpdateSchema.parse(req.body);
    res.json({ data: await organizations.updateRole(actor(req), objectId.parse(req.params.memberId), role) });
  },
  removeMember: async (req: Request, res: Response) => {
    await organizations.removeMember(actor(req), objectId.parse(req.params.memberId));
    res.status(204).send();
  },
};
