import type { NodeType, NodeTypeDescription } from './node-types.js';
import { httpRequest } from './nodes/http-request.js';
import { ifNode } from './nodes/if.js';
import { manualTrigger, scheduleTrigger } from './nodes/triggers.js';

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

export const defaultRegistry = new NodeRegistry([manualTrigger, scheduleTrigger, httpRequest, ifNode]);
