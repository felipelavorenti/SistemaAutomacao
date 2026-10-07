import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  DATA_TABLE_TYPE_LABEL,
  del,
  errorMessage,
  formatDate,
  get,
  post,
  put,
  type DataTable,
  type DataTableColumn,
  type DataTableColumnType,
  type DataTableRow,
  type JsonValue,
} from '../api';
import { useMe } from '../App';
import { ErrorBox, Field, Modal, PageHeader, useLoad } from '../components/ui';

const PAGE_SIZE = 100;
const CONDITIONS = [
  { value: 'ilike', label: 'contém (sem diferenciar maiúsculas)' },
  { value: 'eq', label: 'é igual a' },
  { value: 'neq', label: 'é diferente de' },
  { value: 'gt', label: 'maior que' },
  { value: 'gte', label: 'maior ou igual a' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor ou igual a' },
  { value: 'isEmpty', label: 'está vazio' },
  { value: 'isNotEmpty', label: 'não está vazio' },
  { value: 'isTrue', label: 'é verdadeiro' },
  { value: 'isFalse', label: 'é falso' },
];
const NO_VALUE = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

/** Lista das tabelas de dados (nó Data Table). */
export function DataTablesPage() {
  const me = useMe();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => get<DataTable[]>('/data-tables'));
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader title="Tabelas de dados">
        {me.permissions.editWorkflows && (
          <button className="primary" onClick={() => setCreating(true)}>
            Nova tabela
          </button>
        )}
      </PageHeader>
      <p className="muted">
        Tabelas simples guardadas no Info8n, para os fluxos lerem e gravarem com o nó Data Table (ex.: controle do que já foi processado, de-para de códigos). Todos
        os usuários veem as tabelas; quem edita fluxos pode criar e alterar.
      </p>
      <ErrorBox message={error} />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Colunas</th>
            <th>Linhas</th>
            <th>Alterada em</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}>
              <td>
                <Link to={`/tabelas-de-dados/${t.id}`}>{t.name}</Link>
              </td>
              <td className="muted">{t.columns.map((c) => c.name).join(', ') || 'nenhuma'}</td>
              <td>{t.rowCount.toLocaleString('pt-BR')}</td>
              <td>{formatDate(t.updatedAt)}</td>
            </tr>
          ))}
          {data && !data.length && (
            <tr>
              <td colSpan={4} className="muted">
                Nenhuma tabela ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {creating && (
        <TableModal
          title="Nova tabela"
          onClose={() => setCreating(false)}
          onSave={async (name, columns) => {
            const t = await post<DataTable>('/data-tables', { name, columns });
            navigate(`/tabelas-de-dados/${t.id}`);
          }}
        />
      )}
    </div>
  );
}

/** Nome e colunas da tabela; o tipo de uma coluna que já existe não muda. */
function TableModal({
  title,
  table,
  onClose,
  onSave,
}: {
  title: string;
  table?: DataTable;
  onClose: () => void;
  onSave: (name: string, columns: DataTableColumn[]) => Promise<void>;
}) {
  const [name, setName] = useState(table?.name ?? '');
  const [columns, setColumns] = useState<DataTableColumn[]>(table?.columns ?? [{ name: '', type: 'string' }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const existing = new Set(table?.columns.map((c) => c.name));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(
        name.trim(),
        columns.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim() })),
      );
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Colunas" hint="Letras, números e _, começando por letra. Toda linha também tem id, createdAt e updatedAt. Tirar uma coluna apaga os valores dela.">
        <div className="list-input">
          {columns.map((c, i) => (
            <div key={i} className="list-row">
              <input placeholder="nome_da_coluna" value={c.name} disabled={existing.has(c.name) && !!table} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <select
                value={c.type}
                disabled={existing.has(c.name) && !!table}
                onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value as DataTableColumnType } : x)))}
              >
                {Object.entries(DATA_TABLE_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button className="link danger" onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
                Tirar
              </button>
            </div>
          ))}
          <button className="link" onClick={() => setColumns([...columns, { name: '', type: 'string' }])}>
            + Coluna
          </button>
        </div>
      </Field>
      <ErrorBox message={error} />
      <div className="modal-actions">
        <button onClick={onClose}>Cancelar</button>
        <button className="primary" disabled={!name.trim() || saving} onClick={save}>
          Salvar
        </button>
      </div>
    </Modal>
  );
}

