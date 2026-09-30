import os from 'node:os';
import path from 'node:path';

const fixtureParentPrefix = 'sq-planning-warnings-fixtures-';

// One parent per process: test-home-isolation runs this suite nested and concurrently,
// and each process's temp cleanup removes its whole fixture parent on exit, which
// deleted the board folder the other run still needed to resolve (SQ-3179).
export const planningDepthWarningsFixtureParent = path.join(os.tmpdir(), `${fixtureParentPrefix}${process.pid}`);

export function isPlanningDepthWarningsFixturePath(projectPath: string): boolean {
  const relativePath = path.relative(os.tmpdir(), path.resolve(projectPath));
  const [parent, ...below] = relativePath.split(path.sep);
  return !path.isAbsolute(relativePath) && parent!.startsWith(fixtureParentPrefix) && below.length > 0;
}
