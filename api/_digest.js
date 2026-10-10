// Weekly digest: real market data gathered once per send, then one personal email per subscriber.
// Data: Yahoo Finance (prices, company facts, earnings dates), CNN Fear & Greed, alternative.me,
// Forex Factory (economic calendar) and StockSight's own search counts.
import { UA, quoteSummary } from './_yahoo.js';
import { cnn, computed, crypto as cryptoFearGreed, econ } from './market.js';
import { LITE, facts as toFacts } from './fundamentals.js';
import { db } from './_auth.js';

const SITE = process.env.DIGEST_BASE_URL || 'https://stocksightai.com';
const DAY = 86400e3;

/* ── What the email covers ── */
const SCOREBOARD = [
  ['S&P 500', '^GSPC'], ['Nasdaq', '^IXIC'], ['Dow', '^DJI'], ['Russell 2000', '^RUT'],
  ['10-yr Treasury', '^TNX'], ['Gold', 'GC=F'], ['Oil (WTI)', 'CL=F'], ['Bitcoin', 'BTC-USD'],
];
const SECTORS = [
  ['Technology', 'XLK'], ['Communication', 'XLC'], ['Consumer Discretionary', 'XLY'], ['Consumer Staples', 'XLP'],
  ['Financials', 'XLF'], ['Health Care', 'XLV'], ['Energy', 'XLE'], ['Industrials', 'XLI'],
  ['Materials', 'XLB'], ['Real Estate', 'XLRE'], ['Utilities', 'XLU'],
];
// Widely held stocks: top movers, pick of the week and the earnings calendar
const UNIVERSE = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta'],
  ['TSLA', 'Tesla'], ['AVGO', 'Broadcom'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'], ['MA', 'Mastercard'], ['LLY', 'Eli Lilly'],
  ['UNH', 'UnitedHealth'], ['XOM', 'Exxon Mobil'], ['WMT', 'Walmart'], ['COST', 'Costco'], ['NFLX', 'Netflix'], ['AMD', 'AMD'],
  ['ORCL', 'Oracle'], ['CRM', 'Salesforce'], ['ADBE', 'Adobe'], ['INTC', 'Intel'], ['DIS', 'Disney'], ['BAC', 'Bank of America'],
  ['KO', 'Coca-Cola'], ['PEP', 'PepsiCo'], ['NKE', 'Nike'], ['PLTR', 'Palantir'], ['UBER', 'Uber'], ['COIN', 'Coinbase'],
  ['BRK-B', 'Berkshire Hathaway'], ['HD', 'Home Depot'], ['PG', 'Procter & Gamble'], ['MRK', 'Merck'], ['ABBV', 'AbbVie'],
  ['CVX', 'Chevron'], ['CSCO', 'Cisco'], ['QCOM', 'Qualcomm'], ['MU', 'Micron'], ['SHOP', 'Shopify'], ['PYPL', 'PayPal'],
  ['ABNB', 'Airbnb'], ['SBUX', 'Starbucks'], ['MCD', "McDonald's"], ['BA', 'Boeing'], ['GE', 'GE Aerospace'],
  ['CAT', 'Caterpillar'], ['GS', 'Goldman Sachs'], ['HOOD', 'Robinhood'], ['SOFI', 'SoFi'], ['ARM', 'Arm Holdings'],
  ['MSTR', 'Strategy'], ['SNOW', 'Snowflake'], ['RBLX', 'Roblox'], ['SMCI', 'Super Micro Computer'],
];
const NAMES = Object.fromEntries(UNIVERSE);

// Same ticker conventions as the site (index.html: Y_INDEX, ySym)
const Y_INDEX = {
  SPX: '^GSPC', IXIC: '^IXIC', DJI: '^DJI', RUT: '^RUT', VIX: '^VIX', NDX: '^NDX', MID: '^MID', SP600: '^SP600',
  FTSE: '^FTSE', NI225: '^N225', DAX: '^GDAXI', CAC40: '^FCHI', HSI: '^HSI', ASX: '^AXJO', SENSEX: '^BSESN',
  NIFTY: '^NSEI', KOSPI: '^KS11', SSEC: '000001.SS', IBEX: '^IBEX', MIB: 'FTSEMIB.MI', AEX: '^AEX', SMI: '^SSMI',
  TSX: '^GSPTSE', BVSP: '^BVSP', MERVAL: '^MERV', DXY: 'DX-Y.NYB', US10Y: '^TNX', US30Y: '^TYX',
  GOLD: 'GC=F', SILVER: 'SI=F', USOIL: 'CL=F', UKOIL: 'BZ=F', NATGAS: 'NG=F', CORN: 'ZC=F', WHEAT: 'ZW=F',
};
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT', 'MATIC', 'SHIB', 'UNI',
  'ATOM', 'FIL', 'APT', 'ARB', 'OP', 'INJ', 'SUI', 'TIA', 'NEAR', 'FTM', 'ALGO', 'HBAR', 'VET', 'THETA', 'EOS', 'XLM', 'TRX',
  'BCH', 'ETC', 'XMR', 'ZEC', 'DASH', 'PEPE', 'WIF', 'BONK', 'FLOKI']);
const isCrypto = (t, k) => k === 'c' || (!k && CRYPTO.has(t));
export function ySym(t, k) {
  t = String(t || '').toUpperCase().trim();
  if (Y_INDEX[t]) return Y_INDEX[t];
  if (isCrypto(t, k)) return t + '-USD';
  return t.replace(/\./g, '-');
}
const isStockSym = s => /^[A-Z][A-Z0-9-]{0,9}$/.test(s) && !s.endsWith('-USD');
const show = s => s.replace(/-USD$/, '').replace(/^([A-Z]+)-([A-Z])$/, '$1.$2');

const ECON_EXPLAIN = [
  [/FOMC|Federal Funds|Fed Chair|Powell|Interest Rate/i, 'The Federal Reserve sets interest rates. Lower rates usually help stocks; higher rates usually weigh on them.'],
  [/CPI|Consumer Price/i, 'Measures how fast prices are rising. Hotter inflation can mean higher interest rates for longer.'],
  [/PCE/i, "The Fed's favorite inflation gauge. It moves rate expectations."],
  [/Non-Farm|Payrolls|Unemployment|Jobless|Employment|ADP/i, 'A read on the job market. Strong hiring means a healthy economy, but can also keep rates high.'],
  [/GDP/i, 'The total size of the US economy. Two shrinking quarters in a row is a common definition of recession.'],
  [/Retail Sales/i, 'How much Americans spent at stores. Consumer spending drives most of the economy.'],
  [/PMI|ISM/i, "A survey of purchasing managers. Above 50 means the sector is growing, below 50 means it's shrinking."],
  [/Consumer (Confidence|Sentiment)/i, 'How optimistic people feel. Confident consumers tend to spend more.'],
  [/PPI|Producer Price/i, 'Prices businesses pay. It often hints at where consumer inflation is heading.'],
  [/Housing|Home Sales|Building Permits|Housing Starts/i, 'A read on the housing market, which is very sensitive to interest rates.'],
  [/Treasury|Auction|Bond/i, 'Government bond sales. Weak demand can push interest rates up.'],
];

