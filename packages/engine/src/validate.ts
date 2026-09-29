import { isExpression, parseTemplate, TemplateSyntaxError } from './expressions/template.js';
import { defaultRegistry, type NodeRegistry } from './registry.js';
import type { JsonValue, WorkflowDefinition } from './types.js';

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

/** Verifica o fluxo antes de salvar ou ativar. */
export function validateWorkflow(workflow: WorkflowDefinition, registry: NodeRegistry = defaultRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const node of workflow.nodes) {
    if (ids.has(node.id)) issues.push({ nodeId: node.id, message: `ID de nó repetido: ${node.id}` });
    ids.add(node.id);
    if (names.has(node.name)) issues.push({ nodeId: node.id, message: `Já existe outro nó chamado "${node.name}"` });
    names.add(node.name);

    const type = registry.get(node.type);
    if (!type) {
      issues.push({ nodeId: node.id, message: `Tipo de nó desconhecido: ${node.type}` });
      continue;
    }
    for (const prop of type.description.properties) {
      const value = node.parameters[prop.name];
      if (prop.required && (value === undefined || value === '' || value === '=')) {
        issues.push({ nodeId: node.id, message: `"${node.name}": o campo ${prop.displayName} é obrigatório` });
      }
    }
    for (const message of checkExpressions(node.parameters)) {
      issues.push({ nodeId: node.id, message: `"${node.name}": ${message}` });
    }
  }

  const triggers = workflow.nodes.filter((n) => registry.get(n.type)?.description.group === 'trigger');
  if (triggers.length === 0) issues.push({ message: 'O fluxo precisa de um gatilho' });
  if (triggers.length > 1) issues.push({ message: 'O fluxo deve ter apenas um gatilho' });

  for (const c of workflow.connections) {
    if (!ids.has(c.from) || !ids.has(c.to)) issues.push({ message: 'Existe uma ligação para um nó que não existe' });
  }

  const connected = new Set(workflow.connections.flatMap((c) => [c.from, c.to]));
  for (const node of workflow.nodes) {
    const isTrigger = registry.get(node.type)?.description.group === 'trigger';
    if (!isTrigger && !connected.has(node.id)) {
      issues.push({ nodeId: node.id, message: `"${node.name}" não está ligado a nenhum nó` });
    }
  }
  return issues;
}

function checkExpressions(value: JsonValue): string[] {
  if (isExpression(value)) {
    try {
      parseTemplate(value.slice(1));
      return [];
    } catch (err) {
      return [err instanceof TemplateSyntaxError ? err.message : String(err)];
    }
  }
  if (Array.isArray(value)) return value.flatMap(checkExpressions);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(checkExpressions);
  return [];
}
