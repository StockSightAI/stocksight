// Friend leagues: small private leaderboards that friends join with a code or an invite link.
// The score is XP earned this week (Monday to Sunday, UTC). It resets every Monday, when the Monday cron
// (send-digest.js) saves last week's standings and emails each member how their leagues ended.
//
// Tables (server only, service key): leagues, league_members, xp_weeks, league_results.
// xp_weeks holds everyone's total XP at the start of each week; /api/user records it the first time
// a user's XP changes in a new week, so weekly XP = XP now (or at next week's start) minus that.
import crypto from 'node:crypto';
import { db, unsubscribeUrl, SUPABASE_URL } from './_auth.js';

export const MAX_MEMBERS = 50, MAX_LEAGUES = 10;
export const WEEKLY_CAP = 3000;   // more than this in one week can't come from playing, so it doesn't count
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z2-9]{6}$/;
const SITE = process.env.DIGEST_BASE_URL || 'https://stocksightai.com';
const FROM = 'StockSight <leagues@stocksightai.com>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Levels: the same ladder as LEARN_LEVELS in app.js (a test keeps them in step) ── */
export const LEVEL_MINS = [0, 100, 220, 360, 520, 750, 1050, 1400];
const LEVEL_NAMES = ['Rookie', 'Learner', 'Analyst', 'Strategist', 'Market Pro', 'Expert', 'Master', 'Legend'];
export function levelOf(xp) {
  xp = Math.max(0, Number(xp) || 0);
  let i = 0;
  LEVEL_MINS.forEach((m, j) => { if (xp >= m) i = j; });
  const top = LEVEL_MINS.length - 1;
  if (i === top) { const extra = Math.floor((xp - LEVEL_MINS[top]) / 400); return { n: top + 1 + extra, name: extra ? `Legend ${extra + 1}` : 'Legend' }; }
  return { n: i + 1, name: LEVEL_NAMES[i] };
}
// The profile ring a level earns (shown around photos everywhere, including leagues)
export const ringOf = n => n >= 8 ? 'legend' : n >= 6 ? 'gold' : n >= 5 ? 'silver' : n >= 2 ? 'bronze' : '';

/* ── Weeks (UTC, starting Monday) ── */
export function weekKey(t = Date.now()) {
  const d = new Date(t);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
export const weekShift = (w, n) => weekKey(Date.parse(w + 'T12:00:00Z') + n * 7 * 864e5);
export const weekEndsAt = w => Date.parse(w + 'T00:00:00Z') + 7 * 864e5;

/* ── People ── */
export const memberId = email => crypto.createHash('sha256').update('member:' + String(email).toLowerCase()).digest('hex').slice(0, 16);
export function displayName(name, email) {
  const parts = String(name || '').replace(/[<>"'`]/g, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length) return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
  return String(email || '').split('@')[0].slice(0, 3) + '…';
}
// Only photos stored by our own upload count (older accounts may still hold an emoji here)
export function avatarUrl(a) {
  const s = String(a || '');
  return s.startsWith(`${SUPABASE_URL}/storage/v1/object/public/avatars/`) ? s : null;
}
function streakOf(learn) {
  const last = String(learn?.dlast || '');
  if (!last) return 0;
  return last >= new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10) ? (Number(learn.dstreak) || 0) : 0;
}
const inList = vals => encodeURIComponent(`in.(${vals.map(v => `"${String(v).replace(/["\\]/g, '')}"`).join(',')})`);
const enc = encodeURIComponent;
const list = r => (Array.isArray(r) ? r : []);

/* ── First XP change of a week: remember where the week started ── */
export async function noteXp(email, before, after) {
  if (after === before) return;
  await db('xp_weeks?on_conflict=email,week', {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
    body: { email, week: weekKey(), start_xp: Math.max(0, Math.round(before)) },
  }).catch(e => console.warn('xp_weeks:', e.message));
}

/* ── Standings for many leagues at once ──
 For week W: weekly XP = (start of W+1, or XP now) - start of W, capped. No start row means no XP that week. */
