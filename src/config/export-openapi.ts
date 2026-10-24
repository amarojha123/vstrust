import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openapi } from './openapi';
mkdirSync(resolve('docs'), { recursive: true });
writeFileSync(resolve('docs/openapi.json'), JSON.stringify(openapi, null, 2) + '\n');
