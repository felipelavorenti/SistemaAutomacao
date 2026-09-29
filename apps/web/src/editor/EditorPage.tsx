import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  errorMessage,
  formatDate,
  get,
  post,
  put,
  type ApiCatalog,
  type ConnectionItem,
  type ExecutionDetail,
  type Folder,
  type Item,
  type NodeInstance,
  type NodeRun,
  type NodeTypeDescription,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowListItem,
} from '../api';
import { useMe } from '../App';
import { ErrorBox, Modal, StatusBadge } from '../components/ui';
import { FlowNode, type FlowNodeType } from './FlowNode';
import { NodePanel } from './NodePanel';

const nodeTypes = { sa: FlowNode };

const GROUP_LABEL: Record<string, string> = { trigger: 'Gatilhos', action: 'Ações', logic: 'Lógica', data: 'Dados' };

export function EditorPage() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

function Editor() {
  const { id } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const flow = useReactFlow();
  const readOnly = !me.permissions.editWorkflows;

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition>({ nodes: [], connections: [] });
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [descriptions, setDescriptions] = useState<NodeTypeDescription[]>([]);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [catalog, setCatalog] = useState<ApiCatalog>({ clients: [], endpoints: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [running, setRunning] = useState(false);
  const [testInput, setTestInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [wf, types, conns, fs, wfs, cat] = await Promise.all([
          get<Workflow>(`/workflows/${id}`),
          get<NodeTypeDescription[]>('/node-types'),
          get<ConnectionItem[]>('/connections'),
          get<Folder[]>('/folders'),
          get<WorkflowListItem[]>('/workflows'),
          get<ApiCatalog>('/api-catalog'),
        ]);
        setWorkflow(wf);
        setDefinition(wf.definition);
        setName(wf.name);
        setFolderId(wf.folder_id);
        setDescriptions(types);
        setConnections(conns);
        setFolders(fs);
        setWorkflows(wfs.filter((w) => w.id !== id));
        setCatalog(cat);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [id]);

  // Avisa antes de sair com alterações não salvas.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const describe = useCallback((type: string) => descriptions.find((d) => d.type === type), [descriptions]);

  const update = (fn: (d: WorkflowDefinition) => WorkflowDefinition) => {
    setDefinition((d) => fn(d));
    setDirty(true);
  };

  // Última execução de cada nó e quantas vezes ele rodou (nós dentro de loop rodam várias).
  const runsByNode = useMemo(() => {
    const map = new Map<string, NodeRun>();
    for (const r of execution?.runs ?? []) map.set(r.nodeId, r);
    return map;
  }, [execution]);
  const runCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of execution?.runs ?? []) map.set(r.nodeId, (map.get(r.nodeId) ?? 0) + 1);
    return map;
  }, [execution]);

  const previewOutputs = useMemo(() => {
    const out: Record<string, Item[]> = {};
    for (const r of execution?.runs ?? []) {
      const items = r.output.find((o) => o.length);
      if (items || !out[r.nodeName]) out[r.nodeName] = items ?? [];
    }
    return out;
  }, [execution]);

  const issueNodes = useMemo(() => new Set((workflow?.issues ?? []).map((i) => i.nodeId).filter(Boolean)), [workflow]);

  const nodes: FlowNodeType[] = definition.nodes.map((n) => ({
    id: n.id,
    type: 'sa',
    position: n.position,
    selected: n.id === selectedId,
    data: { node: n, description: describe(n.type), run: runsByNode.get(n.id), runCount: runCounts.get(n.id) ?? 0, hasIssue: issueNodes.has(n.id) },
  }));

  const edges: Edge[] = definition.connections.map((c) => ({
    id: `${c.from}:${c.fromOutput}->${c.to}:${c.toInput}`,
    source: c.from,
    sourceHandle: `out-${c.fromOutput}`,
    target: c.to,
    targetHandle: `in-${c.toInput}`,
    animated: running,
  }));

  const onNodesChange = (changes: NodeChange<FlowNodeType>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position && !readOnly) {
        const pos = change.position;
        update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === change.id ? { ...n, position: { x: Math.round(pos.x), y: Math.round(pos.y) } } : n)) }));
      } else if (change.type === 'remove' && !readOnly) {
        removeNode(change.id);
      } else if (change.type === 'select' && change.selected) {
        setSelectedId(change.id);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (readOnly) return;
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
    if (!removed.size) return;
    update((d) => ({ ...d, connections: d.connections.filter((c) => !removed.has(`${c.from}:${c.fromOutput}->${c.to}:${c.toInput}`)) }));
  };

  const onConnect = (c: FlowConnection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    const conn = { from: c.source, fromOutput: Number(c.sourceHandle?.split('-')[1] ?? 0), to: c.target, toInput: Number(c.targetHandle?.split('-')[1] ?? 0) };
    update((d) =>
      d.connections.some((x) => x.from === conn.from && x.fromOutput === conn.fromOutput && x.to === conn.to && x.toInput === conn.toInput)
        ? d
        : { ...d, connections: [...d.connections, conn] },
    );
  };

  const removeNode = (nodeId: string) => {
    update((d) => ({ nodes: d.nodes.filter((n) => n.id !== nodeId), connections: d.connections.filter((c) => c.from !== nodeId && c.to !== nodeId) }));
    setSelectedId((s) => (s === nodeId ? null : s));
  };

  const uniqueName = (base: string) => {
    const names = new Set(definition.nodes.map((n) => n.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  };

  const addNode = (desc: NodeTypeDescription) => {
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2 - 150, y: window.innerHeight / 2 });
    const selected = definition.nodes.find((n) => n.id === selectedId);
    const position = selected ? { x: selected.position.x + 260, y: selected.position.y } : center;
    const node: NodeInstance = {
      id: crypto.randomUUID(),
      name: uniqueName(desc.displayName),
      type: desc.type,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
      parameters: {},
    };
    update((d) => ({
      nodes: [...d.nodes, node],
      // Liga automaticamente ao nó selecionado, como no n8n.
      connections: selected && desc.inputs > 0 ? [...d.connections, { from: selected.id, fromOutput: 0, to: node.id, toInput: 0 }] : d.connections,
    }));
    setSelectedId(node.id);
    setTimeout(() => flow.fitView({ padding: 0.3, maxZoom: 1, duration: 200 }), 50);
  };

  const save = useCallback(async () => {
    if (!workflow || readOnly) return;
    try {
      setError(null);
      const saved = await put<Workflow>(`/workflows/${workflow.id}`, { name, folderId, definition, baseVersion: workflow.version });
      setWorkflow(saved);
      setDirty(false);
      setNotice(saved.issues.length ? `Salvo, mas com ${saved.issues.length} pendência(s)` : 'Salvo');
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [workflow, readOnly, name, folderId, definition]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const execute = async () => {
    if (!workflow) return;
    let input: Item[] | undefined;
    if (testInput.trim()) {
      try {
        const parsed = JSON.parse(testInput);
        input = (Array.isArray(parsed) ? parsed : [parsed]).map((json) => ({ json }));
      } catch {
        setError('O JSON de entrada para testes não é válido');
        return;
      }
    }
    try {
      setError(null);
      setRunning(true);
      const body = readOnly ? { input } : { definition, input };
      const { executionId } = await post<{ executionId: string }>(`/workflows/${workflow.id}/run`, body);
      for (;;) {
        const ex = await get<ExecutionDetail>(`/executions/${executionId}`);
        setExecution(ex);
        if (ex.status !== 'queued' && ex.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 700));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const setActive = async (active: boolean) => {
    if (!workflow) return;
    if (dirty) return setError('Salve as alterações antes de ativar ou desativar');
    try {
      await post(`/workflows/${workflow.id}/${active ? 'activate' : 'deactivate'}`);
      setWorkflow({ ...workflow, active });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const exportJson = async () => {
    const data = await get(`/workflows/${workflow!.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!workflow) {
    return <div className="center">{error ? <ErrorBox message={error} /> : <span className="muted">Carregando…</span>}</div>;
  }

  const selected = definition.nodes.find((n) => n.id === selectedId);
  const hasSchedule = definition.nodes.some((n) => n.type === 'scheduleTrigger');
  const groups = ['trigger', 'action', 'logic', 'data'].map((g) => [g, descriptions.filter((d) => d.group === g && !d.hidden)] as const).filter(([, list]) => list.length);

  return (
    <div className="editor">
      <header className="editor-toolbar">
        <Link to="/fluxos" onClick={(e) => dirty && !confirm('Sair sem salvar?') && e.preventDefault()}>
          ← Fluxos
        </Link>
        <input className="workflow-name" value={name} disabled={readOnly} onChange={(e) => (setName(e.target.value), setDirty(true))} />
        <select value={folderId} disabled={readOnly} onChange={(e) => (setFolderId(e.target.value), setDirty(true))}>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <span className="muted small">
          versão {workflow.version}
          {dirty && ' · alterações não salvas'}
        </span>
        <div className="spacer" />
        {notice && <span className="ok-text">{notice}</span>}
        {hasSchedule && (
          <label className="check" title="Fluxos ativos rodam sozinhos no agendamento">
            <input type="checkbox" checked={workflow.active} disabled={readOnly} onChange={(e) => setActive(e.target.checked)} /> Ativo
          </label>
        )}
        <button onClick={() => setShowVersions(true)}>Versões</button>
        <button onClick={exportJson}>Exportar</button>
        {me.permissions.executeWorkflows && (
          <button onClick={execute} disabled={running}>
            {running ? 'Executando…' : 'Executar'}
          </button>
        )}
        {!readOnly && (
          <button className="primary" onClick={save} disabled={!dirty}>
            Salvar
          </button>
        )}
      </header>
      <ErrorBox message={error} />
      {workflow.issues.length > 0 && !dirty && (
        <div className="warning-box">
          {workflow.issues.map((i, k) => (
            <div key={k}>{i.message}</div>
          ))}
        </div>
      )}
      {execution && (
        <div className="execution-bar">
          Última execução: <StatusBadge status={execution.status} /> {formatDate(execution.started_at ?? execution.created_at)}
          {execution.error && <span className="error-text"> · {execution.error.nodeName ? `${execution.error.nodeName}: ` : ''}{execution.error.message}</span>}{' '}
          <button className="link" onClick={() => navigate(`/execucoes/${execution.id}`)}>
            Ver log completo
          </button>
        </div>
      )}
      <div className="editor-body">
        {!readOnly && (
          <aside className="palette">
            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="palette-group">{GROUP_LABEL[group]}</div>
                {list.map((d) => (
                  <button key={d.type} className="palette-item" title={d.description} onClick={() => addNode(d)}>
                    {d.displayName}
                  </button>
                ))}
              </div>
            ))}
            <p className="muted small">Clique para adicionar. Com um nó selecionado, o novo já entra ligado a ele.</p>
          </aside>
        )}
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={() => setSelectedId(null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        {selected && (
          <NodePanel
            key={selected.id}
            node={selected}
            description={describe(selected.type)}
            run={runsByNode.get(selected.id)}
            previewOutputs={previewOutputs}
            connections={connections}
            workflows={workflows}
            catalog={catalog}
            runCount={runCounts.get(selectedId!) ?? 0}
            readOnly={readOnly}
            nameTaken={(n) => definition.nodes.some((x) => x.id !== selected.id && x.name === n)}
            testInput={testInput}
            onTestInputChange={setTestInput}
            onChange={(node) => update((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? node : n)) }))}
            onDelete={() => removeNode(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      {showVersions && (
        <VersionsModal
          workflowId={workflow.id}
          onClose={() => setShowVersions(false)}
          onRestore={(def, versionName) => {
            setDefinition(def);
            setName(versionName);
            setDirty(true);
            setShowVersions(false);
            setNotice('Versão carregada; salve para restaurar');
          }}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

function VersionsModal({
  workflowId,
  onClose,
  onRestore,
  readOnly,
}: {
  workflowId: string;
  onClose: () => void;
  onRestore: (definition: WorkflowDefinition, name: string) => void;
  readOnly: boolean;
}) {
  const [versions, setVersions] = useState<{ version: number; name: string; created_at: string; created_by_name: string | null }[]>([]);
  useEffect(() => {
    void get<typeof versions>(`/workflows/${workflowId}/versions`).then(setVersions);
  }, [workflowId]);

  const restore = async (version: number) => {
    const v = await get<{ definition: WorkflowDefinition; name: string }>(`/workflows/${workflowId}/versions/${version}`);
    onRestore(v.definition, v.name);
  };

  return (
    <Modal title="Versões salvas" onClose={onClose}>
      <table>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version}>
              <td>Versão {v.version}</td>
              <td>{formatDate(v.created_at)}</td>
              <td className="muted">{v.created_by_name}</td>
              <td className="row-actions">
                {!readOnly && (
                  <button className="link" onClick={() => restore(v.version)}>
                    Carregar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
