// Checks that need no server: index.html wiring and syntax, and that every API file loads
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const s = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };

const inline = [...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const scripts = inline.join('\n');
const html = s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

// Every inline script parses
const syntax = inline.map((c, i) => { try { new Function(c); return null; } catch (e) { return `script ${i}: ${e.message}`; } }).filter(Boolean);
ok(!syntax.length, 'inline scripts parse', syntax);

// No id used twice in the static HTML
const ids = [...html.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]);
const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
ok(!dup.length, 'no duplicate static ids', dup);

// Inline handlers only call functions that exist
const defined = new Set([
  ...[...scripts.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]),
  ...[...scripts.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/g)].map(m => m[1]),
  ...[...scripts.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
]);
const builtins = new Set(['if', 'event', 'this', 'document', 'window', 'localStorage', 'setTimeout', 'clearTimeout', 'Number', 'String', 'parseFloat', 'parseInt', 'Math', 'JSON', 'alert', 'confirm', 'console', 'return', 'encodeURIComponent', 'open', 'location', 'navigator', 'history', 'requestAnimationFrame', 'Object', 'Array', 'Date', 'toast', 'showToast', 'typeof', 'new', 'delete', 'void']);
const missing = new Set();
for (const m of s.matchAll(/\son(?:click|change|input|keydown|keyup|submit|blur|focus|mouseover|mouseout|mousedown|load)="([^"]*)"/g)) {
  for (const c of m[1].matchAll(/(?<![\w$.'"`])([A-Za-z_$][\w$]*)\s*\(/g)) if (!defined.has(c[1]) && !builtins.has(c[1])) missing.add(c[1]);
}
ok(!missing.size, 'handlers call real functions', [...missing]);

// Template text never leaks into the static page
const leaks = [...html.matchAll(/\$\{[^}]{0,40}\}/g)].map(m => m[0]);
ok(!leaks.length, 'no ${} in static HTML', leaks.slice(0, 10));

// No function declared twice (the later one would silently win)
const fnames = [...scripts.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
const fdup = [...new Set(fnames.filter((x, i) => fnames.indexOf(x) !== i))];
ok(!fdup.length, 'no duplicate function names', fdup);

// Every API file loads (a syntax error here would break that endpoint on Vercel)
for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
  try { await import(pathToFileURL(path.join(root, 'api', f)).href); pass++; }
  catch (e) { failN++; console.log('FAIL', `api/${f} loads`, e.message); }
}
// Vercel's Hobby plan allows 12 functions (files in api/ not starting with "_")
const endpoints = fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
ok(endpoints.length <= 12, `at most 12 serverless functions (have ${endpoints.length})`, endpoints);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
