// Runs each spec file in its own Jest process, one at a time, and prints a per-spec summary.
//
//   node scripts/run-specs.mjs unit       specs that need no sidecar
//   node scripts/run-specs.mjs emulator   every spec against the in-process sidecar emulator
//   node scripts/run-specs.mjs real       every spec under `dapr run` with tests/components (needs the Dapr CLI and Redis)
//
// Extra arguments filter spec names, e.g. `node scripts/run-specs.mjs emulator pubsub`.
// Fails if any spec fails, or if any single test takes longer than MAX_TEST_MS.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEST_MS = 60_000;

// Specs that never start a sidecar (no SidecarContext).
const UNIT_SPECS = ['compression', 'dapr-module', 'state-codec', 'stateful-actor-compression', 'workflow-endpoint'];
// Specs the emulator can't run (workflows need the sidecar's gRPC API).
const EMULATOR_SKIP = ['dapr-workflow'];

const DAPR_RUN_ARGS = [
  'run',
  '--app-id', 'testing',
  '--app-protocol', 'http',
  '--app-port', '3001',
  '--dapr-http-port', '3500',
  '--dapr-grpc-port', '3501',
  '--resources-path', './tests/components',
  '--',
];

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...filters] = process.argv.slice(2);
if (!['unit', 'emulator', 'real'].includes(mode)) {
  console.error('Usage: node scripts/run-specs.mjs <unit|emulator|real> [name filter...]');
  process.exit(2);
}

let specs = readdirSync(join(packageDir, 'tests'))
  .filter((file) => file.endsWith('.spec.ts'))
  .map((file) => basename(file, '.spec.ts'))
  .sort();
if (mode === 'unit') specs = specs.filter((name) => UNIT_SPECS.includes(name));
if (mode === 'emulator') specs = specs.filter((name) => !EMULATOR_SKIP.includes(name));
if (filters.length) specs = specs.filter((name) => filters.some((filter) => name.includes(filter)));

const resultsDir = mkdtempSync(join(tmpdir(), 'nest-dapr-specs-'));
const env = { ...process.env, DAPR_TEST_MODE: mode === 'real' ? 'real' : 'emulator' };
const rows = [];

for (const name of specs) {
  const resultsFile = join(resultsDir, `${name}.json`);
  const jestArgs = ['exec', 'jest', '--runInBand', '--json', `--outputFile=${resultsFile}`, `tests/${name}.spec.ts`];
  const [command, args] = mode === 'real' ? ['dapr', [...DAPR_RUN_ARGS, 'pnpm', ...jestArgs]] : ['pnpm', jestArgs];

  process.stdout.write(`▶ ${name} ... `);
  const started = Date.now();
  // shell: true so Windows resolves the pnpm/dapr shims; the output is kept quiet unless the spec fails.
  const run = spawnSync(command, args, { cwd: packageDir, env, shell: true, encoding: 'utf8' });
  const wallMs = Date.now() - started;

  let report;
  try {
    report = JSON.parse(readFileSync(resultsFile, 'utf8'));
  } catch {
    report = undefined;
  }
  const tests = report?.testResults?.flatMap((file) => file.assertionResults) ?? [];
  const slowest = tests.reduce((max, test) => Math.max(max, test.duration ?? 0), 0);
  const tooSlow = tests.filter((test) => (test.duration ?? 0) > MAX_TEST_MS);
  const ok = report?.success === true && tooSlow.length === 0;

  rows.push({
    name,
    ok,
    passed: report?.numPassedTests ?? 0,
    failed: report?.numFailedTests ?? 0,
    skipped: (report?.numPendingTests ?? 0) + (report?.numTodoTests ?? 0),
    slowest,
    wallMs,
  });
  console.log(ok ? 'ok' : 'FAILED');
  if (!ok) {
    for (const test of tooSlow) console.log(`  over ${MAX_TEST_MS / 1000}s: ${test.fullName} (${test.duration}ms)`);
    if (!report) console.log((run.stdout ?? '') + (run.stderr ?? ''));
    else for (const test of tests.filter((t) => t.status === 'failed')) console.log(`  ✕ ${test.fullName}\n${test.failureMessages.join('\n')}`);
  }
}

rmSync(resultsDir, { recursive: true, force: true });

console.log(`\n${mode} specs (one process per spec):`);
console.table(
  rows.map((row) => ({
    spec: row.name,
    result: row.ok ? 'ok' : 'FAILED',
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    'slowest test (ms)': row.slowest,
    'wall (s)': (row.wallMs / 1000).toFixed(1),
  })),
);

if (mode === 'real') {
  // Reminders are durable; anything left here will keep firing into later runs.
  const scheduler = spawnSync('dapr', ['scheduler', 'list'], { shell: true, encoding: 'utf8' });
  // The CLI prints "No jobs found" on stderr and the job table on stdout.
  const jobs = `${scheduler.stdout ?? ''}${scheduler.stderr ?? ''}`.trim();
  console.log(jobs.startsWith('No jobs') ? 'Dapr scheduler: no jobs left behind' : `Dapr scheduler still has jobs:\n${jobs}`);
}

const failed = rows.filter((row) => !row.ok);
if (!rows.length) {
  console.error('No specs matched.');
  process.exit(1);
}
process.exit(failed.length ? 1 : 0);
