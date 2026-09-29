import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { NodeInstance, NodeRun, NodeTypeDescription } from '../api';

export interface FlowNodeData extends Record<string, unknown> {
  node: NodeInstance;
  description?: NodeTypeDescription;
  run?: NodeRun;
  hasIssue: boolean;
}

export type FlowNodeType = Node<FlowNodeData, 'sa'>;

const GROUP_ICON: Record<string, string> = { trigger: '▶', action: '⇄', logic: '◇', data: '≡' };

export function FlowNode({ data, selected }: NodeProps<FlowNodeType>) {
  const { node, description, run, hasIssue } = data;
  const inputs = description?.inputs ?? 1;
  const outputs = description?.outputs ?? 1;
  const status = run ? run.status : undefined;

  return (
    <div className={`flow-node ${selected ? 'selected' : ''} ${node.disabled ? 'disabled' : ''} ${status ? `run-${status}` : ''} ${hasIssue ? 'has-issue' : ''}`}>
      {Array.from({ length: inputs }, (_, i) => (
        <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} style={{ top: `${((i + 1) / (inputs + 1)) * 100}%` }} />
      ))}
      <div className="flow-node-icon">{GROUP_ICON[description?.group ?? 'action']}</div>
      <div className="flow-node-text">
        <div className="flow-node-name">{node.name}</div>
        <div className="flow-node-type">{description?.displayName ?? `Tipo desconhecido: ${node.type}`}</div>
      </div>
      {run && (
        <div className="flow-node-run" title={run.error?.message}>
          {run.status === 'error' ? 'erro' : `${run.output.reduce((n, o) => n + o.length, 0)} itens`}
        </div>
      )}
      {Array.from({ length: outputs }, (_, i) => (
        <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right} style={{ top: `${((i + 1) / (outputs + 1)) * 100}%` }}>
          {description?.outputNames && <span className="handle-label">{description.outputNames[i]}</span>}
        </Handle>
      ))}
    </div>
  );
}
