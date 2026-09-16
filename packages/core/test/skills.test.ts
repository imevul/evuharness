import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composePrompt,
  createFilesystemSkillCatalog,
  createHarness,
  formatSkillInjection,
  ModeRegistry,
  parseSkillMarkdown,
  STOCK_MODES,
  skillMenuSource,
  skillsMenu,
  staticSkillCatalog,
} from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

const SAMPLE = `---
name: review
description: Review the current changes carefully.
---

Check diffs before approving.
`;

describe('parseSkillMarkdown', () => {
  it('reads frontmatter name, description, and body', () => {
    const skill = parseSkillMarkdown(SAMPLE, { id: 'review' });
    expect(skill).toEqual({
      id: 'review',
      name: 'review',
      description: 'Review the current changes carefully.',
      body: 'Check diffs before approving.',
    });
  });

  it('falls back to the directory id when name is omitted', () => {
    const skill = parseSkillMarkdown('Body only.\n', { id: 'plain' });
    expect(skill.name).toBe('plain');
    expect(skill.description).toBe('plain');
    expect(skill.body).toBe('Body only.');
  });
});

describe('static and filesystem catalogs', () => {
  it('lists and resolves by id or name', async () => {
    const catalog = staticSkillCatalog([
      parseSkillMarkdown(SAMPLE, { id: 'review' }),
      { id: 'explain', name: 'Explain', description: 'Explain code', body: 'Be clear.' },
    ]);

    expect(await catalog.list()).toHaveLength(2);
    expect((await catalog.get('review'))?.body).toContain('Check diffs');
    expect((await catalog.get('Explain'))?.id).toBe('explain');
    expect(await catalog.get('missing')).toBeNull();
  });

  it('loads SKILL.md files from configured roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evu-skills-'));
    await mkdir(join(root, 'doctor'));
    await writeFile(join(root, 'doctor', 'SKILL.md'), SAMPLE.replace('review', 'doctor'), 'utf8');

    const catalog = createFilesystemSkillCatalog({ roots: [root] });
    const listed = await catalog.list();
    expect(listed).toEqual([expect.objectContaining({ id: 'doctor', name: 'doctor' })]);
    expect((await catalog.get('doctor'))?.body).toContain('Check diffs');
  });

  it('rejects a symlink that escapes the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evu-skills-'));
    const outside = await mkdtemp(join(tmpdir(), 'evu-outside-'));
    await writeFile(join(outside, 'secret.md'), SAMPLE, 'utf8');
    await mkdir(join(root, 'escape'));
    await symlink(join(outside, 'secret.md'), join(root, 'escape', 'SKILL.md'));

    const catalog = createFilesystemSkillCatalog({ roots: [root] });
    expect(await catalog.list()).toEqual([]);
  });
});

describe('skills menu and prompt catalog', () => {
  it('exposes skills as / menu items with a prompt effect', async () => {
    const catalog = staticSkillCatalog([parseSkillMarkdown(SAMPLE, { id: 'review' })]);
    const menu = skillsMenu({ catalog });
    expect(menu.trigger).toBe('/');
    expect(menu.effect).toBe('prompt');

    const nodes = await skillMenuSource(catalog).list({ query: '', path: [], scope: {} });
    expect(nodes).toEqual([
      expect.objectContaining({ kind: 'item', id: 'review', label: 'review' }),
    ]);

    const resolution = await menu.resolve!({
      ref: { menu: 'commands', path: [], id: 'review', token: '/review' },
      scope: {},
      mode: 'ask',
      sessionId: 's1',
      text: '/review please',
    });
    expect(resolution).toEqual({
      effect: 'prompt',
      text: formatSkillInjection(parseSkillMarkdown(SAMPLE, { id: 'review' })),
    });
  });

  it('includes the skills catalog in composePrompt', async () => {
    const preview = await composePrompt({
      mode: 'ask',
      modes: new ModeRegistry(STOCK_MODES),
      prompts: { global: 'base' },
      skills: [{ id: 'review', name: 'review', description: 'Review changes' }],
    });
    expect(preview.text).toContain('Available skills');
    expect(preview.text).toContain('review: Review changes');
  });

  it('lists skills from the harness', async () => {
    const catalog = staticSkillCatalog([parseSkillMarkdown(SAMPLE, { id: 'review' })]);
    const harness = createHarness({ skills: catalog });
    expect(await harness.listSkills()).toEqual([
      { id: 'review', name: 'review', description: 'Review the current changes carefully.' },
    ]);
    expect(
      (await harness.toolCatalog('ask')).tools.some((tool) => tool.name === 'load_skill'),
    ).toBe(true);
  });
});