/** Texto que aparece na célula. */
function cellText(value: JsonValue | undefined, type: DataTableColumnType): string {
  if (value === null || value === undefined) return '';
  if (type === 'boolean') return value ? 'Sim' : 'Não';
  if (type === 'date') return formatDate(String(value));
  return String(value);
}

/** Valor digitado na célula, como vai para a API (a API converte para o tipo da coluna). */
function inputValue(raw: string, type: DataTableColumnType): JsonValue {
  if (raw.trim() === '') return null;
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return new Date(raw).toISOString();
  return raw;
}

/** Valor da célula no formato do campo de edição. */
function editText(value: JsonValue | undefined, type: DataTableColumnType): string {
  if (value === null || value === undefined) return '';
  if (type === 'date') {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  return String(value);
}

function CellInput({ column, value, onSave, onCancel }: { column: DataTableColumn; value: JsonValue | undefined; onSave: (v: JsonValue) => void; onCancel: () => void }) {
  const [raw, setRaw] = useState(editText(value, column.type));
  if (column.type === 'boolean') {
    return (
      <select autoFocus value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(e) => onSave(e.target.value === '' ? null : e.target.value === 'true')} onBlur={onCancel}>
        <option value="">(vazio)</option>
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </select>
    );
  }
  return (
    <input
      autoFocus
      type={column.type === 'number' ? 'number' : column.type === 'date' ? 'datetime-local' : 'text'}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => onSave(inputValue(raw, column.type))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSave(inputValue(raw, column.type));
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

/** Uma tabela: linhas com filtro e paginação, edição na própria célula. */
export function DataTablePage() {
  const { id = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const canEdit = me.permissions.editWorkflows;
  const { data: table, error: tableError, reload: reloadTable } = useLoad(() => get<DataTable>(`/data-tables/${id}`), [id]);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<{ column: string; condition: string; value: string } | null>(null);
  const [draft, setDraft] = useState({ column: '', condition: 'ilike', value: '' });
  const [orderDesc, setOrderDesc] = useState(false);
  const query = () => {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), orderDirection: orderDesc ? 'desc' : 'asc' });
    if (filter) {
      const value = filter.condition === 'ilike' ? `%${filter.value}%` : filter.value;
      q.set('filter', JSON.stringify({ type: 'and', conditions: [{ column: filter.column, condition: filter.condition, ...(NO_VALUE.has(filter.condition) ? {} : { value }) }] }));
    }
    return q.toString();
  };
  const { data: rows, error: rowsError, reload: reloadRows } = useLoad(() => get<{ rows: DataTableRow[]; total: number }>(`/data-tables/${id}/rows?${query()}`), [id, page, filter, orderDesc]);
  const [editing, setEditing] = useState<{ row: number; column: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingTable, setEditingTable] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setActionError(null);
      await fn();
      await Promise.all([reloadRows(), reloadTable()]);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  if (!table) return <ErrorBox message={tableError} />;
  const columns = table.columns;
  const total = rows?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader title={table.name}>
        <Link to="/tabelas-de-dados" className="button">
          Voltar
        </Link>
        {canEdit && (
          <>
            <button onClick={() => setEditingTable(true)}>Nome e colunas</button>
            <button className="primary" onClick={() => act(() => post(`/data-tables/${id}/rows`, { rows: [{}] }))}>
              Nova linha
            </button>
          </>
        )}
      </PageHeader>
      <p className="muted">
        {table.rowCount.toLocaleString('pt-BR')} linha(s) · ID {table.id}
        {canEdit && ' · clique numa célula para alterar'}
      </p>

      <div className="inline-form grid-filter">
        <select value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })}>
          <option value="">Filtrar pela coluna…</option>
          <option value="id">id</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={draft.condition} onChange={(e) => setDraft({ ...draft, condition: e.target.value })}>
          {CONDITIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {!NO_VALUE.has(draft.condition) && <input placeholder="Valor" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />}
        <button
          disabled={!draft.column}
          onClick={() => {
            setPage(0);
            setFilter({ ...draft });
          }}
        >
          Filtrar
        </button>
        {filter && (
          <button
            className="link"
            onClick={() => {
              setPage(0);
              setFilter(null);
            }}
          >
            Limpar filtro
          </button>
        )}
        {canEdit && selected.size > 0 && (
          <button
            className="danger"
            onClick={() =>
              confirm(`Apagar ${selected.size} linha(s)?`) &&
              act(async () => {
                await post(`/data-tables/${id}/rows/delete`, { ids: [...selected] });
                setSelected(new Set());
              })
            }
          >
            Apagar {selected.size} linha(s)
          </button>
        )}
      </div>
      <ErrorBox message={rowsError ?? actionError} />

      <div className="table-scroll">
        <table className="data-grid">
          <thead>
            <tr>
              {canEdit && <th className="check" />}
              <th className="clickable" onClick={() => setOrderDesc(!orderDesc)} title="Inverter a ordem">
                id {orderDesc ? '↓' : '↑'}
              </th>
              {columns.map((c) => (
                <th key={c.name}>
                  {c.name} <span className="muted small">{DATA_TABLE_TYPE_LABEL[c.type]}</span>
                </th>
              ))}
              <th>Alterada em</th>
            </tr>
          </thead>
          <tbody>
            {rows?.rows.map((r) => (
              <tr key={r.id}>
                {canEdit && (
                  <td className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                )}
                <td className="muted">{r.id}</td>
                {columns.map((c) => (
                  <td key={c.name} className={canEdit ? 'editable' : undefined} onClick={() => canEdit && setEditing({ row: r.id, column: c.name })}>
                    {editing?.row === r.id && editing.column === c.name ? (
                      <CellInput
                        column={c}
                        value={r[c.name]}
                        onCancel={() => setEditing(null)}
                        onSave={(v) => {
                          setEditing(null);
                          if (v !== (r[c.name] ?? null)) void act(() => put(`/data-tables/${id}/rows/${r.id}`, { data: { [c.name]: v } }));
                        }}
                      />
                    ) : (
                      cellText(r[c.name], c.type)
                    )}
                  </td>
                ))}
                <td className="muted">{formatDate(r.updatedAt)}</td>
              </tr>
            ))}
            {rows && !rows.rows.length && (
              <tr>
                <td colSpan={columns.length + 3} className="muted">
                  {filter ? 'Nenhuma linha atende ao filtro.' : 'Nenhuma linha ainda.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            Anterior
          </button>
          <span className="muted">
            Página {page + 1} de {pages} ({total.toLocaleString('pt-BR')} linhas)
          </span>
          <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Próxima
          </button>
        </div>
      )}

      {canEdit && (
        <p>
          <button
            className="link danger"
            onClick={() =>
              confirm(`Excluir a tabela "${table.name}" e todas as linhas? Os fluxos que usam a tabela vão dar erro.`) &&
              act(async () => {
                await del(`/data-tables/${id}`);
                navigate('/tabelas-de-dados');
              })
            }
          >
            Excluir tabela
          </button>
        </p>
      )}

      {editingTable && (
        <TableModal
          title="Nome e colunas"
          table={table}
          onClose={() => setEditingTable(false)}
          onSave={async (name, cols) => {
            await put(`/data-tables/${id}`, { name, columns: cols });
            await Promise.all([reloadTable(), reloadRows()]);
          }}
        />
      )}
    </div>
  );
}
