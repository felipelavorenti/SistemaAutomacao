/** Atualiza a parte das rotas de docs/api.md a partir de src/api-reference.ts e src/api-examples.ts. */
import { readFileSync, writeFileSync } from 'node:fs';
import { replaceRoutes } from '../src/api-markdown.js';
import { API_REFERENCE } from '../src/api-reference.js';

const file = new URL('../../../docs/api.md', import.meta.url);
writeFileSync(file, replaceRoutes(readFileSync(file, 'utf8'), API_REFERENCE));
console.log('docs/api.md atualizado');
