/** 模型证据用无损路径索引消除重复；执行门仍持有完整 analysis/metadata，批准绑定不变。 */
import { createHash } from 'node:crypto';
import type { ToolAnalysis } from '../../sdk/capabilities.js';
import type { ShellPathFact } from '../../tools/shell-readonly.js';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function shellReviewEvidence(analysis: ToolAnalysis | undefined, cwd?: string): unknown {
  if (
    !analysis ||
    analysis.analyzerId !== 'deterministic-operations' ||
    !analysis.evidence?.some(({ source }) => source === 'controlled-shell-contract')
  )
    return analysis ?? null;
  const paths: string[] = [];
  const indices = new Map<string, number>();
  const pathIndex = (path: string) => {
    let index = indices.get(path);
    if (index === undefined) {
      index = paths.length;
      paths.push(path);
      indices.set(path, index);
    }
    return index;
  };
  // 同类事实只存一次：仍逐项保留路径及顺序，不摘要、不截断风险。
  const profiles = <T>() => {
    const values: T[] = [];
    const indices = new Map<string, number>();
    return {
      values,
      index(value: T) {
        const key = JSON.stringify(value);
        let index = indices.get(key);
        if (index === undefined) {
          index = values.length;
          values.push(value);
          indices.set(key, index);
        }
        return index;
      },
    };
  };
  const effectProfiles = profiles<[string, string | null]>();
  const effects = analysis.effects.map(({ kind, target, scope }) => [
    effectProfiles.index([kind, scope ?? null]),
    target === undefined ? null : pathIndex(target),
  ]);
  const targets = analysis.targets?.map(pathIndex);
  const boundaries = analysis.evidence?.find(({ source }) => source === 'shell-path-boundaries');
  if (!boundaries) return analysis;
  const pathFactProfiles = profiles<[boolean, string, boolean, number]>();
  const pathFacts = (JSON.parse(boundaries.detail) as ShellPathFact[]).map(
    ({ raw, actual, exists, kind, symlink, nlink }) => [
      pathIndex(raw),
      pathIndex(actual),
      pathFactProfiles.index([exists, kind, symlink, nlink]),
    ],
  );
  const pathBindings: number[] = [];
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(analysis.environment ?? {})) {
    if (key.startsWith('path:')) pathBindings.push(pathIndex(key.slice(5)));
    else if (key === '$shellContract') {
      // 受控脚本及身份记录是执行器使用的内部契约，不是模型需要重新解释的用户脚本。
      facts.executionContract = {
        sha256: fingerprint(value),
        enforcedBy: 'bash-tool-revalidation; descriptor-bindings-when-present',
      };
    } else facts[key] = value;
  }
  const {
    environment: _environment,
    effects: _effects,
    targets: _targets,
    evidence: _evidence,
    ...risk
  } = analysis;
  const prefix = cwd ? `${cwd.replace(/\/+$/, '')}/` : undefined;
  return {
    ...risk,
    encoding: 'shell_path_index',
    pathPrefixes: prefix ? [prefix] : [],
    paths: paths.map((path) =>
      prefix && path.startsWith(prefix) ? [0, path.slice(prefix.length)] : path,
    ),
    pathFacts,
    pathFactProfiles: pathFactProfiles.values,
    effects,
    effectProfiles: effectProfiles.values,
    ...(targets ? { targets } : {}),
    evidence: analysis.evidence?.filter(({ source }) => source !== 'shell-path-boundaries'),
    environment: {
      sha256: fingerprint(analysis.environment ?? {}),
      entries: Object.keys(analysis.environment ?? {}).length,
      pathBindings,
      facts,
      identityMetadata: 'retained_in_executor_not_model_input',
    },
  };
}
