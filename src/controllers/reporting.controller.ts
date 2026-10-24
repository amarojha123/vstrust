import type { Request, Response } from 'express';
import * as reporting from '../services/reporting.service';
import { analytics } from '../services/analytics.service';
import { actor, param } from '../utils/http';
export async function getAnalytics(req: Request, res: Response) { res.json({ data: await analytics(actor(req).organizationId, req.query) }); }
export async function listAuditEvents(req: Request, res: Response) { res.json(await reporting.listAuditEvents(actor(req), req.query)); }
export async function listNotifications(req: Request, res: Response) { res.json(await reporting.listNotifications(actor(req), req.query)); }
export async function markNotification(req: Request, res: Response) { res.json({ data: await reporting.markNotification(actor(req), param(req, 'notificationId')) }); }
export async function exportContent(req: Request, res: Response) {
  const contentId = param(req, 'contentId');
  const data = await reporting.exportContent(actor(req), contentId, req.query);
  res.setHeader('Content-Disposition', `attachment; filename="content-${contentId}.json"`);
  res.json({ data });
}
export async function createEvaluation(req: Request, res: Response) { res.status(201).json({ data: await reporting.createEvaluation(actor(req), req.body) }); }
export async function listEvaluations(req: Request, res: Response) { res.json(await reporting.listEvaluations(actor(req), req.query)); }
