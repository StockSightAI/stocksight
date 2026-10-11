// The daily job (Vercel Cron, weekdays after the US close; see vercel.json and send-digest.js):
//  1. Price-alert emails: every alert whose target the latest price crossed gets one email, then is marked
//     fired so it never repeats (cron can run twice). Alerts saved without a direction get one from today's
//     price, so they wait for a real cross instead of firing at once.
//  2. Error summary: browsers report crashes to /api/community; the owner (DIGEST_REPORT_TO) gets a short
//     list of the past day's new ones, and reports older than 14 days are deleted.
import { db, patchUser, unsubscribeUrl } from './_auth.js';
import { UA } from './_yahoo.js';
import { ySym } from './_symbols.js';

const SITE = process.env.DIGEST_BASE_URL || 'https://stocksightai.com';
const FROM = 'StockSight <alerts@stocksightai.com>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 });

// Same shape the site saves: [{ ticker, targetPrice, direction, fired, createdAt, emailedAt }]; older saves were { TICKER: price }
export function normalizeAlerts(raw) {
  if (Array.isArray(raw)) return raw.filter(a => a && typeof a.ticker === 'string' && Number(a.targetPrice) > 0).map(a => ({ ...a, targetPrice: Number(a.targetPrice) }));
  if (raw && typeof raw === 'object') return Object.entries(raw).filter(([, p]) => Number(p) > 0).map(([ticker, p]) => ({ ticker, targetPrice: Number(p), direction: null, fired: false, createdAt: Date.now() }));
  return [];
}

async function latestPrices(tickers) {
  const bySym = Object.fromEntries(tickers.map(t => [ySym(t), t]));
  const syms = Object.keys(bySym), out = {};
  for (let i = 0; i < syms.length; i += 20) {
    const chunk = syms.slice(i, i + 20);
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=5d&interval=1d`,
          { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) continue;
        for (const [s, q] of Object.entries(await r.json() || {})) {
          const closes = (q?.close || []).filter(Number.isFinite);
          if (bySym[s] && closes.length) out[bySym[s]] = closes[closes.length - 1];
        }
        break;
      } catch {}
    }
  }
  return out;
}

function alertEmail(user, hits, unsub) {
  const first = String(user.name || '').trim().split(/\s+/)[0];
  const one = hits.length === 1 ? hits[0] : null;
  const subject = one
    ? `${one.ticker} is ${one.direction} your ${money(one.targetPrice)} alert`
    : `${hits.length} of your price alerts were hit`;
  const rows = hits.map(h => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #ece9f6">
      <a href="${SITE}/stock/${encodeURIComponent(h.ticker)}" style="font:800 17px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#4c3fc7;text-decoration:none">${esc(h.ticker)}</a>
      <div style="font:400 14px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#4a4766;margin-top:3px">Closed at <b style="color:#17152b">${money(h.price)}</b>, ${h.direction} your ${money(h.targetPrice)} target</div>
    </td></tr>`).join('');
  const html = `<div style="background:#f3f2fa;padding:24px 12px"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e8e6f3;border-radius:16px;padding:26px 24px">
    <div style="font:800 19px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#17152b">Stock<span style="color:#6c5ce7">Sight</span></div>
    <p style="font:700 20px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#17152b;margin:18px 0 4px">${first ? `${esc(first)}, ` : ''}${one ? 'your price alert was hit.' : 'some of your price alerts were hit.'}</p>
    <p style="font:400 14px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#8a87a3;margin:0 0 6px">Based on the latest closing prices.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
    <p style="margin:20px 0 0"><a href="${SITE}/stock/${encodeURIComponent(hits[0].ticker)}" style="display:inline-block;background:#6c5ce7;color:#fff;font:700 14px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;text-decoration:none;padding:11px 20px;border-radius:10px">See ${esc(hits[0].ticker)} on StockSight</a></p>
    <p style="font:400 12px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#8a87a3;margin:22px 0 0;line-height:1.6">Each alert emails you once. Set new ones on any stock page.
      <a href="${esc(unsub)}" style="color:#4c3fc7">Stop alert emails</a>. Not financial advice.${process.env.DIGEST_MAILING_ADDRESS ? `<br>StockSight · ${esc(process.env.DIGEST_MAILING_ADDRESS)}` : ''}</p>
  </div></div>`;
  const text = [subject, '', ...hits.map(h => `${h.ticker}: closed at ${money(h.price)}, ${h.direction} your ${money(h.targetPrice)} target. ${SITE}/stock/${h.ticker}`),
    '', `Stop alert emails: ${unsub}`, 'Not financial advice.'].join('\n');
  return { subject, html, text };
}

