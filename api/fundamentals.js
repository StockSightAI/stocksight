// Real company data from Yahoo Finance: profile, valuation, profitability, balance sheet,
// analyst targets and ratings, recent upgrades and downgrades, and earnings history.
//
// GET /api/fundamentals?symbol=AAPL             full detail for one stock, ETF, index or coin
// GET /api/fundamentals?symbols=AAPL,MSFT,...   the scoring facts for up to 20 symbols
// GET /api/fundamentals?symbol=AAPL&options=1   options pulse: implied volatility, expected move, put/call
//                                                ratios, unusual activity and what a protective put costs
import { SYMBOL_RE, quoteSummary, optionChain, trailingCashFlow } from './_yahoo.js';

const FULL = ['price', 'assetProfile', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'recommendationTrend',
  'earningsHistory', 'calendarEvents', 'upgradeDowngradeHistory', 'earningsTrend', 'earnings', 'fundProfile', 'topHoldings'];
export const LITE = ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'earningsHistory', 'calendarEvents', 'assetProfile', 'fundProfile'];

const raw = v => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);
const num = v => { const x = raw(v); return typeof x === 'number' && Number.isFinite(x) ? x : null; };
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Flat facts the verdict model scores; identical for the stock page, the screener and the weekly digest
export function facts(r) {
  const p = r.price || {}, sd = r.summaryDetail || {}, fd = r.financialData || {}, ks = r.defaultKeyStatistics || {};
  const ap = r.assetProfile || {}, fp = r.fundProfile || {}, ce = r.calendarEvents?.earnings || {};
  const hist = (r.earningsHistory?.history || []).filter(h => num(h.epsActual) != null && num(h.epsEstimate) != null);
  const beats = hist.filter(h => num(h.epsActual) >= num(h.epsEstimate)).length;
  const price = num(p.regularMarketPrice) ?? num(fd.currentPrice);
  const nextEarn = (ce.earningsDate || []).map(num).filter(Boolean).sort((a, b) => a - b).find(t => t * 1000 > Date.now() - 86400000) ?? null;
  return {
    price,
    currency: str(p.currency) || 'USD',
    quoteType: str(p.quoteType) || null,
    name: str(p.longName) || str(p.shortName) || null,
    exchange: str(p.exchangeName) || null,
    sector: str(ap.sector) || null,
    industry: str(ap.industry) || null,
    category: str(fp.categoryName) || null,
    marketCap: num(sd.marketCap) ?? num(p.marketCap),
    // analysts
    analysts: num(fd.numberOfAnalystOpinions),
    recMean: num(fd.recommendationMean),
    recKey: str(fd.recommendationKey),
    targetLow: num(fd.targetLowPrice),
    targetMean: num(fd.targetMeanPrice),
    targetMedian: num(fd.targetMedianPrice),
    targetHigh: num(fd.targetHighPrice),
    // growth and profitability
    revenueGrowth: num(fd.revenueGrowth),
    earningsGrowth: num(fd.earningsGrowth) ?? num(ks.earningsQuarterlyGrowth),
    grossMargin: num(fd.grossMargins),
    operatingMargin: num(fd.operatingMargins),
    profitMargin: num(fd.profitMargins) ?? num(ks.profitMargins),
    roe: num(fd.returnOnEquity),
    roa: num(fd.returnOnAssets),
    revenue: num(fd.totalRevenue),
    // valuation
    trailingPE: num(sd.trailingPE),
    forwardPE: num(sd.forwardPE) ?? num(ks.forwardPE),
    peg: num(ks.pegRatio),
    priceToSales: num(sd.priceToSalesTrailing12Months),
    priceToBook: num(ks.priceToBook),
    evToEbitda: num(ks.enterpriseToEbitda),
    evToRevenue: num(ks.enterpriseToRevenue),
    trailingEps: num(ks.trailingEps),
    forwardEps: num(ks.forwardEps),
    // balance sheet and cash
    totalCash: num(fd.totalCash),
    totalDebt: num(fd.totalDebt),
    debtToEquity: num(fd.debtToEquity),
    currentRatio: num(fd.currentRatio),
    freeCashflow: num(fd.freeCashflow),
    operatingCashflow: num(fd.operatingCashflow),
    // income and ownership
    dividendYield: num(sd.dividendYield) ?? num(sd.yield),
    dividendRate: num(sd.dividendRate),
    payoutRatio: num(sd.payoutRatio),
    shortPctFloat: num(ks.shortPercentOfFloat),
    institutionsPct: num(ks.heldPercentInstitutions),
    insidersPct: num(ks.heldPercentInsiders),
    // trading
    beta5y: num(sd.beta) ?? num(ks.beta),
    fiftyTwoWeekHigh: num(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(sd.fiftyTwoWeekLow),
    fiftyDayAvg: num(sd.fiftyDayAverage),
    twoHundredDayAvg: num(sd.twoHundredDayAverage),
    change52w: num(ks['52WeekChange']),
    sp52w: num(ks.SandP52WeekChange),
    // funds
    expenseRatio: num(fp.feesExpensesInvestment?.annualReportExpenseRatio) ?? num(ks.annualReportExpenseRatio),
    fundAssets: num(ks.totalAssets) ?? num(sd.totalAssets),
    // earnings
    beatCount: hist.length ? beats : null,
    reportCount: hist.length || null,
    lastSurprise: hist.length ? num(hist[hist.length - 1].surprisePercent) : null,
    nextEarnings: nextEarn,
    nextEpsEstimate: num(ce.earningsAverage),
  };
}

function full(r, symbol, cf) {
  const ap = r.assetProfile || {}, fp = r.fundProfile || {}, th = r.topHoldings || {};
  const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, num(o?.[k])]));
  const trend = (r.recommendationTrend?.trend || []).map(t => ({ period: t.period, ...pick(t, ['strongBuy', 'buy', 'hold', 'sell', 'strongSell']) }));
  const actions = (r.upgradeDowngradeHistory?.history || []).slice(0, 12).map(a => ({
    date: num(a.epochGradeDate), firm: str(a.firm), from: str(a.fromGrade), to: str(a.toGrade), action: str(a.action),
    target: num(a.currentPriceTarget) || null, priorTarget: num(a.priorPriceTarget) || null,
  }));
  const history = (r.earningsHistory?.history || []).map(h => ({
    quarter: num(h.quarter), actual: num(h.epsActual), estimate: num(h.epsEstimate), surprisePct: num(h.surprisePercent),
  })).filter(h => h.quarter);
  const estimates = (r.earningsTrend?.trend || []).filter(t => /^[0+]/.test(t.period || '')).map(t => ({
    period: t.period, endDate: str(t.endDate), growth: num(t.growth),
    eps: num(t.earningsEstimate?.avg), epsLow: num(t.earningsEstimate?.low), epsHigh: num(t.earningsEstimate?.high),
    revenue: num(t.revenueEstimate?.avg), analysts: num(t.earningsEstimate?.numberOfAnalysts),
  }));
  const fc = r.earnings?.financialsChart || {};
  const series = arr => (arr || []).map(x => ({ date: String(x.date), revenue: num(x.revenue), earnings: num(x.earnings) }));
  const officers = (ap.companyOfficers || []).slice(0, 6).map(o => ({ name: str(o.name), title: str(o.title), age: num(o.age), pay: num(o.totalPay) }));
  const holdings = (th.holdings || []).slice(0, 10).map(h => ({ symbol: str(h.symbol), name: str(h.holdingName), pct: num(h.holdingPercent) }));
  const sectors = (th.sectorWeightings || []).map(o => { const [k, v] = Object.entries(o)[0] || []; return k ? { sector: k, pct: num(v) } : null; }).filter(Boolean);
  return {
    symbol,
    // fcfReported is the reported 12-month free cash flow; freeCashflow stays Yahoo's estimate so scores match the screener
    facts: { ...facts(r), fcfReported: cf?.fcf ?? null, capex: cf?.capex ?? null, fcfAsOf: cf?.asOf ?? null },
    profile: {
      summary: str(ap.longBusinessSummary) || str(ap.description),
      website: str(ap.website),
      city: str(ap.city), state: str(ap.state), country: str(ap.country),
      employees: num(ap.fullTimeEmployees),
      officers,
      startDate: str(ap.startDate),
      family: str(fp.family), legalType: str(fp.legalType),
    },
    analysts: { trend, actions },
    earnings: {
      history, estimates,
      quarterly: series(fc.quarterly), yearly: series(fc.yearly),
    },
    fund: holdings.length || sectors.length ? { holdings, sectors } : null,
    asOf: Date.now(),
  };
}

