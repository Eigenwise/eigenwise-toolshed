import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const tempRoot = path.resolve(os.tmpdir());
const created = new Set<string>();

function trackCandidate(candidate: unknown) {
  if (typeof candidate !== 'string') return;
  const resolved = path.resolve(candidate);
  const relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const first = relative.split(path.sep)[0];
  if (first && first.startsWith('sq-')) created.add(path.join(tempRoot, first));
}

const originalMkdtempSync = fs.mkdtempSync.bind(fs);
const originalMkdirSync = fs.mkdirSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalSymlinkSync = fs.symlinkSync.bind(fs);

(fs as any).mkdtempSync = (...args: any[]) => {
  const directory = (originalMkdtempSync as (...args: any[]) => string)(...args);
  trackCandidate(directory);
  return directory;
};
(fs as any).mkdirSync = (...args: any[]) => {
  const result = (originalMkdirSync as (...args: any[]) => unknown)(...args);
  trackCandidate(args[0]);
  return result;
};
(fs as any).writeFileSync = (...args: any[]) => {
  const result = (originalWriteFileSync as (...args: any[]) => unknown)(...args);
  trackCandidate(args[0]);
  return result;
};
(fs as any).symlinkSync = (...args: any[]) => {
  const result = (originalSymlinkSync as (...args: any[]) => unknown)(...args);
  trackCandidate(args[1]);
  return result;
};

function removeCreatedDirectories() {
  const failures: string[] = [];
  for (const directory of [...created].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error: any) {
      failures.push(`${directory}: ${error?.message || error}`);
    }
  }
  created.clear();
  if (failures.length) {
    const paths = failures.map((failure) => failure.slice(0, failure.indexOf(': ')));
    const script = `const fs=require('node:fs');const paths=${JSON.stringify(paths)};let attempts=0;const retry=()=>{for(const p of paths){try{fs.rmSync(p,{recursive:true,force:true})}catch{}}if(++attempts<30)setTimeout(retry,250)};setTimeout(retry,500);`;
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

after(removeCreatedDirectories);
process.once('exit', () => {
  try {
    removeCreatedDirectories();
  } catch (error: any) {
    process.stderr.write(`${error?.message || error}\n`);
  }
});
