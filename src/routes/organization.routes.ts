import { Router } from 'express';
import { organizationController as controller } from '../controllers/organization.controller';
import { requirePermission, tenant } from '../middlewares/security';

export const organizationRouter = Router();
organizationRouter.get('/', controller.list);
organizationRouter.post('/', controller.create);
organizationRouter.post('/invitations/accept', controller.acceptInvitation);

const scoped = Router({ mergeParams: true });
scoped.get('/', requirePermission('organization:read'), controller.details);
scoped.patch('/', requirePermission('member:write'), controller.update);
scoped.get('/members', requirePermission('organization:read'), controller.members);
scoped.patch('/members/:memberId/role', requirePermission('member:write'), controller.updateRole);
scoped.delete('/members/:memberId', requirePermission('member:write'), controller.removeMember);
scoped.post('/invitations', requirePermission('member:write'), controller.invite);
scoped.get('/invitations', requirePermission('member:write'), controller.invitations);
scoped.delete('/invitations/:invitationId', requirePermission('member:write'), controller.revokeInvitation);
organizationRouter.use('/:organizationId', tenant, scoped);
