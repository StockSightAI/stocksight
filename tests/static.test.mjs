// Checks that need no server: index.html wiring and syntax, and that every API file loads
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const s = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let pass = 0, failN = 0;
const ok = (c, label, x) => { if (c) pass++; else { failN++; console.log('FAIL', label, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };

// The app script lives in app.js; the page keeps a few small inline scripts
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const inline = [...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).concat(app);
const scripts = inline.join('\n');
const html = s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

// Every inline script parses
const syntax = inline.map((c, i) => { try { new Function(c); return null; } catch (e) { return `script ${i}: ${e.message}`; } }).filter(Boolean);
ok(!syntax.length, 'inline scripts and app.js parse', syntax);
ok(/<script defer src="\/app\.js"><\/script>/.test(s), 'index.html loads app.js with defer');
ok(app.includes("const SUPABASE_URL = 'https://fgcjbdqvnjzafgnahwai.supabase.co';"), 'app.js keeps the SUPABASE_URL line the fake backend swaps');

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

// The lesson library (lessons.json) is well formed: every card type, calculator, live card and ticker exists
{
  const lib = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'));
  const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const core = (appSrc.match(/const CORE_TRACK = \{[^\n]*lessons: \[([^\]]*)\]/) || [])[1]?.match(/'([^']+)'/g)?.map(x => x.slice(1, -1)) || [];
  const tickers = new Set([...appSrc.matchAll(/\{t:'([^']+)'/g)].map(m => m[1]));
  const calcs = new Set([...(appSrc.match(/const LC_CALCS = \{[\s\S]*?\n\};/)?.[0] || '').matchAll(/^ (\w+): \{$/gm)].map(m => m[1]));
  const metrics = new Set([...(appSrc.match(/const LC_METRICS = \{[\s\S]*?\n\};/)?.[0] || '').matchAll(/^ (\w+): \{/gm)].map(m => m[1]));
  const icons = new Set([...(appSrc.match(/const LEARN_ICONS = \{[\s\S]*?\n\};/)?.[0] || '').matchAll(/^ (\w+): '/gm)].map(m => m[1]));
  ok(core.length === 6 && calcs.size >= 8 && metrics.size >= 8 && icons.size >= 20, 'found the lesson engine pieces in app.js', { core, calcs: [...calcs], metrics: [...metrics], icons: icons.size });
  const ids = lib.lessons.map(l => l.id);
  ok(new Set([...ids, ...core]).size === ids.length + core.length, 'lesson ids are unique', ids);
  const inTracks = lib.tracks.flatMap(t => t.lessons);
  ok(inTracks.every(id => ids.includes(id)) && ids.every(id => inTracks.includes(id)), 'every lesson is in exactly one track', inTracks.filter(id => !ids.includes(id)));
  ok(lib.tracks.every(t => icons.has(t.icon)), 'track icons exist', lib.tracks.map(t => t.icon));
  const bad = [];
  const q3 = (q, where) => { if (!q?.q || !Array.isArray(q.a) || q.a.length !== 3 || new Set(q.a).size !== 3 || !q.why) bad.push(where); };
  for (const l of lib.lessons) {
    if (!l.title || !(l.mins > 0) || !icons.has(l.icon)) bad.push(l.id + ': title/mins/icon');
    if (!Array.isArray(l.quiz) || l.quiz.length !== 3) bad.push(l.id + ': needs 3 quiz questions');
    (l.quiz || []).forEach((q, k) => q3(q, l.id + ' quiz ' + (k + 1)));
    if (!l.cards?.length || l.cards.length < 3) bad.push(l.id + ': too few cards');
    if (!l.cards.some(c => typeof c === 'object')) bad.push(l.id + ': no hands-on card');
    if (l.cta && !(l.cta.label && (l.cta.go ? tickers.has(l.cta.go) : ['pt', 's', 'screen', 'port', 'w', 'cmp', 'day'].includes(l.cta.tab)))) bad.push(l.id + ': cta');
    l.cards.forEach((c, k) => {
      const at = l.id + ' card ' + (k + 1);
      if (typeof c === 'string') { if (c.length < 20) bad.push(at + ': short'); return; }
      if (c.t === 'predict') q3(c, at);
      else if (c.t === 'calc') { if (!calcs.has(c.calc) || !c.text) bad.push(at + ': calc ' + c.calc); }
      else if (c.t === 'sort') { if (!c.text || !(c.items?.length >= 3) || new Set(c.items).size !== c.items.length || !c.why) bad.push(at + ': sort'); }
      else if (c.t === 'match') { if (!c.text || !(c.pairs?.length >= 3) || c.pairs.some(p => p.length !== 2) || new Set(c.pairs.map(p => p[1])).size !== c.pairs.length) bad.push(at + ': match'); }
      else if (c.t === 'live') {
        if (!c.text) bad.push(at + ': live text');
        if (c.live === 'compare') { if (!metrics.has(c.metric) || !(c.tickers?.length >= 2) || c.tickers.some(t => !tickers.has(t))) bad.push(at + ': compare'); }
        else if (c.live === 'zoom' || c.live === 'drawdown') { if (!tickers.has(c.ticker)) bad.push(at + ': ticker ' + c.ticker); }
        else if (c.live !== 'bestdays') bad.push(at + ': live type ' + c.live);
      } else bad.push(at + ': unknown card type ' + c.t);
    });
  }
  ok(!bad.length, 'every lesson card and question is well formed', bad);
  const raw = fs.readFileSync(path.join(root, 'lessons.json'), 'utf8');
  ok(!/<script|on\w+=|javascript:/i.test(raw), 'lessons hold no scripts or handlers');
}

// Levels and rings are computed in two places (app.js for you, api/_leagues.js for your friends' boards): they must agree
{
  const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const lg = fs.readFileSync(path.join(root, 'api', '_leagues.js'), 'utf8');
  const appMins = [...(appSrc.match(/const LEARN_LEVELS = \[[\s\S]*?\];/)?.[0] || '').matchAll(/min: (\d+)/g)].map(m => +m[1]);
  const srvMins = (lg.match(/export const LEVEL_MINS = \[([^\]]*)\]/)?.[1] || '').split(',').map(Number);
  ok(appMins.length >= 8 && JSON.stringify(appMins) === JSON.stringify(srvMins), 'level ladder matches between app and leagues', { appMins, srvMins });
  const ring = re => (re.exec(appSrc + '\n' + lg) || [])[1];
  const appRing = /const ringForLevel = n => ([^;]*);/.exec(appSrc)?.[1], srvRing = /export const ringOf = n => ([^;]*);/.exec(lg)?.[1];
  ok(appRing && appRing === srvRing, 'ring rules match between app and leagues', { appRing, srvRing });
}

// Installable app: the manifest, its images, the offline service worker and the policy pages app stores link to
{
  const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  ok(man.id && man.name && man.short_name && man.description && man.start_url && man.display === 'standalone' && man.categories?.length, 'manifest has the fields stores check', man);
  const pngSize = p => { const b = fs.readFileSync(path.join(root, p)); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); };
  const imgs = [...man.icons.map(i => [i.src, i.sizes]), ...(man.screenshots || []).map(s => [s.src, s.sizes]), ...(man.shortcuts || []).flatMap(s => (s.icons || []).map(i => [i.src, i.sizes]))];
  const wrong = imgs.filter(([src, sizes]) => !fs.existsSync(path.join(root, src)) || pngSize(src) !== sizes);
  ok(!wrong.length, 'every manifest image exists at its stated size', wrong);
  ok(man.icons.some(i => i.purpose === 'maskable') && man.icons.some(i => i.sizes === '512x512' && i.purpose !== 'maskable'), 'manifest has a 512 icon and a maskable icon');
  ok(man.screenshots?.some(s => s.form_factor === 'wide') && man.screenshots.some(s => s.form_factor === 'narrow'), 'manifest has wide and narrow screenshots');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok(/mode !== 'navigate'/.test(sw) && !/cache\.put|cache\.add\(e\.request/.test(sw) && /offline\.html/.test(sw), 'service worker only adds an offline page (nothing else cached)');
  ok(/serviceWorker\.register\('\/sw\.js'\)/.test(fs.readFileSync(path.join(root, 'app.js'), 'utf8')), 'the app registers the service worker');
  for (const p of ['privacy.html', 'terms.html', 'offline.html']) ok(fs.existsSync(path.join(root, p)), p + ' exists');
  const priv = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8'), terms = fs.readFileSync(path.join(root, 'terms.html'), 'utf8');
  ok(/id="doc"/.test(priv) && /class="updated"/.test(priv) && /id="doc"/.test(terms) && /class="updated"/.test(terms), 'policy pages have the parts the in-app pop-ups load');
  ok(/Google Analytics/.test(priv) && /scrypt/.test(priv) && /under 13/.test(priv) && /profile photo/i.test(priv) && /leagues/.test(priv), 'privacy policy covers analytics, passwords, children, photos and leagues');
}

// Every API file loads (a syntax error here would break that endpoint on Vercel)
for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
  try { await import(pathToFileURL(path.join(root, 'api', f)).href); pass++; }
  catch (e) { failN++; console.log('FAIL', `api/${f} loads`, e.message); }
}
// Vercel runs api/ as CommonJS (package.json has no "type": "module"), so ESM-only features crash there
// even though they work in local Node. That broke /stock/ pages once.
for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
  const lines = fs.readFileSync(path.join(root, 'api', f), 'utf8').split('\n').map(l => l.replace(/^\s*\/\/.*$/, ''));
  const meta = lines.some(l => /\bimport\.meta\b/.test(l));
  const topAwait = lines.some(l => /^\S.*\bawait\s/.test(l) && !/=>|function/.test(l));
  ok(!meta && !topAwait, `api/${f} uses nothing CommonJS lacks (import.meta, top-level await)`);
}
// Vercel's Hobby plan allows 12 functions (files in api/ not starting with "_")
const endpoints = fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
ok(endpoints.length <= 12, `at most 12 serverless functions (have ${endpoints.length})`, endpoints);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
