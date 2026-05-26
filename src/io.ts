// src/io.ts
// Pluggable I/O adapters for speak/listen.
// Adapted from skillos_robot/src/orchestrator/io.ts.

import { execFile } from 'child_process';
import * as readline from 'readline';

// ── Interface ───────────────────────────────────────────────────

export interface IOAdapter {
  speak(text: string): Promise<void>;
  listen(timeoutMs?: number): Promise<string>;
  destroy(): void;
}

// ── ConsoleIOAdapter ────────────────────────────────────────────

export class ConsoleIOAdapter implements IOAdapter {
  private rl: readline.Interface | null = null;

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async speak(text: string): Promise<void> {
    console.log(`\n  Robot: ${text}\n`);
  }

  async listen(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = this.getRL();
      const timer = setTimeout(() => {
        resolve('[silence]');
      }, timeoutMs);

      rl.question('  You: ', (answer) => {
        clearTimeout(timer);
        resolve(answer.trim() || '[silence]');
      });
    });
  }

  destroy(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── MacOSSayAdapter ─────────────────────────────────────────────

export class MacOSSayAdapter implements IOAdapter {
  private rl: readline.Interface | null = null;
  private voice: string;

  constructor(voice = 'Samantha') {
    this.voice = voice;
  }

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async speak(text: string): Promise<void> {
    console.log(`\n  Robot: ${text}\n`);
    return new Promise<void>((resolve) => {
      execFile('say', ['-v', this.voice, text], () => {
        resolve();
      });
    });
  }

  async listen(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve) => {
      const rl = this.getRL();
      const timer = setTimeout(() => {
        resolve('[silence]');
      }, timeoutMs);

      rl.question('  You: ', (answer) => {
        clearTimeout(timer);
        resolve(answer.trim() || '[silence]');
      });
    });
  }

  destroy(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── StubIOAdapter ───────────────────────────────────────────────

export class StubIOAdapter implements IOAdapter {
  private responses: string[];
  private index = 0;
  private spoken: string[] = [];

  constructor(responses?: string[]) {
    this.responses = responses ?? [
      'All clear here. Can you check the server room next? I heard a noise earlier.',
      'The emergency exit should be secured. Make sure it is closed.',
      'Everything looks good. Log this patrol and continue.',
      'End patrol. Return to the main entrance.',
    ];
  }

  async speak(text: string): Promise<void> {
    this.spoken.push(text);
    console.log(`  [stub-speak] ${text}`);
  }

  async listen(_timeoutMs?: number): Promise<string> {
    const response = this.responses[this.index % this.responses.length];
    this.index++;
    console.log(`  [stub-listen] -> "${response}"`);
    return response;
  }

  getSpoken(): string[] {
    return [...this.spoken];
  }

  destroy(): void {}
}

// ── DemoStubIOAdapter ───────────────────────────────────────────

export class DemoStubIOAdapter implements IOAdapter {
  private runNumber = 1;
  private index = 0;
  private spoken: string[] = [];

  private run1Responses = [
    'Hey. The server room felt warm today — the AC might need checking. Also the emergency exit was propped open earlier.',
    'Everything looks fine from here. But I noticed some boxes blocking the supply closet door yesterday.',
    '[silence]',
    '[silence]',
  ];

  private run2Responses = [
    'Good to see you checking the server room first this time. Temperature seems normal today.',
    'The supply closet boxes were cleared yesterday. All good here.',
    '[silence]',
    '[silence]',
  ];

  setRunNumber(n: number): void {
    this.runNumber = n;
    this.index = 0;
    this.spoken = [];
  }

  async speak(text: string): Promise<void> {
    this.spoken.push(text);
    console.log(`  [demo-speak] ${text}`);
  }

  async listen(_timeoutMs?: number): Promise<string> {
    const responses = this.runNumber <= 1 ? this.run1Responses : this.run2Responses;
    const response = responses[this.index % responses.length];
    this.index++;
    console.log(`  [demo-listen] -> "${response}"`);
    return response;
  }

  getSpoken(): string[] {
    return [...this.spoken];
  }

  destroy(): void {}
}

// ── Factory ─────────────────────────────────────────────────────

export type IOAdapterType = 'console' | 'macos' | 'stub' | 'demo';

export function createIOAdapter(type: IOAdapterType): IOAdapter {
  switch (type) {
    case 'console': return new ConsoleIOAdapter();
    case 'macos':   return new MacOSSayAdapter();
    case 'stub':    return new StubIOAdapter();
    case 'demo':    return new DemoStubIOAdapter();
    default:        return new ConsoleIOAdapter();
  }
}