// Options pulse for the expiry closest to a month out (anything expiring within 5 days is skipped:
// those trade on the day's noise). Unusual activity scans that expiry and the next two.
const DAY = 86400;
const goodIv = v => Number.isFinite(v) && v > 0.04 && v < 5;   // outside market hours Yahoo reports near-zero junk
const mid = c => (c ? (c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.lastPrice > 0 ? c.lastPrice : null) : null);
const nearest = (list, x) => list.reduce((b, c) => (!b || Math.abs(c.strike - x) < Math.abs(b.strike - x) ? c : b), null);
const sum = (list, k) => list.reduce((s, c) => s + (Number(c[k]) || 0), 0);
const isoDay = t => new Date(t * 1000).toISOString().slice(0, 10);
export async function optionsSummary(sym, now = Date.now() / 1000) {
  const first = await optionChain(sym);
  const dates = (first?.expirationDates || []).filter(d => d - now > 5 * DAY);
  if (!dates.length) return null;
  const target = now + 30 * DAY;
  const exp = dates.reduce((b, d) => (Math.abs(d - target) < Math.abs(b - target) ? d : b), dates[0]);
  const scan = [exp, ...dates.filter(d => d > exp).slice(0, 2)];
  const chains = await Promise.all(scan.map(d => (first.options?.[0]?.expirationDate === d ? first : optionChain(sym, d))));
  const main = chains[0]?.options?.[0], price = chains[0]?.quote?.regularMarketPrice ?? first.quote?.regularMarketPrice;
  if (!main || !(price > 0)) return null;
  const calls = main.calls || [], puts = main.puts || [];
  const days = Math.max(1, (exp - now) / DAY);
  const atmC = nearest(calls, price), atmP = nearest(puts, price);
  const ivs = [atmC?.impliedVolatility, atmP?.impliedVolatility].filter(goodIv);
  const straddle = mid(atmC) != null && mid(atmP) != null ? mid(atmC) + mid(atmP) : null;
  // Quoted implied volatility when it's live; otherwise read it off the at-the-money straddle,
  // which costs about 0.8 x price x volatility x sqrt(years)
  const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length
    : straddle ? straddle / (0.7979 * price * Math.sqrt(days / 365)) : null;
  const move = iv ? price * iv * Math.sqrt(days / 365) : straddle;
  const callVol = sum(calls, 'volume'), putVol = sum(puts, 'volume'), callOi = sum(calls, 'openInterest'), putOi = sum(puts, 'openInterest');
  const hedge = nearest(puts.filter(p => p.strike <= price), price * 0.95);
  const hedgeCost = mid(hedge);
  const unusual = chains.flatMap((ch, i) => {
    const o = ch?.options?.[0];
    if (!o) return [];
    const tag = (c, type) => ({ type, strike: c.strike, expiry: isoDay(scan[i]), volume: c.volume || 0, openInterest: c.openInterest || 0, iv: goodIv(c.impliedVolatility) ? +c.impliedVolatility.toFixed(4) : null, last: c.lastPrice ?? null });
    return [...(o.calls || []).map(c => tag(c, 'call')), ...(o.puts || []).map(c => tag(c, 'put'))];
  }).filter(c => c.volume >= 500 && c.volume > 2 * c.openInterest).sort((a, b) => b.volume - a.volume).slice(0, 6);
  return {
    symbol: sym, price, expiry: isoDay(exp), days: Math.round(days),
    iv: iv != null ? +iv.toFixed(4) : null,
    expectedMove: move != null ? +move.toFixed(2) : null, expectedMovePct: move != null ? +(move / price).toFixed(4) : null,
    callVolume: callVol, putVolume: putVol, putCallVolume: callVol ? +(putVol / callVol).toFixed(2) : null,
    putCallOpenInterest: callOi ? +(putOi / callOi).toFixed(2) : null,
    protectivePut: hedge && hedgeCost ? { strike: hedge.strike, cost: +hedgeCost.toFixed(2), costPct: +(hedgeCost / price).toFixed(4) } : null,
    unusual, expiries: dates.length, asOf: Date.now(),
  };
}

