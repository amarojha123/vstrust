import { describe, expect, it } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { openapi } from '../config/openapi';
import { authRouter } from '../routes/auth.routes';
import { organizationRouter } from '../routes/organization.routes';
import { brandRouter } from '../routes/brand.routes';
import { documentRouter } from '../routes/document.routes';
import { contentRouter } from '../routes/content.routes';
import { complianceRouter } from '../routes/compliance.routes';
import { reportingRouter } from '../routes/reporting.routes';

function canonical(path: string) { return path.replace(/:[A-Za-z]\w*|\{[^}]+\}/g, '{}').replace(/\/$/, ''); }
function registered(router: any, prefix: string, nestedPrefix = ''): string[] {
  return router.stack.flatMap((layer: any) => {
    if (layer.route) return Object.keys(layer.route.methods).filter(method => layer.route.methods[method]).map(method => `${method} ${canonical(prefix + (layer.route.path === '/' ? '' : layer.route.path))}`);
    if (layer.handle?.stack) return registered(layer.handle, prefix + nestedPrefix);
    return [];
  });
}
describe('published API contract', () => {
  it('passes the OpenAPI 3 structural and reference validator', async () => {
    // The validator dereferences in place; isolate the published contract.
    const validated = await SwaggerParser.validate(JSON.parse(JSON.stringify(openapi)));
    expect(validated.info.title).toBe('TRUST MARK API');
  });
  it('documents every registered API operation and no unimplemented operations', () => {
    const tenantPrefix = '/api/v1/organizations/:organizationId';
    const actual = [
      ...registered(authRouter, '/api/v1/auth'),
      ...registered(organizationRouter, '/api/v1/organizations', '/:organizationId'),
      ...[brandRouter, documentRouter, contentRouter, complianceRouter, reportingRouter].flatMap(router => registered(router, tenantPrefix)),
    ];
    const documented = Object.entries(openapi.paths).flatMap(([path, operations]) => Object.keys(operations).map(method => `${method} ${canonical(path)}`));
    expect(actual.filter(item => !documented.includes(item)), 'Registered operations missing from OpenAPI').toEqual([]);
    expect(documented.filter(item => !actual.includes(item)), 'Documented operations missing from routers').toEqual([]);
    expect(new Set(actual).size).toBe(actual.length);
  });
});
