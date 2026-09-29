import type { NodeType } from '../node-types.js';
import { NodeOperationError } from '../node-types.js';
import type { Item, JsonValue } from '../types.js';
import { isPlainObject } from './paths.js';

interface LoopState {
  pending?: Item[];
  done?: Item[];
}

/**
 * Loop em lotes: manda um lote pela saída "loop", recebe de volta o que o ramo
 * devolveu e manda o próximo. Quando acabam os lotes, a saída "concluído"
 * entrega tudo o que voltou.
 */
export const loop: NodeType = {
  description: {
    type: 'loop',
    displayName: 'Loop',
    description: 'Processa os itens em lotes. Ligue o fim do ramo "loop" de volta na entrada deste nó.',
    group: 'logic',
    inputs: 1,
    outputs: 2,
    outputNames: ['concluído', 'loop'],
    properties: [
      {
        name: 'batchSize',
        displayName: 'Itens por lote',
        type: 'number',
        default: 1,
        description: 'Quantos itens seguem pelo ramo "loop" a cada volta.',
      },
    ],
  },
  hasPendingWork: (state) => (state as LoopState).pending !== undefined,
  async execute(ctx) {
    const state = ctx.state as LoopState;
    const input = ctx.inputs[0] ?? [];
    if (state.pending === undefined) {
      state.pending = [...input];
      state.done = [];
    } else {
      state.done!.push(...input);
    }

    const size = Math.max(1, Math.floor(Number(await ctx.getParam('batchSize', 0)) || 1));
    if (state.pending.length) return [[], state.pending.splice(0, size)];

    const done = state.done ?? [];
    delete state.pending;
    delete state.done;
    return [done, []];
  },
};

export const stopAndError: NodeType = {
  description: {
    type: 'stopAndError',
    displayName: 'Stop and Error',
    description: 'Interrompe o fluxo com erro quando algum item chega aqui.',
    group: 'logic',
    inputs: 1,
    outputs: 0,
    properties: [
      {
        name: 'errorType',
        displayName: 'Tipo de erro',
        type: 'options',
        default: 'message',
        options: [
          { name: 'Mensagem', value: 'message' },
          { name: 'Objeto JSON', value: 'object' },
        ],
      },
      { name: 'message', displayName: 'Mensagem de erro', type: 'string', default: '', required: true, showWhen: { errorType: ['message'] } },
      {
        name: 'errorObject',
        displayName: 'Objeto de erro',
        type: 'json',
        default: '{\n  "message": ""\n}',
        showWhen: { errorType: ['object'] },
        description: 'Fica registrado nos detalhes do erro. O campo "message" vira a mensagem.',
      },
    ],
  },
  async execute(ctx) {
    if ((await ctx.getParam('errorType', 0)) === 'object') {
      let value = await ctx.getParam('errorObject', 0);
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value) as JsonValue;
        } catch {
          throw new NodeOperationError('O objeto de erro não é um JSON válido');
        }
      }
      const message = isPlainObject(value) && typeof value.message === 'string' && value.message ? value.message : 'Fluxo interrompido pelo nó Stop and Error';
      throw new NodeOperationError(message, value);
    }
    const message = String((await ctx.getParam('message', 0)) ?? '').trim();
    throw new NodeOperationError(message || 'Fluxo interrompido pelo nó Stop and Error');
  },
};

const CODE_ALL = `// $input.all() traz todos os itens. Devolva uma lista de objetos.
const saida = [];
for (const item of $input.all()) {
  saida.push({ ...item.json, processado: true });
}
return saida;`;

const PYTHON_ALL = `# _input.all() traz todos os itens. Devolva uma lista de dicionários.
saida = []
for item in _input.all():
    saida.append({**item.json, "processado": True})
return saida`;

