// src/dream_cli.ts
// CLI entry point for running dream consolidation offline.
// Usage: npx tsx src/dream_cli.ts [--output <store-name>] [--max-transcripts <n>] [--instructions <text>]

import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

import { DreamEngine } from './dream';
import { createBackend, type BackendType } from './backend';

async function main() {
  const args = process.argv.slice(2);

  const outputIdx = args.indexOf('--output');
  const output = outputIdx >= 0 && args[outputIdx + 1]
    ? args[outputIdx + 1]
    : 'consolidated';

  const maxIdx = args.indexOf('--max-transcripts');
  const maxTranscripts = maxIdx >= 0 && args[maxIdx + 1]
    ? parseInt(args[maxIdx + 1], 10)
    : 100;

  const instrIdx = args.indexOf('--instructions');
  const instructions = instrIdx >= 0 && args[instrIdx + 1]
    ? args[instrIdx + 1]
    : undefined;

  const memoryDir = process.env.MEMORY_DIR
    ? path.resolve(process.env.MEMORY_DIR)
    : path.resolve(__dirname, '../memory');

  const tracesDir = process.env.TRACES_DIR
    ? path.resolve(process.env.TRACES_DIR)
    : path.resolve(__dirname, '../traces');

  const backendIdx = args.indexOf('--backend');
  const backendType: BackendType = (backendIdx >= 0 && args[backendIdx + 1]
    ? args[backendIdx + 1] as BackendType
    : (process.env.AGENT_BACKEND as BackendType) || 'gemma4');

  const backend = createBackend(backendType, {
    maxTokens: 4096,
    temperature: 0.3,
  });

  console.log(`
  ┌────────────────────────────────────────────────┐
  │  skillos_x_robot — dream consolidation         │
  │  Backend: ${backendType.padEnd(36)}│
  │  Model: ${backend.getModel().padEnd(38)}│
  │  Output store: ${output.padEnd(31)}│
  │  Max transcripts: ${String(maxTranscripts).padEnd(28)}│
  └────────────────────────────────────────────────┘
  `);

  const engine = new DreamEngine(
    {
      memoryDir,
      tracesDir,
      outputStore: output,
      maxTranscripts,
      instructions,
    },
    backend,
  );

  const result = await engine.dream();

  console.log(`\n  === Dream Result ===`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Transcripts processed: ${result.transcriptsProcessed}`);
  console.log(`  Memories read: ${result.memoriesRead}`);
  console.log(`  Memories written: ${result.memoriesWritten}`);
  console.log(`  Duration: ${result.durationMs}ms`);

  if (result.insights.length > 0) {
    console.log(`\n  Insights:`);
    for (const insight of result.insights) {
      console.log(`    - ${insight}`);
    }
  }

  console.log(`\n  Journal:\n${result.journalEntry.split('\n').map(l => '    ' + l).join('\n')}`);
}

main().catch(console.error);
