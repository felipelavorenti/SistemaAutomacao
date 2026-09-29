import { useEffect, useState } from 'react';
import { post, type ConnectionItem, type Item, type JsonValue, type PropertyDescription } from '../api';

export interface FieldContext {
  connections: ConnectionItem[];
  /** Entrada da última execução deste nó, para a prévia das expressões. */
  previewInput: Item[];
  /** Saída de cada nó na última execução, pelo nome. */
  previewOutputs: Record<string, Item[]>;
  readOnly: boolean;
}

const EXPRESSION_TYPES = new Set(['string', 'number', 'boolean', 'options', 'json', 'connection']);

export function isExpression(value: JsonValue): value is string {
  return typeof value === 'string' && value.startsWith('=');
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
    case 'json':
    case 'code':
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
    case 'list':
      return <ListInput prop={prop} value={value} onChange={onChange} ctx={ctx} />;
    default:
      return <input disabled={disabled} value={value === null ? '' : String(value)} placeholder={prop.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
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
