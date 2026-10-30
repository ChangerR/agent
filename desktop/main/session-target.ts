import type { ProjectCatalog } from './project-catalog.js';
import type { RuntimeSnapshot } from '../shared/protocol.js';
import { newSessionSchema } from '../remote/protocol.js';
/** 先选目标再创建；选其他项目时不先恢复其旧会话。 */
export function selectSessionProject(
  catalog: ProjectCatalog,
  runtime: RuntimeSnapshot | undefined,
  input: unknown,
) {
  const id =
    input === undefined
      ? (runtime?.projectId ?? runtime?.cwd)
      : newSessionSchema.parse(input).projectId;
  if (!id) throw new Error('请先选择会话项目。');
  const project = catalog.get(id);
  if (!project) throw new Error('项目不存在，请重新选择会话项目。');
  return project;
}
