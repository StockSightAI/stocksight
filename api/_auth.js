// Shared helpers for /api/auth and /api/user. Not an endpoint (files starting with "_" aren't deployed as one).
//
// Env vars (Vercel dashboard):
//   SUPABASE_SERVICE_KEY  Required. Supabase secret (service_role) key. Never sent to browsers.
//   RESEND_API_KEY        Required for password reset emails.
//   SESSION_SECRET        Optional. Signs sign-in sessions; defaults to SUPABASE_SERVICE_KEY.
//   SUPABASE_URL          Optional. Defaults to the StockSight project.
import crypto from 'node:crypto';

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fgcjbdqvnjzafgnahwai.supabase.co';
const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_KEY || '';
const SESSION_SECRET = () => process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
export const GOOGLE_CLIENT_ID = '215107020140-9n8h7eaor1fl1rlvtnjf1vg5l6upu4ei.apps.googleusercontent.com';
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const SESSION_DAYS = 60;

// Columns the browser may never see or set
const SECRET_COLUMNS = ['phash', 'ph', 'reset_token', 'reset_token_expiry', 'reset_attempts', 'token_version', 'google_id'];
// Columns a signed-in user may change on their own row
export const WRITABLE_COLUMNS = new Set([
  'name', 'mode', 'watchlist', 'portfolio', 'alerts', 'notes', 'streak_count', 'streak_last_date', 'settings', 'avatar',
  'broker', 'tutorial_done', 'onboarding_done', 'pending_orders', 'investor_profile', 'risk_tolerance', 'invest_style',
  'investment_goals', 'preferred_sectors', 'digest',
]);

export function configured() { return !!SERVICE_KEY(); }
export function fail(res, status, error) { return res.status(status).json({ error }); }

