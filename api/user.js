// The signed-in user's own account row. Needs "Authorization: Bearer <token>" from /api/auth.
//   GET                                   -> { user }  (password hash, reset codes and Google id left out)
//   POST { patch: {...} }                 -> saves whitelisted columns (watchlist, portfolio, settings, ...)
//   POST { leaderboard: {...} | null }    -> joins / updates / leaves the paper trading leaderboard
import { configured, fail, readBody, sessionRow, safeRow, patchUser, db, WRITABLE_COLUMNS } from './_auth.js';

const MAX_PATCH_BYTES = 900_000;

function leaderboardName(email) {
  const local = email.split('@')[0];
  return (local.length <= 3 ? local : local.slice(0, 3)) + '***';
}
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return fail(res, 503, 'Accounts are temporarily unavailable.');
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  try {
    const row = await sessionRow(req);
    if (!row) return fail(res, 401, 'Please sign in again.');
    if (req.method === 'GET') return res.status(200).json({ user: safeRow(row) });

    const b = readBody(req);
    if ('leaderboard' in b) {
      const eq = `email=eq.${encodeURIComponent(row.email)}`;
      if (!b.leaderboard) {
        await db(`pt_leaderboard?${eq}`, { method: 'DELETE' });
        return res.status(200).json({ ok: true });
      }
      const value = num(b.leaderboard.value, 0, 1e9), ret = num(b.leaderboard.return_pct, -100, 1e7);
      const count = num(b.leaderboard.holdings_count, 0, 10000);
      if (value === null || ret === null || count === null) return fail(res, 400, 'Invalid leaderboard entry');
      await db('pt_leaderboard?on_conflict=email', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
          email: row.email, display_name: leaderboardName(row.email), value: Math.round(value * 100) / 100,
          return_pct: Math.round(ret * 100) / 100, holdings_count: Math.round(count), updated_at: new Date().toISOString(),
        },
      });
      return res.status(200).json({ ok: true });
    }

    const patch = {};
    for (const [k, v] of Object.entries(b.patch || {})) if (WRITABLE_COLUMNS.has(k)) patch[k] = v;
    if (!Object.keys(patch).length) return res.status(200).json({ ok: true });
    if (JSON.stringify(patch).length > MAX_PATCH_BYTES) return fail(res, 413, 'That is too much data to save at once.');
    if (typeof patch.name === 'string') patch.name = patch.name.replace(/[<>"'`]/g, '').trim().slice(0, 40);
    await patchUser(row.email, patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('user:', e.message, e.detail || '');
    return fail(res, 500, 'Could not save. Please try again.');
  }
}