export default async function handler(req, res) {
  const one = String(req.query?.symbol || '').toUpperCase().trim();
  if (one && req.query?.options) {
    if (!SYMBOL_RE.test(one)) return res.status(400).json({ error: 'Invalid symbol' });
    const o = await optionsSummary(one).catch(() => null);
    if (!o) { res.setHeader('Cache-Control', 's-maxage=300'); return res.status(404).json({ error: 'No options data for this symbol' }); }
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json(o);
  }
  if (one) {
    if (!SYMBOL_RE.test(one)) return res.status(400).json({ error: 'Invalid symbol' });
    const [r, cf] = await Promise.all([quoteSummary(one, FULL), trailingCashFlow(one).catch(() => null)]);
    if (!r) { res.setHeader('Cache-Control', 's-maxage=120'); return res.status(404).json({ error: 'No data for this symbol' }); }
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json(full(r, one, cf));
  }

  const symbols = [...new Set(String(req.query?.symbols || '').toUpperCase().split(',').map(x => x.trim()).filter(x => SYMBOL_RE.test(x)))].slice(0, 20);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });
  const out = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(5, symbols.length) }, async () => {
    while (next < symbols.length) {
      const s = symbols[next++];
      try { const r = await quoteSummary(s, LITE); if (r) out[s] = facts(r); } catch {}
    }
  }));
  res.setHeader('Cache-Control', Object.keys(out).length ? 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400' : 's-maxage=120');
  return res.status(200).json({ data: out });
}
