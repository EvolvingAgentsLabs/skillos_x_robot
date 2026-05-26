// src/backend.ts
// Multi-backend LLM client.
// Supports OpenRouter (OpenAI-compatible) and Gemini AI (direct REST API).

import type { ChatMessage, ToolDefinition, ToolCall, GenerateResult } from './types';

// ── Backend interface ───────────────────────────────────────────

export interface Backend {
  generate(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    toolChoice?: 'auto' | 'none',
  ): Promise<GenerateResult>;
  getModel(): string;
}

// ── Config ─────────────────────────────────────────────────────

export interface BackendConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
}

// ── OpenRouter Backend ─────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterBackend implements Backend {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxRetries: number;

  constructor(config: BackendConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.model = config.model || process.env.AGENT_MODEL || 'google/gemma-4-26b-a4b-it';
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.maxTokens = config.maxTokens || 1024;
    this.temperature = config.temperature ?? 0.3;
    this.maxRetries = config.maxRetries ?? 3;

    if (!this.apiKey) {
      throw new Error(
        'OpenRouter API key required. Set OPENROUTER_API_KEY or pass config.apiKey',
      );
    }
  }

  getModel(): string {
    return this.model;
  }

  async generate(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    toolChoice?: 'auto' | 'none',
  ): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/EvolvingAgentsLabs/skillos_x_robot',
      'X-Title': 'skillos_x_robot Agent',
    };
    const payload = JSON.stringify(body);

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: payload });

        if (!res.ok) {
          const text = await res.text();
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(`OpenRouter ${res.status}: ${text}`);
            console.warn(`  [backend] Retryable error (attempt ${attempt + 1}/${this.maxRetries}): ${res.status}`);
            await sleep(1000 * (attempt + 1));
            continue;
          }
          throw new Error(`OpenRouter ${res.status}: ${text}`);
        }

        const json = await res.json() as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: ToolCall[];
            };
            finish_reason?: string;
          }>;
          model?: string;
          usage?: Record<string, number>;
        };
        const choice = json.choices?.[0];

        if (!choice) {
          throw new Error(`OpenRouter returned no choices: ${JSON.stringify(json)}`);
        }

        return {
          message: choice.message?.content ?? null,
          tool_calls: choice.message?.tool_calls,
          finish_reason: choice.finish_reason || 'unknown',
          model: json.model || this.model,
          usage: json.usage || {},
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const code = (err as NodeJS.ErrnoException).code;
        if (
          attempt < this.maxRetries - 1 &&
          (code === 'ECONNRESET' ||
            code === 'UND_ERR_CONNECT_TIMEOUT' ||
            lastErr.message.includes('fetch failed'))
        ) {
          console.warn(`  [backend] Network error, retrying (attempt ${attempt + 1}/${this.maxRetries})`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr!;
  }
}

// ── Gemini Backend ─────────────────────────────────────────────

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiBackend implements Backend {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxRetries: number;

  constructor(config: BackendConfig = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.maxTokens = config.maxTokens || 8192;
    this.temperature = config.temperature ?? 0.3;
    this.maxRetries = config.maxRetries ?? 3;

    if (!this.apiKey) {
      throw new Error(
        'Gemini API key required. Set GEMINI_API_KEY or pass config.apiKey',
      );
    }
  }

  getModel(): string {
    return this.model;
  }

  async generate(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    _toolChoice?: 'auto' | 'none',
  ): Promise<GenerateResult> {
    // Build Gemini request body from ChatMessage[]
    const body = this.buildRequestBody(messages, tools);
    const url = `${GEMINI_BASE_URL}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const payload = JSON.stringify(body);

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: payload });

        if (!res.ok) {
          const text = await res.text();
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(`Gemini ${res.status}: ${text}`);
            console.warn(`  [backend] Retryable error (attempt ${attempt + 1}/${this.maxRetries}): ${res.status}`);
            await sleep(1000 * (attempt + 1));
            continue;
          }
          throw new Error(`Gemini ${res.status}: ${text}`);
        }

        const json = await res.json() as GeminiResponse;
        return this.parseResponse(json);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const code = (err as NodeJS.ErrnoException).code;
        if (
          attempt < this.maxRetries - 1 &&
          (code === 'ECONNRESET' ||
            code === 'UND_ERR_CONNECT_TIMEOUT' ||
            lastErr.message.includes('fetch failed'))
        ) {
          console.warn(`  [backend] Network error, retrying (attempt ${attempt + 1}/${this.maxRetries})`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr!;
  }

  // ── Gemini format conversion ──────────────────────────────────

  private buildRequestBody(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        temperature: this.temperature,
      },
    };

    // Extract system message → systemInstruction
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && systemMsg.content) {
      body.system_instruction = {
        parts: [{ text: systemMsg.content }],
      };
    }

    // Convert messages → contents (skip system)
    const contents: GeminiContent[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content || '' }],
        });
      } else if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty */ }
            parts.push({
              functionCall: {
                name: tc.function.name,
                args,
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool results → user message with functionResponse
        // Try to find the tool name from the preceding assistant message
        const toolName = this.findToolName(messages, msg.tool_call_id);
        let responseData: unknown;
        try { responseData = JSON.parse(msg.content || '{}'); } catch { responseData = { result: msg.content }; }

        // Check if the last content is already a user with functionResponse parts
        const lastContent = contents[contents.length - 1];
        const fnResponsePart: GeminiPart = {
          functionResponse: {
            name: toolName,
            response: responseData as Record<string, unknown>,
          },
        };

        if (lastContent && lastContent.role === 'user' && lastContent.parts[0]?.functionResponse) {
          // Merge with existing functionResponse user message
          lastContent.parts.push(fnResponsePart);
        } else {
          contents.push({
            role: 'user',
            parts: [fnResponsePart],
          });
        }
      }
    }

    body.contents = contents;

    // Convert tools → Gemini functionDeclarations
    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    return body;
  }

  private findToolName(messages: ChatMessage[], toolCallId?: string): string {
    if (!toolCallId) return 'unknown';
    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id === toolCallId) return tc.function.name;
        }
      }
    }
    return 'unknown';
  }

  private parseResponse(json: GeminiResponse): GenerateResult {
    const candidate = json.candidates?.[0];
    if (!candidate) {
      throw new Error(`Gemini returned no candidates: ${JSON.stringify(json)}`);
    }

    const parts = candidate.content?.parts || [];
    let textMessage = '';
    const toolCalls: ToolCall[] = [];
    let callCounter = 0;

    for (const part of parts) {
      if (part.text) {
        textMessage += part.text;
      }
      if (part.functionCall) {
        callCounter++;
        toolCalls.push({
          id: part.functionCall.id || `call_${Date.now()}_${callCounter}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    // Determine finish reason
    let finishReason = 'stop';
    if (toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (candidate.finishReason === 'STOP') {
      finishReason = 'stop';
    } else if (candidate.finishReason === 'MAX_TOKENS') {
      finishReason = 'length';
    } else if (candidate.finishReason) {
      finishReason = candidate.finishReason.toLowerCase();
    }

    return {
      message: textMessage || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
      model: this.model,
      usage: {
        prompt_tokens: json.usageMetadata?.promptTokenCount,
        completion_tokens: json.usageMetadata?.candidatesTokenCount,
        total_tokens: json.usageMetadata?.totalTokenCount,
      },
    };
  }
}

// ── Gemini API types ────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    id?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    id?: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ── Factory ────────────────────────────────────────────────────

export type BackendType = 'gemma4' | 'gemini';

export function createBackend(type: BackendType, overrides: BackendConfig = {}): Backend {
  console.log(`  [backend] Creating ${type} backend...`);
  if (type === 'gemini') {
    return new GeminiBackend(overrides);
  }
  return new OpenRouterBackend(overrides);
}

// ── Util ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
