import type { Request, Response } from 'express';
import { z } from 'zod';
import * as brand from '../services/brand.service';
import { actor } from '../utils/http';
import { paginate } from '../utils/pagination';
import { knowledgeListSchema, knowledgeSchemas, objectIdSchema, profileSchema, profileUpdateSchema, versionSchema } from '../validators/brand.validators';

export const getProfile = async (req: Request, res: Response) => { res.json({ data: await brand.getProfile(actor(req)) }); };
export const createProfile = async (req: Request, res: Response) => { res.status(201).json({ data: await brand.createProfile(actor(req), profileSchema.strict().parse(req.body)) }); };
export const updateProfile = async (req: Request, res: Response) => { res.json({ data: await brand.updateProfile(actor(req), profileUpdateSchema.parse(req.body)) }); };

export function knowledgeControllers(kind: brand.KnowledgeKind) {
  const schema = knowledgeSchemas[kind];
  return {
    list: async (req: Request, res: Response) => { const filter = knowledgeListSchema.parse(req.query); res.json(await brand.listKnowledge(actor(req), kind, paginate(req.query), filter.status)); },
    get: async (req: Request, res: Response) => { res.json({ data: await brand.getKnowledge(actor(req), kind, objectIdSchema.parse(req.params.id)) }); },
    create: async (req: Request, res: Response) => { res.status(201).json({ data: await brand.createKnowledge(actor(req), kind, schema.parse(req.body)) }); },
    update: async (req: Request, res: Response) => {
      const parsed = schema.partial().extend({ version: z.number().int().min(0) }).strict().parse(req.body);
      res.json({ data: await brand.updateKnowledge(actor(req), kind, objectIdSchema.parse(req.params.id), parsed) });
    },
    publish: async (req: Request, res: Response) => { res.json({ data: await brand.transitionKnowledge(actor(req), kind, objectIdSchema.parse(req.params.id), versionSchema.parse(req.body).version, 'published') }); },
    archive: async (req: Request, res: Response) => { res.json({ data: await brand.transitionKnowledge(actor(req), kind, objectIdSchema.parse(req.params.id), versionSchema.parse(req.body).version, 'archived') }); },
  };
}