/* ── Database (service role, server only) ── */
export async function db(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw Object.assign(new Error(`Database error ${r.status}`), { status: r.status, detail: data });
  return data;
}
const eqEmail = email => `email=eq.${encodeURIComponent(email)}`;
export async function getUserRow(email) {
  const rows = await db(`users?${eqEmail(email)}&select=*&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
export async function patchUser(email, patch) {
  const rows = await db(`users?${eqEmail(email)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  return Array.isArray(rows) ? rows[0] || null : null;
}
export async function insertUser(row) {
  const rows = await db('users', { method: 'POST', body: row, prefer: 'return=representation' });
  return Array.isArray(rows) ? rows[0] || null : null;
}
export async function deleteUserRow(email) {
  await db(`pt_leaderboard?${eqEmail(email)}`, { method: 'DELETE' }).catch(() => {});
  await db(`users?${eqEmail(email)}`, { method: 'DELETE' });
}
export function safeRow(row) {
  if (!row) return null;
  const out = { ...row };
  SECRET_COLUMNS.forEach(k => delete out[k]);
  out.has_password = !!row.phash;
  out.google_linked = !!row.google_id;
  return out;
}
export function publicUser(row) {
  return { name: row.name || '', email: row.email, mode: row.mode || 'simple', createdAt: row.created_at || null, hasPassword: !!row.phash };
}

/* ── Passwords ──
 New hashes: scrypt with a random salt. Older accounts were stored as unsalted SHA-256 ("sha256:<hex>")
 or a legacy short hash ("h..."); those still verify and are upgraded on the next successful sign-in. */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function legacyShort(s) {
  let h = 0;
  for (const c of s) { h = ((h << 5) - h) + c.charCodeAt(0); h |= 0; }
  return 'h' + Math.abs(h).toString(36);
}
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return { ok: false };
  if (stored.startsWith('scrypt$')) {
    const [, salt, key] = stored.split('$');
    const test = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    return { ok: same(test.toString('base64'), key), upgrade: false };
  }
  if (stored.startsWith('sha256:')) {
    const hex = crypto.createHash('sha256').update(pw).digest('hex');
    return { ok: same('sha256:' + hex, stored), upgrade: true };
  }
  return { ok: same(legacyShort(pw), stored), upgrade: true };
}
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Password must be at least 6 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

/* ── Sessions: "<payload>.<signature>", signed with SESSION_SECRET ── */
const b64u = buf => Buffer.from(buf).toString('base64url');
export function signSession(email, version = 0) {
  const payload = b64u(JSON.stringify({ e: email, v: version, exp: Date.now() + SESSION_DAYS * 86400e3 }));
  const sig = b64u(crypto.createHmac('sha256', SESSION_SECRET()).update(payload).digest());
  return `${payload}.${sig}`;
}
export function readSession(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const [payload, sig] = tok.split('.');
  if (!payload || !sig || !SESSION_SECRET()) return null;
  const want = b64u(crypto.createHmac('sha256', SESSION_SECRET()).update(payload).digest());
  if (!same(want, sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!s.e || !s.exp || s.exp < Date.now()) return null;
    return { email: s.e, version: s.v || 0 };
  } catch { return null; }
}
// The session's row, or null if the session was revoked (password changed, account deleted)
export async function sessionRow(req) {
  const s = readSession(req);
  if (!s) return null;
  const row = await getUserRow(s.email);
  if (!row || (row.token_version || 0) !== s.version) return null;
  return row;
}

/* ── Rate limits (per server instance, best effort) ── */
const hits = new Map();
export function limited(key, max, windowMs) {
  const now = Date.now(), e = hits.get(key);
  if (!e || now > e.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  e.n++;
  return e.n > max;
}
export const ipOf = req => (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

/* ── Google: confirm the token was issued to StockSight and the email is verified ── */
export async function verifyGoogle({ accessToken, idToken }) {
  const q = idToken ? `id_token=${encodeURIComponent(idToken)}` : `access_token=${encodeURIComponent(accessToken || '')}`;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?${q}`);
  if (!r.ok) throw new Error('Google could not verify this sign-in');
  const info = await r.json();
  if (info.aud !== GOOGLE_CLIENT_ID && info.azp !== GOOGLE_CLIENT_ID) throw new Error('Google sign-in was for a different app');
  if (String(info.email_verified) !== 'true' || !info.email) throw new Error('Google account email is not verified');
  let given = info.given_name, name = info.name;
  if (!idToken && !given) {
    try {
      const u = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      given = u.given_name; name = u.name;
    } catch {}
  }
  return { email: info.email.toLowerCase(), sub: info.sub, name: given || (name || '').split(' ')[0] || 'User' };
}

/* ── Password reset email ── */
export async function sendResetEmail(email, name, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.AUTH_DEV_LOG_CODES === '1') { console.log(`[dev] reset code for ${email}: ${code}`); return; }
    throw new Error('RESEND_API_KEY is not set');
  }
  const safeName = String(name || '').replace(/[^a-zA-Z\s\-']/g, '').slice(0, 60);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'StockSight <noreply@stocksightai.com>',
      to: email,
      subject: 'Your StockSight password reset code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#05050e;color:#ffffff;border-radius:16px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#6c5ce7,#a29bfe);padding:28px 32px;text-align:center">
            <h1 style="margin:0;font-size:24px;font-weight:900;color:#fff">StockSight</h1>
            <p style="margin:4px 0 0;font-size:14px;color:rgba(255,255,255,0.8)">Password Reset</p>
          </div>
          <div style="padding:32px">
            <p style="margin:0 0 8px;color:#ccc;font-size:15px">Hi${safeName ? ' ' + safeName : ''},</p>
            <p style="margin:0 0 24px;color:#ccc;font-size:15px">Here is your 6-digit reset code:</p>
            <div style="background:rgba(108,92,231,0.15);border:2px dashed rgba(108,92,231,0.5);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
              <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#a29bfe">${code}</span>
            </div>
            <p style="margin:0 0 8px;color:#888;font-size:13px">This code expires in <strong style="color:#fff">15 minutes</strong>.</p>
            <p style="margin:0;color:#888;font-size:13px">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
          </div>
          <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.08);text-align:center">
            <p style="margin:0;color:#555;font-size:12px">StockSight · stocksightai.com</p>
          </div>
        </div>`,
    }),
  });
  if (!r.ok) throw new Error('Email delivery failed');
}
export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
