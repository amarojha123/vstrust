import type { Request, Response } from 'express';
import { actor } from '../utils/http.js';
import * as service from '../services/content.service.js';
import {
  compareSchema, contentListSchema, contentVersionSchema, createContentSchema,
  objectId, pageSchema, reviewDecisionSchema, updateContentSchema,
} from '../validators/content.validators.js';

const contentId = (req: Request) => objectId.parse(req.params.contentId);
export async function create(req: Request, res: Response) { res.status(201).json({ data: await service.createContent(actor(req), createContentSchema.parse(req.body)) }); }
export async function list(req: Request, res: Response) {
  const { items, ...pagination } = await service.listContent(actor(req), contentListSchema.parse(req.query));
  res.json({ data: items, pagination });
}
export async function get(req: Request, res: Response) { res.json({ data: await service.getContent(actor(req), contentId(req)) }); }
export async function update(req: Request, res: Response) { res.json({ data: await service.updateContent(actor(req), contentId(req), updateContentSchema.parse(req.body)) }); }
export async function revisions(req: Request, res: Response) {
  const { items, ...pagination } = await service.listRevisions(actor(req), contentId(req), pageSchema.parse(req.query));
  res.json({ data: items, pagination });
}
export async function revision(req: Request, res: Response) { res.json({ data: await service.getRevision(actor(req), contentId(req), objectId.parse(req.params.revisionId)) }); }
export async function compare(req: Request, res: Response) {
  const query = compareSchema.parse(req.query);
  res.json({ data: await service.compareRevisions(actor(req), contentId(req), query.from, query.to) });
}
export async function submit(req: Request, res: Response) {
  const body = contentVersionSchema.parse(req.body);
  res.json({ data: await service.submitContent(actor(req), contentId(req), body.version) });
}
export async function reviews(req: Request, res: Response) {
  const { items, ...pagination } = await service.listReviews(actor(req), contentId(req), pageSchema.parse(req.query));
  res.json({ data: items, pagination });
}
export async function review(req: Request, res: Response) { res.json({ data: await service.decideReview(actor(req), contentId(req), reviewDecisionSchema.parse(req.body)) }); }
