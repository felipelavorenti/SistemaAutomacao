import { useEffect, useMemo, useState } from 'react';
import type { ApiCatalog, ConnectionItem, Item, JsonValue, NodeInstance, NodeRun, NodeSettings, NodeTypeDescription, WorkflowListItem } from '../api';
import { ErrorBox, Field, JsonView, RunMeta } from '../components/ui';
import { isVisible, ParameterField, type FieldContext } from './ParameterField';

type Tab = 'params' | 'settings';

export function NodePanel({
  node,
  description,
  run,
  previewOutputs,
  connections,
  workflows,
  catalog,
  runCount,
  readOnly,
  nameTaken,
  testInput,
  onTestInputChange,
  onChange,
  onDelete,
  onClose,
}: {
  node: NodeInstance;
  description?: NodeTypeDescription;
  run?: NodeRun;
  previewOutputs: Record<string, Item[]>;
  connections: ConnectionItem[];
  workflows: WorkflowListItem[];
  catalog: ApiCatalog;
  runCount: number;
  readOnly: boolean;
  nameTaken: (name: string) => boolean;
  testInput: string;
  onTestInputChange: (value: string) => void;
  onChange: (node: NodeInstance) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('params');
  const [name, setName] = useState(node.name);
  const [nameError, setNameError] = useState<string | null>(null);

  const input = useMemo(() => run?.input[0] ?? [], [run]);
  const values: Record<string, JsonValue> = {};
  for (const p of description?.properties ?? []) values[p.name] = node.parameters[p.name] !== undefined ? node.parameters[p.name] : p.default;

  const ctx: FieldContext = useMemo(
    () => ({ connections, workflows, catalog, values: node.parameters, previewInput: input, previewOutputs, readOnly }),
    [connections, workflows, catalog, node.parameters, input, previewOutputs, readOnly],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const otherOutputs = Object.entries(previewOutputs).filter(([n, items]) => n !== node.name && items.length);

  const setParam = (key: string, value: JsonValue) => onChange({ ...node, parameters: { ...node.parameters, [key]: value } });
  const setSetting = <K extends keyof NodeSettings>(key: K, value: NodeSettings[K]) => onChange({ ...node, settings: { ...node.settings, [key]: value } });

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === node.name) return setNameError(null);
    if (!trimmed) return setNameError('O nome não pode ficar vazio');
    if (nameTaken(trimmed)) return setNameError('Já existe outro nó com esse nome');
    setNameError(null);
    onChange({ ...node, name: trimmed });
  };

  return (
    <div className="ndv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ndv" role="dialog" aria-label={node.name}>
        <section className="ndv-side">
          <h3>Entrada</h3>
          {!input.length && !otherOutputs.length && <p className="muted small">Execute o fluxo para ver os dados que chegam neste nó.</p>}
          {input.length > 0 && (
            <>
              <div className="muted small">
                {input.length} {input.length === 1 ? 'item' : 'itens'} · arraste um campo para um parâmetro
              </div>
              <JsonView value={input[0].json} pathPrefix="$json" draggable />
              {input.length > 1 && (
                <details>
                  <summary className="small">Todos os itens</summary>
                  <JsonView value={input.map((i) => i.json)} />
                </details>
              )}
            </>
          )}
          {otherOutputs.length > 0 && (
            <details className="input-help" open={!input.length}>
              <summary>Saídas de outros nós</summary>
              {otherOutputs.map(([n, items]) => (
                <div key={n}>
                  <strong>{n}</strong>
                  <JsonView value={items[0].json} pathPrefix={`$node['${n}'].json`} draggable />
                </div>
              ))}
            </details>
          )}
        </section>

        <section className="ndv-main">
          <div className="node-panel-header">
            <input className="node-name" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && commitName()} />
            <button className="icon" onClick={onClose} aria-label="Fechar painel">
              ×
            </button>
          </div>
          <ErrorBox message={nameError} />
          <div className="muted small">{description?.description}</div>
          <div className="tabs">
            <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>
              Parâmetros
            </button>
            <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
              Configurações
            </button>
          </div>

          {tab === 'params' && (
            <div className="panel-body">
              {(node.type === 'manualTrigger' || node.type === 'executeWorkflowTrigger') && (
                <Field label="JSON de entrada para testes" hint="Usado quando você clica em Executar no editor. Não é salvo no fluxo.">
                  <textarea className="code" rows={5} value={testInput} onChange={(e) => onTestInputChange(e.target.value)} placeholder='{ "sku": "123" }' />
                </Field>
              )}
              {description?.properties
                .filter((p) => isVisible(p, values))
                .map((p) => (
                  <ParameterField key={p.name} prop={p} value={values[p.name]} onChange={(v) => setParam(p.name, v)} ctx={ctx} />
                ))}
              {description && !description.properties.length && description.group !== 'trigger' && <p className="muted">Este nó não tem parâmetros.</p>}
              {node.type === 'executeWorkflowTrigger' && (
                <p className="muted small">Os itens enviados pelo nó Execute Workflow do outro fluxo chegam aqui.</p>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="panel-body">
              <label className="check">
                <input type="checkbox" disabled={readOnly} checked={!!node.disabled} onChange={(e) => onChange({ ...node, disabled: e.target.checked })} /> Desativar nó (repassa os itens sem executar)
              </label>
              <label className="check">
                <input type="checkbox" disabled={readOnly} checked={!!node.settings?.continueOnFail} onChange={(e) => setSetting('continueOnFail', e.target.checked)} /> Continuar em caso de erro (o erro vira um item na saída)
              </label>
              <label className="check">
                <input type="checkbox" disabled={readOnly} checked={!!node.settings?.retryOnFail} onChange={(e) => setSetting('retryOnFail', e.target.checked)} /> Tentar de novo quando falhar
              </label>
              {node.settings?.retryOnFail && (
                <div className="grid-2">
                  <Field label="Tentativas no total">
                    <input type="number" min={1} max={10} disabled={readOnly} value={node.settings?.maxTries ?? 3} onChange={(e) => setSetting('maxTries', Number(e.target.value))} />
                  </Field>
                  <Field label="Espera entre tentativas (s)" hint="Cresce a cada tentativa">
                    <input
                      type="number"
                      min={0}
                      disabled={readOnly}
                      value={(node.settings?.waitBetweenTriesMs ?? 1000) / 1000}
                      onChange={(e) => setSetting('waitBetweenTriesMs', Math.round(Number(e.target.value) * 1000))}
                    />
                  </Field>
                </div>
              )}
              <Field label="Tempo limite do nó (s)" hint="Padrão: 120 s">
                <input
                  type="number"
                  min={1}
                  disabled={readOnly}
                  value={node.settings?.timeoutMs ? node.settings.timeoutMs / 1000 : ''}
                  placeholder="120"
                  onChange={(e) => setSetting('timeoutMs', e.target.value ? Math.round(Number(e.target.value) * 1000) : undefined)}
                />
              </Field>
              <Field label="Anotações">
                <textarea rows={3} disabled={readOnly} value={node.notes ?? ''} onChange={(e) => onChange({ ...node, notes: e.target.value })} />
              </Field>
              {!readOnly && (
                <button className="danger" onClick={onDelete}>
                  Excluir nó
                </button>
              )}
            </div>
          )}
        </section>

        <section className="ndv-side">
          <h3>Saída</h3>
          {!run && <p className="muted small">Execute o fluxo para ver o que este nó devolve.</p>}
          {runCount > 1 && <p className="muted small">O nó rodou {runCount} vezes; estes são os dados da última. Todas estão na tela da execução.</p>}
          {run && <RunMeta meta={run.meta} />}
          {run?.error && (
            <div className="error-panel">
              <strong>{run.error.message}</strong>
              {run.error.details != null && <JsonView value={run.error.details} />}
            </div>
          )}
          {run?.output.map((items, i) => (
            <div key={i}>
              <div className="muted small">
                {run.output.length > 1 ? `Saída ${description?.outputNames?.[i] ?? i + 1} · ` : ''}
                {items.length} {items.length === 1 ? 'item' : 'itens'}
              </div>
              <JsonView value={items.map((it) => it.json)} />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
