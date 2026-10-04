/**
 * Skill 加载器测试。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, SkillLoader } from '../src/skills/loader.js';

describe('parseFrontmatter', () => {
  it('解析 name 与 description', () => {
    const { meta, body } = parseFrontmatter('---\nname: foo\ndescription: bar baz\n---\n\n# Body\ncontent');
    expect(meta).toEqual({ name: 'foo', description: 'bar baz' });
    expect(body).toContain('# Body');
  });

  it('无 frontmatter 时原样返回', () => {
    const { meta, body } = parseFrontmatter('# Just text');
    expect(meta).toEqual({});
    expect(body).toBe('# Just text');
  });
});

describe('SkillLoader', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'agentlab-skill-'));
    await mkdir(join(tmp, '.agent', 'skills', 'deploy'), { recursive: true });
    await writeFile(
      join(tmp, '.agent', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 部署应用\n---\n\n步骤：1. build 2. upload',
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('发现项目级 skill 并解析', () => {
    const loader = new SkillLoader(tmp);
    loader.load();
    const skill = loader.get('deploy');
    expect(skill?.description).toBe('部署应用');
    expect(skill?.body).toContain('步骤');
  });
});
