import childProcess from 'node:child_process';
import type { ExecFileOptions, ExecFileSyncOptions, ExecFileSyncOptionsWithBufferEncoding, ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';

// Node caps what a child may print at 1 MiB. `git ls-files` passes that near 17k tracked paths, so
// the board failed with ENOBUFS where plain git worked (GH-179, GH-216, GH-218). The cap stays, so a
// runaway command still ends, but far above any listing or patch the board reads.
export const GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;

const execFileCallback = promisify(childProcess.execFile);

export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return childProcess.execFileSync(file, args, { maxBuffer: GIT_OUTPUT_MAX_BUFFER, ...options });
}

// A git command that can run for minutes (a commit runs the repository's hooks) must not hold the
// board MCP server's only thread, or every other call on it waits too (GH-314).
export async function execFileText(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<string> {
  const { stdout } = await execFileCallback(file, args, { maxBuffer: GIT_OUTPUT_MAX_BUFFER, windowsHide: true, ...options, encoding: 'utf8' });
  return stdout;
}
