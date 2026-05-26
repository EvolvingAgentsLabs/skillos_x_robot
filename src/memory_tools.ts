// src/memory_tools.ts
// Tool definitions and dispatcher for memory operations.

import type { ToolDefinition, ToolCall } from './types';
import { MemoryStore } from './memory';

// ── Tool definitions ───────────────────────────────────────────

export const MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read a document from a memory store. Returns the content, SHA256 hash, and version number.',
      parameters: {
        type: 'object',
        properties: {
          store: {
            type: 'string',
            description: 'The name of the memory store.',
          },
          path: {
            type: 'string',
            description: 'The document path within the store (e.g., "maria.md").',
          },
        },
        required: ['store', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: 'Write content to a memory document. Creates version history automatically.',
      parameters: {
        type: 'object',
        properties: {
          store: {
            type: 'string',
            description: 'The name of the memory store.',
          },
          path: {
            type: 'string',
            description: 'The document path within the store (e.g., "maria.md").',
          },
          content: {
            type: 'string',
            description: 'The content to write.',
          },
        },
        required: ['store', 'path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: 'List documents in a memory store. If no store is specified, lists all available stores.',
      parameters: {
        type: 'object',
        properties: {
          store: {
            type: 'string',
            description: 'Optional: the name of the memory store to list. If omitted, lists all stores.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'Delete a document from a memory store.',
      parameters: {
        type: 'object',
        properties: {
          store: {
            type: 'string',
            description: 'The name of the memory store.',
          },
          path: {
            type: 'string',
            description: 'The document path to delete.',
          },
        },
        required: ['store', 'path'],
      },
    },
  },
];

// ── Dispatcher ─────────────────────────────────────────────────

export function dispatchMemoryToolCall(
  stores: Map<string, MemoryStore>,
  toolCall: ToolCall,
): unknown {
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    return { error: `Invalid JSON arguments: ${toolCall.function.arguments}` };
  }

  switch (name) {
    case 'read_memory': {
      const store = stores.get(String(args.store || ''));
      if (!store) return { error: `Unknown memory store: ${args.store}` };
      const result = store.read(String(args.path || ''));
      if (!result) return { error: `Document not found: ${args.path}` };
      return result;
    }

    case 'write_memory': {
      const store = stores.get(String(args.store || ''));
      if (!store) return { error: `Unknown memory store: ${args.store}` };
      return store.write(
        String(args.path || ''),
        String(args.content || ''),
        args.precondition_sha256 ? String(args.precondition_sha256) : undefined,
      );
    }

    case 'list_memories': {
      if (args.store) {
        const store = stores.get(String(args.store));
        if (!store) return { error: `Unknown memory store: ${args.store}` };
        return { store: store.name, documents: store.list() };
      }
      // List all stores
      const storeList = [];
      for (const [, store] of stores) {
        const m = store.getManifest();
        storeList.push({
          name: m.name,
          description: m.description,
          access: m.access,
          documents: store.list().length,
        });
      }
      return { stores: storeList };
    }

    case 'delete_memory': {
      const store = stores.get(String(args.store || ''));
      if (!store) return { error: `Unknown memory store: ${args.store}` };
      return store.delete(String(args.path || ''));
    }

    default:
      return { error: `Unknown memory tool: ${name}` };
  }
}
