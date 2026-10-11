// Refresh the compatibility snapshot from a compiled engine with input metadata.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the compiled engine index.js path');
const engine = createRequire(import.meta.url)(resolve(modulePath));
const operations = engine.getDocxCapabilities().formats.find(format => format.format === 'docx')?.operations;
if (!operations?.length || operations.some(operation => !operation.inputSchema)) {
  throw new Error('The selected engine must supply input schemas');
}
const snapshot = operations.map(operation => ({
  ...operation,
  inputSchema: JSON.parse(operation.inputSchema),
}));
writeFileSync(new URL('../src/legacy-docx-inputs.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