export async function boards(leagues, week = weekKey()) {
  if (!leagues.length) return {};
  const mems = list(await db(`league_members?league_id=${inList(leagues.map(l => l.id))}&select=league_id,email,joined_at&order=joined_at.asc&limit=${leagues.length * MAX_MEMBERS}`));
  const emails = [...new Set(mems.map(m => m.email))];
  const [users, starts, nexts] = emails.length ? await Promise.all([
    db(`users?email=${inList(emails)}&select=email,name,avatar,learn&limit=${emails.length}`),
    db(`xp_weeks?email=${inList(emails)}&week=eq.${week}&select=email,start_xp&limit=${emails.length}`),
    db(`xp_weeks?email=${inList(emails)}&week=eq.${weekShift(week, 1)}&select=email,start_xp&limit=${emails.length}`),
  ]) : [[], [], []];
  const U = Object.fromEntries(list(users).map(u => [u.email, u]));
  const S = Object.fromEntries(list(starts).map(r => [r.email, Number(r.start_xp) || 0]));
  const N = Object.fromEntries(list(nexts).map(r => [r.email, Number(r.start_xp) || 0]));
  const out = {};
  for (const l of leagues) {
    const rows = mems.filter(m => m.league_id === l.id).map(m => {
      const u = U[m.email] || {}, xp = Math.max(0, Number(u.learn?.xp) || 0), lv = levelOf(xp);
      const end = N[m.email] ?? xp, weekXp = S[m.email] == null ? 0 : Math.max(0, Math.min(WEEKLY_CAP, end - S[m.email]));
      return { email: m.email, id: memberId(m.email), name: displayName(u.name, m.email), avatar: avatarUrl(u.avatar), xp, weekXp, level: lv.n, title: lv.name, ring: ringOf(lv.n), streak: streakOf(u.learn), owner: m.email === l.owner_email, joinedAt: m.joined_at };
    });
    rows.sort((a, b) => b.weekXp - a.weekXp || b.xp - a.xp || String(a.joinedAt).localeCompare(String(b.joinedAt)));
    rows.forEach((r, i) => { r.rank = i + 1; });
    out[l.id] = rows;
  }
  return out;
}
// What a member may see about the others: never their email
const publicRow = (r, me) => ({ id: r.id, name: r.name, avatar: r.avatar, weekXp: r.weekXp, xp: r.xp, level: r.level, title: r.title, ring: r.ring, streak: r.streak, rank: r.rank, owner: r.owner, me: r.email === me });

async function leagueByCode(code) {
  if (!CODE_RE.test(code)) return null;
  const r = list(await db(`leagues?code=eq.${enc(code)}&select=id,code,name,owner_email,created_at&limit=1`));
  return r[0] || null;
}
async function myLeagueRows(email) {
  const mem = list(await db(`league_members?email=eq.${enc(email)}&select=league_id&limit=${MAX_LEAGUES + 5}`));
  if (!mem.length) return [];
  return list(await db(`leagues?id=${inList(mem.map(m => m.league_id))}&select=id,code,name,owner_email,created_at&order=created_at.asc`));
}

/* ── What the app asks for ── */
export async function summary(email) {
  const leagues = await myLeagueRows(email);
  const week = weekKey(), last = weekShift(week, -1);
  const [now, prev, wins] = await Promise.all([
    boards(leagues, week), boards(leagues, last),
    db(`league_results?winner_email=eq.${enc(email)}&select=week&limit=500`).catch(() => []),
  ]);
  return {
    week, endsAt: weekEndsAt(week), wins: list(wins).length,
    leagues: leagues.map(l => {
      const rows = now[l.id] || [], mine = rows.find(r => r.email === email), lastRows = (prev[l.id] || []).filter(r => r.weekXp > 0);
      return {
        code: l.code, name: l.name, owner: l.owner_email === email, members: rows.length,
        rank: mine?.rank || null, weekXp: mine?.weekXp || 0,
        top: rows.slice(0, 3).map(r => publicRow(r, email)),
        lastWinner: lastRows[0] ? { name: lastRows[0].name, weekXp: lastRows[0].weekXp, me: lastRows[0].email === email } : null,
      };
    }),
  };
}

export async function detail(email, code) {
  const l = await leagueByCode(code);
  if (!l) return { error: 404 };
  const week = weekKey();
  const [now, prev] = await Promise.all([boards([l], week), boards([l], weekShift(week, -1))]);
  const rows = now[l.id] || [];
  if (!rows.some(r => r.email === email)) return { error: 403 };
  const lastRows = (prev[l.id] || []).filter(r => r.weekXp > 0);
  return {
    code: l.code, name: l.name, owner: l.owner_email === email, week, endsAt: weekEndsAt(week),
    members: rows.map(r => publicRow(r, email)),
    lastWeek: lastRows.slice(0, 3).map(r => ({ name: r.name, weekXp: r.weekXp, me: r.email === email })),
    max: MAX_MEMBERS,
  };
}

// What an invite link shows before joining: the league's name and size, never who is in it
export async function invitePreview(code) {
  const l = await leagueByCode(code);
  if (!l) return null;
  const [mem, owner] = await Promise.all([
    db(`league_members?league_id=eq.${l.id}&select=email&limit=${MAX_MEMBERS + 1}`),
    db(`users?email=eq.${enc(l.owner_email)}&select=name&limit=1`).catch(() => []),
  ]);
  return { code: l.code, name: l.name, members: list(mem).length, by: displayName(list(owner)[0]?.name, '').replace(/…$/, '') || null, full: list(mem).length >= MAX_MEMBERS };
}

