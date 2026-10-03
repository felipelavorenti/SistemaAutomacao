import { useEffect, useState } from 'react';
import { post, type ApiCatalog, type ApiVariable, type ConnectionItem, type Item, type JsonValue, type PropertyDescription, type WorkflowListItem } from '../api';

export interface FieldContext {
  connections: ConnectionItem[];
  /** Fluxos que o usuário enxerga, para o nó Execute Workflow. */
  workflows: WorkflowListItem[];
  /** Clientes e endpoints cadastrados nos ERPs, para o nó HTTP com API cadastrada. */
  catalog: ApiCatalog;
  /** Valores atuais dos parâmetros do nó (o endpoint depende do cliente escolhido). */
  values: Record<string, JsonValue>;
  /** Entrada da última execução deste nó, para a prévia das expressões. */
  previewInput: Item[];
  /** Saída de cada nó na última execução, pelo nome. */
  previewOutputs: Record<string, Item[]>;
  readOnly: boolean;
}

const EXPRESSION_TYPES = new Set(['string', 'number', 'boolean', 'options', 'json', 'connection', 'workflow', 'erpClient', 'erpEndpoint']);

export function isExpression(value: JsonValue): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

/** O navegador omite os segundos quando são zero; guardamos sempre hh:mm:ss. */
function withSeconds(raw: string): string {
  return /(^|T)\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
}

export function isVisible(prop: PropertyDescription, values: Record<string, JsonValue>): boolean {
  if (!prop.showWhen) return true;
  return Object.entries(prop.showWhen).every(([key, allowed]) => {
    const current = values[key];
    return allowed.some((a) => a === current);
  });
}