const TERMS = [
  ['P/E ratio', 'Price-to-earnings: the share price divided by a year of earnings per share. A P/E of 20 means investors pay $20 for every $1 of yearly profit. A higher P/E usually means investors expect faster growth.'],
  ['Market cap', "The total value of a company's shares: share price × shares outstanding. It's how large-cap and small-cap companies are defined."],
  ['Dividend yield', 'Yearly dividends divided by the share price. A $100 stock that pays $3 a year yields 3%.'],
  ['ETF', 'Exchange-traded fund: a basket of investments that trades like a single stock. One share of an S&P 500 ETF gives you a slice of 500 companies.'],
  ['Index fund', 'A fund that copies a market index instead of picking stocks. Low costs and broad diversification make index funds a common core holding.'],
  ['Expense ratio', 'The yearly fee a fund charges, as a percent of what you invest. An expense ratio of 0.10% costs $1 a year for every $1,000.'],
  ['Volatility', 'How much a price swings up and down. Higher volatility means bigger moves in both directions.'],
  ['Beta', 'How much a stock tends to move compared with the overall market. A beta of 1.5 means it has historically moved about 50% more than the S&P 500.'],
  ['Dollar-cost averaging', "Investing a fixed amount on a regular schedule, whatever the price. You automatically buy more shares when prices are low and fewer when they're high."],
  ['Diversification', "Spreading money across many investments so one bad pick can't sink your whole portfolio."],
  ['Bull and bear markets', 'A bull market is a long stretch of rising prices. A bear market is a drop of 20% or more from a recent high.'],
  ['Correction', 'A decline of 10% to 20% from a recent high. Corrections are a normal part of investing and happen fairly often.'],
  ['EPS', "Earnings per share: a company's profit divided by its number of shares. It's the number analysts estimate before every earnings report."],
  ['Revenue vs. profit', "Revenue is all the money a company brings in from sales. Profit is what's left after every cost. A company can grow revenue and still lose money."],
  ['Free cash flow', 'The cash a business generates after paying for its operations and investments. Companies use it for dividends, buybacks and paying down debt.'],
  ['Compounding', 'Earning returns on your past returns. $1,000 growing 8% a year becomes about $2,159 in 10 years and about $10,063 in 30.'],
  ['Limit order', "An order to buy or sell only at a price you choose or better. It protects you from a bad price, but it might not get filled."],
  ['Market order', 'An order to buy or sell right away at the best available price. Fast, but the price you get can differ from the last quote.'],
  ['Stop-loss order', 'An order that sells automatically if the price falls to a level you set, to cap how much you can lose.'],
  ['Bid-ask spread', 'The gap between the highest price buyers offer (bid) and the lowest price sellers accept (ask). Smaller spreads mean cheaper trading.'],
  ['Short selling', 'Borrowing shares and selling them, hoping to buy them back cheaper later. Losses have no limit if the price keeps rising.'],
  ['Treasury yield', 'The interest rate the US government pays to borrow. When the 10-year yield rises, borrowing gets more expensive across the economy, which can weigh on stocks.'],
  ['Inflation (CPI)', 'The Consumer Price Index tracks what everyday goods and services cost. When CPI rises, each dollar buys less.'],
  ['Fed funds rate', 'The interest rate the Federal Reserve sets for overnight loans between banks. It ripples into rates on mortgages, credit cards and savings accounts.'],
  ['Price target', "An analyst's estimate of where a stock will trade in about 12 months. Targets are opinions and change often."],
  ['52-week high and low', "The highest and lowest prices a stock has traded at over the past year. They show where today's price sits in its recent range."],
  ['200-day moving average', 'The average closing price over the last 200 trading days. Traders watch whether a stock trades above it (uptrend) or below it (downtrend).'],
  ['Asset allocation', 'How you split your money between stocks, bonds, cash and other assets. It drives most of the risk and return in a portfolio.'],
  ['Rebalancing', 'Trimming what has grown and adding to what has lagged to get back to your target mix.'],
  ['Capital gains', 'The profit when you sell an investment for more than you paid. In the US, holding for more than a year usually qualifies for a lower tax rate.'],
];

