import type { NodeType, NodeTypeDescription } from './node-types.js';
import { httpRequest } from './nodes/http-request.js';
import { ifNode } from './nodes/if.js';
import { manualTrigger, scheduleTrigger } from './nodes/triggers.js';
import { aggregate, merge, splitOut } from './nodes/data.js';
import { clickup } from './nodes/clickup.js';
import { gmail } from './nodes/gmail.js';
import { database } from './nodes/database.js';
import { editFields } from './nodes/edit-fields.js';
import { metabase } from './nodes/metabase.js';
import { n8nUnsupported } from './nodes/unsupported.js';
import { code, executeWorkflow, executeWorkflowTrigger, loop, stopAndError } from './nodes/flow.js';
import { flowExtraNodes } from './nodes/flow-extra.js';
import { transformNodes } from './nodes/transform.js';
import { formatNodes } from './nodes/formats.js';
import { fileConvertNodes } from './nodes/files-convert.js';
import { fileDiskNodes } from './nodes/files-disk.js';
import { webhookNodes } from './nodes/webhook.js';
import { listenTriggerNodes } from './nodes/triggers-listen.js';

export class NodeRegistry {
  private types = new Map<string, NodeType>();

  constructor(types: NodeType[] = []) {
    for (const t of types) this.register(t);
  }

  register(type: NodeType): void {
    this.types.set(type.description.type, type);
  }

  get(type: string): NodeType | undefined {
    return this.types.get(type);
  }

  descriptions(): NodeTypeDescription[] {
    return [...this.types.values()].map((t) => t.description);
  }
}

export const defaultRegistry = new NodeRegistry([
  manualTrigger,
  scheduleTrigger,
  executeWorkflowTrigger,
  httpRequest,
  database,
  metabase,
  clickup,
  gmail,
  executeWorkflow,
  ifNode,
  loop,
  stopAndError,
  splitOut,
  aggregate,
  merge,
  editFields,
  code,
  ...flowExtraNodes,
  ...transformNodes,
  ...formatNodes,
  ...fileConvertNodes,
  ...fileDiskNodes,
  ...webhookNodes,
  ...listenTriggerNodes,
  n8nUnsupported,
]);
