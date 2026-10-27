import fs from 'node:fs';
import path from 'node:path';

// Stands in for a coverage command: writes the planned LCOV into the isolated report directory, then
// applies any planned rewrites, which is how a test simulates files changing during the command.
const plan = JSON.parse(fs.readFileSync('coverage-plan.json', 'utf8'));
fs.writeFileSync(path.join(process.env.QUALITY_GATE_COVERAGE_DIR, 'lcov.info'), plan.lcov);
for (const [file, text] of Object.entries(plan.rewrite ?? {})) fs.writeFileSync(file, text);
