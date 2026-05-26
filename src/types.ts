// src/types.ts
// Shared interfaces for skillos_x_robot.

// ── World ──────────────────────────────────────────────────────

export interface Position {
  x: number;       // meters
  y: number;       // meters
  heading: number;  // degrees, 0=east, 90=north
}

export interface Landmark {
  id: string;
  label: string;
  x: number;  // meters
  y: number;  // meters
  type: 'door' | 'person' | 'obstacle' | 'object';
}

export interface ObserveResult {
  position: Position;
  nearby_landmarks: Array<{
    id: string;
    label: string;
    distance_m: number;
    bearing_deg: number;
    type: string;
  }>;
  nearest_person?: {
    id: string;
    label: string;
    distance_m: number;
    bearing_deg: number;
  };
}

// ── Skills ─────────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
}

export interface Skill {
  meta: SkillMeta;
  instructions: string;
  filePath: string;
}

// ── OpenAI-compatible function calling ─────────────────────────

export interface ToolFunctionParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolFunctionParameter>;
    required?: string[];
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

// ── Chat messages ──────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ── Backend ────────────────────────────────────────────────────

export interface GenerateResult {
  message: string | null;
  tool_calls?: ToolCall[];
  finish_reason: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ── Memory ─────────────────────────────────────────────────────

export interface MemoryManifest {
  name: string;
  description: string;
  instructions: string;
  access: 'read_write' | 'read_only';
  created: string;
  maxSizeBytes: number;
}

export interface MemoryDocument {
  path: string;
  content: string;
  sha256: string;
  version: number;
  lastModified: string;
}

// ── Session traces ─────────────────────────────────────────────

export interface SessionTraceMeta {
  timestamp: string;
  task: string;
  outcome: 'success' | 'failure' | 'max_turns';
  durationMs: number;
  turns: number;
  model: string;
  skillsLoaded: string[];
  memoryReads: number;
  memoryWrites: number;
}

export interface ParsedTranscript {
  meta: SessionTraceMeta;
  summary: string;
  filePath: string;
}

// ── Agent result ───────────────────────────────────────────────

export interface AgentRunResult {
  outcome: 'success' | 'failure' | 'max_turns';
  turns: number;
  durationMs: number;
  messages: ChatMessage[];
  skillsLoaded: string[];
  memoryReads: number;
  memoryWrites: number;
}

// ── Dream ──────────────────────────────────────────────────────

export interface DreamResult {
  status: 'completed' | 'failed';
  transcriptsProcessed: number;
  memoriesRead: number;
  memoriesWritten: number;
  insights: string[];
  journalEntry: string;
  durationMs: number;
}

// ── WebSocket messages ─────────────────────────────────────────

export type WsMessage =
  | { type: 'pose'; x: number; y: number; heading: number }
  | { type: 'goal'; goalId: string }
  | { type: 'speak'; text: string; step: number }
  | { type: 'listen'; text: string; step: number }
  | { type: 'move'; distance_cm: number; step: number }
  | { type: 'rotate'; degrees: number; direction: 'left' | 'right'; step: number }
  | { type: 'observe'; step: number; landmarks: number }
  | { type: 'arrived'; reason: string }
  | { type: 'halt'; status: string }
  | { type: 'tool_call'; name: string; args: unknown; step: number }
  | { type: 'skill_loaded'; name: string; step: number }
  | { type: 'memory_read'; store: string; path: string; step: number }
  | { type: 'memory_write'; store: string; path: string; step: number }
  | { type: 'dream_progress'; stage: string; detail: string }
  | { type: 'dream_complete'; result: DreamResult }
  | { type: 'run_started'; task: string }
  | { type: 'run_complete'; outcome: string; turns: number; durationMs: number };