/* ── Small helpers ── */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch {} }
  }));
}
const etDate = (ms, opts) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', ...opts });
const etKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// Yahoo stores earnings dates either with the real time or as a bare date at midnight UTC
const earnDate = (ms, opts) => {
  const d = new Date(ms);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? d.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts }) : etDate(ms, opts);
};
export function isoWeek(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

/* ── Prices: one month of daily closes per symbol, 20 symbols per request ── */
async function spark(symbols) {
  const out = {}, chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  await pool(chunks, 4, async c => {
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(',')}&range=1mo&interval=1d`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) continue;
        Object.assign(out, await r.json());
        return;
      } catch {}
    }
  });
  return out;
}

// Last finished session's close vs. the last close at least a week before it
function weekMove(sym, q, now) {
  const ts = q?.timestamp || [], cl = q?.close || [];
  const sessionLen = sym.endsWith('-USD') ? DAY : sym.endsWith('=F') ? 22 * 3600e3 : 7 * 3600e3;
  const pts = ts.map((t, i) => ({ t: t * 1000, c: cl[i] })).filter(p => Number.isFinite(p.c) && p.t + sessionLen <= now);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const ref = [...pts].reverse().find(p => p.t <= last.t - 6.5 * DAY);
  if (!ref) return null;
  const days = pts.filter(p => p.t > ref.t && p.t <= last.t);
  return { price: last.c, prev: ref.c, change: last.c - ref.c, pct: (last.c / ref.c - 1) * 100, from: days[0]?.t ?? last.t, to: last.t };
}

/* ── The verdict model, same weights and thresholds as scoreAsset in index.html (stocks only) ── */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
function scoreStock(f) {
  if (!f?.price) return null;
  const px = f.price, spRet = f.sp52w ?? 0.12, factors = [];
  const add = (key, weight, score) => { if (score != null && Number.isFinite(score)) factors.push({ key, weight, score: Math.round(clamp(score, 0, 100)) }); };
  if (f.analysts >= 3 && f.recMean) {
    const base = (5 - f.recMean) / 4 * 100, w = Math.min(1, f.analysts / 10);
    let s = 50 + (base - 50) * w;
    const up = f.targetMean ? f.targetMean / px - 1 : null;
    if (up != null) s = 0.6 * s + 0.4 * clamp(50 + up * 250, 0, 100);
    add('analysts', 25, s);
  }
  if (f.revenueGrowth != null || f.earningsGrowth != null) {
    const g = f.revenueGrowth != null ? clamp(45 + f.revenueGrowth * 150, 0, 100) : null;
    const e = f.earningsGrowth != null ? clamp(45 + clamp(f.earningsGrowth, -1, 1) * 80, 0, 100) : null;
    add('growth', 20, g != null && e != null ? 0.6 * g + 0.4 * e : (g ?? e));
  }
  const pp = [];
  if (f.operatingMargin != null) pp.push(clamp(30 + f.operatingMargin * 200, 0, 100));
  if (f.roe != null) pp.push(clamp(40 + Math.min(f.roe, 0.6) * 100, 0, 100));
  if (f.freeCashflow != null) pp.push(f.freeCashflow > 0 ? 75 : 20);
  if (f.profitMargin != null && f.profitMargin < 0) pp.push(10);
  if (pp.length) add('profit', 20, avg(pp));
  const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE > 0 ? f.trailingPE : null;
  if (pe) {
    const s1 = clamp(100 - 60 * Math.log10(pe / 6), 5, 98);
    const s2 = f.peg > 0 ? clamp(100 - (f.peg - 0.5) * 30, 5, 95) : null;
    add('value', 15, s2 != null ? (s1 + s2) / 2 : s1);
  } else if (f.profitMargin != null && f.profitMargin < 0) {
    add('value', 15, f.priceToSales ? clamp(70 - f.priceToSales * 4, 10, 60) : 25);
  }
  if (!/Financial/i.test(f.sector || '')) {
    const hp = [];
    if (f.debtToEquity != null) hp.push(clamp(90 - (f.debtToEquity / 100) * 25, 5, 95));
    if (f.totalCash != null && f.totalDebt != null) hp.push(f.totalCash >= f.totalDebt ? 88 : clamp(88 - (f.totalDebt - f.totalCash) / Math.max(f.totalDebt, 1) * 55, 30, 88));
    if (f.currentRatio != null) hp.push(clamp(30 + f.currentRatio * 35, 10, 95));
    if (hp.length) add('health', 10, avg(hp));
  }
  if (f.change52w != null) {
    let s = 50 + (f.change52w - spRet) * 120;
    if (f.twoHundredDayAvg) s += px > f.twoHundredDayAvg ? 8 : -8;
    add('momentum', 10, s);
  }
  if (!factors.length) return null;
  const wsum = factors.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(factors.reduce((s, x) => s + x.score * x.weight, 0) / wsum);
  const verdict = score >= 80 ? 'Strong Buy' : score >= 68 ? 'Buy' : score >= 48 ? 'Hold' : 'Sell';
  return { score, verdict, factors, coverage: wsum };
}
const recLabel = m => m <= 1.5 ? 'Strong Buy' : m <= 2.5 ? 'Buy' : m <= 3.5 ? 'Hold' : m <= 4.5 ? 'Sell' : 'Strong Sell';
const pctTxt = x => `${Math.round(Math.abs(x) * 100)}%`;
function reason(key, f) {
  switch (key) {
    case 'analysts': {
      const up = f.targetMean && f.price ? f.targetMean / f.price - 1 : null;
      return `${f.analysts} Wall Street analysts rate it ${recLabel(f.recMean)} on average${up != null ? `, with an average price target ${pctTxt(up)} ${up >= 0 ? 'above' : 'below'} today's price` : ''}.`;
    }
    case 'growth': return f.revenueGrowth != null ? `Revenue is ${f.revenueGrowth >= 0 ? 'up' : 'down'} ${pctTxt(f.revenueGrowth)} from a year ago.` : `Earnings are ${f.earningsGrowth >= 0 ? 'up' : 'down'} ${pctTxt(f.earningsGrowth)} from a year ago.`;
    case 'profit': return f.operatingMargin != null ? `It keeps ${pctTxt(f.operatingMargin)} of every sales dollar as operating profit.` : 'It produces strong returns on shareholder money.';
    case 'value': { const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE; return pe ? `It trades at ${pe.toFixed(1)}× ${f.forwardPE > 0 ? 'next year\'s expected' : 'last year\'s'} earnings.` : 'Its valuation looks reasonable for its sales.'; }
    case 'health': return f.totalCash != null && f.totalDebt != null && f.totalCash >= f.totalDebt ? 'It holds more cash than debt.' : 'Its balance sheet is in good shape.';
    case 'momentum': return `The stock is ${f.change52w >= 0 ? 'up' : 'down'} ${pctTxt(f.change52w)} over the past year${f.sp52w != null ? `, vs. ${f.sp52w >= 0 ? '+' : '−'}${pctTxt(f.sp52w)} for the S&P 500` : ''}.`;
    default: return '';
  }
}

/* ── Gather everything shared by all subscribers ── */
export async function gatherMarket(subscribers, now = Date.now()) {
  // Every symbol a subscriber holds, watches or paper-trades
  const userSyms = new Set();
  for (const s of subscribers) {
    for (const w of listOf(s.watchlist)) userSyms.add(ySym(w.ticker, w.type));
    for (const h of listOf(s.portfolio?.holdings)) userSyms.add(ySym(h.ticker, h.type));
    for (const t of Object.keys(s.portfolio?.paper_trade?.holdings || {})) userSyms.add(ySym(t));
  }
  const fixed = [...SCOREBOARD.map(x => x[1]), '^VIX', ...SECTORS.map(x => x[1]), ...UNIVERSE.map(x => x[0])];
  const allSyms = [...new Set([...fixed, ...userSyms])].slice(0, 400);
  const factSyms = [...new Set([...UNIVERSE.map(x => x[0]), ...[...userSyms].filter(isStockSym)])].slice(0, 110);

  const sinceKey = new Date(now - 7 * DAY).toISOString().slice(0, 10);
  const [px, fg, cfg, ev, factsBySym, searches] = await Promise.all([
    spark(allSyms),
    cnn().catch(() => null).then(x => x || computed().catch(() => null)),
    cryptoFearGreed().catch(() => null),
    econ().catch(() => []),
    (async () => {
      const out = {};
      await pool(factSyms, 6, async s => { const r = await quoteSummary(s, LITE); if (r) out[s] = toFacts(r); });
      return out;
    })(),
    db(`searches?select=ticker&date=gte.${sinceKey}&limit=20000`).catch(() => []),
  ]);

  const moves = {};
  for (const s of allSyms) { const m = weekMove(s, px[s], now); if (m) moves[s] = m; }
  const spx = moves['^GSPC'];
  if (!spx) throw new Error('No S&P 500 data, so no digest this time');

  const sectors = SECTORS.map(([name, s]) => ({ name, sym: s, ...moves[s] })).filter(x => x.pct != null).sort((a, b) => b.pct - a.pct);
  const universe = UNIVERSE.map(([t, name]) => ({ t, name, ...moves[t] })).filter(x => x.pct != null).sort((a, b) => b.pct - a.pct);

  // Earnings reports in the 7 days after the send
  const start = new Date(etKey(now) + 'T00:00:00Z').getTime() - 12 * 3600e3, end = now + 7 * DAY;
  const earnings = {};
  for (const [s, f] of Object.entries(factsBySym)) {
    const t = f?.nextEarnings ? f.nextEarnings * 1000 : null;
    if (t && t >= start && t < end) earnings[s] = t;
  }

  // StockSight pick: rotate weekly through the five highest-rated stocks in the model
  const rated = UNIVERSE.map(([t, name]) => ({ t, name, f: factsBySym[t], r: scoreStock(factsBySym[t]) }))
    .filter(x => x.r && x.r.coverage >= 80 && (x.r.verdict === 'Buy' || x.r.verdict === 'Strong Buy'))
    .sort((a, b) => b.r.score - a.r.score).slice(0, 5);
  const pick = rated.length ? rated[isoWeek(new Date(now)) % rated.length] : null;

  const events = ev.filter(e => { const t = new Date(e.date).getTime(); return t >= now - 6 * 3600e3 && t < end; });
  const high = events.filter(e => e.impact === 'High');
  const econList = (high.length >= 3 ? high : [...high, ...events.filter(e => e.impact !== 'High')]).slice(0, 6)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const counts = {};
  for (const r of Array.isArray(searches) ? searches : []) if (r?.ticker) counts[r.ticker] = (counts[r.ticker] || 0) + 1;
  const totalSearches = Object.values(counts).reduce((a, b) => a + b, 0);
  const trending = totalSearches >= 10 ? Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t) : [];

  return {
    now, moves, spx, sectors, universe, earnings, pick, econ: econList, trending, fg, cfg, facts: factsBySym,
    week: { from: spx.from, to: spx.to }, term: TERMS[isoWeek(new Date(now)) % TERMS.length],
  };
}
function listOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => typeof x === 'string' ? { ticker: x } : x).filter(x => x && typeof x.ticker === 'string' && x.ticker.trim());
}

/* ── Formatting ── */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = x => x > 0 ? '+' : x < 0 ? '−' : '';
const fPct = (p, d = 1) => p == null || !Number.isFinite(p) ? '—' : `${sign(+p.toFixed(d))}${Math.abs(p).toFixed(d)}%`;
const fNum = (v, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fPx = v => v == null ? '—' : '$' + fNum(v, v >= 10000 ? 0 : v >= 1 ? 2 : 4);
const fLevel = v => fNum(v, v >= 10000 ? 0 : 2);
const fMoney = v => '$' + fNum(Math.abs(v), Math.abs(v) >= 100000 ? 0 : 2);
const fSigned = v => `${v >= 0 ? '+' : '−'}${fMoney(v)}`;
function weekLabel(w) {
  const a = new Date(w.from), b = new Date(w.to);
  const sameMonth = etDate(a, { month: 'short' }) === etDate(b, { month: 'short' });
  return sameMonth
    ? `${etDate(a, { month: 'short', day: 'numeric' })}–${etDate(b, { day: 'numeric' })}, ${etDate(b, { year: 'numeric' })}`
    : `${etDate(a, { month: 'short', day: 'numeric' })} – ${etDate(b, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const C = { bg: '#f3f2fa', card: '#ffffff', ink: '#17152b', ink2: '#4a4766', mute: '#8a87a3', line: '#e8e6f3', soft: '#f7f6fd', accent: '#6c5ce7', accentInk: '#4c3fc7', up: '#0b8a57', down: '#d23a52', upBg: '#e6f6ee', downBg: '#fdebee' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const st = (size, weight = 400, color = C.ink, extra = '') => `font-family:${FONT};font-size:${size}px;font-weight:${weight};color:${color};${extra}`;
const tone = p => p > 0.005 ? C.up : p < -0.005 ? C.down : C.mute;
const pctPill = (p, d = 1) => `<span style="${st(12, 700, tone(p), `background:${p > 0.005 ? C.upBg : p < -0.005 ? C.downBg : C.soft};border-radius:999px;padding:3px 8px;white-space:nowrap`)}">${fPct(p, d)}</span>`;
const stockUrl = t => `${SITE}/?stock=${encodeURIComponent(show(t))}`;
const tickerLink = (t, color = C.accentInk) => `<a href="${stockUrl(t)}" style="${st(13, 800, color, 'text-decoration:none')}">${esc(show(t))}</a>`;
const fQuote = (sym, v) => sym.startsWith('^') ? fLevel(v) : fPx(v);
const table = (inner, extra = '') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;${extra}">${inner}</table>`;
function card(title, inner, sub = '') {
  return `<tr><td style="padding:0 0 14px">${table(`<tr><td style="padding:22px 22px 20px">
    ${title ? `<p style="${st(11, 800, C.accent, 'margin:0;letter-spacing:.12em;text-transform:uppercase')}">${title}</p>` : ''}
    ${sub ? `<p style="${st(13, 400, C.mute, 'margin:4px 0 0')}">${sub}</p>` : ''}
    <div style="height:14px;line-height:14px;font-size:0">&nbsp;</div>${inner}</td></tr>`, `background:${C.card};border:1px solid ${C.line};border-radius:16px`)}</td></tr>`;
}
// cells: [html, attributes, extra css]
const row = (cells, last) => `<tr>${cells.map(([html, attrs = '', css = '']) => `<td ${attrs} style="padding:9px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}vertical-align:middle;${css}">${html}</td>`).join('')}</tr>`;

/* ── The week in a few sentences, written from the numbers ── */
function story(M) {
  const s = M.moves['^GSPC'], n = M.moves['^IXIC'], d = M.moves['^DJI'], btc = M.moves['BTC-USD'];
  const did = p => p >= 0 ? 'gained' : 'lost';
  const dir = s.pct >= 0.2 ? 'Stocks rose this past week' : s.pct <= -0.2 ? 'Stocks fell this past week' : 'Stocks were roughly flat this past week';
  const parts = [`${dir}: the S&P 500 ${did(s.pct)} ${Math.abs(s.pct).toFixed(1)}% to ${fLevel(s.price)}${n ? `, the Nasdaq ${did(n.pct)} ${Math.abs(n.pct).toFixed(1)}%` : ''}${d ? ` and the Dow ${did(d.pct)} ${Math.abs(d.pct).toFixed(1)}%` : ''}.`];
  const sec = M.sectors;
  if (sec.length >= 2) {
    const lead = sec[0], lag = sec[sec.length - 1];
    if (lag.pct >= 0) parts.push(`Every sector rose, led by ${lead.name} (${fPct(lead.pct)}).`);
    else if (lead.pct <= 0) parts.push(`Every sector fell; ${lead.name} held up best (${fPct(lead.pct)}) and ${lag.name} fell the most (${fPct(lag.pct)}).`);
    else parts.push(`${lead.name} led (${fPct(lead.pct)}) while ${lag.name} lagged (${fPct(lag.pct)}).`);
  }
  const big = [...M.universe].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
  if (big) parts.push(`Among popular stocks, ${big.name} made the biggest move, ${big.pct >= 0 ? 'up' : 'down'} ${Math.abs(big.pct).toFixed(1)}%.`);
  if (M.fg?.score != null && M.fg.weekAgo != null) {
    parts.push(M.fg.score === M.fg.weekAgo
      ? `Investor mood held steady at ${M.fg.score} (${M.fg.rating}) on CNN's Fear & Greed index.`
      : `CNN's Fear & Greed index ${M.fg.score > M.fg.weekAgo ? 'rose' : 'fell'} to ${M.fg.score} (${M.fg.rating}) from ${M.fg.weekAgo} a week earlier.`);
  }
  if (btc) parts.push(`Bitcoin ${btc.pct >= 0 ? 'rose' : 'fell'} ${Math.abs(btc.pct).toFixed(1)}% to ${fPx(btc.price)}.`);
  return parts;
}

/* ── One subscriber's numbers ── */
function personal(sub, M) {
  const mv = (t, k) => M.moves[ySym(t, k)];
  // Holdings, merged by ticker
  const merged = {};
  for (const h of listOf(sub.portfolio?.holdings)) {
    const shares = Number(h.shares);
    if (!(shares > 0)) continue;
    const key = ySym(h.ticker, h.type);
    const m = merged[key] ||= { sym: key, t: h.ticker.toUpperCase(), name: h.name || NAMES[key] || '', shares: 0, cost: 0, costKnown: true };
    m.shares += shares;
    if (Number(h.buyPrice) > 0) m.cost += shares * Number(h.buyPrice); else m.costKnown = false;
  }
  const hold = Object.values(merged).map(h => {
    const m = M.moves[h.sym];
    return m ? { ...h, price: m.price, pct: m.pct, value: h.shares * m.price, week: h.shares * m.change } : null;
  }).filter(Boolean).sort((a, b) => b.value - a.value);
  let portfolio = null;
  if (hold.length) {
    const value = hold.reduce((s, h) => s + h.value, 0), week = hold.reduce((s, h) => s + h.week, 0);
    const known = hold.filter(h => h.costKnown), cost = known.reduce((s, h) => s + h.cost, 0);
    portfolio = {
      value, week, weekPct: value - week > 0 ? week / (value - week) * 100 : 0, rows: hold.slice(0, 10), more: hold.length - 10,
      gain: cost > 0 ? known.reduce((s, h) => s + h.value, 0) - cost : null, gainPct: cost > 0 ? (known.reduce((s, h) => s + h.value, 0) / cost - 1) * 100 : null,
      best: [...hold].sort((a, b) => b.pct - a.pct)[0], worst: [...hold].sort((a, b) => a.pct - b.pct)[0],
    };
  }

  const wl = listOf(sub.watchlist).map(w => {
    const sym = ySym(w.ticker, w.type), m = M.moves[sym];
    return m ? { sym, t: w.ticker.toUpperCase(), name: w.name || NAMES[sym] || '', price: m.price, pct: m.pct, earn: M.earnings[sym] } : null;
  }).filter(Boolean);
  const seen = new Set();
  const watch = wl.filter(w => !seen.has(w.sym) && seen.add(w.sym)).sort((a, b) => b.pct - a.pct);

  // Paper account at today's prices (same math as the site: cash + shares × price)
  let paper = null;
  const pt = sub.portfolio?.paper_trade;
  if (pt && typeof pt === 'object' && Number.isFinite(Number(pt.cash))) {
    const pos = Object.entries(pt.holdings || {}).map(([t, h]) => ({ t, shares: Number(typeof h === 'object' ? h?.shares : h), m: mv(t) })).filter(p => p.shares > 0);
    const priced = pos.filter(p => p.m);
    if (pos.length && priced.length === pos.length) {
      const value = Number(pt.cash) + priced.reduce((s, p) => s + p.shares * p.m.price, 0);
      const week = priced.reduce((s, p) => s + p.shares * p.m.change, 0);
      paper = { value, allTime: (value / 10000 - 1) * 100, week, positions: pos.length };
    }
  }

  const mine = new Set([...hold.map(h => h.sym), ...watch.map(w => w.sym)]);
  const myEarnings = [...mine].filter(s => M.earnings[s]).map(s => ({ t: show(s), at: M.earnings[s] })).sort((a, b) => a.at - b.at);
  return { portfolio, watch, paper, myEarnings };
}

/* ── Rendering ── */
function scoreboardHTML(M) {
  const tiles = SCOREBOARD.map(([label, s]) => {
    const m = M.moves[s];
    if (!m) return null;
    const isYield = s === '^TNX';
    const level = isYield ? `${m.price.toFixed(2)}%` : s === 'BTC-USD' || s.endsWith('=F') ? fPx(m.price) : fLevel(m.price);
    const chg = isYield ? `${sign(Math.round(m.change * 100))}${Math.abs(Math.round(m.change * 100))} bps` : fPct(m.pct);
    return (left) => `<td width="50%" style="padding:${left ? '0 5px 10px 0' : '0 0 10px 5px'};vertical-align:top">${table(`<tr><td style="padding:12px 14px">
      <p style="${st(12, 600, C.mute, 'margin:0')}">${label}</p>
      <p style="${st(18, 800, C.ink, 'margin:3px 0 0;letter-spacing:-.01em')}">${level}</p>
      <p style="${st(13, 700, tone(isYield ? m.change : m.pct), 'margin:2px 0 0')}">${chg}</p></td></tr>`, `background:${C.soft};border-radius:12px`)}</td>`;
  }).filter(Boolean);
  let rows = '';
  for (let i = 0; i < tiles.length; i += 2) rows += `<tr>${tiles[i](true)}${tiles[i + 1] ? tiles[i + 1](false) : '<td width="50%"></td>'}</tr>`;
  return table(rows, 'margin-bottom:-10px');
}

function sectorsHTML(M) {
  const max = Math.max(...M.sectors.map(s => Math.abs(s.pct)), 0.5);
  const bar = (w, color, align) => w < 1 ? '&nbsp;' : table(`<tr><td align="${align}">${table(`<tr><td height="10" style="height:10px;line-height:10px;font-size:0;background:${color};border-radius:3px">&nbsp;</td></tr>`, `width:${w}%`)}</td></tr>`);
  return table(M.sectors.map((s, i) => {
    const w = Math.round(Math.abs(s.pct) / max * 100);
    return row([
      [`<span style="${st(13, 600, C.ink)}">${esc(s.name)}</span>`, 'width="40%"'],
      [s.pct < 0 ? bar(w, C.down, 'right') : '&nbsp;', 'width="22%"'],
      [`<div style="width:2px;height:16px;background:${C.line};margin:0 auto"></div>`, 'width="2%"'],
      [s.pct >= 0 ? bar(w, C.up, 'left') : '&nbsp;', 'width="22%"'],
      [`<span style="${st(13, 700, tone(s.pct))}">${fPct(s.pct)}</span>`, 'width="14%" align="right"'],
    ], i === M.sectors.length - 1);
  }).join(''));
}

function moversHTML(M) {
  const list = (items) => table(items.map((x, i) => row([
    [`${tickerLink(x.t)}<br><span style="${st(12, 400, C.mute)}">${esc(x.name)}</span>`],
    [pctPill(x.pct), 'align="right"'],
  ], i === items.length - 1)).join(''));
  const up = M.universe.slice(0, 3), down = M.universe.slice(-3).reverse();
  return table(`<tr>
    <td width="48%" style="vertical-align:top"><p style="${st(12, 700, C.up, 'margin:0 0 2px')}">▲ Up the most</p>${list(up)}</td>
    <td width="4%"></td>
    <td width="48%" style="vertical-align:top"><p style="${st(12, 700, C.down, 'margin:0 0 2px')}">▼ Down the most</p>${list(down)}</td></tr>`);
}

function gauge(score) {
  const bands = [['#d23a52', 'Extreme fear'], ['#ef7d57', 'Fear'], ['#c9c6d9', 'Neutral'], ['#5bbf8a', 'Greed'], ['#0b8a57', 'Extreme greed']];
  const pos = clamp(score, 2, 98);
  return table(`<tr>${bands.map(([c]) => `<td width="20%" height="8" style="height:8px;line-height:8px;font-size:0;background:${c}">&nbsp;</td>`).join('')}</tr>`, 'border-radius:4px;overflow:hidden') +
    table(`<tr><td width="${pos}%" style="font-size:0;line-height:0">&nbsp;</td><td style="${st(11, 800, C.ink, 'line-height:14px;padding-top:2px')}">▲</td></tr>`, 'margin-left:-4px');
}
function moodHTML(M) {
  const block = (label, x, note) => x?.score == null ? '' : `<td width="48%" style="vertical-align:top">
    <p style="${st(12, 600, C.mute, 'margin:0')}">${label}</p>
    <p style="${st(24, 800, C.ink, 'margin:2px 0 0')}">${x.score} <span style="${st(14, 700, C.ink2)}">${esc(x.rating)}</span></p>
    ${x.weekAgo != null ? `<p style="${st(12, 400, C.mute, 'margin:2px 0 10px')}">${x.weekAgo === x.score ? 'Same as' : x.score > x.weekAgo ? `Up ${x.score - x.weekAgo} from` : `Down ${x.weekAgo - x.score} from`} ${x.weekAgo} a week ago</p>` : `<p style="margin:0 0 10px"></p>`}
    ${gauge(x.score)}${note ? `<p style="${st(12, 400, C.mute, 'margin:8px 0 0')}">${note}</p>` : ''}</td>`;
  const vix = M.moves['^VIX'];
  const a = block("Stocks · CNN Fear & Greed", M.fg, vix ? `VIX (volatility) ${vix.price.toFixed(1)}, ${fPct(vix.pct)} on the week` : '');
  const b = block('Crypto · Fear & Greed', M.cfg, '');
  if (!a && !b) return '';
  return table(`<tr>${a || '<td width="48%"></td>'}<td width="4%"></td>${b || '<td width="48%"></td>'}</tr>`) +
    `<p style="${st(13, 400, C.ink2, 'margin:14px 0 0;line-height:1.55')}">Low readings mean investors are fearful and high readings mean they're greedy. Extremes in either direction have often come before the market turned.</p>`;
}

function pickHTML(M) {
  const p = M.pick;
  if (!p) return '';
  const top = [...p.r.factors].sort((a, b) => b.score - a.score).slice(0, 3).map(x => reason(x.key, p.f)).filter(Boolean);
  const vColor = p.r.verdict === 'Strong Buy' ? C.up : '#2f9e6e';
  return table(`<tr><td style="vertical-align:top">
      <a href="${stockUrl(p.t)}" style="${st(20, 800, C.ink, 'text-decoration:none')}">${esc(p.name)}</a>
      <span style="${st(14, 700, C.mute)}"> ${esc(show(p.t))}</span>
      <p style="${st(13, 400, C.mute, 'margin:3px 0 0')}">${fPx(p.f.price)}${M.moves[p.t] ? ` · ${fPct(M.moves[p.t].pct)} this week` : ''}</p></td>
    <td align="right" style="vertical-align:top;white-space:nowrap">
      <span style="${st(12, 800, '#ffffff', `background:${vColor};border-radius:999px;padding:5px 11px`)}">${p.r.verdict}</span>
      <p style="${st(12, 600, C.mute, 'margin:8px 0 0')}">Score ${p.r.score}/100</p></td></tr>`) +
    `<ul style="margin:14px 0 0;padding:0 0 0 18px">${top.map(t => `<li style="${st(14, 400, C.ink2, 'margin:0 0 6px;line-height:1.5')}">${esc(t)}</li>`).join('')}</ul>` +
    `<p style="${st(12, 400, C.mute, 'margin:10px 0 0;line-height:1.5')}">Chosen from the five highest-rated stocks in StockSight's model this week, which scores analyst views, growth, profitability, valuation, financial health and momentum. A starting point for research, not a recommendation.</p>`;
}

function aheadHTML(M, P) {
  const blocks = [];
  if (M.econ.length) {
    const explained = new Set();
    blocks.push(`<p style="${st(13, 800, C.ink, 'margin:0 0 4px')}">Economic calendar <span style="${st(12, 400, C.mute)}">· times in ET</span></p>` + table(M.econ.map((e, i) => {
      const t = new Date(e.date).getTime();
      let why = ECON_EXPLAIN.find(([re]) => re.test(e.title))?.[1];
      if (why && explained.has(why)) why = null; else if (why) explained.add(why);
      const nums = [e.forecast && `Forecast ${esc(e.forecast)}`, e.previous && `Previous ${esc(e.previous)}`].filter(Boolean).join(' · ');
      return row([
        [`<span style="${st(12, 700, C.ink2)}">${etDate(t, { weekday: 'short' })}</span><br><span style="${st(12, 400, C.mute)}">${new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}</span>`, 'width="64"', 'vertical-align:top'],
        [`<span style="${st(14, 700, C.ink)}">${esc(e.title)}</span>${e.impact === 'High' ? ` <span style="${st(10, 800, C.down, 'letter-spacing:.06em')}">HIGH IMPACT</span>` : ''}${nums ? `<br><span style="${st(12, 400, C.mute)}">${nums}</span>` : ''}${why ? `<br><span style="${st(13, 400, C.ink2, 'line-height:1.5')}">${why}</span>` : ''}`],
      ], i === M.econ.length - 1);
    }).join('')));
  }
  const reporting = Object.entries(M.earnings).filter(([s]) => NAMES[s]).sort((a, b) => a[1] - b[1]);
  if (reporting.length) {
    const byDay = {};
    for (const [s, t] of reporting) (byDay[earnDate(t, { weekday: 'long', month: 'short', day: 'numeric' })] ||= []).push(s);
    blocks.push(`<p style="${st(13, 800, C.ink, 'margin:18px 0 4px')}">Big earnings reports</p>` + table(Object.entries(byDay).map(([day, syms], i, a) => row([
      [`<span style="${st(13, 600, C.ink2)}">${day}</span>`, 'width="42%"'],
      [syms.map(s => tickerLink(s)).join('<span style="color:#c9c6d9"> &nbsp;·&nbsp; </span>')],
    ], i === a.length - 1)).join('')));
  }
  if (P?.myEarnings.length) {
    blocks.push(`<p style="${st(13, 400, C.ink2, `margin:14px 0 0;padding:12px 14px;background:${C.soft};border-radius:10px;line-height:1.5`)}"><b style="color:${C.ink}">Your stocks reporting:</b> ${P.myEarnings.map(e => `${esc(e.t)} (${earnDate(e.at, { weekday: 'short' })})`).join(', ')}. Prices often swing sharply right after earnings.</p>`);
  }
  return blocks.join('');
}

function portfolioHTML(P) {
  const p = P.portfolio;
  if (!p) return '';
  const head = table(`<tr><td style="vertical-align:bottom">
      <p style="${st(12, 600, C.mute, 'margin:0')}">Value at the latest close</p>
      <p style="${st(28, 800, C.ink, 'margin:2px 0 0;letter-spacing:-.02em')}">${fMoney(p.value)}</p></td>
    <td align="right" style="vertical-align:bottom">
      <p style="${st(16, 800, tone(p.week), 'margin:0')}">${fSigned(p.week)}</p>
      <p style="${st(13, 600, tone(p.week), 'margin:2px 0 0')}">${fPct(p.weekPct, 2)} this week</p></td></tr>`);
  const extra = [
    p.gain != null ? `Total gain since you bought: <b style="color:${tone(p.gain)}">${fSigned(p.gain)} (${fPct(p.gainPct)})</b>` : '',
    p.rows.length > 1 ? `Best this week: <b>${esc(p.best.t)}</b> ${fPct(p.best.pct)} · Worst: <b>${esc(p.worst.t)}</b> ${fPct(p.worst.pct)}` : '',
  ].filter(Boolean).map(x => `<p style="${st(13, 400, C.ink2, 'margin:6px 0 0')}">${x}</p>`).join('');
  const rows = table(p.rows.map((h, i) => row([
    [`${tickerLink(h.t)}<br><span style="${st(12, 400, C.mute)}">${fNum(h.shares, h.shares % 1 ? 4 : 0)} ${h.sym.endsWith('-USD') ? 'coins' : 'sh'} · ${fQuote(h.sym, h.price)}</span>`],
    [`<span style="${st(13, 600, C.ink)}">${fMoney(h.value)}</span>`, 'align="right"'],
    [pctPill(h.pct), 'align="right" width="76"'],
  ], i === p.rows.length - 1)).join(''), 'margin-top:12px');
  return head + extra + rows + (p.more > 0 ? `<p style="${st(12, 400, C.mute, 'margin:8px 0 0')}">+ ${p.more} more in the app</p>` : '');
}

function watchHTML(P) {
  if (!P.watch.length) return '';
  const rows = P.watch.slice(0, 10);
  return table(rows.map((w, i) => row([
    [`${tickerLink(w.t)}${w.earn ? ` <span style="${st(10, 800, C.accentInk, `background:#efecff;border-radius:6px;padding:2px 6px`)}">EARNINGS ${earnDate(w.earn, { weekday: 'short' }).toUpperCase()}</span>` : ''}<br><span style="${st(12, 400, C.mute)}">${esc(w.name || '')}</span>`],
    [`<span style="${st(13, 600, C.ink)}">${fQuote(w.sym, w.price)}</span>`, 'align="right"'],
    [pctPill(w.pct), 'align="right" width="76"'],
  ], i === rows.length - 1)).join('')) + (P.watch.length > 10 ? `<p style="${st(12, 400, C.mute, 'margin:8px 0 0')}">+ ${P.watch.length - 10} more in your watchlist</p>` : '');
}

function paperHTML(P) {
  const p = P.paper;
  if (!p) return '';
  return table(`<tr><td>
      <p style="${st(12, 600, C.mute, 'margin:0')}">Practice account (started at $10,000)</p>
      <p style="${st(22, 800, C.ink, 'margin:2px 0 0')}">${fMoney(p.value)}</p></td>
    <td align="right"><p style="${st(14, 800, tone(p.allTime), 'margin:0')}">${fPct(p.allTime)} all time</p>
      <p style="${st(12, 600, tone(p.week), 'margin:3px 0 0')}">${fSigned(p.week)} on your ${p.positions} position${p.positions === 1 ? '' : 's'} this week</p></td></tr>`);
}

export function buildEmail(sub, M, unsubscribeUrl) {
  const P = personal(sub, M);
  const first = String(sub.name || '').trim().split(/\s+/)[0] || '';
  const sentences = story(M);
  const wk = weekLabel(M.week);
  const spx = M.moves['^GSPC'];

  let subject;
  if (P.portfolio) subject = `Your portfolio ${fPct(P.portfolio.weekPct)} this week · S&P 500 ${fPct(spx.pct)}`;
  else if (P.watch.length) {
    const big = [...P.watch].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
    subject = `S&P 500 ${fPct(spx.pct)} this week · ${big.t} ${fPct(big.pct)} on your watchlist`;
  } else subject = `S&P 500 ${fPct(spx.pct)} this week · ${M.sectors[0] ? `${M.sectors[0].name} led` : 'your weekly market recap'}`;

  const sections = [
    card('The week in 30 seconds', `<p style="${st(15, 400, C.ink2, 'margin:0;line-height:1.65')}">${sentences.map(esc).join(' ')}</p>`),
    card('Scoreboard', scoreboardHTML(M), `Week of ${wk} · change vs. the previous Friday`),
    P.portfolio ? card('Your portfolio', portfolioHTML(P)) : '',
    P.watch.length ? card('Your watchlist', watchHTML(P), 'Sorted from best to worst this week') : '',
    P.paper ? card('Paper trading', paperHTML(P)) : '',
    !P.portfolio && !P.watch.length ? card('Make this email yours', `<p style="${st(14, 400, C.ink2, 'margin:0;line-height:1.6')}">Add stocks to your watchlist or log your real holdings in StockSight, and this email will show how <b>your</b> investments did each week.</p>`) : '',
    M.sectors.length ? card('Sectors', sectorsHTML(M), 'S&P 500 sector funds, weekly change') : '',
    M.universe.length >= 6 ? card('Biggest movers', moversHTML(M), 'Among 55 widely held US stocks') : '',
    M.fg || M.cfg ? card('Market mood', moodHTML(M)) : '',
    M.pick ? card('StockSight pick of the week', pickHTML(M)) : '',
    M.econ.length || Object.keys(M.earnings).length || P.myEarnings.length ? card('The week ahead', aheadHTML(M, P)) : '',
    M.trending.length ? card('Trending on StockSight', `<p style="margin:0;line-height:2.2">${M.trending.map(t => `<a href="${stockUrl(t)}" style="${st(13, 700, C.accentInk, `text-decoration:none;background:#efecff;border-radius:999px;padding:6px 12px;margin-right:6px;white-space:nowrap`)}">${esc(t)}</a>`).join(' ')}</p><p style="${st(12, 400, C.mute, 'margin:8px 0 0')}">The most-searched tickers on StockSight over the past 7 days.</p>`) : '',
    card('Term of the week', `<p style="${st(17, 800, C.ink, 'margin:0')}">${esc(M.term[0])}</p><p style="${st(14, 400, C.ink2, 'margin:6px 0 0;line-height:1.6')}">${esc(M.term[1])}</p>`),
  ].join('');

  const preheader = sentences[0];
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
${table(`<tr><td align="center" style="padding:24px 12px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse">
  <tr><td style="padding:4px 4px 18px">${table(`<tr>
    <td><a href="${SITE}" style="${st(20, 800, C.ink, 'text-decoration:none;letter-spacing:-.02em')}">Stock<span style="color:${C.accent}">Sight</span></a></td>
    <td align="right"><span style="${st(12, 600, C.mute)}">Weekly digest · ${esc(wk)}</span></td></tr>`)}</td></tr>
  <tr><td style="padding:0 4px 16px"><p style="${st(24, 800, C.ink, 'margin:0;letter-spacing:-.02em;line-height:1.25')}">${first ? `Good morning, ${esc(first)}.` : 'Good morning.'}</p>
    <p style="${st(15, 400, C.ink2, 'margin:6px 0 0;line-height:1.5')}">Here's how the market, and your investments, did this past week.</p></td></tr>
  ${sections}
  <tr><td align="center" style="padding:6px 0 22px">${table(`<tr><td style="background:${C.accent};border-radius:12px"><a href="${SITE}" style="${st(15, 800, '#ffffff', 'display:inline-block;padding:14px 30px;text-decoration:none')}">Open StockSight</a></td></tr>`, 'width:auto;margin:0 auto')}</td></tr>
  <tr><td style="padding:0 8px 28px;text-align:center">
    <p style="${st(12, 400, C.mute, 'margin:0 0 8px;line-height:1.6')}">You're getting this because you turned on the weekly digest in StockSight. <a href="${esc(unsubscribeUrl)}" style="color:${C.accentInk}">Unsubscribe</a> · <a href="${SITE}" style="color:${C.accentInk}">Settings</a></p>
    <p style="${st(11, 400, C.mute, 'margin:0;line-height:1.6')}">For information and education only, not financial advice. Weekly changes compare Friday's close with the previous Friday's (crypto: Sunday to Sunday). Data: Yahoo Finance, CNN Business, alternative.me, Forex Factory.</p>
  </td></tr>
</table></td></tr>`, `background:${C.bg}`)}
</body></html>`;

  const lines = [
    `StockSight weekly digest · ${wk}`, '', first ? `Good morning, ${first}.` : 'Good morning.', '', sentences.join(' '), '',
    'SCOREBOARD', ...SCOREBOARD.map(([l, s]) => M.moves[s] && `${l}: ${s === '^TNX' ? M.moves[s].price.toFixed(2) + '%' : fLevel(M.moves[s].price)} (${s === '^TNX' ? `${sign(Math.round(M.moves[s].change * 100))}${Math.abs(Math.round(M.moves[s].change * 100))} bps` : fPct(M.moves[s].pct)})`).filter(Boolean),
    ...(P.portfolio ? ['', 'YOUR PORTFOLIO', `${fMoney(P.portfolio.value)} (${fSigned(P.portfolio.week)}, ${fPct(P.portfolio.weekPct, 2)} this week)`, ...P.portfolio.rows.map(h => `${h.t}: ${fMoney(h.value)} (${fPct(h.pct)})`)] : []),
    ...(P.watch.length ? ['', 'YOUR WATCHLIST', ...P.watch.slice(0, 10).map(w => `${w.t}: ${fQuote(w.sym, w.price)} (${fPct(w.pct)})`)] : []),
    ...(M.pick ? ['', 'STOCKSIGHT PICK OF THE WEEK', `${M.pick.name} (${show(M.pick.t)}): ${M.pick.r.verdict}, score ${M.pick.r.score}/100`] : []),
    ...(M.econ.length ? ['', 'THE WEEK AHEAD', ...M.econ.map(e => `${etDate(new Date(e.date).getTime(), { weekday: 'short' })}: ${e.title}`)] : []),
    '', `TERM OF THE WEEK: ${M.term[0]}`, M.term[1], '', `Open StockSight: ${SITE}`, `Unsubscribe: ${unsubscribeUrl}`,
    'For information and education only, not financial advice.',
  ];
  return { subject, html, text: lines.join('\n') };
}
