import { afterAll, describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import { PythonRunner } from '../src/python/runner.js';
import type { Connection, Item, NodeInstance, WorkflowDefinition } from '../src/types.js';

const node = (id: string, type: string, parameters: NodeInstance['parameters'] = {}, name = id): NodeInstance => ({
  id,
  name,
  type,
  position: { x: 0, y: 0 },
  parameters,
});
const link = (from: string, to: string): Connection => ({ from, fromOutput: 0, to, toInput: 0 });
const trigger = node('t', 'manualTrigger', {}, 'Início');
const items = (...list: Record<string, unknown>[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));
const python = new PythonRunner({ size: 1 });
afterAll(() => python.close());

function run(code: string, mode: 'all' | 'each', input: Item[], settings: NodeInstance['settings'] = {}) {
  const wf: WorkflowDefinition = {
    nodes: [trigger, { ...node('c', 'code', { language: 'python', mode, pythonCode: code }, 'Python'), settings }],
    connections: [link('t', 'c')],
  };
  return executeWorkflow({ workflow: wf, executionId: 'exec-1', mode: 'manual', triggerItems: input, python, vars: { empresa: 'ACME' } });
}

describe('Code em Python', { timeout: 60_000 }, () => {
  it('roda uma vez com todos os itens, com print nos logs', async () => {
    const code = `import math
total = sum(item.json.preco for item in _input.all())
print("itens:", len(_input.all()))
return [{"total": total, "raiz": math.sqrt(16), "empresa": _vars.empresa, "execucao": _execution["id"]}]`;
    const result = await run(code, 'all', items({ preco: 10 }, { preco: 5.5 }));
    expect(result.status).toBe('success');
    expect(result.lastOutput).toEqual([{ json: { total: 15.5, raiz: 4, empresa: 'ACME', execucao: 'exec-1' } }]);
    expect(result.runs[1].meta?.logs).toEqual(['itens: 2']);
  });

  it('roda uma vez por item e lê a saída de outro nó', async () => {
    const code = `return {"sku": _json["sku"], "dobro": _json.qtd * 2, "origem": len(_("Início").all())}`;
    const result = await run(code, 'each', items({ sku: 'A', qtd: 1 }, { sku: 'B', qtd: 3 }));
    expect(result.lastOutput.map((i) => i.json)).toEqual([
      { sku: 'A', dobro: 2, origem: 2 },
      { sku: 'B', dobro: 6, origem: 2 },
    ]);
  });

  it('erro traz a linha do código e o que foi impresso', async () => {
    const result = await run('print("antes")\nx = 1\nraise ValueError("preço inválido")', 'all', items({}));
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('ValueError: preço inválido (linha 3)');
    expect(result.error?.details).toEqual({ logs: ['antes'] });
  });

  it('erro de sintaxe aponta a linha', async () => {
    const result = await run('x = 1\nif x\n  pass', 'all', items({}));
    expect(result.error?.message).toMatch(/^Erro de sintaxe na linha 2/);
  });

  it('não lê arquivos nem variáveis de ambiente do servidor', async () => {
    const code = `import os
try:
    open("/etc/hostname").read()
    arquivo = "leu"
except Exception as e:
    arquivo = type(e).__name__
import pyodide_js
f = pyodide_js.constructor.constructor("try { return process.getBuiltinModule('fs').readFileSync('/etc/hostname', 'utf8') } catch (e) { return 'bloqueado' }")
return {"arquivo": arquivo, "fuga": f(), "env": dict(os.environ).get("DATABASE_URL")}`;
    process.env.DATABASE_URL = 'postgres://segredo';
    const result = await run(code, 'all', items({}));
    expect(result.lastOutput[0]?.json).toEqual({ arquivo: 'FileNotFoundError', fuga: 'bloqueado', env: null });
  });

  it('código que passa do tempo limite é interrompido e o próximo roda normalmente', async () => {
    const slow = await run('while True:\n    pass', 'all', items({}), { timeoutMs: 1500 });
    expect(slow.status).toBe('error');
    expect(slow.error?.message).toMatch(/tempo limite/);
    const next = await run('return {"ok": True}', 'all', items({}));
    expect(next.lastOutput).toEqual([{ json: { ok: true } }]);
  });
});
