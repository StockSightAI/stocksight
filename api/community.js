// Community data, kept on the server so it can't be stuffed from the browser.
//   POST { action: 'search', ticker }        someone looked up a ticker (once per person, ticker and day)
//   POST { action: 'vote', ticker, vote }    buy / hold / sell; needs the sign-in token, one vote per account
//   POST { action: 'error', message, ... }   a crash in someone's browser, kept for the daily error summary
//   GET  ?trending=1&days=1                  the most-searched real tickers (1 = today, up to 7)
//   GET  ?votes=TICKER                       vote counts, plus your own vote when signed in
// Friend leagues (api/_leagues.js), signed in:
//   GET  ?leagues=1                          your leagues, ranks and last week's winners
//   GET  ?league=CODE                        one league's board (members only)
//   GET  ?invite=CODE                        what an invite shows before joining (no sign-in needed)
//   POST { action: 'league-create', name } | 'league-join' { code } | 'league-leave' { code }
//        'league-rename' { code, name } | 'league-remove' { code, member } | 'league-delete' { code }
import crypto from 'node:crypto';
import { configured, fail, readBody, limited, ipOf, db, sessionRow, readSession } from './_auth.js';
import * as L from './_leagues.js';
import { logSearch, trending } from './_trending.js';
import { TICKER_RE } from './_symbols.js';

const VOTES = ['buy', 'hold', 'sell'];
// Same id the site used before votes moved here, so existing votes stay with their owners
const voterId = email => crypto.createHash('sha256').update('stocksight-vote:' + String(email).trim().toLowerCase()).digest('hex');

async function voteCounts(ticker) {
  const rows = await db(`votes?ticker=eq.${encodeURIComponent(ticker)}&select=vote&limit=100000`);
  const c = { buy: 0, hold: 0, sell: 0 };
  for (const r of Array.isArray(rows) ? rows : []) if (c[r.vote] != null) c[r.vote]++;
  return { ...c, total: c.buy + c.hold + c.sell };
}

export default async function handler(req, res) {
  if (!configured()) return fail(res, 503, 'Unavailable');
  try {
    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'error') {
        // Small, capped and best effort: the table may not exist yet, and reports never fail the page
        if (limited('err:' + ipOf(req), 20, 3600e3)) return res.status(204).end();
        const clip = (v, n) => String(v ?? '').slice(0, n);
        const row = { message: clip(b.message, 500), source: clip(b.source, 300), stack: clip(b.stack, 2000), page: clip(b.page, 200), ua: clip(req.headers?.['user-agent'], 200) };
        if (row.message) await db('client_errors', { method: 'POST', body: row, prefer: 'return=minimal' }).catch(() => {});
        return res.status(204).end();
      }

      if (String(b.action || '').startsWith('league-')) {
        const row = await sessionRow(req);
        if (!row) return fail(res, 401, 'Sign in to use leagues');
        if (limited('league:' + row.email, 60, 600e3)) return fail(res, 429, 'Too many changes. Try again in a few minutes.');
        const code = String(b.code || '').toUpperCase().trim();
        const out = b.action === 'league-create' ? (limited('league-new:' + row.email, 20, 864e5) ? { error: 429, message: 'You can start up to 20 leagues a day.' } : await L.create(row.email, b.name))
          : b.action === 'league-join' ? await L.join(row.email, code)
          : b.action === 'league-leave' ? await L.leave(row.email, code)
          : b.action === 'league-rename' ? await L.manage(row.email, code, { rename: b.name })
          : b.action === 'league-remove' ? await L.manage(row.email, code, { remove: String(b.member || '') })
          : b.action === 'league-delete' ? await L.manage(row.email, code, { del: true })
          : { error: 400, message: 'Unknown league action' };
        if (out.error) return fail(res, out.error, out.message || 'Could not do that');
        return res.status(200).json({ ok: true, ...out });
      }

      const ticker = String(b.ticker || '').toUpperCase().trim();
      if (!TICKER_RE.test(ticker)) return fail(res, 400, 'Invalid ticker');

      if (b.action === 'vote') {
        if (!VOTES.includes(b.vote)) return fail(res, 400, 'Invalid vote');
        const row = await sessionRow(req);
        if (!row) return fail(res, 401, 'Sign in to vote');
        if (limited('vote:' + row.email, 40, 600e3)) return fail(res, 429, 'Too many votes. Try again in a few minutes.');
        await db('votes?on_conflict=ticker,voter_hash', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
          body: { ticker, voter_hash: voterId(row.email), vote: b.vote },
        });
        return res.status(200).json({ ok: true, ...(await voteCounts(ticker)), mine: b.vote });
      }

      // A search (the default action)
      const ip = ipOf(req);
      if (limited('search:' + ip, 120, 3600e3)) return res.status(204).end();
      await logSearch(ticker, ip);
      return res.status(204).end();
    }

    if (req.method === 'GET') {
      if (req.query?.invite) {
        if (limited('invite:' + ipOf(req), 60, 600e3)) return fail(res, 429, 'Too many requests');
        const p = await L.invitePreview(String(req.query.invite).toUpperCase().trim());
        res.setHeader('Cache-Control', 'no-store');
        return p ? res.status(200).json(p) : fail(res, 404, "That invite doesn't match a league.");
      }
      if (req.query?.leagues || req.query?.league) {
        res.setHeader('Cache-Control', 'private, no-store');
        const row = await sessionRow(req);
        if (!row) return fail(res, 401, 'Sign in to see your leagues');
        if (req.query.leagues) return res.status(200).json(await L.summary(row.email));
        const d = await L.detail(row.email, String(req.query.league).toUpperCase().trim());
        if (d.error) return fail(res, d.error, d.error === 403 ? "You're not in this league." : 'League not found.');
        return res.status(200).json(d);
      }
      if (req.query?.votes) {
        const ticker = String(req.query.votes).toUpperCase().trim();
        if (!TICKER_RE.test(ticker)) return fail(res, 400, 'Invalid ticker');
        const counts = await voteCounts(ticker);
        // Your own vote, if you're signed in (a valid signature is enough to read it)
        const s = readSession(req);
        let mine = null;
        if (s) {
          const r = await db(`votes?ticker=eq.${encodeURIComponent(ticker)}&voter_hash=eq.${voterId(s.email)}&select=vote&limit=1`);
          mine = Array.isArray(r) && r[0] ? r[0].vote : null;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({ ticker, ...counts, mine });
      }
      const days = Math.min(7, Math.max(1, Number(req.query?.days) || 1));
      const list = await trending({ days, limit: 8 });
      res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=900');
      return res.status(200).json({ trending: list, days });
    }
    return fail(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('community:', e.message, e.detail || '');
    return fail(res, 500, 'Community data unavailable');
  }
}
