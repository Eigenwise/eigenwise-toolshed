import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function compilerFrom(directory) {
  const requireCompiler = createRequire(path.join(directory, 'package.json'));
  try {
    requireCompiler.resolve('typescript/unstable/ast');
    return requireCompiler;
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
    throw error;
  }
}

export function resolveCompiler(projectRoot) {
  const requireCompiler = compilerFrom(projectRoot) || compilerFrom(fileURLToPath(new URL('../', import.meta.url)));
  if (!requireCompiler) throw new Error(`Quality Gate needs TypeScript 7 with its unstable parser API. No supported typescript dependency was found in the scored project (${projectRoot}) or in the quality-gate plugin. Install typescript in the project or install the plugin's dependencies.`);
  return requireCompiler;
}

export async function loadCompiler(projectRoot) {
  const requireCompiler = resolveCompiler(projectRoot);
  const load = (entry) => import(pathToFileURL(requireCompiler.resolve(`typescript/unstable/${entry}`)).href);
  const [ast, { API: SyncParserApi }, { API: AsyncParserApi }, { createVirtualFileSystem }] = await Promise.all(['ast', 'sync', 'async', 'fs'].map(load));
  return { ast, SyncParserApi, AsyncParserApi, createVirtualFileSystem };
}
