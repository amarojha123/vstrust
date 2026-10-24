import { Router } from 'express';
import { requirePermission } from '../middlewares/security';
import * as controller from '../controllers/brand.controller';
import type { KnowledgeKind } from '../services/brand.service';

export const brandRouter = Router({ mergeParams: true });
brandRouter.get('/brand-profile', requirePermission('brand:read'), controller.getProfile);
brandRouter.post('/brand-profile', requirePermission('brand:write'), controller.createProfile);
brandRouter.put('/brand-profile', requirePermission('brand:write'), controller.updateProfile);
brandRouter.patch('/brand-profile', requirePermission('brand:write'), controller.updateProfile);
for (const kind of ['guidelines', 'approved-facts', 'terminology-rules'] as KnowledgeKind[]) {
  const handlers = controller.knowledgeControllers(kind);
  brandRouter.get(`/${kind}`, requirePermission('brand:read'), handlers.list);
  brandRouter.get(`/${kind}/:id`, requirePermission('brand:read'), handlers.get);
  brandRouter.post(`/${kind}`, requirePermission('brand:write'), handlers.create);
  brandRouter.patch(`/${kind}/:id`, requirePermission('brand:write'), handlers.update);
  brandRouter.post(`/${kind}/:id/publish`, requirePermission('brand:write'), handlers.publish);
  brandRouter.post(`/${kind}/:id/archive`, requirePermission('brand:write'), handlers.archive);
}