export async function runAlerts({ resendKey, now = Date.now(), send = true }) {
  let users;
  try { users = await db('users?select=email,name,alerts,alert_emails&alerts=not.is.null&limit=5000'); }
  catch { users = await db('users?select=email,name,alerts&alerts=not.is.null&limit=5000'); } // before the alert_emails column exists
  users = (Array.isArray(users) ? users : []).filter(u => u?.email);

  const lists = users.map(u => ({ u, alerts: normalizeAlerts(u.alerts) })).filter(x => x.alerts.some(a => !a.fired));
  const tickers = [...new Set(lists.flatMap(x => x.alerts.filter(a => !a.fired).map(a => a.ticker.toUpperCase())))];
  const prices = tickers.length ? await latestPrices(tickers) : {};

  const emails = [], updates = [];
  let fired = 0, directed = 0;
  for (const { u, alerts } of lists) {
    let changed = false;
    const hits = [];
    for (const a of alerts) {
      const price = prices[a.ticker.toUpperCase()];
      if (a.fired || price == null) continue;
      if (a.direction !== 'above' && a.direction !== 'below') {
        a.direction = price < a.targetPrice ? 'above' : 'below'; changed = true; directed++; continue;
      }
      if ((a.direction === 'above' && price >= a.targetPrice) || (a.direction === 'below' && price <= a.targetPrice)) {
        a.fired = true; a.firedAt = now; changed = true; fired++;
        if (u.alert_emails !== false) { a.emailedAt = now; hits.push({ ...a, ticker: a.ticker.toUpperCase(), price }); }
      }
    }
    if (hits.length) {
      const unsub = unsubscribeUrl(u.email, SITE, 'alerts');
      const { subject, html, text } = alertEmail(u, hits, unsub);
      emails.push({ from: FROM, to: [u.email], subject, html, text, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    }
    if (changed) updates.push({ email: u.email, alerts });
  }

  // Mark alerts first: a repeated cron run then finds nothing to send
  for (const up of updates) { try { await patchUser(up.email, { alerts: up.alerts }); } catch (e) { console.error('alerts: could not save', e.message); } }
  let sent = 0;
  const errors = [];
  if (send && emails.length) {
    for (let i = 0; i < emails.length; i += 100) {
      try {
        const r = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(emails.slice(i, i + 100)),
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) sent += Array.isArray(body.data) ? body.data.length : emails.slice(i, i + 100).length;
        else errors.push(body.message || r.status);
      } catch (e) { errors.push(e.message); }
    }
  }
  return { users: lists.length, tickers: tickers.length, priced: Object.keys(prices).length, fired, directed, emailed: sent, errors };
}

export async function runErrorSummary({ resendKey, now = Date.now() }) {
  const since = new Date(now - 864e5).toISOString();
  let rows = [];
  try { rows = await db(`client_errors?select=message,source,page,ua,at&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=2000`); }
  catch { return { errors: 0, note: 'client_errors table not set up yet' }; }
  try { await db(`client_errors?at=lt.${encodeURIComponent(new Date(now - 14 * 864e5).toISOString())}`, { method: 'DELETE' }); } catch {}
  rows = Array.isArray(rows) ? rows : [];
  const to = String(process.env.DIGEST_REPORT_TO || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!rows.length || !to.length || !resendKey) return { errors: rows.length };

  const groups = {};
  for (const r of rows) {
    const k = `${r.message}|${r.source}`;
    (groups[k] ||= { message: r.message, source: r.source, pages: new Set(), count: 0, last: r.at }).count++;
    groups[k].pages.add(r.page || '/');
  }
  const list = Object.values(groups).sort((a, b) => b.count - a.count).slice(0, 20);
  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#17152b;max-width:620px">
    <p style="font-size:18px;font-weight:800;margin:0 0 4px">${rows.length} error report${rows.length === 1 ? '' : 's'} from visitors' browsers</p>
    <p style="color:#666;margin:0 0 14px">Past 24 hours, grouped. Forward this to Claude to have them fixed.</p>
    ${list.map(g => `<div style="border:1px solid #e8e6f3;border-radius:10px;padding:10px 12px;margin:0 0 8px">
      <b>${esc(g.message).slice(0, 300)}</b><br><span style="color:#666;font-size:12px">${esc(g.source || 'unknown source')} · ${g.count}× · on ${esc([...g.pages].slice(0, 3).join(', '))}</span></div>`).join('')}
  </div>`;
  const text = list.map(g => `${g.count}x ${g.message} (${g.source || 'unknown'}) on ${[...g.pages].slice(0, 3).join(', ')}`).join('\n');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'StockSight <digest@stocksightai.com>', to, subject: `[StockSight] ${rows.length} site error report${rows.length === 1 ? '' : 's'} today`, html, text }),
    });
  } catch (e) { console.error('error summary not sent:', e.message); }
  return { errors: rows.length, groups: list.length };
}
