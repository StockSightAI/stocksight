// npm test: the static checks, then each API suite against its own fresh fake backend
// (tests/fake-backend.mjs), so suites never see each other's data and production is never touched.
// The API suites need internet for Yahoo Finance and CNN; everything else is faked locally.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const SUITES = ['auth.test.mjs', 'votes.test.mjs', 'search-digest.test.mjs'];

// Node warns that api/*.js are ES modules in a package without "type"; harmless, so keep the output clean
const quiet = { NODE_NO_WARNINGS: '1' };

const run = (file, env = {}) => new Promise(done => {
  const p = spawn(node, [path.join(dir, file)], { stdio: 'inherit', env: { ...process.env, ...quiet, ...env } });
  p.on('exit', code => done(code));
});

function startBackend(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(node, [path.join(dir, 'fake-backend.mjs')], { env: { ...process.env, ...quiet, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('fake backend did not start:\n' + out)); }, 15000);
    p.stdout.on('data', d => { out += d; if (out.includes('fake backend on')) { clearTimeout(timer); resolve(p); } });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => reject(new Error(`fake backend exited (${code}):\n${out}`)));
  });
}

const failed = [];
console.log('\n▶ static.test.mjs');
if (await run('static.test.mjs')) failed.push('static.test.mjs');

for (const [i, suite] of SUITES.entries()) {
  const port = 5600 + i;
  console.log(`\n▶ ${suite}`);
  let backend;
  try { backend = await startBackend(port); }
  catch (e) { console.log(e.message); failed.push(suite); continue; }
  const code = await run(suite, { TEST_BASE: `http://localhost:${port}` });
  backend.kill();
  if (code) failed.push(suite);
}

console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nAll test suites passed.');
process.exit(failed.length ? 1 : 0);
