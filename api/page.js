// Stock pages for search engines and link previews: stocksightai.com/stock/NVDA
// (vercel.json rewrites /stock/:t to /api/page?t=...). Sends the normal site with this stock's title,
// description and preview tags, plus a short real-data summary in the page itself. People see that summary
// only until the app loads and opens the full stock page; crawlers can read it either way.
// Also league invites: stocksightai.com/join/ABC123 (rewritten to /api/page?league=...) gets a link preview
// naming the league, so a shared invite reads as an invite. The app on that address handles the joining.
import fs from 'node:fs';
import path from 'node:path';
import { UA, quoteSummary } from './_yahoo.js';
import { LITE, facts as toFacts } from './fundamentals.js';
import { scoreStock } from './_digest.js';
import { ySym, TICKER_RE } from './_symbols.js';
import { invitePreview, CODE_RE } from './_leagues.js';

const SITE = 'https://stocksightai.com';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => v == null ? null : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 });
const pct = v => v == null ? null : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const big = v => v == null ? null : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;

// The site's own index.html: bundled with this function (vercel.json includeFiles), or fetched as a fallback.
// Vercel runs these files as CommonJS, so ESM-only features (the module's own URL) aren't available here.
let shell = null;
async function siteHtml(req) {
  if (shell) return shell;
  try { shell = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'); return shell; } catch {}
  const r = await fetch(`https://${req.headers?.host || 'stocksightai.com'}/index.html`);
  if (!r.ok) throw new Error(`index.html: ${r.status}`);
  shell = await r.text();
  return shell;
}

function withHead(html, { title, description, url, noindex }) {
  const set = (re, tag) => { html = re.test(html) ? html.replace(re, tag) : html; };
  set(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  set(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`);
  set(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  set(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`);
  set(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(description)}">`);
  set(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(title)}">`);
  set(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(description)}">`);
  set(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  if (noindex) html = html.replace(/<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex">');
  return html;
}

// quoteSummary gives nothing both for a made-up ticker and when Yahoo is having a moment. Only Yahoo saying
// "no such symbol" makes a 404; anything else keeps the page up, so an outage never tells Google a stock is gone.
async function unknownTicker(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.status === 404) return true;
      if (r.ok) return !(await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    } catch {}
  }
  return false;
}

async function renderInvite(req, res, code) {
  let html = await siteHtml(req);
  const p = CODE_RE.test(code) ? await invitePreview(code).catch(() => null) : null;
  const title = p ? `Join ${p.name} on StockSight` : 'Join a league on StockSight';
  const description = p
    ? `${p.by ? `${p.by} invited you to` : "You're invited to"} ${p.name}, a StockSight league with ${p.members} ${p.members === 1 ? 'member' : 'members'}. Learn investing, earn XP and see who tops the board each week.`
    : 'StockSight leagues: learn investing with friends, earn XP and see who tops the board each week.';
  html = withHead(html, { title, description, url: `${SITE}/join/${encodeURIComponent(code)}`, noindex: true })
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${SITE}/">`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  return res.status(200).send(html);
}

export default async function handler(req, res) {
  const t = String(req.query?.t || '').toUpperCase().trim();
  if (req.query?.league) {
    const code = String(req.query.league).toUpperCase().trim();
    try { return await renderInvite(req, res, code); }
    catch (e) { console.error('invite page:', e); res.setHeader('Location', '/'); return res.status(302).end(); }
  }
  try {
    return await render(req, res, t);
  } catch (e) {
    // Never a broken page: the app on this address opens the stock by itself
    console.error('stock page:', t, e);
    res.setHeader('Cache-Control', 'no-store');
    if (shell) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(200).send(shell); }
    res.setHeader('Location', TICKER_RE.test(t) ? `/?stock=${encodeURIComponent(t)}` : '/');
    return res.status(302).end();
  }
}

async function render(req, res, t) {
  let html = await siteHtml(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const valid = TICKER_RE.test(t);
  const f = valid ? await quoteSummary(ySym(t), LITE).then(r => (r ? toFacts(r) : null)).catch(() => null) : null;
  if (!f?.price) {
    if (!valid || await unknownTicker(ySym(t))) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
      return res.status(404).send(withHead(html, { title: 'Stock not found | StockSight', description: "We couldn't find that ticker. Search any stock, ETF or coin on StockSight.", url: `${SITE}/`, noindex: true }));
    }
    // No numbers right now: the page with this stock's address and name, and no summary, cached briefly
    const url = `${SITE}/stock/${encodeURIComponent(t)}`;
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.status(200).send(withHead(html, { title: `${t} Stock: Price, Analyst Target and Verdict | StockSight`, description: `${t} stock price, analyst target, forecast and StockSight's verdict. Real data, explained in plain English.`, url }));
  }

  const name = f.name || t;
  const isStock = f.quoteType === 'EQUITY';
  const R = isStock ? scoreStock(f) : null;
  const up = f.targetMean && f.price ? f.targetMean / f.price - 1 : null;
  const url = `${SITE}/stock/${encodeURIComponent(t)}`;
  const title = isStock ? `${name} (${t}) Stock: Price, Analyst Target and Verdict | StockSight` : `${name} (${t}): Price and Analysis | StockSight`;
  const description = [
    `${name} (${t}) is trading at ${money(f.price)}${f.change52w != null ? `, ${pct(f.change52w)} over the past year` : ''}.`,
    up != null ? `Analysts' average target is ${money(f.targetMean)} (${pct(up)}).` : '',
    R ? `StockSight's verdict: ${R.verdict} (${R.score}/100).` : '',
    'Real data, explained in plain English.',
  ].filter(Boolean).join(' ');

  const stats = [
    ['Price', money(f.price)],
    ['Past year', pct(f.change52w)],
    ['Analyst target', f.targetMean ? `${money(f.targetMean)}${up != null ? ` (${pct(up)})` : ''}` : null],
    ['StockSight verdict', R ? `${R.verdict}, ${R.score}/100` : null],
    ['Market cap', big(f.marketCap)],
    ['P/E', f.trailingPE ? f.trailingPE.toFixed(1) : null],
    ['Sector', f.sector],
  ].filter(([, v]) => v);
  const summary = `
<div id="seoStock" class="seo-stock">
 <p><a href="/">StockSight</a> · stock research for people who aren't stock people</p>
 <h1>${esc(name)} (${esc(t)})${isStock ? ' stock' : ''}</h1>
 <p>${esc(description)}</p>
 <dl>${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
 <p>Loading the full analysis: the chart, the forecast, analyst ratings and earnings. <a href="/stock/${encodeURIComponent(t)}">Open it</a>. Free, no account needed.</p>
 <p style="font-size:.8rem">Real market data from Yahoo Finance. Not financial advice.</p>
</div>`;

  html = withHead(html, { title, description, url }).replace('<body>\n', `<body>\n${summary}\n`);
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).send(html);
}
