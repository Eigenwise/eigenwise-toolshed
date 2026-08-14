import os from 'node:os';
import path from 'node:path';

export const planningDepthWarningsFixtureParent = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures');

export function isPlanningDepthWarningsFixturePath(projectPath: string): boolean {
  const relativePath = path.relative(planningDepthWarningsFixtureParent, path.resolve(projectPath));
  return Boolean(relativePath) && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}
