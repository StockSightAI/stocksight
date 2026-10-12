// The signed-in user's own account row. Needs "Authorization: Bearer <token>" from /api/auth.
//   GET                                   -> { user }  (password hash, reset codes and Google id left out)
//   POST { patch: {...} }                 -> saves whitelisted columns (watchlist, portfolio, settings, ...)
//   POST { leaderboard: {...} | null }    -> joins / updates / leaves the paper trading leaderboard
//   POST { avatar: "data:image/jpeg;base64,..." | null }  -> sets or removes the profile photo
import { configured, fail, readBody, sessionRow, safeRow, patchUser, db, limited, WRITABLE_COLUMNS, avatarPath, storagePublicUrl, storageUpload, storageDelete } from './_auth.js';
import { noteXp } from './_leagues.js';

const MAX_PATCH_BYTES = 900_000;

function leaderboardName(email) {
  const local = email.split('@')[0];
  return (local.length <= 3 ? local : local.slice(0, 3)) + '***';
}
// Real image bytes only: JPEG, PNG or WebP, checked by their first bytes rather than trusting the label
function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
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
    if ('avatar' in b) {
      if (limited('avatar:' + row.email, 12, 3600e3)) return fail(res, 429, 'Too many photo changes. Try again in an hour.');
      const path = avatarPath(row.email);
      if (b.avatar === null) {
        await storageDelete(path).catch(() => {});
        await patchUser(row.email, { avatar: null });
        return res.status(200).json({ ok: true, avatar: null });
      }
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.avatar || ''));
      if (!m) return fail(res, 400, 'Choose a JPG, PNG or WebP photo.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 400_000) return fail(res, 413, 'That photo is too large.');
      const kind = imageKind(buf);
      if (!kind) return fail(res, 400, "That file isn't a photo we can use.");
      await storageUpload(path, buf, `image/${kind}`);
      const url = `${storagePublicUrl(path)}?v=${Date.now().toString(36)}`;
      await patchUser(row.email, { avatar: url });
      return res.status(200).json({ ok: true, avatar: url });
    }
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
    if ('learn' in patch) {
      if (!patch.learn || typeof patch.learn !== 'object' || Array.isArray(patch.learn)) return fail(res, 400, 'Invalid learning progress');
      const before = Math.max(0, Number(row.learn?.xp) || 0), after = Math.max(0, Number(patch.learn.xp) || 0);
      // A first save carries XP earned before progress was saved to accounts; it doesn't count as this week's
      await noteXp(row.email, row.learn ? before : after, after);
    }
    await patchUser(row.email, patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('user:', e.message, e.detail || '');
    return fail(res, 500, 'Could not save. Please try again.');
  }
}
