// src/session_trace.ts
// Records agent execution transcripts for dream consumption.
// Each run is saved as a markdown file with YAML frontmatter.

import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, SessionTraceMeta, ParsedTranscript } from './types';

// ── Recorder ───────────────────────────────────────────────────

export class SessionTraceRecorder {
  private tracesDir: string;

  constructor(tracesDir: string) {
    this.tracesDir = tracesDir;
    if (!fs.existsSync(tracesDir)) {
      fs.mkdirSync(tracesDir, { recursive: true });
    }
  }

  save(meta: SessionTraceMeta, messages: ChatMessage[]): string {
    const slug = meta.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/-$/, '');
    const ts = new Date(meta.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${ts}_${slug}.md`;
    const filePath = path.join(this.tracesDir, filename);

    const frontmatter = [
      '---',
      `timestamp: "${meta.timestamp}"`,
      `task: "${meta.task.replace(/"/g, '\\"')}"`,
      `outcome: ${meta.outcome}`,
      `duration_ms: ${meta.durationMs}`,
      `turns: ${meta.turns}`,
      `model: "${meta.model}"`,
      `skills_loaded: [${meta.skillsLoaded.map(s => `"${s}"`).join(', ')}]`,
      `memory_reads: ${meta.memoryReads}`,
      `memory_writes: ${meta.memoryWrites}`,
      '---',
    ].join('\n');

    const turns: string[] = [];
    let turnNum = 0;
    for (const msg of messages) {
      if (msg.role === 'system') continue; // skip system prompt
      turnNum++;

      if (msg.role === 'user') {
        turns.push(`## Turn ${turnNum}\n**User:** ${msg.content}`);
      } else if (msg.role === 'assistant') {
        let text = '';
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const calls = msg.tool_calls
            .map(tc => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`)
            .join('\n');
          text = msg.content ? `${msg.content}\n${calls}` : calls;
        } else {
          text = msg.content || '(no content)';
        }
        turns.push(`## Turn ${turnNum}\n**Assistant:** ${text}`);
      } else if (msg.role === 'tool') {
        // Summarize tool results (truncate long outputs)
        const content = msg.content || '';
        const summary = content.length > 200
          ? content.slice(0, 200) + '...'
          : content;
        turns.push(`**Tool Result** (${msg.tool_call_id}): ${summary}`);
        turnNum--; // tool results don't count as separate turns
      }
    }

    const body = `\n# Session: ${meta.task}\n\n${turns.join('\n\n')}`;
    fs.writeFileSync(filePath, frontmatter + body, 'utf-8');

    return filePath;
  }

  // ── Static loader ────────────────────────────────────────────

  static loadTranscripts(tracesDir: string, limit = 100): ParsedTranscript[] {
    if (!fs.existsSync(tracesDir)) return [];

    const files = fs.readdirSync(tracesDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .sort()
      .reverse()
      .slice(0, limit);

    const transcripts: ParsedTranscript[] = [];

    for (const file of files) {
      const filePath = path.join(tracesDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');

      const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      if (!fmMatch) continue;

      const frontmatter = fmMatch[1];
      const body = fmMatch[2];

      const meta: SessionTraceMeta = {
        timestamp: extractField(frontmatter, 'timestamp') || '',
        task: extractField(frontmatter, 'task') || '',
        outcome: (extractField(frontmatter, 'outcome') || 'failure') as SessionTraceMeta['outcome'],
        durationMs: parseInt(extractField(frontmatter, 'duration_ms') || '0', 10),
        turns: parseInt(extractField(frontmatter, 'turns') || '0', 10),
        model: extractField(frontmatter, 'model') || '',
        skillsLoaded: extractArrayField(frontmatter, 'skills_loaded'),
        memoryReads: parseInt(extractField(frontmatter, 'memory_reads') || '0', 10),
        memoryWrites: parseInt(extractField(frontmatter, 'memory_writes') || '0', 10),
      };

      // Create a summary from the body (first 500 chars)
      const summary = body.trim().slice(0, 500);

      transcripts.push({ meta, summary, filePath });
    }

    return transcripts;
  }
}

// ── Helpers ────────────────────────────────────────────────────

function extractField(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'));
  return match ? match[1].trim() : '';
}

function extractArrayField(frontmatter: string, key: string): string[] {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)]`, 'm'));
  if (!match) return [];
  return match[1]
    .split(',')
    .map(s => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}
