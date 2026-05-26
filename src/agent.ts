// src/agent.ts
// Agent loop: model + tools + skills + memory.
// Simple while loop using native function calling with progressive skill disclosure.

import type { ChatMessage, ToolCall, WsMessage, Skill, AgentRunResult } from './types';
import type { RobotHAL } from './hal';
import type { MemoryStore } from './memory';
import type { Backend } from './backend';
import { TOOL_DEFINITIONS, dispatchToolCall, ToolContext } from './tools';
import { buildSkillMetadataPrompt } from './skills';
import { buildMemoryPrompt } from './memory';

// ── Agent ──────────────────────────────────────────────────────

export interface AgentConfig {
  backend: Backend;
  hal: RobotHAL;
  skills: Skill[];
  memoryStores: Map<string, MemoryStore>;
  maxTurns?: number;
  broadcast?: (msg: WsMessage) => void;
}

export class Agent {
  private backend: Backend;
  private hal: RobotHAL;
  private skills: Skill[];
  private memoryStores: Map<string, MemoryStore>;
  private maxTurns: number;
  private broadcast: (msg: WsMessage) => void;
  private step = 0;
  private skillsLoaded: string[] = [];
  private memoryReads = 0;
  private memoryWrites = 0;

  constructor(config: AgentConfig) {
    this.backend = config.backend;
    this.hal = config.hal;
    this.skills = config.skills;
    this.memoryStores = config.memoryStores;
    this.maxTurns = config.maxTurns ?? 50;
    this.broadcast = config.broadcast ?? (() => {});
  }

  async run(task: string): Promise<AgentRunResult> {
    const startTime = Date.now();
    this.skillsLoaded = [];
    this.memoryReads = 0;
    this.memoryWrites = 0;

    const systemPrompt = this.buildSystemPrompt();
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    this.broadcast({ type: 'run_started', task });

    console.log(`\n  [agent] Task: "${task}"`);
    console.log(`  [agent] Model: ${this.backend.getModel()}`);
    console.log(`  [agent] Skills available: ${this.skills.map(s => s.meta.name).join(', ') || 'none'}`);
    console.log(`  [agent] Memory stores: ${[...this.memoryStores.keys()].join(', ') || 'none'}`);
    console.log(`  [agent] Max turns: ${this.maxTurns}\n`);

    let outcome: AgentRunResult['outcome'] = 'success';

    for (let turn = 0; turn < this.maxTurns; turn++) {
      this.step = turn + 1;
      console.log(`  [agent] --- Turn ${this.step} ---`);

      let result;
      try {
        result = await this.backend.generate(messages, TOOL_DEFINITIONS);
      } catch (err) {
        console.error(`  [agent] Backend error: ${err}`);
        this.broadcast({ type: 'halt', status: 'error' });
        outcome = 'failure';
        break;
      }

      // If the model returned tool calls, execute them
      if (result.tool_calls && result.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: result.message,
          tool_calls: result.tool_calls,
        });

        for (const tc of result.tool_calls) {
          console.log(`  [agent] tool_call: ${tc.function.name}(${tc.function.arguments})`);

          const output = await this.executeToolCall(tc);

          messages.push({
            role: 'tool',
            content: JSON.stringify(output),
            tool_call_id: tc.id,
          });
        }
        continue;
      }

      // No tool calls — model is speaking or done
      if (result.message) {
        console.log(`  [agent] assistant: ${result.message}`);
        messages.push({ role: 'assistant', content: result.message });
      }

      // Handle malformed function calls — ask model to retry
      if (result.finish_reason === 'malformed_function_call') {
        console.log(`  [agent] Malformed function call — asking model to retry.`);
        messages.push({
          role: 'user',
          content: 'Your last function call was malformed. Please try again with valid JSON arguments. Continue with the patrol.',
        });
        continue;
      }

      if (result.finish_reason === 'stop') {
        console.log(`  [agent] Model signaled stop. Done.`);
        this.broadcast({ type: 'halt', status: 'complete' });
        break;
      }

