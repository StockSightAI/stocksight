// Stock pages for search engines and link previews: stocksightai.com/stock/NVDA
// (vercel.json rewrites /stock/:t to /api/page?t=...). Sends the normal site with this stock's title,
// description and preview tags, plus a short real-data summary in the page itself. People see that summary
// only until the app loads and opens the full stock page; crawlers can read it either way.
import fs from 'node:fs';
import path from 'node:path';
import { quoteSummary } from './_yahoo.js';
import { LITE, facts as toFacts } from './fundamentals.js';
import { scoreStock } from './_digest.js';
import { ySym, TICKER_RE } from './_symbols.js';

const SITE = 'https://stocksightai.com';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => v == null ? null : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 });
const pct = v => v == null ? null : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const big = v => v == null ? null : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;

// The site's own index.html: bundled with this function (vercel.json includeFiles), or fetched as a fallback
let shell = null;
async function siteHtml(req) {
  if (shell) return shell;
  for (const p of [path.join(process.cwd(), 'index.html'), path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'index.html')]) {
    try { shell = fs.readFileSync(p, 'utf8'); return shell; } catch {}
  }
  const r = await fetch(`https://${req.headers?.host || 'stocksightai.com'}/index.html`);
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

export default async function handler(req, res) {
  const t = String(req.query?.t || '').toUpperCase().trim();
  let html = await siteHtml(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const f = TICKER_RE.test(t) ? await quoteSummary(ySym(t), LITE).then(r => (r ? toFacts(r) : null)).catch(() => null) : null;
  if (!f?.price) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
    return res.status(404).send(withHead(html, { title: 'Stock not found | StockSight', description: "We couldn't find that ticker. Search any stock, ETF or coin on StockSight.", url: `${SITE}/`, noindex: true }));
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
