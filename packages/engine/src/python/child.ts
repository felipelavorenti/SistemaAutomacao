/**
 * Processo filho que roda o código Python do nó Code com o Pyodide (Python em
 * WebAssembly). O pai o inicia com o modelo de permissões do Node: sem acesso a
 * arquivos fora do Pyodide, sem criar processos e sem variáveis de ambiente.
 * Este arquivo não importa nada do projeto, porque o processo não pode ler
 * outros arquivos.
 */
import { constants } from 'node:fs';

// O Pyodide lê as constantes do sistema de arquivos por process.binding, que o
// modelo de permissões bloqueia. Entregamos só essas constantes.
(process as unknown as { binding: (name: string) => unknown }).binding = (name: string) => {
  if (name === 'constants') return { fs: constants };
  throw new Error('Recurso bloqueado no Python');
};

const PRELUDE = String.raw`
import json as __jsonlib
import traceback as __traceback

class _Obj(dict):
    """Dicionário que também aceita item.campo."""
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key) from None
    def __setattr__(self, key, value):
        self[key] = value

def __wrap(value):
    if isinstance(value, dict):
        return _Obj({k: __wrap(v) for k, v in value.items()})
    if isinstance(value, list):
        return [__wrap(v) for v in value]
    return value

class _Items:
    def __init__(self, items, index=0):
        self._items = items
        self._index = index
    def all(self):
        return self._items
    def first(self):
        return self._items[0] if self._items else None
    def last(self):
        return self._items[-1] if self._items else None
    @property
    def item(self):
        return self._items[self._index] if self._index < len(self._items) else self.first()
    @property
    def json(self):
        item = self.item
        return item["json"] if item else _Obj()

class _NodeAccess:
    def __init__(self, outputs, index):
        self._outputs = outputs
        self._index = index
    def __getitem__(self, name):
        if name not in self._outputs:
            raise KeyError('Nó "' + name + '" não foi executado antes deste nó')
        return _Items(self._outputs[name], self._index)
    def __call__(self, name):
        return self[name]

class __UserError(Exception):
    pass

def __user_line(exc):
    line = None
    for frame in __traceback.extract_tb(exc.__traceback__):
        if frame.filename == "<código>":
            line = frame.lineno - 1
    return line

async def __run(raw):
    req = __jsonlib.loads(raw)
    body = "\n".join("    " + line for line in req["code"].split("\n"))
    try:
        compiled = compile("async def __user_main():\n" + body + "\n    pass\n", "<código>", "exec")
    except SyntaxError as e:
        raise __UserError("Erro de sintaxe na linha " + str((e.lineno or 1) - 1) + ": " + str(e.msg)) from None
    items = __wrap(req["input"])
    outputs = {name: __wrap(value) for name, value in req["nodeOutputs"].items()}
    indexes = range(len(items)) if req["mode"] == "each" else [0]
    results = []
    for index in indexes:
        node = _NodeAccess(outputs, index)
        scope = {
            "__builtins__": __builtins__,
            "_input": _Items(items, index),
            "_json": items[index]["json"] if index < len(items) else _Obj(),
            "_item_index": index,
            "_node": node,
            "_": node,
            "_execution": __wrap(req["execution"]),
            "_vars": __wrap(req["vars"]),
        }
        exec(compiled, scope)
        try:
            result = await scope["__user_main"]()
        except Exception as e:
            line = __user_line(e)
            where = " (linha " + str(line) + ")" if line else ""
            prefix = "item " + str(index) + ": " if req["mode"] == "each" else ""
            raise __UserError(prefix + type(e).__name__ + ": " + str(e) + where) from None
        results.append(result)
    try:
        return __jsonlib.dumps({"results": results}, default=str, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raise __UserError("O resultado tem NaN ou infinito, que não existem em JSON") from None
`;

interface Request {
  id: number;
  code: string;
  mode: 'all' | 'each';
  input: unknown[];
  nodeOutputs: Record<string, unknown[]>;
  execution: unknown;
  vars: unknown;
}

let logs: string[] = [];
const log = (line: string) => {
  if (logs.length < 200) logs.push(line);
};

const { loadPyodide } = (await import(process.argv[2]!)) as {
  loadPyodide: (options: Record<string, unknown>) => Promise<{
    runPython(code: string): unknown;
    globals: { get(name: string): (raw: string) => Promise<string> };
  }>;
};
// jsglobals vazio: "import js" não enxerga nada do processo.
const pyodide = await loadPyodide({ jsglobals: {}, stdout: log, stderr: log });
pyodide.runPython(PRELUDE);
const run = pyodide.globals.get('__run');

process.on('message', async (req: Request) => {
  logs = [];
  try {
    const raw = await run(
      JSON.stringify({ code: req.code, mode: req.mode, input: req.input, nodeOutputs: req.nodeOutputs, execution: req.execution, vars: req.vars }),
    );
    process.send!({ id: req.id, ok: true, results: (JSON.parse(raw) as { results: unknown[] }).results, logs });
  } catch (err) {
    process.send!({ id: req.id, ok: false, message: pythonMessage(err), logs });
  }
});
process.send!({ type: 'ready' });

/** O erro do Pyodide traz o traceback inteiro; fica só a última linha. */
function pythonMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text.trim().split('\n').filter(Boolean);
  const last = lines.at(-1) ?? text;
  return last.replace(/^(?:__main__\.)?__UserError: /, '');
}