export const code: NodeType = {
  description: {
    type: 'code',
    displayName: 'Code',
    description: 'Roda JavaScript ou Python sobre os itens. console.log e print aparecem nos dados do nó.',
    group: 'data',
    inputs: 1,
    outputs: 1,
    properties: [
      {
        name: 'mode',
        displayName: 'Rodar',
        type: 'options',
        default: 'all',
        options: [
          { name: 'Uma vez com todos os itens', value: 'all' },
          { name: 'Uma vez para cada item', value: 'each' },
        ],
      },
      {
        name: 'language',
        displayName: 'Linguagem',
        type: 'options',
        default: 'javaScript',
        options: [
          { name: 'JavaScript', value: 'javaScript' },
          { name: 'Python', value: 'python' },
        ],
      },
      {
        name: 'jsCode',
        displayName: 'Código JavaScript',
        type: 'code',
        default: CODE_ALL,
        showWhen: { language: ['javaScript'] },
        description:
          'Disponível: $input.all(), $json (item atual), $("Nó").first(), $execution, $vars. Pode usar await. No modo "cada item", devolva um objeto.',
      },
      {
        name: 'pythonCode',
        displayName: 'Código Python',
        type: 'code',
        default: PYTHON_ALL,
        showWhen: { language: ['python'] },
        description:
          'Disponível: _input.all(), _json (item atual), _("Nó").first(), _execution, _vars e a biblioteca padrão do Python. item.json.campo e item.json["campo"] funcionam. No modo "cada item", devolva um dicionário.',
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const mode = await ctx.getParam('mode', 0);
    const logs: string[] = [];
    const out: Item[] = [];

    if (ctx.node.parameters.language === 'python') {
      const source = String(ctx.node.parameters.pythonCode ?? PYTHON_ALL);
      try {
        const { results, logs: runLogs } = await ctx.runPython(source, mode === 'each' ? 'each' : 'all');
        logs.push(...runLogs);
        results.forEach((result, i) => out.push(...toItems(result, mode === 'each' ? i : undefined)));
      } finally {
        if (logs.length) ctx.meta.logs = logs.slice(0, 500);
      }
      return [out];
    }

    const source = String(ctx.node.parameters.jsCode ?? CODE_ALL);

    const collect = async (index: number) => {
      const { result, logs: runLogs } = await ctx.runCode(source, index);
      logs.push(...runLogs);
      out.push(...toItems(result, mode === 'each' ? index : undefined));
    };

    try {
      if (mode === 'each') for (let i = 0; i < input.length; i++) await collect(i);
      else await collect(0);
    } finally {
      if (logs.length) ctx.meta.logs = logs.slice(0, 500);
    }
    return [out];
  },
};

/** Aceita [{...}], [{ json: {...} }] ou um objeto só. */
function toItems(result: JsonValue, itemIndex?: number): Item[] {
  if (result === null) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((value, i) => {
    if (!isPlainObject(value)) {
      const where = itemIndex === undefined ? `posição ${i}` : `item ${itemIndex}`;
      throw new NodeOperationError(`O código deve devolver objetos; recebeu ${JSON.stringify(value)} (${where})`);
    }
    return isPlainObject(value.json) && Object.keys(value).every((k) => k === 'json' || k === 'binary') ? { json: value.json } : { json: value };
  });
}

export const executeWorkflowTrigger: NodeType = {
  description: {
    type: 'executeWorkflowTrigger',
    displayName: 'Chamado por outro fluxo',
    description: 'Inicia este fluxo quando outro fluxo o chama pelo nó Execute Workflow. Recebe os itens enviados.',
    group: 'trigger',
    inputs: 0,
    outputs: 1,
    properties: [],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    return [input.length ? input : [{ json: {} }]];
  },
};

export const executeWorkflow: NodeType = {
  description: {
    type: 'executeWorkflow',
    displayName: 'Execute Workflow',
    description: 'Executa outro fluxo, que precisa começar pelo gatilho "Chamado por outro fluxo", e devolve a saída dele.',
    group: 'action',
    inputs: 1,
    outputs: 1,
    // Um subfluxo pode demorar bem mais que um nó comum.
    defaultTimeoutMs: 3_600_000,
    properties: [
      { name: 'workflowId', displayName: 'Fluxo', type: 'workflow', default: '', required: true },
      {
        name: 'mode',
        displayName: 'Executar',
        type: 'options',
        default: 'once',
        options: [
          { name: 'Uma vez com todos os itens', value: 'once' },
          { name: 'Uma vez para cada item', value: 'each' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const input = ctx.inputs[0] ?? [];
    const mode = await ctx.getParam('mode', 0);
    const executionIds: string[] = [];
    const out: Item[] = [];

    const call = async (items: Item[], index: number) => {
      const workflowId = String((await ctx.getParam('workflowId', index)) ?? '').trim();
      if (!workflowId) throw new NodeOperationError('Escolha o fluxo a executar');
      const result = await ctx.executeWorkflow(workflowId, items);
      executionIds.push(result.executionId);
      ctx.meta.subExecutionIds = executionIds;
      if (result.status !== 'success') {
        const where = result.error?.nodeName ? ` no nó "${result.error.nodeName}"` : '';
        throw new NodeOperationError(`O subfluxo falhou${where}: ${result.error?.message ?? result.status}`, {
          subExecutionId: result.executionId,
          node: result.error?.nodeName ?? null,
          message: result.error?.message ?? null,
          details: result.error?.details ?? null,
        });
      }
      out.push(...result.output);
    };

    if (mode === 'each') for (let i = 0; i < input.length; i++) await call([input[i]], i);
    else await call(input, 0);
    return [out];
  },
};
