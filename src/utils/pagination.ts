import { z } from 'zod';
const schema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'title', '-title']).default('-createdAt'),
});
export function paginate(query: unknown) {
  const { page, limit, sort: field } = schema.parse(query);
  const sort: Record<string, 1 | -1> = { [field.replace(/^-/, '')]: field.startsWith('-') ? -1 : 1, _id: 1 };
  return { page, limit, skip: (page - 1) * limit, sort };
}
