// src/dream.ts
// Dream engine — offline memory consolidation.
// Reads memory stores + session transcripts, uses LLM to reorganize and deduplicate.
// Produces a new, clean memory store.

import * as path from 'path';
import type { DreamResult, ParsedTranscript } from './types';
import { MemoryStore } from './memory';
import { SessionTraceRecorder } from './session_trace';
import type { Backend } from './backend';

// ── Config ─────────────────────────────────────────────────────

export interface DreamConfig {
  memoryDir: string;
  tracesDir: string;
  outputStore: string;
  maxTranscripts: number;
  instructions?: string;
}

// ── DreamEngine ────────────────────────────────────────────────

export class DreamEngine {
  private config: DreamConfig;
  private backend: Backend;

  constructor(config: DreamConfig, backend: Backend) {
    this.config = config;
    this.backend = backend;
  }

  async dream(): Promise<DreamResult> {
    const startTime = Date.now();
    console.log('  [dream] Starting memory consolidation...');

    // 1. Load existing memory stores
    const stores = MemoryStore.loadAll(this.config.memoryDir);
    const existingContent = this.readAllMemories(stores);
    const memoriesRead = this.countDocuments(stores);
    console.log(`  [dream] Read ${memoriesRead} memory document(s) from ${stores.size} store(s)`);

    // 2. Load session transcripts
    const transcripts = SessionTraceRecorder.loadTranscripts(
      this.config.tracesDir,
      this.config.maxTranscripts,
    );
    console.log(`  [dream] Loaded ${transcripts.length} session transcript(s)`);

    if (transcripts.length === 0 && memoriesRead === 0) {
      console.log('  [dream] Nothing to consolidate.');
      return {
        status: 'completed',
        transcriptsProcessed: 0,
        memoriesRead: 0,
        memoriesWritten: 0,
        insights: [],
        journalEntry: 'No transcripts or memories to consolidate.',
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Build consolidation prompt
    const prompt = this.buildConsolidationPrompt(existingContent, transcripts);

    // 4. Call LLM for synthesis
    console.log(`  [dream] Calling ${this.backend.getModel()} for consolidation...`);
    let llmOutput: string;
    try {
      const result = await this.backend.generate([
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: prompt },
      ]);
      llmOutput = result.message || '';
    } catch (err) {
      console.error(`  [dream] LLM error: ${err}`);
      return {
        status: 'failed',
        transcriptsProcessed: transcripts.length,
        memoriesRead,
        memoriesWritten: 0,
        insights: [],
        journalEntry: `Dream failed: ${err}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Parse output into documents
    const documents = this.parseConsolidationOutput(llmOutput);
    console.log(`  [dream] LLM produced ${documents.size} document(s)`);

    // 6. Write to output memory store
    const outputStore = MemoryStore.create(this.config.memoryDir, {
      name: this.config.outputStore,
      description: 'Dream-consolidated memories. Deduplicated, reorganized, and enriched from session transcripts.',
      instructions: 'This store contains consolidated knowledge from past sessions. Check here for known facts about people, places, and preferences.',
      access: 'read_write',
      created: new Date().toISOString(),
      maxSizeBytes: 102400,
    });

    let memoriesWritten = 0;
    for (const [docPath, content] of documents) {
      const result = outputStore.write(docPath, content);
      if ('ok' in result) memoriesWritten++;
    }
    console.log(`  [dream] Wrote ${memoriesWritten} document(s) to "${this.config.outputStore}"`);

    // 7. Extract insights
    const insights = this.extractInsights(llmOutput);

    // 8. Build journal entry
    const journalEntry = [
      `Dream completed at ${new Date().toISOString()}`,
      `Model: ${this.backend.getModel()}`,
      `Transcripts processed: ${transcripts.length}`,
      `Input memories: ${memoriesRead}`,
      `Output documents: ${memoriesWritten}`,
      `Insights: ${insights.length}`,
      '',
      ...insights.map((i, idx) => `${idx + 1}. ${i}`),
    ].join('\n');

    // Write journal to output store
    outputStore.write('_dream_journal.md', journalEntry);

    const durationMs = Date.now() - startTime;
    console.log(`  [dream] Consolidation complete in ${durationMs}ms`);

    return {
      status: 'completed',
      transcriptsProcessed: transcripts.length,
      memoriesRead,
      memoriesWritten,
      insights,
      journalEntry,
      durationMs,
    };
  }

  // ── Private ──────────────────────────────────────────────────

  private getSystemPrompt(): string {
    return `You are a memory consolidation engine for RoClaw, an autonomous facility patrol and safety monitoring robot.

Your task is to analyze patrol session transcripts and existing memories, then produce a clean, reorganized set of memory documents.

For each memory document you produce, output it in this exact format:
--- DOCUMENT: <path> ---
<content>
--- END DOCUMENT ---

For example:
--- DOCUMENT: staff/carlos.md ---
# Carlos
- Night shift security guard
- Usually stationed near the main corridor
- Asks robot to prioritize server room checks
--- END DOCUMENT ---

Focus on:
1. Staff profiles (names, roles, shifts, usual locations, interaction patterns)
2. Checkpoint status history (which checkpoints had anomalies, when)
3. Patrol patterns (optimal routes, areas that need more frequent checks)
4. Incident reports (what anomalies were detected, how they were resolved)
5. Facility knowledge (door states, equipment locations, layout notes)

Rules:
- Deduplicate information. If the same fact appears in multiple places, keep one.
- Resolve contradictions by preferring newer information (later timestamps).
- Organize logically — one document per topic or person.
- Keep each document focused and concise.
- Use markdown formatting.

After all documents, output a section:
--- INSIGHTS ---
- List of new insights or patterns discovered
--- END INSIGHTS ---

${this.config.instructions ?? ''}`;
  }

  private buildConsolidationPrompt(
    existingContent: string,
    transcripts: ParsedTranscript[],
  ): string {
    const parts: string[] = [];

    if (existingContent) {
      parts.push('## Existing Memories\n\n' + existingContent);
    }

    if (transcripts.length > 0) {
      parts.push(`## Session Transcripts (${transcripts.length} sessions)\n`);
      for (const t of transcripts) {
        parts.push(
          `### Session: ${t.meta.task} (${t.meta.outcome}, ${t.meta.timestamp})\n` +
          `Skills: ${t.meta.skillsLoaded.join(', ') || 'none'}\n` +
          `Turns: ${t.meta.turns}, Duration: ${t.meta.durationMs}ms\n\n` +
          t.summary,
        );
      }
    }

    return parts.join('\n\n---\n\n');
  }

  private parseConsolidationOutput(output: string): Map<string, string> {
    const documents = new Map<string, string>();
    const docRegex = /--- DOCUMENT:\s*(.+?)\s*---\n([\s\S]*?)--- END DOCUMENT ---/g;
    let match;
    while ((match = docRegex.exec(output)) !== null) {
      const docPath = match[1].trim();
      const content = match[2].trim();
      documents.set(docPath, content);
    }
    return documents;
  }

  private extractInsights(output: string): string[] {
    const insightsMatch = output.match(/--- INSIGHTS ---\n([\s\S]*?)--- END INSIGHTS ---/);
    if (!insightsMatch) return [];
    return insightsMatch[1]
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  private readAllMemories(stores: Map<string, MemoryStore>): string {
    const sections: string[] = [];
    for (const [name, store] of stores) {
      const docs = store.list();
      for (const doc of docs) {
        const content = store.read(doc.path);
        if (content) {
          sections.push(`### Store: ${name} / ${doc.path}\n${content.content}`);
        }
      }
    }
    return sections.join('\n\n');
  }

  private countDocuments(stores: Map<string, MemoryStore>): number {
    let count = 0;
    for (const [, store] of stores) {
      count += store.list().length;
    }
    return count;
  }
}
