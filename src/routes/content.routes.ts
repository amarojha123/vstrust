import { Router } from 'express';
import { requirePermission } from '../middlewares/security.js';
import * as controller from '../controllers/content.controller.js';

export const contentRouter = Router({ mergeParams: true });
contentRouter.get('/content', requirePermission('content:read'), controller.list);
contentRouter.post('/content', requirePermission('content:write'), controller.create);
contentRouter.get('/content/:contentId', requirePermission('content:read'), controller.get);
contentRouter.patch('/content/:contentId', requirePermission('content:write'), controller.update);
contentRouter.put('/content/:contentId/autosave', requirePermission('content:write'), controller.update);
contentRouter.post('/content/:contentId/autosave', requirePermission('content:write'), controller.update);
contentRouter.get('/content/:contentId/revisions', requirePermission('content:read'), controller.revisions);
contentRouter.get('/content/:contentId/revisions/compare', requirePermission('content:read'), controller.compare);
contentRouter.get('/content/:contentId/revisions/:revisionId', requirePermission('content:read'), controller.revision);
contentRouter.post('/content/:contentId/submit', requirePermission('content:write'), controller.submit);
contentRouter.get('/content/:contentId/reviews', requirePermission('content:read'), controller.reviews);
contentRouter.post('/content/:contentId/review', requirePermission('review:write'), controller.review);
