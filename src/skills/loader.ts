/**
 * Skill 加载器：发现 + frontmatter 解析。
 *
 * 扫描两个位置（项目级覆盖用户级同名 skill）：
 *   ~/.agent/skills/<name>/SKILL.md
 *   <cwd>/.agent/skills/<name>/SKILL.md
 *
 * SKILL.md 格式：
 *   ---
 *   name: my-skill
 *   description: 一句话描述（决定模型何时加载它）
 *   ---
 *   正文（模型调用 use_skill 后才读入）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 全文（含 frontmatter 之外的部分） */
  body: string;
  path: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

/** 极简 YAML frontmatter 解析（只支持 key: value 平铺，够用即可） */
export function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) (meta as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

function scanDir(dir: string): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(skillFile, 'utf-8'));
    skills.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? '(no description)',
      body,
      path: skillFile,
    });
  }
  return skills;
}

export class SkillLoader {
  private skills = new Map<string, Skill>();

  constructor(readonly cwd: string) {}

  load(): void {
    // 先用户级，后项目级（项目级覆盖同名）
    for (const skill of scanDir(join(homedir(), '.agent', 'skills'))) {
      this.skills.set(skill.name, skill);
    }
    for (const skill of scanDir(join(this.cwd, '.agent', 'skills'))) {
      this.skills.set(skill.name, skill);
    }
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}