const cleanName = s => String(s || '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
function newCode() { const b = crypto.randomBytes(6); return [...b].map(x => CODE_ABC[x % CODE_ABC.length]).join(''); }

export async function create(email, rawName) {
  const name = cleanName(rawName);
  if (name.length < 2) return { error: 400, message: 'Give your league a name (2 to 30 characters).' };
  if ((await myLeagueRows(email)).length >= MAX_LEAGUES) return { error: 409, message: `You can be in up to ${MAX_LEAGUES} leagues. Leave one to start another.` };
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    try {
      const rows = list(await db('leagues', { method: 'POST', prefer: 'return=representation', body: { code, name, owner_email: email } }));
      if (!rows[0]) continue;
      await db('league_members', { method: 'POST', prefer: 'return=minimal', body: { league_id: rows[0].id, email } });
      return { code, name };
    } catch (e) { if (e.status !== 409) throw e; }
  }
  return { error: 503, message: 'Could not create the league. Please try again.' };
}

export async function join(email, code) {
  const l = await leagueByCode(code);
  if (!l) return { error: 404, message: "That code doesn't match a league. Check it and try again." };
  const mem = list(await db(`league_members?league_id=eq.${l.id}&select=email&limit=${MAX_MEMBERS + 1}`));
  if (mem.some(m => m.email === email)) return { code: l.code, name: l.name, already: true };
  if (mem.length >= MAX_MEMBERS) return { error: 409, message: `That league is full (${MAX_MEMBERS} people).` };
  if ((await myLeagueRows(email)).length >= MAX_LEAGUES) return { error: 409, message: `You can be in up to ${MAX_LEAGUES} leagues. Leave one to join this one.` };
  await db('league_members?on_conflict=league_id,email', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { league_id: l.id, email } });
  return { code: l.code, name: l.name };
}

// Leaving: the owner's role passes to whoever joined next; an empty league is deleted
export async function leave(email, code) {
  const l = await leagueByCode(code);
  if (!l) return { error: 404, message: 'League not found.' };
  await db(`league_members?league_id=eq.${l.id}&email=eq.${enc(email)}`, { method: 'DELETE' });
  const rest = list(await db(`league_members?league_id=eq.${l.id}&select=email,joined_at&order=joined_at.asc&limit=1`));
  if (!rest.length) await db(`leagues?id=eq.${l.id}`, { method: 'DELETE' });
  else if (l.owner_email === email) await db(`leagues?id=eq.${l.id}`, { method: 'PATCH', body: { owner_email: rest[0].email } });
  return { ok: true };
}
export async function leaveAll(email) {
  for (const l of await myLeagueRows(email)) await leave(email, l.code);
}

export async function manage(email, code, { rename, remove, del }) {
  const l = await leagueByCode(code);
  if (!l) return { error: 404, message: 'League not found.' };
  if (l.owner_email !== email) return { error: 403, message: 'Only the person who runs this league can do that.' };
  if (del) { await db(`leagues?id=eq.${l.id}`, { method: 'DELETE' }); return { ok: true }; }
  if (rename != null) {
    const name = cleanName(rename);
    if (name.length < 2) return { error: 400, message: 'Give your league a name (2 to 30 characters).' };
    await db(`leagues?id=eq.${l.id}`, { method: 'PATCH', body: { name } });
    return { ok: true, name };
  }
  if (remove) {
    const mem = list(await db(`league_members?league_id=eq.${l.id}&select=email&limit=${MAX_MEMBERS + 1}`));
    const target = mem.find(m => memberId(m.email) === remove);
    if (!target) return { error: 404, message: 'That person is not in this league.' };
    if (target.email === email) return { error: 400, message: 'To leave your own league, use Leave.' };
    await db(`league_members?league_id=eq.${l.id}&email=eq.${enc(target.email)}`, { method: 'DELETE' });
    return { ok: true };
  }
  return { error: 400, message: 'Nothing to change.' };
}

