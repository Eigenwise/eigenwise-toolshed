import { randomUUID } from 'node:crypto';
import { link, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const [mode, lockDirectory, ownerToken, behavior] = process.argv.slice(2);
if (mode === undefined || lockDirectory === undefined) {
  throw new Error('crash reclaim fixture requires a mode and lock directory');
}

const token = randomUUID();
const server = createServer((socket) => {
  if (behavior === 'silent') return;
  socket.end(behavior === 'wrong' ? randomUUID() : token);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('crash reclaim fixture did not bind a TCP port');
}

if (mode === 'generated') {
  if (ownerToken === undefined) throw new Error('generated reclaim fixture requires an owner token');
  await rename(
    path.join(lockDirectory, `generation-${ownerToken}`),
    path.join(lockDirectory, `reclaim-${ownerToken}.${address.port}.${token}`),
  );
} else if (mode === 'legacy') {
  const generationToken = randomUUID();
  const preparedClaim = path.join(lockDirectory, `.legacy-reclaim-${generationToken}`);
  await writeFile(preparedClaim, JSON.stringify({ generationToken, port: address.port, token }), { flag: 'wx' });
  await link(preparedClaim, path.join(lockDirectory, 'legacy-reclaim'));
  await rm(preparedClaim, { force: true });
} else {
  throw new Error(`unsupported crash reclaim fixture mode: ${mode}`);
}

if (behavior === 'hold' || behavior === 'silent' || behavior === 'wrong') {
  process.stdout.write('claimed\n');
  await new Promise(() => undefined);
}

process.exit(0);
