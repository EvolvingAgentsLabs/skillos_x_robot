// src/skills.ts
// SKILL.md parser and system prompt builder.
// Skills follow the google-ai-edge/gallery format: YAML frontmatter + markdown instructions.

import * as fs from 'fs';
import * as path from 'path';
import type { Skill, SkillMeta } from './types';

// ── Parser ─────────────────────────────────────────────────────

/**
 * Parse a SKILL.md file into a Skill object.
 * Expected format:
 *   ---
 *   name: skill-name
 *   description: What this skill does
 *   ---
 *   Markdown instructions...
 */
export function parseSkillFile(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!fmMatch) {
    throw new Error(`Invalid SKILL.md format (no frontmatter): ${filePath}`);
  }

  const frontmatter = fmMatch[1];
  const instructions = fmMatch[2].trim();

  const meta: SkillMeta = { name: '', description: '' };
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'name') meta.name = value;
    if (key === 'description') meta.description = value;
  }

  if (!meta.name) {
    meta.name = path.basename(filePath, '.skill.md');
  }

  return { meta, instructions, filePath };
}

// ── Loader ─────────────────────────────────────────────────────

/**
 * Load all *.skill.md files from a directory.
 */
export function loadSkills(dir: string): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.skill.md'));
  return files.map(f => parseSkillFile(path.join(dir, f)));
}

// ── System prompt builder (full — legacy) ─────────────────────

/**
 * Build the skills section for the system prompt (full body, legacy).
 */
export function buildSkillInstructions(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const sections = skills.map(s => {
    return `### Skill: ${s.meta.name}\n${s.meta.description}\n\n${s.instructions}`;
  });

  return `\n## Available Skills\n\n${sections.join('\n\n---\n\n')}`;
}

// ── Progressive disclosure (Level 1 — metadata only) ──────────

/**
 * Build the skill metadata section for the system prompt (Level 1).
 * Only includes name + description (~100 tokens per skill).
 * Agent uses load_skill tool to get full instructions (Level 2).
 */
export function buildSkillMetadataPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const rows = skills.map(s =>
    `| ${s.meta.name} | ${s.meta.description} |`
  );

  return `\n## Available Skills

You have access to the following skills. When a task matches a skill, call \`load_skill(name)\` to get detailed instructions before proceeding.

| Skill | Description |
|-------|-------------|
${rows.join('\n')}`;
}

// ── Progressive disclosure (Level 2 — on-demand body) ─────────

/**
 * Load the full instructions body for a named skill.
 * Called by the load_skill tool dispatcher.
 */
export function loadSkillBody(skills: Skill[], name: string): string | null {
  const skill = skills.find(s => s.meta.name === name);
  if (!skill) return null;
  return skill.instructions;
}