/* ── Monday: save last week's standings and email every member how their leagues ended ── */
function resultsEmail(user, items, unsub) {
  const first = String(user.name || '').trim().split(/\s+/)[0];
  const won = items.filter(x => x.rank === 1);
  const subject = won.length ? `You won ${won[0].name}${won.length > 1 ? ` and ${won.length - 1} more` : ''} this week`
    : items.length === 1 ? `You finished #${items[0].rank} in ${items[0].name}` : `Your league results for last week`;
  const F = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  const rows = items.map(x => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #ece9f6">
      <div style="font:800 16px ${F};color:#17152b">${esc(x.name)}</div>
      <div style="font:400 14px ${F};color:#4a4766;margin-top:4px">${x.rank === 1 ? '<b style="color:#4c3fc7">You won</b>' : `You finished <b style="color:#17152b">#${x.rank}</b> of ${x.of}`} with ${x.weekXp} XP.${x.rank === 1 ? '' : ` ${esc(x.winner)} won with ${x.winnerXp} XP.`}</div>
    </td></tr>`).join('');
  const html = `<div style="background:#f3f2fa;padding:24px 12px"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e8e6f3;border-radius:16px;padding:26px 24px">
    <div style="font:800 19px ${F};color:#17152b">Stock<span style="color:#6c5ce7">Sight</span></div>
    <p style="font:700 20px ${F};color:#17152b;margin:18px 0 4px">${first ? `${esc(first)}, ` : ''}${won.length ? 'you won your league.' : 'here is how your league week ended.'}</p>
    <p style="font:400 14px ${F};color:#8a87a3;margin:0 0 6px">A new week started Monday. Everyone is back to 0 XP.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
    <p style="margin:20px 0 0"><a href="${SITE}/leagues" style="display:inline-block;background:#6c5ce7;color:#fff;font:700 14px ${F};text-decoration:none;padding:11px 20px;border-radius:10px">See this week's board</a></p>
    <p style="font:400 13px ${F};color:#4a4766;margin:14px 0 0">Today's 5-question challenge is worth up to 70 XP.</p>
    <p style="font:400 12px ${F};color:#8a87a3;margin:22px 0 0;line-height:1.6">You get this because you're in a StockSight league.
      <a href="${esc(unsub)}" style="color:#4c3fc7">Stop league emails</a>. Not financial advice.${process.env.DIGEST_MAILING_ADDRESS ? `<br>StockSight · ${esc(process.env.DIGEST_MAILING_ADDRESS)}` : ''}</p>
  </div></div>`;
  const text = [subject, '', ...items.map(x => `${x.name}: ${x.rank === 1 ? 'you won' : `#${x.rank} of ${x.of}`} with ${x.weekXp} XP${x.rank === 1 ? '' : ` (${x.winner} won with ${x.winnerXp})`}.`),
    '', `This week's board: ${SITE}/leagues`, `Stop league emails: ${unsub}`].join('\n');
  return { subject, html, text };
}

export async function runLeagueWeek({ resendKey, now = Date.now(), send = true }) {
  const week = weekShift(weekKey(now), -1);   // the week that just ended
  const leagues = list(await db('leagues?select=id,code,name,owner_email&limit=5000'));
  const B = await boards(leagues, week);
  const perUser = {};
  let finalized = 0;
  for (const l of leagues) {
    const rows = B[l.id] || [];
    if (rows.length < 2 || !rows[0].weekXp) continue;   // nobody competed: nothing to report
    const saved = list(await db('league_results?on_conflict=league_id,week', {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: { league_id: l.id, week, winner_email: rows[0].email, results: rows.slice(0, 10).map(r => ({ id: r.id, name: r.name, weekXp: r.weekXp, rank: r.rank })) },
    }));
    if (!saved.length) continue;   // already done (the cron can run twice)
    finalized++;
    for (const r of rows) {
      (perUser[r.email] ||= []).push({ name: l.name, rank: r.rank, of: rows.length, weekXp: r.weekXp, winner: rows[0].name, winnerXp: rows[0].weekXp });
    }
  }
  const emails = Object.keys(perUser);
  let users = [];
  if (emails.length) {
    try { users = list(await db(`users?email=${inList(emails)}&select=email,name,league_emails&limit=${emails.length}`)); }
    catch { users = list(await db(`users?email=${inList(emails)}&select=email,name&limit=${emails.length}`)); }   // before league_emails exists
  }
  const batch = users.filter(u => u.league_emails !== false).map(u => {
    const unsub = unsubscribeUrl(u.email, SITE, 'leagues');
    const { subject, html, text } = resultsEmail(u, perUser[u.email], unsub);
    return { from: FROM, to: [u.email], subject, html, text, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  });
  let sent = 0;
  const errors = [];
  if (send && resendKey) {
    for (let i = 0; i < batch.length; i += 100) {
      try {
        const r = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `leagues-${week}-${i}` },
          body: JSON.stringify(batch.slice(i, i + 100)),
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) sent += Array.isArray(body.data) ? body.data.length : batch.slice(i, i + 100).length;
        else errors.push(body.message || r.status);
      } catch (e) { errors.push(e.message); }
    }
  }
  return { week, leagues: leagues.length, finalized, emailed: sent, errors };
}
