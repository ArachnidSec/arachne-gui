import fs from 'node:fs';
import path from 'node:path';

/**
 * Skills: markdown files with frontmatter, loaded per turn.
 *
 * This is the single strongest pattern in the tools I looked at. A harness can
 * only ship so much prompt; skills let an operator add domain knowledge
 * without touching code, and let the harness load only what the current task
 * needs. Small models in particular do better with two focused skills than
 * with one gigantic system prompt.
 */

const parseFrontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text.trim() };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length).trim() };
};

export function loadSkills(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
    const id = entry.name.replace(/\.md$/, '');
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    skills.push({
      id,
      name: data.name || id,
      description: data.description || '',
      agents: (data.agents || '').split(',').map((s) => s.trim()).filter(Boolean),
      tags: (data.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      body,
      chars: body.length,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which skills apply to this agent by default (frontmatter `agents:`). */
export function skillsFor(skills, agentId) {
  return skills.filter((s) => !s.agents.length || s.agents.includes(agentId));
}

/** Cap by characters, not count — three short skills beat one long one. */
export function selectSkills(skills, ids = [], { budget = 9000 } = {}) {
  const chosen = [];
  let used = 0;
  for (const id of ids) {
    const skill = skills.find((s) => s.id === id);
    if (!skill) continue;
    if (used + skill.chars > budget && chosen.length) continue;
    chosen.push(skill);
    used += skill.chars;
  }
  return chosen;
}

export function skillBlock(skills) {
  if (!skills.length) return '';
  const parts = skills.map(
    (s) => `### ${s.name}\n${s.description ? `${s.description}\n` : ''}${s.body}`,
  );
  return `\n\nACTIVE SKILLS — follow these procedures over your general habits.\n\n${parts.join('\n\n')}`;
}

/** Compact catalog for the UI and for the model's awareness of what exists. */
export function publicSkills(skills) {
  return skills.map(({ id, name, description, agents, tags }) => ({ id, name, description, agents, tags }));
}
