import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react';
import { useEffect } from 'react';
import { resolveOutputs, type NodeInstance, type NodeRun, type NodeTypeDescription } from '../api';
import { Icon, NODE_COLOR } from '../components/icons';

export interface FlowNodeData extends Record<string, unknown> {
  node: NodeInstance;
  description?: NodeTypeDescription;
  run?: NodeRun;
  runCount?: number;
  hasIssue: boolean;
}

export type FlowNodeType = Node<FlowNodeData, 'sa'>;

/** Nó no estilo do n8n: um quadrado com o ícone e o nome embaixo. */
export function FlowNode({ id, data, selected }: NodeProps<FlowNodeType>) {
  const { node, description, run, runCount = 0, hasIssue } = data;
  const inputs = description?.inputs ?? 1;
  const resolved = description ? resolveOutputs(description, node.parameters) : { count: 1, names: undefined };
  const outputs = resolved.count;
  const outputNames = resolved.names;
  // O React Flow precisa recalcular as alças quando a quantidade de saídas muda (ex.: regra nova no Switch).
  const updateInternals = useUpdateNodeInternals();
  const handleKey = `${outputs}:${(outputNames ?? []).join('|')}`;
  useEffect(() => updateInternals(id), [handleKey, id, updateInternals]);
  const status = run ? run.status : undefined;
  const trigger = description?.group === 'trigger';
  const classes = ['flow-node', trigger && 'trigger', selected && 'selected', node.disabled && 'disabled', status && `run-${status}`, hasIssue && 'has-issue'];

  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <div className="flow-node-box" title={description?.description}>
        {Array.from({ length: inputs }, (_, i) => (
          <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} style={{ top: `${((i + 1) / (inputs + 1)) * 100}%` }}>
            {description?.inputNames && <span className="handle-label handle-label-in">{description.inputNames[i]}</span>}
          </Handle>
        ))}
        {trigger && <span className="trigger-bolt">⚡</span>}
        <span className="flow-node-icon" style={{ color: description ? (NODE_COLOR[node.type] ?? 'var(--primary)') : 'var(--danger)' }}>
          <Icon name={description ? node.type : 'unknown'} size={40} />
        </span>
        {run && (
          <span className={`flow-node-status ${run.status}`} title={run.error?.message}>
            {run.status === 'error' ? '!' : '✓'}
          </span>
        )}
        {Array.from({ length: outputs }, (_, i) => (
          <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right} style={{ top: `${((i + 1) / (outputs + 1)) * 100}%` }}>
            {outputNames && <span className="handle-label">{outputNames[i]}</span>}
          </Handle>
        ))}
      </div>
      <div className="flow-node-label">
        <div className="flow-node-name">{node.name}</div>
        <div className="flow-node-type">{description?.displayName ?? `Tipo desconhecido: ${node.type}`}</div>
        {run && (
          <div className="flow-node-run">
            {run.status === 'error' ? 'erro' : itemCount(run.output.reduce((n, o) => n + o.length, 0))}
            {runCount > 1 && ` · ${runCount}x`}
          </div>
        )}
      </div>
    </div>
  );
}

function itemCount(n: number): string {
  return n === 1 ? '1 item' : `${n} itens`;
}
