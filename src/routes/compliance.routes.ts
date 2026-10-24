import { Router } from 'express';
import { requirePermission } from '../middlewares/security.js';
import * as controller from '../controllers/compliance.controller.js';

export const complianceRouter = Router({ mergeParams: true });
complianceRouter.post('/content/:contentId/scans', requirePermission('scan:write'), controller.initiate);
complianceRouter.get('/content/:contentId/scans', requirePermission('content:read'), controller.list);
complianceRouter.get('/scans/:scanId', requirePermission('content:read'), controller.get);
complianceRouter.get('/scans/:scanId/findings', requirePermission('content:read'), controller.findings);
complianceRouter.get('/findings/:findingId', requirePermission('content:read'), controller.finding);
complianceRouter.get('/findings/:findingId/evidence', requirePermission('content:read'), controller.evidence);
complianceRouter.get('/findings/:findingId/decisions', requirePermission('content:read'), controller.decisions);
complianceRouter.post('/findings/:findingId/decisions', requirePermission('content:write'), controller.decide);
