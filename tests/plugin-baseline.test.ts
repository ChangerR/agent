import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { capturePluginBaseline } from '../scripts/capture-plugin-baseline.js';
it('默认 legacy 执行与 ec341e63 真实离线基线的事件、历史、审批次数一致', async () => {
  const baseline = JSON.parse(await readFile(resolve('tests/fixtures/plugin-baseline-ec341e63.json'), 'utf8'));
  expect(await capturePluginBaseline(process.cwd())).toEqual(baseline);
});
