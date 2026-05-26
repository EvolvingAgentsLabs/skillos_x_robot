// src/memory.ts
// Persistent memory stores — Anthropic-equivalent memory system.
// Each store is a directory of markdown documents with version history.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MemoryManifest } from './types';

// ── MemoryStore ────────────────────────────────────────────────

export class MemoryStore {
  readonly name: string;
  private storeDir: string;
  private manifest: MemoryManifest;

  constructor(storeDir: string, manifest: MemoryManifest) {
    this.storeDir = storeDir;
    this.manifest = manifest;
    this.name = manifest.name;
  }

  getManifest(): MemoryManifest {
    return { ...this.manifest };
  }

  read(docPath: string): { content: string; sha256: string; version: number } | null {
    const fullPath = path.join(this.storeDir, docPath);
    if (!fs.existsSync(fullPath)) return null;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const sha256 = computeSha256(content);
    const version = this.getCurrentVersion(docPath);
    return { content, sha256, version };
  }

  write(
    docPath: string,
    content: string,
    preconditionSha256?: string,
  ): { ok: true; version: number; sha256: string } | { error: string } {
    if (this.manifest.access === 'read_only') {
      return { error: `Store "${this.name}" is read-only` };
    }

    const fullPath = path.join(this.storeDir, docPath);

    // Check precondition
    if (preconditionSha256) {
      if (fs.existsSync(fullPath)) {
        const current = fs.readFileSync(fullPath, 'utf-8');
        const currentSha = computeSha256(current);
        if (currentSha !== preconditionSha256) {
          return { error: `SHA256 mismatch: expected ${preconditionSha256}, got ${currentSha}` };
        }
      } else if (preconditionSha256 !== '') {
        return { error: `Document does not exist but precondition SHA256 was provided` };
      }
    }

    // Ensure parent directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create version backup if document already exists
    let version = 1;
    if (fs.existsSync(fullPath)) {
      version = this.getCurrentVersion(docPath) + 1;
      const existing = fs.readFileSync(fullPath, 'utf-8');
      fs.writeFileSync(`${fullPath}.v${version - 1}`, existing, 'utf-8');
    }

    // Write new content
    fs.writeFileSync(fullPath, content, 'utf-8');
    const sha256 = computeSha256(content);

    return { ok: true, version, sha256 };
  }

  list(): Array<{ path: string; sizeBytes: number; lastModified: string }> {
    const results: Array<{ path: string; sizeBytes: number; lastModified: string }> = [];
    this.walkDir(this.storeDir, '', results);
    return results;
  }

  delete(docPath: string): { ok: true } | { error: string } {
    if (this.manifest.access === 'read_only') {
      return { error: `Store "${this.name}" is read-only` };
    }
    const fullPath = path.join(this.storeDir, docPath);
    if (!fs.existsSync(fullPath)) {
      return { error: `Document not found: ${docPath}` };
    }
    fs.unlinkSync(fullPath);
    return { ok: true };
  }

  // ── Private ──────────────────────────────────────────────────

  private getCurrentVersion(docPath: string): number {
    let v = 0;
    const fullPath = path.join(this.storeDir, docPath);
    while (fs.existsSync(`${fullPath}.v${v + 1}`)) {
      v++;
    }
    return v + 1; // current is v+1
  }

  private walkDir(
    dir: string,
    prefix: string,
    results: Array<{ path: string; sizeBytes: number; lastModified: string }>,
  ): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      // Skip version files
      if (/\.v\d+$/.test(entry.name)) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this.walkDir(full, rel, results);
      } else {
        const stat = fs.statSync(full);
        results.push({
          path: rel,
          sizeBytes: stat.size,
          lastModified: stat.mtime.toISOString(),
        });
      }
    }
  }

  // ── Static factories ─────────────────────────────────────────

  static loadAll(baseDir: string): Map<string, MemoryStore> {
    const stores = new Map<string, MemoryStore>();
    if (!fs.existsSync(baseDir)) return stores;

    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const storeDir = path.join(baseDir, entry.name);
      const manifestPath = path.join(storeDir, '_manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      const manifest: MemoryManifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      );
      stores.set(manifest.name, new MemoryStore(storeDir, manifest));
    }
    return stores;
  }

  static create(baseDir: string, manifest: MemoryManifest): MemoryStore {
    const storeDir = path.join(baseDir, manifest.name);
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(storeDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
    return new MemoryStore(storeDir, manifest);
  }
}

// ── System prompt builder ──────────────────────────────────────

export function buildMemoryPrompt(stores: Map<string, MemoryStore>): string {
  if (stores.size === 0) return '';

  const rows: string[] = [];
  const instructions: string[] = [];

  for (const [, store] of stores) {
    const m = store.getManifest();
    rows.push(`| ${m.name} | ${m.access} | ${m.description} |`);
    if (m.instructions) {
      instructions.push(`- **${m.name}**: ${m.instructions}`);
    }
  }

  let section = `\n## Memory Stores

You have persistent memory that survives between sessions. Use the memory tools to read and write information.

| Store | Access | Description |
|-------|--------|-------------|
${rows.join('\n')}`;

  if (instructions.length > 0) {
    section += `\n\n### Memory Instructions\n${instructions.join('\n')}`;
  }

  section += `\n\nAvailable memory tools: read_memory, write_memory, list_memories, delete_memory.
- Check memory at the start of a task to recall prior interactions.
- Write important information (names, preferences, outcomes) to memory for future sessions.`;

  return section;
}

// ── Helpers ────────────────────────────────────────────────────

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}
