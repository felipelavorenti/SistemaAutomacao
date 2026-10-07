import { isExpression, parseTemplate, TemplateSyntaxError } from './expressions/template.js';
import { UNSUPPORTED_NODE_TYPE } from './n8n/import.js';
import { defaultRegistry, type NodeRegistry } from './registry.js';
import { ScheduleError, scheduleRepeat } from './schedule.js';
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
    if (node.type === UNSUPPORTED_NODE_TYPE) {
      issues.push({ nodeId: node.id, message: `"${node.name}" veio do n8n sem equivalente; substitua-o por outros nós` });
    }
    const values = Object.fromEntries(type.description.properties.map((p) => [p.name, node.parameters[p.name] ?? p.default]));
    for (const prop of type.description.properties) {
      const value = node.parameters[prop.name];
      const visible = !prop.showWhen || Object.entries(prop.showWhen).every(([key, allowed]) => allowed.includes(values[key] ?? null));
      if (prop.required && visible && (value === undefined || value === '' || value === '=')) {
        issues.push({ nodeId: node.id, message: `"${node.name}": o campo ${prop.displayName} é obrigatório` });
      }
    }
    // Data vazia já aparece como campo obrigatório.
    if (node.type === 'scheduleTrigger' && !(values.mode === 'once' && !values.dateTime)) {
      try {
        scheduleRepeat(values);
      } catch (err) {
        if (err instanceof ScheduleError) issues.push({ nodeId: node.id, message: `"${node.name}": ${err.message}` });
        else throw err;
      }
    }
    for (const message of checkExpressions(node.parameters)) {
      issues.push({ nodeId: node.id, message: `"${node.name}": ${message}` });
    }
  }

  const triggers = workflow.nodes.filter((n) => registry.get(n.type)?.description.group === 'trigger');
  if (triggers.length === 0) issues.push({ message: 'O fluxo precisa de um gatilho' });
  // Vários gatilhos valem, como no n8n: cada execução começa no gatilho que disparou.

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