export function ParameterField({
  prop,
  value,
  onChange,
  ctx,
}: {
  prop: PropertyDescription;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  ctx: FieldContext;
}) {
  const expression = isExpression(value);
  const canToggle = EXPRESSION_TYPES.has(prop.type);

  const toggle = (toExpression: boolean) => {
    if (toExpression && !expression) {
      onChange(`=${value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    } else if (!toExpression && expression) {
      const raw = value.slice(1);
      if (prop.type === 'number') onChange(raw === '' || Number.isNaN(Number(raw)) ? prop.default : Number(raw));
      else if (prop.type === 'boolean') onChange(raw === 'true');
      else onChange(raw);
    }
  };

  return (
    <div className="param">
      <div className="param-header">
        <span className="field-label">
          {prop.displayName}
          {prop.required && <span className="required">*</span>}
        </span>
        {canToggle && !ctx.readOnly && (
          <div className="mode-toggle" role="group" aria-label="Modo do campo">
            <button className={!expression ? 'on' : ''} onClick={() => toggle(false)}>
              Fixo
            </button>
            <button className={expression ? 'on' : ''} onClick={() => toggle(true)}>
              Expressão
            </button>
          </div>
        )}
      </div>
      {expression ? (
        <ExpressionEditor value={value} onChange={onChange} ctx={ctx} />
      ) : (
        <FixedInput prop={prop} value={value} onChange={onChange} ctx={ctx} />
      )}
      {prop.description && <div className="field-hint">{prop.description}</div>}
    </div>
  );
}

function FixedInput({ prop, value, onChange, ctx }: { prop: PropertyDescription; value: JsonValue; onChange: (v: JsonValue) => void; ctx: FieldContext }) {
  const disabled = ctx.readOnly;
  switch (prop.type) {
    case 'number':
      return <input type="number" disabled={disabled} value={value === null ? '' : Number(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'boolean':
      return (
        <label className="check">
          <input type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> Sim
        </label>
      );
    case 'options':
      return (
        <select disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {prop.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'multiOptions': {
      const selected = Array.isArray(value) ? value.map(String) : [];
      const flip = (v: string) =>
        onChange(prop.options!.map((o) => o.value).filter((o) => (o === v ? !selected.includes(v) : selected.includes(o))));
      return (
        <div className="check-row">
          {prop.options?.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" disabled={disabled} checked={selected.includes(o.value)} onChange={() => flip(o.value)} /> {o.name}
            </label>
          ))}
        </div>
      );
    }
    case 'time':
      return <input type="time" step={1} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(withSeconds(e.target.value))} />;
    case 'dateTime':
      return (
        <input type="datetime-local" step={1} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(withSeconds(e.target.value))} />
      );
    case 'code':
      return <CodeInput value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={onChange} />;
    case 'json':
      return (
        <textarea
          className="code"
          rows={6}
          disabled={disabled}
          value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'connection': {
      const options = ctx.connections.filter((c) => !prop.connectionTypes || prop.connectionTypes.includes(c.type));
      return (
        <select disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">Nenhuma</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.typeName}{c.clientName ? ` · ${c.clientName}` : ''})
            </option>
          ))}
          {value && !options.some((c) => c.id === value) && <option value={String(value)}>Conexão sem acesso ou excluída</option>}
        </select>
      );
    }
    case 'workflow': {
      const callable = ctx.workflows.filter((w) => w.callable);
      const others = ctx.workflows.filter((w) => !w.callable);
      const current = ctx.workflows.find((w) => w.id === value);
      return (
        <>
          <select disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            <option value="">Escolha o fluxo</option>
            {callable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.folder_name})
              </option>
            ))}
            {others.length > 0 && (
              <optgroup label="Sem o gatilho Chamado por outro fluxo">
                {others.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.folder_name})
                  </option>
                ))}
              </optgroup>
            )}
            {value && !current && <option value={String(value)}>Fluxo sem acesso ou excluído</option>}
          </select>
          {current && (
            <div className="field-hint">
              ID {current.id} · <a href={`/fluxos/${current.id}`} target="_blank" rel="noreferrer">abrir em outra aba</a>
              {!current.callable && <span className="required"> · este fluxo precisa começar pelo gatilho "Chamado por outro fluxo"</span>}
            </div>
          )}
        </>
      );
    }
    case 'erpClient': {
      const current = ctx.catalog.clients.find((c) => c.id === value);
      const erps = [...new Set(ctx.catalog.clients.map((c) => c.erpName))];
      return (
        <select disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">Escolha o cliente</option>
          {erps.map((erp) => (
            <optgroup key={erp} label={erp}>
              {ctx.catalog.clients
                .filter((c) => c.erpName === erp)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.clientName}
                    {c.label ? ` · ${c.label}` : ''}
                  </option>
                ))}
            </optgroup>
          ))}
          {value && !current && <option value={String(value)}>Cliente sem acesso ou excluído</option>}
        </select>
      );
    }
    case 'erpEndpoint': {
      const endpoints = endpointsFor(ctx);
      const current = ctx.catalog.endpoints.find((e) => e.id === value);
      return (
        <>
          <select disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            <option value="">{endpoints ? 'Escolha o endpoint' : 'Escolha o cliente primeiro'}</option>
            {endpoints?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.method} {e.path})
              </option>
            ))}
            {value && !current && <option value={String(value)}>Endpoint excluído</option>}
          </select>
          {current?.description && <div className="field-hint">{current.description}</div>}
        </>
      );
    }
    case 'erpVariables':
      return <ErpVariablesInput value={value} onChange={onChange} ctx={ctx} />;
    case 'list':
      return <ListInput prop={prop} value={value} onChange={onChange} ctx={ctx} />;
    default:
      if (prop.multiline) {
        return (
          <textarea
            className="code"
            rows={Math.min(20, Math.max(5, String(value ?? '').split('\n').length + 1))}
            spellCheck={false}
            disabled={disabled}
            value={value === null ? '' : String(value)}
            placeholder={prop.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      }
      return <input disabled={disabled} value={value === null ? '' : String(value)} placeholder={prop.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Endpoints do ERP do cliente escolhido; null enquanto não há cliente (ou ele é uma expressão). */
function endpointsFor(ctx: FieldContext) {
  const client = ctx.catalog.clients.find((c) => c.id === ctx.values.erpClient);
  if (client) return ctx.catalog.endpoints.filter((e) => e.erpId === client.erpId);
  return isExpression(ctx.values.erpClient ?? null) ? ctx.catalog.endpoints : null;
}

const VARIABLE_FIELD_TYPE: Record<ApiVariable['type'], PropertyDescription['type']> = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  json: 'json',
};

/** Um campo Fixo/Expressão para cada variável do endpoint escolhido. */
function ErpVariablesInput({ value, onChange, ctx }: { value: JsonValue; onChange: (v: JsonValue) => void; ctx: FieldContext }) {
  const endpoint = ctx.catalog.endpoints.find((e) => e.id === ctx.values.endpoint);
  const current = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!endpoint) return <div className="field-hint">Escolha o endpoint para ver as variáveis.</div>;
  if (!endpoint.variables.length) return <div className="field-hint">Este endpoint não tem variáveis.</div>;
  return (
    <div className="list-input">
      {endpoint.variables.map((v) => {
        const prop: PropertyDescription = {
          name: v.name,
          displayName: v.label || v.name,
          type: VARIABLE_FIELD_TYPE[v.type] ?? 'string',
          default: v.default,
          required: v.required,
          description: v.default ? `Padrão: ${v.default}` : undefined,
        };
        const own = current[v.name];
        return <ParameterField key={v.name} prop={prop} value={own === undefined ? (prop.type === 'string' || prop.type === 'json' ? '' : null) : own} onChange={(next) => onChange({ ...current, [v.name]: next })} ctx={ctx} />;
      })}
    </div>
  );
}

/** Editor de código simples: fonte monoespaçada e Tab insere espaços. */
function CodeInput({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: JsonValue) => void }) {
  return (
    <textarea
      className="code code-editor"
      rows={Math.min(24, Math.max(10, value.split('\n').length + 1))}
      spellCheck={false}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const el = e.currentTarget;
        const { selectionStart: start, selectionEnd: end } = el;
        onChange(value.slice(0, start) + '  ' + value.slice(end));
        requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
      }}
    />
  );
}

function ListInput({ prop, value, onChange, ctx }: { prop: PropertyDescription; value: JsonValue; onChange: (v: JsonValue) => void; ctx: FieldContext }) {
  const rows = Array.isArray(value) ? (value as Record<string, JsonValue>[]) : [];
  const fields = prop.fields ?? [];
  const blank = () => Object.fromEntries(fields.map((f) => [f.name, f.default]));
  const update = (i: number, key: string, v: JsonValue) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  return (
    <div className="list-input">
      {rows.map((row, i) => (
        <div key={i} className="list-row">
          <div className="list-row-fields">
            {fields.map((f) => (
              <ParameterField key={f.name} prop={f} value={row[f.name] ?? f.default} onChange={(v) => update(i, f.name, v)} ctx={ctx} />
            ))}
          </div>
          {!ctx.readOnly && (
            <button className="icon" title="Remover" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      {!ctx.readOnly && (
        <button className="link" onClick={() => onChange([...rows, blank()])}>
          + Adicionar
        </button>
      )}
    </div>
  );
}

function ExpressionEditor({ value, onChange, ctx }: { value: string; onChange: (v: JsonValue) => void; ctx: FieldContext }) {
  const [preview, setPreview] = useState<{ result?: JsonValue; error?: string } | null>(null);

  // Prévia com os dados da última execução, recalculada quando o texto para de mudar.
  useEffect(() => {
    if (ctx.readOnly) return;
    const t = setTimeout(async () => {
      try {
        setPreview(await post('/expressions/preview', { value, input: ctx.previewInput, nodeOutputs: ctx.previewOutputs }));
      } catch {
        setPreview(null);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [value, ctx.previewInput, ctx.previewOutputs, ctx.readOnly]);

  return (
    <div className="expression">
      <textarea
        className="code expression-input"
        rows={Math.min(8, Math.max(2, value.split('\n').length))}
        value={value.slice(1)}
        disabled={ctx.readOnly}
        placeholder="Texto com {{ expressões }}. Arraste campos do painel de entrada para cá."
        onChange={(e) => onChange(`=${e.target.value}`)}
      />
      {preview && (
        <div className={`expression-preview ${preview.error ? 'is-error' : ''}`}>
          {preview.error ? preview.error : <code>{typeof preview.result === 'string' ? preview.result : JSON.stringify(preview.result)}</code>}
        </div>
      )}
    </div>
  );
}
