// src/tools.ts
// Tool definitions (OpenAI function calling format) and unified dispatcher.
// Includes HAL tools, skill tools, and memory tools.

import type { ToolDefinition, ToolCall, Skill } from './types';
import type { RobotHAL } from './hal';
import type { MemoryStore } from './memory';
import { loadSkillBody } from './skills';
import { dispatchMemoryToolCall, MEMORY_TOOL_DEFINITIONS } from './memory_tools';

// ── Tool context ───────────────────────────────────────────────

export interface ToolContext {
  hal: RobotHAL;
  skills: Skill[];
  memoryStores: Map<string, MemoryStore>;
}

// ── HAL tool definitions ───────────────────────────────────────

export const HAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'move_forward',
      description: 'Move the robot forward by a specified distance in centimeters.',
      parameters: {
        type: 'object',
        properties: {
          distance_cm: {
            type: 'number',
            description: 'Distance to move forward in centimeters (1-200).',
          },
        },
        required: ['distance_cm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rotate_left',
      description: 'Rotate the robot counter-clockwise by a specified number of degrees.',
      parameters: {
        type: 'object',
        properties: {
          degrees: {
            type: 'number',
            description: 'Degrees to rotate left (1-360).',
          },
        },
        required: ['degrees'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rotate_right',
      description: 'Rotate the robot clockwise by a specified number of degrees.',
      parameters: {
        type: 'object',
        properties: {
          degrees: {
            type: 'number',
            description: 'Degrees to rotate right (1-360).',
          },
        },
        required: ['degrees'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop',
      description: 'Stop the robot immediately.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_position',
      description: 'Get the current position and heading of the robot. Returns {x, y, heading} in meters and degrees.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'observe',
      description: 'Observe the surroundings. Returns nearby landmarks with distance and bearing, and the nearest person if any.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Say something aloud to the person nearby.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to speak.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listen',
      description: 'Listen for a response from the person. Returns the text they said.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// ── Skill tool definition ──────────────────────────────────────

export const SKILL_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: 'Load the full instructions for a named skill. Call this when you need to execute a skill from the Available Skills table.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name to load (from the Available Skills table).',
        },
      },
      required: ['name'],
    },
  },
};

// ── Combined tool definitions ──────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...HAL_TOOL_DEFINITIONS,
  SKILL_TOOL_DEFINITION,
  ...MEMORY_TOOL_DEFINITIONS,
];

// ── Memory tool names ──────────────────────────────────────────

const MEMORY_TOOL_NAMES = new Set(
  MEMORY_TOOL_DEFINITIONS.map(t => t.function.name),
);

// ── Unified dispatcher ─────────────────────────────────────────

export async function dispatchToolCall(
  ctx: ToolContext,
  toolCall: ToolCall,
): Promise<unknown> {
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    return { error: `Invalid JSON arguments: ${toolCall.function.arguments}` };
  }

  // Skill tool
  if (name === 'load_skill') {
    const skillName = String(args.name || '');
    const body = loadSkillBody(ctx.skills, skillName);
    if (body === null) {
      return { error: `Skill not found: "${skillName}". Available: ${ctx.skills.map(s => s.meta.name).join(', ')}` };
    }
    return { skill: skillName, instructions: body };
  }

  // Memory tools
  if (MEMORY_TOOL_NAMES.has(name)) {
    return dispatchMemoryToolCall(ctx.memoryStores, toolCall);
  }

  // HAL tools
  switch (name) {
    case 'move_forward':
      return ctx.hal.move_forward(Number(args.distance_cm) || 20);
    case 'rotate_left':
      return ctx.hal.rotate_left(Number(args.degrees) || 15);
    case 'rotate_right':
      return ctx.hal.rotate_right(Number(args.degrees) || 15);
    case 'stop':
      return ctx.hal.stop();
    case 'get_position':
      return ctx.hal.get_position();
    case 'observe':
      return ctx.hal.observe();
    case 'speak':
      return ctx.hal.speak(String(args.text || ''));
    case 'listen':
      return ctx.hal.listen();
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
