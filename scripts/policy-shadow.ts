/** 离线入口：只读分析与标准输出。不会执行工具、调用模型或写配置。 */
import { resolve } from 'node:path';
import { runCuratedShadow } from '../src/builtin/policy-shadow/corpus.js';
const args = process.argv.slice(2);
let cwd = process.cwd(); let recorded = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--cwd' && args[index + 1]) cwd = resolve(args[++index]);
  else if (arg === '--recorded-reviewer-fixtures') recorded = true;
  else if (arg === '--help') { process.stdout.write('Usage: pnpm exec tsx scripts/policy-shadow.ts [--cwd path] [--recorded-reviewer-fixtures]\nNo tools, models, or config writes. Recorded fixture mode is explicit simulation.\n'); process.exit(0); }
  else throw new Error(`Unknown argument: ${arg}`);
}
const result = await runCuratedShadow(cwd, { mode: recorded ? 'recorded-reviewer-fixtures' : 'deterministic-only' });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.summary.errors > 0) process.exitCode = 1;
