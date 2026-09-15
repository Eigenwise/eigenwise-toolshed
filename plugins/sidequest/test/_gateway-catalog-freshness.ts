import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SIDEQUEST_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-gateway-catalog-home-'));
