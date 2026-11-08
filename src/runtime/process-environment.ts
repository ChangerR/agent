/** 普通子进程默认最小环境；凭据只可经宿主显式列名传递。 */
const baseNames = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
];
export function processEnvironment(
  inherit: readonly string[] = [],
  source = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...baseNames, ...inherit])
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}
