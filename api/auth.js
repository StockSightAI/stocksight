// Account sign-in, done on the server so password hashes and reset codes never reach browsers.
// POST { action, ... }:
//   signup          { name, email, password }
//   login           { email, password }
//   google          { accessToken } or { idToken }
//   reset-request   { email }                    emails a 6-digit code
//   reset-confirm   { email, code, password }
//   change-password { current, password }       needs the session token
//   delete          { password, confirm }        needs the session token
// Successful sign-ins return { token, user }. The token goes in "Authorization: Bearer <token>".
import crypto from 'node:crypto';
import {
  configured, fail, readBody, limited, ipOf, EMAIL_RE, getUserRow, insertUser, patchUser, deleteUserRow,
  hashPassword, verifyPassword, passwordProblem, signSession, sessionRow, publicUser, verifyGoogle, sendResetEmail, sha256,
} from './_auth.js';

const MIN = 60e3;
const CODE_TTL = 15 * MIN;
const MAX_CODE_TRIES = 5;

function signedIn(res, row) {
  return res.status(200).json({ token: signSession(row.email, row.token_version || 0), user: publicUser(row) });
}
const cleanName = n => String(n || '').replace(/[<>"'`]/g, '').trim().slice(0, 40);
const cleanEmail = e => String(e || '').trim().toLowerCase();

async function signup(req, res, b) {
  const email = cleanEmail(b.email), name = cleanName(b.name);
  if (!name) return fail(res, 400, 'Enter your first name.');
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'Enter a valid email address.');
  const bad = passwordProblem(b.password);
  if (bad) return fail(res, 400, bad);
  if (limited('signup:' + ipOf(req), 10, 60 * MIN)) return fail(res, 429, 'Too many new accounts from this network. Try again later.');

  const row = await getUserRow(email);
  if (row?.phash) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.', code: 'exists' });
  if (row?.google_id) return res.status(409).json({ error: 'This email signs in with Google. Use "Continue with Google".', code: 'google' });
  const phash = hashPassword(b.password);
  // A row with no password and no Google link (e.g. digest-only) gets claimed by the new account
  const saved = row ? await patchUser(email, { name, phash }) : await insertUser({ email, name, phash, mode: 'simple' });
  return signedIn(res, saved || { email, name, phash, mode: 'simple' });
}

async function login(req, res, b) {
  const email = cleanEmail(b.email);
  if (!EMAIL_RE.test(email) || typeof b.password !== 'string') return fail(res, 400, 'Enter your email and password.');
  if (limited('login-ip:' + ipOf(req), 30, 15 * MIN) || limited('login:' + email, 10, 15 * MIN)) {
    return fail(res, 429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
  const row = await getUserRow(email);
  if (!row) return res.status(401).json({ error: 'Incorrect email or password.', code: 'no_account' });
  if (!row.phash) {
    return res.status(401).json({ error: row.google_id ? 'This account signs in with Google. Use "Continue with Google".' : 'Incorrect email or password.', code: row.google_id ? 'google' : 'no_password' });
  }
  const check = verifyPassword(b.password, row.phash);
  if (!check.ok) return res.status(401).json({ error: 'Incorrect email or password.', code: 'wrong' });
  if (check.upgrade) await patchUser(email, { phash: hashPassword(b.password) }).catch(() => {});
  return signedIn(res, row);
}

async function google(req, res, b) {
  if (limited('google:' + ipOf(req), 30, 15 * MIN)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
  let g;
  try { g = await verifyGoogle({ accessToken: b.accessToken, idToken: b.idToken }); }
  catch (e) { return fail(res, 401, e.message); }
  let row = await getUserRow(g.email);
  if (!row) row = await insertUser({ email: g.email, name: cleanName(g.name) || 'User', google_id: g.sub, phash: '', mode: 'simple' });
  else if (!row.google_id) row = (await patchUser(g.email, { google_id: g.sub })) || row;
  return signedIn(res, row || { email: g.email, name: g.name });
}

async function resetRequest(req, res, b) {
  const email = cleanEmail(b.email);
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'Enter a valid email.');
  if (limited('reset-ip:' + ipOf(req), 8, 15 * MIN) || limited('reset:' + email, 3, 15 * MIN)) {
    return fail(res, 429, 'Too many code requests. Wait 15 minutes and try again.');
  }
  const row = await getUserRow(email);
  if (!row) return res.status(404).json({ error: 'No account found with that email.', code: 'no_account' });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await patchUser(email, { reset_token: sha256(email + ':' + code), reset_token_expiry: Date.now() + CODE_TTL, reset_attempts: 0 });
  try { await sendResetEmail(email, row.name, code); }
  catch (e) { console.error('reset email:', e.message); return fail(res, 502, 'We could not send the email. Try again in a minute.'); }
  return res.status(200).json({ ok: true });
}

async function resetConfirm(req, res, b) {
  const email = cleanEmail(b.email), code = String(b.code || '').trim();
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return fail(res, 400, 'Enter the 6-digit code.');
  const bad = passwordProblem(b.password);
  if (bad) return fail(res, 400, bad);
  if (limited('confirm-ip:' + ipOf(req), 20, 15 * MIN)) return fail(res, 429, 'Too many attempts. Wait 15 minutes and try again.');

  const row = await getUserRow(email);
  if (!row?.reset_token) return fail(res, 400, 'That code is no longer valid. Request a new one.');
  if (Date.now() > Number(row.reset_token_expiry || 0)) return fail(res, 400, 'Code expired. Request a new one.');
  if ((row.reset_attempts || 0) >= MAX_CODE_TRIES) {
    await patchUser(email, { reset_token: null, reset_token_expiry: null });
    return fail(res, 400, 'Too many wrong codes. Request a new one.');
  }
  const want = Buffer.from(row.reset_token), got = Buffer.from(sha256(email + ':' + code));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    await patchUser(email, { reset_attempts: (row.reset_attempts || 0) + 1 });
    return fail(res, 400, 'Incorrect code. Check your email.');
  }
  // New password signs out every other device
  const saved = await patchUser(email, {
    phash: hashPassword(b.password), reset_token: null, reset_token_expiry: null, reset_attempts: 0,
    token_version: (row.token_version || 0) + 1,
  });
  return signedIn(res, saved);
}

async function changePassword(req, res, b) {
  const row = await sessionRow(req);
  if (!row) return fail(res, 401, 'Please sign in again.');
  const bad = passwordProblem(b.password);
  if (bad) return fail(res, 400, bad);
  if (limited('change:' + row.email, 10, 15 * MIN)) return fail(res, 429, 'Too many attempts. Wait 15 minutes and try again.');
  // Google-only accounts have no password yet, so they can add one without a current password
  if (row.phash && !verifyPassword(String(b.current || ''), row.phash).ok) return fail(res, 403, 'Current password is incorrect.');
  const saved = await patchUser(row.email, { phash: hashPassword(b.password), token_version: (row.token_version || 0) + 1 });
  return signedIn(res, saved);
}

async function deleteAccount(req, res, b) {
  const row = await sessionRow(req);
  if (!row) return fail(res, 401, 'Please sign in again.');
  if (b.confirm !== 'DELETE') return fail(res, 400, 'Please type DELETE to confirm.');
  if (limited('delete:' + row.email, 10, 15 * MIN)) return fail(res, 429, 'Too many attempts. Wait 15 minutes and try again.');
  if (row.phash && !verifyPassword(String(b.password || ''), row.phash).ok) return fail(res, 403, 'Incorrect password. Please try again.');
  await deleteUserRow(row.email);
  return res.status(200).json({ ok: true });
}

const ACTIONS = {
  signup, login, google, 'reset-request': resetRequest, 'reset-confirm': resetConfirm,
  'change-password': changePassword, delete: deleteAccount,
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!configured()) {
    console.error('auth: SUPABASE_SERVICE_KEY is not set');
    return fail(res, 503, 'Sign-in is temporarily unavailable. Please try again soon.');
  }
  const b = readBody(req);
  const run = ACTIONS[b.action];
  if (!run) return fail(res, 400, 'Unknown action');
  try {
    return await run(req, res, b);
  } catch (e) {
    console.error(`auth ${b.action}:`, e.message, e.detail || '');
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}
