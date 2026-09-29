import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import { UNSUPPORTED_NODE_TYPE } from '../n8n/import.js';

/** Nó do n8n sem equivalente, trazido pelo importador para alguém substituir. */
export const n8nUnsupported: NodeType = {
  description: {
    type: UNSUPPORTED_NODE_TYPE,
    displayName: 'Nó do n8n não convertido',
    description: 'Veio do n8n e não tem equivalente aqui. Substitua por outros nós; o fluxo não pode ser ativado com ele.',
    group: 'logic',
    hidden: true,
    inputs: 1,
    outputs: 1,
    properties: [
      { name: 'n8nType', displayName: 'Tipo no n8n', type: 'string', default: '' },
      { name: 'reason', displayName: 'Motivo', type: 'string', default: '' },
      { name: 'n8nParameters', displayName: 'Configuração original', type: 'json', default: '{}' },
    ],
  },
  async execute(ctx) {
    throw new NodeOperationError(`"${ctx.node.name}" é um nó do n8n sem equivalente (${String(ctx.node.parameters.n8nType ?? '?')}); substitua-o antes de executar`);
  },
};
