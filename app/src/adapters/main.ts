import { readFileSync } from 'node:fs';
import { open } from '../store/db.ts';
import { type Descriptor, runImport } from './import.ts';

/**
 * Import a workload described by a JSON descriptor.
 *
 *   AOA_DB=./aoa.db node src/adapters/main.ts descriptor.json
 *
 * Writes only to the store. It opens no file in the workload for writing.
 */
const descPath = process.argv[2];
if (!descPath) {
  process.stderr.write('usage: main.ts <descriptor.json>\n');
  process.exit(2);
}
const desc = JSON.parse(readFileSync(descPath, 'utf8')) as Descriptor;
const db = open(process.env['AOA_DB'] ?? './aoa.db');
const report = runImport(db, desc);
db.close();

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.missing.length > 0) {
  process.stdout.write(`\nnot found in the workload: ${report.missing.join(', ')}\n`);
}
process.stdout.write('\nnothing was written to the workload.\n');
