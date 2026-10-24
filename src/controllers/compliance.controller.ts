import type { Request, Response } from 'express';
import { actor } from '../utils/http.js';
import * as service from '../services/compliance.service.js';
import { contentVersionSchema, findingDecisionSchema, findingListSchema, idempotencyKeySchema, objectId, pageSchema } from '../validators/content.validators.js';

export async function initiate(req: Request, res: Response) {
  const input = contentVersionSchema.parse(req.body);
  const key = idempotencyKeySchema.parse(req.get('Idempotency-Key'));
  const scan = await service.initiateScan(actor(req), objectId.parse(req.params.contentId), input.version, key);
  const data = scan!.toObject();
  delete data.knowledgeSnapshot;
  res.status(202).json({ data });
}
export async function list(req: Request, res: Response) {
  const { items, ...pagination } = await service.listScans(actor(req), objectId.parse(req.params.contentId), pageSchema.parse(req.query));
  res.json({ data: items, pagination });
}
export async function get(req: Request, res: Response) { res.json({ data: await service.getScan(actor(req), objectId.parse(req.params.scanId)) }); }
export async function findings(req: Request, res: Response) {
  const { items, ...pagination } = await service.listFindings(actor(req), objectId.parse(req.params.scanId), findingListSchema.parse(req.query));
  res.json({ data: items, pagination });
}
export async function finding(req: Request, res: Response) { res.json({ data: await service.getFinding(actor(req), objectId.parse(req.params.findingId)) }); }
export async function evidence(req: Request, res: Response) { res.json({ data: await service.getEvidence(actor(req), objectId.parse(req.params.findingId)) }); }
export async function decisions(req: Request, res: Response) { res.json({ data: await service.listFindingDecisions(actor(req), objectId.parse(req.params.findingId)) }); }
export async function decide(req: Request, res: Response) { res.json({ data: await service.decideFinding(actor(req), objectId.parse(req.params.findingId), findingDecisionSchema.parse(req.body)) }); }