      if (!result.tool_calls?.length && result.finish_reason !== 'tool_calls') {
        console.log(`  [agent] No tool calls and finish_reason="${result.finish_reason}". Halting.`);
        this.broadcast({ type: 'halt', status: 'complete' });
        break;
      }
    }

    if (this.step >= this.maxTurns) {
      console.log(`  [agent] Max turns reached (${this.maxTurns}). Halting.`);
      this.broadcast({ type: 'halt', status: 'max_turns' });
      outcome = 'max_turns';
    }

    const durationMs = Date.now() - startTime;
    this.broadcast({ type: 'run_complete', outcome, turns: this.step, durationMs });

    console.log(`  [agent] Finished after ${this.step} turns (${durationMs}ms).`);
    console.log(`  [agent] Skills loaded: ${this.skillsLoaded.join(', ') || 'none'}`);
    console.log(`  [agent] Memory ops: ${this.memoryReads} reads, ${this.memoryWrites} writes`);

    return {
      outcome,
      turns: this.step,
      durationMs,
      messages,
      skillsLoaded: [...this.skillsLoaded],
      memoryReads: this.memoryReads,
      memoryWrites: this.memoryWrites,
    };
  }

  // ── Private ────────────────────────────────────────────────

  private async executeToolCall(tc: ToolCall): Promise<unknown> {
    const name = tc.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch { /* use empty args */ }

    // Broadcast the tool call event
    this.broadcast({
      type: 'tool_call',
      name,
      args,
      step: this.step,
    });

    const ctx: ToolContext = {
      hal: this.hal,
      skills: this.skills,
      memoryStores: this.memoryStores,
    };

    const output = await dispatchToolCall(ctx, tc);

    // Track skill loads
    if (name === 'load_skill' && args.name) {
      const skillName = String(args.name);
      if (!this.skillsLoaded.includes(skillName)) {
        this.skillsLoaded.push(skillName);
      }
      this.broadcast({ type: 'skill_loaded', name: skillName, step: this.step });
    }

    // Track memory operations
    if (name === 'read_memory') {
      this.memoryReads++;
      this.broadcast({
        type: 'memory_read',
        store: String(args.store || ''),
        path: String(args.path || ''),
        step: this.step,
      });
    }
    if (name === 'write_memory') {
      this.memoryWrites++;
      this.broadcast({
        type: 'memory_write',
        store: String(args.store || ''),
        path: String(args.path || ''),
        step: this.step,
      });
    }
    if (name === 'delete_memory') this.memoryWrites++;

    // Broadcast specific events for visualization
    if (name === 'move_forward') {
      const pos = await this.hal.get_position();
      this.broadcast({ type: 'pose', x: pos.x, y: pos.y, heading: pos.heading });
      this.broadcast({ type: 'move', distance_cm: Number(args.distance_cm) || 0, step: this.step });
    } else if (name === 'rotate_left') {
      const pos = await this.hal.get_position();
      this.broadcast({ type: 'pose', x: pos.x, y: pos.y, heading: pos.heading });
      this.broadcast({ type: 'rotate', degrees: Number(args.degrees) || 0, direction: 'left', step: this.step });
    } else if (name === 'rotate_right') {
      const pos = await this.hal.get_position();
      this.broadcast({ type: 'pose', x: pos.x, y: pos.y, heading: pos.heading });
      this.broadcast({ type: 'rotate', degrees: Number(args.degrees) || 0, direction: 'right', step: this.step });
    } else if (name === 'speak') {
      this.broadcast({ type: 'speak', text: String(args.text || ''), step: this.step });
    } else if (name === 'listen') {
      const result = output as { text: string };
      this.broadcast({ type: 'listen', text: result.text, step: this.step });
    } else if (name === 'observe') {
      const obs = output as { nearby_landmarks?: unknown[] };
      this.broadcast({ type: 'observe', step: this.step, landmarks: obs.nearby_landmarks?.length ?? 0 });
    }

    return output;
  }

  private buildSystemPrompt(): string {
    const skillSection = buildSkillMetadataPrompt(this.skills);
    const memorySection = buildMemoryPrompt(this.memoryStores);

    return `You are RoClaw, an autonomous facility patrol and safety monitoring robot. You patrol buildings, check security checkpoints, detect anomalies, and interact with facility staff.

## Your capabilities

You have tools to control your body:
- move_forward(distance_cm) — move forward in the direction you are facing
- rotate_left(degrees) — turn left (counterclockwise). Max 180 degrees.
- rotate_right(degrees) — turn right (clockwise). Max 180 degrees.
- stop() — emergency stop
- get_position() — check your position {x, y} in meters and heading in degrees
- observe() — scan surroundings, returns landmarks with distance and bearing
- speak(text) — communicate with staff or announce status
- listen() — listen for verbal commands from staff

## How to navigate

1. Call observe() to scan your surroundings.
2. Find the target landmark in the results. Each landmark has:
   - distance_m: how far away it is
   - bearing_deg: angle from your current heading (range: -180 to +180)
3. **Bearing tells you which way to turn:**
   - Positive bearing (e.g. +45) → call rotate_left(45)
   - Negative bearing (e.g. -30) → call rotate_right(30)
   - bearing near 0 → you are already facing it, just move forward
4. After rotating, call move_forward(50) to move 50cm forward.
5. Call observe() again to check progress.
6. Repeat until distance_m < 0.3 (you have arrived).

**IMPORTANT:** Never rotate more than 180 degrees. The bearing is always between -180 and +180, so you never need to.

## Patrol protocol

1. **FIRST:** Load the patrol-route skill with load_skill("patrol-route").
2. **THEN:** Read patrol-log memory with read_memory("patrol-log", "latest.md") to check for prior patrol data.
3. Visit each checkpoint in order. At each one:
   - Navigate to it using observe/rotate/move
   - Announce: speak("Checkpoint [name] — clear") or speak("Checkpoint [name] — anomaly detected: [reason]")
4. If you encounter a person, greet them, listen for instructions, and act on them.
5. **AFTER visiting all checkpoints:** Write a patrol summary to memory with write_memory("patrol-log", "latest.md", "[summary]"). Include timestamp, each checkpoint status, anomalies found, and staff interactions.
6. Return to starting area and stop.

## Important rules
- Move in short steps (50cm), observe after every 1-2 moves.
- Keep tool calls simple — one tool per turn.
- When patrol is complete, write memory then stop.
${skillSection}${memorySection}`;
  }
}
