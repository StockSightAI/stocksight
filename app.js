/* StockSight app: everything that runs the site.
   Loaded from index.html with <script defer src="/app.js">, so the page (and the landing screen) can
   draw while this downloads. It runs after the HTML is parsed, before DOMContentLoaded, like the inline
   script it used to be. */
/* ════════════════════════════════
 SUPABASE CONFIG
════════════════════════════════ */
const SUPABASE_URL = 'https://fgcjbdqvnjzafgnahwai.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OfRLOYvNWFmq2x9qF5ix1g_7ynysTdY';
// Public, read-only data straight from Supabase (today only the leaderboard). Everything private goes through /api.
async function sbRead(path) {
 const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
 if (!r.ok) throw new Error('Supabase read failed: ' + r.status);
 return r.json();
}

/* ── Account API ──
 Sign-in runs on the server (/api/auth), and the user's own row is read and saved through /api/user
 with a signed session token, so password hashes and reset codes never reach the browser. */
const TOKEN_KEY = 'ss_tok';
const getTok = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setTok = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

async function authApi(action, body = {}, withSession = false) {
 try {
 const headers = { 'Content-Type': 'application/json' };
 if (withSession && getTok()) headers.Authorization = 'Bearer ' + getTok();
 const r = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify({ action, ...body }) });
 const d = await r.json().catch(() => ({}));
 if (r.status === 401 && withSession) await sessionExpired();
 if (!r.ok) return { ok: false, status: r.status, code: d.code, error: d.error || 'Something went wrong. Please try again.' };
 return { ok: true, ...d };
 } catch {
 return { ok: false, status: 0, error: 'Could not reach StockSight. Check your connection and try again.' };
 }
}

async function accountApi(method, body) {
 if (!getTok()) return { data: null, error: { message: 'Not signed in' } };
 try {
 const r = await fetch('/api/user', {
 method,
 headers: { Authorization: 'Bearer ' + getTok(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
 body: body ? JSON.stringify(body) : undefined,
 });
 const d = await r.json().catch(() => ({}));
 if (r.status === 401) { await sessionExpired(); return { data: null, error: { message: 'Signed out' } }; }
 if (!r.ok) return { data: null, error: { message: d.error || 'Request failed' } };
 return { data: d, error: null };
 } catch (e) { return { data: null, error: { message: e.message } }; }
}

// Stand-in for usersTable() with the same chaining (select/update/upsert/eq/single/maybeSingle).
// It always reads or saves the signed-in user's own row.
function usersTable() {
 let patch = null;
 const run = async () => {
 if (!patch) { const { data, error } = await accountApi('GET'); return { data: data?.user || null, error }; }
 const { email, ...rest } = patch;
 const { error } = await accountApi('POST', { patch: rest });
 return { data: null, error };
 };
 const q = {
 select: () => q, eq: () => q, single: () => q, maybeSingle: () => q,
 update: p => { patch = p; return q; }, upsert: p => { patch = p; return q; },
 then: (res, rej) => run().then(res, rej),
 };
 return q;
}

// The session token is missing, expired or revoked (e.g. password changed on another device)
let _sessionEnding = false;
async function sessionExpired(msg) {
 if (_sessionEnding || !user) return;
 _sessionEnding = true;
 try { await logout(); } finally { _sessionEnding = false; }
 setTimeout(() => toast(msg || 'Your session ended. Please sign in again.', 'info', 5000), 400);
}

// Starts the session from a successful /api/auth response
async function startSession(d) {
 setTok(d.token);
 const u = { name: d.user.name || '', email: d.user.email, mode: d.user.mode || 'simple', createdAt: d.user.createdAt || new Date().toISOString(), hasPassword: d.user.hasPassword !== false };
 const users = await getU();
 users[u.email] = { name: u.name, email: u.email, mode: u.mode, createdAt: u.createdAt };
 await setU(users);
 await setSess(u);
 resetSessionData();
 document.getElementById('signupNudge')?.remove();
 user = u;
 return u;
}

/* ── Supabase user helpers ── */

// Sync local user data up to Supabase (called on login + signup)
async function syncUserToSupabase(u) {
 if (!u?.email) return;
 try {
 const e = u.email;
 const watchlistData = await sg('ss3_wl_'+e) || [];
 const holdingsData = await sg('ss3_h_'+e) || [];
 const prefs = await sg('ss3_p_'+e) || {};
 const pt = safeParse('ss_pt_'+e, {cash:10000,holdings:{}});
 const alerts = safeParse('ss_alerts_'+e, []);
 const notes = safeParse('ss_notes_'+e, {});
 const streakData = safeParse('ss_streak_'+e, {});

 const avatar = localStorage.getItem('ss_avatar_'+e) || '';
 const payload = {
 email: e,
 name: u.name || '',
 watchlist: watchlistData,
 portfolio: { holdings: holdingsData, paper_trade: pt, prefs },
 alerts: alerts,
 notes: notes,
 streak_count: streakData.count || 0,
 streak_last_date: streakData.lastDate || '',
 settings: prefs,
 avatar: avatar
 };

 await usersTable().update(payload);
 } catch(err) {
 console.warn('Supabase sync failed (non-critical):', err.message);
 }
}


// trackSearch is defined in the TRENDING ON STOCKSIGHT section below
// (records locally for badges + inserts into Supabase for community trending)

// Community votes live on the server: one vote per signed-in account per ticker (api/community.js)
async function getVotes(ticker) {
 try {
  const r = await fetch('/api/community?votes=' + encodeURIComponent(ticker.toUpperCase()), { headers: getTok() ? { Authorization: 'Bearer ' + getTok() } : {} });
  if (!r.ok) return null;
  return await r.json();
 } catch { return null; }
}

// Cast or update a community vote for a ticker
async function castVote(ticker, vote) {
 if (!user?.email) { showToast('Sign in to vote', 'info'); return; }
 try {
 const r = await fetch('/api/community', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getTok() },
  body: JSON.stringify({ action: 'vote', ticker: ticker.toUpperCase(), vote }),
 });
 if (r.status === 401) { await sessionExpired(); return; }
 if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save vote');
 showToast(`Voted ${vote.toUpperCase()} on ${ticker}`, 'success');
 renderVoteBar(ticker);
 renderPoll(ticker);
 } catch(err) {
 showToast(err.message || 'Could not save vote', 'warn');
 }
}

// Get vote counts for a ticker and render them
async function renderVoteBar(ticker) {
 const el = document.getElementById('voteBar_'+ticker);
 if (!el) return;
 if (!TREND_TICKER_RE.test(String(ticker).toUpperCase())) return;
 try {
 // Counts, plus this account's own vote when signed in
 const data = await getVotes(ticker);
 if (!data) throw new Error('unavailable');
 const total = data.total || 0;
 const bp = total ? Math.round((data.buy/total)*100) : 0;
 const hp2 = total ? Math.round((data.hold/total)*100) : 0;
 const sp = total ? Math.round((data.sell/total)*100) : 0;
 const userVote = user?.email ? data.mine : null;

 el.innerHTML = `
 <div>
 <div style="display:flex;gap:6px;margin-bottom:10px">
 <button onclick="castVote('${ticker}','buy')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${userVote==='buy'?'var(--green)':'var(--border)'};background:${userVote==='buy'?'rgba(0,201,122,.12)':'var(--card2)'};color:${userVote==='buy'?'var(--green)':'var(--text2)'};font-family:inherit;font-size:.73rem;font-weight:700;cursor:pointer;transition:all .15s">
 Buy
 </button>
 <button onclick="castVote('${ticker}','hold')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${userVote==='hold'?'var(--gold)':'var(--border)'};background:${userVote==='hold'?'rgba(253,203,110,.12)':'var(--card2)'};color:${userVote==='hold'?'var(--gold)':'var(--text2)'};font-family:inherit;font-size:.73rem;font-weight:700;cursor:pointer;transition:all .15s">
 Hold
 </button>
 <button onclick="castVote('${ticker}','sell')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${userVote==='sell'?'var(--red)':'var(--border)'};background:${userVote==='sell'?'rgba(255,71,87,.12)':'var(--card2)'};color:${userVote==='sell'?'var(--red)':'var(--text2)'};font-family:inherit;font-size:.73rem;font-weight:700;cursor:pointer;transition:all .15s">
 Sell
 </button>
 </div>
 ${total > 0 ? `
 <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;margin-bottom:6px">
 ${bp>0?`<div style="width:${bp}%;background:var(--green);border-radius:4px;transition:width .5s ease"></div>`:''}
 ${hp2>0?`<div style="width:${hp2}%;background:var(--gold);border-radius:4px;transition:width .5s ease"></div>`:''}
 ${sp>0?`<div style="width:${sp}%;background:var(--red);border-radius:4px;transition:width .5s ease"></div>`:''}
 </div>
 <div style="display:flex;justify-content:space-between;font-size:.65rem">
 <span style="color:var(--green)"> ${bp}%</span>
 <span style="color:var(--gold)"> ${hp2}%</span>
 <span style="color:var(--red)"> ${sp}%</span>
 </div>
 <div style="text-align:center;font-size:.62rem;color:var(--text3);margin-top:4px">${total} community vote${total!==1?'s':''}</div>
 ` : `<div style="text-align:center;font-size:.72rem;color:var(--text3);padding:4px 0">No votes yet — be the first! </div>`}
 </div>`;
 } catch {
 el.innerHTML = '<span style="font-size:.7rem;color:var(--text3)">Vote data unavailable</span>';
 }
}


/* ════════════════════════════════
 GLOBAL UTILITIES (must be first — used throughout the file)
════════════════════════════════ */

// Safe JSON.parse — never throws; returns fallback on bad data
function safeParse(key, fallback) {
 try {
 const raw = localStorage.getItem(key);
 if (raw === null || raw === undefined) return fallback;
 const parsed = JSON.parse(raw);
 return parsed ?? fallback;
 } catch { return fallback; }
}

// XSS guard — escape user-supplied strings before inserting into innerHTML
function escapeHTML(str) {
 return String(str ?? '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#039;');
}

// SHA-256 password hash (async, returns hex string)
// Falls back gracefully if crypto.subtle is unavailable (non-HTTPS context)
async function hashPassword(pw) {
 try {
 const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
 return 'sha256:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
 } catch {
 // Fallback to legacy djb2 hash — keeps app working in plain file:// contexts
 return hp(pw);
 }
}

/* ════════════════════════════════
 TICKER MAP
════════════════════════════════ */
const TICKERS = [
 // ── MEGA CAP TECH ──
 {t:'AAPL',n:'Apple',k:'s'},{t:'MSFT',n:'Microsoft',k:'s'},{t:'GOOGL',n:'Alphabet (Google)',k:'s'},
 {t:'GOOG',n:'Alphabet Class C',k:'s'},{t:'AMZN',n:'Amazon',k:'s'},{t:'META',n:'Meta Platforms',k:'s'},
 {t:'TSLA',n:'Tesla',k:'s'},{t:'NVDA',n:'NVIDIA',k:'s'},{t:'NFLX',n:'Netflix',k:'s'},
 {t:'AMD',n:'AMD',k:'s'},{t:'INTC',n:'Intel',k:'s'},{t:'ORCL',n:'Oracle',k:'s'},
 {t:'PYPL',n:'PayPal',k:'s'},{t:'SPOT',n:'Spotify',k:'s'},{t:'SHOP',n:'Shopify',k:'s'},
 {t:'CRM',n:'Salesforce',k:'s'},{t:'ADBE',n:'Adobe',k:'s'},{t:'QCOM',n:'Qualcomm',k:'s'},
 {t:'TXN',n:'Texas Instruments',k:'s'},{t:'AVGO',n:'Broadcom',k:'s'},{t:'MU',n:'Micron Technology',k:'s'},
 {t:'AMAT',n:'Applied Materials',k:'s'},{t:'LRCX',n:'Lam Research',k:'s'},{t:'KLAC',n:'KLA Corporation',k:'s'},
 {t:'MRVL',n:'Marvell Technology',k:'s'},{t:'ARM',n:'ARM Holdings',k:'s'},{t:'SMCI',n:'Super Micro Computer',k:'s'},
 {t:'HPQ',n:'HP Inc.',k:'s'},{t:'HPE',n:'Hewlett Packard Enterprise',k:'s'},{t:'DELL',n:'Dell Technologies',k:'s'},
 {t:'IBM',n:'IBM',k:'s'},{t:'ACN',n:'Accenture',k:'s'},{t:'NOW',n:'ServiceNow',k:'s'},
 {t:'SNOW',n:'Snowflake',k:'s'},{t:'CRWD',n:'CrowdStrike',k:'s'},{t:'DDOG',n:'Datadog',k:'s'},
 {t:'ZS',n:'Zscaler',k:'s'},{t:'NET',n:'Cloudflare',k:'s'},{t:'OKTA',n:'Okta',k:'s'},
 {t:'TWLO',n:'Twilio',k:'s'},{t:'MDB',n:'MongoDB',k:'s'},{t:'ESTC',n:'Elastic',k:'s'},
 {t:'GTLB',n:'GitLab',k:'s'},{t:'S',n:'SentinelOne',k:'s'},{t:'TEAM',n:'Atlassian',k:'s'},
 {t:'WDAY',n:'Workday',k:'s'},{t:'ANSS',n:'ANSYS',k:'s'},{t:'CDNS',n:'Cadence Design',k:'s'},
 {t:'SNPS',n:'Synopsys',k:'s'},{t:'NXPI',n:'NXP Semiconductors',k:'s'},{t:'MPWR',n:'Monolithic Power',k:'s'},
 {t:'ON',n:'ON Semiconductor',k:'s'},{t:'STX',n:'Seagate',k:'s'},{t:'WDC',n:'Western Digital',k:'s'},
 {t:'TER',n:'Teradyne',k:'s'},{t:'FORM',n:'FormFactor',k:'s'},{t:'COHR',n:'Coherent Corp',k:'s'},
 // ── FINANCE & BANKING ──
 {t:'JPM',n:'JPMorgan Chase',k:'s'},{t:'BAC',n:'Bank of America',k:'s'},{t:'V',n:'Visa',k:'s'},
 {t:'MA',n:'Mastercard',k:'s'},{t:'GS',n:'Goldman Sachs',k:'s'},{t:'MS',n:'Morgan Stanley',k:'s'},
 {t:'WFC',n:'Wells Fargo',k:'s'},{t:'C',n:'Citigroup',k:'s'},{t:'AXP',n:'American Express',k:'s'},
 {t:'BLK',n:'BlackRock',k:'s'},{t:'SCHW',n:'Charles Schwab',k:'s'},{t:'USB',n:'US Bancorp',k:'s'},
 {t:'PNC',n:'PNC Financial',k:'s'},{t:'TFC',n:'Truist Financial',k:'s'},{t:'COF',n:'Capital One',k:'s'},
 {t:'DFS',n:'Discover Financial',k:'s'},{t:'AIG',n:'AIG',k:'s'},{t:'MET',n:'MetLife',k:'s'},
 {t:'PRU',n:'Prudential Financial',k:'s'},{t:'AFL',n:'Aflac',k:'s'},{t:'ALL',n:'Allstate',k:'s'},
 {t:'TRV',n:'Travelers Companies',k:'s'},{t:'CB',n:'Chubb',k:'s'},{t:'MMC',n:'Marsh & McLennan',k:'s'},
 {t:'ICE',n:'Intercontinental Exchange',k:'s'},{t:'CME',n:'CME Group',k:'s'},{t:'CBOE',n:'Cboe Global Markets',k:'s'},
 {t:'COIN',n:'Coinbase',k:'s'},{t:'HOOD',n:'Robinhood',k:'s'},{t:'BRK.B',n:'Berkshire Hathaway',k:'s'},
 {t:'BRK.A',n:'Berkshire Hathaway A',k:'s'},{t:'MCO',n:'Moody\'s',k:'s'},{t:'SPGI',n:'S&P Global',k:'s'},
 {t:'FIS',n:'Fidelity National Info',k:'s'},{t:'FISV',n:'Fiserv',k:'s'},{t:'GPN',n:'Global Payments',k:'s'},
 // ── CONSUMER & RETAIL ──
 {t:'WMT',n:'Walmart',k:'s'},{t:'TGT',n:'Target',k:'s'},{t:'COST',n:'Costco',k:'s'},
 {t:'HD',n:'Home Depot',k:'s'},{t:'LOW',n:'Lowe\'s',k:'s'},{t:'MCD',n:'McDonald\'s',k:'s'},
 {t:'SBUX',n:'Starbucks',k:'s'},{t:'NKE',n:'Nike',k:'s'},{t:'LULU',n:'Lululemon',k:'s'},
 {t:'BKNG',n:'Booking Holdings',k:'s'},{t:'ABNB',n:'Airbnb',k:'s'},{t:'UBER',n:'Uber',k:'s'},
 {t:'LYFT',n:'Lyft',k:'s'},{t:'DPZ',n:'Domino\'s Pizza',k:'s'},{t:'YUM',n:'Yum! Brands',k:'s'},
 {t:'CMG',n:'Chipotle',k:'s'},{t:'DNUT',n:'Krispy Kreme',k:'s'},{t:'SHAK',n:'Shake Shack',k:'s'},
 {t:'WING',n:'Wingstop',k:'s'},{t:'QSR',n:'Restaurant Brands (Burger King)',k:'s'},
 {t:'KO',n:'Coca-Cola',k:'s'},{t:'PEP',n:'PepsiCo',k:'s'},{t:'MDLZ',n:'Mondelez',k:'s'},
 {t:'KHC',n:'Kraft Heinz',k:'s'},{t:'GIS',n:'General Mills',k:'s'},{t:'K',n:'Kellanova',k:'s'},
 {t:'CPB',n:'Campbell Soup',k:'s'},{t:'HRL',n:'Hormel Foods',k:'s'},{t:'SJM',n:'J.M. Smucker',k:'s'},
 {t:'STZ',n:'Constellation Brands',k:'s'},{t:'BF.B',n:'Brown-Forman',k:'s'},{t:'TAP',n:'Molson Coors',k:'s'},
 {t:'CLX',n:'Clorox',k:'s'},{t:'PG',n:'Procter & Gamble',k:'s'},{t:'CL',n:'Colgate-Palmolive',k:'s'},
 {t:'KMB',n:'Kimberly-Clark',k:'s'},{t:'CHD',n:'Church & Dwight',k:'s'},{t:'ELF',n:'e.l.f. Beauty',k:'s'},
 {t:'ULTA',n:'Ulta Beauty',k:'s'},{t:'CPRT',n:'Copart',k:'s'},{t:'EBAY',n:'eBay',k:'s'},
 {t:'ETSY',n:'Etsy',k:'s'},{t:'W',n:'Wayfair',k:'s'},{t:'CHWY',n:'Chewy',k:'s'},
 // ── HEALTHCARE & PHARMA ──
 {t:'JNJ',n:'Johnson & Johnson',k:'s'},{t:'UNH',n:'UnitedHealth Group',k:'s'},{t:'PFE',n:'Pfizer',k:'s'},
 {t:'MRNA',n:'Moderna',k:'s'},{t:'ABBV',n:'AbbVie',k:'s'},{t:'LLY',n:'Eli Lilly',k:'s'},
 {t:'BMY',n:'Bristol-Myers Squibb',k:'s'},{t:'GILD',n:'Gilead Sciences',k:'s'},{t:'ISRG',n:'Intuitive Surgical',k:'s'},
 {t:'CVS',n:'CVS Health',k:'s'},{t:'HCA',n:'HCA Healthcare',k:'s'},{t:'AMGN',n:'Amgen',k:'s'},
 {t:'BIIB',n:'Biogen',k:'s'},{t:'REGN',n:'Regeneron',k:'s'},{t:'VRTX',n:'Vertex Pharmaceuticals',k:'s'},
 {t:'ILMN',n:'Illumina',k:'s'},{t:'IDXX',n:'IDEXX Laboratories',k:'s'},{t:'EW',n:'Edwards Lifesciences',k:'s'},
 {t:'BSX',n:'Boston Scientific',k:'s'},{t:'BAX',n:'Baxter International',k:'s'},{t:'BDX',n:'Becton Dickinson',k:'s'},
 {t:'MDT',n:'Medtronic',k:'s'},{t:'SYK',n:'Stryker',k:'s'},{t:'ZBH',n:'Zimmer Biomet',k:'s'},
 {t:'TMO',n:'Thermo Fisher Scientific',k:'s'},{t:'DHR',n:'Danaher',k:'s'},{t:'A',n:'Agilent Technologies',k:'s'},
 {t:'IQV',n:'IQVIA',k:'s'},{t:'CNC',n:'Centene',k:'s'},{t:'HUM',n:'Humana',k:'s'},
 {t:'CI',n:'Cigna',k:'s'},{t:'MCK',n:'McKesson',k:'s'},{t:'ABC',n:'AmerisourceBergen',k:'s'},
 {t:'NVAX',n:'Novavax',k:'s'},{t:'BNTX',n:'BioNTech',k:'s'},{t:'SRPT',n:'Sarepta Therapeutics',k:'s'},
 {t:'RARE',n:'Ultragenyx',k:'s'},{t:'ACAD',n:'ACADIA Pharmaceuticals',k:'s'},
 // ── ENERGY ──
 {t:'XOM',n:'ExxonMobil',k:'s'},{t:'CVX',n:'Chevron',k:'s'},{t:'COP',n:'ConocoPhillips',k:'s'},
 {t:'SLB',n:'SLB (Schlumberger)',k:'s'},{t:'OXY',n:'Occidental Petroleum',k:'s'},{t:'NEE',n:'NextEra Energy',k:'s'},
 {t:'ENPH',n:'Enphase Energy',k:'s'},{t:'HAL',n:'Halliburton',k:'s'},{t:'BKR',n:'Baker Hughes',k:'s'},
 {t:'PSX',n:'Phillips 66',k:'s'},{t:'VLO',n:'Valero Energy',k:'s'},{t:'MPC',n:'Marathon Petroleum',k:'s'},
 {t:'EOG',n:'EOG Resources',k:'s'},{t:'DVN',n:'Devon Energy',k:'s'},{t:'FANG',n:'Diamondback Energy',k:'s'},
 {t:'APA',n:'APA Corporation',k:'s'},{t:'MRO',n:'Marathon Oil',k:'s'},{t:'EQT',n:'EQT Corporation',k:'s'},
 {t:'D',n:'Dominion Energy',k:'s'},{t:'DUK',n:'Duke Energy',k:'s'},{t:'SO',n:'Southern Company',k:'s'},
 {t:'AEP',n:'American Electric Power',k:'s'},{t:'EXC',n:'Exelon',k:'s'},{t:'XEL',n:'Xcel Energy',k:'s'},
 {t:'SRE',n:'Sempra Energy',k:'s'},{t:'PCG',n:'PG&E',k:'s'},{t:'WEC',n:'WEC Energy',k:'s'},
 {t:'FSLR',n:'First Solar',k:'s'},{t:'RUN',n:'Sunrun',k:'s'},{t:'PLUG',n:'Plug Power',k:'s'},
 {t:'BE',n:'Bloom Energy',k:'s'},{t:'CHPT',n:'ChargePoint',k:'s'},
 // ── MEDIA, TELECOM & ENTERTAINMENT ──
 {t:'DIS',n:'Disney',k:'s'},{t:'PARA',n:'Paramount Global',k:'s'},{t:'WBD',n:'Warner Bros. Discovery',k:'s'},
 {t:'RBLX',n:'Roblox',k:'s'},{t:'EA',n:'Electronic Arts',k:'s'},{t:'TTWO',n:'Take-Two Interactive',k:'s'},
 {t:'SNAP',n:'Snapchat / Snap',k:'s'},{t:'PINS',n:'Pinterest',k:'s'},{t:'RDDT',n:'Reddit',k:'s'},
 {t:'MTCH',n:'Match Group',k:'s'},{t:'T',n:'AT&T',k:'s'},{t:'VZ',n:'Verizon',k:'s'},
 {t:'TMUS',n:'T-Mobile',k:'s'},{t:'CHTR',n:'Charter Communications',k:'s'},{t:'CMCSA',n:'Comcast',k:'s'},
 {t:'FOXA',n:'Fox Corporation A',k:'s'},{t:'FOX',n:'Fox Corporation B',k:'s'},
 {t:'NYT',n:'New York Times',k:'s'},{t:'IAC',n:'IAC',k:'s'},{t:'ZETA',n:'Zeta Global',k:'s'},
 {t:'TTD',n:'The Trade Desk',k:'s'},{t:'MGNI',n:'Magnite',k:'s'},{t:'IAS',n:'Integral Ad Science',k:'s'},
 // ── INDUSTRIALS & AEROSPACE ──
 {t:'BA',n:'Boeing',k:'s'},{t:'LMT',n:'Lockheed Martin',k:'s'},{t:'RTX',n:'RTX (Raytheon)',k:'s'},
 {t:'NOC',n:'Northrop Grumman',k:'s'},{t:'GD',n:'General Dynamics',k:'s'},{t:'HII',n:'Huntington Ingalls',k:'s'},
 {t:'LHX',n:'L3Harris Technologies',k:'s'},{t:'GE',n:'GE Aerospace',k:'s'},{t:'HON',n:'Honeywell',k:'s'},
 {t:'MMM',n:'3M',k:'s'},{t:'EMR',n:'Emerson Electric',k:'s'},{t:'ITW',n:'Illinois Tool Works',k:'s'},
 {t:'PH',n:'Parker Hannifin',k:'s'},{t:'ROK',n:'Rockwell Automation',k:'s'},{t:'ETN',n:'Eaton',k:'s'},
 {t:'AME',n:'AMETEK',k:'s'},{t:'ROP',n:'Roper Technologies',k:'s'},{t:'FTV',n:'Fortive',k:'s'},
 {t:'IR',n:'Ingersoll Rand',k:'s'},{t:'TT',n:'Trane Technologies',k:'s'},{t:'CARR',n:'Carrier Global',k:'s'},
 {t:'OTIS',n:'Otis Worldwide',k:'s'},{t:'XYL',n:'Xylem',k:'s'},{t:'JCI',n:'Johnson Controls',k:'s'},
 {t:'UPS',n:'United Parcel Service',k:'s'},{t:'FDX',n:'FedEx',k:'s'},{t:'EXPD',n:'Expeditors',k:'s'},
 {t:'NSC',n:'Norfolk Southern',k:'s'},{t:'UNP',n:'Union Pacific',k:'s'},{t:'CSX',n:'CSX',k:'s'},
 {t:'DAL',n:'Delta Air Lines',k:'s'},{t:'UAL',n:'United Airlines',k:'s'},{t:'AAL',n:'American Airlines',k:'s'},
 {t:'LUV',n:'Southwest Airlines',k:'s'},{t:'ALK',n:'Alaska Air',k:'s'},{t:'JBLU',n:'JetBlue',k:'s'},
 {t:'CAT',n:'Caterpillar',k:'s'},{t:'DE',n:'Deere & Company',k:'s'},{t:'AGCO',n:'AGCO',k:'s'},
 // ── EV & AUTOS ──
 {t:'RIVN',n:'Rivian',k:'s'},{t:'LCID',n:'Lucid Motors',k:'s'},{t:'F',n:'Ford',k:'s'},
 {t:'GM',n:'General Motors',k:'s'},{t:'TM',n:'Toyota',k:'s'},{t:'HMC',n:'Honda',k:'s'},
 {t:'STLA',n:'Stellantis',k:'s'},{t:'RACE',n:'Ferrari',k:'s'},{t:'POAHY',n:'Porsche',k:'s'},
 {t:'NIO',n:'NIO',k:'s'},{t:'XPEV',n:'XPeng',k:'s'},{t:'LI',n:'Li Auto',k:'s'},
 {t:'FSR',n:'Fisker',k:'s'},{t:'NKLA',n:'Nikola',k:'s'},
 // ── FINTECH & EMERGING TECH ──
 {t:'PLTR',n:'Palantir',k:'s'},{t:'SOFI',n:'SoFi Technologies',k:'s'},{t:'HIMS',n:'Hims & Hers',k:'s'},
 {t:'UPST',n:'Upstart',k:'s'},{t:'AFRM',n:'Affirm',k:'s'},{t:'SQ',n:'Block (Square)',k:'s'},
 {t:'DKNG',n:'DraftKings',k:'s'},{t:'RKLB',n:'Rocket Lab',k:'s'},{t:'IONQ',n:'IonQ',k:'s'},
 {t:'JOBY',n:'Joby Aviation',k:'s'},{t:'PATH',n:'UiPath',k:'s'},{t:'AI',n:'C3.ai',k:'s'},
 {t:'BBAI',n:'BigBear.ai',k:'s'},{t:'SOUN',n:'SoundHound AI',k:'s'},{t:'CAI',n:'Cantor Equity Partners',k:'s'},
 {t:'RXRX',n:'Recursion Pharmaceuticals',k:'s'},{t:'SDCL',n:'Sprinklr',k:'s'},
 {t:'ASAN',n:'Asana',k:'s'},{t:'MSTR',n:'MicroStrategy',k:'s'},{t:'CLSK',n:'CleanSpark',k:'s'},
 {t:'CIFR',n:'Cipher Mining',k:'s'},{t:'RIOT',n:'Riot Platforms',k:'s'},{t:'MARA',n:'Marathon Digital',k:'s'},
 {t:'HUT',n:'Hut 8 Mining',k:'s'},{t:'BITO',n:'Bitcoin Strategy ETF',k:'s'},
 // ── REAL ESTATE REITs ──
 {t:'AMT',n:'American Tower',k:'s'},{t:'PLD',n:'Prologis',k:'s'},{t:'EQIX',n:'Equinix',k:'s'},
 {t:'SPG',n:'Simon Property Group',k:'s'},{t:'O',n:'Realty Income',k:'s'},{t:'WELL',n:'Welltower',k:'s'},
 {t:'DLR',n:'Digital Realty',k:'s'},{t:'PSA',n:'Public Storage',k:'s'},{t:'EXR',n:'Extra Space Storage',k:'s'},
 {t:'AVB',n:'AvalonBay Communities',k:'s'},{t:'EQR',n:'Equity Residential',k:'s'},{t:'MAA',n:'Mid-America Apartment',k:'s'},
 {t:'VTR',n:'Ventas',k:'s'},{t:'DOC',n:'Physicians Realty',k:'s'},{t:'NNN',n:'National Retail Properties',k:'s'},
 {t:'WPC',n:'W. P. Carey',k:'s'},{t:'KIM',n:'Kimco Realty',k:'s'},{t:'REG',n:'Regency Centers',k:'s'},
 // ── ETFs ──
 {t:'SPY',n:'S&P 500 ETF (SPY)',k:'s'},{t:'QQQ',n:'NASDAQ 100 ETF (QQQ)',k:'s'},
 {t:'IWM',n:'Russell 2000 ETF (IWM)',k:'s'},{t:'VOO',n:'Vanguard S&P 500',k:'s'},
 {t:'VTI',n:'Vanguard Total Market',k:'s'},{t:'GLD',n:'Gold ETF (GLD)',k:'s'},
 {t:'ARKK',n:'ARK Innovation ETF',k:'s'},{t:'SOXL',n:'Semiconductor Bull 3x',k:'s'},
 {t:'TQQQ',n:'NASDAQ 3x Bull ETF',k:'s'},{t:'SQQQ',n:'NASDAQ 3x Bear ETF',k:'s'},
 {t:'SPXL',n:'S&P 500 3x Bull ETF',k:'s'},{t:'SPXS',n:'S&P 500 3x Bear ETF',k:'s'},
 {t:'XLF',n:'Financial Select Sector ETF',k:'s'},{t:'XLK',n:'Technology Select Sector ETF',k:'s'},
 {t:'XLE',n:'Energy Select Sector ETF',k:'s'},{t:'XLV',n:'Health Care Select Sector ETF',k:'s'},
 {t:'XLI',n:'Industrial Select Sector ETF',k:'s'},{t:'XLY',n:'Consumer Discretionary ETF',k:'s'},
 {t:'XLP',n:'Consumer Staples ETF',k:'s'},{t:'XLU',n:'Utilities ETF',k:'s'},
 {t:'VNQ',n:'Vanguard Real Estate ETF',k:'s'},{t:'IAU',n:'iShares Gold Trust',k:'s'},
 {t:'SLV',n:'Silver ETF (SLV)',k:'s'},{t:'USO',n:'US Oil Fund',k:'s'},{t:'UNG',n:'Natural Gas ETF',k:'s'},
 {t:'HYG',n:'High Yield Bond ETF',k:'s'},{t:'TLT',n:'Long-Term Treasury ETF',k:'s'},
 {t:'AGG',n:'Core US Bond ETF',k:'s'},{t:'VEA',n:'Vanguard Developed Markets',k:'s'},
 {t:'VWO',n:'Vanguard Emerging Markets',k:'s'},{t:'EEM',n:'iShares MSCI Emerging Markets',k:'s'},
 {t:'EFA',n:'iShares MSCI EAFE',k:'s'},{t:'IEMG',n:'iShares Core MSCI EM',k:'s'},
 {t:'ARKG',n:'ARK Genomic Revolution ETF',k:'s'},{t:'ARKQ',n:'ARK Autonomous Tech ETF',k:'s'},
 {t:'ARKW',n:'ARK Next Gen Internet ETF',k:'s'},{t:'BOTZ',n:'Global X Robotics & AI ETF',k:'s'},
 {t:'MSOS',n:'US Cannabis ETF',k:'s'},{t:'KWEB',n:'China Internet ETF',k:'s'},
 {t:'JETS',n:'US Global Jets ETF',k:'s'},{t:'DRIV',n:'Global X Autonomous & EV ETF',k:'s'},
 {t:'ICLN',n:'iShares Clean Energy ETF',k:'s'},{t:'HACK',n:'Cybersecurity ETF',k:'s'},
 // ── MATERIALS & CHEMICALS ──
 {t:'LIN',n:'Linde',k:'s'},{t:'APD',n:'Air Products',k:'s'},{t:'SHW',n:'Sherwin-Williams',k:'s'},
 {t:'PPG',n:'PPG Industries',k:'s'},{t:'ECL',n:'Ecolab',k:'s'},{t:'DD',n:'DuPont',k:'s'},
 {t:'DOW',n:'Dow',k:'s'},{t:'LYB',n:'LyondellBasell',k:'s'},{t:'ALB',n:'Albemarle',k:'s'},
 {t:'NEM',n:'Newmont',k:'s'},{t:'FCX',n:'Freeport-McMoRan',k:'s'},{t:'NUE',n:'Nucor',k:'s'},
 {t:'STLD',n:'Steel Dynamics',k:'s'},{t:'RS',n:'Reliance Steel',k:'s'},{t:'VMC',n:'Vulcan Materials',k:'s'},
 // ── INDEXES ──
 {t:'SPX',n:'S&P 500',k:'i'},{t:'IXIC',n:'NASDAQ Composite',k:'i'},{t:'DJI',n:'Dow Jones Industrial',k:'i'},
 {t:'RUT',n:'Russell 2000',k:'i'},{t:'VIX',n:'CBOE Volatility Index (VIX)',k:'i'},
 {t:'NDX',n:'NASDAQ 100',k:'i'},{t:'SP600',n:'S&P 600 Small Cap',k:'i'},{t:'MID',n:'S&P 400 Mid Cap',k:'i'},
 {t:'FTSE',n:'FTSE 100 (UK)',k:'i'},{t:'NI225',n:'Nikkei 225 (Japan)',k:'i'},{t:'DAX',n:'DAX (Germany)',k:'i'},
 {t:'CAC40',n:'CAC 40 (France)',k:'i'},{t:'HSI',n:'Hang Seng (Hong Kong)',k:'i'},
 {t:'ASX',n:'ASX 200 (Australia)',k:'i'},{t:'SENSEX',n:'BSE Sensex (India)',k:'i'},
 {t:'NIFTY',n:'Nifty 50 (India)',k:'i'},{t:'KOSPI',n:'KOSPI (South Korea)',k:'i'},
 {t:'SSEC',n:'Shanghai Composite (China)',k:'i'},{t:'IBEX',n:'IBEX 35 (Spain)',k:'i'},
 {t:'MIB',n:'FTSE MIB (Italy)',k:'i'},{t:'AEX',n:'AEX (Netherlands)',k:'i'},
 {t:'SMI',n:'Swiss Market Index',k:'i'},{t:'TSX',n:'TSX Composite (Canada)',k:'i'},
 {t:'BVSP',n:'Bovespa (Brazil)',k:'i'},{t:'MERVAL',n:'Merval (Argentina)',k:'i'},
 {t:'DXY',n:'US Dollar Index',k:'i'},{t:'US10Y',n:'US 10-Year Treasury Yield',k:'i'},
 {t:'US02Y',n:'US 2-Year Treasury Yield',k:'i'},{t:'US30Y',n:'US 30-Year Treasury Yield',k:'i'},
 {t:'GOLD',n:'Gold Spot Price',k:'i'},{t:'SILVER',n:'Silver Spot Price',k:'i'},
 {t:'USOIL',n:'WTI Crude Oil',k:'i'},{t:'UKOIL',n:'Brent Crude Oil',k:'i'},
 {t:'NATGAS',n:'Natural Gas',k:'i'},{t:'CORN',n:'Corn Futures',k:'i'},{t:'WHEAT',n:'Wheat Futures',k:'i'},
 // ── CRYPTO ──
 {t:'BTC',n:'Bitcoin',k:'c'},{t:'ETH',n:'Ethereum',k:'c'},{t:'SOL',n:'Solana',k:'c'},
 {t:'BNB',n:'BNB (Binance)',k:'c'},{t:'XRP',n:'XRP / Ripple',k:'c'},{t:'DOGE',n:'Dogecoin',k:'c'},
 {t:'ADA',n:'Cardano',k:'c'},{t:'AVAX',n:'Avalanche',k:'c'},{t:'LINK',n:'Chainlink',k:'c'},
 {t:'LTC',n:'Litecoin',k:'c'},{t:'DOT',n:'Polkadot',k:'c'},{t:'MATIC',n:'Polygon',k:'c'},
 {t:'SHIB',n:'Shiba Inu',k:'c'},{t:'UNI',n:'Uniswap',k:'c'},{t:'ATOM',n:'Cosmos',k:'c'},
 {t:'FIL',n:'Filecoin',k:'c'},{t:'APT',n:'Aptos',k:'c'},{t:'ARB',n:'Arbitrum',k:'c'},
 {t:'OP',n:'Optimism',k:'c'},{t:'INJ',n:'Injective',k:'c'},{t:'SUI',n:'Sui',k:'c'},
 {t:'TIA',n:'Celestia',k:'c'},{t:'NEAR',n:'NEAR Protocol',k:'c'},{t:'FTM',n:'Fantom',k:'c'},
 {t:'ALGO',n:'Algorand',k:'c'},{t:'HBAR',n:'Hedera',k:'c'},{t:'VET',n:'VeChain',k:'c'},
 {t:'THETA',n:'Theta Network',k:'c'},{t:'EOS',n:'EOS',k:'c'},{t:'XLM',n:'Stellar',k:'c'},
 {t:'TRX',n:'TRON',k:'c'},{t:'BCH',n:'Bitcoin Cash',k:'c'},{t:'ETC',n:'Ethereum Classic',k:'c'},
 {t:'XMR',n:'Monero',k:'c'},{t:'ZEC',n:'Zcash',k:'c'},{t:'DASH',n:'Dash',k:'c'},
 {t:'PEPE',n:'Pepe',k:'c'},{t:'WIF',n:'dogwifhat',k:'c'},{t:'BONK',n:'Bonk',k:'c'},
 {t:'FLOKI',n:'Floki Inu',k:'c'},{t:'MEME',n:'Memecoin',k:'c'},{t:'WLD',n:'Worldcoin',k:'c'},
 {t:'IMX',n:'Immutable X',k:'c'},{t:'GALA',n:'Gala Games',k:'c'},{t:'SAND',n:'The Sandbox',k:'c'},
 {t:'MANA',n:'Decentraland',k:'c'},{t:'AXS',n:'Axie Infinity',k:'c'},{t:'ENJ',n:'Enjin Coin',k:'c'},
 {t:'CHZ',n:'Chiliz',k:'c'},{t:'FLOW',n:'Flow',k:'c'},{t:'ICP',n:'Internet Computer',k:'c'},
 {t:'GRT',n:'The Graph',k:'c'},{t:'LDO',n:'Lido DAO',k:'c'},{t:'AAVE',n:'Aave',k:'c'},
 {t:'MKR',n:'Maker',k:'c'},{t:'SNX',n:'Synthetix',k:'c'},{t:'CRV',n:'Curve DAO',k:'c'},
 {t:'COMP',n:'Compound',k:'c'},{t:'SUSHI',n:'SushiSwap',k:'c'},{t:'1INCH',n:'1inch',k:'c'},
 {t:'BLUR',n:'Blur',k:'c'},{t:'PYTH',n:'Pyth Network',k:'c'},{t:'JTO',n:'Jito',k:'c'},
 {t:'JUP',n:'Jupiter',k:'c'},{t:'STRK',n:'Starknet',k:'c'},{t:'MANTA',n:'Manta Network',k:'c'},
 {t:'ALT',n:'AltLayer',k:'c'},{t:'PIXEL',n:'Pixels',k:'c'},{t:'PORTAL',n:'Portal',k:'c'},
 {t:'USDT',n:'Tether USD',k:'c'},{t:'USDC',n:'USD Coin',k:'c'},{t:'DAI',n:'Dai',k:'c'},
 {t:'BUSD',n:'Binance USD',k:'c'},{t:'TUSD',n:'TrueUSD',k:'c'},
];

// TradingView symbols — correct exchange for every ticker
function tvSym(t, k) {
 const map = {
 // ── INDEXES ──
 SPX:'SP:SPX', IXIC:'NASDAQ:IXIC', DJI:'DJ:DJI', RUT:'TVC:RUT', VIX:'TVC:VIX',
 NDX:'NASDAQ:NDX', MID:'SP:MID', SP600:'SP:SP600',
 FTSE:'FOREXCOM:UKXGBP', NI225:'TVC:NI225', DAX:'XETR:DAX',
 CAC40:'EURONEXT:PX1', HSI:'TVC:HSI', ASX:'ASX:XJO', SENSEX:'BSE:SENSEX',
 NIFTY:'NSE:NIFTY', KOSPI:'KRX:KOSPI', SSEC:'SSE:000001', IBEX:'BME:IBC',
 MIB:'MIL:FTSEMIB', AEX:'EURONEXT:AEX', SMI:'SWX:SMI', TSX:'TSX:OSPTX',
 BVSP:'BMFBOVESPA:IBOV', MERVAL:'BYMA:MERVAL',
 DXY:'TVC:DXY', US10Y:'TVC:US10Y', US02Y:'TVC:US02Y', US30Y:'TVC:US30Y',
 GOLD:'TVC:GOLD', SILVER:'TVC:SILVER', USOIL:'TVC:USOIL', UKOIL:'TVC:UKOIL',
 NATGAS:'TVC:NATURALGAS', CORN:'CBOT:ZC1!', WHEAT:'CBOT:ZW1!',
 // ── CRYPTO ──
 BTC:'BITSTAMP:BTCUSD', ETH:'BITSTAMP:ETHUSD', SOL:'COINBASE:SOLUSD',
 BNB:'BINANCE:BNBUSDT', XRP:'BITSTAMP:XRPUSD', DOGE:'BINANCE:DOGEUSDT',
 ADA:'COINBASE:ADAUSD', AVAX:'COINBASE:AVAXUSD', LINK:'COINBASE:LINKUSD',
 LTC:'COINBASE:LTCUSD', DOT:'COINBASE:DOTUSD', MATIC:'COINBASE:MATICUSD',
 SHIB:'BINANCE:SHIBUSDT', UNI:'COINBASE:UNIUSD', ATOM:'COINBASE:ATOMUSD',
 FIL:'COINBASE:FILUSD', APT:'COINBASE:APTUSD', ARB:'COINBASE:ARBUSD',
 OP:'COINBASE:OPUSD', INJ:'BINANCE:INJUSDT', SUI:'BINANCE:SUIUSDT',
 TIA:'BINANCE:TIAUSDT', NEAR:'COINBASE:NEARUSD', FTM:'COINBASE:FTMUSD',
 ALGO:'COINBASE:ALGOUSD', HBAR:'COINBASE:HBARUSD', VET:'BINANCE:VETUSDT',
 THETA:'BINANCE:THETAUSDT', EOS:'COINBASE:EOSUSD', XLM:'COINBASE:XLMUSD',
 TRX:'BINANCE:TRXUSDT', BCH:'COINBASE:BCHUSD', ETC:'COINBASE:ETCUSD',
 XMR:'KRAKEN:XMRUSD', ZEC:'COINBASE:ZECUSD', DASH:'COINBASE:DASHUSD',
 PEPE:'BINANCE:PEPEUSDT', WIF:'BINANCE:WIFUSDT', BONK:'BINANCE:BONKUSDT',
 FLOKI:'BINANCE:FLOKIUSDT', WLD:'BINANCE:WLDUSDT', IMX:'BINANCE:IMXUSDT',
 GALA:'BINANCE:GALAUSDT', SAND:'COINBASE:SANDUSD', MANA:'COINBASE:MANAUSD',
 AXS:'COINBASE:AXSUSD', ENJ:'BINANCE:ENJUSDT', CHZ:'BINANCE:CHZUSDT',
 FLOW:'COINBASE:FLOWUSD', ICP:'COINBASE:ICPUSD', GRT:'COINBASE:GRTUSD',
 LDO:'COINBASE:LDOUSD', AAVE:'COINBASE:AAVEUSD', MKR:'COINBASE:MKRUSD',
 SNX:'COINBASE:SNXUSD', CRV:'COINBASE:CRVUSD', COMP:'COINBASE:COMPUSD',
 SUSHI:'BINANCE:SUSHIUSDT', '1INCH':'BINANCE:1INCHUSDT', BLUR:'BINANCE:BLURUSDT',
 PYTH:'BINANCE:PYTHUSDT', JTO:'BINANCE:JTOUSDT', JUP:'BINANCE:JUPUSDT',
 STRK:'BINANCE:STRKUSDT', USDT:'BINANCE:USDTUSD', USDC:'COINBASE:USDCUSD',
 DAI:'BINANCE:DAIUSDT', MEME:'BINANCE:MEMEUSDT', PORTAL:'BINANCE:PORTALUSDT',
 // ── NYSE STOCKS ──
 JPM:'NYSE:JPM', BAC:'NYSE:BAC', WMT:'NYSE:WMT', JNJ:'NYSE:JNJ',
 V:'NYSE:V', MA:'NYSE:MA', DIS:'NYSE:DIS', 'BRK.B':'NYSE:BRK.B', 'BRK.A':'NYSE:BRK.A',
 COIN:'NYSE:COIN', HOOD:'NYSE:HOOD', GS:'NYSE:GS', MS:'NYSE:MS', WFC:'NYSE:WFC',
 C:'NYSE:C', AXP:'NYSE:AXP', BLK:'NYSE:BLK', SCHW:'NYSE:SCHW', ICE:'NYSE:ICE',
 USB:'NYSE:USB', PNC:'NYSE:PNC', TFC:'NYSE:TFC', COF:'NYSE:COF', DFS:'NYSE:DFS',
 AIG:'NYSE:AIG', MET:'NYSE:MET', PRU:'NYSE:PRU', AFL:'NYSE:AFL', ALL:'NYSE:ALL',
 TRV:'NYSE:TRV', CB:'NYSE:CB', MMC:'NYSE:MMC', CME:'NASDAQ:CME', CBOE:'CBOE:CBOE',
 MCO:'NYSE:MCO', SPGI:'NYSE:SPGI', FIS:'NYSE:FIS', GPN:'NYSE:GPN',
 TGT:'NYSE:TGT', HD:'NYSE:HD', LOW:'NYSE:LOW', MCD:'NYSE:MCD', NKE:'NYSE:NKE',
 BKNG:'NASDAQ:BKNG', UBER:'NYSE:UBER', DPZ:'NASDAQ:DPZ', YUM:'NYSE:YUM',
 CMG:'NYSE:CMG', QSR:'NYSE:QSR', KO:'NYSE:KO', PEP:'NASDAQ:PEP', MDLZ:'NASDAQ:MDLZ',
 KHC:'NASDAQ:KHC', GIS:'NYSE:GIS', CLX:'NYSE:CLX', PG:'NYSE:PG', CL:'NYSE:CL',
 KMB:'NYSE:KMB', CPRT:'NASDAQ:CPRT', EBAY:'NASDAQ:EBAY',
 UNH:'NYSE:UNH', PFE:'NYSE:PFE', ABBV:'NYSE:ABBV', BMY:'NYSE:BMY',
 CVS:'NYSE:CVS', HCA:'NYSE:HCA', AMGN:'NASDAQ:AMGN', BIIB:'NASDAQ:BIIB',
 REGN:'NASDAQ:REGN', BSX:'NYSE:BSX', BAX:'NYSE:BAX', BDX:'NYSE:BDX',
 MDT:'NYSE:MDT', SYK:'NYSE:SYK', TMO:'NYSE:TMO', DHR:'NYSE:DHR',
 IQV:'NYSE:IQV', CNC:'NYSE:CNC', HUM:'NYSE:HUM', CI:'NYSE:CI',
 XOM:'NYSE:XOM', CVX:'NYSE:CVX', COP:'NYSE:COP', SLB:'NYSE:SLB',
 OXY:'NYSE:OXY', HAL:'NYSE:HAL', BKR:'NASDAQ:BKR', PSX:'NYSE:PSX',
 VLO:'NYSE:VLO', MPC:'NYSE:MPC', DVN:'NYSE:DVN', APA:'NASDAQ:APA',
 MRO:'NYSE:MRO', D:'NYSE:D', DUK:'NYSE:DUK', SO:'NYSE:SO', AEP:'NASDAQ:AEP',
 EXC:'NASDAQ:EXC', SRE:'NYSE:SRE', PCG:'NYSE:PCG', NEE:'NYSE:NEE',
 SNAP:'NYSE:SNAP', RBLX:'NYSE:RBLX', PINS:'NYSE:PINS', RDDT:'NYSE:RDDT',
 MTCH:'NASDAQ:MTCH', T:'NYSE:T', VZ:'NYSE:VZ', CMCSA:'NASDAQ:CMCSA',
 FOXA:'NASDAQ:FOXA', FOX:'NASDAQ:FOX', NYT:'NYSE:NYT',
 BA:'NYSE:BA', LMT:'NYSE:LMT', RTX:'NYSE:RTX', NOC:'NYSE:NOC', GD:'NYSE:GD',
 LHX:'NYSE:LHX', GE:'NYSE:GE', HON:'NASDAQ:HON', MMM:'NYSE:MMM', EMR:'NYSE:EMR',
 ITW:'NASDAQ:ITW', CAT:'NYSE:CAT', DE:'NYSE:DE', UPS:'NYSE:UPS', FDX:'NYSE:FDX',
 NSC:'NASDAQ:NSC', UNP:'NYSE:UNP', CSX:'NASDAQ:CSX', DAL:'NYSE:DAL',
 UAL:'NASDAQ:UAL', AAL:'NASDAQ:AAL', LUV:'NYSE:LUV', F:'NYSE:F', GM:'NYSE:GM',
 STLA:'NYSE:STLA', RACE:'NYSE:RACE', NIO:'NYSE:NIO', XPEV:'NYSE:XPEV',
 LI:'NASDAQ:LI', NKLA:'NASDAQ:NKLA', PLTR:'NYSE:PLTR', HIMS:'NYSE:HIMS',
 SQ:'NYSE:SQ', PATH:'NYSE:PATH', AI:'NYSE:AI', IONQ:'NYSE:IONQ', JOBY:'NYSE:JOBY',
 MSTR:'NASDAQ:MSTR', RIOT:'NASDAQ:RIOT', MARA:'NASDAQ:MARA',
 AMT:'NYSE:AMT', PLD:'NYSE:PLD', SPG:'NYSE:SPG', O:'NYSE:O', WELL:'NYSE:WELL',
 DLR:'NYSE:DLR', PSA:'NYSE:PSA', AVB:'NYSE:AVB', EQR:'NYSE:EQR',
 LIN:'NASDAQ:LIN', SHW:'NYSE:SHW', PPG:'NYSE:PPG', ECL:'NYSE:ECL',
 DD:'NYSE:DD', DOW:'NYSE:DOW', NEM:'NYSE:NEM', FCX:'NYSE:FCX', NUE:'NYSE:NUE',
 SPY:'AMEX:SPY', IWM:'AMEX:IWM', GLD:'AMEX:GLD', ARKK:'AMEX:ARKK',
 XLF:'AMEX:XLF', XLK:'AMEX:XLK', XLE:'AMEX:XLE', XLV:'AMEX:XLV',
 XLI:'AMEX:XLI', XLY:'AMEX:XLY', XLP:'AMEX:XLP', XLU:'AMEX:XLU',
 VNQ:'AMEX:VNQ', IAU:'AMEX:IAU', SLV:'AMEX:SLV', USO:'AMEX:USO',
 HYG:'AMEX:HYG', TLT:'AMEX:TLT', AGG:'AMEX:AGG', VEA:'AMEX:VEA',
 VWO:'AMEX:VWO', EEM:'AMEX:EEM', EFA:'AMEX:EFA', IEMG:'AMEX:IEMG',
 QQQ:'NASDAQ:QQQ', VTI:'AMEX:VTI', VOO:'AMEX:VOO', SCHD:'AMEX:SCHD',
 BOTZ:'AMEX:BOTZ', MSOS:'AMEX:MSOS', KWEB:'AMEX:KWEB', JETS:'AMEX:JETS',
 ICLN:'AMEX:ICLN', HACK:'AMEX:HACK', DRIV:'AMEX:DRIV',
 LLY:'NYSE:LLY', TM:'NYSE:TM',
 // ── NASDAQ STOCKS ──
 AAPL:'NASDAQ:AAPL', MSFT:'NASDAQ:MSFT', GOOGL:'NASDAQ:GOOGL', GOOG:'NASDAQ:GOOG',
 AMZN:'NASDAQ:AMZN', META:'NASDAQ:META', TSLA:'NASDAQ:TSLA', NVDA:'NASDAQ:NVDA',
 NFLX:'NASDAQ:NFLX', AMD:'NASDAQ:AMD', INTC:'NASDAQ:INTC', ORCL:'NASDAQ:ORCL',
 PYPL:'NASDAQ:PYPL', SPOT:'NASDAQ:SPOT', SHOP:'NYSE:SHOP', CRM:'NYSE:CRM',
 ADBE:'NASDAQ:ADBE', QCOM:'NASDAQ:QCOM', TXN:'NASDAQ:TXN', AVGO:'NASDAQ:AVGO',
 MU:'NASDAQ:MU', AMAT:'NASDAQ:AMAT', LRCX:'NASDAQ:LRCX', KLAC:'NASDAQ:KLAC',
 MRVL:'NASDAQ:MRVL', ARM:'NASDAQ:ARM', SMCI:'NASDAQ:SMCI', HPQ:'NYSE:HPQ',
 HPE:'NYSE:HPE', DELL:'NYSE:DELL', IBM:'NYSE:IBM', ACN:'NYSE:ACN',
 NOW:'NYSE:NOW', SNOW:'NYSE:SNOW', CRWD:'NASDAQ:CRWD', DDOG:'NASDAQ:DDOG',
 ZS:'NASDAQ:ZS', NET:'NYSE:NET', OKTA:'NASDAQ:OKTA', TWLO:'NYSE:TWLO',
 MDB:'NASDAQ:MDB', GTLB:'NASDAQ:GTLB', S:'NYSE:S', TEAM:'NASDAQ:TEAM',
 WDAY:'NASDAQ:WDAY', ANSS:'NASDAQ:ANSS', CDNS:'NASDAQ:CDNS', SNPS:'NASDAQ:SNPS',
 NXPI:'NASDAQ:NXPI', MPWR:'NASDAQ:MPWR', ON:'NASDAQ:ON', TER:'NASDAQ:TER',
 MRNA:'NASDAQ:MRNA', GILD:'NASDAQ:GILD', ISRG:'NASDAQ:ISRG', VRTX:'NASDAQ:VRTX',
 ILMN:'NASDAQ:ILMN', IDXX:'NASDAQ:IDXX', A:'NYSE:A',
 EQT:'NYSE:EQT', FANG:'NASDAQ:FANG', ENPH:'NASDAQ:ENPH', FSLR:'NASDAQ:FSLR',
 RUN:'NASDAQ:RUN', PLUG:'NASDAQ:PLUG', BE:'NYSE:BE', CHPT:'NYSE:CHPT',
 TMUS:'NASDAQ:TMUS', CHTR:'NASDAQ:CHTR', TTD:'NASDAQ:TTD',
 RIVN:'NASDAQ:RIVN', LCID:'NASDAQ:LCID', SOFI:'NASDAQ:SOFI', UPST:'NASDAQ:UPST',
 AFRM:'NASDAQ:AFRM', DKNG:'NASDAQ:DKNG', RKLB:'NASDAQ:RKLB',
 BBAI:'NYSE:BBAI', SOUN:'NASDAQ:SOUN', RXRX:'NASDAQ:RXRX', ASAN:'NYSE:ASAN',
 CLSK:'NASDAQ:CLSK', HUT:'NASDAQ:HUT', BITO:'NYSE:BITO',
 EQIX:'NASDAQ:EQIX', EXTR:'NASDAQ:EXTR', EXR:'NYSE:EXR', MAA:'NYSE:MAA',
 LULU:'NASDAQ:LULU', SBUX:'NASDAQ:SBUX', COST:'NASDAQ:COST', ABNB:'NASDAQ:ABNB',
 LYFT:'NASDAQ:LYFT', ETSY:'NASDAQ:ETSY', CHWY:'NYSE:CHWY',
 PARA:'NASDAQ:PARA', WBD:'NASDAQ:WBD', EA:'NASDAQ:EA', TTWO:'NASDAQ:TTWO',
 QQQ:'NASDAQ:QQQ', VOO:'NYSE:VOO', VTI:'NYSE:VTI', SOXL:'NYSE:SOXL',
 TQQQ:'NASDAQ:TQQQ', SQQQ:'NASDAQ:SQQQ', SPXL:'NYSE:SPXL', SPXS:'NYSE:SPXS',
 ARKQ:'NYSE:ARKQ', ARKW:'NYSE:ARKW', ARKG:'NYSE:ARKG',
 APD:'NYSE:APD', ALB:'NYSE:ALB', VMC:'NYSE:VMC', STLD:'NASDAQ:STLD',
 HON:'NASDAQ:HON', ROP:'NASDAQ:ROP', FTV:'NYSE:FTV', IR:'NYSE:IR',
 TT:'NYSE:TT', CARR:'NYSE:CARR', OTIS:'NYSE:OTIS', XYL:'NYSE:XYL',
 JCI:'NYSE:JCI', EXPD:'NASDAQ:EXPD', ALK:'NYSE:ALK', JBLU:'NASDAQ:JBLU',
 AGCO:'NYSE:AGCO', HMC:'NYSE:HMC', FSR:'NYSE:FSR',
 };
 if (map[t]) return map[t];
 if (k === 'c') return 'BINANCE:' + t + 'USDT';
 if (k === 'i') return 'TVC:' + t;
 // For stocks: try NYSE first as it has more tickers, NASDAQ as fallback
 return 'NYSE:' + t;
}

const PICKS = {
 s: ['AAPL','TSLA','NVDA','MSFT','AMZN','META','GOOGL','AMD','JPM','NFLX'],
 i: ['SPX','IXIC','DJI','RUT','VIX','FTSE','NI225','DAX'],
 c: ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX'],
};

/* ════════════════════════════════
 STATE
════════════════════════════════ */
let user = null, tab = 's', theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark', mode = 'simple', marketFilter = 's';
// The theme someone picked on purpose (null = never picked, so the dark default applies). Synced with the account.
let themeChoice = null;

function staggerCards(container) {
 if (!container) return;
 const cards = container.querySelectorAll('.card');
 cards.forEach((c, i) => {
 c.classList.add('card-enter');
 c.style.animationDelay = (i * 55) + 'ms';
 });
}

function countUp(el, target, duration=900, prefix='', suffix='') {
 if (!el) return;
 const start = performance.now();
 function step(ts) {
 const p = Math.min((ts - start) / duration, 1);
 const ease = 1 - Math.pow(1 - p, 3);
 const val = target * ease;
 el.textContent = prefix + (Number.isInteger(target) ? Math.round(val).toLocaleString() : val.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})) + suffix;
 if (p < 1) requestAnimationFrame(step);
 }
 requestAnimationFrame(step);
}
let watchlist = [], holdings = [], clockTick = null;
let currentAsset = null;
let dashPick = { s:'AAPL', i:'SPX', c:'BTC' };

// Customization state (persisted per user)
let accentColor = 'purple'; // purple | blue | green | orange | pink | gold
let chartStyle = '1'; // 1=Candles, 3=Line, 5=Bars, 8=Heikin Ashi
let chartInterval = 'D'; // D, W, M
let currency = 'USD'; // USD, EUR, GBP, JPY
let compactMode = false; // tighter spacing
let nameDisplay = 'first'; // first | full

/* ════════════════════════════════
 ONE-TIME FRESH START WIPE
════════════════════════════════ */
(function() {
 if (!localStorage.getItem('ss_fresh_v1')) {
 Object.keys(localStorage).filter(k => k.startsWith('ss')).forEach(k => localStorage.removeItem(k));
 localStorage.setItem('ss_fresh_v1', '1');
 }
})();

/* ════════════════════════════════
 STORAGE — window.storage (Claude artifact) with localStorage fallback
 This means: works inside Claude AND works when downloaded & opened in browser
════════════════════════════════ */
const hp = s => { let h=0; for(const c of s){h=((h<<5)-h)+c.charCodeAt(0);h|=0;} return 'h'+Math.abs(h).toString(36); };

// Check which storage system is available
const hasArtifactStorage = typeof window.storage !== 'undefined' && window.storage !== null;

async function sg(k) {
 try {
 if (hasArtifactStorage) {
 const r = await window.storage.get(k);
 return r ? JSON.parse(r.value) : null;
 } else {
 const v = localStorage.getItem('ss_' + k);
 return v ? JSON.parse(v) : null;
 }
 } catch { return null; }
}

async function ss(k, v) {
 try {
 if (hasArtifactStorage) {
 await window.storage.set(k, JSON.stringify(v));
 } else {
 localStorage.setItem('ss_' + k, JSON.stringify(v));
 }
 } catch {}
}

async function sd(k) {
 try {
 if (hasArtifactStorage) {
 await window.storage.delete(k);
 } else {
 localStorage.removeItem('ss_' + k);
 }
 } catch {}
}
// ── Accounts used on this device ──
async function getU() {
 try {
 const local = await sg('ss3_u').then(r=>r||{});
 return local;
 } catch { return {}; }
}
async function setU(users) {
 // Accounts used on this device (names only; passwords are checked on the server)
 await ss('ss3_u', users);
}
const getSess=()=>sg('ss3_s');
const setSess=u=>ss('ss3_s',u);
const delSess=()=>sd('ss3_s');

// Sign-in starts the app before the account's settings arrive, so put them on screen once they do
function showLoadedSettings(prevTheme) {
 if (document.body.dataset.screen !== 'app') return;
 applyAllSettings(false);
 if (theme !== prevTheme) setTimeout(reRenderCurrentView, 50);
}

async function loadUserData(){
 const e=user?.email||'';
 const prevTheme = theme;

 // Try Supabase first
 try {
 const { data, error } = await usersTable().select('*').eq('email', e).maybeSingle();
 if (!user) return; // session ended while loading
 if (data && typeof data.has_password === 'boolean' && user.hasPassword !== data.has_password) {
 user.hasPassword = data.has_password;
 setSess(user);
 }
 if (data && !error) {
 // Restore watchlist
 if (data.watchlist?.length) { watchlist = data.watchlist; await ss('ss3_wl_'+e, watchlist); }
 else { watchlist = await sg('ss3_wl_'+e)||[]; }
 // Restore holdings
 const sbHoldings = data.portfolio?.holdings;
 if (sbHoldings?.length) { holdings = sbHoldings; await ss('ss3_h_'+e, holdings); }
 else { holdings = await sg('ss3_h_'+e)||[]; }
 // Restore paper trade
 const sbPt = data.portfolio?.paper_trade;
 if (sbPt) { try { localStorage.setItem('ss_pt_'+e, JSON.stringify(sbPt)); } catch {} }
 // Restore pending orders
 if (data.pending_orders?.length) { try { localStorage.setItem('ss_pt_pending_'+e, JSON.stringify(data.pending_orders)); } catch {} }
 // Restore alerts
 if (data.alerts && normalizeAlerts(data.alerts).length) { try { localStorage.setItem('ss_alerts_'+e, JSON.stringify(normalizeAlerts(data.alerts))); } catch {} }
 if (typeof data.alert_emails === 'boolean') { try { localStorage.setItem('ss_alertmail_'+e, data.alert_emails ? '1' : '0'); } catch {} }
 loadAlerts();
 // Restore notes
 if (data.notes && Object.keys(data.notes).length) { try { localStorage.setItem('ss_notes_'+e, JSON.stringify(data.notes)); } catch {} }
 // Restore streak
 if (data.streak_count) { try { localStorage.setItem('ss_streak_'+e, JSON.stringify({ count: data.streak_count, lastDate: data.streak_last_date })); } catch {} }
 // Restore broker, tutorial, onboarding, avatar
 if (data.broker) { try { localStorage.setItem('ss_broker_'+e, data.broker); } catch {} }
 if (data.tutorial_done) { try { localStorage.setItem('ss_tutorial_done_'+e, '1'); } catch {} }
 if (data.onboarding_done){ try { localStorage.setItem('ss_onboarding_'+e, '1'); } catch {} }
 try { const av = avatarUrlOf(data.avatar); av ? localStorage.setItem('ss_avatar_'+e, av) : localStorage.removeItem('ss_avatar_'+e); } catch {}
 if (typeof data.league_emails === 'boolean') { try { localStorage.setItem('ss_lgmail_'+e, data.league_emails ? '1' : '0'); } catch {} }
 if (typeof data.digest === 'boolean') { try { data.digest ? localStorage.setItem('ss_digest_'+e, '1') : localStorage.removeItem('ss_digest_'+e); } catch {} }
 // Learning progress: this browser's copy and the account's, combined; the account gets the result if it was missing anything
 try {
  const local = safeParse('ss_learn_'+e, null);
  const merged = data.learn && typeof data.learn === 'object' ? mergeLearn(local || {}, data.learn) : local;
  if (merged) {
   localStorage.setItem('ss_learn_'+e, JSON.stringify(merged));
   const same = o => JSON.stringify({ ...learnShape(o), at: 0 });
   if (!data.learn || same(merged) !== same(data.learn)) setTimeout(() => { if (user?.email === e) saveLearn(getLearn()); }, 4000);
  }
 } catch {}
 // Restore settings/prefs
 const p = data.settings || data.portfolio?.prefs || {};
 if(p.themeChoice === 'light' || p.themeChoice === 'dark') { theme = themeChoice = p.themeChoice; try { localStorage.setItem('ss_theme', theme); } catch {} }
 if(p.mode) mode=p.mode;
 if(p.accentColor) accentColor=p.accentColor;
 if(p.chartStyle) chartStyle=p.chartStyle;
 if(p.chartInterval) chartInterval=p.chartInterval;
 if(p.currency) currency=p.currency;
 if(p.compactMode!==undefined) compactMode=p.compactMode;
 if(p.nameDisplay) nameDisplay=p.nameDisplay;
 if(p.dashPick) dashPick={...dashPick,...p.dashPick};
 if(p.darkSchedule!==undefined) darkSchedule=p.darkSchedule;
 if(p.portfolioName) portfolioName=p.portfolioName;
 showLoadedSettings(prevTheme);
 return;
 }
 } catch(err) { console.warn('loadUserData Supabase failed, using localStorage:', err.message); }

 // Fallback to localStorage
 watchlist=await sg('ss3_wl_'+e)||[];
 holdings=await sg('ss3_h_'+e)||[];
 const p=await sg('ss3_p_'+e)||{};
 if(p.themeChoice === 'light' || p.themeChoice === 'dark') { theme = themeChoice = p.themeChoice; try { localStorage.setItem('ss_theme', theme); } catch {} }
 if(p.mode) mode=p.mode;
 if(p.accentColor) accentColor=p.accentColor;
 if(p.chartStyle) chartStyle=p.chartStyle;
 if(p.chartInterval) chartInterval=p.chartInterval;
 if(p.currency) currency=p.currency;
 if(p.compactMode!==undefined) compactMode=p.compactMode;
 if(p.nameDisplay) nameDisplay=p.nameDisplay;
 if(p.dashPick) dashPick={...dashPick,...p.dashPick};
 if(p.darkSchedule!==undefined) darkSchedule=p.darkSchedule;
 if(p.portfolioName) portfolioName=p.portfolioName;
 showLoadedSettings(prevTheme);
}

// Save functions — write to localStorage AND sync to Supabase
const saveWL=()=>{
 if(!user?.email) return;
 ss('ss3_wl_'+user.email, watchlist);
 usersTable().update({ watchlist }).eq('email', user.email).then(({error})=>{ if(error) console.warn('saveWL sync failed'); });
 renderRail();
};
const saveH=()=>{
 if(!user?.email) return;
 ss('ss3_h_'+user.email, holdings);
 const _prefs = safeParse('ss3_p_'+user.email, {});
 usersTable().update({ portfolio: { holdings, paper_trade: getPtPortfolio(), prefs: _prefs } }).eq('email', user.email).then(({error})=>{ if(error) console.warn('saveH sync failed'); });
};
const saveP=()=>{
 if(!user?.email) return;
 const prefs = {theme, themeChoice, mode, accentColor, chartStyle, chartInterval, currency, compactMode, nameDisplay, dashPick, darkSchedule, portfolioName};
 ss('ss3_p_'+user.email, prefs);
 usersTable().update({ settings: prefs }).eq('email', user.email).then(({error})=>{ if(error) console.warn('saveP sync failed'); });
};

/* ════════════════════════════════
 BOOT
════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
 // Ensure all screens are hidden before deciding which to show
 ['gate','app','profile'].forEach(name => {
 const el = document.getElementById('S-'+name);
 if (el) el.style.display = 'none';
 });

 try {
 const sess = await getSess();
 if (sess && !getTok()) {
 // Signed in before sign-in moved to the server: sign in once more
 await delSess();
 applyTheme(false);
 updateGateUserCount();
 show('gate');
 setTimeout(() => toast('We upgraded account security. Please sign in again.', 'info', 6000), 600);
 } else if (sess) {
 user = sess;
 await loadUserData();
 if (!user) return;
 setTimeout(captureWlLoginSnapshot, 300);
 bootApp();
 } else if (leagueDeepLink()) {
 // A league invite (stocksightai.com/join/ABC123): show the app with the invite, not the landing page
 applyTheme(false);
 bootGuest();
 openLeagueDeepLink();
 } else if (deepLinkTicker() && location.pathname.startsWith('/stock/')) {
 // Someone opened stocksightai.com/stock/NVDA (from Google or a shared link): show the stock right away
 applyTheme(false);
 bootGuest();
 openDeepLink();
 } else {
 applyTheme(false);
 updateGateUserCount();
 show('gate');
 }
 } catch(e) {
 console.error('Boot error:', e);
 applyTheme(false);
 show('gate');
 }
});

/* ════════════════════════════════
 SCREEN MANAGEMENT
 — All screens start as display:none in HTML
 — show() is the only way to activate one
════════════════════════════════ */
function show(name) {
 if (name === 'profile' && !requireAuth('Profile & Settings')) return;
 document.body.dataset.screen = name;
 document.getElementById('seoStock')?.remove(); // the server-drawn summary on /stock/ pages, replaced by the real page
 if (name === 'app') setTimeout(moveNavPill, 30);
 const screens = ['gate','app','profile'];
 screens.forEach(n => {
 const el = document.getElementById('S-'+n);
 if (!el) return;
 if (n === name) {
 el.style.display = 'block';
 el.style.opacity = '1';
 el.style.transform = 'none';
 el.style.transition = '';
 } else {
 el.style.display = 'none';
 el.style.opacity = '';
 el.style.transform = '';
 }
 });
 if (name === 'profile') loadProfilePage();
 const nav = document.getElementById('mobileNav');
 if (nav) {
 if (name === 'gate') {
 nav.style.display = 'none';
 } else if (name === 'app' || name === 'profile') {
 nav.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
 }
 }
}

function bootApp() {
 setTimeout(() => { if (user) refreshLivePrices(); }, 600);
 // Carry lesson XP earned as a guest over to the account
 try {
  const g = localStorage.getItem('ss_learn_guest');
  if (g && !localStorage.getItem('ss_learn_' + user.email)) { localStorage.setItem('ss_learn_' + user.email, g); localStorage.removeItem('ss_learn_guest'); saveLearn(getLearn()); }
 } catch {}
 // Clear the gate-page preview animation interval (fires when user logs in)
 if (window._gatePreviewInterval) { clearInterval(window._gatePreviewInterval); window._gatePreviewInterval = null; }
 const displayName = escapeHTML(nameDisplay==='full' ? user.name : user.name.split(' ')[0]);
 document.getElementById('appHdrActions').innerHTML = `
 <button class="btn-help" data-tip="Help & FAQ" onclick="openHelp()" style="display:inline-flex;align-items:center;justify-content:center"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></button>
 <button class="icon-btn" id="themeBtn" data-tip="Toggle theme" onclick="toggleTheme()" style="font-size:.85rem;padding:6px 10px"></button>
 <button onclick="toggleMode()" id="modeBtn" data-tip="Beginner / Advanced mode" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:6px 11px;font-family:inherit;font-size:.7rem;font-weight:700;cursor:pointer;color:var(--text2);transition:all .15s"></button>
 <button id="notifBtn" onclick="openNotificationCenter()" data-tip="Notifications" style="position:relative;background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:6px 10px;font-size:.85rem;cursor:pointer;transition:all .15s">🔔</button>
 <div class="user-pill" onclick="show('profile')">
 <div class="avatar" id="hdrAvatar">${myAvatarHTML(30)}</div>
 <div class="user-name">${displayName}</div>
 <div style="font-size:.52rem;color:var(--text3);margin-left:2px">▾</div>
 </div>`;
 updateThemeBtn();
 updateNotifBadge();
 const wbEl = document.getElementById('wbName'); if (wbEl) wbEl.textContent = displayName;
 applyAllSettings(false);
 // Load persisted local data
 loadNotes();
 loadAlerts();
 loadSearchHistory();
 applyDarkSchedule(false); // start dark schedule if enabled
 document.getElementById('mobileNav').style.display = 'flex';
 show('app');
 initSearch();
 startClock();
 updateStreak();
 initTickerTape();
 switchTab('s');
 setTimeout(applyModeLabels, 100);
 setTimeout(checkWatchlistNotifications, 2000);
 openDeepLink();
 openLeagueDeepLink();
 lgAfterLogin();
 setTimeout(() => loadLeagues().then(lgNotices), 2500);

 const isNewUser = !localStorage.getItem('ss_onboarding_'+(user?.email||''));
 const tutDone = !!localStorage.getItem('ss_tutorial_done_'+(user?.email||''));
 const brokerSet = !!localStorage.getItem('ss_broker_'+(user?.email||''));

 if (isNewUser) {
 // Brand new user: 1) questionnaire → 2) tutorial → 3) broker
 setTimeout(startOnboarding, 500);
 } else if (!tutDone) {
 // Returning user who hasn't finished tutorial: 2) tutorial → 3) broker
 setTimeout(startTutorial, 500);
 } else if (!brokerSet) {
 // Has done everything except set broker — respect "don't ask me again"
 if (!localStorage.getItem('ss_broker_dismiss_'+(user?.email||''))) setTimeout(openBrokerModal, 600);
 }
}

// Google Analytics events for the moments that matter (gtag is defined in index.html)
function track(name, params) { try { gtag('event', name, params || {}); } catch {} }

// Adding StockSight to the home screen (it's a web app, not an app-store app): Chrome and Edge offer their own prompt; iPhone uses Share, Add to Home Screen
let _installPrompt = null, _justInstalled = false;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); _installPrompt = e; syncInstallUI(); });
addEventListener('appinstalled', () => { _installPrompt = null; _justInstalled = true; track('app_installed'); syncInstallUI(); });
function isInstalledApp() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function syncInstallUI() {
 const btn = document.getElementById('installBtn'), desc = document.getElementById('installDesc');
 if (!btn || !desc) return;
 const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
 btn.style.display = !isInstalledApp() && _installPrompt ? '' : 'none';
 desc.textContent = isInstalledApp() ? "You're using StockSight from your home screen."
  : _justInstalled ? 'Added. Open StockSight from your home screen or app list.'
  : _installPrompt ? 'It opens full screen from its own icon. No app store needed.'
  : iphone ? 'In Safari, tap the Share button, then "Add to Home Screen".'
  : 'In your browser menu, choose "Add to Home screen" (some browsers call it "Install").';
}
async function installApp() {
 if (!_installPrompt) return syncInstallUI();
 _installPrompt.prompt();
 try { await _installPrompt.userChoice; } catch {}
 _installPrompt = null;
 syncInstallUI();
}

// The address bar follows the stock being viewed (/stock/NVDA), so links can be copied and shared
function syncStockUrl(ticker) {
 try {
  const want = ticker ? '/stock/' + encodeURIComponent(ticker) : '/';
  if (location.pathname !== want) history.replaceState(history.state, '', want + location.hash);
 } catch {}
}
function deepLinkTicker() {
 let t = '';
 try {
  const m = location.pathname.match(/^\/stock\/([^/?#]+)\/?$/i);
  t = (m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get('stock') || '').toUpperCase().trim();
 } catch {}
 return /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(t) ? t : '';
}

// Links open a stock's page: stocksightai.com/stock/NVDA (or the older ?stock=NVDA)
function openDeepLink() {
 const t = deepLinkTicker();
 if (!t) return;
 const local = TICKERS.find(e => e.t === t);
 setTimeout(() => {
  if (local && ['s','i','c'].includes(local.k) && local.k !== tab) switchTab(local.k, true);
  verifyTicker(t, local?.n || t, local?.k);
 }, 400);
}

function goHome() {
 show('app');
 currentAsset = null;
 syncStockUrl(null);
 const ss = document.getElementById('searchSection');
 if (ss) ss.style.display = '';
 switchTab('s', true);
 renderHome(marketFilter || 's');
}

/* ════════════════════════════════
 GUEST MODE
════════════════════════════════ */
let guestSearchCount = 0;
let nudgeDismissed = false;

function bootGuest() {
 // Show app without account — guest browsing mode
 document.getElementById('appHdrActions').innerHTML = `
 <button class="btn-help" onclick="openHelp()" title="Help & FAQ">?</button>
 <button class="icon-btn" id="themeBtn" onclick="toggleTheme()" title="Toggle dark/light mode" style="font-size:.85rem;padding:6px 10px"></button>
 <div style="display:flex;gap:6px">
 <button onclick="openModal('login')" style="background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.74rem;font-weight:600;color:var(--text2);cursor:pointer;transition:all .15s" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text2)'">Log in</button>
 <button onclick="openModal('signup')" style="background:linear-gradient(135deg,var(--accent),var(--accent3));color:#fff;border:none;border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.74rem;font-weight:600;cursor:pointer">Sign up free</button>
 </div>`;
 applyAllSettings(false);
 document.getElementById('mobileNav').style.display = 'flex';
 show('app');
 initSearch();
 startClock();
 switchTab('s');
 setTimeout(applyModeLabels, 100);
 // Guest greeting
 const g = document.getElementById('wbGreeting');
 if (g) g.innerHTML = 'Welcome to <strong style="color:var(--accent2)">StockSight</strong>';
 updateGateUserCount();
}

function updateGateUserCount() {
 const el = document.getElementById('gateUserCount');
 if (!el) return;
 try {
 const users = safeParse('ss3_u', {});
 const count = Object.keys(users).length;
 el.textContent = (2400 + count).toLocaleString() + '+';
 } catch { el.textContent = '2,400+'; }
}

function requireAuth(featureName) {
 if (user) return true;
 // Show a contextual prompt to sign up
 showSignupNudge(`Sign up free to use <strong>${featureName}</strong>, plus lessons, leagues with friends, watchlists, portfolio tracking and more.`, true);
 return false;
}

function trackGuestSearch() {
 if (user || nudgeDismissed) return;
 guestSearchCount++;
 if (guestSearchCount === 5) {
 setTimeout(() => showSignupNudge('You\'re getting the hang of this! <strong>Create a free account</strong> to save stocks to your watchlist, track your portfolio, and unlock AI chat.', false), 800);
 }
}

function showSignupNudge(message, isFeatureGate) {
 // Don't show if already showing
 if (document.getElementById('signupNudge')) return;
 const nudge = document.createElement('div');
 nudge.id = 'signupNudge';
 nudge.style.cssText = `position:fixed;inset:0;z-index:8900;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);padding:1rem`;
 nudge.innerHTML = `
 <div style="background:var(--card);border:1px solid rgba(108,92,231,.4);border-radius:20px;padding:2rem;max-width:500px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5);animation:fadeUp .25s cubic-bezier(.16,1,.3,1);position:relative">
 <button onclick="${!isFeatureGate ? 'nudgeDismissed=true;' : 'switchTab(\'s\');'}document.getElementById('signupNudge').remove()"
 style="position:absolute;top:12px;right:14px;background:var(--card2);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:.85rem;color:var(--text3);display:flex;align-items:center;justify-content:center;font-weight:700;line-height:1">&#x2715;</button>
 <div style="text-align:center;margin-bottom:1.5rem">
 <div style="font-family:'Geist',sans-serif;font-size:1.15rem;font-weight:800;margin-bottom:.5rem">Unlock the full StockSight experience</div>
 <div style="font-size:.82rem;color:var(--text2);line-height:1.65">${message}</div>
 </div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-bottom:1.5rem;padding:1rem;background:var(--card2);border-radius:12px;border:1px solid var(--border)">
 ${[' Lessons and quizzes',' Leagues with friends',' Save to Watchlist',' Portfolio tracker',
 ' Paper trading',' Price alerts',' AI Chat per stock',' Badges & streaks',
 ' Stock notes',' Vote on polls',' Broker integration',' Weekly digest'].map(f =>
 `<div style="display:flex;align-items:center;gap:6px;font-size:.74rem;color:var(--text2)"><span style="color:var(--green);font-size:.75rem;font-weight:700">&#x2713;</span>${f}</div>`).join('')}
 </div>
 <div style="display:flex;gap:8px">
 <button onclick="document.getElementById('signupNudge').remove();openModal('signup')"
 style="flex:1;background:linear-gradient(135deg,var(--accent),var(--accent3));color:#fff;border:none;border-radius:10px;padding:12px;font-family:inherit;font-size:.85rem;font-weight:700;cursor:pointer"
 onmouseover="this.style.opacity='.9'" onmouseout="this.style.opacity='1'">
 Create free account →
 </button>
 <button onclick="document.getElementById('signupNudge').remove();openModal('login')"
 style="background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:12px 18px;font-family:inherit;font-size:.82rem;font-weight:600;cursor:pointer;color:var(--text2)"
 onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
 Log in
 </button>
 </div>
 <div style="text-align:center;margin-top:.75rem;font-size:.65rem;color:var(--text3)">Free forever · No credit card · Takes 30 seconds</div>
 </div>`;
 document.body.appendChild(nudge);
}
async function logout() {
 await delSess();
 setTok('');
 user = null;
 if (clockTick) clearInterval(clockTick);
 // Reset any active state
 guestSearchCount = 0;
 nudgeDismissed = false;
 searchHistory = [];
 watchlist = [];
 holdings = [];
 renderPaperTradeTab._synced = false;
 renderPaperTradeTab._syncing = false;
 document.getElementById('mobileNav').style.display = 'none';
 // Go to gate screen
 show('gate');
 updateGateUserCount();
}

/* ════════════════════════════════
 SVG ICON SYSTEM
════════════════════════════════ */
const ICONS = {
 'trending-up':   '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
 'star':          '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
 'briefcase':     '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
 'sliders':       '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
 'git-compare':   '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
 'play':          '<polygon points="5 3 19 12 5 21 5 3"/>',
 'bell':          '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
 'moon':          '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
 'sun':           '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
 'user':          '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
 'check-circle':  '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
 'x-circle':      '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
 'alert-triangle':'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
 'message-circle':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 'dollar-sign':   '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
 'award':         '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
 'help-circle':   '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
 'book-open':     '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
 'zap':           '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};
function icon(name, size=16) {
 const paths = ICONS[name];
 if (!paths) return '';
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;pointer-events:none">${paths}</svg>`;
}

/* ════════════════════════════════
 NUMBER FORMATTING UTILITIES
════════════════════════════════ */
function fmtPrice(n) {
 if (n == null || isNaN(n)) return '—';
 if (n >= 1000) return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
 if (n >= 1) return '$' + n.toFixed(2);
 return '$' + n.toPrecision(4);
}
function fmtPct(n, showSign=true) {
 if (n == null || isNaN(n)) return '—';
 return (showSign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function fmtLarge(n) {
 if (n == null || isNaN(n)) return '—';
 if (Math.abs(n) >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
 if (Math.abs(n) >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
 if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
 if (Math.abs(n) >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
 return '$' + n.toFixed(2);
}

/* ════════════════════════════════
 #18 TOAST NOTIFICATIONS
════════════════════════════════ */
function toast(msg, type='info', duration=3500) {
 if (user && ['star','money','success'].includes(type)) addNotification(msg, type);
 updateNotifBadge();
 const toastIcons = {
  success: `<span style="color:var(--green)">${icon('check-circle',16)}</span>`,
  error:   `<span style="color:var(--red)">${icon('x-circle',16)}</span>`,
  warning: `<span style="color:var(--gold)">${icon('alert-triangle',16)}</span>`,
  info:    `<span style="color:var(--accent2)">${icon('message-circle',16)}</span>`,
  money:   `<span style="color:var(--green)">${icon('dollar-sign',16)}</span>`,
  star:    `<span style="color:var(--gold)">${icon('award',16)}</span>`,
 };
 const toastIcon = toastIcons[type] || toastIcons.info;
 const container = document.getElementById('toast-container');
 if (!container) return;
 const el = document.createElement('div');
 el.className = 'toast';
 const prog = document.createElement('div');
 prog.className = 'toast-progress';
 prog.style.cssText = `animation:toastProgress ${duration}ms linear forwards`;
 el.innerHTML = `<span class="toast-icon">${toastIcon}</span><span style="flex:1">${msg}</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
 el.appendChild(prog);
 container.appendChild(el);
 setTimeout(() => {
 el.style.animation = 'toastOut .2s var(--ease-out) forwards';
 setTimeout(() => el.remove(), 300);
 }, duration);
}

/* ════════════════════════════════
 #20 CONFETTI (fires on every holding add)
════════════════════════════════ */
function launchConfetti() {
 const canvas = document.getElementById('confetti-canvas');
 if (!canvas) return;
 canvas.style.display = 'block';
 const ctx = canvas.getContext('2d'); if (!ctx) return;
 canvas.width = window.innerWidth; canvas.height = window.innerHeight;
 const COLORS = ['#6c5ce7','#00c97a','#f59e0b','#ff3860','#00b4d8','#a78bfa','#fbbf24'];
 const pieces = Array.from({length:120}, () => ({
 x: Math.random()*canvas.width, y: -10,
 size: 6+Math.random()*8, color: COLORS[Math.floor(Math.random()*COLORS.length)],
 vx: (Math.random()-0.5)*6, vy: 3+Math.random()*5,
 angle: Math.random()*360, spin: (Math.random()-0.5)*8,
 shape: Math.random()<0.5?'rect':'circle'
 }));
 let frame = 0;
 const animate = () => {
 ctx.clearRect(0,0,canvas.width,canvas.height);
 pieces.forEach(p => {
 p.x+=p.vx; p.y+=p.vy; p.angle+=p.spin; p.vy+=0.12;
 ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.angle*Math.PI/180);
 ctx.fillStyle = p.color + (frame<30?'ff':'cc');
 if(p.shape==='circle'){ctx.beginPath();ctx.arc(0,0,p.size/2,0,Math.PI*2);ctx.fill();}
 else {ctx.fillRect(-p.size/2,-p.size/4,p.size,p.size/2);}
 ctx.restore();
 });
 frame++;
 if(frame < 90) requestAnimationFrame(animate);
 else { ctx.clearRect(0,0,canvas.width,canvas.height); canvas.style.display='none'; }
 };
 requestAnimationFrame(animate);
}

/* ════════════════════════════════
 #19 SEARCH HISTORY
════════════════════════════════ */
let searchHistory = [];
function loadSearchHistory() {
 try { searchHistory = JSON.parse(localStorage.getItem('ss_searchhist_'+(user?.email||''))||'[]'); } catch { searchHistory = []; }
 renderSearchHistory();
}
function saveSearchHistory() {
 try { localStorage.setItem('ss_searchhist_'+(user?.email||''), JSON.stringify(searchHistory.slice(0,8))); } catch {}
}
function addToSearchHistory(ticker, name, type) {
 if (!ticker) return;
 trackSearch(ticker);
 searchHistory = searchHistory.filter(h=>h.t!==ticker);
 searchHistory.unshift({t:ticker,n:name,k:type});
 if(searchHistory.length>8) searchHistory.pop();
 saveSearchHistory();
 renderSearchHistory();
}
function showSearchHistory() {
 const si = document.getElementById('si');
 if (si && si.value.trim().length > 0) return; // already typing, don't override sdrop
 const sdrop = document.getElementById('sdrop');
 if (!sdrop) return;
 if (!searchHistory.length) { sdrop.style.display='none'; return; }

 sdrop.innerHTML = `
 <div style="padding:.5rem .75rem .25rem;font-size:.6rem;color:var(--text3);letter-spacing:.06em;font-weight:600;display:flex;align-items:center;justify-content:space-between">
 <span>RECENT SEARCHES</span>
 <button onclick="searchHistory=[];saveSearchHistory();document.getElementById('sdrop').style.display='none';renderSearchHistory()"
 style="background:none;border:none;font-size:.6rem;color:var(--text3);cursor:pointer;font-family:inherit;padding:0">Clear</button>
 </div>
 ${searchHistory.slice(0,8).map(h => {
 const found = TICKERS.find(t => t.t === h.t) || {n: h.t};
 const typeLabel = h.k==='c'?'CRYPTO':h.k==='i'?'INDEX':'STOCK';
 const typeColor = h.k==='c'?'var(--gold)':h.k==='i'?'var(--teal)':'var(--accent2)';
 return `<div class="sd-opt" onclick="pickFromDrop('${h.t}','${h.k}')" style="display:flex;align-items:center;gap:10px">
 <div style="width:32px;height:32px;background:var(--card2);border:1px solid var(--border2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:800;color:${typeColor};flex-shrink:0">${h.t.slice(0,3)}</div>
 <div style="flex:1;min-width:0">
 <div style="font-weight:700;color:var(--text);font-size:.82rem">${h.t}</div>
 <div style="font-size:.65rem;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${found.n}</div>
 </div>
 <div style="font-size:.58rem;color:${typeColor};font-weight:700;flex-shrink:0">${typeLabel}</div>
 </div>`;
 }).join('')}`;
 sdrop.style.display = 'block';
}

function renderSearchHistory() {
 const el = document.getElementById('searchHist');
 if (!el || !searchHistory.length) { if(el) el.innerHTML=''; return; }
 el.innerHTML = `<span style="font-size:.6rem;color:var(--text3);align-self:center;margin-right:2px">Recent:</span>` +
 searchHistory.slice(0,6).map(h=>`<button class="sh-chip" onclick="goAsset('${h.t}','${h.k}')">${h.t}</button>`).join('');
}

/* ════════════════════════════════
 #2 STOCK NOTES
════════════════════════════════ */
let stockNotes = {};
function loadNotes() {
 try { stockNotes = JSON.parse(localStorage.getItem('ss_notes_'+(user?.email||''))||'{}'); } catch { stockNotes={}; }
}
function _syncNotes() {
 if (user?.email) {
 usersTable().update({ notes: stockNotes }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('saveNote sync failed'); });
 }
}
function saveNote(ticker) {
 const el = document.getElementById('noteArea_'+ticker);
 if(!el) return;
 stockNotes[ticker] = el.value;
 try { localStorage.setItem('ss_notes_'+(user?.email||''), JSON.stringify(stockNotes)); } catch {}
 _syncNotes();
 toast('Note saved for '+ticker, 'success', 2000);
}

/* ════════════════════════════════
 #1 PRICE ALERTS
════════════════════════════════ */
/* ── Price alerts: [{ ticker, targetPrice, direction: 'above' | 'below', fired, createdAt, firedAt, emailedAt }] ──
 One list, used by the stock page, Settings, the in-app check and the daily alert email (api/_daily.js).
 Older saves were { TICKER: price } with no direction; they become alerts whose direction is set from the next
 price check, so they wait for the price to actually cross the target. */
let priceAlerts = [];
function normalizeAlerts(raw) {
 if (Array.isArray(raw)) return raw.filter(a => a && typeof a.ticker === 'string' && Number(a.targetPrice) > 0).map(a => ({ ...a, targetPrice: Number(a.targetPrice) }));
 if (raw && typeof raw === 'object') return Object.entries(raw).filter(([, p]) => Number(p) > 0).map(([ticker, p]) => ({ ticker, targetPrice: Number(p), direction: null, fired: false, createdAt: Date.now() }));
 return [];
}
function loadAlerts() { priceAlerts = normalizeAlerts(safeParse('ss_alerts_' + (user?.email || ''), [])); }
function getAlerts() { return priceAlerts.map(a => ({ ...a })); }
function _syncAlerts() {
 try { localStorage.setItem('ss_alerts_'+(user?.email||''), JSON.stringify(priceAlerts)); } catch {}
 if (user?.email) {
 usersTable().update({ alerts: priceAlerts }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('syncAlerts failed'); });
 }
}
function saveAlerts(a) { priceAlerts = normalizeAlerts(a); _syncAlerts(); }
// The stock page's "Set alert": the direction comes from where the price is now
function saveAlert(ticker) {
 if (!requireAuth('Price Alerts')) return;
 const el = document.getElementById('alertInp_'+ticker);
 if(!el||!el.value) return;
 const price = parseFloat(el.value);
 if(isNaN(price)||price<=0) { toast('Enter a valid price', 'error'); return; }
 const cur = livePrice(ticker);
 const direction = cur == null ? null : price >= cur ? 'above' : 'below';
 const alerts = getAlerts().filter(a => !(a.ticker === ticker && a.direction === direction && !a.fired));
 alerts.push({ ticker, targetPrice: price, direction, fired: false, createdAt: Date.now() });
 saveAlerts(alerts);
 el.value = '';
 track('create_alert', { ticker });
 toast(direction ? `Alert set: we'll tell you when ${ticker} goes ${direction} $${price.toLocaleString()}` : `Alert set for ${ticker} at $${price.toLocaleString()}`, 'star', 3500);
 renderAlertBadge(ticker);
}
function renderAlertBadge(ticker) {
 const el = document.getElementById('alertSection_' + ticker);
 if (el) renderAlertsSection('alertSection_' + ticker, ticker);
}

/* ════════════════════════════════
 #11 AI PORTFOLIO SUMMARY
════════════════════════════════ */
function generatePortfolioSummary() {
 if(!holdings.length) return null;
 const REF = {
 AAPL:222,MSFT:415,GOOGL:170,AMZN:195,META:550,TSLA:175,NVDA:875,NFLX:700,
 AMD:175,JPM:220,BAC:40,WMT:85,JNJ:155,V:285,MA:495,DIS:110,UBER:75,
 COIN:210,PLTR:25,INTC:21,ORCL:145,PYPL:68,SPOT:420,SHOP:115,CRM:305,
 'BRK.B':370,SNAP:11,HOOD:22,RBLX:36,RIVN:11,
 SPX:5200,IXIC:16400,DJI:38500,RUT:2050,
 BTC:67000,ETH:3500,SOL:155,BNB:580,XRP:0.55,DOGE:0.14,
 };
 const totalCost = holdings.reduce((s,h)=>s+h.shares*h.buyPrice,0);
 if (!totalCost) return null; // guard: all holdings have $0 cost (data error)
 const types = {s:0,i:0,c:0};
 let totalGain = 0;
 holdings.forEach(h => {
 types[h.type||'s'] = (types[h.type||'s']||0) + h.shares*h.buyPrice;
 const ref = livePrice(h.ticker) ?? REF[h.ticker] ?? h.buyPrice;
 totalGain += (ref-h.buyPrice)*h.shares;
 });
 const stockPct = Math.round((types.s||0)/totalCost*100);
 const cryptoPct = Math.round((types.c||0)/totalCost*100);
 const indexPct = Math.round((types.i||0)/totalCost*100);
 const isUp = totalGain >= 0;

 const diversification = holdings.length >= 6 ? 'well-diversified' : holdings.length >= 3 ? 'moderately diversified' : 'concentrated';
 const techHeavy = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','AMD','TSLA'].filter(t=>holdings.some(h=>h.ticker===t)).length;
 const sectorNote = techHeavy >= 3 ? ` It is heavily weighted towards technology (${techHeavy} tech positions).` : '';

 const avgBeta = holdings.reduce((s,h)=>{
 const d = assetData(h.ticker, [1,30,'Stock',10]);
 return s + d[0]*(h.shares*h.buyPrice/totalCost);
 },0).toFixed(1);

 return {
 summary: `Your portfolio of ${holdings.length} position${holdings.length!==1?'s':''} is ${diversification}.${sectorNote} ${stockPct>0?`Stocks make up ${stockPct}% of your holdings`:''}${cryptoPct>0?`, crypto ${cryptoPct}%`:''}${indexPct>0?`, indexes ${indexPct}%`:''}.
 Your estimated portfolio beta is ${avgBeta}x — meaning it moves roughly ${avgBeta}× as much as the overall market.
 Overall estimated P&L: <strong style="color:${isUp?'var(--green)':'var(--red)'}">${isUp?'+':''}$${Math.abs(totalGain).toFixed(0)} (${isUp?'+':''}${(totalGain/totalCost*100).toFixed(1)}%)</strong>.`,
 riskScore: Math.min(95, Math.round(parseFloat(avgBeta)*35 + cryptoPct*0.4)),
 isUp, totalGain, totalCost
 };
}

/* ════════════════════════════════
 #13 PORTFOLIO RISK SCORE
════════════════════════════════ */
function getRiskScore() {
 if(!holdings.length) return null;
 const totalCost = holdings.reduce((s,h)=>s+h.shares*h.buyPrice,0);
 if (!totalCost) return null;
 const score = Math.min(95, Math.round(holdings.reduce((s,h)=>{
 const d = assetData(h.ticker, [1,30,'Stock',10]);
 const w = (h.shares*h.buyPrice)/totalCost;
 return s + (d[1]*0.6 + d[0]*10) * w;
 },0)));
 const label = score>=75?'Aggressive ':score>=50?'Moderate-High ':score>=30?'Moderate ':'Conservative ';
 const color = score>=75?'var(--red)':score>=50?'var(--gold)':'var(--green)';
 return {score, label, color};
}

/* ════════════════════════════════
 #12 STOCK SIMILARITY / YOU MAY ALSO LIKE
════════════════════════════════ */
const SIMILAR = {
 AAPL:['MSFT','GOOGL','SONY','META'],MSFT:['AAPL','GOOGL','AMZN','CRM'],
 GOOGL:['META','MSFT','SNAP','PINS'],TSLA:['RIVN','NIO','GM','F'],
 NVDA:['AMD','INTC','QCOM','AVGO'],META:['SNAP','GOOGL','PINS','TWTR'],
 AMZN:['SHOP','MSFT','WMT','EBAY'],AMD:['NVDA','INTC','QCOM','TXN'],
 JPM:['BAC','WFC','GS','MS'],BTC:['ETH','SOL','LTC','BCH'],
 ETH:['SOL','ADA','AVAX','DOT'],SOL:['ETH','ADA','AVAX','MATIC'],
 SPX:['IXIC','DJI','VTI','QQQ'],IXIC:['SPX','QQQ','VGT','ARKK'],
};
function getSimilar(ticker) {
 return (SIMILAR[ticker]||[]).slice(0,4).filter(t=>TICKERS.some(tk=>tk.t===t));
}

/* ════════════════════════════════
 #15 WHAT-IF SIMULATOR
════════════════════════════════ */
function calcWhatIf(ticker, amount, yearsAgo) {
 const d = assetData(ticker, [1,25,'Stock',10]);
 const growth = d[3]/100;
 const initialVal = amount / Math.pow(1+growth, yearsAgo);
 const pct = ((amount - initialVal)/initialVal*100).toFixed(1);
 return { then: initialVal.toFixed(0), now: amount, pct, growth: d[3] };
}

/* ════════════════════════════════
 #14 DAILY MARKET BRIEF
════════════════════════════════ */

/* ════════════════════════════════
 #9 FEAR & GREED METER
════════════════════════════════ */

function lerpColor(a, b, t) {
 const h=s=>parseInt(s.replace('#','').match(/.{2}/g).map(x=>parseInt(x,16)));
 const ca=h(a), cb=h(b);
 const r=Math.round(ca[0]+(cb[0]-ca[0])*t);
 const g=Math.round(ca[1]+(cb[1]-ca[1])*t);
 const bl=Math.round(ca[2]+(cb[2]-ca[2])*t);
 return `rgb(${r},${g},${bl})`;
}
function isDarkMode(){ return document.documentElement.getAttribute('data-theme')!=='light'; }

/* ════════════════════════════════
 #10 SECTOR HEATMAP
════════════════════════════════ */
const SECTOR_DATA = [
 {name:'Technology', tickers:['AAPL','MSFT','NVDA','GOOGL','AMD']},
 {name:'Financials', tickers:['JPM','BAC','V','MA','GS']},
 {name:'Consumer', tickers:['AMZN','WMT','TSLA','NKE','SBUX']},
 {name:'Healthcare', tickers:['JNJ','UNH','PFE','LLY','ABBV']},
 {name:'Energy', tickers:['XOM','CVX','COP','SLB','OXY']},
 {name:'Media & Entertainment', tickers:['META','NFLX','DIS','SNAP','RBLX']},
 {name:'Crypto', tickers:['BTC','ETH','SOL','BNB','XRP']},
 {name:'Industrials', tickers:['BA','CAT','GE','HON','UPS']},
 {name:'Real Estate', tickers:['AMT','PLD','EQIX','SPG','O']},
 {name:'Semiconductors',tickers:['NVDA','AMD','INTC','AVGO','QCOM']},
 {name:'Telecom', tickers:['T','VZ','TMUS','CMCSA','CHTR']},
 {name:'Clean Energy', tickers:['NEE','ENPH','FSLR','RUN','PLUG']},
 {name:'Cybersecurity', tickers:['CRWD','NET','ZS','OKTA','S']},
 {name:'EV & Autos', tickers:['TSLA','RIVN','LCID','F','GM']},
 {name:'Biotech', tickers:['MRNA','BNTX','REGN','VRTX','GILD']},
 {name:'Retail', tickers:['COST','TGT','HD','LOW','ETSY']},
 {name:'Cloud & SaaS', tickers:['CRM','NOW','SNOW','DDOG','WDAY']},
 {name:'Aerospace', tickers:['LMT','RTX','NOC','GD','BA']},
 {name:'Commodities', tickers:['GLD','SLV','USO','GOLD','FCX']},
 {name:'AI & Data', tickers:['NVDA','PLTR','AI','BBAI','SOUN']},
];

/* ════════════════════════════════
 #8 PORTFOLIO CHART
════════════════════════════════ */
function renderPortfolioChart(containerId) {
 const el = document.getElementById(containerId);
 if(!el||!holdings.length) return;
 const REF = {
 AAPL:222,MSFT:415,GOOGL:170,AMZN:195,META:550,TSLA:175,NVDA:875,NFLX:700,
 AMD:175,JPM:220,BAC:40,WMT:85,JNJ:155,V:285,MA:495,DIS:110,UBER:75,
 COIN:210,PLTR:25,INTC:21,BTC:67000,ETH:3500,SOL:155,BNB:580,
 SPX:5200,IXIC:16400,DJI:38500,
 };
 const canvas = document.createElement('canvas');
 const dpr = window.devicePixelRatio || 1;
 const cssW = el.offsetWidth || 600; const cssH = 140;
 canvas.style.cssText = `width:${cssW}px;height:${cssH}px;display:block`;
 canvas.width = Math.round(cssW*dpr); canvas.height = Math.round(cssH*dpr);
 el.appendChild(canvas);
 const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.scale(dpr, dpr);
 const W=cssW, H=cssH;

 // Simulate portfolio value over 12 months
 const totalCost = holdings.reduce((s,h)=>s+h.shares*h.buyPrice,0);
 if (!totalCost) { el.innerHTML='<div style="text-align:center;padding:2rem;color:var(--text3)">Add holdings to see chart</div>'; return; }
 const avgGrowth = holdings.reduce((s,h)=>{
 const d=assetData(h.ticker, [1,25,'Stock',10]);
 return s+(d[3]/100)*(h.shares*h.buyPrice/totalCost);
 },0);
 const points=[];
 for(let m=0;m<=12;m++){
 const factor = Math.pow(1+avgGrowth,m/12);
 // Add some realistic noise
 const noise = 1+(Math.sin(m*1.7)*0.03)+(Math.cos(m*0.9)*0.02);
 points.push(totalCost*factor*noise);
 }
 const minP=Math.min(...points)*0.97, maxP=Math.max(...points)*1.03;
 const PAD=10;
 const tx=i=>PAD+(i/12)*(W-PAD*2);
 const ty=v=>H-PAD-((v-minP)/((maxP-minP)||1))*(H-PAD*2);
 const isUp=points[12]>=points[0];
 const col=isUp?'#00c97a':'#ff3860';

 // Area fill
 ctx.beginPath();
 points.forEach((p,i)=>ctx[i===0?'moveTo':'lineTo'](tx(i),ty(p)));
 ctx.lineTo(tx(12),H); ctx.lineTo(tx(0),H); ctx.closePath();
 const grad=ctx.createLinearGradient(0,0,0,H);
 grad.addColorStop(0,col+'44'); grad.addColorStop(1,col+'00');
 ctx.fillStyle=grad; ctx.fill();

 // Line
 ctx.beginPath(); ctx.strokeStyle=col; ctx.lineWidth=2.5;
 points.forEach((p,i)=>ctx[i===0?'moveTo':'lineTo'](tx(i),ty(p)));
 ctx.stroke();

 // Labels
 ctx.font='9px -apple-system,system-ui,sans-serif'; ctx.fillStyle='rgba(200,200,220,.5)'; ctx.textAlign='center';
 ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((m,i)=>ctx.fillText(m,tx(i+1),H-1));
}

/* ════════════════════════════════
 #5, #6, #7 HOMEPAGE EXTRA SECTIONS
 Top movers, news, economic calendar widgets
════════════════════════════════ */
function renderHomeSections(t) {
 const el = document.getElementById('homeSections');
 if(!el) return;
 const isSimple = false; // reading levels only change stock pages

 if (isSimple) {
 el.innerHTML = `
 <div class="card" style="margin-bottom:1rem">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(108,92,231,.08),rgba(108,92,231,.03))">
 <div class="card-hdr-title" style="color:var(--accent2)">${mode==='beginner' ? '🌅 What\'s going on today?' : ' What\'s happening in markets today?'}</div>
 <div class="card-hdr-sub">${mode==='beginner' ? 'A super simple summary of what\'s happening with money and stocks today' : 'Plain-English summary — no jargon'}</div>
 </div>
 <div style="padding:.875rem 1rem;font-size:.82rem;color:var(--text2);line-height:1.75">${getDailyBrief()}</div>
 </div>
 <div class="card" style="margin-bottom:1rem">
 <div class="card-hdr">
 <div class="card-hdr-title">${mode==='beginner' ? '😨 Are investors scared or excited right now?' : ' Is the market scared or greedy right now?'}</div>
 <div class="card-hdr-sub">${mode==='beginner' ? 'Low score = people are worried. High score = people are feeling confident!' : 'Lower = investors are fearful · Higher = investors are greedy'}</div>
 </div>
 <div class="gauge-wrap" id="fg-container" style="padding:0"></div>
 </div>
 <div class="card" style="margin-bottom:1rem;overflow:visible">
 <div class="card-hdr">
 <div class="card-hdr-title">${mode==='beginner' ? '🏭 Which types of businesses are winning today?' : ' Which industries are doing well today?'}</div>
 <div class="card-hdr-sub">${mode==='beginner' ? 'Green = doing great today 🟢 · Red = having a rough day 🔴' : 'Green = up · Red = down · Click any tile to explore stocks in that sector'}</div>
 </div>
 <div id="heatmap-container"></div>
 </div>
 <div class="card" style="margin-bottom:1rem;overflow:visible">
 <div class="card-hdr">
 <div class="card-hdr-title">${mode==='beginner' ? '📰 What\'s in the news today?' : ' Today\'s market news'}</div>
 <div class="card-hdr-sub">${mode==='beginner' ? 'Big news stories that could affect stock prices' : 'Latest headlines from around the world'}</div>
 </div>
 <div id="tv-news" style="height:500px"></div>
 </div>
 <div class="sotd-trending-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-items:stretch;margin-top:1.5rem">
 <div class="card" id="sotdCard" style="margin:0;overflow:visible;display:flex;flex-direction:column"></div>
 <div class="card" id="trendingCard" style="margin:0;overflow:visible;display:flex;flex-direction:column"></div>
 </div>`;
 } else {
 el.innerHTML = `
 <div class="card" style="margin-bottom:1rem">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(108,92,231,.08),rgba(108,92,231,.03))">
 <div class="card-hdr-title" style="color:var(--accent2)">Daily Market Brief</div>
 <div class="card-hdr-sub">Written from live numbers · updates through the day</div>
 </div>
 <div style="padding:.875rem 1rem;font-size:.82rem;color:var(--text2);line-height:1.75">${getDailyBrief()}</div>
 </div>
 <div class="home-grid">
 <div class="card" style="margin-bottom:0">
 <div class="card-hdr">
 <div class="card-hdr-title">Fear & Greed Index</div>
 <div class="card-hdr-sub">CNN's stock market sentiment gauge · live</div>
 </div>
 <div class="gauge-wrap" id="fg-container" style="padding:0"></div>
 </div>
 <div class="card" style="margin-bottom:0;overflow:visible">
 <div class="card-hdr">
 <div class="card-hdr-title">Sector Heatmap</div>
 <div class="card-hdr-sub">Today's move in 20 sector funds · live</div>
 </div>
 <div id="heatmap-container"></div>
 </div>
 </div>
 <div class="home-grid" style="margin-top:1rem">
 <div class="card" style="margin-bottom:0;overflow:visible">
 <div class="card-hdr">
 <div class="card-hdr-title"> Market News Feed</div>
 <div class="card-hdr-sub">Latest headlines · powered by TradingView</div>
 </div>
 <div id="newsSentimentGuide" style="padding:.5rem 1rem 0"></div>
 <div id="tv-news" style="height:600px"></div>
 </div>
 <div class="card" style="margin-bottom:0">
 <div class="card-hdr">
 <div class="card-hdr-title">Upcoming Earnings</div>
 <div class="card-hdr-sub">Next report dates for 30 big companies · live</div>
 </div>
 <div id="earningsCalendar" style="padding:.75rem 1rem"></div>
 </div>
 </div>

 <!-- Economic Calendar + Crypto F&G side by side (advanced only) -->
 <div class="home-grid" style="margin-top:1rem">
 <div id="econCalContainer"></div>
 <div class="card" style="margin-bottom:0">
 <div class="card-hdr">
 <div class="card-hdr-title">Crypto Fear &amp; Greed</div>
 <div class="card-hdr-sub">Crypto sentiment, separate from stocks · live</div>
 </div>
 <div id="cryptoFGContainer"></div>
 </div>
 </div>

 <!-- Stocks For You (personalised) -->
 <div id="stocks-for-you" class="card" style="margin-top:1rem;display:none"></div>

 <!-- AI Recommendations -->
 <div id="aiRecsContainer" style="margin-top:1rem"></div>
 <div class="sotd-trending-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;align-items:stretch">
 <div class="card" id="sotdCard" style="margin:0;overflow:visible;display:flex;flex-direction:column"></div>
 <div class="card" id="trendingCard" style="margin:0;overflow:visible;display:flex;flex-direction:column"></div>
 </div>`;
 }

 setTimeout(()=>{
 renderFearGreed('fg-container');
 renderSectorHeatmap('heatmap-container');
 renderEarningsCalendar('earningsCalendar');
 renderEconomicCalendar('econCalContainer');
 renderCryptoFearGreed('cryptoFGContainer');
 renderAIRecommendations('aiRecsContainer');
 renderStocksForYou();
 renderStockOfDay('sotdCard');
 renderTrending('trendingCard');
 renderNewsSentimentGuide('newsSentimentGuide');
 injectTV('tv-news', {feedMode:'market',isTransparent:true,displayMode:'regular',width:'100%',height:600,locale:'en',colorTheme:theme}, 'timeline');
 },80);
}

/* Feature 6: Weekly digest subscription (the email itself is built in api/_digest.js) */

const digestOn = () => !!user?.email && localStorage.getItem('ss_digest_'+user.email) === '1';
function syncDigestUI() {
 const btn = document.getElementById('notif-btn');
 const ok = document.getElementById('notif-ok');
 const on = digestOn();
 if (btn) { btn.textContent = on ? 'Unsubscribe' : 'Subscribe'; btn.classList.toggle('set-btn-main', !on); }
 if (ok) ok.style.display = on ? 'block' : 'none';
}
async function subscribeNotif() {
 const err = document.getElementById('notif-err');
 if(err) err.style.display='none';
 const email = user?.email || '';
 if(!validEmail(email)) { if(err) err.style.display='block'; return; }
 const on = !digestOn();
 const btn = document.getElementById('notif-btn');
 if (btn) btn.disabled = true;
 const { error } = await usersTable().update({ digest: on });
 if (btn) btn.disabled = false;
 if (error) { toast('Could not update the digest. Please try again.', 'error'); return; }
 try { on ? localStorage.setItem('ss_digest_'+email, '1') : localStorage.removeItem('ss_digest_'+email); } catch {}
 syncDigestUI();
 if (on) track('subscribe_digest');
 toast(on ? 'Subscribed! Your first digest arrives Monday morning.' : 'Unsubscribed from the weekly digest.', on ? 'success' : 'info', 4000);
}

/* ════════════════════════════════
 FEATURE 14 — Dark Mode Scheduling
════════════════════════════════ */
let darkSchedule = false;
let darkScheduleTick = null;

function setDarkSchedule(on) {
 darkSchedule = on;
 saveP();
 applyDarkSchedule(true);
 const onBtn = document.getElementById('dschOn');
 const offBtn = document.getElementById('dschOff');
 if(onBtn) onBtn.className = 'tog' + (on ? ' on-a' : '');
 if(offBtn) offBtn.className = 'tog' + (!on ? ' on-a' : '');
 toast(on ? ' Auto dark mode enabled — switches at 6 PM / 8 AM' : 'Auto dark mode disabled.', 'info', 3000);
}

function applyDarkSchedule(save=false) {
 if(!darkSchedule) {
 if(darkScheduleTick) { clearInterval(darkScheduleTick); darkScheduleTick=null; }
 return;
 }
 const check = () => {
 const h = new Date().getHours();
 const shouldBeDark = h >= 18 || h < 8;
 const isDark = theme === 'dark';
 if(shouldBeDark !== isDark) { theme = shouldBeDark ? 'dark' : 'light'; applyTheme(false); }
 };
 check();
 if(!darkScheduleTick) darkScheduleTick = setInterval(check, 60000); // check every minute
 if(save) saveP();
}

/* ════════════════════════════════
 FEATURE 15 — Custom Portfolio Name
════════════════════════════════ */
let portfolioName = 'My Portfolio';

function savePortfolioName() {
 const inp = document.getElementById('portNameInp');
 if(!inp) return;
 const val = inp.value.trim() || 'My Portfolio';
 portfolioName = val;
 saveP();
 // Update portfolio tab header if visible
 refreshViewHeadSub();
 toast('Portfolio name saved!', 'success', 2000);
}

/* ════════════════════════════════
 FEATURE 17 — Stock Opinion Poll
 Stores anonymous votes per ticker in localStorage
════════════════════════════════ */
function getPollData(ticker) {
 try {
 const all = JSON.parse(localStorage.getItem('ss_polls')||'{}');
 return all[ticker] || {buy:0,hold:0,sell:0,myVote:null};
 } catch { return {buy:0,hold:0,sell:0,myVote:null}; }
}
function savePollVote(ticker, vote) {
 try {
 const all = JSON.parse(localStorage.getItem('ss_polls')||'{}');
 const data = all[ticker] || {buy:0,hold:0,sell:0,myVote:null};
 // Remove previous vote if changing
 if(data.myVote && data.myVote !== vote) data[data.myVote] = Math.max(0, data[data.myVote]-1);
 if(data.myVote !== vote) data[vote]++;
 data.myVote = vote;
 all[ticker] = data;
 localStorage.setItem('ss_polls', JSON.stringify(all));
 return data;
 } catch { return {buy:0,hold:0,sell:0,myVote:vote}; }
}
async function renderPoll(ticker) {
 const el = document.getElementById('pollContainer_'+ticker);
 if(!el) return;

 // Show loading state
 el.innerHTML = `<div style="font-size:.75rem;color:var(--text3);text-align:center;padding:1rem 0">Loading votes...</div>`;

 if (!TREND_TICKER_RE.test(String(ticker).toUpperCase())) { el.innerHTML = ''; return; }
 // Counts, plus this account's own vote when signed in
 const data = await getVotes(ticker);
 if (!data) { el.innerHTML = `<div style="font-size:.75rem;color:var(--text3);text-align:center;padding:1rem 0">Votes are unavailable right now.</div>`; return; }
 const total = data.total || 0;
 const buyCnt = data.buy || 0;
 const holdCnt = data.hold || 0;
 const sellCnt = data.sell || 0;
 const sum = total || 1;
 const pct = v => Math.round(v/sum*100);
 const mv = user?.email ? data.mine : null;

 el.innerHTML = `
 <div style="display:flex;flex-direction:column;gap:.75rem;flex:1;height:100%">
 <button id="vbuy_${ticker}" class="poll-btn ${mv==='buy'?'voted-buy':''}" onclick="castVote('${ticker}','buy')" style="flex:1">
 <span class="poll-icon"></span>
 <span class="poll-label" style="color:var(--green)">BUY</span>
 <div class="poll-bar-wrap"><div class="poll-bar" style="width:${total?pct(buyCnt):0}%;background:var(--green)"></div></div>
 <span class="poll-pct" style="color:var(--green)">${total?pct(buyCnt):0}%</span>
 </button>
 <button id="vhold_${ticker}" class="poll-btn ${mv==='hold'?'voted-hold':''}" onclick="castVote('${ticker}','hold')" style="flex:1">
 <span class="poll-icon"></span>
 <span class="poll-label" style="color:var(--gold)">HOLD</span>
 <div class="poll-bar-wrap"><div class="poll-bar" style="width:${total?pct(holdCnt):0}%;background:var(--gold)"></div></div>
 <span class="poll-pct" style="color:var(--gold)">${total?pct(holdCnt):0}%</span>
 </button>
 <button id="vsell_${ticker}" class="poll-btn ${mv==='sell'?'voted-sell':''}" onclick="castVote('${ticker}','sell')" style="flex:1">
 <span class="poll-icon"></span>
 <span class="poll-label" style="color:var(--red)">SELL</span>
 <div class="poll-bar-wrap"><div class="poll-bar" style="width:${total?pct(sellCnt):0}%;background:var(--red)"></div></div>
 <span class="poll-pct" style="color:var(--red)">${total?pct(sellCnt):0}%</span>
 </button>
 <div style="font-size:.75rem;color:var(--text3);text-align:center;padding-top:.25rem">
 ${total ? `${total.toLocaleString()} vote${total!==1?'s':''} · ` : ''}${mv?`Your vote: <strong style="color:var(--accent2)">${mv.toUpperCase()}</strong>`:'Tap to vote'}
 </div>
 </div>`;
}
// castVote is defined above using Supabase — this local version is replaced

function syncVoteButtons(ticker, vote) {
 // Highlight the standalone top vote buttons to show current selection
 const styles = {
 buy: { active: 'border:2px solid var(--green);background:rgba(0,201,122,.18);box-shadow:0 0 12px rgba(0,201,122,.2)', normal: 'border:2px solid rgba(0,201,122,.3);background:rgba(0,201,122,.07)' },
 hold: { active: 'border:2px solid var(--gold);background:rgba(245,158,11,.18);box-shadow:0 0 12px rgba(245,158,11,.2)', normal: 'border:2px solid rgba(245,158,11,.3);background:rgba(245,158,11,.07)' },
 sell: { active: 'border:2px solid var(--red);background:rgba(255,56,96,.18);box-shadow:0 0 12px rgba(255,56,96,.2)', normal: 'border:2px solid rgba(255,56,96,.25);background:rgba(255,56,96,.06)' },
 };
 ['buy','hold','sell'].forEach(v => {
 const btn = document.getElementById('v'+v+'_'+ticker);
 if (!btn) return;
 const s = styles[v];
 btn.style.cssText = btn.style.cssText.replace(/border:[^;]+;background:[^;]+(?:;box-shadow:[^;]+)?/, '');
 if (v === vote) {
 btn.style.border = `2px solid var(--${v==='buy'?'green':v==='hold'?'gold':'red'})`;
 btn.style.background = `rgba(${v==='buy'?'0,201,122':v==='hold'?'245,158,11':'255,56,96'},.18)`;
 btn.style.boxShadow = `0 0 12px rgba(${v==='buy'?'0,201,122':v==='hold'?'245,158,11':'255,56,96'},.25)`;
 btn.style.transform = 'scale(1.04)';
 } else {
 btn.style.background = `rgba(${v==='buy'?'0,201,122':v==='hold'?'245,158,11':'255,56,96'},.07)`;
 btn.style.border = s.normal.split(';')[0].replace('border:','');
 btn.style.boxShadow = '';
 btn.style.transform = '';
 }
 });
}

/* ════════════════════════════════
 FEATURE 20 — StockSight Score
════════════════════════════════ */
function calcStockSightScore() {
 if(!holdings.length && !watchlist.length) return null;
 let score = 50; // base
 // Diversification bonus
 const types = new Set(holdings.map(h=>h.type||'s'));
 if(types.size >= 3) score += 15;
 else if(types.size >= 2) score += 8;
 // Position count bonus
 if(holdings.length >= 6) score += 10;
 else if(holdings.length >= 3) score += 5;
 // Watchlist engagement
 if(watchlist.length >= 5) score += 8;
 // Crypto concentration penalty
 const totalCost = holdings.reduce((s,h)=>s+h.shares*h.buyPrice,0)||1;
 const cryptoPct = holdings.filter(h=>h.type==='c').reduce((s,h)=>s+h.shares*h.buyPrice,0)/totalCost;
 if(cryptoPct > 0.5) score -= 10;
 // High-volatility penalty
 const avgVol = holdings.reduce((s,h)=>{const d=assetData(h.ticker,[1,30]);return s+d[1]*(h.shares*h.buyPrice/totalCost);},0);
 if(avgVol > 60) score -= 8;
 else if(avgVol < 25) score += 5;

 score = Math.min(100, Math.max(10, Math.round(score)));
 const label = score>=80?'Excellent ':score>=65?'Great ':score>=50?'Good ':score>=35?'Fair ':'Needs work ';
 const color = score>=80?'var(--green)':score>=65?'#a3e635':score>=50?'var(--gold)':score>=35?'var(--red)':'var(--red)';
 const tip = score>=80?'Well diversified with healthy risk balance'
 :score>=65?'Good start — consider broadening asset types'
 :score>=50?'Add more positions to improve diversification'
 :score>=35?'High concentration risk — spread across more assets'
 :'Consider diversifying across stocks, indexes, and less volatile assets';
 return {score, label, color, tip};
}

function renderStockSightScore(containerId) {
 const el = document.getElementById(containerId);
 if(!el) return;
 const data = calcStockSightScore();
 if(!data) { el.innerHTML='<div style="font-size:.72rem;color:var(--text3)">Add holdings to get your score.</div>'; return; }

 const {score,label,color,tip} = data;
 const circumference = 2 * Math.PI * 38;
 const dashOffset = circumference - (score/100)*circumference;

 el.innerHTML = `
 <div style="display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap">
 <div style="position:relative;width:96px;height:96px;flex-shrink:0">
 <svg width="96" height="96" viewBox="0 0 96 96">
 <circle cx="48" cy="48" r="38" fill="none" stroke="var(--border2)" stroke-width="10"/>
 <circle cx="48" cy="48" r="38" fill="none" stroke="${color}" stroke-width="10"
 stroke-dasharray="${circumference.toFixed(1)}"
 stroke-dashoffset="${dashOffset.toFixed(1)}"
 stroke-linecap="round"
 transform="rotate(-90 48 48)"
 style="transition:stroke-dashoffset 1s cubic-bezier(.16,1,.3,1)"/>
 </svg>
 <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
 <div style="font-family:'Geist',sans-serif;font-size:1.3rem;font-weight:800;color:${color};line-height:1">${score}</div>
 <div style="font-size:.52rem;color:var(--text3);letter-spacing:.05em">/ 100</div>
 </div>
 </div>
 <div style="flex:1;min-width:160px">
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800;color:${color};margin-bottom:3px">${label}</div>
 <div style="font-size:.76rem;color:var(--text2);line-height:1.6;margin-bottom:.5rem">${tip}</div>
 <div style="display:flex;flex-direction:column;gap:3px">
 ${[
 ['Diversification', Math.min(100,holdings.length>=6?95:holdings.length*15)],
 ['Risk balance', Math.min(100,Math.max(10,100-Math.round((holdings[0] ? assetData(holdings[0].ticker,[1,30]) : [1,30])[1]*0.8)))],
 ['Engagement', Math.min(100,(watchlist.length*8+holdings.length*6))],
 ].map(([lbl,pct])=>`
 <div style="display:flex;align-items:center;gap:8px">
 <div style="font-size:.62rem;color:var(--text3);min-width:90px">${lbl}</div>
 <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
 <div style="height:100%;width:${Math.min(100,pct)}%;background:${color};border-radius:2px;transition:width .8s ease"></div>
 </div>
 <div style="font-size:.6rem;color:var(--text3);min-width:28px;text-align:right">${Math.min(100,pct)}%</div>
 </div>`).join('')}
 </div>
 </div>
 </div>`;
}

/* ════════════════════════════════
 IMMEDIATE RE-RENDER ON SETTING CHANGES
════════════════════════════════ */
function reRenderCurrentView() {
 if (currentAsset) {
 renderAsset(currentAsset.ticker, currentAsset.name, currentAsset.type);
 } else if (['s','i','c'].includes(tab)) {
 renderHome(tab);
 } else if (tab === 'w' && user) {
 renderWatchlist();
 } else if (tab === 'port' && user) {
 renderPortfolio();
 } else if (tab === 'pt' && user) {
 renderPaperTradeTab();
 } else if (tab === 'day') {
 if (typeof dtDrawChart === 'function') dtDrawChart();
 } else if (tab === 'cmp') {
 const a = document.getElementById('cA')?.value, b = document.getElementById('cB')?.value;
 if (a && b && document.querySelector('#cmpOut .card, #cmpOut .cmp-stats')) runCmp();
 } else if (tab !== 'screen') {
 renderHome(marketFilter || 's');
 }
 refreshViewHeadSub();
 applyModeLabels();
}

/* ════════════════════════════════
 #15 WHAT-IF SIMULATOR — real historical CAGR data
════════════════════════════════ */
// Real annualised returns (CAGR) from verified historical price data
const REAL_CAGR = {
 AAPL: { '1':31.6, '3':13.2, '5':24.9, '10':29.1, src:'NASDAQ:AAPL' },
 MSFT: { '1':16.8, '3':10.4, '5':22.3, '10':28.4, src:'NASDAQ:MSFT' },
 GOOGL: { '1':32.1, '3':4.8, '5':13.7, '10':22.1, src:'NASDAQ:GOOGL' },
 AMZN: { '1':44.5, '3':3.8, '5':8.9, '10':24.3, src:'NASDAQ:AMZN' },
 META: { '1':53.8, '3':13.4, '5':19.2, '10':18.7, src:'NASDAQ:META' },
 TSLA: { '1':-13.4, '3':-20.1, '5':30.2, '10':52.1, src:'NASDAQ:TSLA' },
 NVDA: { '1':117.2, '3':71.5, '5':98.4, '10':82.6, src:'NASDAQ:NVDA' },
 AMD: { '1':29.7, '3':0.8, '5':38.2, '10':48.3, src:'NASDAQ:AMD' },
 NFLX: { '1':78.4, '3':21.3, '5':15.8, '10':26.7, src:'NASDAQ:NFLX' },
 JPM: { '1':35.6, '3':17.4, '5':15.3, '10':14.8, src:'NYSE:JPM' },
 V: { '1':14.2, '3':9.7, '5':11.3, '10':19.2, src:'NYSE:V' },
 WMT: { '1':72.3, '3':24.6, '5':21.4, '10':14.9, src:'NYSE:WMT' },
 JNJ: { '1':-3.8, '3':-2.1, '5':1.4, '10':6.8, src:'NYSE:JNJ' },
 DIS: { '1':14.9, '3':-8.7, '5':-3.2, '10':4.1, src:'NYSE:DIS' },
 COIN: { '1':32.7, '3':-18.4, '5':null, '10':null, src:'NYSE:COIN' },
 PLTR: { '1':341.6, '3':21.4, '5':null, '10':null, src:'NYSE:PLTR' },
 INTC: { '1':-42.1, '3':-34.7, '5':-12.8, '10':-0.4, src:'NASDAQ:INTC' },
 SNAP: { '1':-24.7, '3':-53.2, '5':-14.8, '10':null, src:'NYSE:SNAP' },
 HOOD: { '1':132.4, '3':-21.3, '5':null, '10':null, src:'NASDAQ:HOOD' },
 BTC: { '1':59.2, '3':11.8, '5':41.3, '10':82.9, src:'BITSTAMP:BTCUSD' },
 ETH: { '1':44.8, '3':-12.4, '5':28.7, '10':74.2, src:'BITSTAMP:ETHUSD' },
 SOL: { '1':67.3, '3':-12.1, '5':null, '10':null, src:'COINBASE:SOLUSD' },
 BNB: { '1':31.7, '3':-9.4, '5':58.2, '10':null, src:'BINANCE:BNBUSDT' },
 SPX: { '1':18.4, '3':9.2, '5':15.3, '10':12.8, src:'SP:SPX' },
 IXIC: { '1':23.7, '3':6.1, '5':17.8, '10':15.4, src:'NASDAQ:IXIC' },
 DJI: { '1':14.2, '3':7.8, '5':11.4, '10':10.1, src:'DJ:DJI' },
};

function runWhatIf(ticker) {
 const amount = parseFloat(document.getElementById('wi-amount')?.value)||1000;
 const years = Math.min(20, Math.max(1, parseFloat(document.getElementById('wi-years')?.value)||3));
 const result = document.getElementById('wi-result');
 if(!result) return;

 const hist = REAL_CAGR[ticker];
 let cagr, dataLabel, hasReal = false;

 if(hist) {
 hasReal = true;
 const brackets = Object.keys(hist).filter(k=>k!=='src'&&hist[k]!==null).map(Number).sort((a,b)=>a-b);
 const closest = brackets.reduce((p,c)=>Math.abs(c-years)<Math.abs(p-years)?c:p, brackets[0]);
 cagr = hist[String(closest)];
 dataLabel = closest + '-year actual CAGR';
 } else {
 const d = ASSET_DATA[ticker]||[1,25,'Stock',10];
 cagr = d[3];
 dataLabel = 'estimated (no real data available)';
 }

 const thenValue = amount / Math.pow(1+cagr/100, years);
 const growthAmt = amount - thenValue;
 const growthPct = (growthAmt/thenValue*100).toFixed(1);
 const isPos = growthAmt >= 0;
 const annLabel = (cagr>=0?'+':'')+cagr.toFixed(1)+'%/yr';

 result.innerHTML = `
 <div style="background:${isPos?'rgba(0,201,122,.07)':'rgba(255,56,96,.07)'};border:1px solid ${isPos?'rgba(0,201,122,.22)':'rgba(255,56,96,.2)'};border-radius:12px;padding:1rem">
 <div style="font-size:.82rem;color:var(--text2);line-height:1.75;margin-bottom:.875rem">
 If you invested <strong>$${amount.toLocaleString()}</strong> in <strong>${ticker}</strong> exactly <strong>${years} year${years!==1?'s':''} ago</strong>:
 </div>
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.875rem">
 <div style="background:var(--card);border:1px solid var(--border);border-radius:9px;padding:.75rem;text-align:center">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;margin-bottom:4px">YOU PAID (EST.)</div>
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800">$${Math.round(thenValue).toLocaleString()}</div>
 </div>
 <div style="background:var(--card);border:1px solid var(--border);border-radius:9px;padding:.75rem;text-align:center">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;margin-bottom:4px">WORTH TODAY (EST.)</div>
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800;color:${isPos?'var(--green)':'var(--red)'}">$${Math.round(amount).toLocaleString()}</div>
 </div>
 <div style="background:var(--card);border:1px solid var(--border);border-radius:9px;padding:.75rem;text-align:center">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;margin-bottom:4px">TOTAL ${isPos?'GAIN':'LOSS'}</div>
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800;color:${isPos?'var(--green)':'var(--red)'}">${isPos?'+':''}$${Math.abs(Math.round(growthAmt)).toLocaleString()}<br><span style="font-size:.7rem">(${isPos?'+':''}${growthPct}%)</span></div>
 </div>
 </div>
 <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:4px">
 <div style="font-size:.66rem;color:var(--text3)">
 ${hasReal?' <strong style="color:var(--text2)">Real historical data</strong>':' Estimated (no real data for this ticker)'} ·
 Rate: <strong style="color:${isPos?'var(--green)':'var(--red)'}">${annLabel}</strong> · ${dataLabel}
 </div>
 ${hist?.src?`<a href="https://www.tradingview.com/chart/?symbol=${hist.src}" target="_blank" rel="noopener" style="font-size:.63rem;color:var(--accent2);font-weight:600;text-decoration:none">View chart ↗</a>`:''}
 </div>
 <div style="font-size:.62rem;color:var(--text3)"> The "you paid" price is a backward projection from today's reference price — not the actual historical price. Past returns don't guarantee future results.</div>
 </div>`;
}

function startClock() {
 if (clockTick) clearInterval(clockTick);

 const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
 const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

 // US market holidays (ET date strings)
 const HOLIDAYS = new Set([
 '2025-01-01','2025-01-20','2025-02-17','2025-04-18',
 '2025-05-26','2025-06-19','2025-07-04','2025-09-01',
 '2025-11-27','2025-12-25',
 '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
 '2026-05-25','2026-06-19','2026-07-03','2026-08-31',
 '2026-11-26','2026-12-25',
 ]);

 // Get current ET offset in minutes (handles EST=-300, EDT=-240 automatically)
 function getETOffsetMs() {
 const now = new Date();
 // Parse ET time via Intl
 const parts = new Intl.DateTimeFormat('en-US', {
 timeZone: 'America/New_York',
 year:'numeric', month:'2-digit', day:'2-digit',
 hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
 }).formatToParts(now);
 const get = type => parseInt(parts.find(p=>p.type===type).value);
 const etMs = Date.UTC(get('year'), get('month')-1, get('day'), get('hour')%24, get('minute'), get('second'));
 return etMs - now.getTime(); // negative value
 }

 function getETNow() {
 const now = new Date();
 const offsetMs = getETOffsetMs();
 return new Date(now.getTime() + offsetMs);
 }

 function etDateKey(etDate) {
 const y = etDate.getUTCFullYear();
 const m = String(etDate.getUTCMonth()+1).padStart(2,'0');
 const d = String(etDate.getUTCDate()).padStart(2,'0');
 return `${y}-${m}-${d}`;
 }

 // Build a UTC timestamp for a specific ET hour:min on a given ET date (as UTC Date)
 function etTimeToUTC(etUTCDate, h, m) {
 const offsetMs = getETOffsetMs();
 // etUTCDate is already in UTC coords aligned to ET
 const base = new Date(Date.UTC(etUTCDate.getUTCFullYear(), etUTCDate.getUTCMonth(), etUTCDate.getUTCDate(), h, m, 0));
 return new Date(base.getTime() - offsetMs);
 }

 function nextTradingDayOpen(fromETDate, skipToday) {
 let d = new Date(fromETDate.getTime());
 if(skipToday) d.setUTCDate(d.getUTCDate()+1);
 for(let i=0; i<10; i++) {
 const dow = d.getUTCDay();
 const key = etDateKey(d);
 if(dow!==0 && dow!==6 && !HOLIDAYS.has(key)) break;
 d.setUTCDate(d.getUTCDate()+1);
 }
 return etTimeToUTC(d, 9, 30);
 }

 function getMarketStatus() {
 const now = new Date();
 const et = getETNow(); // ET time expressed as UTC object
 const dow = et.getUTCDay();
 const h = et.getUTCHours();
 const mi = et.getUTCMinutes();
 const mins = h * 60 + mi;
 const dateKey = etDateKey(et);
 const isHoliday = HOLIDAYS.has(dateKey);
 const isWeekend = dow===0 || dow===6;

 const PRE=4*60, OPEN=9*60+30, CLOSE=16*60, AFTER=20*60;

 if(isWeekend || isHoliday) {
 const reason = isHoliday ? ' Market holiday' : (dow===6 ? ' Weekend' : ' Weekend');
 const nextOpen = nextTradingDayOpen(et, false);
 return {status:'closed', label:'Market Closed', cls:'mkt-closed', dot:'closed', reason, nextOpen};
 }
 if(mins < PRE) {
 const nextOpen = etTimeToUTC(et, 4, 0);
 return {status:'closed', label:'Market Closed', cls:'mkt-closed', dot:'closed', reason:'Pre-market opens 4:00 AM ET', nextOpen};
 }
 if(mins < OPEN) {
 const nextOpen = etTimeToUTC(et, 9, 30);
 return {status:'pre', label:'Pre-Market', cls:'mkt-pre', dot:'pre', reason:'Regular session 9:30 AM ET', nextOpen};
 }
 if(mins < CLOSE) {
 const closesAt = etTimeToUTC(et, 16, 0);
 return {status:'open', label:'Market Open', cls:'mkt-open', dot:'open', reason:'NYSE & NASDAQ live', closesAt};
 }
 if(mins < AFTER) {
 const nextOpen = nextTradingDayOpen(et, true);
 return {status:'pre', label:'After-Hours', cls:'mkt-pre', dot:'pre', reason:'Extended session 4–8 PM ET', nextOpen};
 }
 const nextOpen = nextTradingDayOpen(et, true);
 return {status:'closed', label:'Market Closed', cls:'mkt-closed', dot:'closed', reason:'Opens pre-market 4:00 AM ET', nextOpen};
 }

 function fmtCountdown(targetUTC) {
 const diff = targetUTC.getTime() - Date.now();
 if(diff <= 0) return '';
 const totalSec = Math.floor(diff / 1000);
 const hh = Math.floor(totalSec / 3600);
 const mm = Math.floor((totalSec % 3600) / 60);
 const ss = totalSec % 60;
 if(hh > 0) return `${hh}h ${mm}m ${String(ss).padStart(2,'0')}s`;
 if(mm > 0) return `${mm}m ${String(ss).padStart(2,'0')}s`;
 return `${ss}s`;
 }

 function tick() {
 const now = new Date();

 // ── Clock ──
 const de = document.getElementById('wbDate');
 const te = document.getElementById('wbTime');
 if(de) de.textContent = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
 if(te) {
 const h = now.getHours(), m = String(now.getMinutes()).padStart(2,'0'), s = String(now.getSeconds()).padStart(2,'0');
 te.textContent = `${h%12||12}:${m}:${s} ${h>=12?'PM':'AM'}`;
 }

 // ── Market Status ──
 const bar = document.getElementById('marketStatusBar');
 if(!bar) return;

 const ms = getMarketStatus();

 const tbm = document.getElementById('tbMarket');
 if (tbm) {
  const et = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  tbm.className = 'tb-market tbm-' + ms.status;
  tbm.innerHTML = `<span class="tbm-dot"></span><span class="tbm-label">${ms.label}</span><span class="tbm-time">${et} ET</span>`;
 }

 let countdown = '';
 if(ms.status==='open' && ms.closesAt) {
 const cd = fmtCountdown(ms.closesAt);
 if(cd) countdown = `<span class="mkt-countdown">closes in ${cd}</span>`;
 } else if(ms.nextOpen) {
 const cd = fmtCountdown(ms.nextOpen);
 if(cd) countdown = `<span class="mkt-countdown">opens in ${cd}</span>`;
 }

 bar.innerHTML = `
 <div class="mkt-pill ${ms.cls}">
 <div class="${ms.dot==='open'?'mkt-dot-open':'mkt-dot '+ms.dot}"></div>
 <span> ${ms.label}</span>
 ${countdown}
 </div>
 <div class="mkt-pill mkt-open">
 <div class="mkt-dot-open"></div>
 <span>₿ Crypto</span>
 <span class="mkt-countdown">24/7</span>
 </div>
 <div style="font-size:.66rem;color:var(--text3);align-self:center">${ms.reason}</div>`;

 // Append dedicated countdown chip
 const day = now.getDay(), h2 = now.getHours(), m2 = now.getMinutes(), s2 = now.getSeconds();
 const totalSecs = h2*3600 + m2*60 + s2;
 const openSecs = 9*3600+30*60, closeSecs = 16*3600;
 const isWeekday = day >= 1 && day <= 5;
 let cdLabel, cdSecs;
 if (!isWeekday || totalSecs >= closeSecs) {
 let next = new Date(now); next.setHours(9,30,0,0);
 if (totalSecs >= closeSecs || !isWeekday) next.setDate(next.getDate() + (day===5?3:day===6?2:1));
 cdSecs = Math.floor((next - now) / 1000); cdLabel = ' Opens in';
 } else if (totalSecs < openSecs) {
 cdSecs = openSecs - totalSecs; cdLabel = ' Opens in';
 } else {
 cdSecs = closeSecs - totalSecs; cdLabel = ' Closes in';
 }
 const cdH = Math.floor(cdSecs/3600), cdM = Math.floor((cdSecs%3600)/60), cdS = cdSecs%60;
 const cdStr = cdH > 0 ? `${cdH}h ${cdM}m` : `${cdM}m ${cdS}s`;
 const chip = document.createElement('div');
 chip.id = 'mktCountdown';
 chip.style.cssText = 'font-size:.68rem;color:var(--text2);background:var(--card);border:1px solid var(--border);border-radius:20px;padding:4px 12px;display:flex;align-items:center;gap:5px;';
 chip.innerHTML = `${cdLabel} <strong style="color:var(--text)">${cdStr}</strong>`;
 bar.appendChild(chip);
 }

 tick();
 clockTick = setInterval(tick, 1000);
}

/* ════════════════════════════════
 THEME & MODE
════════════════════════════════ */
function applyTheme(save=true){
 document.documentElement.setAttribute('data-theme', theme);
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f6f9' : '#0f0f13');
 const d=document.getElementById('tD'), l=document.getElementById('tL');
 if(d){ d.className='tog'+(theme==='dark'?' on-a':''); l.className='tog'+(theme==='light'?' on-a':''); }
 updateThemeBtn();
 if(save) saveP();
}
// A choice the user made: remembered on this device (landing page, guest mode) and on their account
function setTheme(t){
 const root = document.documentElement;
 themeChoice = t;
 try { localStorage.setItem('ss_theme', t); } catch {}
 // Choosing by hand turns off the automatic evening switch so the two don't fight
 if (darkSchedule) {
  darkSchedule = false; applyDarkSchedule();
  document.getElementById('dschOn')?.classList.remove('on-a'); document.getElementById('dschOff')?.classList.add('on-a');
 }
 if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  root.classList.add('theme-anim');
  clearTimeout(window._themeAnimT);
  window._themeAnimT = setTimeout(() => root.classList.remove('theme-anim'), 520);
 }
 theme=t; applyTheme(!!user);
 // Refresh any already-loaded TradingView iframes to match new theme
 const tvTheme = t === 'light' ? 'light' : 'dark';
 document.querySelectorAll('iframe[src*="tradingview"]').forEach(f => {
 try { f.src = f.src.replace(/theme=(dark|light)/gi, 'theme=' + tvTheme); } catch(e) {}
 });
 setTimeout(reRenderCurrentView, 50);
}
function toggleTheme(){ setTheme(theme==='dark'?'light':'dark'); }

// showToast — alias so onclick="showToast(...)" calls in HTML work
function showToast(msg, type, icon) { toast((icon ? icon + ' ' : '') + msg, type || 'info'); }

// setMarketFilter — updates the active pill and re-renders home with the selected filter
function setMarketFilter(f) {
 marketFilter = f;
 ['s','i','c'].forEach(id => {
 const btn = document.getElementById('mf-' + id);
 if (btn) btn.className = 'mf-pill' + (id === f ? ' mf-on' : '');
 });
 renderHome(f);
}

/* ════════════════════════════════
 FORGOT PASSWORD
════════════════════════════════ */

function showForgotPassword() {
 const panel = document.getElementById('forgotPanel');
 if (!panel) return;
 panel.style.display = 'block';
 document.getElementById('fpStep1').style.display = 'block';
 document.getElementById('fpStep2').style.display = 'none';
 document.getElementById('fp-err1').style.display = 'none';
 const liEmail = document.getElementById('li-e')?.value?.trim();
 if (liEmail) document.getElementById('fp-email').value = liEmail;
}
function hideForgotPassword() {
 const panel = document.getElementById('forgotPanel');
 if (panel) panel.style.display = 'none';
}

let _fpEmail = '';
async function sendResetCode() {
 const emailEl = document.getElementById('fp-email');
 const email = emailEl?.value?.trim().toLowerCase();
 const btn = document.getElementById('fpSendBtn');
 const errEl = document.getElementById('fp-err1');
 if (!validEmail(email)) { errEl.textContent = 'Enter a valid email.'; errEl.style.display = 'block'; return; }

 btn.disabled = true; btn.textContent = 'Sending...';
 errEl.style.display = 'none';

 // The server creates the code, keeps only a hash of it and emails it
 const r = await authApi('reset-request', { email });
 btn.disabled = false; btn.textContent = 'Send Code';
 if (!r.ok) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }

 _fpEmail = email;
 document.getElementById('fpStep1').style.display = 'none';
 document.getElementById('fpStep2').style.display = 'block';
 const codeDisplay = document.getElementById('fpCodeDisplay');
 if (codeDisplay) codeDisplay.style.display = 'none';
 const subtitleEl = document.getElementById('fpStep2Subtitle');
 if (subtitleEl) subtitleEl.textContent = 'Check your email for the 6-digit code and enter it below.';
 showToast('Code sent! Check your email ', 'success');
}

async function verifyResetCode() {
 const code = document.getElementById('fp-code')?.value?.trim();
 const newPw = document.getElementById('fp-newpw')?.value;
 const confirmPw = document.getElementById('fp-confirmpw')?.value;
 const btn = document.getElementById('fpVerifyBtn');
 const errEl = document.getElementById('fp-err2');
 errEl.style.display = 'none';

 if (!code || !/^\d{6}$/.test(code)) { errEl.textContent = 'Enter the 6-digit code.'; errEl.style.display = 'block'; return; }
 if (!newPw || newPw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
 if (newPw !== confirmPw) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }

 const lookupEmail = _fpEmail || document.getElementById('fp-email')?.value?.trim().toLowerCase();
 if (!lookupEmail) { errEl.textContent = 'Session expired. Please start over.'; errEl.style.display = 'block'; return; }

 btn.disabled = true; btn.textContent = 'Verifying...';
 const r = await authApi('reset-confirm', { email: lookupEmail, code, password: newPw });
 if (!r.ok) {
 errEl.textContent = r.error; errEl.style.display = 'block';
 btn.disabled = false; btn.textContent = 'Reset Password';
 return;
 }
 _fpEmail = '';
 document.getElementById('fp-ok').style.display = 'block';
 btn.textContent = ' Done!';
 await startSession(r);
 setTimeout(() => { hideForgotPassword(); closeModal(); bootApp(); loadUserData(); }, 1800);
}
function updateThemeBtn(){
 const b=document.getElementById('themeBtn');
 if(b) b.innerHTML=theme==='dark'?icon('moon',15):icon('sun',15);
 const mb=document.getElementById('modeBtn');
 if(mb) mb.innerHTML=mode==='beginner'
  ?`${icon('smile',13)}<span style="margin-left:4px">Beginner</span>`
  :mode==='simple'
  ?`${icon('book-open',13)}<span style="margin-left:4px">Experienced</span>`
  :`${icon('zap',13)}<span style="margin-left:4px">Advanced</span>`;
}
function toggleMode(){
 mode = mode==='beginner'?'simple':mode==='simple'?'advanced':'beginner';
 if(user) { try{ const u=JSON.parse(localStorage.getItem('ss3_u')||'{}'); if(u[user.email]) { u[user.email].mode=mode; localStorage.setItem('ss3_u',JSON.stringify(u)); } }catch{} }
 updateThemeBtn();
 applyModeLabels();
 renderHome(tab);
 const label = mode==='beginner'?'Beginner':mode==='simple'?'Intermediate':'Advanced';
 toast(`Switched to ${label} mode`, 'info', 2500);
}
function applyMode(save=true){
 const b=document.getElementById('mB'), s=document.getElementById('mS'), a=document.getElementById('mA');
 if(b) b.className='tog'+(mode==='beginner'?' on-g':'');
 if(s) s.className='tog'+(mode==='simple'?' on-g':'');
 if(a) a.className='tog'+(mode==='advanced'?' on-gold':'');
 if(save) saveP();
}
function setMode(m){ mode=m; applyMode(); setTimeout(()=>{ applyModeLabels(); reRenderCurrentView(); }, 0); }

/* ── ACCENT COLOR ── */
const ACCENT_COLORS = ['purple','blue','green','orange','pink','gold','teal','ruby'];
function applyAccent(save=true){
 ACCENT_COLORS.forEach(c => document.body.classList.remove('accent-'+c));
 if(accentColor !== 'purple') document.body.classList.add('accent-'+accentColor);
 // Update setting toggles
 ACCENT_COLORS.forEach(c => {
 const btn = document.getElementById('ac-'+c);
 if(btn) { btn.className = 'tog' + (c===accentColor?' on-a':'') + (accentUnlocked(c) ? '' : ' locked'); if (ACCENT_LOCKS[c]) btn.title = accentUnlocked(c) ? '' : `Unlocks at Level ${ACCENT_LOCKS[c]}`; }
 });
 if(save) saveP();
}
function setAccent(c){ if (!accentUnlocked(c)) { toast(`Reach Level ${ACCENT_LOCKS[c]} to unlock this color. Earn XP in Learn.`, 'info', 3500); return; } accentColor=c; applyAccent(); setTimeout(reRenderCurrentView, 50); }

/* ── COMPACT MODE ── */
function applyCompact(save=true){
 document.body.classList.toggle('compact', compactMode);
 const on=document.getElementById('cmOn'), off=document.getElementById('cmOff');
 if(on){ on.className='tog'+(compactMode?' on-a':''); off.className='tog'+(compactMode?'':' on-a'); }
 if(save) saveP();
}
function setCompact(v){ compactMode=v; applyCompact(); setTimeout(reRenderCurrentView, 50); }

/* ── CHART STYLE ── */
function applyChartStyle(save=true){
 ['1','3','5','8'].forEach(s=>{
 const btn=document.getElementById('cs-'+s);
 if(btn) btn.className='tog'+(s===chartStyle?' on-a':'');
 });
 if(save) saveP();
}
function setChartStyle(s){ chartStyle=s; applyChartStyle(); }

/* ── CHART INTERVAL ── */
function applyInterval(save=true){
 ['D','W','M'].forEach(i=>{
 const btn=document.getElementById('ci-'+i);
 if(btn) btn.className='tog'+(i===chartInterval?' on-a':'');
 });
 if(save) saveP();
}
function setChartInterval(i){ chartInterval=i; applyInterval(); }

/* ── CURRENCY ── */
function applyCurrency(save=true){
 ['USD','EUR','GBP','JPY'].forEach(c=>{
 const btn=document.getElementById('cu-'+c);
 if(btn) btn.className='tog'+(c===currency?' on-a':'');
 });
 if(save) saveP();
}
function setCurrency(c){ currency=c; applyCurrency(); }

/* ── NAME DISPLAY ── */
function applyNameDisplay(save=true){
 const ndF=document.getElementById('nd-first'), ndFull=document.getElementById('nd-full');
 if(ndF){ ndF.className='tog'+(nameDisplay==='first'?' on-a':''); ndFull.className='tog'+(nameDisplay==='full'?' on-a':''); }
 // Update welcome bar
 const wb=document.querySelector('.wb-left');
 if(wb && user){
 const displayName = nameDisplay==='full' ? user.name : user.name.split(' ')[0];
 wb.innerHTML = `Welcome back, <strong>${displayName}</strong>`;
 }
 if(save) saveP();
}
function setNameDisplay(v){ nameDisplay=v; applyNameDisplay(); }

/* ── DASHBOARD PICK FROM SETTINGS ── */
function changeDashStockSettings(t){
 const label = {s:'Stock',i:'Index',c:'Crypto'}[t];
 const example = {s:'TSLA',i:'DJI',c:'ETH'}[t];
 const input = prompt(`Enter a ticker for the ${label} dashboard (e.g. ${example}):`);
 if(!input) return;
 const resolved = resolveQ(input.trim());
 dashPick[t] = resolved.t;
 saveP();
 // Update the display in settings
 const el = document.getElementById('dashPick'+t.toUpperCase());
 if(el) el.textContent = resolved.t;
}

/* ── APPLY ALL CUSTOM SETTINGS ── */
function applyAllSettings(save=false){
 applyTheme(save);
 applyAccent(save);
 applyCompact(save);
 applyChartStyle(save);
 applyInterval(save);
 applyCurrency(save);
 applyNameDisplay(save);
 applyMode(save);
}

/* ════════════════════════════════
 SEARCH AUTOCOMPLETE
════════════════════════════════ */
const TC = {s:'var(--accent2)', i:'var(--teal)', c:'var(--gold)'};
const TL = {s:'stock', i:'index', c:'crypto'};

function searchT(q) {
 if (!q || q.length < 1) return [];
 const lq = q.toLowerCase();
 const typeFilter = ['s','i','c'].includes(marketFilter) ? marketFilter : null;
 return TICKERS.filter(e => {
 if (typeFilter && e.k !== typeFilter) return false;
 return e.t.toLowerCase().startsWith(lq) ||
 e.n.toLowerCase().includes(lq) ||
 e.t.toLowerCase() === lq;
 }).slice(0, 10);
}

function resolveQ(raw) {
 const q = raw.trim();
 const exact = TICKERS.find(e => e.t.toLowerCase() === q.toLowerCase());
 if (exact) return exact;
 const partial = TICKERS.find(e => e.n.toLowerCase().includes(q.toLowerCase()));
 if (partial) return partial;
 return { t: q.toUpperCase(), n: q.toUpperCase(), k: tab };
}

function pickFromDrop(ticker, type) {
 const si = document.getElementById('si');
 const sdrop = document.getElementById('sdrop');
 if (type && type !== tab && ['s','i','c'].includes(type)) switchTab(type, true);
 if (si) si.value = ticker;
 if (sdrop) sdrop.style.display = 'none';
 doSearch();
}

let _searchTimer = null;
function onSearchInput(q) {
 const sdrop = document.getElementById('sdrop');
 if (!sdrop) return;
 const trimmed = q.trim();
 if (!trimmed) { sdrop.style.display = 'none'; return; }

 // Show local matches immediately while API loads
 const local = searchT(trimmed);
 let html = local.map(r => `
 <div class="sd-opt" onclick="pickFromDrop('${r.t}','${r.k}')">
 <span class="sd-tick" style="color:${TC[r.k]}">${r.t}</span>
 <span class="sd-name">${r.n}</span>
 <span class="sd-tag">${TL[r.k]}</span>
 </div>`).join('');
 html += `<div class="sd-opt" style="opacity:.45;pointer-events:none;font-size:.68rem;padding:6px 12px;gap:6px">
 <span></span><span>Searching all markets...</span></div>`;
 sdrop.innerHTML = html;
 sdrop.style.display = 'block';

 // Debounce live API search
 clearTimeout(_searchTimer);
 _searchTimer = setTimeout(async () => {
 try {
 const res = await fetch(
 `https://symbol-search.tradingview.com/symbol_search/?text=${encodeURIComponent(trimmed)}&type=&exchange=&lang=en&search_type=undefined`,
 { headers: { 'Accept': 'application/json' } }
 );
 const data = await res.json();
 if (!data || !data.symbols) return;

 // Map TV type to our k types
 const kindMap = t => {
 if (!t) return 's';
 if (t === 'crypto') return 'c';
 if (t === 'index' || t === 'economic') return 'i';
 return 's';
 };

 const results = data.symbols.slice(0, 12).map(s => ({
 t: s.symbol,
 n: s.description || s.symbol,
 k: kindMap(s.type),
 exchange: s.exchange,
 fullSym: s.exchange ? `${s.exchange}:${s.symbol}` : s.symbol,
 }));

 if (!results.length) {
 // No results — still show fallback
 sdrop.innerHTML = `<div class="sd-opt" onclick="pickFromDrop('${trimmed.toUpperCase()}','${tab}')" style="opacity:.8">
 <span class="sd-tick" style="color:var(--text3)"></span>
 <span class="sd-name">Search "<strong style="color:var(--accent2)">${trimmed.toUpperCase()}</strong>" anyway</span>
 <span class="sd-tag">any</span>
 </div>`;
 sdrop.style.display = 'block';
 return;
 }

 sdrop.innerHTML = results.map(r => `
 <div class="sd-opt" onclick="pickFromDropFull('${r.fullSym}','${r.t}','${r.k}','${r.n.replace(/'/g,'&#39;')}')">
 <span class="sd-tick" style="color:${TC[r.k]||'var(--accent2)'}">${r.t}</span>
 <span class="sd-name">${r.n}</span>
 <span class="sd-tag" style="font-size:.58rem">${r.exchange||''}</span>
 </div>`).join('') +
 `<div class="sd-opt" onclick="pickFromDrop('${trimmed.toUpperCase()}','${tab}')" style="border-top:1px solid var(--border);opacity:.75">
 <span class="sd-tick" style="color:var(--text3)"></span>
 <span class="sd-name">Search "<strong style="color:var(--accent2)">${trimmed.toUpperCase()}</strong>" directly</span>
 <span class="sd-tag">any</span>
 </div>`;
 sdrop.style.display = 'block';
 } catch(e) {
 // API failed — keep local results, add manual fallback
 const upper = trimmed.toUpperCase();
 const cur = sdrop.innerHTML.replace(/<div[^>]*>.*?<\/div>/, '');
 sdrop.innerHTML = cur + `<div class="sd-opt" onclick="pickFromDrop('${upper}','${tab}')" style="border-top:1px solid var(--border);opacity:.8">
 <span class="sd-tick" style="color:var(--text3)"></span>
 <span class="sd-name">Search "<strong style="color:var(--accent2)">${upper}</strong>" anyway</span>
 <span class="sd-tag">any</span>
 </div>`;
 }
 }, 280);
}

function pickFromDropFull(fullSym, ticker, k, name) {
 const si = document.getElementById('si');
 const sdrop = document.getElementById('sdrop');
 if (si) si.value = ticker;
 if (sdrop) sdrop.style.display = 'none';
 if (k && k !== tab && ['s','i','c'].includes(k)) switchTab(k, true);
 addToSearchHistory(ticker, name, k || tab);
 // Symbol came directly from TradingView's API — skip verification, render directly
 renderAsset(ticker, name, k || tab, fullSym);
}

function initSearch() {
 // Close dropdown when clicking outside — only listener we still need
 document.addEventListener('click', e => {
 if (!e.target.closest('.search-wrap')) {
 const sdrop = document.getElementById('sdrop');
 if (sdrop) sdrop.style.display = 'none';
 }
 });
}

/* ════════════════════════════════
 TABS
════════════════════════════════ */
// Tabs that need an account
const SIGNED_IN_TABS = { w: 'Watchlist', port: 'Portfolio', pt: 'Paper Trading', day: 'Day Trading', learn: 'Learn', leagues: 'Leagues' };
function switchTab(t, skipRender=false) {
 if (!user && SIGNED_IN_TABS[t]) { requireAuth(SIGNED_IN_TABS[t]); return; }
 _viewSeq++;
 tutOnTab(t);
 const mc = document.getElementById('mainContent');
 if (mc) {
 mc.style.transition = 'opacity .15s, transform .15s';
 mc.style.opacity = '0';
 mc.style.transform = 'translateY(5px)';
 }
 setTimeout(() => {
 tab = t;
 setPhoneTitle(t);
 currentAsset = null;
 syncStockUrl(null);
 setViewHead(user || !['w','port','pt','day','leagues'].includes(t) ? t : null);
 if (mc && (user || !['w','port','pt','day','leagues'].includes(t))) mc.dataset.view = ['s','i','c'].includes(t) ? 'home' : t;
 renderRail();
 ['s','w','cmp','port','screen','pt','day','learn','leagues','more'].forEach(id => {
 const b = document.getElementById('tab-'+id);
 if (b) b.className = 'tab' + (id===t ? ' on-'+id : '');
 const mb = document.getElementById('mbn-'+id);
 const mOn = id === t || (id === 'more' && MORE_ITEMS.some(m => m[0] === t)) || (id === 's' && ['i','c'].includes(t));
 if (mb) mb.className = 'mbn-tab' + (mOn ? ' mbn-on-'+id : '');
 });
 moveNavPill();

 // Show market filter pills only on Markets tab
 const mf = document.getElementById('marketFilter');
 if (mf) mf.style.display = (t === 's') ? 'flex' : 'none';

 const ss2 = document.getElementById('searchSection');
 const mcRestore = () => { if (mc) { mc.style.transition='opacity .2s, transform .2s'; mc.style.opacity='1'; mc.style.transform=''; } };
 if (t==='w') { if(!requireAuth('Watchlist')) return; ss2.style.display='none'; document.title='Watchlist — StockSight'; showWatchlistSkeleton(); setTimeout(()=>{renderWatchlist();mcRestore();},60); return; }
 if (t==='cmp') { ss2.style.display='none'; document.title='Compare — StockSight'; renderCompare(); mcRestore(); return; }
 if (t==='port') { if(!requireAuth('Portfolio')) return; ss2.style.display='none'; document.title='Portfolio — StockSight'; showPortfolioSkeleton(); setTimeout(()=>{renderPortfolio();mcRestore();},60); return; }
 if (t==='screen') { ss2.style.display='none'; document.title='Screener — StockSight'; renderScreener(); mcRestore(); return; }
 if (t==='pt') { if(!requireAuth('Paper Trading')) return; ss2.style.display='none'; document.title='Paper Trading — StockSight'; renderPaperTradeTab(); mcRestore(); return; }
 if (t==='learn') { if(!requireAuth('Learn')) return; ss2.style.display='none'; document.title='Learn — StockSight'; renderLearnView(); mcRestore(); return; }
 if (t==='leagues') { if(!requireAuth('Leagues')) return; ss2.style.display='none'; document.title='Leagues — StockSight'; if (!skipRender) renderLeaguesView(); mcRestore(); return; }
 if (t==='day') { if(!requireAuth('Day Trading')) return; ss2.style.display='none'; document.title='Day Trade — StockSight'; renderDayTradeTab(); mcRestore(); return; }

 ss2.style.display = 'block';

 // Update go button color and label
 const gb = document.getElementById('goBtn');
 if (gb) {
 gb.className = `btn-go bg-${t==='i'?'i':t==='c'?'c':'s'}`;
 gb.textContent = t==='i' ? 'Research →' : 'Analyze →';
 }

 // Quick picks
 const pks = PICKS[t] || [];
 document.getElementById('picks').innerHTML = pks.map(p =>
 `<button class="pick" onclick="quickPick('${p}')">${p}</button>`
 ).join('');

 const tabTitles = {s:'Markets',i:'Indexes',c:'Crypto'};
 document.title = (tabTitles[t]||'Markets') + ' — StockSight';
 if (!skipRender) {
 const siEl = document.getElementById('si');
 if (siEl) siEl.value = '';
 renderHome(t);
 }
 if (mc) {
 mc.style.transition = 'opacity .2s, transform .2s';
 mc.style.opacity = '1';
 mc.style.transform = '';
 }
 }, 120); // end switchTab setTimeout
}

function quickPick(ticker) {
 if (tutorialActive() && TUTORIAL_STEPS[tutStep]?.action?.detect === 'search-input') return;
 const siEl = document.getElementById('si');
 if (siEl) siEl.value = ticker;
 document.querySelectorAll('.pick').forEach(el => el.classList.remove('ps','pi','pc'));
 const cls = {s:'ps',i:'pi',c:'pc'}[tab];
 if (event && event.target && cls) event.target.classList.add(cls);
 doSearch();
}

/* ════════════════════════════════
 SEARCH / VIEW CHART
════════════════════════════════ */
function doSearch() {
 const si = document.getElementById('si');
 const raw = si ? si.value.trim() : '';
 if (!raw) return;
 trackGuestSearch();
 clMark('cl_search');
 refreshChecklist();
 _lastSearchQuery = raw; // save for "back to results" button
 if (tutorialActive() && TUTORIAL_STEPS[tutStep]?.action?.detect === 'search-input') {
 const btn = document.getElementById('tutNextBtn');
 if (btn && btn.disabled) {
 // trigger the markDone manually
 document.getElementById('tutActionPrompt')?.classList.remove('show');
 const doneTxt = document.getElementById('tutDoneText');
 if (doneTxt) doneTxt.textContent = 'Great — search works! Click Next to continue.';
 document.getElementById('tutDoneBadge')?.classList.add('show');
 document.getElementById('tutSpotlight')?.classList.remove('pulse');
 if (btn) btn.disabled = false;
 cleanTutListeners();
 }
 return; // don't navigate during tutorial
 }
 const resolved = resolveQ(raw);
 if (resolved.k && resolved.k !== tab && ['s','i','c'].includes(resolved.k)) {
 switchTab(resolved.k, true);
 if (si) si.value = raw;
 }
 addToSearchHistory(resolved.t, resolved.n, resolved.k || tab);
 verifyTicker(resolved.t, resolved.n, resolved.k || tab);
}

/* ════════════════════════════════
 SIMPLE / ADVANCED MODE LABELS
 Call applyModeLabels() after any mode change
════════════════════════════════ */
const BEGINNER_LABELS = {
 's': '📈 Markets', 'i': '🌍 Indexes', 'c': '₿ Crypto',
 'w': '⭐ My List', 'cmp': '⚖️ Compare', 'port': '💼 My Money', 'screen': '🔍 Find Stocks', 'pt': '🎮 Practice',
 'search_ph_s': 'Search for a company, like Apple or Tesla',
 'search_ph_i': 'Search for a market, like the S&P 500',
 'search_ph_c': 'Search for a coin, like Bitcoin or Ethereum',
 'go_btn_s': 'Look it up →',
 'go_btn_i': 'Look it up →',
 'go_btn_c': 'Look it up →',
 'go_btn': 'Look it up →',
};
const SIMPLE_LABELS = {
 's': 'Markets', 'i': 'Indexes', 'c': 'Crypto',
 'w': 'Watchlist', 'cmp': 'Compare', 'port': 'Portfolio', 'screen': 'Screener', 'pt': 'Paper Trade',
 'search_ph_s': 'Search a company: Apple, Tesla, Google',
 'search_ph_i': 'Search an index: S&P 500, Dow Jones',
 'search_ph_c': 'Search a coin: Bitcoin, Ethereum',
 'go_btn_s': 'Analyze →',
 'go_btn_i': 'Research →',
 'go_btn_c': 'Analyze →',
 'go_btn': 'Analyze →',
};
const ADV_LABELS = {
 's': 'Markets', 'i': 'Indexes', 'c': 'Crypto',
 'w': 'Watchlist', 'cmp': 'Compare', 'port': 'Portfolio', 'screen': 'Screener', 'pt': 'Paper Trade',
 'search_ph_s': 'Ticker or name: AAPL, MSFT, SPX, BTC',
 'search_ph_i': 'Index symbol: SPX, IXIC, DJI, VIX',
 'search_ph_c': 'Crypto: BTC, ETH, SOL, DOGE',
 'go_btn_s': 'Analyze →',
 'go_btn_i': 'Research →',
 'go_btn_c': 'Analyze →',
 'go_btn': 'Analyze →',
};

function applyModeLabels() {
 // Reading levels only change stock pages, so the rest of the site uses one set of labels
 const L = SIMPLE_LABELS;
 const isSimple = false;
 document.body.classList.remove('mode-beginner', 'mode-simple', 'mode-advanced');

 // Tab text — update all tabs
 const tabMap = {s:'tab-s',i:'tab-s',c:'tab-s',w:'tab-w',cmp:'tab-cmp',port:'tab-port',screen:'tab-screen',pt:'tab-pt'};
 const tabEl = {
 's': document.getElementById('tab-s'),
 'w': document.getElementById('tab-w'),
 'cmp': document.getElementById('tab-cmp'),
 'port': document.getElementById('tab-port'),
 'screen': document.getElementById('tab-screen'),
 'pt': document.getElementById('tab-pt'),
 };
 Object.entries(tabEl).forEach(([key, el]) => {
 if (el && L[key]) {
 // Preserve the icon span if present
 const icon = el.querySelector('.tab-icon');
 const iconHtml = icon ? icon.outerHTML + ' ' : '';
 const labelText = L[key].replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]+\s/u, ''); // strip emoji prefix only
 el.innerHTML = iconHtml + labelText;
 }
 });

 // Search placeholder + go button
 const si_el = document.getElementById('si');
 const gb = document.getElementById('goBtn');
 if (si_el) {
 const ph = {s:'search_ph_s',i:'search_ph_i',c:'search_ph_c'}[tab] || 'search_ph_s';
 si_el.placeholder = L[ph];
 }
 if (gb) gb.textContent = L['go_btn_'+tab] || L['go_btn'];

 // Welcome bar
 const wb = document.getElementById('wbGreeting');
 if (wb && user) {
 wb.innerHTML = isSimple
 ? `Hey, <strong>${user.name.split(' ')[0]}</strong> What do you want to look up today?`
 : `Welcome back, <strong>${escapeHTML(user.name)}</strong>`;
 }

 // Simple mode: show helpful tip bar, hide advanced market filter labels
 const mfS = document.getElementById('mf-s');
 const mfI = document.getElementById('mf-i');
 const mfC = document.getElementById('mf-c');
 if (mfS) mfS.textContent = isSimple ? ' Stocks' : ' Stocks';
 if (mfI) mfI.textContent = isSimple ? ' Indexes' : ' Indexes';
 if (mfC) mfC.textContent = isSimple ? '₿ Crypto' : '₿ Crypto';
}

/* ════════════════════════════════
 HOMEPAGE (with dashboard stock picker)
════════════════════════════════ */
/* ════════════════════════════════
 MARKETS DASHBOARD: index tiles, main chart, popular cards, lessons
════════════════════════════════ */
const DASH_DEFAULT_PICK = { s:'AAPL', i:'SPX', c:'BTC' };
const DASH_TILES = {
 s: [['FOREXCOM:SPXUSD','S&P 500','SPX','i'], ['FOREXCOM:NSXUSD','Nasdaq 100','NDX','i'], ['FOREXCOM:DJI','Dow Jones','DJI','i'], ['CAPITALCOM:VIX','VIX','VIX','i']],
 i: [['FOREXCOM:SPXUSD','S&P 500','SPX','i'], ['FOREXCOM:NSXUSD','Nasdaq 100','NDX','i'], ['FOREXCOM:DJI','Dow Jones','DJI','i'], ['CAPITALCOM:RTY','Russell 2000','RUT','i']],
 c: [['BITSTAMP:BTCUSD','Bitcoin','BTC','c'], ['BITSTAMP:ETHUSD','Ethereum','ETH','c'], ['COINBASE:SOLUSD','Solana','SOL','c'], ['BITSTAMP:XRPUSD','XRP','XRP','c']],
};
const DASH_POPULAR = {
 s: [['NASDAQ:AAPL','Apple','AAPL','s'], ['NASDAQ:NVDA','NVIDIA','NVDA','s'], ['NASDAQ:TSLA','Tesla','TSLA','s'], ['NASDAQ:MSFT','Microsoft','MSFT','s']],
 i: [['FOREXCOM:UKXGBP','FTSE 100','FTSE','i'], ['CAPITALCOM:J225','Nikkei 225','NI225','i'], ['CAPITALCOM:DE40','DAX','DAX','i'], ['CAPITALCOM:HK50','Hang Seng','HSI','i']],
 c: [['BINANCE:BNBUSDT','BNB','BNB','c'], ['BINANCE:DOGEUSDT','Dogecoin','DOGE','c'], ['BINANCE:ADAUSDT','Cardano','ADA','c'], ['BINANCE:AVAXUSDT','Avalanche','AVAX','c']],
};
const DASH_ICON = d => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/* ════════════════════════════════
 LEARNING: lesson tracks with hands-on cards, a daily challenge, endless practice and real-stock lessons
 "Start here" lives in this file so the home row works instantly; the other tracks load from /lessons.json.
 A card is plain text, or interactive: predict (guess first, then see why), calc (sliders), live (real
 market numbers), sort (tap in order) or match (pair them up). In every question the right answer is listed
 first and shuffled on screen. Progress is kept in the browser and on the account (users.learn).
════════════════════════════════ */
const LEARN_ICONS = {
 book: '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
 trend: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
 down: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
 chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
 shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
 layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
 doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
 growth: '<path d="M3 20h18"/><rect x="5" y="12" width="3" height="6"/><rect x="10.5" y="8" width="3" height="10"/><rect x="16" y="4" width="3" height="14"/>',
 calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
 percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
 fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
 checklist: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
 piggy: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5"/><line x1="12" y1="6.5" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="17.5"/>',
 scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a4 4 0 0 0 6 0z"/><path d="M19 7l-3 7a4 4 0 0 0 6 0z"/>',
 building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 6h.01M15 6h.01M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/><path d="M10 22v-4h4v4"/>',
 pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
 coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/>',
 target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
 bank: '<path d="M3 21h18"/><path d="M5 21V10M9 21V10M15 21V10M19 21V10"/><path d="M2 10l10-7 10 7z"/>',
 globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
 pulse: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
 bulb: '<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
 clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
 split: '<path d="M16 3h5v5M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
 brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>',
 refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
 alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
 bitcoin: '<path d="M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727"/>',
 ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
 rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
 bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
 loop: '<path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/>',
 search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
 check: '<polyline points="20 6 9 17 4 12"/>',
};
const learnIcon = n => DASH_ICON(LEARN_ICONS[n] || LEARN_ICONS.book);

const CORE_TRACK = { id: 'start', title: 'Start here', desc: 'The basics, in about 15 minutes', icon: 'book', lessons: ['stock-market', 'first-trade', 'read-chart', 'risk', 'etfs', 'earnings'] };
const CORE_LESSONS = [
 {
  id: 'stock-market', title: 'What is the stock market?', mins: 2, icon: 'book',
  cards: [
   'A stock is a small piece of ownership in a company. Buy one share of Apple and you own a tiny slice of Apple, including a claim on its future profits.',
   'The stock market is where those shares change hands, mostly on exchanges like the New York Stock Exchange and the Nasdaq. Prices move all day because buyers and sellers keep agreeing on new prices.',
   { t: 'predict', q: 'A company reports much bigger profits than expected. What usually happens to its stock price?', a: ['It tends to rise', 'It tends to fall', 'Nothing, profits don\'t matter'], why: 'More profit makes each share more valuable, so more people want to own it and the price tends to rise.' },
   'Indexes such as the S&P 500 group hundreds of stocks together so you can see how the whole market is doing at a glance. When someone says "the market is up today", they usually mean the S&P 500.',
   { t: 'live', live: 'zoom', ticker: 'SPY', text: 'Real data: the S&P 500 (through SPY, a fund that tracks it). Tap the ranges to see how it has moved.' },
  ],
  quiz: [
   { q: 'What do you own when you buy one share of a company?', a: ['A small piece of the company', 'A loan you gave the company', 'A coupon for its products'], why: 'A share is a slice of ownership, including a claim on future profits.' },
   { q: 'What does the S&P 500 track?', a: ['About 500 large US companies', 'The 500 most traded cryptocurrencies', 'Interest rates set by the Fed'], why: 'It bundles roughly 500 big US companies to show how the market is doing.' },
   { q: 'Why do stock prices change during the day?', a: ['Buyers and sellers keep agreeing on new prices', 'The government sets them every hour', 'Companies update them on their websites'], why: 'Every trade is a new agreement between a buyer and a seller.' },
  ],
  cta: { label: 'See the S&P 500', go: 'SPX' },
 },
 {
  id: 'first-trade', title: 'How to place your first trade', mins: 3, icon: 'trend',
  cards: [
   'Start with a company you understand. Search for it in StockSight and read the plain-English verdict and the chart before you decide anything.',
   'Decide how much to put in. A common rule for beginners is to only invest money you won\'t need for the next few years, because prices can drop for a while before they recover.',
   { t: 'match', text: 'Match each order type to what it does:', pairs: [['Market order', 'Buys right away at the current price'], ['Limit order', 'Only buys at your price or better'], ['Stop-loss order', 'Sells if the price falls to a level you set']] },
   { t: 'predict', q: 'A stock trades at $152 and you never want to pay more than $150. What should you use?', a: ['A limit order at $150', 'A market order', 'Buy now and hope'], why: 'A limit order only fills at $150 or less. A market order would buy right away at about $152.' },
   'Practice before you use real money. The Paper Trade tab gives you $10,000 of pretend cash and the same steps as a real broker, so mistakes cost nothing. StockSight never places real orders.',
  ],
  quiz: [
   { q: 'Which order buys right away at the current price?', a: ['A market order', 'A limit order', 'A stop order'], why: 'Market orders fill immediately at whatever the price is right now.' },
   { q: 'You never want to pay more than $150 a share. What should you use?', a: ['A limit order at $150', 'A market order', 'Buy as many shares as you can'], why: 'A limit order only fills at your price or better.' },
   { q: 'Which money is best to invest?', a: ['Money you won\'t need for a few years', 'Next month\'s rent', 'Money borrowed on a credit card'], why: 'Prices can drop for a while, so give your money time to recover.' },
  ],
  cta: { label: 'Open Paper Trade', tab: 'pt' },
 },
 {
  id: 'read-chart', title: 'How to read a stock chart', mins: 3, icon: 'chart',
  cards: [
   'The line shows the price over time. The left side is older and the right side is now, so a line that climbs from left to right means the price went up over that period.',
   { t: 'live', live: 'zoom', ticker: 'AAPL', text: 'Try it with Apple\'s real price. Switch between ranges and notice how the same stock can look scary over a month and fine over five years, or the other way around.' },
   'Many charts color a period green when the price ended higher than it started and red when it ended lower.',
   { t: 'predict', q: 'A stock fell 4% today but is up 30% this year. What\'s the better way to see the bigger picture?', a: ['Switch the chart to 1Y', 'Only look at today', 'Ignore the chart completely'], why: 'Zooming out shows the trend behind a single bad day.' },
   'Candlestick charts pack more detail into each bar: where the price opened, the highest and lowest it reached, and where it closed. Big moves on heavy trading volume usually matter more.',
  ],
  quiz: [
   { q: 'Where is the most recent price on a chart?', a: ['On the right side', 'On the left side', 'In the middle'], why: 'Time runs left to right, so the newest price is on the right.' },
   { q: 'A stock fell today but is up 30% this year. How would you see that?', a: ['Switch the range to 1Y', 'Only look at the 1D view', 'Ignore the chart'], why: 'Zooming out shows the bigger trend behind a single bad day.' },
   { q: 'What does one candlestick show?', a: ['The open, high, low and close', 'Only the closing price', 'How many people own the stock'], why: 'Each candle packs four prices for its time period.' },
  ],
  cta: { label: 'Try the chart', tab: 's' },
 },
 {
  id: 'risk', title: 'Risk and diversification', mins: 3, icon: 'shield',
  cards: [
   'Every investment carries risk: the chance it is worth less when you need the money. Even great companies can drop 20% or more in a bad year.',
   'Volatility measures how much a price swings. A stock with 60% yearly volatility can move much further, up and down, than one with 15%.',
   { t: 'calc', calc: 'diversify', text: 'Diversification means spreading your money across many companies. Slide from 1 stock to 50 and watch the range of yearly results narrow. It never shrinks to zero, because the whole market still moves.' },
   'Index funds diversify for you by holding hundreds of stocks at once, so one bad pick can\'t sink everything.',
   'Time helps too. Broad stock markets have historically trended up over long periods, but short-term drops are normal. Money you won\'t need for years can ride them out.',
  ],
  quiz: [
   { q: 'What does diversification mean?', a: ['Spreading money across many investments', 'Buying more of your best stock', 'Selling whenever the price drops'], why: 'Spreading out means one bad pick hurts less.' },
   { q: 'Stock A swings about 15% a year and stock B about 60%. Which is more volatile?', a: ['Stock B', 'Stock A', 'They are the same'], why: 'Bigger swings mean higher volatility.' },
   { q: 'Why do many beginners like index funds?', a: ['They hold many stocks at once', 'They can never lose money', 'They pay a fixed interest rate'], why: 'One purchase gives you a slice of hundreds of companies.' },
  ],
  cta: { label: 'Open the screener', tab: 'screen' },
 },
 {
  id: 'etfs', title: 'ETFs and index funds', mins: 2, icon: 'layers',
  cards: [
   'An ETF (exchange-traded fund) is a basket of investments you can buy in one go, just like a single stock. One share of an S&P 500 ETF gives you a small piece of all 500 companies.',
   'Index funds follow a market index instead of trying to pick winners. Because nobody is paid to choose stocks, their fees are usually very low.',
   { t: 'live', live: 'compare', metric: 'vol', tickers: ['SPY', 'AAPL', 'TSLA'], text: 'One fund holding 500 companies versus two single stocks, in real numbers. Guess which one swings the least.' },
   'Fees matter more than they look. A fund charging 1% a year takes far more of your money over decades than one charging 0.05%. You\'ll find the fee listed as the expense ratio.',
   'Popular funds track the S&P 500 (like SPY or VOO) or the Nasdaq 100 (like QQQ). Search any of them on StockSight to see how the whole basket is doing.',
  ],
  quiz: [
   { q: 'What is an ETF?', a: ['A basket of investments that trades like one stock', 'A savings account at a bank', 'A type of cryptocurrency'], why: 'You buy and sell it like a stock, but it holds many investments.' },
   { q: 'Why are index funds usually cheap?', a: ['They follow an index instead of paying stock pickers', 'The government pays their fees', 'They only hold one company'], why: 'Tracking an index needs far less work than picking stocks.' },
   { q: 'Where do you find a fund\'s yearly fee?', a: ['Its expense ratio', 'Its ticker symbol', 'Its share price'], why: 'The expense ratio is the percentage charged each year.' },
  ],
  cta: { label: 'Look up SPY', go: 'SPY' },
 },
 {
  id: 'earnings', title: 'Reading a company\'s earnings', mins: 3, icon: 'doc',
  cards: [
   'Public companies report their results every three months. This is called earnings season, and prices often jump or drop on the news.',
   'Revenue is all the money a company brings in from sales. Profit, also called net income, is what\'s left after paying every cost.',
   { t: 'predict', q: 'A company\'s revenue rose 20%, but its profit fell. How is that possible?', a: ['Its costs rose faster than its sales', 'Revenue and profit are the same thing', 'It isn\'t possible'], why: 'Profit is what\'s left after costs. If costs grow faster than sales, profit can shrink even while revenue grows.' },
   'Earnings per share (EPS) splits that profit across each share. Analysts publish estimates beforehand, and beating or missing them can move the stock a lot.',
   'Look at the trend, not one report. Revenue and profit growing over several years usually tells you more than a single good or bad quarter.',
  ],
  quiz: [
   { q: 'How often do US public companies report earnings?', a: ['Every three months', 'Once every five years', 'Every day'], why: 'Results come out quarterly, four times a year.' },
   { q: 'What is revenue?', a: ['All the money brought in from sales', 'Profit after every cost', 'The stock\'s price'], why: 'Revenue is the top line, before any costs.' },
   { q: 'What does EPS stand for?', a: ['Earnings per share', 'Equity price spread', 'Estimated profit score'], why: 'It is profit divided across every share.' },
  ],
  cta: { label: 'Check Apple\'s earnings', go: 'AAPL' },
 },
];

// The library: "Start here" now, every track once /lessons.json arrives
const LEARN_LIB = { tracks: [CORE_TRACK], byId: Object.fromEntries(CORE_LESSONS.map(l => [l.id, l])), full: false };
let _libReq = null;
function loadLessonLibrary() {
 if (LEARN_LIB.full) return Promise.resolve(LEARN_LIB);
 if (!_libReq) {
  _libReq = fetch('/lessons.json').then(r => { if (!r.ok) throw new Error('lessons'); return r.json(); }).then(j => {
   (j.lessons || []).forEach(l => { if (l?.id && !LEARN_LIB.byId[l.id]) LEARN_LIB.byId[l.id] = l; });
   LEARN_LIB.tracks = [CORE_TRACK, ...(j.tracks || []).map(t => ({ ...t, lessons: (t.lessons || []).filter(id => LEARN_LIB.byId[id]) })).filter(t => t.lessons.length)];
   LEARN_LIB.full = true;
   refreshLearnRow();
   return LEARN_LIB;
  }).catch(() => { _libReq = null; return LEARN_LIB; });
 }
 return _libReq;
}
const allLessonIds = () => LEARN_LIB.tracks.flatMap(t => t.lessons);
const lessonById = id => LEARN_LIB.byId[id] || null;
const trackOf = id => LEARN_LIB.tracks.find(t => t.lessons.includes(id)) || null;

/* ── Progress, XP and levels ── */
const LEARN_LEVELS = [
 { min: 0, name: 'Rookie' }, { min: 100, name: 'Learner' }, { min: 220, name: 'Analyst' },
 { min: 360, name: 'Strategist' }, { min: 520, name: 'Market Pro' }, { min: 750, name: 'Expert' },
 { min: 1050, name: 'Master' }, { min: 1400, name: 'Legend' },
];
const learnKey = () => 'ss_learn_' + (user?.email || 'guest');
// Older saves keyed the six starter lessons by position (0 to 5)
function learnShape(s) {
 s = s && typeof s === 'object' ? s : {};
 const lessons = { ...(s.lessons || {}) };
 Object.keys(lessons).forEach(k => {
  const id = /^\d+$/.test(k) ? CORE_TRACK.lessons[+k] : null;
  if (id) { const a = lessons[id] || {}, b = lessons[k] || {}; lessons[id] = { read: !!(a.read || b.read), best: Math.max(a.best ?? -1, b.best ?? -1) < 0 ? undefined : Math.max(a.best ?? -1, b.best ?? -1) }; delete lessons[k]; }
 });
 return {
  xp: s.xp || 0, lessons, tour: Array.isArray(s.tour) ? s.tour : [], tourDone: !!s.tourDone, guides: s.guides || {},
  review: s.review || {}, daily: s.daily || null, dstreak: s.dstreak || 0, dlast: s.dlast || null,
  stocks: s.stocks || {}, practice: s.practice || { n: 0, right: 0 }, at: s.at || 0,
  freezes: s.freezes || 0, freezeLevel: s.freezeLevel ?? null,
 };
}
function getLearn() { return learnShape(safeParse(learnKey(), {})); }
let _learnSyncT = null;
function saveLearn(s) {
 s.at = Date.now();
 try { localStorage.setItem(learnKey(), JSON.stringify(s)); } catch {}
 if (user?.email) {
  clearTimeout(_learnSyncT);
  _learnSyncT = setTimeout(() => {
   if (!user?.email) return;
   usersTable().update({ learn: getLearn() }).eq('email', user.email).then(({ error }) => { if (error) console.warn('learn sync failed'); });
  }, 2500);
 }
}
// Two copies of progress (this browser and the account) combined, keeping the best of each
function mergeLearn(a, b) {
 a = learnShape(a); b = learnShape(b);
 const newer = a.at >= b.at ? a : b;
 const lessons = { ...a.lessons };
 Object.entries(b.lessons).forEach(([id, l]) => {
  const x = lessons[id] || {};
  const best = Math.max(x.best ?? -1, l.best ?? -1);
  lessons[id] = { read: !!(x.read || l.read), ...(best >= 0 ? { best } : {}) };
 });
 const stocks = { ...a.stocks };
 Object.entries(b.stocks).forEach(([t, v]) => { const x = stocks[t] || {}; stocks[t] = { read: !!(x.read || v.read), best: Math.max(x.best ?? 0, v.best ?? 0), at: Math.max(x.at || 0, v.at || 0) }; });
 const streakFrom = (a.dlast || '') > (b.dlast || '') ? a : (b.dlast || '') > (a.dlast || '') ? b : (a.dstreak >= b.dstreak ? a : b);
 return {
  xp: Math.max(a.xp, b.xp), lessons, tour: [...new Set([...a.tour, ...b.tour])], tourDone: a.tourDone || b.tourDone,
  guides: { ...a.guides, ...b.guides }, review: newer.review, stocks, practice: newer.practice,
  daily: (a.daily?.date || '') >= (b.daily?.date || '') ? a.daily : b.daily,
  dstreak: streakFrom.dstreak, dlast: streakFrom.dlast, at: Math.max(a.at, b.at),
  freezes: newer.freezes, freezeLevel: newer.freezeLevel ?? a.freezeLevel ?? b.freezeLevel,
 };
}
function learnLevel(xp) {
 let i = 0;
 LEARN_LEVELS.forEach((l, j) => { if (xp >= l.min) i = j; });
 const cur = LEARN_LEVELS[i], next = LEARN_LEVELS[i + 1];
 if (!next) {
  // Past the named levels there's a new one every 400 XP, forever
  const extra = Math.floor((xp - cur.min) / 400), min = cur.min + extra * 400;
  return { n: i + 1 + extra, name: extra ? `${cur.name} ${extra + 1}` : cur.name, min, next: min + 400, pct: (xp - min) / 4 };
 }
 return { n: i + 1, name: cur.name, min: cur.min, next: next.min, pct: (xp - cur.min) / (next.min - cur.min) * 100 };
}
function lessonDone(id) { const l = getLearn().lessons[id]; return !!(l && l.read && l.best != null); }

function showXpPop(n) {
 const el = document.createElement('div');
 el.className = 'xp-pop';
 el.textContent = `+${n} XP`;
 document.body.appendChild(el);
 setTimeout(() => el.remove(), 1300);
}

function learnAddXP(n) {
 if (n <= 0) return;
 const s = getLearn();
 const before = learnLevel(s.xp).n;
 s.xp += n;
 grantFreezes(s);
 saveLearn(s);
 showXpPop(n);
 const after = learnLevel(s.xp);
 if (after.n > before) {
  const got = [];
  for (let k = before + 1; k <= after.n; k++) got.push(...rewardsAt(k));
  setTimeout(() => {
   toast(`Level up! Level ${after.n}: ${after.name}.${got.length ? ` Unlocked: ${got.map(r => r.title).join(', ')}.` : ''}`, 'success', 5500);
   try { launchConfetti(); } catch {}
   refreshMyAvatar();
   applyAccent(false);
  }, 500);
 }
 refreshLearnRow();
 if (user) checkAndAwardBadges();
}

/* ── Days, shuffles and the question bank ── */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const learnToday = () => ymd(new Date());
const dayShift = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
function seededRand(seed) {
 let h = 1779033703 ^ seed.length;
 for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
 let a = h >>> 0;
 return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffled(arr, rnd = Math.random) {
 const a = arr.slice();
 for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
 return a;
}
const shuffleIdx = n => shuffled([...Array(n).keys()]);
function bankQ(qid) {
 const [id, k] = String(qid).split('#');
 const l = lessonById(id), q = l?.quiz?.[+k];
 return q ? { ...q, qid, lesson: id } : null;
}
const bankQuestions = () => allLessonIds().flatMap(id => (lessonById(id)?.quiz || []).map((_, k) => bankQ(`${id}#${k}`)));
const reviewDue = (s, today) => Object.entries(s.review).filter(([, r]) => r.due <= today).map(([qid]) => bankQ(qid)).filter(Boolean);
// Missed questions come back tomorrow; get one right and it waits 3 days, then 7, then it's learned
function applyReview(s, results) {
 const today = learnToday();
 results.forEach(({ qid, right }) => {
  if (!qid) return;
  const r = s.review[qid];
  if (!right) s.review[qid] = { due: dayShift(today, 1), n: 0 };
  else if (r) { const n = (r.n || 0) + 1; if (n >= 3) delete s.review[qid]; else s.review[qid] = { due: dayShift(today, n === 1 ? 3 : 7), n }; }
 });
}

/* ── Questions written from today's real market data ── */
const QUIZ_POOL = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'NFLX', 'JPM', 'V', 'MA', 'WMT', 'KO', 'PEP', 'MCD', 'DIS', 'NKE', 'COST', 'JNJ', 'PFE', 'XOM', 'CVX', 'BAC', 'INTC', 'AMD', 'ORCL', 'CRM', 'ADBE', 'HD', 'PG', 'ABBV', 'UNH', 'CAT', 'BA', 'T', 'VZ', 'SBUX', 'UBER', 'F'];
const SECTOR_NAMES = ['Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy', 'Industrials', 'Communication Services', 'Utilities', 'Real Estate', 'Basic Materials'];
const tName = t => TICKERS.find(e => e.t === t)?.n || t;
const quizPool = () => QUIZ_POOL.filter(t => TICKERS.some(e => e.t === t));
const pctTxt = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
// Two tickers where val(hi) is clearly bigger than val(lo)
function pickPair(rnd, T, ok, val, far) {
 const c = shuffled(T.filter(t => { try { return ok(t); } catch { return false; } }), rnd);
 for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
  const [hi, lo] = val(c[i]) >= val(c[j]) ? [c[i], c[j]] : [c[j], c[i]];
  if (far(val(hi), val(lo))) return [hi, lo];
 }
 return null;
}
function pickTrio(rnd, T, ok, val, far) {
 const c = shuffled(T.filter(t => { try { return ok(t); } catch { return false; } }), rnd);
 for (let i = 0; i + 2 < c.length; i++) {
  const three = c.slice(i, i + 3).sort((x, y) => val(y) - val(x));
  if (far(val(three[0]), val(three[1]))) return three;
 }
 return null;
}
const LIVE_QS = [
 // P/E
 (r, T, F) => {
  const p = pickPair(r, T, t => F(t)?.trailingPE > 0 && F(t).trailingPE < 400, t => F(t).trailingPE, (h, l) => h >= l * 1.3);
  if (!p) return null; const [hi, lo] = p, pe = t => F(t).trailingPE.toFixed(1);
  return { q: 'Investors are paying more for each $1 of yearly profit at which company right now?', a: [tName(hi), tName(lo), 'They cost about the same'], why: `${tName(hi)}'s P/E is ${pe(hi)} and ${tName(lo)}'s is ${pe(lo)}. A P/E of ${pe(hi)} means paying about $${pe(hi)} for every $1 of yearly profit.`, lesson: 'pe-ratio' };
 },
 // Market cap
 (r, T, F) => {
  const c = pickTrio(r, T, t => F(t)?.marketCap > 0, t => F(t).marketCap, (a, b) => a >= b * 1.3);
  if (!c) return null;
  return { q: 'Which of these companies is worth the most in total right now?', a: c.map(tName), why: `Market caps today: ${c.map(t => `${tName(t)} ${fmtBig(F(t).marketCap)}`).join(', ')}. Market cap is the share price times the number of shares.`, lesson: 'market-cap' };
 },
 // Profit margin
 (r, T, F) => {
  const p = pickPair(r, T, t => F(t)?.profitMargin != null, t => F(t).profitMargin, (h, l) => h - l >= 0.06);
  if (!p) return null; const [hi, lo] = p;
  const cents = t => { const m = F(t).profitMargin; return m >= 0 ? `keeps about ${Math.round(m * 100)} cents` : `loses about ${Math.round(-m * 100)} cents`; };
  return { q: 'Which company keeps more of each $1 of sales as profit?', a: [tName(hi), tName(lo), 'They keep the same amount'], why: `Out of every sales dollar, ${tName(hi)} ${cents(hi)} and ${tName(lo)} ${cents(lo)}.`, lesson: 'margins' };
 },
 // Volatility
 (r, T, F, S) => {
  const p = pickPair(r, T, t => S(t)?.vol > 0, t => S(t).vol, (h, l) => h >= l * 1.4);
  if (!p) return null; const [hi, lo] = p;
  return { q: 'Whose stock price swings more?', a: [tName(hi), tName(lo), 'They swing about the same'], why: `${tName(hi)}'s yearly volatility is about ${pctTxt(S(hi).vol)}, ${tName(lo)}'s about ${pctTxt(S(lo).vol)}. Bigger swings mean a wider range of outcomes, up and down.`, lesson: 'volatility-beta' };
 },
 // Past year
 (r, T, F, S) => {
  const t = shuffled(T.filter(t => S(t)?.ret1y != null && Math.abs(S(t).ret1y) > 0.02 && Math.abs(S(t).ret1y - 0.2) > 0.02), r)[0];
  if (!t) return null; const v = S(t).ret1y;
  const opts = ['Up more than 20%', 'Up between 0% and 20%', 'Down'], right = v > 0.2 ? 0 : v > 0 ? 1 : 2;
  return { q: `Over the past year, how did ${tName(t)}'s stock price do?`, a: [opts[right], ...opts.filter((_, k) => k !== right)], why: `${tName(t)} is ${fmtSigned(v, 0)} over the past year. One year is a short window, so it says little about the next one.`, lesson: 'read-chart' };
 },
 // Sector
 (r, T, F) => {
  const t = shuffled(T.filter(t => F(t)?.sector), r)[0];
  if (!t) return null; const sec = F(t).sector;
  const others = shuffled(SECTOR_NAMES.filter(x => x !== sec), r).slice(0, 2);
  return { q: `${tName(t)} belongs to which sector?`, a: [sec, ...others], why: `${tName(t)} is in ${sec}${F(t).industry ? `, in the ${F(t).industry} industry` : ''}. Stocks in the same sector often move together.`, lesson: 'sectors' };
 },
 // Dividend yield
 (r, T, F) => {
  const c = pickTrio(r, T, t => F(t)?.price > 0, t => F(t).dividendYield || 0, (a, b) => a >= 0.01 && a >= b * 1.4);
  if (!c) return null; const y = t => F(t).dividendYield ? pctTxt(F(t).dividendYield, 1) : 'no dividend';
  return { q: 'Which of these pays the highest dividend yield right now?', a: c.map(tName), why: `Yields today: ${c.map(t => `${tName(t)} ${y(t)}`).join(', ')}. A 3% yield pays $3 a year for every $100 invested.`, lesson: 'dividends' };
 },
 // Analyst target
 (r, T, F) => {
  const t = shuffled(T.filter(t => F(t)?.analysts >= 5 && F(t).targetMean > 0 && F(t).price > 0 && Math.abs(F(t).targetMean / F(t).price - 1) >= 0.04), r)[0];
  if (!t) return null; const f = F(t), up = f.targetMean / f.price - 1;
  const opts = ['Above today\'s price', 'Below today\'s price'];
  return { q: `Is the analysts' average price target for ${tName(t)} above or below today's price?`, a: [up > 0 ? opts[0] : opts[1], up > 0 ? opts[1] : opts[0], 'Exactly at today\'s price'], why: `The average of ${f.analysts} analysts' targets is ${fmtPx(f.targetMean)}, compared with ${fmtPx(f.price)} today (${fmtSigned(up, 0)}). Targets are educated guesses, not promises.`, lesson: 'analyst-targets' };
 },
 // Biggest drop this year
 (r, T, F, S) => {
  const near = d => Math.abs(d - 0.15) < 0.02 || Math.abs(d - 0.35) < 0.02;
  const t = shuffled(T.filter(t => S(t)?.maxDD != null && !near(-S(t).maxDD)), r)[0];
  if (!t) return null; const d = -S(t).maxDD;
  const opts = ['Less than 15%', 'Between 15% and 35%', 'More than 35%'], right = d < 0.15 ? 0 : d <= 0.35 ? 1 : 2;
  return { q: `What was ${tName(t)}'s biggest fall from a high during the past year?`, a: [opts[right], ...opts.filter((_, k) => k !== right)], why: `At its worst point, ${tName(t)} was ${pctTxt(d)} below its high. Even great companies have big drops along the way.`, lesson: 'bull-bear' };
 },
 // Revenue growth
 (r, T, F) => {
  const p = pickPair(r, T, t => F(t)?.revenueGrowth != null, t => F(t).revenueGrowth, (h, l) => h - l >= 0.08);
  if (!p) return null; const [hi, lo] = p;
  return { q: 'Whose sales grew faster in the latest quarter, compared with a year earlier?', a: [tName(hi), tName(lo), 'They grew at the same pace'], why: `${tName(hi)}'s revenue grew ${fmtSigned(F(hi).revenueGrowth, 0)} and ${tName(lo)}'s ${fmtSigned(F(lo).revenueGrowth, 0)}.`, lesson: 'revenue-growth' };
 },
 // Beta
 (r, T, F, S) => {
  const p = pickPair(r, T, t => S(t)?.beta != null, t => S(t).beta, (h, l) => h - l >= 0.4);
  if (!p) return null; const [hi, lo] = p;
  return { q: 'Which stock tends to move more when the whole market moves?', a: [tName(hi), tName(lo), 'Neither, stocks don\'t follow the market'], why: `${tName(hi)}'s beta is ${S(hi).beta.toFixed(2)} and ${tName(lo)}'s is ${S(lo).beta.toFixed(2)}. A beta above 1 means bigger moves than the market.`, lesson: 'volatility-beta' };
 },
];
async function liveQuestions(n, rnd) {
 const T = shuffled(quizPool(), rnd).slice(0, 14);
 const items = T.map(t => [t, 's']);
 await Promise.all([fetchFacts(items).catch(() => null), fetchStats(items).catch(() => null)]);
 const out = [];
 for (const g of shuffled(LIVE_QS, rnd)) {
  if (out.length >= n) break;
  try { const q = g(rnd, T, factsFor, liveStats); if (q) out.push({ ...q, live: true }); } catch {}
 }
 return out;
}

/* ── The home row and the Learn hub ── */
const stockOfDay = () => { const p = quizPool(); return p[Math.floor(seededRand('stock:' + learnToday())() * p.length)] || 'AAPL'; };
function learnTiles(s) {
 const today = learnToday(), tiles = [];
 const dailyDone = s.daily?.date === today && s.daily.done;
 const streakOn = streakAlive(s, today);
 if (!dailyDone) tiles.push({ icon: 'bolt', title: 'Today\'s challenge', sub: streakOn ? `${s.dstreak}-day streak, keep it going` : '5 real-market questions · +70 XP', go: 'startDaily()' });
 allLessonIds().filter(id => !lessonDone(id)).slice(0, 3).forEach(id => {
  const l = lessonById(id), st = s.lessons[id] || {};
  tiles.push({ icon: l.icon, title: l.title, sub: st.read ? 'Quiz waiting · +30 XP' : `${l.mins} min · +50 XP`, go: `openLesson('${id}')` });
 });
 const t = stockOfDay();
 tiles.push({ icon: 'search', title: `Learn from ${tName(t)}`, sub: 'Its real numbers, explained', go: `openStockLesson('${t}')` });
 tiles.push({ icon: 'loop', title: 'Endless practice', sub: 'Fresh questions every round', go: 'startPractice()' });
 return tiles.slice(0, 3);
}
function learnRowHTML() {
 if (!LEARN_LIB.full) setTimeout(loadLessonLibrary, 1500);
 const s = getLearn();
 const lv = learnLevel(s.xp);
 return `
 <button type="button" class="dash-learn-intro learn-level" onclick="openLearnHub()" aria-label="Open all lessons">
  <span class="lv-ring" style="--p:${lv.pct.toFixed(0)}"><b>${lv.n}</b></span>
  <span class="lv-txt"><span class="lv-name">Learn &amp; grow</span><span class="lv-sub">${user ? `${lv.name} · ${s.xp} XP` : 'Free with an account'}</span></span>
 </button>
 ${learnTiles(s).map((x, i) => `<button type="button" class="dash-lesson dash-lesson-${i % 3}" onclick="${x.go}">
   <span class="dash-lesson-ico">${learnIcon(x.icon)}</span>
   <span class="dash-lesson-txt"><span class="dash-lesson-title">${escapeHTML(x.title)}</span><span class="dash-lesson-time">${x.sub}</span></span>
  </button>`).join('')}`;
}

function refreshLearnRow() {
 const row = document.querySelector('.dash-learn');
 if (row) row.innerHTML = learnRowHTML();
 const hub = document.getElementById('learnHubBody');
 if (hub) {
  const open = [...hub.querySelectorAll('details.hub-track[open]')].map(d => d.dataset.track);
  hub.innerHTML = learnHubHTML(open);
 }
}

function learnHubHTML(openTracks) {
 const s = getLearn();
 const lv = learnLevel(s.xp);
 const ids = allLessonIds();
 const done = ids.filter(id => lessonDone(id)).length;
 const today = learnToday();
 const dailyDone = s.daily?.date === today && s.daily.done;
 const streak = streakAlive(s, today) ? s.dstreak : 0;
 const due = reviewDue(s, today).length;
 const firstOpen = LEARN_LIB.tracks.find(t => t.lessons.some(id => !lessonDone(id)))?.id;
 const stockT = stockOfDay();
 return `
 <div class="hub-top">
  <span class="lv-ring lv-ring-lg" style="--p:${lv.pct.toFixed(0)}"><b>${lv.n}</b></span>
  <div class="hub-lv">
   <h2 id="learnHubTitle">Level ${lv.n}: ${lv.name}</h2>
   <p>${s.xp} XP, ${lv.next - s.xp} XP to Level ${lv.n + 1}</p>
   <div class="hub-bar"><i style="width:${lv.pct.toFixed(0)}%"></i></div>
  </div>
 </div>
 <div class="hub-stats">
  <div><b>${done}/${ids.length}${LEARN_LIB.full ? '' : '+'}</b><span>Lessons done</span></div>
  <div><b>${streak}</b><span>Day streak</span></div>
  <div><b>${Object.values(s.lessons).filter(l => l.best === 3).length}</b><span>Perfect quizzes</span></div>
 </div>
 ${rewardsHubHTML(s, lv)}
 <div class="hub-modes">
  <button type="button" class="hub-mode hm-daily${dailyDone ? ' is-done' : ''}" onclick="startDaily()">
   <span class="hm-ico">${learnIcon(dailyDone ? 'check' : 'bolt')}</span>
   <b>Today's challenge</b><span>${dailyDone ? `Done, ${s.daily.score}/${s.daily.total}. New one tomorrow` : `5 questions from today's market${due ? `, plus ${Math.min(due, 2)} to review` : ''}`}</span>
  </button>
  <button type="button" class="hub-mode" onclick="startPractice()">
   <span class="hm-ico">${learnIcon('loop')}</span>
   <b>Endless practice</b><span>New questions every round${s.practice.n ? `, ${s.practice.right} of ${s.practice.n} right so far` : ''}</span>
  </button>
  <button type="button" class="hub-mode" onclick="openStockLesson('${stockT}')">
   <span class="hm-ico">${learnIcon('search')}</span>
   <b>Learn from ${escapeHTML(tName(stockT))}</b><span>Today's real stock, explained</span>
  </button>
 </div>
 ${hubLeagueHTML()}
 <div class="hub-tracks">
  ${LEARN_LIB.tracks.map((t, ti) => {
   const n = t.lessons.filter(id => lessonDone(id)).length;
   const open = openTracks ? openTracks.includes(t.id) : t.id === firstOpen;
   return `<details class="hub-track" data-track="${t.id}"${open ? ' open' : ''}>
    <summary><span class="dash-lesson-ico dash-lesson-${ti % 3}">${learnIcon(t.icon)}</span><span class="ht-txt"><b>${escapeHTML(t.title)}</b><span>${escapeHTML(t.desc || '')}</span></span><span class="ht-n${n === t.lessons.length ? ' all' : ''}">${n}/${t.lessons.length}</span></summary>
    <div class="hub-list">${t.lessons.map(id => {
     const l = lessonById(id), st = s.lessons[id] || {}, isDone = lessonDone(id);
     return `<button type="button" class="hub-item dash-lesson-${ti % 3}${isDone ? ' is-done' : ''}" onclick="openLesson('${id}')">
      <span class="dash-lesson-ico">${isDone ? learnIcon('check') : learnIcon(l.icon)}</span>
      <span class="hub-item-txt"><b>${escapeHTML(l.title)}</b><span>${isDone ? `Done, best quiz ${st.best}/3` : st.read ? 'Read, quiz waiting' : `${l.mins} min, ${l.cards.filter(c => typeof c === 'object').length} hands-on`}</span></span>
      <span class="hub-xp">${isDone && st.best === 3 ? 'Mastered' : '+' + (isDone ? (3 - st.best) * 10 : st.read ? 30 : 50) + ' XP'}</span>
     </button>`;
    }).join('')}</div>
   </details>`;
  }).join('')}
  ${LEARN_LIB.full ? '' : '<p class="hub-more">Loading more lessons...</p>'}
 </div>
 <button type="button" class="hub-tour" onclick="closeLesson();${user ? 'restartTutorial()' : "openModal('signup')"}">${s.tourDone ? 'Replay the app tour' : 'Take the app tour'}<span>${s.tourDone ? 'Refresh your memory' : 'Up to 150 XP'}</span></button>`;
}

function lessonOverlay(labelId, inner, extraCls = '') {
 closeLesson();
 const ov = document.createElement('div');
 ov.className = 'modal-overlay lesson-overlay';
 ov.id = 'lessonOverlay';
 ov.innerHTML = `<div class="modal-box lesson-box ${extraCls}" role="dialog" aria-modal="true" aria-labelledby="${labelId}">
  <button type="button" class="modal-close" onclick="closeLesson()" aria-label="Close">${DASH_ICON('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>
  ${inner}
 </div>`;
 ov.addEventListener('click', e => { if (e.target === ov) closeLesson(); });
 document.body.appendChild(ov);
 return ov;
}
function openLearnHub() {
 if (!requireAuth('Learn')) return;
 lessonOverlay('learnHubTitle', `<div id="learnHubBody">${learnHubHTML()}</div>`, 'hub-box');
 if (!LEARN_LIB.full) loadLessonLibrary();
}

/* ── Running a lesson, a real-stock lesson, the daily challenge or a practice round ── */
let _lesson = null;
function startRun(R) {
 R.seq = Date.now() + Math.random();
 _lesson = R;
 lessonOverlay('lessonTitle', '<div id="lessonBody"></div>');
 _lesson = R;   // lessonOverlay cleared it
 renderLesson();
}
function quizOrder(qs) { return qs.map(q => shuffleIdx(q.a.length)); }
async function openLesson(id) {
 if (!requireAuth('Learn')) return;
 if (typeof id === 'number') id = CORE_TRACK.lessons[id];
 let l = lessonById(id);
 if (!l && !LEARN_LIB.full) { await loadLessonLibrary(); l = lessonById(id); }
 if (!l) return;
 startRun({ kind: 'lesson', L: l, page: 0, mode: 'read', q: 0, score: 0, picked: null, order: quizOrder(l.quiz), ix: {}, results: [] });
}
function startQuizRun(kind, title, icon) {
 startRun({ kind, L: { id: kind, title, icon, quiz: [] }, mode: 'loading', q: 0, score: 0, picked: null, order: [], ix: {}, results: [] });
 return _lesson;
}
function fillRun(R, qs) {
 if (_lesson !== R) return;
 R.L.quiz = qs; R.order = quizOrder(qs); R.mode = qs.length ? 'quiz' : 'error';
 renderLesson();
}
async function startDaily() {
 if (!requireAuth('Learn')) return;
 const today = learnToday(), s0 = getLearn();
 if (s0.daily?.date === today && s0.daily.done) { toast('Today\'s challenge is done. Here\'s a practice round instead.', 'info', 2600); return startPractice(); }
 const R = startQuizRun('daily', 'Today\'s challenge', 'bolt');
 await loadLessonLibrary();
 const rnd = seededRand('daily:' + today);
 const review = reviewDue(getLearn(), today).slice(0, 2).map(q => ({ ...q, review: true }));
 const live = await liveQuestions(5 - review.length, rnd);
 let qs = [...live, ...review];
 if (qs.length < 5) qs.push(...shuffled(bankQuestions().filter(q => !qs.some(x => x.qid === q.qid)), rnd).slice(0, 5 - qs.length));
 fillRun(R, qs);
}
async function startPractice() {
 if (!requireAuth('Learn')) return;
 const R = startQuizRun('practice', 'Endless practice', 'loop');
 await loadLessonLibrary();
 const live = await liveQuestions(3, Math.random);
 const review = reviewDue(getLearn(), learnToday()).slice(0, 1).map(q => ({ ...q, review: true }));
 let qs = [...live, ...review];
 qs.push(...shuffled(bankQuestions().filter(q => !qs.some(x => x.qid === q.qid))).slice(0, 5 - qs.length));
 fillRun(R, shuffled(qs));
}

// A lesson written from one real stock's numbers: what it is, its chart, its valuation, risk and analysts
async function openStockLesson(t) {
 if (!requireAuth('Learn')) return;
 t = String(t || stockOfDay()).toUpperCase();
 const k = tickerKind(t);
 const R = startQuizRun('stock', `Learn from ${tName(t)}`, 'search');
 R.ticker = t;
 const [d] = await Promise.all([getFundamentals(t, k), fetchStats([[t, k]]).catch(() => null)]);
 if (_lesson !== R) return;
 const f = d?.facts, S = liveStats(t);
 if (!f?.price) { R.mode = 'error'; R.err = `We couldn't load ${t}'s numbers right now.`; return renderLesson(); }
 const name = f.name || tName(t);
 const cap = f.marketCap, capClass = cap >= 200e9 ? 'mega-cap' : cap >= 10e9 ? 'large-cap' : cap >= 2e9 ? 'mid-cap' : 'small-cap';
 const pe = f.trailingPE > 0 ? f.trailingPE : null;
 const cards = [
  `${escapeHTML(name)} (${t}) ${f.sector ? `is in the ${escapeHTML(f.sector)} sector${f.industry ? `, in ${escapeHTML(f.industry)}` : ''}` : 'is a publicly traded company'}.${cap ? ` All its shares together are worth about ${fmtBig(cap)}, which makes it a ${capClass} company.` : ''} Let's read its numbers like an investor.`,
  { t: 'live', live: 'zoom', ticker: t, text: `Here's ${escapeHTML(tName(t))}'s real price. Tap through the ranges: what story does each one tell?` },
 ];
 if (pe) cards.push({ t: 'predict', q: `${escapeHTML(tName(t))}'s P/E ratio is ${pe.toFixed(1)}. What does that mean?`, a: [`Investors pay about $${pe.toFixed(0)} for each $1 of its yearly profit`, `One share costs $${pe.toFixed(0)}`, `It earns ${pe.toFixed(0)}% a year`], why: `P/E is the share price divided by a year of profit per share. A higher P/E usually means investors expect faster growth.` });
 else cards.push(`${escapeHTML(tName(t))} has no P/E right now because it hasn't been profitable over the last year (or doesn't report profit like a company). That's common for young companies and funds.`);
 if (f.profitMargin != null) cards.push(`Out of every $1 of sales, ${escapeHTML(tName(t))} ${f.profitMargin >= 0 ? `keeps about ${Math.round(f.profitMargin * 100)} cents as profit` : `loses about ${Math.round(-f.profitMargin * 100)} cents`}${f.revenueGrowth != null ? `, and its sales ${f.revenueGrowth >= 0 ? 'grew' : 'shrank'} ${pctTxt(Math.abs(f.revenueGrowth))} in the latest quarter compared with a year earlier` : ''}.${f.dividendYield ? ` It also pays a dividend yielding about ${pctTxt(f.dividendYield, 1)} a year.` : ''}`);
 if (S?.ret1y != null) cards.push(`Over the past year the price moved ${fmtSigned(S.ret1y, 0)}.${S.maxDD != null ? ` At its worst it was ${pctTxt(-S.maxDD)} below its high.` : ''}${S.vol != null ? ` Its yearly volatility is about ${pctTxt(S.vol)}` : ''}${S.beta != null ? `, and its beta of ${S.beta.toFixed(2)} means it tends to move ${S.beta > 1.1 ? 'more than' : S.beta < 0.9 ? 'less than' : 'about as much as'} the market` : ''}${S.vol != null ? '.' : ''}`);
 const up = f.targetMean && f.analysts >= 3 ? f.targetMean / f.price - 1 : null;
 if (up != null && Math.abs(up) >= 0.02) cards.push({ t: 'predict', q: `Guess: is the average analyst price target for ${escapeHTML(tName(t))} above or below today's price?`, a: [up > 0 ? 'Above today\'s price' : 'Below today\'s price', up > 0 ? 'Below today\'s price' : 'Above today\'s price', 'Exactly at today\'s price'], why: `${f.analysts} analysts' average target is ${fmtPx(f.targetMean)}, compared with ${fmtPx(f.price)} today (${fmtSigned(up, 0)}). Targets are educated guesses, not promises.` });
 // Quiz from the same numbers
 const quiz = [];
 if (cap) {
  const near = fmtBig(cap), opts = [near, fmtBig(cap * 10), fmtBig(cap / 10)];
  if (new Set(opts).size === 3) quiz.push({ q: `About how much is ${escapeHTML(tName(t))} worth in total?`, a: opts, why: `Its market cap is about ${near}: the share price times every share.` });
 }
 if (f.sector) quiz.push({ q: `Which sector is ${escapeHTML(tName(t))} in?`, a: [f.sector, ...shuffled(SECTOR_NAMES.filter(x => x !== f.sector)).slice(0, 2)], why: `It's in ${f.sector}${f.industry ? ` (${f.industry})` : ''}.` });
 if (S?.ret1y != null && Math.abs(S.ret1y) > 0.02) quiz.push({ q: `Over the past year, did ${escapeHTML(tName(t))}'s price go up or down?`, a: [S.ret1y > 0 ? 'Up' : 'Down', S.ret1y > 0 ? 'Down' : 'Up', 'It didn\'t move'], why: `It's ${fmtSigned(S.ret1y, 0)} over the past year.` });
 if (f.profitMargin != null && f.profitMargin > 0.01) quiz.push({ q: `About how much of each $1 in sales does ${escapeHTML(tName(t))} keep as profit?`, a: [`${Math.round(f.profitMargin * 100)} cents`, `${Math.min(95, Math.round(f.profitMargin * 100) + 30)} cents`, '$1'], why: `Its profit margin is ${pctTxt(f.profitMargin, 1)}.` });
 if (pe) quiz.push({ q: `With a P/E of ${pe.toFixed(1)}, about how much do investors pay for each $1 of ${escapeHTML(tName(t))}'s yearly profit?`, a: [`About $${pe.toFixed(0)}`, `About $1`, `About $${Math.max(2, Math.round(pe / 4))}`].filter((x, i, a) => a.indexOf(x) === i), why: 'That\'s exactly what P/E measures.' });
 const qs = quiz.filter(q => q.a.length === 3).slice(0, 3);
 if (qs.length < 3) { await loadLessonLibrary(); qs.push(...shuffled(bankQuestions()).slice(0, 3 - qs.length)); }
 if (_lesson !== R) return;
 R.L = { id: 'stock:' + t, title: `Learn from ${tName(t)}`, icon: 'search', mins: 2, cards, quiz: qs, cta: { label: `Open ${t}'s full page`, go: t } };
 R.order = quizOrder(qs); R.page = 0; R.mode = 'read';
 renderLesson();
}

function learnCta(c) {
 if (!c) return '';
 const act = c.go ? `goAsset('${jsq(c.go)}','${tickerKind(c.go)}')` : c.tab ? `switchTab('${jsq(c.tab)}')` : '';
 return act ? `closeLesson();${act}` : 'closeLesson()';
}
function nextLessonId(id) {
 const ids = allLessonIds(), i = ids.indexOf(id);
 return ids.slice(i + 1).find(x => !lessonDone(x)) || ids.find(x => !lessonDone(x)) || null;
}

function renderLesson() {
 const box = document.getElementById('lessonBody');
 if (!box || !_lesson) return;
 const R = _lesson, L = R.L;
 const tr = R.kind === 'lesson' ? trackOf(L.id) : null;
 const kicker = tr ? `${escapeHTML(tr.title)} · Lesson ${tr.lessons.indexOf(L.id) + 1} of ${tr.lessons.length}` : R.kind === 'stock' ? 'Real stock lesson' : R.kind === 'daily' ? new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Practice';
 const sub = R.mode === 'loading' ? 'Getting real market data...'
  : R.mode === 'read' ? (R.kind === 'stock' ? 'Real numbers, explained · +15 XP' : `${L.mins} min read · +20 XP`)
  : R.mode === 'quiz' ? (R.kind === 'practice' ? 'Practice · +3 XP per right answer' : 'Quick check · +10 XP per right answer')
  : R.mode === 'error' ? 'Something went wrong' : 'Complete';
 const ci = tr ? LEARN_LIB.tracks.indexOf(tr) % 3 : R.kind === 'daily' ? 1 : 2;
 const head = `<div class="lesson-head"><div class="lesson-ico dash-lesson-${ci}">${learnIcon(L.icon)}</div><div><div class="lesson-kicker">${kicker}</div><h2 id="lessonTitle" class="lesson-title">${escapeHTML(L.title)}</h2><div class="lesson-time">${sub}</div></div></div>`;
 if (R.mode === 'loading') {
  box.innerHTML = `${head}<div class="lc-load lc-load-lg"><i></i><i></i><i></i></div>`;
 } else if (R.mode === 'error') {
  box.innerHTML = `${head}<p class="lesson-card">${escapeHTML(R.err || 'Live market data isn\'t available right now. Try again in a minute.')}</p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="openLearnHub()">All lessons</button>${R.kind === 'stock' ? `<button type="button" class="lesson-cta" onclick="openStockLesson('${jsq(shuffled(quizPool().filter(x => x !== R.ticker))[0] || 'AAPL')}')">Try another stock</button>` : `<button type="button" class="lesson-cta" onclick="${R.kind === 'daily' ? 'startDaily()' : 'startPractice()'}">Try again</button>`}</div>`;
 } else if (R.mode === 'read') {
  const card = L.cards[R.page], last = R.page === L.cards.length - 1;
  const need = lcNeedsAnswer(card) && !R.ix[R.page]?.done;
  box.innerHTML = `${head}
  <div class="lesson-steps">${L.cards.map((_, k) => `<i class="${k <= R.page ? 'on' : ''}"></i>`).join('')}</div>
  <div class="lc-wrap" id="lcWrap">${lcHTML(card, R.page)}</div>
  <div class="lesson-nav">
   <button type="button" class="dash-btn" onclick="lessonStep(-1)" ${R.page === 0 ? 'disabled' : ''}>Back</button>
   ${need && card.t !== 'predict' ? '<button type="button" class="lc-skip" onclick="lcSkip()">Skip</button>' : ''}
   <button type="button" class="lesson-cta" onclick="lessonStep(1)" ${need ? 'disabled' : ''}>${last ? 'Take the quiz' : 'Next'}</button>
  </div>`;
  lcMount(card, R.page);
 } else if (R.mode === 'quiz') {
  const qq = L.quiz[R.q];
  const order = R.order[R.q];
  const answered = R.picked !== null;
  const lessonLink = answered && qq.lesson && R.kind !== 'lesson' && lessonById(qq.lesson) ? `<button type="button" class="lc-skip" onclick="openLesson('${qq.lesson}')">Lesson: ${escapeHTML(lessonById(qq.lesson).title)}</button>` : '<span></span>';
  box.innerHTML = `${head}
  <div class="lesson-steps">${L.quiz.map((_, k) => `<i class="${k < R.q || (k === R.q && answered) ? 'on' : ''}"></i>`).join('')}</div>
  <div class="quiz-q">Question ${R.q + 1} of ${L.quiz.length}${qq.live ? ' · <span class="lc-tag">Live data</span>' : qq.review ? ' · <span class="lc-tag">Review</span>' : ''}</div>
  <p class="quiz-text">${qq.q}</p>
  <div class="quiz-opts">${order.map(k => {
   const cls = !answered ? '' : k === 0 ? ' right' : k === R.picked ? ' wrong' : ' dim';
   return `<button type="button" class="quiz-opt${cls}" onclick="lessonAnswer(${k})" ${answered ? 'disabled' : ''}>${escapeHTML(qq.a[k])}</button>`;
  }).join('')}</div>
  ${answered ? `<p class="quiz-why ${R.picked === 0 ? 'ok' : 'no'}"><b>${R.picked === 0 ? 'Correct.' : 'Not quite.'}</b> ${qq.why}</p>
  <div class="lesson-nav">${lessonLink}<button type="button" class="lesson-cta" onclick="lessonNextQ()">${R.q === L.quiz.length - 1 ? 'See results' : 'Next question'}</button></div>` : ''}`;
 } else {
  box.innerHTML = `${head}${doneHTML(R)}`;
 }
 box.querySelector('.lesson-cta:not([disabled]), .quiz-opt:not([disabled]), .lc-chip, .lc-m:not([disabled])')?.focus({ preventScroll: true });
}

function doneHTML(R) {
 const L = R.L, n = L.quiz.length, perfect = R.score === n;
 const lv = learnLevel(getLearn().xp), s = getLearn();
 const score = `<div class="quiz-result">
   <div class="quiz-score ${perfect ? 'perfect' : ''}"><b>${R.score}/${n}</b><span>${perfect ? 'Perfect score' : R.score >= n * 0.6 ? 'Nice work' : 'Keep practicing'}</span></div>
   <div class="quiz-earned">You earned <b>${R.earned} XP</b>${R.note ? `. ${R.note}` : ''}.</div>
   <div class="hub-lvline"><span>Level ${lv.n}: ${lv.name}</span><div class="hub-bar"><i style="width:${lv.pct.toFixed(0)}%"></i></div></div>
  </div>`;
 if (R.kind === 'lesson') {
  const next = nextLessonId(L.id);
  return `${score}<div class="lesson-nav">
   ${R.score < n ? `<button type="button" class="dash-btn" onclick="openLesson('${L.id}')">Try again</button>` : L.cta ? `<button type="button" class="dash-btn" onclick="${learnCta(L.cta)}">${escapeHTML(L.cta.label)}</button>` : '<span></span>'}
   ${next ? `<button type="button" class="lesson-cta" onclick="openLesson('${next}')">Next lesson</button>` : '<button type="button" class="lesson-cta" onclick="startPractice()">Keep practicing</button>'}
  </div>`;
 }
 if (R.kind === 'stock') {
  const other = shuffled(quizPool().filter(x => x !== R.ticker))[0] || 'AAPL';
  return `${score}<div class="lesson-nav"><button type="button" class="dash-btn" onclick="${learnCta(L.cta)}">${escapeHTML(L.cta.label)}</button><button type="button" class="lesson-cta" onclick="openStockLesson('${other}')">Another stock</button></div>`;
 }
 if (R.kind === 'daily') {
  return `${score}<p class="lc-streak">${learnIcon('fire')}<span><b>${s.dstreak}-day streak.</b>${R.froze ? ` A streak freeze saved it${R.froze > 1 ? ` (${R.froze} used)` : ''}.` : ''} ${s.dstreak > 1 ? 'Come back tomorrow to keep it going.' : 'Come back tomorrow to start a streak.'}</span></p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="openLearnHub()">All lessons</button><button type="button" class="lesson-cta" onclick="startPractice()">Keep practicing</button></div>`;
 }
 return `${score}<div class="lesson-nav"><button type="button" class="dash-btn" onclick="openLearnHub()">All lessons</button><button type="button" class="lesson-cta" onclick="startPractice()">Another round</button></div>`;
}

function lessonStep(d) {
 const R = _lesson; if (!R) return;
 const L = R.L;
 if (d > 0 && R.page === L.cards.length - 1) {
  const s = getLearn();
  if (R.kind === 'stock') {
   const st = s.stocks[R.ticker] || {};
   if (!st.read) { st.read = true; st.at = Date.now(); s.stocks[R.ticker] = st; saveLearn(s); learnAddXP(15); }
  } else {
   const st = s.lessons[L.id] || {};
   if (!st.read) { st.read = true; s.lessons[L.id] = st; saveLearn(s); learnAddXP(20); }
  }
  R.mode = 'quiz'; R.q = 0; R.picked = null; R.score = 0; R.results = [];
 } else {
  R.page = Math.max(0, Math.min(L.cards.length - 1, R.page + d));
 }
 renderLesson();
}

function lessonAnswer(k) {
 const R = _lesson;
 if (!R || R.picked !== null) return;
 R.picked = k;
 if (k === 0) R.score++;
 const q = R.L.quiz[R.q];
 const qid = q.qid || (R.kind === 'lesson' ? `${R.L.id}#${R.q}` : null);
 R.results.push({ qid, right: k === 0 });
 renderLesson();
}

function lessonNextQ() {
 const R = _lesson; if (!R) return;
 const L = R.L;
 if (R.q < L.quiz.length - 1) { R.q++; R.picked = null; renderLesson(); return; }
 const s = getLearn(), n = L.quiz.length;
 let earned = 0;
 if (R.kind === 'lesson' || R.kind === 'stock') {
  const map = R.kind === 'lesson' ? s.lessons : s.stocks, key = R.kind === 'lesson' ? L.id : R.ticker;
  const st = map[key] || { read: true };
  const prevBest = st.best ?? 0;
  earned = Math.max(0, R.score - prevBest) * 10;
  if (R.score === n && prevBest < n) earned += R.kind === 'lesson' ? 20 : 10;
  st.best = Math.max(prevBest, R.score);
  if (R.kind === 'stock') st.at = Date.now();
  map[key] = st;
 } else if (R.kind === 'daily') {
  const today = learnToday();
  if (!(s.daily?.date === today && s.daily.done)) {
   earned = R.score * 10 + (R.score === n ? 20 : 0);
   s.daily = { date: today, score: R.score, total: n, done: true };
   // Missed days are forgiven if you have enough streak freezes saved
   const gap = s.dlast ? daysFrom(s.dlast, today) : null;
   if (gap === 1) s.dstreak = (s.dstreak || 0) + 1;
   else if (gap > 1 && s.dstreak && gap - 1 <= (s.freezes || 0)) { s.freezes -= gap - 1; s.dstreak += 1; R.froze = gap - 1; }
   else if (gap !== 0) s.dstreak = 1;
   s.dlast = today;
  }
 } else {
  earned = R.score * 3;
  s.practice = { n: (s.practice?.n || 0) + n, right: (s.practice?.right || 0) + R.score };
 }
 applyReview(s, R.results);
 saveLearn(s);
 R.earned = earned;
 R.note = R.kind === 'daily' && earned === 0 ? 'You already finished today\'s challenge' : '';
 R.mode = 'done';
 if (earned) learnAddXP(earned);
 if (R.score === n) { try { launchConfetti(); } catch {} }
 track('learn_complete', { kind: R.kind, id: L.id, score: R.score, total: n });
 renderLesson();
 refreshLearnRow();
}

function closeLesson() {
 document.getElementById('lessonOverlay')?.remove();
 _lesson = null;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLesson(); });

/* ── Hands-on cards ── */
const lcNeedsAnswer = c => c && typeof c === 'object' && ['predict', 'sort', 'match'].includes(c.t);
function lcState(i, init) { const R = _lesson; if (!R) return init(); if (!R.ix[i]) R.ix[i] = init(); return R.ix[i]; }
function lcFinish(i) {
 const R = _lesson; if (!R) return;
 lcState(i, () => ({})).done = true;
 if (R.mode === 'read' && R.page === i) renderLesson();
}
function lcSkip() { const R = _lesson; if (R) lcFinish(R.page); }
const lcCurrent = i => _lesson && _lesson.mode === 'read' && _lesson.page === i;

function lcHTML(card, i) {
 if (typeof card === 'string') return `<p class="lesson-card">${card}</p>`;
 if (card.t === 'predict') {
  const st = lcState(i, () => ({ order: shuffleIdx(card.a.length), picked: null }));
  const ans = st.picked != null;
  return `<div class="lc-tag">Guess first</div><p class="quiz-text">${card.q}</p>
  <div class="quiz-opts">${st.order.map(k => `<button type="button" class="quiz-opt${!ans ? '' : k === 0 ? ' right' : k === st.picked ? ' wrong' : ' dim'}" onclick="lcPredict(${i},${k})" ${ans ? 'disabled' : ''}>${card.a[k]}</button>`).join('')}</div>
  ${ans ? `<p class="quiz-why ${st.picked === 0 ? 'ok' : 'no'}"><b>${st.picked === 0 ? 'Good guess.' : 'Not quite.'}</b> ${card.why}</p>` : ''}`;
 }
 if (card.t === 'sort') {
  const st = lcState(i, () => { let pool; do { pool = shuffleIdx(card.items.length); } while (pool.every((k, j) => k === j)); return { pool, picked: [], checked: false }; });
  const right = st.checked && st.picked.every((k, j) => k === j);
  return `<div class="lc-tag">Put them in order</div><p class="lesson-card lc-text">${card.text}</p>
  <ol class="lc-sorted">${st.picked.map((k, j) => `<li class="${st.checked ? (k === j ? 'right' : 'wrong') : ''}"><span>${j + 1}</span><em>${card.items[k]}</em>${st.checked ? '' : `<button type="button" aria-label="Take back" onclick="lcSortUndo(${i},${j})">${DASH_ICON('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>`}</li>`).join('')}
   ${st.picked.length < card.items.length ? `<li class="lc-slot"><span>${st.picked.length + 1}</span><em>Tap the ${st.picked.length ? 'next' : 'first'} one below</em></li>` : ''}</ol>
  <div class="lc-chips">${st.pool.filter(k => !st.picked.includes(k)).map(k => `<button type="button" class="lc-chip" onclick="lcSortPick(${i},${k})">${card.items[k]}</button>`).join('')}</div>
  ${st.checked ? `<p class="quiz-why ${right ? 'ok' : 'no'}"><b>${right ? 'Exactly right.' : 'Not quite. The usual order:'}</b> ${right ? '' : card.items.map((x, j) => `${j + 1}. ${x}`).join(' · ') + '. '}${card.why}</p>
   ${right ? '' : `<button type="button" class="dash-btn lc-retry" onclick="lcSortReset(${i})">Try again</button>`}` : ''}`;
 }
 if (card.t === 'match') {
  const st = lcState(i, () => ({ right: shuffleIdx(card.pairs.length), sel: null, got: [], miss: 0, bad: null }));
  const done = st.got.length === card.pairs.length;
  return `<div class="lc-tag">Match them up</div><p class="lesson-card lc-text">${card.text}</p>
  <div class="lc-match">
   <div class="lc-col">${card.pairs.map((p, k) => `<button type="button" class="lc-m${st.got.includes(k) ? ' got' : st.sel === k ? ' sel' : ''}" onclick="lcMatchTerm(${i},${k})" ${st.got.includes(k) ? 'disabled' : ''}>${p[0]}</button>`).join('')}</div>
   <div class="lc-col">${st.right.map(k => `<button type="button" class="lc-m lc-def${st.got.includes(k) ? ' got' : st.bad === k ? ' bad' : ''}" onclick="lcMatchDef(${i},${k})" ${st.got.includes(k) ? 'disabled' : ''}>${card.pairs[k][1]}</button>`).join('')}</div>
  </div>
  <p class="lc-hint">${done ? `All matched${st.miss ? `, with ${st.miss} miss${st.miss > 1 ? 'es' : ''}` : ' on the first try'}.` : st.sel == null ? 'Tap a term on the left, then its meaning on the right.' : `Now tap what <b>${card.pairs[st.sel][0]}</b> means.`}</p>`;
 }
 if (card.t === 'calc') return `<div class="lc-tag">Try it</div><p class="lesson-card lc-text">${card.text}</p><div class="lc-calc" data-calc="${card.calc}">${lcCalcHTML(card.calc)}</div>`;
 if (card.t === 'live') return `<div class="lc-tag">Live data</div><p class="lesson-card lc-text">${card.text}</p><div class="lc-live" id="lcLive-${i}"><div class="lc-load"><i></i><i></i><i></i></div></div>`;
 return '';
}
function lcMount(card, i) {
 if (!card || typeof card !== 'object') return;
 if (card.t === 'calc') lcCalcRun();
 if (card.t === 'live') lcLive(card, i).catch(() => lcLiveFail(i));
}
function lcLiveFail(i) { const el = document.getElementById('lcLive-' + i); if (el) el.innerHTML = '<p class="lc-hint">Live numbers aren\'t available right now. The lesson works without them.</p>'; }

function lcPredict(i, k) {
 const st = lcState(i, () => ({}));
 if (st.picked != null) return;
 st.picked = k; st.done = true;
 renderLesson();
}
function lcSortPick(i, k) {
 const st = lcState(i, () => ({})), card = _lesson.L.cards[i];
 if (st.checked || st.picked.includes(k)) return;
 st.picked.push(k);
 if (st.picked.length === card.items.length) { st.checked = true; st.done = true; }
 renderLesson();
}
function lcSortUndo(i, j) { const st = lcState(i, () => ({})); if (!st.checked) { st.picked.splice(j, 1); renderLesson(); } }
function lcSortReset(i) { const st = lcState(i, () => ({})); st.picked = []; st.checked = false; renderLesson(); }
function lcMatchTerm(i, k) { const st = lcState(i, () => ({})); if (!st.got.includes(k)) { st.sel = k; st.bad = null; renderLesson(); } }
function lcMatchDef(i, k) {
 const st = lcState(i, () => ({})), card = _lesson.L.cards[i];
 if (st.sel == null || st.got.includes(k)) return;
 if (k === st.sel) { st.got.push(k); st.sel = null; st.bad = null; if (st.got.length === card.pairs.length) st.done = true; }
 else { st.miss++; st.bad = k; setTimeout(() => { if (st.bad === k) { st.bad = null; if (lcCurrent(i)) renderLesson(); } }, 700); }
 renderLesson();
}

/* Calculators: sliders in, plain-English answer out */
const $r = v => '$' + Math.round(v).toLocaleString('en-US');
const LC_CALCS = {
 compound: {
  inputs: [['m', 'Invest each month', 0, 1000, 25, 100, '$'], ['y', 'For this many years', 1, 40, 1, 30, ' yrs'], ['r', 'Yearly return', 0, 12, 0.5, 7, '%']],
  out: ({ m, y, r }) => {
   const i = r / 1200, n = y * 12, fv = i ? m * ((1 + i) ** n - 1) / i : m * n, put = m * n, g = Math.max(0, fv - put);
   return `<div class="lc-big">${$r(fv)}</div><div class="lc-sub">after ${y} years</div>
   <div class="lc-split"><i class="a" style="flex:${put || 0.0001}"></i><i class="b" style="flex:${g || 0.0001}"></i></div>
   <div class="lc-legend"><span><i class="a"></i>You put in ${$r(put)}</span><span><i class="b"></i>Growth adds ${$r(g)}</span></div>`;
  },
 },
 fees: {
  inputs: [['f', 'Your fund\'s yearly fee', 0.05, 2, 0.05, 1, '%'], ['y', 'Years invested', 5, 40, 1, 30, ' yrs']],
  out: ({ f, y }) => {
   const base = 10000 * (1.07 * (1 - 0.0005)) ** y, mine = 10000 * (1.07 * (1 - f / 100)) ** y;
   return `<div class="lc-sub">$10,000 growing 7% a year before fees</div>
   <div class="lc-bars">
    <div class="lc-barrow"><span class="lc-bt">0.05% fee</span><span class="lc-bw"><i style="width:100%"></i></span><b>${$r(base)}</b></div>
    <div class="lc-barrow"><span class="lc-bt">${f.toFixed(2)}% fee</span><span class="lc-bw"><i class="neg" style="width:${(mine / base * 100).toFixed(1)}%"></i></span><b>${$r(mine)}</b></div>
   </div>
   <p class="lc-res">${f <= 0.05 ? 'Same fee, same result.' : `That fee costs you about <b>${$r(base - mine)}</b> over ${y} years.`}</p>`;
  },
 },
 inflation: {
  inputs: [['y', 'Years from now', 1, 40, 1, 20, ' yrs'], ['p', 'Inflation each year', 1, 8, 0.5, 3, '%']],
  out: ({ y, p }) => {
   const v = 1000 / (1 + p / 100) ** y;
   return `<div class="lc-big">${$r(v)}</div><div class="lc-sub">is what $1,000 of cash will really buy, in today's money</div>
   <div class="lc-split"><i class="a" style="flex:${v}"></i><i class="c" style="flex:${1000 - v}"></i></div>
   <div class="lc-legend"><span><i class="a"></i>Still buys</span><span><i class="c"></i>Lost to inflation: ${pctTxt(1 - v / 1000)}</span></div>`;
  },
 },
 pe: {
  inputs: [['p', 'Share price', 5, 500, 5, 100, '$'], ['e', 'Yearly profit per share', 0.5, 20, 0.5, 5, '$']],
  out: ({ p, e }) => {
   const pe = p / e;
   return `<div class="lc-big">P/E ${pe.toFixed(1)}</div>
   <p class="lc-res">You pay <b>$${pe.toFixed(1)}</b> for each $1 of yearly profit. If profit never grew, it would take about ${Math.round(pe)} years of profit to add up to the price. ${pe > 35 ? 'Investors are betting on fast growth.' : pe < 12 ? 'Cheap, or investors expect trouble.' : 'A middle-of-the-road valuation.'}</p>`;
  },
 },
 dividend: {
  inputs: [['a', 'You invest', 1000, 100000, 1000, 10000, '$'], ['y', 'Dividend yield', 0.5, 8, 0.25, 3, '%']],
  out: ({ a, y }) => {
   const inc = a * y / 100;
   return `<div class="lc-big">${$r(inc)} a year</div><div class="lc-sub">about ${$r(inc / 12)} a month</div>
   <p class="lc-res">Reinvest every dividend for 10 years at the same yield and, even if the price never moved, your ${$r(a)} grows to about <b>${$r(a * (1 + y / 100) ** 10)}</b>.</p>`;
  },
 },
 dca: {
  inputs: [['d', 'How deep the month-3 dip is', 0, 70, 5, 30, '%']],
  out: ({ d }) => {
   const px = [50, 50, 50 * (1 - d / 100), 50 * (1 - d / 200), 50, 55], sh = px.map(p => 100 / p), tot = sh.reduce((x, y) => x + y, 0);
   const hi = Math.max(...px);
   return `<div class="lc-months">${px.map((p, k) => `<div><span class="lc-mbar" style="height:${(p / hi * 100).toFixed(0)}%"></span><b>$${p.toFixed(0)}</b><small>${sh[k].toFixed(1)} sh</small><em>M${k + 1}</em></div>`).join('')}</div>
   <p class="lc-res">$100 a month bought <b>${tot.toFixed(1)} shares</b> at an average of <b>$${(600 / tot).toFixed(2)}</b> each, below the $${(px.reduce((x, y) => x + y, 0) / 6).toFixed(2)} average price. At the end they're worth ${$r(tot * 55)}, versus $660 if all $600 went in at month 1.</p>`;
  },
 },
 drawdown: {
  inputs: [['l', 'Your loss', 5, 90, 5, 50, '%']],
  out: ({ l }) => {
   const need = 1 / (1 - l / 100) - 1, yrs = Math.log(1 / (1 - l / 100)) / Math.log(1.08);
   return `<div class="lc-big">+${(need * 100).toFixed(0)}%</div><div class="lc-sub">gain needed just to get back to even</div>
   <div class="lc-bars">
    <div class="lc-barrow"><span class="lc-bt">Loss</span><span class="lc-bw"><i class="neg" style="width:${Math.min(100, l / (need * 100) * 100).toFixed(1)}%"></i></span><b>−${l}%</b></div>
    <div class="lc-barrow"><span class="lc-bt">Gain needed</span><span class="lc-bw"><i style="width:100%"></i></span><b>+${(need * 100).toFixed(0)}%</b></div>
   </div>
   <p class="lc-res">At 8% a year, that recovery takes about <b>${yrs.toFixed(1)} years</b>.</p>`;
  },
 },
 diversify: {
  inputs: [['n', 'Stocks you own', 1, 50, 1, 1, '']],
  out: ({ n }) => {
   const [lo, hi] = lcDiversify(n), sx = v => (Math.max(0, Math.min(1, (v + 0.8) / 1.6)) * 100).toFixed(1);
   return `<div class="lc-sub">Range of yearly returns in 9 out of 10 simulated years</div>
   <div class="lc-range"><span class="lc-zero" style="left:${sx(0)}%"></span><i style="left:${sx(lo)}%;width:${(sx(hi) - sx(lo)).toFixed(1)}%"></i></div>
   <div class="lc-range-l"><span>−80%</span><span>0%</span><span>+80%</span></div>
   <p class="lc-res">With ${n} stock${n > 1 ? 's' : ''}: from <b>${fmtSigned(lo, 0)}</b> to <b>${fmtSigned(hi, 0)}</b>. ${n === 1 ? 'One company can have a terrible year.' : n < 10 ? 'Already narrower.' : 'Most single-company risk is gone. What\'s left is the whole market\'s ups and downs.'}</p>`;
  },
 },
};
// Each simulated year: the market moves (16% swings) and each stock adds its own (30% swings)
let _divSim = null;
const _divCache = {};
function lcDiversify(n) {
 if (_divCache[n]) return _divCache[n];
 if (!_divSim) {
  const rnd = seededRand('diversify'), g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  _divSim = Array.from({ length: 1000 }, () => ({ m: g() * 0.16, s: Array.from({ length: 50 }, () => g() * 0.30) }));
 }
 const rets = _divSim.map(y => 0.08 + y.m + y.s.slice(0, n).reduce((a, b) => a + b, 0) / n).sort((a, b) => a - b);
 return (_divCache[n] = [rets[100], rets[899]]);
}
function lcCalcHTML(name) {
 const C = LC_CALCS[name]; if (!C) return '';
 return `<div class="lc-sliders">${C.inputs.map(([k, label, min, max, step, val]) => `<label class="lc-sl"><span>${label}</span><b data-v="${k}"></b><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}" oninput="lcCalcRun()"></label>`).join('')}</div><div class="lc-out"></div>`;
}
function lcCalcRun() {
 const box = document.querySelector('#lcWrap .lc-calc'); if (!box) return;
 const C = LC_CALCS[box.dataset.calc]; if (!C) return;
 const v = {};
 C.inputs.forEach(([k, , , , , , unit]) => {
  const inp = box.querySelector(`input[data-k="${k}"]`);
  v[k] = +inp.value;
  const shown = unit === '$' ? $r(v[k]) : `${v[k]}${unit}`;
  box.querySelector(`[data-v="${k}"]`).textContent = shown;
  inp.style.setProperty('--fill', `${((v[k] - inp.min) / (inp.max - inp.min) * 100).toFixed(1)}%`);
 });
 box.querySelector('.lc-out').innerHTML = C.out(v);
}

/* Live cards: real prices and company numbers */
const LC_METRICS = {
 pe: { name: 'P/E ratio', get: f => f?.trailingPE > 0 ? f.trailingPE : null, fmt: v => v.toFixed(1) },
 marketCap: { name: 'Market cap', get: f => f?.marketCap || null, fmt: fmtBig },
 profitMargin: { name: 'Profit margin', get: f => f?.profitMargin ?? null, fmt: v => pctTxt(v, 1) },
 revenueGrowth: { name: 'Revenue growth vs. a year ago', get: f => f?.revenueGrowth ?? null, fmt: v => fmtSigned(v, 1) },
 dividendYield: { name: 'Dividend yield', get: f => f?.price ? (f.dividendYield || 0) : null, fmt: v => pctTxt(v, 2) },
 upside: { name: 'Average analyst target vs. price', get: f => f?.targetMean > 0 && f?.price > 0 ? f.targetMean / f.price - 1 : null, fmt: v => fmtSigned(v, 1) },
 vol: { name: 'Yearly volatility', stats: true, get: (f, s) => s?.vol ?? null, fmt: v => pctTxt(v) },
 beta: { name: 'Beta', stats: true, get: (f, s) => s?.beta ?? null, fmt: v => v.toFixed(2) },
};
async function lcLive(card, i) {
 const el = () => (lcCurrent(i) ? document.getElementById('lcLive-' + i) : null);
 if (card.live === 'compare') {
  const M = LC_METRICS[card.metric], st = lcState(i, () => ({ guess: null }));
  const items = card.tickers.map(t => [t, tickerKind(t)]);
  const data = M.stats ? fetchStats(items) : fetchFacts(items);
  if (st.guess == null) {
   const e = el(); if (!e) return;
   e.innerHTML = `<div class="lc-chips lc-guess">${card.tickers.map(t => `<button type="button" class="lc-chip" onclick="lcGuess(${i},'${t}')"><b>${t}</b><small>${escapeHTML(tName(t))}</small></button>`).join('')}</div>`;
   return;
  }
  await data;
  const e = el(); if (!e) return;
  const vals = card.tickers.map(t => [t, M.get(factsFor(t), liveStats(t))]).filter(([, v]) => v != null && Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  if (vals.length < 2) return lcLiveFail(i);
  const top = vals[0][0], scale = Math.max(...vals.map(([, v]) => Math.abs(v))) || 1;
  e.innerHTML = `<div class="lc-bars">${vals.map(([t, v]) => `<div class="lc-barrow${t === st.guess ? ' mine' : ''}"><span class="lc-bt">${t}${t === st.guess ? ' <small>your pick</small>' : ''}</span><span class="lc-bw"><i class="${v < 0 ? 'neg' : ''}${t === top ? ' top' : ''}" style="width:${Math.max(2, Math.abs(v) / scale * 100).toFixed(1)}%"></i></span><b>${M.fmt(v)}</b></div>`).join('')}</div>
  <p class="quiz-why ${st.guess === top ? 'ok' : 'no'}"><b>${st.guess === top ? 'You got it.' : `It's ${escapeHTML(tName(top))}.`}</b> ${M.name}, live from Yahoo Finance.</p>`;
  return;
 }
 const t = card.ticker || 'SPY';
 const d = await getHistory(ySym(t, tickerKind(t)));
 const e = el(); if (!e) return;
 if (card.live === 'zoom') {
  const st = lcState(i, () => ({ r: '1M' })), N = { '1M': 21, '6M': 126, '1Y': 252, '5Y': d.c.length };
  const words = { '1M': 'the past month', '6M': 'the past 6 months', '1Y': 'the past year', '5Y': `the past ${Math.max(1, Math.round((d.t[d.t.length - 1] - d.t[0]) / 31557600))} years` };
  const c = d.c.slice(-Math.min(N[st.r], d.c.length)), ch = c[c.length - 1] / c[0] - 1;
  e.innerHTML = `<div class="lc-zoom-h"><b>${escapeHTML(tName(t))}</b><span class="${ch >= 0 ? 'up' : 'dn'}">${fmtSigned(ch, 1)}</span><small>over ${words[st.r]}</small></div>
  ${lcSpark(c, ch >= 0)}
  <div class="lc-seg" role="group" aria-label="Time range">${Object.keys(N).map(r => `<button type="button" class="${r === st.r ? 'on' : ''}" aria-pressed="${r === st.r}" onclick="lcZoomSet(${i},'${r}')">${r}</button>`).join('')}</div>`;
  return;
 }
 if (card.live === 'drawdown') {
  const c = d.c, ts = d.t; let pk = 0, best = { dd: 0, p: 0, tr: 0 };
  for (let k = 0; k < c.length; k++) { if (c[k] > c[pk]) pk = k; const dd = c[k] / c[pk] - 1; if (dd < best.dd) best = { dd, p: pk, tr: k }; }
  let rec = -1; for (let k = best.tr; k < c.length; k++) if (c[k] >= c[best.p]) { rec = k; break; }
  const dt = k => new Date(ts[k] * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const months = rec >= 0 ? Math.max(1, Math.round((ts[rec] - ts[best.tr]) / 2629800)) : 0;
  e.innerHTML = `${lcSpark(c, c[c.length - 1] >= c[0], (x, y) => `<rect x="${x(best.p)}" y="0" width="${Math.max(1, x(best.tr) - x(best.p))}" height="110" class="lc-dd-zone"/><circle cx="${x(best.p)}" cy="${y(c[best.p])}" r="4" class="lc-dd-pk"/><circle cx="${x(best.tr)}" cy="${y(c[best.tr])}" r="4" class="lc-dd-tr"/>`)}
  <p class="lc-res">Biggest fall: <b>${pctTxt(-best.dd)}</b>, from ${dt(best.p)} to ${dt(best.tr)}. ${rec >= 0 ? `It was back at that old high by ${dt(rec)}, about ${months} month${months > 1 ? 's' : ''} after the low.` : 'It hasn\'t gotten back to that high yet.'}</p>`;
  return;
 }
 if (card.live === 'bestdays') {
  const c = d.c, r = c.slice(1).map((v, k) => v / c[k] - 1), total = c[c.length - 1] / c[0] - 1;
  const best = r.map((_, k) => k).sort((a, b) => r[b] - r[a]), worst = r.map((_, k) => k).sort((a, b) => r[a] - r[b]).slice(0, 10);
  const without = n => { const skip = new Set(best.slice(0, n)); let g = 1; r.forEach((v, k) => { if (!skip.has(k)) g *= 1 + v; }); return g - 1; };
  const near = best.slice(0, 10).filter(k => worst.some(w => Math.abs(w - k) <= 10)).length;
  const yrs = Math.max(1, Math.round((d.t[d.t.length - 1] - d.t[0]) / 31557600));
  const st = lcState(i, () => ({ n: 10 }));
  st.bd = { total, without };
  e.innerHTML = `<label class="lc-sl"><span>Best days you missed</span><b data-bd></b><input type="range" min="0" max="30" step="1" value="${st.n}" oninput="lcBestSet(${i},this.value)"></label>
  <div class="lc-bars lc-bd-out"></div>
  <p class="lc-res">S&amp;P 500 (SPY) over the past ${yrs} years. ${near} of its 10 best days came within two weeks of one of its 10 worst days.</p>`;
  lcBestDraw(i);
 }
}
// Only the results redraw while the slider moves, so dragging it keeps working
function lcBestDraw(i) {
 const st = lcState(i, () => ({})), box = document.getElementById('lcLive-' + i);
 if (!st.bd || !box) return;
 const { total, without } = st.bd, miss = without(st.n), scale = Math.max(Math.abs(total), Math.abs(miss)) || 1;
 box.querySelector('[data-bd]').textContent = st.n;
 box.querySelector('input[type=range]').style.setProperty('--fill', `${(st.n / 30 * 100).toFixed(1)}%`);
 box.querySelector('.lc-bd-out').innerHTML = `
   <div class="lc-barrow"><span class="lc-bt">Stayed in</span><span class="lc-bw"><i class="${total < 0 ? 'neg' : ''}" style="width:${(Math.abs(total) / scale * 100).toFixed(1)}%"></i></span><b>${fmtSigned(total, 0)}</b></div>
   <div class="lc-barrow"><span class="lc-bt">Missed ${st.n}</span><span class="lc-bw"><i class="${miss < 0 ? 'neg' : ''}" style="width:${Math.max(1, Math.abs(miss) / scale * 100).toFixed(1)}%"></i></span><b>${fmtSigned(miss, 0)}</b></div>`;
}
function lcGuess(i, t) { const st = lcState(i, () => ({})); if (st.guess == null) { st.guess = t; const c = _lesson?.L.cards[i]; if (c) lcLive(c, i).catch(() => lcLiveFail(i)); } }
function lcZoomSet(i, r) { lcState(i, () => ({})).r = r; const c = _lesson?.L.cards[i]; if (c) lcLive(c, i).catch(() => lcLiveFail(i)); }
function lcBestSet(i, n) { lcState(i, () => ({})).n = +n; lcBestDraw(i); }
function lcSpark(c, up, extra) {
 const W = 300, H = 110, n = c.length, lo = Math.min(...c), hi = Math.max(...c);
 const x = k => +(k / Math.max(1, n - 1) * W).toFixed(1), y = v => +(H - 6 - (v - lo) / (hi - lo || 1) * (H - 12)).toFixed(1);
 const step = Math.max(1, Math.floor(n / 240)), pts = [];
 for (let k = 0; k < n; k += step) pts.push(`${x(k)},${y(c[k])}`);
 pts.push(`${x(n - 1)},${y(c[n - 1])}`);
 return `<svg class="lc-spark ${up ? 'up' : 'dn'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price chart">${extra ? extra(x, y) : ''}<polyline points="${pts.join(' ')}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}


function dashLineColors() {
 return theme === 'dark'
  ? { line: 'rgba(139,92,246,1)', top: 'rgba(139,92,246,0.24)', bottom: 'rgba(139,92,246,0)' }
  : { line: 'rgba(109,40,217,1)', top: 'rgba(109,40,217,0.14)', bottom: 'rgba(109,40,217,0)' };
}

function dashMini(containerId, symbol) {
 const c = dashLineColors();
 injectTV(containerId, {
  symbol, height: '100%', locale: 'en', dateRange: '1D', colorTheme: theme, isTransparent: true,
  autosize: true, largeChartUrl: '', chartOnly: false, noTimeScale: true,
  trendLineColor: c.line, underLineColor: c.top, underLineBottomColor: c.bottom,
 }, 'mini-symbol-overview');
}

function dashChart(containerId, symbol, name) {
 const c = dashLineColors();
 injectTV(containerId, {
  symbols: [[name, symbol + '|1D']], chartOnly: false, height: '100%', locale: 'en', colorTheme: theme, autosize: true,
  showVolume: false, showMA: false, hideDateRanges: false, hideMarketStatus: false, hideSymbolLogo: false,
  scalePosition: 'right', scaleMode: 'Normal', fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '10',
  noTimeScale: false, valuesTracking: '1', changeMode: 'price-and-percent', chartType: 'area', lineWidth: 2, lineType: 0,
  dateRanges: ['1d|1', '1w|15', '1m|30', '3m|60', '12m|1D', '60m|1W', 'all|1M'], isTransparent: true,
  lineColor: c.line, topColor: c.top, bottomColor: c.bottom, gridLineColor: 'rgba(0,0,0,0)',
  widgetFontColor: theme === 'dark' ? '#a4a4b4' : '#585869',
 }, 'symbol-overview');
}

function dashSelect(symbol, name, ticker, type, btn) {
 const stage = document.querySelector('.dash-stage');
 if (stage) ssTabSelect(stage, 0, false);
 document.querySelectorAll('.dash-tile').forEach(el => el.classList.toggle('on', !!btn && el === btn.parentElement));
 const nameEl = document.getElementById('dashChartName');
 if (nameEl) nameEl.textContent = name;
 const full = document.getElementById('dashFull');
 if (full) full.onclick = () => goAsset(ticker, type);
 dashChart('dashChart', symbol, name);
}


function renderHome(t) {
 setViewHead(null);
 // Guard: only render for market tabs
 const validTabs = ['s','i','c'];
 if (!validTabs.includes(t)) t = marketFilter || 's';
 if (isPhone()) { renderPhoneHome(t); return; }
 // Always restore the search bar when returning to home
 const _ss = document.getElementById('searchSection');
 if (_ss) _ss.style.display = 'block';

 showHomeSkeleton();
 fadeMainContent(() => {
 const ticker = dashPick[t] || {s:'AAPL', i:'SPX', c:'BTC'}[t] || 'AAPL';
 const sym = tvSym(ticker, t);
 const found = TICKERS.find(e => e.t === ticker);
 const displayName = found ? found.n : ticker;

 // Overview symbols are STRICTLY tab-specific — no mixing
 const ovSyms = {
 s: [{s:'NASDAQ:AAPL'},{s:'NASDAQ:TSLA'},{s:'NASDAQ:NVDA'},{s:'NASDAQ:MSFT'},{s:'NASDAQ:AMZN'},{s:'NASDAQ:META'}],
 i: [{s:'SP:SPX'},{s:'NASDAQ:IXIC'},{s:'DJ:DJI'},{s:'TVC:RUT'},{s:'TVC:VIX'},{s:'FOREXCOM:UKXGBP'}],
 c: [{s:'BITSTAMP:BTCUSD'},{s:'BITSTAMP:ETHUSD'},{s:'COINBASE:SOLUSD'},{s:'BINANCE:BNBUSDT'},{s:'BITSTAMP:XRPUSD'}],
 }[t];

 // Default main chart per tab — use correct type per tab
 const tickerType = t === 'c' ? 'c' : t === 'i' ? 'i' : 's';
 const defaultChartSym = tvSym(ticker, tickerType) || (t==='c' ? 'BITSTAMP:BTCUSD' : t==='i' ? 'SP:SPX' : 'NASDAQ:AAPL');

 const isSimple = false; // reading levels only change stock pages

 const ovLabel = {
 s: ' Top Movers — Stocks',
 i: ' Top Movers — Indexes',
 c: ' Top Movers — Crypto',
 }[t];

 const chartLabel = {
 s: isSimple ? 'Price Chart' : 'Live Chart',
 i: isSimple ? 'Index Chart' : 'Live Index Chart',
 c: isSimple ? 'Price Chart' : 'Live Chart',
 }[t];

 const uid = Date.now();
 const pinnedStocks = getPinnedStocks();
 const tiles = DASH_TILES[t];
 const userPick = dashPick[t] !== DASH_DEFAULT_PICK[t];
 const chartSym = userPick ? defaultChartSym : tiles[0][0];
 const chartName = userPick ? displayName : tiles[0][1];
 const chartTk = userPick ? ticker : tiles[0][2];
 const chartType = userPick ? tickerType : tiles[0][3];
 const popular = (t === 's' && pinnedStocks.length ? pinnedStocks.slice(0, 4).map(p => [tvSym(p.t, p.k), p.n, p.t, p.k]) : DASH_POPULAR[t]);
 const hr = new Date().getHours();
 const first = user?.name ? escapeHTML(user.name.split(' ')[0]) : '';
 const greet = (hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening') + (first ? `, ${first}` : '');
 const sub = { s: "Here's what's happening in the markets today.", i: "Here's how the world's major indexes are doing.", c: "Here's what crypto is doing today." }[t];
 const popTitle = { s: pinnedStocks.length ? 'Your pinned stocks' : 'Popular stocks', i: 'World markets', c: 'More coins' }[t];

 const mcHome = document.getElementById('mainContent');
 mcHome.dataset.view = 'home';
 mcHome.innerHTML = `
 <div class="dash-head">
 <h1>${greet}</h1>
 <p>${sub}</p>
 </div>

 <div class="dash-tiles">
 ${tiles.map(([s, n, tk, ty], i) => `
 <div class="dash-tile${s === chartSym ? ' on' : ''}">
 <div class="dash-tile-tv" id="dash-tile-${uid}-${i}"></div>
 <button type="button" class="dash-hit" aria-label="Show ${n} on the chart" onclick="dashSelect('${s}','${n}','${tk}','${ty}',this)"></button>
 </div>`).join('')}
 </div>

 <section class="card ss-tabs dash-stage" data-ss-group="home" data-ss-nosave="1">
 <div class="ss-tabs-bar" role="tablist">
 <button type="button" class="ss-tab on" role="tab" data-order="-1" aria-selected="true">Chart</button>
 <div class="dash-stage-actions">
 ${!isSimple ? `<button type="button" class="dash-btn" onclick="changeDashStock('${t}')">Change</button>` : ''}
 <button type="button" class="dash-btn dash-btn-main" id="dashFull" onclick="goAsset('${chartTk}','${chartType}')">Full analysis</button>
 </div>
 </div>
 <div class="ss-tabs-body">
 <div class="ss-panel on" role="tabpanel"><div id="dashChart" class="dash-chart"></div></div>
 </div>
 </section>

 <div class="dash-pop-wrap">
 <div class="dash-sec-h">
 <h2>${popTitle}</h2>
 ${t === 's' ? `<button type="button" class="rail-link" onclick="if(requireAuth('Custom Homepage'))toggleCustomizePanel()">${pinnedStocks.length ? 'Edit pins' : 'Pin your own'}</button>` : ''}
 </div>
 <div id="customizePanel" class="customize-panel" style="display:none">
 <div class="cp-title">Pin stocks to your Markets page</div>
 <div class="cp-sub">Pin up to 6 stocks. The first 4 show up here.</div>
 <div style="display:flex;gap:6px;flex-wrap:wrap" id="pinPickerChips">
 ${PICKS.s.concat(PICKS.c.slice(0,3)).map(t2=>{
 const f=TICKERS.find(e=>e.t===t2)||{t:t2,n:t2,k:'s'};
 const isPinned=pinnedStocks.some(p=>p.t===t2);
 return `<button class="pin-chip${isPinned?' pinned':''}" onclick="togglePin('${f.t}','${f.n}','${f.k}')">${f.t}</button>`;
 }).join('')}
 </div>
 <div style="margin-top:.875rem;display:flex;gap:6px">
 <button class="dash-btn dash-btn-main" onclick="toggleCustomizePanel()">Done</button>
 <button class="dash-btn" onclick="clearPins()">Clear all pins</button>
 </div>
 </div>
 <div class="dash-pop">
 ${popular.map(([s, n, tk, ty], i) => `
 <div class="dash-card">
 <div class="dash-card-tv" id="dash-pop-${uid}-${i}"></div>
 <button type="button" class="dash-hit" aria-label="Open ${escapeHTML(n)}" onclick="goAsset('${tk}','${ty}')"></button>
 </div>`).join('')}
 </div>
 </div>

 <section class="dash-learn">${learnRowHTML()}</section>
 <section class="dash-league" id="dashLeague"></section>

 <div class="card">
 <div class="card-hdr">
 <div class="card-hdr-title">Top movers today</div>
 <div class="card-hdr-sub">Biggest gainers and losers right now</div>
 </div>
 <div id="tv-ov-${uid}" class="ss-fill" style="height:420px"></div>
 </div>
 <div id="obChecklistWrap"></div>
 <div id="homeSections"></div>`;

 ssBindTabs(mcHome.querySelector('.dash-stage'));
 ssApplyTabGroups();

 setTimeout(() => {
 tiles.forEach(([s], i) => dashMini(`dash-tile-${uid}-${i}`, s));
 popular.forEach(([s], i) => dashMini(`dash-pop-${uid}-${i}`, s));
 dashChart('dashChart', chartSym, chartName);
 injectTV(`tv-ov-${uid}`, {
 colorTheme: theme, dateRange: '1D', exchange: 'US',
 showChart: true, locale: 'en', isTransparent: true,
 showSymbolLogo: true, showFloatingTooltip: false, width: '100%', height: '100%',
 plotLineColorGrowing: 'rgba(41,191,138,1)',
 plotLineColorFalling: 'rgba(241,53,53,1)',
 gridLineColor: 'rgba(240,243,250,0)',
 scaleFontColor: 'rgba(120,123,134,1)',
 belowLineFillColorGrowing: 'rgba(41,191,138,0.12)',
 belowLineFillColorFalling: 'rgba(241,53,53,0.12)',
 symbolActiveColor: 'rgba(41,191,138,0.12)',
 }, 'hotlists');
 }, 50);

 applyModeLabels();
 setTimeout(()=>{ renderHomeSections(t); ssApplyTabGroups(); staggerCards(document.getElementById('mainContent')); renderDashLeague(); }, 120);
 if (user) {
 setTimeout(() => {
 renderOnboardingChecklist('obChecklistWrap');
 checkMilestones();
 }, 200);
 }
 }); // end fadeMainContent
}

function changeDashStock(t) {
 const input = prompt(`Enter a ticker symbol to show on the ${t==='c'?'Crypto':t==='i'?'Index':'Stock'} dashboard (e.g. ${t==='c'?'ETH':t==='i'?'DJI':'TSLA'}):`);
 if (!input) return;
 const resolved = resolveQ(input.trim());
 dashPick[t] = resolved.t;
 renderHome(t);
}

/* ════════════════════════════════
 ASSET VIEW
════════════════════════════════ */
/* ════════════════════════════════
 STOCK PAGE
 One page, three reading levels. Beginner explains it like you've never invested,
 Intermediate shows the key numbers with what they mean, Advanced shows everything.
 Everything else on the site looks the same in every level.
════════════════════════════════ */
const jsq = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;');
const XP_HINT = { beginner: 'Simplest words, no jargon', mid: 'Key numbers, explained', advanced: 'Every number, no hand-holding' };
const rsLoading = msg => `<div class="rs-loading"><span class="fc-spark"></span><small>${msg || 'Loading real data'}</small></div>`;
const RS_ICON = {
 up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
 mid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
 down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>',
 check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
 warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/></svg>',
};

function renderAsset(ticker, name, type, overrideSym) {
 setViewHead(null);
 trackSearch(ticker);
 showAssetSkeleton();
 const dataP = loadResearch(ticker, type);
 fadeMainContent(() => {
  const xp = xpMode();
  const sym = overrideSym || tvSym(ticker, type);
  const c = { ticker, name, type, sym, xp };
  const mcEl = document.getElementById('mainContent');
  mcEl.dataset.view = 'asset';
  mcEl.innerHTML = assetHeadHTML(c) + `<div class="asset-work xp-${xp}">${assetStageHTML(c)}${assetSideHTML(c)}</div>`;
  mcEl.querySelectorAll('.asset-work > .ss-tabs').forEach(ssBindTabs);

  window.switchAssetTab = function(which) {
   const stage = document.querySelector('.asset-stage');
   if (!stage) return;
   const tabs = [...stage.querySelectorAll(':scope > .ss-tabs-bar > .ss-tab')];
   const i = which === 'predict' ? tabs.findIndex(b => b.id === 'atab-predict') : 0;
   ssTabSelect(stage, Math.max(0, i), false);
  };
  window._predictLoaded = false;
  document.getElementById('atab-predict')?.addEventListener('ss-show', () => {
   if (window._predictLoaded) return;
   window._predictLoaded = true;
   localStorage.setItem('ss_prediction_used_' + (user?.email || ''), '1');
   xp === 'beginner' ? renderKidForecast(ticker, name, type) : renderForecast(ticker, name, type);
  });

  setTimeout(() => {
   injectTV('tv-quote', { symbol: sym, colorTheme: theme, isTransparent: true, locale: 'en', autosize: true }, 'single-quote');
   if (xp === 'beginner') kidChart('tv-chart', sym, name);
   else injectTV('tv-chart', {
    autosize: true, symbol: sym, interval: chartInterval, timezone: 'Etc/UTC', theme, style: chartStyle, locale: 'en',
    toolbar_bg: theme === 'dark' ? '#16161c' : '#ffffff', enable_publishing: false, withdateranges: true,
    hide_side_toolbar: xp !== 'advanced' || innerWidth < 768, allow_symbol_change: false, save_image: false,
   }, 'advanced-chart');
   if (document.getElementById('tv-tech')) injectTV('tv-tech', { symbol: sym, showIntervalTabs: true, displayMode: 'multiple', width: '100%', height: '100%', locale: 'en', colorTheme: theme, isTransparent: true }, 'technical-analysis');
   injectTV('tv-asset-news', { feedMode: 'symbol', symbol: sym, isTransparent: true, displayMode: 'regular', width: '100%', height: '100%', locale: 'en', colorTheme: theme }, 'timeline');
  }, 50);

  setTimeout(() => {
   if (document.getElementById('pollContainer_' + ticker)) {
    renderPoll(ticker);
    const pdata = getPollData(ticker);
    if (pdata.myVote) syncVoteButtons(ticker, pdata.myVote);
    setTimeout(() => fitPollCard('pollContainer_' + ticker), 120);
   }
   renderAlertBadge(ticker);
   if (user && document.getElementById('alertSection_' + ticker)) renderAlertsSection('alertSection_' + ticker, ticker);
   if (typeof renderMarketSessionBadge === 'function') renderMarketSessionBadge('mktSessionBadge_' + ticker);
   fetchQuotes([[ticker, type]]).then(q => {
    const lp = q[ticker]?.price;
    if (!lp || currentAsset?.ticker !== ticker) return;
    const qw = document.querySelector('.asset-quick-wrap');
    if (qw) qw.innerHTML = quickTargetsHTML(ticker, lp);
   });
   setTimeout(() => { if (currentAsset?.ticker === ticker) getHistory(ySym(ticker, type)).catch(() => {}); }, 1500);
  }, 200);

  dataP.then(D => { if (currentAsset?.ticker === ticker) fillResearch(c, D); });

  currentAsset = { ticker, name, type };
  document.title = ticker + ' — ' + (name || ticker) + ' | StockSight';
  syncStockUrl(ticker);
  track('view_stock', { ticker });
  const chatBox = document.getElementById('chatBox');
  if (chatBox) chatBox.innerHTML = `<div class="chat-hello">${xp === 'beginner'
   ? `Hi! I can explain <strong>${escapeHTML(name)}</strong> in simple words. Tap a question below or type your own.`
   : xp === 'mid'
   ? `Ask me anything about <strong>${ticker}</strong>. Try <em>"Is it a good buy?"</em> or <em>"Is it expensive?"</em>`
   : `Ask about <strong>${ticker}</strong>: valuation, margins, estimates, analyst moves, risk.`}</div>`;
  checkAndAwardBadges();
 });
}

async function loadResearch(ticker, type) {
 const [F] = await Promise.all([
  getFundamentals(ticker, type),
  fetchStats([[ticker, type], ['SPX', 'i']]).catch(() => null),
  fetchQuotes([[ticker, type]]).catch(() => null),
 ]);
 const st = liveStats(ticker);
 const R = scoreAsset(ticker, F?.facts || factsFor(ticker), st);
 const P = R ? researchPoints(R) : { good: [], bad: [] };
 window._rs = { ticker, F, R, P };
 return { F, R, P, st };
}

function kidChart(id, sym, name) {
 const col = dashLineColors();
 injectTV(id, {
  symbols: [[name, sym + '|12M']], chartOnly: false, height: '100%', locale: 'en', colorTheme: theme, autosize: true,
  showVolume: false, showMA: false, hideDateRanges: false, hideMarketStatus: true, hideSymbolLogo: false,
  scalePosition: 'right', scaleMode: 'Normal', fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '12',
  noTimeScale: false, valuesTracking: '1', changeMode: 'price-and-percent', chartType: 'area', lineWidth: 3, lineType: 0,
  dateRanges: ['1m|30', '12m|1D', '60m|1W', 'all|1M'], isTransparent: true,
  lineColor: col.line, topColor: col.top, bottomColor: col.bottom, gridLineColor: 'rgba(0,0,0,0)',
  widgetFontColor: theme === 'dark' ? '#a4a4b4' : '#585869',
 }, 'symbol-overview');
}

/* ── Page frame ── */
function assetHeadHTML(c) {
 const { ticker, name, type, xp } = c;
 const isWl = watchlist.some(w => w.ticker === ticker);
 const typeLabel = xp === 'beginner' ? ({ s: 'Company', i: 'Market scoreboard', c: 'Digital coin' }[type] || 'Asset')
  : xp === 'mid' ? ({ s: 'Stock', i: 'Index', c: 'Crypto' }[type] || 'Asset') : ({ s: 'Equity', i: 'Index', c: 'Crypto' }[type] || 'Asset');
 const bc = { s: 'b-s', i: 'b-i', c: 'b-c' }[type] || 'b-s';
 const backQ = _lastSearchQuery ? jsq(_lastSearchQuery) : '';
 const savedBroker = localStorage.getItem('ss_broker_' + (user?.email || ''));
 const investLabel = xp === 'beginner' ? 'Buy for real' : savedBroker ? `Invest via ${BROKER_NAMES[savedBroker] || savedBroker}` : 'Invest now';
 const investClick = user ? `handleInvestNow('${ticker}','${type}')` : "requireAuth('Investing')";
 return `
 <header class="asset-top asset-head xp-${xp} ${type}">
  <div class="ah-id">
   <div class="ah-crumbs">
    <nav aria-label="Breadcrumb">
     <button type="button" onclick="goHome()">Markets</button>
     ${backQ ? `<span aria-hidden="true">/</span><button type="button" onclick="document.getElementById('si').value='${backQ}';onSearchInput('${backQ}');document.getElementById('si').focus()">Results for "${escapeHTML(_lastSearchQuery)}"</button>` : ''}
    </nav>
    <div class="xp-switch" role="group" aria-label="Explain this page for">${['beginner', 'mid', 'advanced'].map(x => `<button type="button" class="${x === xp ? 'on' : ''}" aria-pressed="${x === xp}" onclick="setXp('${x}')" title="${XP_HINT[x]}">${XP_LABEL[x]}</button>`).join('')}</div>
   </div>
   <div class="ah-title">${xp === 'beginner'
    ? `<span class="a-kidname">${escapeHTML(rsName(ticker, { name }))}</span><span class="a-kidtick">${ticker}</span>`
    : `<span class="live-dot"></span><span class="a-ticker">${ticker}</span><span class="a-name">${escapeHTML(name)}</span>`}</div>
   <div class="a-badges">
    <span class="badge ${bc}">${typeLabel}</span>
    ${type === 'c' ? `<span class="badge b-c">${xp === 'beginner' ? 'Trades all day, every day' : '24/7'}</span>` : ''}
    <span class="badge b-wl" id="wlBtn" onclick="toggleWL('${ticker}','${jsq(name)}','${type}')">${isWl ? ' Saved' : xp === 'beginner' ? '+ Save' : '+ Watchlist'}</span>
    <button type="button" class="badge b-share" onclick="shareStockCard('${ticker}','${type}')" aria-label="Share ${ticker} as an image"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>Share</button>
    <span id="mktSessionBadge_${ticker}" class="ah-session"></span>
   </div>
  </div>
  <div class="ah-quote" id="tv-quote"></div>
  <div class="ah-ai" id="rsHead">${[1, 2, 3].map(() => '<div class="ah-stat rs-skel"><span></span><b></b></div>').join('')}</div>
  <div class="ah-actions">
   <button class="pt-btn" onclick="openPtModal('${ticker}','${jsq(name)}')">${xp === 'beginner' ? 'Practice buying' : 'Paper trade'}</button>
   <button class="invest-btn" onclick="${investClick}">${investLabel}</button>
  </div>
 </header>`;
}

function assetStageHTML(c) {
 const { xp } = c;
 const tabs = xp === 'beginner'
  ? [['Price', 'price'], ['What could happen', 'predict'], ['What experts think', 'analysts'], ['News', 'news']]
  : (xp === 'mid'
  ? [['Chart', 'price'], ['Forecast', 'predict'], ['Valuation', 'dcf'], ['Stress test', 'stress'], ['Analysts', 'analysts'], ['Earnings', 'earnings'], ['Options', 'opts'], ['News', 'news']]
  : [['Chart', 'price'], ['Forecast', 'predict'], ['Valuation', 'dcf'], ['Stress test', 'stress'], ['Fundamentals', 'fund'], ['Analysts', 'analysts'], ['Earnings', 'earnings'], ['Options', 'opts'], ['News', 'news'], ['Technicals', 'tech']])
   .filter(([, k]) => !(['c', 'i'].includes(c.type) && (k === 'dcf' || k === 'opts')));
 const panel = k => ({
  price: '<div id="tv-chart" class="ss-fill"></div>',
  predict: '<div class="asset-forecast"><div id="predContent"></div></div>',
  analysts: `<div id="rsAnalysts" class="rs-pane">${rsLoading('Loading analyst ratings')}</div>`,
  earnings: `<div id="rsEarnings" class="rs-pane">${rsLoading('Loading earnings')}</div>`,
  fund: `<div id="rsFund" class="rs-pane">${rsLoading('Loading financials')}</div>`,
  news: '<div id="tv-asset-news" class="ss-fill"></div>',
  tech: '<div id="tv-tech" class="ss-fill"></div>',
  dcf: `<div id="rsDcf" class="rs-pane">${rsLoading('Building the valuation')}</div>`,
  stress: `<div id="rsStress" class="rs-pane">${rsLoading('Running the stress tests')}</div>`,
  opts: `<div id="rsOpts" class="rs-pane">${rsLoading('Reading the options market')}</div>`,
 }[k]);
 return `
  <section class="card ss-tabs asset-stage" data-ss-group="asset-main-${xp}" data-ss-nosave="1">
   <div class="ss-tabs-bar" role="tablist">${tabs.map(([l, k], i) => `<button type="button" class="ss-tab${i ? '' : ' on'}" role="tab"${k === 'predict' ? ' id="atab-predict"' : ''}>${l}</button>`).join('')}</div>
   <div class="ss-tabs-body">${tabs.map(([, k], i) => `<div class="ss-panel${i ? '' : ' on'}" role="tabpanel">${panel(k)}</div>`).join('')}</div>
  </section>`;
}

function assetSideHTML(c) {
 const { ticker, xp } = c;
 const tabs = xp === 'beginner'
  ? [['Should I buy it?', 'verdict'], ['What they do', 'about'], ['Ask a question', 'chat']]
  : xp === 'mid'
  ? [['Should you buy?', 'verdict'], ['Ask AI', 'chat'], ['About', 'about'], ['Community', 'poll'], ['Notes', 'notes'], ['Alerts', 'alerts']]
  : [['Analysis', 'verdict'], ['Risk', 'risk'], ['Ask AI', 'chat'], ['About', 'about'], ['Community', 'poll'], ['Notes', 'notes'], ['Alerts', 'alerts']];
 const chips = xp === 'beginner' ? [
  ['What does it do?', `what does ${ticker} do`], ['Is it a good buy?', `should I buy ${ticker}`], ['Is it risky?', `is ${ticker} risky`],
  ['Will it go up?', `will ${ticker} go up`], ['What do experts say?', `what do analysts say about ${ticker}`], ['What is a stock?', `what is a stock`],
 ] : xp === 'mid' ? [
  ['Is it a good buy?', `should I buy ${ticker}`], ['Is it expensive?', `is ${ticker} overvalued pe ratio`], ['Is it risky?', `is ${ticker} risky`],
  ['How are earnings?', `earnings revenue ${ticker}`], ['What do analysts say?', `what do analysts say about ${ticker}`], ['Does it pay dividends?', `dividend ${ticker}`],
  ['Bull case', `bull case ${ticker}`], ['Bear case', `bear case for ${ticker}`], ['Who runs it?', `who runs ${ticker}`],
 ] : [
  ['Valuation', `valuation pe ratio ${ticker}`], ['Margins and growth', `earnings revenue margins ${ticker}`], ['Analyst moves', `what do analysts say about ${ticker}`],
  ['Risk and beta', `volatility beta ${ticker}`], ['Bull case', `bull case ${ticker}`], ['Bear case', `bear case for ${ticker}`],
  ['Dividend', `dividend ${ticker}`], ['Leadership', `who runs ${ticker}`], ['Macro sensitivity', `interest rates inflation ${ticker}`],
 ];
 const panel = k => ({
  verdict: `<div id="rsVerdict" class="asset-pad rs-pane">${rsLoading('Checking the numbers')}</div>`,
  about: `<div id="rsAbout" class="asset-pad rs-pane">${rsLoading()}</div>`,
  risk: `<div id="rsRisk" class="asset-pad rs-pane">${rsLoading('Measuring risk')}</div>`,
  chat: `<div class="asset-chat">
     <div id="chatBox"></div>
     <div id="chatChips">${chips.map(([label, q]) => `<button class="chat-chip" onclick="askChip(this, this.dataset.q)" data-q="${q}">${label}</button>`).join('')}</div>
     <div class="asset-chat-input">
      <input id="chatIn" type="text" placeholder="${xp === 'beginner' ? 'Type a question in your own words' : 'Ask a custom question'}" onkeydown="if(event.key==='Enter')sendChat()"/>
      <button type="button" onclick="sendChat()">Send</button>
     </div>
    </div>`,
  poll: `<div class="card asset-poll" id="pollCard_${ticker}">
     <div class="card-hdr"><div class="card-hdr-title">Community poll</div><div class="card-hdr-sub">Anonymous. Tap to add your vote.</div></div>
     <div id="pollContainer_${ticker}" class="asset-pad"></div>
    </div>`,
  notes: `<div class="asset-pad asset-notes">
     <label for="noteArea_${ticker}">Private notes, saved to this browser</label>
     <textarea id="noteArea_${ticker}" class="note-area" placeholder="Price targets, your thesis, reminders...">${stockNotes[ticker] || ''}</textarea>
     <button type="button" class="dash-btn dash-btn-main" onclick="saveNote('${ticker}')">Save note</button>
    </div>`,
  alerts: `<div class="asset-pad asset-alerts">
     <label for="alertInp_${ticker}">Alert me when ${ticker} reaches</label>
     <div class="alert-row">
      <input id="alertInp_${ticker}" class="alert-inp" type="number" step="0.01" min="0" placeholder="e.g. 250.00" onkeydown="if(event.key==='Enter')saveAlert('${ticker}')"/>
      <button type="button" class="dash-btn dash-btn-main" onclick="saveAlert('${ticker}')">Set alert</button>
     </div>
     <div class="asset-quick-wrap">${quickTargetsHTML(ticker, livePrice(ticker))}</div>
     <div id="alertSection_${ticker}"></div>
     <p class="asset-hint">You'll get a heads-up in the app when ${ticker} is within 5% of a target, and an email once it crosses (checked every weekday after the market closes). Manage alerts in Settings, Notifications.</p>
    </div>`,
 }[k]);
 return `
  <section class="card ss-tabs asset-side" data-ss-group="asset-side-${xp}">
   <div class="ss-tabs-bar" role="tablist">${tabs.map(([l], i) => `<button type="button" class="ss-tab${i ? '' : ' on'}" role="tab">${l}</button>`).join('')}</div>
   <div class="ss-tabs-body">${tabs.map(([, k], i) => `<div class="ss-panel${i ? '' : ' on'}" role="tabpanel">${panel(k)}</div>`).join('')}</div>
  </section>`;
}

/* ── Fill the page once the real data is in ── */
function fillResearch(c, D) {
 const { ticker, name, type, xp } = c;
 const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
 const { F, R, P } = D;
 if (!R) {
  const retry = `<button type="button" class="dash-btn dash-btn-main" onclick="loadResearch('${ticker}','${type}').then(D=>fillResearch({ticker:'${ticker}',name:'${jsq(name)}',type:'${type}',xp:'${xp}'},D))">Try again</button>`;
  const msg = `<div class="rs-loading rs-err"><b>Couldn't load ${ticker}'s data</b><small>The market data service didn't respond. Check your connection and try again.</small>${retry}</div>`;
  ['rsVerdict', 'rsAnalysts', 'rsEarnings', 'rsFund', 'rsRisk', 'rsAbout', 'rsDcf', 'rsStress', 'rsOpts'].forEach(id => set(id, msg));
  set('rsHead', '');
  return;
 }
 set('rsHead', rsHeadHTML(R, F, xp));
 set('rsVerdict', rsVerdictHTML(R, P, F, xp));
 set('rsAnalysts', rsAnalystsHTML(R, F, xp));
 set('rsEarnings', rsEarningsHTML(R, F, xp));
 set('rsFund', rsFundHTML(R, F));
 set('rsRisk', rsRiskHTML(R, F));
 set('rsAbout', rsAboutHTML(R, F, xp, c));
 fillInsights(c, D);
 document.querySelectorAll('.rs-pane').forEach(p => { p.classList.remove('rs-in'); void p.offsetWidth; p.classList.add('rs-in'); });
}

function rsHeadHTML(R, F, xp) {
 const f = R.facts, st = R.stats, v = R.verdict, col = VERDICT_COLOR[v];
 const stat = (label, val, sub, style = '', extra = '') => `<div class="ah-stat"${extra}><span>${label}</span><b${style ? ` style="${style}"` : ''}>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
 if (xp === 'beginner') {
  const tr = F?.analysts?.trend?.[0];
  let experts = 'No experts yet', ecol = 'var(--text2)';
  if (tr) {
   const b = (tr.strongBuy || 0) + (tr.buy || 0), h = tr.hold || 0, s = (tr.sell || 0) + (tr.strongSell || 0);
   if (b + h + s) { [experts, ecol] = b >= h && b >= s ? ['Buy it', 'var(--green)'] : h >= s ? ['Wait', 'var(--gold)'] : ['Avoid', 'var(--red)']; }
  }
  const vol = st.vol;
  const ride = vol == null ? ['—', ''] : vol < 0.2 ? ['Smooth', 'var(--green)'] : vol < 0.4 ? ['Bumpy', 'var(--gold)'] : ['Wild ride', 'var(--red)'];
  const h = hundredThen(st);
  return stat('Experts say', experts, '', `color:${ecol}`)
   + stat('The ride', ride[0], vol != null ? `swings ~${pc0(vol)} a year` : '', `color:${ride[1]}`)
   + (h ? stat(`$100 from ${h.years} yr${h.years > 1 ? 's' : ''} ago`, `$${Math.round(h.value).toLocaleString()}`, 'is worth this today', `color:${h.value >= 100 ? 'var(--green)' : 'var(--red)'}`) : '');
 }
 if (xp === 'mid') {
  const up = f.targetMean && R.price ? f.targetMean / R.price - 1 : null;
  return stat('StockSight verdict', v, `${R.score}/100`, `color:${col}`, ` title="Scored from real fundamentals, analyst data and price action"`)
   + (up != null ? stat('Analyst target', fmtPx(f.targetMean), `${fmtSigned(up, 0)} from today`) : st.ret1y != null ? stat('Past year', fmtSigned(st.ret1y, 0), 'price change') : '')
   + (st.vol != null ? stat('Risk', st.vol >= 0.7 ? 'Very high' : st.vol >= 0.4 ? 'High' : st.vol >= 0.25 ? 'Moderate' : 'Lower', `swings ~${pc0(st.vol)} a year`, `color:${st.vol >= 0.7 ? 'var(--red)' : st.vol >= 0.4 ? 'var(--gold)' : 'var(--green)'}`) : '');
 }
 const short = v => v >= 1000 ? Math.round(v).toLocaleString() : v >= 10 ? Math.round(v) : v.toPrecision(3);
 const range = f.fiftyTwoWeekHigh && f.fiftyTwoWeekLow ? `${short(f.fiftyTwoWeekLow)}–${short(f.fiftyTwoWeekHigh)}` : '—';
 return stat('Score', `${R.score}`, v, `color:${col}`)
  + (f.marketCap ? stat('Mkt cap', fmtBig(f.marketCap)) : R.kind === 'fund' && f.fundAssets ? stat('Assets', fmtBig(f.fundAssets)) : stat('1y return', fmtSigned(st.ret1y, 0), 'vs S&P ' + fmtSigned(liveStats('SPX')?.ret1y, 0)))
  + (R.kind === 'fund' ? stat('Expense', fmtPlain(f.expenseRatio, 2), f.category || '') : stat('P/E', f.trailingPE ? f.trailingPE.toFixed(1) : '—', f.forwardPE ? `${f.forwardPE.toFixed(1)} fwd` : ''))
  + stat('52-wk', range, R.price && f.fiftyTwoWeekHigh ? `${fmtSigned(R.price / f.fiftyTwoWeekHigh - 1, 0)} off high` : '');
}

function rsVerdictHTML(R, P, F, xp) {
 const name = rsName(R.t, R.facts), col = VERDICT_COLOR[R.verdict];
 const updated = `Real data from Yahoo Finance, updated ${new Date(F?.asOf || Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. Not financial advice.`;
 if (xp === 'beginner') {
  const tone = R.verdict === 'Sell' ? 'bad' : R.verdict === 'Hold' ? 'meh' : 'good';
  return `
   <div class="kid-verdict v-${tone}">
    <span class="kid-badge">${RS_ICON[tone === 'good' ? 'up' : tone === 'meh' ? 'mid' : 'down']}</span>
    <div><small>Our answer</small><h3>${VERDICT_KID[R.verdict]}</h3><p>${verdictLine(R, P, 'beginner')}</p></div>
   </div>
   <section class="kid-card">
    <h4>Report card</h4>
    <ul class="kid-grades">${R.factors.map(fc => { const t = factorText(fc, R, 'beginner'), g = kidGrade(fc); return `<li><span class="kg kg-${g}">${g}</span><b>${t.name}</b><small>${fc.key === 'analysts' ? kidExpertsText(fc) : t.text}</small></li>`; }).join('')}</ul>
   </section>
   <div class="kid-two">
    ${P.good.length ? `<section class="kid-list good"><h4>${RS_ICON.check}Good things</h4><ul>${P.good.slice(0, 3).map(p => `<li>${p.kid}</li>`).join('')}</ul></section>` : ''}
    ${P.bad.length ? `<section class="kid-list bad"><h4>${RS_ICON.warn}Be careful</h4><ul>${P.bad.slice(0, 3).map(p => `<li>${p.kid}</li>`).join('')}</ul></section>` : ''}
   </div>
   <div class="kid-tip"><div><b>Try it with pretend money first</b><p>Practice buying ${escapeHTML(name)} with fake money and watch what happens. No risk at all.</p></div><button type="button" class="dash-btn dash-btn-main" onclick="openPtModal('${R.t}','${jsq(name)}')">Practice</button></div>
   <p class="rs-foot">This is a computer's best guess from real numbers, not advice. Never invest money you can't afford to lose.</p>`;
 }
 if (xp === 'mid') {
  const conf = R.confidence >= 70 ? 'High' : R.confidence >= 50 ? 'Medium' : 'Low';
  return `
   <div class="rs-verdict">
    <span class="lv-ring lv-ring-lg" style="--p:${R.score}"><b>${R.score}</b></span>
    <div><small>StockSight verdict</small><h3 style="color:${col}">${R.verdict}</h3><p>${verdictLine(R, P, 'mid')}</p><span class="rs-conf" title="How much of the data we could check, and how much it agrees">Confidence: ${conf}</span></div>
   </div>
   <section class="rs-sec"><h4>How it scores</h4>
    ${R.factors.map(fc => { const t = factorText(fc, R, 'mid'); return `<div class="rs-factor"><div class="rs-f-top"><b>${t.name}</b><span>${fc.score}</span></div><i><em style="width:${fc.score}%;background:${fc.score >= 67 ? 'var(--green)' : fc.score >= 45 ? 'var(--gold)' : 'var(--red)'}"></em></i><small>${t.text}</small></div>`; }).join('')}
   </section>
   <div class="rs-two">
    ${P.good.length ? `<section class="rs-sec rs-good"><h4>Reasons to like it</h4><ul>${P.good.slice(0, 4).map(p => `<li>${p.mid}</li>`).join('')}</ul></section>` : ''}
    ${P.bad.length ? `<section class="rs-sec rs-bad"><h4>Things to watch</h4><ul>${P.bad.slice(0, 4).map(p => `<li>${p.mid}</li>`).join('')}</ul></section>` : ''}
   </div>
   <section class="rs-sec"><h4>Key numbers <span class="rs-hint">hover for what each means</span></h4><div class="rs-keys">${rsKeyNumbers(R, F)}</div></section>
   <details class="rs-how"><summary>How we score this</summary><p>${rsMethod(R)}</p></details>
   <p class="rs-foot">${updated}</p>`;
 }
 return `
  <div class="rs-adv-head"><b style="color:${col}">${R.score}</b><div><span style="color:${col}">${R.verdict}</span><small>Composite of ${R.factors.length} factors · confidence ${R.confidence}%</small></div></div>
  <table class="rs-table"><thead><tr><th>Factor</th><th>Inputs</th><th>Wt</th><th>Score</th></tr></thead>
   <tbody>${R.factors.map(fc => `<tr><td>${fc.label}</td><td>${factorText(fc, R, 'mid').text}</td><td>${fc.weight}%</td><td><b style="color:${fc.score >= 67 ? 'var(--green)' : fc.score >= 45 ? 'var(--gold)' : 'var(--red)'}">${fc.score}</b></td></tr>`).join('')}</tbody>
  </table>
  <div class="rs-two">
   <section class="rs-sec rs-good"><h4>Bull</h4><ul>${P.good.map(p => `<li>${p.adv}</li>`).join('') || '<li>—</li>'}</ul></section>
   <section class="rs-sec rs-bad"><h4>Bear</h4><ul>${P.bad.map(p => `<li>${p.adv}</li>`).join('') || '<li>—</li>'}</ul></section>
  </div>
  <details class="rs-how"><summary>Method</summary><p>${rsMethod(R)}</p></details>
  <p class="rs-foot">${updated}</p>`;
}

// Beginners see the experts' vote itself, not the price-target math mixed in
function kidGrade(fc) {
 const m = fc.inputs?.recMean;
 if (fc.key !== 'analysts' || m == null) return rsGrade(fc.score);
 return m <= 1.8 ? 'A' : m <= 2.4 ? 'B' : m <= 3 ? 'C' : m <= 3.6 ? 'D' : 'F';
}
function kidExpertsText(fc) {
 const m = fc.inputs?.recMean;
 return m == null ? 'Experts are unsure' : m <= 1.8 ? 'Almost all experts say buy' : m <= 2.4 ? 'Most experts say buy' : m <= 3 ? 'Experts are split' : 'Most experts say wait or sell';
}

function rsMethod(R) {
 return R.kind === 'stock'
  ? 'Six factors, each scored 0 to 100 from live data: analyst ratings and price targets (25%), sales and profit growth (20%), margins, return on equity and free cash flow (20%), price compared with earnings (15%), debt and cash (10%), and the past year versus the S&P 500 (10%). 80+ is Strong Buy, 68+ Buy, 48+ Hold, below that Sell. Banks skip the debt test because borrowing is their business.'
  : R.kind === 'crypto'
  ? 'Coins have no sales or profits to check, so the score uses the past year versus the S&P 500, how much the price swings, and a fixed low score for having no business underneath. That caps crypto at Hold.'
  : 'Funds and indexes are scored on the past year versus the S&P 500, how much the price swings, diversification and yearly fees. The verdict is capped at Buy.';
}

function rsKeyNumbers(R, F) {
 const f = R.facts, st = R.stats;
 const k = (label, val, tip) => val && val !== '—' ? `<div class="rs-key" data-tip="${tip}" tabindex="0"><span>${label}</span><b>${val}</b></div>` : '';
 if (R.kind === 'fund') return k('Yearly fee', fmtPlain(f.expenseRatio, 2), 'The expense ratio: the share of your money the fund keeps each year to run itself.')
  + k('Category', f.category, 'The kind of investments this fund holds.')
  + k('Dividend yield', fmtPlain(f.dividendYield, 2), 'Cash paid out each year as a share of the price.')
  + k('Past year', fmtSigned(st.ret1y, 0), 'How much the price changed over the last 12 months.')
  + k('Price swings', st.vol != null ? `~${fmtPlain(st.vol, 0)}/yr` : '—', 'Volatility: how much the price usually moves in a year.');
 if (R.kind !== 'stock') return k('Market value', fmtBig(f.marketCap), 'The total value of every coin or share in existence.')
  + k('Past year', fmtSigned(st.ret1y, 0), 'How much the price changed over the last 12 months.')
  + k('Price swings', st.vol != null ? `~${fmtPlain(st.vol, 0)}/yr` : '—', 'Volatility: how much the price usually moves in a year. The S&P 500 is about 15%.')
  + k('Worst drop', fmtSigned(st.maxDD, 0), 'The biggest fall from a high point during the past year.')
  + k('5-yr growth', st.cagr != null ? `${fmtSigned(st.cagr, 0)}/yr` : '—', 'Average yearly price growth over the past five years.');
 return k('Market cap', fmtBig(f.marketCap), 'Market capitalization: what all of its shares are worth together.')
  + k('P/E ratio', f.trailingPE ? f.trailingPE.toFixed(1) : '—', 'Price ÷ yearly profit per share. How many dollars you pay for $1 of yearly profit. The S&P 500 average is around 20 to 25.')
  + k('Sales growth', fmtSigned(f.revenueGrowth, 0), 'How much more (or less) it sold than a year earlier.')
  + k('Profit margin', fmtPlain(f.profitMargin, 0), 'How many cents of every $1 in sales end up as profit.')
  + k('Dividend yield', f.dividendYield ? fmtPlain(f.dividendYield, 2) : 'None', 'Cash it pays shareholders each year, as a percent of the share price.')
  + k('Next earnings', f.nextEarnings ? fmtShortDay(f.nextEarnings) : '—', 'The date it next reports quarterly results. Prices often move a lot that day.')
  + k('Beta', f.beta5y != null ? f.beta5y.toFixed(2) : '—', 'How much it tends to move compared with the whole market. 1 = same as the market, 2 = twice as much.')
  + k('Debt to equity', f.debtToEquity != null ? (f.debtToEquity / 100).toFixed(2) : '—', 'How much it owes compared with what shareholders own. Lower is safer.');
}

function rsAnalystsHTML(R, F, xp) {
 const f = R.facts, name = rsName(R.t, f);
 const tr = F?.analysts?.trend?.[0];
 const total = tr ? ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((s, k) => s + (tr[k] || 0), 0) : 0;
 if (!total && !f.targetMean) {
  const why = R.kind === 'crypto' ? `Wall Street analysts don't rate coins like ${name}, so there are no expert ratings or price targets.`
   : R.kind === 'fund' ? `Analysts rate companies, not funds. ${name} simply follows what's inside it.`
   : R.kind === 'index' ? 'An index is a scoreboard of many companies, so analysts rate the companies inside it instead.'
   : `No Wall Street analysts publish ratings on ${name} right now.`;
  return `<div class="rs-empty"><b>${xp === 'beginner' ? 'No experts to ask here' : 'No analyst coverage'}</b><p>${why}</p></div>`;
 }
 const b = (tr?.strongBuy || 0) + (tr?.buy || 0), h = tr?.hold || 0, s = (tr?.sell || 0) + (tr?.strongSell || 0);
 const up = f.targetMean && R.price ? f.targetMean / R.price - 1 : null;
 if (xp === 'beginner') {
  const most = b >= h && b >= s ? ['Buy it', 'good'] : h >= s ? ['Wait and see', 'meh'] : ['Don\'t buy', 'bad'];
  const hi = Math.max(R.price || 0, f.targetMean || 0) || 1;
  return `
   <div class="kid-experts">
    <p class="kid-lead">We checked what <b>${total}</b> expert${total === 1 ? '' : 's'} who study ${escapeHTML(name)} for a living think.</p>
    <div class="kid-vote">
     ${b ? `<div class="kv good" style="flex:${b}"><b>${b}</b><span>say buy</span></div>` : ''}
     ${h ? `<div class="kv meh" style="flex:${h}"><b>${h}</b><span>say wait</span></div>` : ''}
     ${s ? `<div class="kv bad" style="flex:${s}"><b>${s}</b><span>say sell</span></div>` : ''}
    </div>
    <p class="kid-big">Most of them say: <b class="kv-${most[1]}">${most[0]}</b></p>
    ${f.targetMean && R.price ? `
    <div class="kid-target">
     <div><span>One share costs today</span><i><em style="width:${(R.price / hi * 100).toFixed(0)}%"></em></i><b>${fmtPx(R.price)}</b></div>
     <div><span>Experts guess it'll be worth in a year</span><i class="tgt"><em style="width:${(f.targetMean / hi * 100).toFixed(0)}%"></em></i><b>${fmtPx(f.targetMean)}</b></div>
    </div>
    <p class="kid-note">${Math.abs(up) < 0.03 ? 'That\'s about the same as today.' : up > 0 ? `That's ${pc0(up)} more than today.` : `That's ${pc0(up)} less than today.`}</p>` : ''}
    <p class="rs-foot">Experts are often wrong. Think of this as a hint, not a promise.</p>
   </div>`;
 }
 const seg = (n, cls, lbl) => n ? `<div class="ar-seg ${cls}" style="flex:${n}" title="${n} ${lbl}"><span>${n}</span></div>` : '';
 const lo = f.targetLow, hi = f.targetHigh, span = hi && lo ? Math.max(hi, R.price || hi) - Math.min(lo, R.price || lo) : 0, base = Math.min(lo || 0, R.price || lo || 0);
 const pos = v => span ? ((v - base) / span * 100).toFixed(1) : 50;
 const actions = (F?.analysts?.actions || []).filter(a => a.firm && a.to);
 const verb = a => ({ up: 'upgraded to', down: 'downgraded to', init: 'started at', main: 'kept', reit: 'reiterated' }[a.action] || 'rated');
 const ratingBlock = `
  <section class="rs-sec">
   <h4>Ratings from ${total} analysts <span class="rs-hint">consensus: ${recWord(f.recMean)}${f.recMean ? ` (${f.recMean.toFixed(1)} on a 1 to 5 scale)` : ''}</span></h4>
   <div class="ar-bar">${seg(tr?.strongBuy, 'sb', 'Strong Buy')}${seg(tr?.buy, 'b', 'Buy')}${seg(tr?.hold, 'h', 'Hold')}${seg(tr?.sell, 's', 'Sell')}${seg(tr?.strongSell, 'ss', 'Strong Sell')}</div>
   <div class="ar-legend"><span class="sb">Strong Buy</span><span class="b">Buy</span><span class="h">Hold</span><span class="s">Sell</span><span class="ss">Strong Sell</span></div>
  </section>`;
 const targetBlock = f.targetMean ? `
  <section class="rs-sec">
   <h4>12-month price targets</h4>
   <div class="at-range">
    <i style="left:${pos(lo)}%;right:${100 - pos(hi)}%"></i>
    <b class="at-mean" style="left:${pos(f.targetMean)}%" title="Average target ${fmtPx(f.targetMean)}"></b>
    ${R.price ? `<b class="at-now" style="left:${pos(R.price)}%" title="Price now ${fmtPx(R.price)}"></b>` : ''}
   </div>
   <div class="at-labels"><span>Low ${fmtPx(lo)}</span><span>Average ${fmtPx(f.targetMean)}${up != null ? ` <em class="${up >= 0 ? 'up' : 'down'}">${fmtSigned(up, 1)}</em>` : ''}</span><span>High ${fmtPx(hi)}</span></div>
   ${xp === 'mid' ? `<p class="rs-explain">Analysts are researchers at banks and brokers. A price target is where they think the stock will be in about a year. They're often wrong, so the average and the range matter more than any one number.</p>` : ''}
  </section>` : '';
 if (xp === 'mid') return ratingBlock + targetBlock + (actions.length ? `
  <section class="rs-sec"><h4>Latest analyst moves</h4>
   <ul class="ar-moves">${actions.slice(0, 5).map(a => `<li><span>${fmtShortDay(a.date)}</span><b>${escapeHTML(a.firm)}</b> ${verb(a)} ${escapeHTML(a.to)}${a.target ? `, target ${a.priorTarget && a.priorTarget !== a.target ? `${fmtPx(a.priorTarget)} → ` : ''}${fmtPx(a.target)}` : ''}</li>`).join('')}</ul>
  </section>` : '');
 const trend = F?.analysts?.trend || [];
 return ratingBlock + targetBlock + `
  ${trend.length > 1 ? `<section class="rs-sec"><h4>Rating trend</h4>
   <table class="rs-table rs-compact"><thead><tr><th>Month</th><th>Strong Buy</th><th>Buy</th><th>Hold</th><th>Sell</th><th>Strong Sell</th></tr></thead>
   <tbody>${trend.map(x => `<tr><td>${x.period === '0m' ? 'Now' : x.period.replace('-', '').replace('m', ' mo ago')}</td><td>${x.strongBuy ?? '—'}</td><td>${x.buy ?? '—'}</td><td>${x.hold ?? '—'}</td><td>${x.sell ?? '—'}</td><td>${x.strongSell ?? '—'}</td></tr>`).join('')}</tbody></table>
  </section>` : ''}
  ${actions.length ? `<section class="rs-sec"><h4>Upgrades and downgrades</h4>
   <table class="rs-table rs-compact"><thead><tr><th>Date</th><th>Firm</th><th>Action</th><th>Rating</th><th>Target</th></tr></thead>
   <tbody>${actions.map(a => `<tr><td>${fmtShortDay(a.date)}</td><td>${escapeHTML(a.firm)}</td><td class="ac-${a.action}">${{ up: 'Upgrade', down: 'Downgrade', init: 'Initiate', main: 'Maintain', reit: 'Reiterate' }[a.action] || a.action || '—'}</td><td>${a.from && a.from !== a.to ? `${escapeHTML(a.from)} → ` : ''}${escapeHTML(a.to)}</td><td>${a.target ? `${a.priorTarget && a.priorTarget !== a.target ? `${fmtPx(a.priorTarget)} → ` : ''}${fmtPx(a.target)}` : '—'}</td></tr>`).join('')}</tbody></table>
  </section>` : ''}`;
}

function rsEarningsHTML(R, F, xp) {
 const f = R.facts, E = F?.earnings || {};
 if (R.kind === 'fund') {
  const H = F?.fund?.holdings || [];
  return `<div class="rs-empty"><b>Funds don't report earnings</b><p>A fund's results come from the companies it owns.${H.length ? ' Its biggest holdings:' : ''}</p></div>${H.length ? `<ul class="rs-holdings">${H.map(h => `<li><button type="button" onclick="goAsset('${jsq(h.symbol)}','s')">${escapeHTML(h.symbol || '')}</button><span>${escapeHTML(h.name || '')}</span><b>${fmtPlain(h.pct)}</b></li>`).join('')}</ul>` : ''}`;
 }
 if (R.kind !== 'stock' || (!E.history?.length && !f.nextEarnings)) return `<div class="rs-empty"><b>No earnings reports</b><p>${R.kind === 'crypto' ? 'Coins aren\'t companies, so they never report sales or profit.' : R.kind === 'index' ? 'Indexes don\'t report earnings; the companies inside them do.' : 'No earnings data is available for this company yet.'}</p></div>`;
 const hist = (E.history || []).slice(-4);
 const mx = Math.max(...hist.flatMap(h => [Math.abs(h.actual || 0), Math.abs(h.estimate || 0)]), 0.01);
 const q = ts => { const d = new Date(ts * 1000); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${String(d.getUTCFullYear()).slice(2)}`; };
 const next = f.nextEarnings ? `
  <section class="rs-sec rs-next"><div><small>Next report</small><b>${fmtDay(f.nextEarnings)}</b><span>in ${Math.max(0, Math.round((f.nextEarnings * 1000 - Date.now()) / 86400000))} days</span></div>
   ${f.nextEpsEstimate != null ? `<div><small>Expected profit per share</small><b>$${f.nextEpsEstimate.toFixed(2)}</b><span>analyst average</span></div>` : ''}
  </section>` : '';
 const bars = hist.length ? `
  <section class="rs-sec"><h4>Profit per share vs. what analysts expected</h4>
   <div class="eb-chart">${hist.map(h => { const beat = h.actual >= h.estimate; return `<div class="eb-col"><div class="eb-bars"><i class="eb-est" style="height:${(Math.abs(h.estimate) / mx * 100).toFixed(0)}%" title="Expected $${h.estimate?.toFixed(2)}"></i><i class="eb-act ${beat ? 'beat' : 'miss'}" style="height:${(Math.abs(h.actual) / mx * 100).toFixed(0)}%" title="Actual $${h.actual?.toFixed(2)}"></i></div><b class="${beat ? 'up' : 'down'}">${beat ? 'Beat' : 'Miss'} ${fmtSigned(h.surprisePct, 1)}</b><span>${q(h.quarter)}</span></div>`; }).join('')}</div>
   <div class="eb-legend"><span><i class="eb-est"></i>Expected</span><span><i class="eb-act beat"></i>Actual</span></div>
   ${xp === 'mid' ? '<p class="rs-explain">EPS (earnings per share) is the company\'s profit divided by its number of shares. Beating the estimate means it earned more than Wall Street expected, which often lifts the price.</p>' : ''}
  </section>` : '';
 const yearly = (E.yearly || []).filter(y => y.revenue);
 const ymax = Math.max(...yearly.map(y => y.revenue), 1);
 const years = yearly.length ? `
  <section class="rs-sec"><h4>Yearly sales and profit</h4>
   <div class="ey-chart">${yearly.map(y => `<div class="ey-col"><div class="ey-bars"><i class="ey-rev" style="height:${(y.revenue / ymax * 100).toFixed(0)}%" title="Sales ${fmtBig(y.revenue)}"></i><i class="ey-earn" style="height:${(Math.max(0, y.earnings || 0) / ymax * 100).toFixed(0)}%" title="Profit ${fmtBig(y.earnings)}"></i></div><b>${fmtBig(y.revenue)}</b><span>${y.date}</span></div>`).join('')}</div>
   <div class="eb-legend"><span><i class="ey-rev"></i>Sales</span><span><i class="ey-earn"></i>Profit</span></div>
  </section>` : '';
 const est = xp === 'advanced' && E.estimates?.length ? `
  <section class="rs-sec"><h4>Consensus estimates</h4>
   <table class="rs-table rs-compact"><thead><tr><th>Period</th><th>EPS</th><th>Range</th><th>Revenue</th><th>Growth</th><th>#</th></tr></thead>
   <tbody>${E.estimates.map(e => `<tr><td>${{ '0q': 'This qtr', '+1q': 'Next qtr', '0y': 'This FY', '+1y': 'Next FY' }[e.period] || e.period}${e.endDate ? ` <small>${e.endDate.slice(0, 7)}</small>` : ''}</td><td>${e.eps != null ? '$' + e.eps.toFixed(2) : '—'}</td><td>${e.epsLow != null ? `$${e.epsLow.toFixed(2)}–$${e.epsHigh.toFixed(2)}` : '—'}</td><td>${fmtBig(e.revenue)}</td><td>${fmtSigned(e.growth, 1)}</td><td>${e.analysts ?? '—'}</td></tr>`).join('')}</tbody></table>
  </section>` : '';
 return next + bars + years + est;
}

function rsFundHTML(R, F) {
 const f = R.facts, st = R.stats;
 const row = (l, v) => `<div><span>${l}</span><b>${v ?? '—'}</b></div>`;
 const grp = (title, rows) => `<section class="rs-sec fd-grp"><h4>${title}</h4><div class="fd-grid">${rows.join('')}</div></section>`;
 if (R.kind === 'fund') {
  const H = F?.fund?.holdings || [], S = F?.fund?.sectors || [];
  return grp('Fund', [row('Category', f.category), row('Expense ratio', fmtPlain(f.expenseRatio, 2)), row('Assets', fmtBig(f.fundAssets)), row('Yield', fmtPlain(f.dividendYield, 2)), row('Family', F?.profile?.family), row('Beta (5y)', f.beta5y?.toFixed(2))])
   + (H.length ? `<section class="rs-sec"><h4>Top holdings</h4><ul class="rs-holdings">${H.map(h => `<li><button type="button" onclick="goAsset('${jsq(h.symbol)}','s')">${escapeHTML(h.symbol || '')}</button><span>${escapeHTML(h.name || '')}</span><b>${fmtPlain(h.pct)}</b></li>`).join('')}</ul></section>` : '')
   + (S.length ? `<section class="rs-sec"><h4>Sector weights</h4><ul class="rs-holdings">${S.filter(x => x.pct > 0.005).sort((a, b) => b.pct - a.pct).map(x => `<li><span>${x.sector.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase())}</span><b>${fmtPlain(x.pct)}</b></li>`).join('')}</ul></section>` : '');
 }
 if (R.kind !== 'stock') return grp('Market', [row('Market cap', fmtBig(f.marketCap)), row('52-wk high', fmtPx(f.fiftyTwoWeekHigh)), row('52-wk low', fmtPx(f.fiftyTwoWeekLow)), row('1y return', fmtSigned(st.ret1y)), row('Volatility', fmtPlain(st.vol, 0)), row('5y CAGR', fmtSigned(st.cagr))]) + `<div class="rs-empty"><p>${R.kind === 'crypto' ? 'Coins have no income statement or balance sheet.' : 'Indexes have no company financials of their own.'}</p></div>`;
 const fcf = f.fcfReported ?? f.freeCashflow, fcfm = fcf != null && f.revenue ? fcf / f.revenue : null;
 return `<div class="fd-wrap">
  ${grp('Valuation', [row('P/E (ttm)', f.trailingPE?.toFixed(1)), row('P/E (fwd)', f.forwardPE?.toFixed(1)), row('PEG', f.peg?.toFixed(2)), row('P/S', f.priceToSales?.toFixed(1)), row('P/B', f.priceToBook?.toFixed(1)), row('EV/EBITDA', f.evToEbitda?.toFixed(1)), row('EV/Revenue', f.evToRevenue?.toFixed(1)), row('Mkt cap', fmtBig(f.marketCap))])}
  ${grp('Profitability', [row('Gross margin', fmtPlain(f.grossMargin)), row('Operating margin', fmtPlain(f.operatingMargin)), row('Net margin', fmtPlain(f.profitMargin)), row('ROE', fmtPlain(f.roe)), row('ROA', fmtPlain(f.roa)), row('FCF margin', fmtPlain(fcfm))])}
  ${grp('Growth', [row('Revenue y/y', fmtSigned(f.revenueGrowth)), row('Earnings y/y', fmtSigned(f.earningsGrowth)), row('Revenue (ttm)', fmtBig(f.revenue)), row('EPS (ttm)', f.trailingEps != null ? '$' + f.trailingEps.toFixed(2) : '—'), row('EPS (fwd)', f.forwardEps != null ? '$' + f.forwardEps.toFixed(2) : '—')])}
  ${grp('Balance sheet and cash', [row('Cash', fmtBig(f.totalCash)), row('Debt', fmtBig(f.totalDebt)), row('Debt/Equity', f.debtToEquity != null ? (f.debtToEquity / 100).toFixed(2) : '—'), row('Current ratio', f.currentRatio?.toFixed(2)), row('Operating CF', fmtBig(f.operatingCashflow)), row('Free cash flow', fmtBig(f.fcfReported ?? f.freeCashflow))])}
  ${grp('Dividends and ownership', [row('Yield', f.dividendYield ? fmtPlain(f.dividendYield, 2) : 'None'), row('Annual dividend', f.dividendRate ? '$' + f.dividendRate.toFixed(2) : '—'), row('Payout ratio', fmtPlain(f.payoutRatio, 0)), row('Institutions', fmtPlain(f.institutionsPct, 0)), row('Insiders', fmtPlain(f.insidersPct, 1)), row('Short % float', fmtPlain(f.shortPctFloat, 1))])}
 </div>`;
}

function rsRiskHTML(R, F) {
 const f = R.facts, st = R.stats, sp = liveStats('SPX');
 const row = (l, v, tip) => `<div${tip ? ` title="${tip}"` : ''}><span>${l}</span><b>${v ?? '—'}</b></div>`;
 const pos52 = f.fiftyTwoWeekHigh && f.fiftyTwoWeekLow && R.price ? (R.price - f.fiftyTwoWeekLow) / (f.fiftyTwoWeekHigh - f.fiftyTwoWeekLow) : null;
 return `
  <section class="rs-sec fd-grp"><h4>Volatility and market link</h4><div class="fd-grid">
   ${row('Volatility (1y)', fmtPlain(st.vol, 1), 'Annualised standard deviation of daily returns')}
   ${row('vs S&P 500', st.vol != null && sp?.vol ? (st.vol / sp.vol).toFixed(2) + 'x' : '—')}
   ${row('Beta (2y wkly, adj)', st.beta?.toFixed(2), 'Weekly returns vs the S&P 500, Bloomberg-adjusted')}
   ${row('Beta (5y mthly)', f.beta5y?.toFixed(2), 'Yahoo Finance')}
   ${row('Correlation', st.corr?.toFixed(2))}
   ${row('Max drawdown (1y)', fmtSigned(st.maxDD, 1))}
  </div></section>
  <section class="rs-sec fd-grp"><h4>Returns and trend</h4><div class="fd-grid">
   ${row('1y return', fmtSigned(st.ret1y, 1))}
   ${row('S&P 500 1y', fmtSigned(sp?.ret1y, 1))}
   ${row(`CAGR (${st.years ? Math.round(st.years) : 5}y)`, fmtSigned(st.cagr, 1))}
   ${row('RSI (14)', st.rsi?.toFixed(0))}
   ${row('vs 50-day avg', f.fiftyDayAvg && R.price ? fmtSigned(R.price / f.fiftyDayAvg - 1, 1) : '—')}
   ${row('vs 200-day avg', f.twoHundredDayAvg && R.price ? fmtSigned(R.price / f.twoHundredDayAvg - 1, 1) : '—')}
  </div></section>
  <section class="rs-sec fd-grp"><h4>Positioning</h4><div class="fd-grid">
   ${row('52-wk range', f.fiftyTwoWeekLow ? `${fmtPx(f.fiftyTwoWeekLow)}–${fmtPx(f.fiftyTwoWeekHigh)}` : '—')}
   ${row('Position in range', pos52 != null ? fmtPlain(pos52, 0) : '—')}
   ${row('Short % float', fmtPlain(f.shortPctFloat, 1))}
   ${row('Institutions', fmtPlain(f.institutionsPct, 0))}
  </div></section>
  <p class="rs-foot">Volatility, beta, drawdown and CAGR are computed by StockSight from daily closes; the rest is from Yahoo Finance.</p>`;
}

function rsAboutHTML(R, F, xp, c) {
 const f = R.facts, p = F?.profile || {}, name = rsName(R.t, f), st = R.stats;
 const sentences = (p.summary || '').match(/[^.!?]+[.!?]+/g) || [];
 const place = [p.city, p.state || p.country].filter(Boolean).join(', ');
 const similar = getSimilar(R.t);
 const gfT = c.type === 'c' ? R.t + '-USD' : R.t;
 const links = R.kind === 'stock' ? [
  ['Annual report (10-K)', `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${R.t}&type=10-K&dateb=&owner=include&count=5`],
  ['Financial statements', `https://finance.yahoo.com/quote/${R.t}/financials/`],
  ['Analyst estimates', `https://finance.yahoo.com/quote/${R.t}/analysis/`],
  ['Google Finance', `https://www.google.com/finance/quote/${gfT}`],
 ] : [['Yahoo Finance', `https://finance.yahoo.com/quote/${ySym(R.t, c.type)}`], ['Google Finance', `https://www.google.com/finance/quote/${gfT}`]];
 if (xp === 'beginner') {
  const h = hundredThen(st);
  const what = R.kind === 'crypto' ? `${name} is digital money that lives on the internet. No company owns it, and nobody prints it. People buy and sell it with each other${p.startDate ? `, and it has been around since ${p.startDate.slice(0, 4)}` : ''}.`
   : R.kind === 'fund' ? `${name} is a fund, like a basket. When you buy one share, you get a tiny piece of lots of companies at once${F?.fund?.holdings?.length ? `, including ${F.fund.holdings.slice(0, 3).map(x => rsName(x.symbol, { name: x.name })).join(', ')}` : ''}.`
   : R.kind === 'index' ? `${name} is a scoreboard. It shows how a big group of companies is doing all together. You can't buy the scoreboard itself, but you can buy a fund that copies it, like ${INDEX_ETF[R.t] || 'an index fund'}.`
   : (sentences[0] || `${name} is a company you can own a piece of.`).replace(/^([A-Z][\w.&'\- ]+?)(,)? (Inc\.|Corporation|Corp\.|Co\.|Ltd\.)/, '$1');
  return `
   <div class="kid-about">
    <p class="kid-what">${escapeHTML(what)}</p>
    <ul class="kid-facts">
     ${place && R.kind === 'stock' ? `<li><span>Where it's based</span><b>${escapeHTML(place)}</b></li>` : ''}
     ${p.employees ? `<li><span>People who work there</span><b>${p.employees.toLocaleString()}</b></li>` : ''}
     ${f.marketCap ? `<li><span>What the whole thing is worth</span><b>${fmtBig(f.marketCap)}</b></li>` : ''}
     ${h ? `<li><span>If you put in $100 ${h.years} year${h.years > 1 ? 's' : ''} ago</span><b class="${h.value >= 100 ? 'up' : 'down'}">you'd have $${Math.round(h.value).toLocaleString()}</b></li>` : ''}
     ${f.dividendYield ? `<li><span>Pays you just for owning it</span><b>about $${(f.dividendYield * 100).toFixed(2)} a year per $100</b></li>` : ''}
    </ul>
    <div class="kid-word"><b>What's a ${R.kind === 'crypto' ? 'coin' : R.kind === 'fund' ? 'fund' : 'stock'}?</b><p>${R.kind === 'crypto' ? 'A coin is a kind of digital money. Its price goes up when more people want it and down when fewer do.' : R.kind === 'fund' ? 'A fund collects money from lots of people and buys many different stocks with it, so you own a little of everything inside.' : 'A stock is a tiny piece of a company. If the company does well, your piece is usually worth more. If it does badly, your piece is worth less.'}</p></div>
   </div>`;
 }
 const facts = [
  ['Sector', f.sector], ['Industry', f.industry], ['Category', f.category], ['Headquarters', place || null],
  ['Employees', p.employees ? p.employees.toLocaleString() : null], ['Exchange', f.exchange], ['Fund family', p.family],
  ['Website', p.website ? `<a href="${escapeHTML(p.website)}" target="_blank" rel="noopener">${escapeHTML(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : null],
 ].filter(([, v]) => v);
 const summary = xp === 'advanced' ? sentences.join(' ') : sentences.slice(0, 3).join(' ');
 const officers = xp === 'advanced' && p.officers?.length ? `
  <section class="rs-sec"><h4>Leadership</h4><table class="rs-table rs-compact"><thead><tr><th>Name</th><th>Role</th><th>Age</th><th>Pay</th></tr></thead>
   <tbody>${p.officers.map(o => `<tr><td>${escapeHTML((o.name || '').replace(/^(Mr\.|Ms\.|Mrs\.|Dr\.)\s+/, ''))}</td><td>${escapeHTML(o.title || '')}</td><td>${o.age ?? '—'}</td><td>${o.pay ? fmtBig(o.pay) : '—'}</td></tr>`).join('')}</tbody></table></section>`
  : xp === 'mid' && p.officers?.length ? `<section class="rs-sec"><h4>Who runs it</h4><ul class="rs-people">${p.officers.slice(0, 3).map(o => `<li><b>${escapeHTML((o.name || '').replace(/^(Mr\.|Ms\.|Mrs\.|Dr\.)\s+/, ''))}</b><span>${escapeHTML(o.title || '')}</span></li>`).join('')}</ul></section>` : '';
 return `
  ${summary ? `<p class="asset-desc">${escapeHTML(summary)}</p>` : ''}
  <div class="rs-facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${String(v).startsWith('<a') ? v : escapeHTML(String(v))}</b></div>`).join('')}</div>
  ${officers}
  <div class="asset-links">${links.map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener noreferrer"><b>${l}</b><span>Opens in a new tab</span></a>`).join('')}</div>
  ${similar.length ? `<div class="asset-similar"><span>Similar</span>${similar.map(t2 => `<button class="sh-chip" onclick="goAsset('${t2}','s')">${t2}</button>`).join('')}</div>` : ''}`;
}

/* ── Beginner forecast: one year, three outcomes, plain words ── */
async function renderKidForecast(ticker, name, type) {
 const el = document.getElementById('predContent');
 if (!el) return;
 el.innerHTML = rsLoading(`Looking at how ${escapeHTML(rsName(ticker, { name }))}'s price moved before`);
 try {
  const sym = ySym(ticker, type);
  const [hist, mkt] = await Promise.all([getHistory(sym), sym === '^GSPC' ? Promise.resolve(null) : getHistory('^GSPC').catch(() => null)]);
  if (currentAsset?.ticker !== ticker || !document.body.contains(el)) return;
  const R = fcCompute(hist, mkt, sym, type === 'c', sym + new Date().toISOString().slice(0, 10));
  window._fc = { R, ticker, hz: 4 };
  const h = R.horizons[4], nm = escapeHTML(rsName(ticker, { name }));
  const lo = h.p10, hi = h.p90, span = hi - lo || 1, pos = v => ((v - lo) / span * 100).toFixed(1);
  el.innerHTML = `
   <div class="kid-fc">
    <p class="kid-lead">We looked at how ${nm}'s price went up and down over the last ${Math.max(1, Math.round(R.stats.years))} years and imagined thousands of possible next years. Here's what usually happened:</p>
    <div class="kid-fc-cards">
     <div class="kfc bad"><span>A bad year</span><b>${fmtPx(lo)}</b><small>${fmtSigned(lo / R.price - 1, 0)}</small></div>
     <div class="kfc mid"><span>A normal year</span><b>${fmtPx(h.p50)}</b><small>${fmtSigned(h.p50 / R.price - 1, 0)}</small></div>
     <div class="kfc good"><span>A great year</span><b>${fmtPx(hi)}</b><small>${fmtSigned(hi / R.price - 1, 0)}</small></div>
    </div>
    <div class="kid-fc-line"><i></i><b style="left:${pos(R.price)}%"><span>Today ${fmtPx(R.price)}</span></b></div>
    <p class="kid-big">In about <b>${Math.round(h.pUp * 10)} out of 10</b> of those imagined years, the price ended higher than today.</p>
    <p class="rs-foot">Nobody can see the future. This is a guess based on the past, and the real price can land outside these numbers.</p>
   </div>`;
 } catch {
  el.innerHTML = `<div class="rs-loading rs-err"><b>Couldn't load the price history</b><small>Check your connection and try again.</small><button type="button" class="dash-btn dash-btn-main" onclick="renderKidForecast('${ticker}','${jsq(name)}','${type}')">Try again</button></div>`;
 }
}


/* ════════════════════════════════
 TV WIDGET INJECTOR
════════════════════════════════ */
function injectTV(containerId, config, widgetType) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = '';
 const wrap = document.createElement('div');
 wrap.className = 'tradingview-widget-container';
 wrap.style.cssText = 'width:100%;height:100%';
 const inner = document.createElement('div');
 inner.className = 'tradingview-widget-container__widget';
 inner.style.cssText = 'width:100%;height:100%';
 wrap.appendChild(inner);
 const scr = document.createElement('script');
 scr.type = 'text/javascript';
 scr.src = `https://s3.tradingview.com/external-embedding/embed-widget-${widgetType}.js`;
 scr.async = true;
 scr.textContent = JSON.stringify({ ...config, width: '100%' });
 wrap.appendChild(scr);
 el.appendChild(wrap);
}

// The model projects forward using known sector beta + volatility estimates
const ASSET_DATA = {
 // ticker: [beta, annualVolatility%, sector, avgGrowth5yr%]
 AAPL:[1.2,28,'Technology',18],MSFT:[0.9,24,'Technology',22],GOOGL:[1.1,30,'Technology',20],
 AMZN:[1.3,34,'E-Commerce',25],META:[1.4,38,'Social Media',30],TSLA:[2.0,55,'EV',35],
 NVDA:[1.8,52,'Semiconductors',45],NFLX:[1.3,40,'Streaming',15],AMD:[1.7,50,'Semiconductors',28],
 JPM:[0.8,22,'Finance',10],BAC:[0.9,28,'Finance',8],WMT:[0.5,16,'Retail',8],
 JNJ:[0.6,18,'Healthcare',6],V:[0.9,22,'Payments',14],MA:[1.0,24,'Payments',15],
 DIS:[1.1,30,'Entertainment',5],UBER:[1.5,45,'Transport',20],COIN:[2.5,80,'Crypto',50],
 PLTR:[1.8,60,'Software',25],INTC:[0.8,30,'Semiconductors',3],ORCL:[0.9,25,'Software',12],
 PYPL:[1.3,40,'Fintech',8],SPOT:[1.5,45,'Streaming',18],SHOP:[1.8,55,'E-Commerce',22],
 CRM:[1.1,30,'Software',16],'BRK.B':[0.7,18,'Finance',10],SNAP:[1.8,65,'Social',5],
 HOOD:[2.0,70,'Fintech',15],RBLX:[1.9,65,'Gaming',10],RIVN:[2.5,90,'EV',20],
 SPX:[1.0,18,'Index',10],IXIC:[1.1,22,'Index',12],DJI:[0.8,15,'Index',8],
 RUT:[1.1,24,'Index',8],VIX:[0,80,'Volatility',0],
 BTC:[3.0,70,'Crypto',60],ETH:[2.5,65,'Crypto',55],SOL:[3.5,85,'Crypto',70],
 BNB:[2.8,72,'Crypto',50],XRP:[3.0,80,'Crypto',40],DOGE:[4.0,100,'Crypto',30],
 ADA:[3.2,85,'Crypto',35],AVAX:[3.5,88,'Crypto',45],LINK:[3.0,80,'Crypto',40],
 LTC:[2.5,70,'Crypto',25],DOT:[3.2,85,'Crypto',35],MATIC:[3.5,88,'Crypto',40],
 // Additional major stocks
 LLY:[0.4,25,'Healthcare',30],AVGO:[1.2,32,'Semiconductors',28],ADBE:[1.1,32,'Software',18],
 QCOM:[1.1,35,'Semiconductors',15],AMAT:[1.4,38,'Semiconductors',22],ARM:[1.5,45,'Semiconductors',25],
 AMGN:[0.6,22,'Healthcare',8],GILD:[0.5,20,'Healthcare',6],ISRG:[0.9,26,'Healthcare',15],
 TMO:[0.8,22,'Healthcare',12],DHR:[0.9,24,'Healthcare',11],
 XOM:[0.7,22,'Energy',8],CVX:[0.7,20,'Energy',7],COP:[0.9,28,'Energy',10],NEE:[0.6,20,'Utilities',8],
 BA:[1.3,38,'Aerospace',5],LMT:[0.6,18,'Defense',8],RTX:[0.8,22,'Defense',9],
 GE:[1.0,30,'Industrials',12],CAT:[1.1,28,'Industrials',10],HON:[0.7,20,'Industrials',8],DE:[1.0,25,'Industrials',10],
 F:[1.2,35,'Automotive',5],GM:[1.1,32,'Automotive',6],NIO:[2.5,80,'EV',15],LCID:[3.0,90,'EV',5],
 SOFI:[1.8,60,'Fintech',20],HIMS:[1.9,65,'Healthcare',35],RDDT:[2.0,70,'Social',20],
 SMCI:[2.2,75,'Technology',45],NVAX:[2.8,85,'Healthcare',10],
};

/* ════════════════════════════════
 LIVE PRICES
 /api/quotes gives the latest price, /api/history gives daily closes.
 Both come from Yahoo Finance and are cached at the edge.
════════════════════════════════ */
const Y_INDEX = {
 SPX:'^GSPC', IXIC:'^IXIC', DJI:'^DJI', RUT:'^RUT', VIX:'^VIX', NDX:'^NDX', MID:'^MID', SP600:'^SP600',
 FTSE:'^FTSE', NI225:'^N225', DAX:'^GDAXI', CAC40:'^FCHI', HSI:'^HSI', ASX:'^AXJO', SENSEX:'^BSESN',
 NIFTY:'^NSEI', KOSPI:'^KS11', SSEC:'000001.SS', IBEX:'^IBEX', MIB:'FTSEMIB.MI', AEX:'^AEX', SMI:'^SSMI',
 TSX:'^GSPTSE', BVSP:'^BVSP', MERVAL:'^MERV', DXY:'DX-Y.NYB', US10Y:'^TNX', US30Y:'^TYX',
 GOLD:'GC=F', SILVER:'SI=F', USOIL:'CL=F', UKOIL:'BZ=F', NATGAS:'NG=F', CORN:'ZC=F', WHEAT:'ZW=F',
};
// Assets with no built-in long-run return (volatility, rates, currencies)
const FC_FLAT = new Set(['^VIX', '^TNX', '^TYX', 'DX-Y.NYB']);
const FC_COMMODITY = new Set(['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'NG=F', 'ZC=F', 'ZW=F']);

function isCryptoTicker(t, k) {
 if (k) return k === 'c';
 return TICKERS.some(e => e.t === t && e.k === 'c');
}
function ySym(t, k) {
 if (Y_INDEX[t]) return Y_INDEX[t];
 if (isCryptoTicker(t, k)) return t + '-USD';
 return String(t).replace(/\./g, '-');
}

const LIVE_Q = {};
async function fetchQuotes(items) {
 const fresh = Date.now() - 60000;
 const need = items.filter(([t]) => !LIVE_Q[t] || LIVE_Q[t].at < fresh);
 if (need.length) {
  const map = {};
  need.forEach(([t, k]) => { map[ySym(t, k)] = t; });
  try {
   const r = await fetch('/api/quotes?symbols=' + encodeURIComponent(Object.keys(map).join(',')));
   if (r.ok) {
    const { quotes } = await r.json();
    const got = {};
    for (const [s, q] of Object.entries(quotes || {})) if (map[s]) got[map[s]] = LIVE_Q[map[s]] = { ...q, at: Date.now() };
    if (typeof rememberPrices === 'function') rememberPrices(got);
   }
  } catch {}
 }
 return Object.fromEntries(items.map(([t]) => [t, LIVE_Q[t] || null]));
}
function livePrice(t) { return LIVE_Q[t]?.price ?? null; }

const _histReq = new Map();
function getHistory(sym) {
 if (!_histReq.has(sym)) {
  _histReq.set(sym, fetch('/api/history?symbol=' + encodeURIComponent(sym))
   .then(r => { if (!r.ok) throw new Error('No price history'); return r.json(); })
   .then(d => { if (!d?.c || d.c.length < 120) throw new Error('Not enough price history'); return d; })
   .catch(e => { _histReq.delete(sym); throw e; }));
 }
 return _histReq.get(sym);
}


/* ── Real risk and growth numbers (/api/stats, from 5 years of daily prices) ──
 Volatility, beta, 5-year growth and RSI for the screener, stock pages and portfolio tools.
 The hand-entered ASSET_DATA table is only a fallback, and still drives the practice simulations. */
const LIVE_STATS = (() => { try { return JSON.parse(localStorage.getItem('ss_stats_cache') || '{}') || {}; } catch { return {}; } })();
const STATS_TTL = 12 * 3600e3;
function liveStats(t) { const st = LIVE_STATS[t]; return st && Date.now() - st.at < 7 * 86400e3 ? st : null; }
function tickerKind(t) {
 const e = TICKERS.find(x => x.t === t);
 return e?.k || (Y_INDEX[t] ? 'i' : 's');
}
const _statsReq = new Map();
const _statsMiss = {};   // tickers the data service had nothing for, so we don't keep asking
function statsStale(t) {
 if (_statsMiss[t] && Date.now() - _statsMiss[t] < 6 * 3600e3) return false;
 return !LIVE_STATS[t] || Date.now() - LIVE_STATS[t].at > STATS_TTL;
}
async function fetchStats(items) {
 const need = items.filter(([t]) => statsStale(t));
 if (need.length) {
  const map = {};
  need.forEach(([t, k]) => { map[ySym(t, k || tickerKind(t))] = t; });
  const syms = Object.keys(map).sort();
  const chunks = [];
  for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  await Promise.all(chunks.map(async ch => {
   const key = ch.join(',');
   if (!_statsReq.has(key)) {
    _statsReq.set(key, fetch('/api/stats?symbols=' + encodeURIComponent(key)).then(r => r.ok ? r.json() : null).catch(() => null));
    setTimeout(() => _statsReq.delete(key), 30000);
   }
   const j = await _statsReq.get(key);
   for (const [sym, st] of Object.entries(j?.stats || {})) if (map[sym]) LIVE_STATS[map[sym]] = { ...st, at: Date.now() };
   if (j) ch.forEach(sym => { if (!j.stats?.[sym]) _statsMiss[map[sym]] = Date.now(); });
  }));
  try { localStorage.setItem('ss_stats_cache', JSON.stringify(LIVE_STATS)); } catch {}
 }
 return Object.fromEntries(items.map(([t]) => [t, liveStats(t)]));
}
// [beta, yearly volatility %, sector, 5-year growth %/yr]: real numbers when we have them
function assetData(t, fallback) {
 const base = ASSET_DATA[t] || fallback || [1, 30, tickerKind(t) === 'c' ? 'Crypto' : tickerKind(t) === 'i' ? 'Index' : 'Stock', 10];
 const st = liveStats(t);
 if (!st) return base;
 return [
  st.beta != null ? +st.beta.toFixed(2) : base[0],
  st.vol != null ? Math.round(st.vol * 100) : base[1],
  base[2],
  st.cagr != null ? Math.round(st.cagr * 100) : base[3],
 ];
}
// Same, but null for an asset we know nothing about (keeps "no data" UI working)
function assetDataOrNull(t) { return ASSET_DATA[t] || liveStats(t) ? assetData(t) : null; }
function fmtGrowth(g) { return `${g >= 0 ? '+' : ''}${g}%/yr`; }

/* ════════════════════════════════
 RESEARCH: real company data and a verdict you can check
 /api/fundamentals (Yahoo Finance) for the business, /api/stats for risk,
 /api/quotes for the price. Every verdict is scored from these numbers.
════════════════════════════════ */
const xpMode = () => mode === 'beginner' ? 'beginner' : mode === 'advanced' ? 'advanced' : 'mid';
const XP_LABEL = { beginner: 'Beginner', mid: 'Intermediate', advanced: 'Advanced' };
function setXp(x) {
 if (xpMode() === x) return;
 setMode(x === 'mid' ? 'simple' : x);
 toast(`Showing the ${XP_LABEL[x]} version of stock pages`, 'info', 2200);
}

// Full detail for one asset (stock page)
const _fundFull = new Map();
function getFundamentals(t, k) {
 const sym = ySym(t, k || tickerKind(t));
 if (!_fundFull.has(sym)) {
  _fundFull.set(sym, fetch('/api/fundamentals?symbol=' + encodeURIComponent(sym))
   .then(r => r.ok ? r.json() : null).catch(() => null)
   .then(d => { if (!d) setTimeout(() => _fundFull.delete(sym), 30000); else rememberFacts({ [t]: d.facts }); return d; }));
 }
 return _fundFull.get(sym);
}

// Scoring facts for many assets (screener, Markets, Compare), kept for 12 hours
const LIVE_FACTS = (() => { try { return JSON.parse(localStorage.getItem('ss_facts_cache') || '{}') || {}; } catch { return {}; } })();
const FACTS_TTL = 12 * 3600e3;
const _factsMiss = {};
let _factsSaveT = null;
function rememberFacts(map) {
 Object.entries(map).forEach(([t, f]) => { if (f) LIVE_FACTS[t] = { ...f, at: Date.now() }; });
 clearTimeout(_factsSaveT);
 _factsSaveT = setTimeout(() => { try { localStorage.setItem('ss_facts_cache', JSON.stringify(LIVE_FACTS)); } catch {} }, 500);
}
function factsFor(t) { const f = LIVE_FACTS[t]; return f && Date.now() - f.at < 4 * 86400e3 ? f : null; }
function factsStale(t) {
 if (_factsMiss[t] && Date.now() - _factsMiss[t] < 6 * 3600e3) return false;
 return !LIVE_FACTS[t] || Date.now() - LIVE_FACTS[t].at > FACTS_TTL;
}
const _factsReq = new Map();
async function fetchFacts(items) {
 const need = items.filter(([t]) => factsStale(t));
 if (need.length) {
  const map = {};
  need.forEach(([t, k]) => { map[ySym(t, k || tickerKind(t))] = t; });
  const syms = Object.keys(map).sort();
  const chunks = [];
  for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));
  await Promise.all(chunks.map(async ch => {
   const key = ch.join(',');
   if (!_factsReq.has(key)) {
    _factsReq.set(key, fetch('/api/fundamentals?symbols=' + encodeURIComponent(key)).then(r => r.ok ? r.json() : null).catch(() => null));
    setTimeout(() => _factsReq.delete(key), 30000);
   }
   const j = await _factsReq.get(key);
   const got = {};
   for (const [sym, f] of Object.entries(j?.data || {})) if (map[sym]) got[map[sym]] = f;
   rememberFacts(got);
   if (j) ch.forEach(sym => { if (!j.data?.[sym]) _factsMiss[map[sym]] = Date.now(); });
  }));
 }
 return Object.fromEntries(items.map(([t]) => [t, factsFor(t)]));
}

/* ── Formatting ── */
const rsClamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rsAvg = a => a.reduce((s, x) => s + x, 0) / a.length;
function fmtBig(v) {
 if (v == null || !Number.isFinite(v)) return '—';
 const a = Math.abs(v), s = v < 0 ? '-' : '';
 return a >= 1e12 ? `${s}$${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}$${Math.round(a).toLocaleString()}`;
}
function fmtPx(v) { return v == null || !Number.isFinite(v) ? '—' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: v < 1 ? 4 : 2, maximumFractionDigits: v < 1 ? 6 : 2 }); }
function fmtSigned(v, d = 1) { return v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`; }
function fmtPlain(v, d = 1) { return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`; }
function fmtX(v, d = 1) { return v == null || !Number.isFinite(v) || v <= 0 ? '—' : `${v.toFixed(d)}x`; }
function fmtDay(ts) { return ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function fmtShortDay(ts) { return ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'; }
const pc0 = v => `${Math.round(Math.abs(v) * 100)}%`;
function rsName(t, f) {
 const n = (f?.name || TICKERS.find(e => e.t === t)?.n || t).replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Co\.|Company|Ltd\.?|plc|Holdings?|Group|Incorporated|Platforms|Technologies)$/i, '').replace(/\s+USD$/, '').replace(/^The\s+(?=\S+\s*\S)/, '');
 return n.length > 28 ? t : n;
}
function rsGrade(s) { return s >= 80 ? 'A' : s >= 67 ? 'B' : s >= 52 ? 'C' : s >= 40 ? 'D' : 'F'; }
function rsKind(t, f) {
 const q = f?.quoteType;
 if (q === 'ETF' || q === 'MUTUALFUND') return 'fund';
 if (q === 'INDEX' || tickerKind(t) === 'i') return 'index';
 if (q === 'CRYPTOCURRENCY' || tickerKind(t) === 'c') return 'crypto';
 return 'stock';
}
const INDEX_ETF = { SPX:'VOO or SPY', IXIC:'QQQ', NDX:'QQQ', DJI:'DIA', RUT:'IWM', VIX:'none (it measures fear)', MID:'IJH', SP600:'IJR' };

/* ── Verdict model ──
 Stocks: analysts 25%, growth 20%, profitability 20%, valuation 15%, financial health 10%, momentum 10%.
 Verdicts: 80+ Strong Buy, 68+ Buy, 48+ Hold, below that Sell.
 Funds and indexes: momentum, risk, diversification and cost. Crypto: momentum and risk only,
 with no business underneath, so it can't score as high. */
function scoreAsset(t, f, st) {
 const kind = rsKind(t, f);
 // A company verdict needs its business numbers; price action alone isn't enough
 if (kind === 'stock' && !f) return null;
 const px = livePrice(t) || f?.price || null;
 const spRet = liveStats('SPX')?.ret1y ?? f?.sp52w ?? 0.12;
 const factors = [];
 const add = (key, label, weight, score, inputs) => {
  if (score == null || !Number.isFinite(score)) return;
  factors.push({ key, label, weight, score: Math.round(rsClamp(score, 0, 100)), inputs });
 };
 if (kind === 'stock' && f) {
  if (f.analysts >= 3 && f.recMean) {
   const base = (5 - f.recMean) / 4 * 100, w = Math.min(1, f.analysts / 10);
   let s = 50 + (base - 50) * w;
   const up = f.targetMean && px ? f.targetMean / px - 1 : null;
   if (up != null) s = 0.6 * s + 0.4 * rsClamp(50 + up * 250, 0, 100);
   add('analysts', 'Analyst view', 25, s, { recMean: f.recMean, analysts: f.analysts, upside: up });
  }
  if (f.revenueGrowth != null || f.earningsGrowth != null) {
   const g = f.revenueGrowth != null ? rsClamp(45 + f.revenueGrowth * 150, 0, 100) : null;
   const e = f.earningsGrowth != null ? rsClamp(45 + rsClamp(f.earningsGrowth, -1, 1) * 80, 0, 100) : null;
   add('growth', 'Growth', 20, g != null && e != null ? 0.6 * g + 0.4 * e : (g ?? e), { revenueGrowth: f.revenueGrowth, earningsGrowth: f.earningsGrowth });
  }
  const pp = [];
  if (f.operatingMargin != null) pp.push(rsClamp(30 + f.operatingMargin * 200, 0, 100));
  if (f.roe != null) pp.push(rsClamp(40 + Math.min(f.roe, 0.6) * 100, 0, 100));
  if (f.freeCashflow != null) pp.push(f.freeCashflow > 0 ? 75 : 20);
  if (f.profitMargin != null && f.profitMargin < 0) pp.push(10);
  if (pp.length) add('profit', 'Profitability', 20, rsAvg(pp), { operatingMargin: f.operatingMargin, roe: f.roe, freeCashflow: f.freeCashflow });
  const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE > 0 ? f.trailingPE : null;
  if (pe) {
   const s1 = rsClamp(100 - 60 * Math.log10(pe / 6), 5, 98);
   const s2 = f.peg > 0 ? rsClamp(100 - (f.peg - 0.5) * 30, 5, 95) : null;
   add('value', 'Valuation', 15, s2 != null ? (s1 + s2) / 2 : s1, { pe, peg: f.peg });
  } else if (f.profitMargin != null && f.profitMargin < 0) {
   add('value', 'Valuation', 15, f.priceToSales ? rsClamp(70 - f.priceToSales * 4, 10, 60) : 25, { pe: null, priceToSales: f.priceToSales });
  }
  if (!/Financial/i.test(f.sector || '')) {
   const hp = [];
   if (f.debtToEquity != null) hp.push(rsClamp(90 - (f.debtToEquity / 100) * 25, 5, 95));
   if (f.totalCash != null && f.totalDebt != null) hp.push(f.totalCash >= f.totalDebt ? 88 : rsClamp(88 - (f.totalDebt - f.totalCash) / Math.max(f.totalDebt, 1) * 55, 30, 88));
   if (f.currentRatio != null) hp.push(rsClamp(30 + f.currentRatio * 35, 10, 95));
   if (hp.length) add('health', 'Financial health', 10, rsAvg(hp), { debtToEquity: f.debtToEquity, cash: f.totalCash, debt: f.totalDebt, currentRatio: f.currentRatio });
  }
 }
 const ret = st?.ret1y ?? f?.change52w;
 if (ret != null) {
  let s = 50 + (ret - spRet) * 120;
  if (f?.twoHundredDayAvg && px) s += px > f.twoHundredDayAvg ? 8 : -8;
  // A price far above its 200-day average is usually hype or a squeeze: it can't lift the verdict
  if (f?.twoHundredDayAvg && px && px / f.twoHundredDayAvg > 1.35) s = Math.min(s, 50);
  add('momentum', 'Momentum', kind === 'stock' ? 10 : 35, s, { ret1y: ret, spRet, above200: f?.twoHundredDayAvg && px ? px > f.twoHundredDayAvg : null });
 }
 if (kind !== 'stock') {
  if (st?.vol != null) add('risk', 'Risk', 30, rsClamp(95 - st.vol * 100, 5, 95), { vol: st.vol, maxDD: st.maxDD });
  if (kind === 'fund' || kind === 'index') {
   add('diversified', 'Diversification', 25, t === 'VIX' ? 30 : 85, {});
   if (f?.expenseRatio != null) add('cost', 'Cost', 10, rsClamp(95 - f.expenseRatio * 6000, 10, 95), { expenseRatio: f.expenseRatio });
  }
  if (kind === 'crypto') add('basics', 'Business behind it', 35, 30, {});
 }
 if (!factors.length) return null;
 const wsum = factors.reduce((s, x) => s + x.weight, 0);
 let score = factors.reduce((s, x) => s + x.score * x.weight, 0) / wsum;
 const coverage = Math.min(1, wsum / 100);
 const spread = Math.sqrt(rsAvg(factors.map(x => (x.score - score) ** 2)));
 const confidence = Math.round(rsClamp(35 + 60 * coverage * (1 - spread / 60), 20, 92));
 let verdict = score >= 80 ? 'Strong Buy' : score >= 68 ? 'Buy' : score >= 48 ? 'Hold' : 'Sell';
 if ((kind === 'fund' || kind === 'index') && verdict === 'Strong Buy') verdict = 'Buy';
 if (kind === 'crypto' && (verdict === 'Strong Buy' || verdict === 'Buy')) verdict = 'Hold';
 if (t === 'VIX') verdict = 'Hold';
 return { t, kind, score: Math.round(score), verdict, confidence, factors, facts: f || {}, stats: st || {}, price: px, coverage };
}
// Quick verdict from cached numbers (screener, Compare, Markets); null when we have nothing yet
function verdictFor(t) {
 const f = factsFor(t), st = liveStats(t);
 if (!f && !st) return null;
 return scoreAsset(t, f, st);
}
const VERDICT_COLOR = { 'Strong Buy': 'var(--green)', 'Buy': 'var(--green)', 'Hold': 'var(--gold)', 'Sell': 'var(--red)' };
const VERDICT_KID = { 'Strong Buy': 'Looks really good', 'Buy': 'Looks good', 'Hold': 'Just okay right now', 'Sell': 'Not a great pick now' };

/* ── Reasons, in three reading levels ── */
function researchPoints(R) {
 const f = R.facts || {}, st = R.stats || {}, px = R.price, t = R.t, name = rsName(t, f);
 const spRet = liveStats('SPX')?.ret1y ?? f.sp52w ?? 0.12, spVol = liveStats('SPX')?.vol || 0.15;
 const good = [], bad = [];
 const G = (w, kid, mid, adv) => good.push({ w, kid, mid, adv }), B = (w, kid, mid, adv) => bad.push({ w, kid, mid, adv });
 const financial = /Financial/i.test(f.sector || '');
 if (R.kind === 'stock') {
  if (f.revenueGrowth != null) {
   const g = f.revenueGrowth;
   if (g >= 0.08) G(Math.min(1, g * 2.5), `More people are buying from ${name}. Sales grew ${pc0(g)} in a year.`, `Sales grew ${pc0(g)} over the past year.`, `Revenue ${fmtSigned(g)} y/y`);
   else if (g < 0) B(-g + 0.2, `${name} sold less than it did a year ago.`, `Sales shrank ${pc0(g)} over the past year.`, `Revenue ${fmtSigned(g)} y/y`);
  }
  if (f.earningsGrowth != null) {
   const e = f.earningsGrowth;
   if (e >= 0.1) G(Math.min(e, 1) * 0.8, `Its profit went up ${pc0(e)} compared with last year.`, `Profit grew ${pc0(e)} from a year earlier.`, `Earnings ${fmtSigned(e)} y/y`);
   else if (e <= -0.1) B(Math.min(-e, 1) * 0.8, `Its profit went down ${pc0(e)} compared with last year.`, `Profit fell ${pc0(e)} from a year earlier.`, `Earnings ${fmtSigned(e)} y/y`);
  }
  if (f.profitMargin != null && f.profitMargin < 0) B(0.7, `${name} is spending more than it earns, so it's losing money right now.`, `It isn't profitable yet (net margin ${fmtPlain(f.profitMargin)}).`, `Net margin ${fmtPlain(f.profitMargin)}`);
  else if (f.operatingMargin >= 0.2) G(f.operatingMargin, `For every $1 it sells, it keeps about ${Math.round(f.operatingMargin * 100)}¢ as profit. That's a lot.`, `Very profitable: keeps ${pc0(f.operatingMargin)} of sales as operating profit.`, `Op. margin ${fmtPlain(f.operatingMargin)}${f.roe != null ? `, ROE ${fmtPlain(f.roe, 0)}` : ''}`);
  if (!financial && f.totalCash != null && f.totalDebt != null) {
   if (f.totalCash > f.totalDebt) G(0.3, `It has more money saved than it owes.`, `More cash (${fmtBig(f.totalCash)}) than debt (${fmtBig(f.totalDebt)}).`, `Net cash ${fmtBig(f.totalCash - f.totalDebt)}`);
   else if (f.debtToEquity > 150) B(0.45, `It owes a lot of money.`, `Carries heavy debt: ${(f.debtToEquity / 100).toFixed(1)}x shareholder equity.`, `D/E ${(f.debtToEquity / 100).toFixed(2)}, net debt ${fmtBig(f.totalDebt - f.totalCash)}`);
  }
  const fcf = f.fcfReported ?? f.freeCashflow;
  if (fcf > 0 && f.revenue && fcf / f.revenue >= 0.15) G(0.35, `It brings in lots of spare cash after paying its bills.`, `Generates strong cash: ${fmtBig(fcf)} of free cash flow last year.`, `FCF ${fmtBig(fcf)} (${fmtPlain(fcf / f.revenue, 0)} margin)`);
  const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE > 0 ? f.trailingPE : null;
  if (pe >= 35) B(Math.min(1, pe / 60), `It's expensive. Buyers pay about $${Math.round(pe)} for every $1 of profit it makes in a year.`, `Pricey: about ${Math.round(pe)}x expected earnings, versus roughly 20x for a typical S&P 500 stock.`, `Fwd P/E ${pe.toFixed(1)}${f.peg > 0 ? `, PEG ${f.peg.toFixed(2)}` : ''}`);
  else if (pe && pe <= 15) G(0.4, `Its price is low compared with how much money it makes.`, `Inexpensive: about ${Math.round(pe)}x expected earnings.`, `Fwd P/E ${pe.toFixed(1)}${f.peg > 0 ? `, PEG ${f.peg.toFixed(2)}` : ''}`);
  if (f.analysts >= 5 && f.recMean) {
   if (f.recMean <= 2.2) G(0.5, `Most experts who study ${name} say it's a good buy.`, `Most of the ${f.analysts} Wall Street analysts covering it rate it a Buy.`, `Consensus ${f.recMean.toFixed(2)} across ${f.analysts} analysts`);
   else if (f.recMean >= 3) B(0.5, `Many experts aren't excited about it.`, `Analysts lean cautious: the average rating is closer to Hold or Sell.`, `Consensus ${f.recMean.toFixed(2)} across ${f.analysts} analysts`);
  }
  if (f.targetMean && px && f.analysts >= 3) {
   const up = f.targetMean / px - 1;
   if (up >= 0.1) G(Math.min(up, 1), `Experts think one share could be worth ${fmtPx(f.targetMean)} in a year. Today it costs ${fmtPx(px)}.`, `The average analyst target (${fmtPx(f.targetMean)}) is ${pc0(up)} above today's price.`, `Mean target ${fmtPx(f.targetMean)} (${fmtSigned(up)})`);
   else if (up <= -0.05) B(Math.min(-up, 1), `It already costs more than experts think it's worth.`, `It trades ${pc0(up)} above the average analyst target of ${fmtPx(f.targetMean)}.`, `Mean target ${fmtPx(f.targetMean)} (${fmtSigned(up)})`);
  }
  if (f.reportCount >= 3) {
   if (f.beatCount === f.reportCount) G(0.4, `It did better than experts expected ${f.beatCount} times in a row.`, `Beat profit estimates in each of the last ${f.reportCount} quarters.`, `EPS beats ${f.beatCount}/${f.reportCount}, last surprise ${fmtSigned(f.lastSurprise)}`);
   else if (f.beatCount <= f.reportCount / 2) B(0.35, `It often earned less than experts expected.`, `Missed profit estimates in ${f.reportCount - f.beatCount} of the last ${f.reportCount} quarters.`, `EPS beats ${f.beatCount}/${f.reportCount}`);
  }
  if (f.dividendYield >= 0.02) G(0.3, `It pays its owners about $${(f.dividendYield * 100).toFixed(2)} a year for every $100 they own, just for holding it.`, `Pays a ${fmtPlain(f.dividendYield)} dividend.`, `Yield ${fmtPlain(f.dividendYield, 2)}${f.payoutRatio != null ? `, payout ${fmtPlain(f.payoutRatio, 0)}` : ''}`);
  if (f.shortPctFloat >= 0.1) B(0.35, `Lots of traders are betting its price will fall.`, `${pc0(f.shortPctFloat)} of its shares are sold short, a sign of skepticism.`, `Short interest ${fmtPlain(f.shortPctFloat)} of float`);
 }
 if (st.ret1y != null) {
  const rel = st.ret1y - spRet;
  if (rel >= 0.1) G(Math.min(rel, 1) * 0.6, `Its price went up ${pc0(st.ret1y)} this year, more than most stocks.`, `Up ${pc0(st.ret1y)} over the past year, ahead of the S&P 500 (${fmtSigned(spRet, 0)}).`, `1y ${fmtSigned(st.ret1y)} vs SPX ${fmtSigned(spRet)}`);
  else if (rel <= -0.1) B(Math.min(-rel, 1) * 0.6, st.ret1y < 0 ? `Its price went down ${pc0(st.ret1y)} this year.` : `Its price grew less than most stocks this year.`, `${st.ret1y < 0 ? `Down ${pc0(st.ret1y)}` : `Up only ${pc0(st.ret1y)}`} over the past year, behind the S&P 500 (${fmtSigned(spRet, 0)}).`, `1y ${fmtSigned(st.ret1y)} vs SPX ${fmtSigned(spRet)}`);
 }
 if (st.vol != null) {
  const ratio = st.vol / spVol;
  if (ratio >= 2) B(Math.min(1, ratio / 4), `Its price jumps up and down a lot, like a roller coaster.`, `Volatile: swings about ${pc0(st.vol)} a year, ${ratio.toFixed(1)}x the S&P 500.`, `Vol ${fmtPlain(st.vol, 0)} (${ratio.toFixed(1)}x SPX), max drawdown ${fmtSigned(st.maxDD, 0)}`);
  else if (ratio <= 1.2 && R.kind === 'stock') G(0.2, `Its price is fairly steady.`, `Steadier than most stocks: swings about ${pc0(st.vol)} a year.`, `Vol ${fmtPlain(st.vol, 0)} (${ratio.toFixed(1)}x SPX)`);
 }
 if (R.kind === 'fund') {
  G(0.6, `One share holds a little bit of lots of companies, so one bad company can't sink it.`, `Diversified: one share spreads your money across many companies.`, `Fund${f.category ? `, ${f.category}` : ''}`);
  if (f.expenseRatio != null && f.expenseRatio <= 0.002) G(0.4, `It's cheap to own: about $${Math.max(1, Math.round(f.expenseRatio * 10000))} a year for every $10,000.`, `Low cost: ${fmtPlain(f.expenseRatio, 2)} a year in fees.`, `Expense ratio ${fmtPlain(f.expenseRatio, 2)}`);
  else if (f.expenseRatio >= 0.0075) B(0.4, `It charges a high fee every year.`, `Expensive to hold: ${fmtPlain(f.expenseRatio, 2)} a year in fees.`, `Expense ratio ${fmtPlain(f.expenseRatio, 2)}`);
 }
 if (R.kind === 'index') G(0.5, `This is a scoreboard for a big group of companies. You can't buy it directly, but you can buy a fund that copies it (${INDEX_ETF[t] || 'an index fund'}).`, `You can't buy an index directly; investors use a fund that tracks it, such as ${INDEX_ETF[t] || 'an index ETF'}.`, `Tradable proxy: ${INDEX_ETF[t] || 'index ETF'}`);
 if (R.kind === 'crypto') B(0.7, `No company is behind it, so there are no profits to check. Its price is just what people are willing to pay.`, `No earnings or cash flow to value; the price runs on demand and sentiment.`, `No fundamentals; sentiment-driven`);
 const stretch = f.twoHundredDayAvg && px ? px / f.twoHundredDayAvg - 1 : null;
 if (stretch != null && stretch > 0.35) B(Math.min(1, stretch), `The price jumped fast. It's ${pc0(stretch)} above its usual level, and big jumps like that often cool off.`, `The price is ${pc0(stretch)} above its 200-day average. Run-ups that steep often cool off.`, `${pc0(stretch)} above the 200-day average (stretched)`);
 good.sort((a, b) => b.w - a.w); bad.sort((a, b) => b.w - a.w);
 return { good: good.slice(0, 5), bad: bad.slice(0, 5) };
}

// One sentence a reader at each level can take away
function verdictLine(R, P, xp) {
 const g = P.good[0], b = P.bad[0];
 if (xp === 'beginner') {
  return R.verdict === 'Sell' ? `We checked the important things about ${rsName(R.t, R.facts)}, and more of them look worrying than good.`
   : R.verdict === 'Hold' ? `${rsName(R.t, R.facts)} has some good things and some worries, so it's a "wait and see" pick.`
   : `Most of the important things about ${rsName(R.t, R.facts)} look good.`;
 }
 const low = s => s ? s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, '') : '';
 if (g && b) return `${g.mid.replace(/\.$/, '')}, but ${low(b.mid)}.`;
 return (g || b)?.mid || 'Not enough data to say much yet.';
}

// What each factor means at each reading level
function factorText(fc, R, xp) {
 const i = fc.inputs || {}, s = fc.score;
 const tier = s >= 67 ? 'hi' : s >= 45 ? 'mid' : 'lo';
 const K = {
  analysts: { hi: 'Experts like it', mid: 'Experts are unsure', lo: 'Experts aren\'t fans' },
  growth: { hi: 'Selling more every year', mid: 'Growing slowly', lo: 'Selling less than before' },
  profit: { hi: 'Makes lots of money', mid: 'Makes some money', lo: 'Not making much money' },
  value: { hi: 'Fairly priced', mid: 'A bit pricey', lo: 'Very expensive right now' },
  health: { hi: 'Has plenty of savings', mid: 'Has some debt', lo: 'Owes a lot' },
  momentum: { hi: 'Price went up lately', mid: 'Price has been flat', lo: 'Price went down lately' },
  risk: { hi: 'Smooth ride', mid: 'Some bumps', lo: 'Wild ride' },
  diversified: { hi: 'Spread across lots of companies', mid: 'Somewhat spread out', lo: 'Not spread out' },
  cost: { hi: 'Cheap to own', mid: 'Normal fees', lo: 'High fees' },
  basics: { hi: 'Strong business', mid: 'Some business', lo: 'No company behind it' },
 };
 const KIDNAME = { analysts: 'Experts', growth: 'Growing', profit: 'Making money', value: 'Price tag', health: 'Money safety', momentum: 'Lately', risk: 'Bumpiness', diversified: 'Spread out', cost: 'Fees', basics: 'Business behind it' };
 if (xp === 'beginner') return { name: KIDNAME[fc.key] || fc.label, text: K[fc.key]?.[tier] || '' };
 const mid = {
  analysts: () => `${i.analysts} analysts, average rating ${recWord(i.recMean)}${i.upside != null ? `; average target ${fmtSigned(i.upside, 0)} from here` : ''}`,
  growth: () => [i.revenueGrowth != null ? `Sales ${fmtSigned(i.revenueGrowth, 0)}` : '', i.earningsGrowth != null ? `profit ${fmtSigned(i.earningsGrowth, 0)}` : ''].filter(Boolean).join(', ') + ' over the past year',
  profit: () => [i.operatingMargin != null ? `${fmtPlain(i.operatingMargin, 0)} operating margin` : '', i.roe != null ? `${fmtPlain(i.roe, 0)} return on equity` : '', i.freeCashflow != null ? (i.freeCashflow > 0 ? 'positive free cash flow' : 'burning cash') : ''].filter(Boolean).join(', '),
  value: () => i.pe ? `${i.pe.toFixed(0)}x expected earnings${i.peg > 0 ? `, PEG ${i.peg.toFixed(1)}` : ''} (market is about 20x)` : 'No earnings to value it on',
  health: () => [i.debtToEquity != null ? `Debt is ${(i.debtToEquity / 100).toFixed(1)}x equity` : '', i.cash != null && i.debt != null ? `${fmtBig(i.cash)} cash vs ${fmtBig(i.debt)} debt` : ''].filter(Boolean).join(', '),
  momentum: () => `${fmtSigned(i.ret1y, 0)} over a year vs ${fmtSigned(i.spRet, 0)} for the S&P 500${i.above200 != null ? (i.above200 ? ', above its 200-day average' : ', below its 200-day average') : ''}`,
  risk: () => `Swings about ${fmtPlain(i.vol, 0)} a year${i.maxDD != null ? `, worst drop ${fmtSigned(i.maxDD, 0)} this year` : ''}`,
  diversified: () => 'Holds many companies in one share',
  cost: () => `${fmtPlain(i.expenseRatio, 2)} yearly fee`,
  basics: () => 'No earnings, sales or cash flow behind the price',
 };
 return { name: fc.label, text: (mid[fc.key] || (() => ''))() };
}
function recWord(m) { return m == null ? '—' : m <= 1.5 ? 'Strong Buy' : m <= 2.5 ? 'Buy' : m <= 3.5 ? 'Hold' : m <= 4.5 ? 'Sell' : 'Strong Sell'; }

// What $100 grew into, from the real 5-year growth rate
function hundredThen(st) {
 if (st?.cagr == null || !st.years) return null;
 return { value: 100 * Math.pow(1 + st.cagr, st.years), years: Math.max(1, Math.round(st.years)) };
}

// The verdict and reasons in the shape older chat answers expect, from real data only
function realProfile(t) {
 const S = window._rs;
 const R = S?.ticker === t ? S.R : verdictFor(t);
 if (!R) return null;
 const P = S?.ticker === t ? S.P : researchPoints(R);
 const join = arr => arr.slice(0, 3).map(x => x.mid.replace(/\.$/, '')).join('. ');
 return { verdict: R.verdict, score: R.score, color: VERDICT_COLOR[R.verdict], reason: `${join(P.good) || 'No standout strengths in the data'}. Risks: ${join(P.bad) || 'nothing major stands out'}.` };
}

// Answers built from the live research on the open stock page, at the reader's level.
// Returns null to fall back to the general knowledge base.
function realChatReply(m, ticker, rich) {
 const S = window._rs;
 if (!S || S.ticker !== ticker || !S.R) return null;
 if (/what('s| is) an? /.test(m) && !m.includes(ticker.toLowerCase())) return null;
 const { R, P, F } = S, f = R.facts, st = R.stats, xp = xpMode(), name = rsName(ticker, f);
 const kid = xp === 'beginner', adv = xp === 'advanced';
 const pick = p => kid ? p.kid : adv ? p.adv : p.mid;
 const list = arr => arr.length ? arr.map(p => `• ${pick(p)}`).join('<br>') : '• Nothing stands out here.';
 const sents = (F?.profile?.summary || '').match(/[^.!?]+[.!?]+/g) || [];
 const tail = kid ? '<br><br><em>This is a computer\'s guess from real numbers, not advice.</em>' : '<br><br><em>From live Yahoo Finance data. Not financial advice.</em>';

 // A bare 'what is ...' means the business, unless it names a topic ("what's the bear case?", "what is the P/E?")
 const topic = /bull|bear|upside|downside|risk|safe|volatil|beta|rate|inflation|macro|\bfed\b|econom|recession|valu|expensive|cheap|p\/?e\b|ratio|dividend|earning|revenue|margin|profit|target|analyst|forecast|predict|price|news|options?\b|short|insider|ceo|who runs|compet/.test(m);
 if (/what does .* do|business model|how does .* make money|what do they (do|make|sell)|tell me about/.test(m) || (/^what is |^what's /.test(m) && !topic)) {
  if (R.kind === 'stock' && sents.length) return rich(kid ? `What ${name} does` : `${ticker}: the business`, (kid ? sents[0] : sents.slice(0, adv ? 4 : 2).join(' ')) + (f.industry && !kid ? `<br><br>Sector: ${f.sector} · Industry: ${f.industry}${F?.profile?.employees ? ` · ${F.profile.employees.toLocaleString()} employees` : ''}` : ''));
  if (R.kind === 'fund') return rich(`What ${name} is`, `${kid ? 'It\'s a fund: one share holds a little of many companies.' : sents.slice(0, 2).join(' ')}${F?.fund?.holdings?.length ? `<br><br>Biggest holdings: ${F.fund.holdings.slice(0, 5).map(h => `${h.symbol} (${fmtPlain(h.pct)})`).join(', ')}` : ''}`);
  if (R.kind === 'crypto') return rich(`What ${name} is`, kid ? 'It\'s digital money on the internet. No company is behind it, so its price is just what people will pay.' : (sents[0] || `${name} is a cryptocurrency.`) + ' There\'s no company, revenue or profit behind it, so its value depends entirely on demand.');
 }
 if (/should i buy|good buy|worth (buying|it)|buy or sell|good (stock|investment|pick)|invest in|is it good/.test(m)) {
  const head = kid ? `${VERDICT_KID[R.verdict]}.` : `StockSight verdict: <strong>${R.verdict}</strong> (${R.score}/100).`;
  return rich(kid ? `Is ${name} a good buy?` : `${ticker}: buy, hold or sell?`, `${head} ${verdictLine(R, P, xp)}<br><br><strong>${kid ? 'Good things' : 'For it'}</strong><br>${list(P.good.slice(0, 3))}<br><br><strong>${kid ? 'Be careful' : 'Against it'}</strong><br>${list(P.bad.slice(0, 3))}${tail}`);
 }
 if (/bull case|upside|reasons to (buy|like)|why buy|positives|strengths/.test(m)) return rich(kid ? `Good things about ${name}` : `${ticker}: the bull case`, list(P.good) + tail);
 if (/bear case|downside|reasons not|why not|negatives|weakness|what are the risks|main risks/.test(m)) return rich(kid ? `Things to be careful about` : `${ticker}: the bear case`, list(P.bad) + bearChatExtra(R) + tail);
 if (/interest rate|inflation|macro|federal reserve|\bfed\b|rate (hike|cut)|the economy|recession/.test(m) && !kid) {
  return rich(`${ticker}: interest rates and the economy`, macroChatLine(ticker) + 'Higher rates make future profits worth less today, so fast-growing companies usually feel them most, while banks can benefit. The Stress test tab shows how it held up in 2022 and other crashes.' + tail);
 }
 if (/risky|risk level|volatil|beta|is it safe|how safe|swing/.test(m)) {
  if (st.vol == null) return null;
  const spv = liveStats('SPX')?.vol || 0.15, ratio = st.vol / spv;
  if (kid) return rich(`Is ${name} risky?`, `${ratio >= 2 ? 'Yes, it\'s a wild ride.' : ratio >= 1.3 ? 'A little. It\'s bumpier than most.' : 'Not very. It\'s steadier than most.'} In a normal year its price can move about ${pc0(st.vol)} up or down. Over the past year, its biggest drop from a high point was ${pc0(st.maxDD)}.`);
  return rich(`${ticker}: risk`, `• Volatility: ${fmtPlain(st.vol, 0)} a year (${ratio.toFixed(1)}x the S&P 500)<br>• Beta: ${st.beta != null ? st.beta.toFixed(2) : '—'}${adv ? ` (2y weekly, adjusted; 5y monthly ${f.beta5y?.toFixed(2) ?? '—'})` : ' (how much it moves with the market)'}<br>• Biggest drop in the past year: ${fmtSigned(st.maxDD, 0)}${f.shortPctFloat != null ? `<br>• Short interest: ${fmtPlain(f.shortPctFloat, 1)} of shares` : ''}${tail}`);
 }
 if (/overvalued|undervalued|expensive|cheap|valuation|p\/?e\b|pe ratio|price.to.earnings/.test(m) && R.kind === 'stock') {
  const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE;
  if (!pe) return rich(kid ? `Is ${name} expensive?` : `${ticker}: valuation`, kid ? 'It isn\'t making a profit right now, so there\'s no easy way to tell.' : `No positive earnings to compare against, so P/E doesn't apply.${f.priceToSales ? ` It trades at ${f.priceToSales.toFixed(1)}x sales.` : ''}`);
  if (kid) return rich(`Is ${name} expensive?`, `Buyers pay about <strong>$${Math.round(pe)}</strong> for every $1 of profit ${name} makes in a year. For a typical big company it's about $20. So it's ${pe > 30 ? 'on the expensive side' : pe < 15 ? 'on the cheap side' : 'about normal'}.`);
  return rich(`${ticker}: valuation`, `• P/E: ${f.trailingPE?.toFixed(1) ?? '—'} trailing, ${f.forwardPE?.toFixed(1) ?? '—'} forward (S&P 500 is roughly 20 to 25)${f.peg ? `<br>• PEG: ${f.peg.toFixed(2)} (P/E relative to growth; near 1 is fair)` : ''}${adv ? `<br>• P/S ${f.priceToSales?.toFixed(1) ?? '—'} · P/B ${f.priceToBook?.toFixed(1) ?? '—'} · EV/EBITDA ${f.evToEbitda?.toFixed(1) ?? '—'}` : ''}${f.targetMean && R.price ? `<br>• Average analyst target: ${fmtPx(f.targetMean)} (${fmtSigned(f.targetMean / R.price - 1, 0)})` : ''}${tail}`);
 }
 if (/earnings|revenue|sales|profit|margin|financials|growth|eps/.test(m) && R.kind === 'stock') {
  if (kid) return rich(`How is ${name} doing?`, `${f.revenueGrowth != null ? `It sold ${f.revenueGrowth >= 0 ? `${pc0(f.revenueGrowth)} more` : `${pc0(f.revenueGrowth)} less`} than a year ago. ` : ''}${f.profitMargin != null ? (f.profitMargin > 0 ? `For every $1 it sells, it keeps about ${Math.round(f.profitMargin * 100)}¢ as profit. ` : 'Right now it spends more than it earns. ') : ''}${f.reportCount ? `It did better than experts expected ${f.beatCount} of the last ${f.reportCount} times it reported.` : ''}`);
  return rich(`${ticker}: earnings and growth`, `• Sales ${fmtSigned(f.revenueGrowth, 0)} y/y${f.revenue ? ` (${fmtBig(f.revenue)} over the last year)` : ''}<br>• Profit ${fmtSigned(f.earningsGrowth, 0)} y/y<br>• Margins: ${fmtPlain(f.grossMargin, 0)} gross, ${fmtPlain(f.operatingMargin, 0)} operating, ${fmtPlain(f.profitMargin, 0)} net${f.reportCount ? `<br>• Beat EPS estimates ${f.beatCount} of the last ${f.reportCount} quarters` : ''}${f.nextEarnings ? `<br>• Next report: ${fmtDay(f.nextEarnings)}${f.nextEpsEstimate != null ? `, EPS expected $${f.nextEpsEstimate.toFixed(2)}` : ''}` : ''}${tail}`);
 }
 if (/analyst|expert|price target|target price|rating|wall street/.test(m)) {
  const tr = F?.analysts?.trend?.[0];
  if (!tr && !f.targetMean) return rich(kid ? 'What do experts say?' : `${ticker}: analysts`, kid ? 'No experts publish ratings on this one.' : 'No Wall Street analyst coverage.');
  const b = (tr?.strongBuy || 0) + (tr?.buy || 0), h = tr?.hold || 0, s = (tr?.sell || 0) + (tr?.strongSell || 0);
  if (kid) return rich('What do experts say?', `Out of ${b + h + s} experts, <strong>${b}</strong> say buy, <strong>${h}</strong> say wait and <strong>${s}</strong> say sell.${f.targetMean ? ` On average they think one share will be worth ${fmtPx(f.targetMean)} in a year. Today it's ${fmtPx(R.price)}.` : ''}`);
  const act = (F?.analysts?.actions || []).slice(0, adv ? 5 : 3).map(a => `${fmtShortDay(a.date)}: ${a.firm}, ${a.to}${a.target ? ` (target ${fmtPx(a.target)})` : ''}`).join('<br>');
  return rich(`${ticker}: analysts`, `${b} Buy · ${h} Hold · ${s} Sell (consensus ${recWord(f.recMean)}${f.recMean ? `, ${f.recMean.toFixed(2)}` : ''})${f.targetMean ? `<br>Targets: ${fmtPx(f.targetLow)} low, ${fmtPx(f.targetMean)} average, ${fmtPx(f.targetHigh)} high (${fmtSigned(f.targetMean / R.price - 1, 0)} to the average)` : ''}${act ? `<br><br><strong>Recent moves</strong><br>${act}` : ''}${tail}`);
 }
 if (/dividend|yield|payout/.test(m)) {
  if (!f.dividendYield) return rich(kid ? 'Does it pay you?' : `${ticker}: dividend`, kid ? `No, ${name} doesn't pay owners cash right now.` : `${ticker} doesn't pay a dividend.`);
  return rich(kid ? 'Does it pay you?' : `${ticker}: dividend`, kid ? `Yes! It pays about $${(f.dividendYield * 100).toFixed(2)} a year for every $100 you own, just for holding it.` : `Yield ${fmtPlain(f.dividendYield, 2)}${f.dividendRate ? ` ($${f.dividendRate.toFixed(2)} per share a year)` : ''}${f.payoutRatio != null ? `, paying out ${fmtPlain(f.payoutRatio, 0)} of profit` : ''}.${tail}`);
 }
 if (/ceo|who runs|leadership|leader|founder|management|executive|boss/.test(m) && F?.profile?.officers?.length) {
  const o = F.profile.officers, clean = s => (s || '').replace(/^(Mr\.|Ms\.|Mrs\.|Dr\.)\s+/, '');
  return rich(kid ? `Who's in charge of ${name}?` : `${ticker}: leadership`, kid ? `The top boss is <strong>${clean(o[0].name)}</strong> (${o[0].title}).` : o.slice(0, adv ? 6 : 3).map(x => `• ${clean(x.name)}, ${x.title}${adv && x.pay ? ` (${fmtBig(x.pay)} pay)` : ''}`).join('<br>'));
 }
 return null;
}

/* ════════════════════════════════
 FORECAST ENGINE
 1. Volatility: RiskMetrics EWMA now, pulled back toward the 3-year average (GARCH-style)
 2. Expected return: CAPM baseline from beta to the S&P 500, nudged by 12-month momentum,
    the 50/200-day trend and the asset's own long-run growth (heavily shrunk)
 3. 4,000 paths with GARCH volatility, resampling the asset's own past shocks (fat tails kept)
 4. Walk-forward test: the same model, run at every week of the last 2 years using only the
    data available at the time, sets the range width and reports a true out-of-sample hit rate
════════════════════════════════ */
const FC_HORIZONS = [
 { id:'1W', label:'1 week', s:5, c:7 },
 { id:'1M', label:'1 month', s:21, c:30 },
 { id:'3M', label:'3 months', s:63, c:91 },
 { id:'6M', label:'6 months', s:126, c:182 },
 { id:'1Y', label:'1 year', s:252, c:365 },
];
const FC_PATHS = 4000;
const FC_GARCH = { a:0.05, b:0.935 }; // persistence 0.985 a day (half-life ~46 days)

function fcRng(seed) {
 let a = seed >>> 0;
 return () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}
function fcHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function fcQuant(sorted, q) { const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function fcPhi(x) {
 const t = 1 / (1 + 0.2316419 * Math.abs(x));
 const p = 0.3989423 * Math.exp(-x * x / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
 return x > 0 ? 1 - p : p;
}

function fcPrepare(hist, mkt, sym, isCrypto) {
 const c = hist.c, n = c.length;
 const ppy = isCrypto ? 365 : 252;
 const scale = isCrypto ? 365 / 252 : 1;
 const L = d => Math.round(d * scale);
 const r = new Float64Array(n - 1);
 for (let i = 1; i < n; i++) r[i - 1] = Math.log(c[i] / c[i - 1]);
 const sq = new Float64Array(r.length + 1);
 for (let i = 0; i < r.length; i++) sq[i + 1] = sq[i] + r[i] * r[i];
 // v[i] = variance forecast for r[i], made at close i
 const v = new Float64Array(n);
 const k0 = Math.min(40, r.length);
 v[0] = Math.max(1e-8, sq[k0] / k0);
 for (let i = 0; i < r.length; i++) v[i + 1] = 0.94 * v[i] + 0.06 * r[i] * r[i];

 // Align with the S&P 500 by calendar day for beta
 const P = { c, r, sq, v, n, ppy, L, isCrypto, sym, t: hist.t, kind: FC_FLAT.has(sym) ? 'flat' : FC_COMMODITY.has(sym) ? 'commodity' : isCrypto ? 'crypto' : 'equity' };
 P.isMarket = sym === '^GSPC';
 if (mkt && !P.isMarket) {
  const mDay = new Map();
  mkt.t.forEach((ts, i) => mDay.set(Math.floor(ts / 86400), mkt.c[i]));
  const ax = [], ay = [], alignAt = new Int32Array(n).fill(-1);
  let prevS = null, prevM = null, k = -1;
  for (let i = 0; i < n; i++) {
   const m = mDay.get(Math.floor(hist.t[i] / 86400));
   if (m != null) {
    if (prevS != null) { ax.push(Math.log(m / prevM)); ay.push(Math.log(c[i] / prevS)); k++; }
    prevS = c[i]; prevM = m;
   }
   alignAt[i] = k;
  }
  const N = ax.length, Sx = new Float64Array(N + 1), Sy = new Float64Array(N + 1), Sxy = new Float64Array(N + 1), Sxx = new Float64Array(N + 1), Syy = new Float64Array(N + 1);
  for (let j = 0; j < N; j++) { Sx[j + 1] = Sx[j] + ax[j]; Sy[j + 1] = Sy[j] + ay[j]; Sxy[j + 1] = Sxy[j] + ax[j] * ay[j]; Sxx[j + 1] = Sxx[j] + ax[j] * ax[j]; Syy[j + 1] = Syy[j] + ay[j] * ay[j]; }
  P.align = { alignAt, Sx, Sy, Sxy, Sxx, Syy };
  // Market backdrop today
  const mc = mkt.c, mn = mc.length;
  if (mn > 200) { let s = 0; for (let i = mn - 200; i < mn; i++) s += mc[i]; P.mktAbove200 = mc[mn - 1] > s / 200; P.mktVs200 = mc[mn - 1] / (s / 200) - 1; }
 }
 return P;
}

// Beta and correlation over ~1 year of aligned days ending at close i (Blume-adjusted beta)
function fcBetaAt(P, i) {
 if (P.isMarket) return { beta:1, corr:1 };
 const A = P.align;
 if (!A) return { beta: P.isCrypto ? 1.5 : 1, corr: null };
 const k = A.alignAt[i] + 1, w = Math.min(k, 252);
 if (w < 60) return { beta: P.isCrypto ? 1.5 : 1, corr: null };
 const s = k - w;
 const mx = (A.Sx[k] - A.Sx[s]) / w, my = (A.Sy[k] - A.Sy[s]) / w;
 const cov = (A.Sxy[k] - A.Sxy[s]) / w - mx * my;
 const vx = (A.Sxx[k] - A.Sxx[s]) / w - mx * mx, vy = (A.Syy[k] - A.Syy[s]) / w - my * my;
 const raw = vx > 0 ? cov / vx : 1;
 return { beta: 0.67 * raw + 0.33, rawBeta: raw, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null };
}

function fcLongRunVar(P, i) {
 const w = Math.min(i, P.ppy * 3);
 return w < 20 ? P.v[i] : (P.sq[i] - P.sq[i - w]) / w;
}
function fcVarSum(P, v0, lr, h) {
 const phi = FC_GARCH.a + FC_GARCH.b;
 return h * lr + (v0 - lr) * (1 - Math.pow(phi, h)) / (1 - phi);
}

function fcSignalsAt(P, t) {
 const { c, L } = P;
 const sma = len => { if (t + 1 < len) return null; let s = 0; for (let i = t - len + 1; i <= t; i++) s += c[i]; return s / len; };
 const price = c[t];
 const s50 = sma(L(50)), s200 = sma(L(200));
 const mom = t >= L(252) ? Math.log(c[t - L(21)] / c[t - L(252)]) : null;
 let rsi = null;
 if (t >= 40) {
  const st = Math.max(1, t - 150);
  let g = 0, l = 0;
  for (let i = st; i < st + 14; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= 14; l /= 14;
  for (let i = st + 14; i <= t; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
  rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
 }
 const back = Math.min(t, P.ppy * 5);
 const histAnn = back >= P.ppy ? Math.pow(c[t] / c[t - back], P.ppy / back) - 1 : null;
 return { price, s50, s200, mom, rsi, histAnn };
}

function fcDrift(P, sig, beta, volAnn) {
 const RF = 0.04, ERP = 0.05;
 const prior = P.kind === 'flat' ? 0 : P.kind === 'commodity' ? 0.03 : P.kind === 'crypto' ? 0.06 : RF + Math.max(0.3, Math.min(2.2, beta)) * ERP;
 if (P.kind === 'flat') return { e:0, prior:0, mom:0, trend:0, hist:0, shortAdj:0 };
 const mom = sig.mom == null ? 0 : 0.06 * volAnn * Math.max(-2, Math.min(2, sig.mom / Math.max(0.12, volAnn)));
 const trend = sig.s200 && sig.s50 ? 0.02 * volAnn * ((sig.price > sig.s200 ? 1 : -1) + (sig.s50 > sig.s200 ? 0.5 : -0.5)) : 0;
 const hist = sig.histAnn == null ? 0 : 0.1 * (Math.max(-0.5, Math.min(0.8, sig.histAnn)) - prior);
 const e = Math.max(-0.35, Math.min(0.45, prior + mom + trend + hist));
 const shortAdj = sig.rsi == null ? 0 : sig.rsi > 75 ? -0.006 : sig.rsi < 25 ? 0.006 : 0;
 return { e, prior, mom, trend, hist, shortAdj };
}

// Log-return mean over h days for a given drift, plus the variance
function fcMoments(P, d, v0, lr, h) {
 const varH = fcVarSum(P, v0, lr, h);
 const mu = Math.log(1 + d.e) * h / P.ppy + Math.log(1 + d.shortAdj) * Math.min(h, P.L(21)) / P.L(21) - 0.5 * varH;
 return { mu, varH };
}

// Weekly walk-forward test of the 1-month forecast over the last 2 years
function fcBacktest(P) {
 const h = P.L(21), step = P.L(5);
 const end = P.n - 1 - h;
 const start = Math.max(P.L(260), end - P.L(504));
 const rows = [];
 for (let t = start; t <= end; t += step) {
  const lr = fcLongRunVar(P, t);
  const volAnn = Math.sqrt(lr * P.ppy);
  const { beta } = fcBetaAt(P, t);
  const d = fcDrift(P, fcSignalsAt(P, t), beta, volAnn);
  const { mu, varH } = fcMoments(P, d, P.v[t], lr, h);
  const actual = Math.log(P.c[t + h] / P.c[t]);
  rows.push({ t, err: (actual - mu) / Math.sqrt(varH), callUp: mu > 0, wentUp: actual > 0 });
 }
 const cut = P.n - 1 - h - P.L(252);
 const calib = rows.filter(r => r.t < cut), test = rows.filter(r => r.t >= cut);
 let scale = 1;
 if (calib.length >= 20) {
  const q80 = fcQuant(calib.map(r => Math.abs(r.err)).sort((a, b) => a - b), 0.8);
  scale = Math.max(0.95, Math.min(1.6, 1 + 0.6 * (q80 / 1.2816 - 1)));
 }
 const set = test.length >= 15 ? test : null;
 return {
  scale,
  n: set ? set.length : 0,
  coverage: set ? set.filter(r => Math.abs(r.err) <= 1.2816 * scale).length / set.length : null,
  hit: set ? set.filter(r => r.callUp === r.wentUp).length / set.length : null,
  upShare: set ? set.filter(r => r.wentUp).length / set.length : null,
 };
}

function fcCompute(hist, mkt, sym, isCrypto, seedKey) {
 const P = fcPrepare(hist, mkt, sym, isCrypto);
 const t = P.n - 1;
 const lr = fcLongRunVar(P, t);
 const v0 = P.v[t];
 const volNow = Math.sqrt(v0 * P.ppy), volNormal = Math.sqrt(lr * P.ppy);
 const bc = fcBetaAt(P, t);
 const sig = fcSignalsAt(P, t);
 const d = fcDrift(P, sig, bc.beta, volNormal);
 const bt = fcBacktest(P);
 const price = Number.isFinite(hist.price) && hist.price > 0 ? hist.price : P.c[t];

 // Standardised past shocks (last 3 years), re-centred to mean 0 and variance 1
 const zs = [];
 for (let i = Math.max(0, P.r.length - P.ppy * 3); i < P.r.length; i++) zs.push(P.r[i] / Math.sqrt(P.v[i]));
 const zm = zs.reduce((s, x) => s + x, 0) / zs.length;
 const zsd = Math.sqrt(zs.reduce((s, x) => s + (x - zm) ** 2, 0) / zs.length) || 1;
 const Z = Float64Array.from(zs, x => Math.max(-8, Math.min(8, (x - zm) / zsd)));

 const H = isCrypto ? 365 : 252;
 const hzDays = FC_HORIZONS.map(h => isCrypto ? h.c : h.s);
 const step = Math.max(1, Math.round(H / 120));
 const cps = [];
 for (let k = step; k < H; k += step) cps.push(k);
 hzDays.forEach(k => { if (!cps.includes(k)) cps.push(k); });
 cps.sort((a, b) => a - b);
 const cpIndex = new Int32Array(H + 1).fill(-1);
 cps.forEach((k, j) => { cpIndex[k] = j; });

 const K = cps.length, out = new Float32Array(FC_PATHS * K);
 const rnd = fcRng(fcHash(seedKey));
 const muD = Math.log(1 + d.e) / P.ppy, shortD = Math.log(1 + d.shortAdj) / P.L(21), shortN = P.L(21);
 const omega = lr * (1 - FC_GARCH.a - FC_GARCH.b), s = bt.scale;
 const vCap = lr * 25;
 for (let p = 0; p < FC_PATHS; p++) {
  let lp = 0, v = v0;
  for (let k = 1; k <= H; k++) {
   const sd = Math.sqrt(v);
   const shock = sd * Z[(rnd() * Z.length) | 0];
   lp += muD + (k <= shortN ? shortD : 0) - 0.5 * v * s * s + shock * s;
   v = Math.min(vCap, omega + FC_GARCH.a * shock * shock + FC_GARCH.b * v);
   const j = cpIndex[k];
   if (j >= 0) out[p * K + j] = lp;
  }
 }
 const col = new Float64Array(FC_PATHS);
 const fan = cps.map((k, j) => {
  for (let p = 0; p < FC_PATHS; p++) col[p] = out[p * K + j];
  col.sort();
  let up = 0, mean = 0;
  for (let p = 0; p < FC_PATHS; p++) { if (col[p] > 0) up++; mean += Math.exp(col[p]); }
  const q = x => price * Math.exp(fcQuant(col, x));
  return { d:k, p10:q(0.1), p25:q(0.25), p50:q(0.5), p75:q(0.75), p90:q(0.9), pUp: up / FC_PATHS, mean: price * mean / FC_PATHS };
 });
 const at = k => fan.find(f => f.d === k);
 const horizons = FC_HORIZONS.map((h, i) => ({ ...h, days: hzDays[i], ...at(hzDays[i]) }));

 // Extra context for the signal list
 const L = P.L, c = P.c;
 const yr = Math.min(t, L(252));
 let hi = 0, lo = Infinity, peak = 0, maxDD = 0;
 for (let i = t - yr; i <= t; i++) { hi = Math.max(hi, c[i]); lo = Math.min(lo, c[i]); peak = Math.max(peak, c[i]); maxDD = Math.min(maxDD, c[i] / peak - 1); }
 return {
  P, price, horizons, fan, sig, drift: d, backtest: bt,
  stats: { volNow, volNormal, beta: bc.beta, corr: bc.corr, ret1y: c[t] / c[t - yr] - 1, hi52: hi, lo52: lo, fromHigh: price / hi - 1, maxDD, cagr: sig.histAnn, years: (hist.t[t] - hist.t[0]) / 31557600 },
  mkt: { above200: P.mktAbove200, vs200: P.mktVs200 },
  source: hist.source || 'Yahoo Finance', asOf: hist.t[t] * 1000,
 };
}

/* ════════════════════════════════
 PAGE HEADER + "HOW IT WORKS" GUIDES
 Every tab except Markets gets a title row with a guide button.
 The guide slides in, explains the tab, and "Show me" spotlights the real control.
════════════════════════════════ */
const TG_ICONS = {
 w:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
 port:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>',
 screen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
 cmp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/><path d="M18 15v-3a3 3 0 0 0-3-3H9"/></svg>',
 pt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
 day:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
};

const TAB_GUIDES = {
 w: {
  title:'Watchlist',
  sub: () => `${watchlist.length} saved · live charts`,
  lead:'Your shortlist of stocks, ETFs and crypto. Every card is a live chart, so you can check everything you care about at a glance instead of searching for each one.',
  uses:[['Track ideas','Keep an eye on companies you might buy.'],['Follow what you own','Check prices without logging into your broker.'],['Catch big moves','Spot a sharp drop or jump, then dig in.']],
  steps:[
   ['Find a stock','Search any company in the bar at the top and open its page.','#si'],
   ['Save it','Tap + Watchlist under the name. It appears here right away.',null],
   ['Open the full picture','Hit View Full Chart on a card for the AI verdict, forecast and news.','#mainContent .wl-card'],
   ['Keep it tidy','Open a stock and tap Saved to take it off your list.',null],
  ],
  terms:[['Ticker','The short code a stock trades under, like AAPL for Apple.'],['Intraday chart','How the price moved during today\'s session.'],['After-hours','Trading before 9:30am or after 4pm ET. Prices can jump on thin volume.']],
  tip:'Keep it to 10 to 15 names. A focused list is one you\'ll actually follow.',
 },
 port: {
  title:'Portfolio',
  sub: () => {
   const nm = typeof portfolioName === 'string' && portfolioName && portfolioName !== 'My Portfolio' ? portfolioName + ' · ' : '';
   return nm + (holdings.length ? `${holdings.length} holding${holdings.length !== 1 ? 's' : ''} · live prices` : 'Track the investments you own');
  },
  action: () => `<button type="button" class="vh-btn vh-main" id="vhAddHolding" onclick="openHoldModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Add holding</span></button>`,
  lead:'Track the real investments you own, wherever you bought them. Add a position and StockSight shows what it\'s worth today at live prices, your profit or loss, and how your money is split.',
  uses:[['One total','See your gain or loss across every broker in one place.'],['Spot risk','Notice when one stock or sector is too big a slice.'],['Plan moves','Try what-if scenarios before you rebalance.']],
  steps:[
   ['Add a holding','Click Add holding, pick the ticker, then enter shares and price, or just the total you invested.','#vhAddHolding'],
   ['Read the table','Price now is the live market price. P&L compares it with what you paid.','#mainContent .port-table-wrap'],
   ['Explore the tabs','Allocation, Growth, Rebalance and What if each look at your money a different way.','#mainContent > .ss-tabs'],
   ['Sold something?','Remove it with the x at the end of its row.',null],
  ],
  terms:[['Cost basis','What you paid in total: shares times your buy price.'],['P&L','Profit and loss. It stays "unrealized" until you sell.'],['Allocation','How your money is split across your holdings.']],
  tip:'If one holding is more than a quarter of your portfolio, one bad quarter for that company can hit your whole account.',
 },
 screen: {
  title:'Screener',
  sub: () => 'Find ideas by description or by the numbers',
  lead:'Go from "I want safe dividend stocks" to a shortlist in seconds. Describe what you\'re after in plain English, or filter by sector, risk, growth, momentum and AI verdict.',
  uses:[['Discover','Find companies you haven\'t heard of yet.'],['Narrow down','Cut a whole sector to the lower-risk names.'],['Follow the AI','List everything rated Buy or better.']],
  steps:[
   ['Describe it','Type an idea like "high growth AI companies" or tap a suggestion.','#scr-narrative'],
   ['Filter','Pick a sector, risk level, growth rate, RSI range or AI verdict.','#scr-filter-row'],
   ['Open a result','Results sort by growth. Click any ticker to open its full page.','#scr-results'],
   ['Save the setup','Name a filter combination and save it to reuse later.','#scr-presets-row'],
  ],
  terms:[['Beta','How much it moves versus the market. 1.5x means about 50% bigger swings.'],['RSI','A 0 to 100 momentum gauge. Over 70 is stretched up, under 30 stretched down.'],['Growth / yr','Average yearly price growth over about 5 years. Not a promise.']],
  tip:'A screener is a starting point, not an answer. Read each result\'s AI analysis and forecast before you decide.',
 },
 cmp: {
  title:'Compare',
  sub: () => 'Two assets, side by side',
  lead:'Put two stocks, ETFs or coins next to each other to see which is riskier, which has grown faster and how the AI rates each one.',
  uses:[['Pick between rivals','Apple vs Microsoft, Visa vs Mastercard.'],['Stock vs fund','Check a single stock against an ETF like VOO.'],['Gauge crypto','See how Bitcoin\'s swings compare with the S&P 500.']],
  steps:[
   ['Choose asset A','Type a ticker or company name in the first box.','#cA'],
   ['Choose asset B','Do the same in the second box.','#cB'],
   ['Compare','See risk, growth, AI verdict and charts side by side.','#mainContent .btn-cmp'],
  ],
  terms:[['Volatility','How much the price swings in a year. Higher means a bumpier ride.'],['AI verdict','StockSight\'s plain-English Buy, Hold or Sell view of the business.']],
  tip:'Compare like with like. Two companies in the same industry tell you more than a stock versus a coin.',
 },
 pt: {
  title:'Paper Trading',
  sub: () => 'Practice with $10,000 of virtual money',
  lead:'Practice investing with $10,000 of pretend money. Buy and sell stocks and crypto with zero risk, learn how orders and P&L work, and build confidence before you use real money.',
  uses:[['Test a strategy','Try an idea before real money is on the line.'],['Learn the mechanics','See how buying, selling and returns actually work.'],['Compete','Climb the leaderboard against other StockSight users.']],
  steps:[
   ['Place a trade','Click New Trade, or Paper trade on any stock page. Choose shares or a dollar amount.','#mainContent .pt-btn'],
   ['Watch your account','Total value, cash and return update as prices move.','#pt-stats-row'],
   ['Manage positions','Buy more or sell straight from Open Positions.','#mainContent > .pt-pos'],
   ['Review','Allocation, Risk lab and Insight show what you do well and where you\'re exposed.','#mainContent > .ss-tabs'],
  ],
  terms:[['Buying power','Cash you have left to buy with.'],['Average cost','The average price you paid across all your buys of one stock.'],['Market order','Fills at the current price. Orders placed while the market is closed fill at the next open.']],
  tip:'Trade it like it\'s real. Sizing positions the way you would with your own money is what makes the practice count.',
 },
 day: {
  title:'Day Trade',
  sub: () => 'Replay a real trading day, minute by minute',
  lead:'A day-trading simulator built on real data. Replay an actual trading day from the last two weeks, minute by minute, go long or short, and use stops and targets the way day traders do, without risking a cent.',
  uses:[['Read price action','Practice spotting intraday trends and reversals.'],['Size trades','Learn how many shares fit your risk budget.'],['Build discipline','Journal every trade and review your numbers.']],
  steps:[
   ['Start the session','Pick a ticker, then press Play. Change the speed or step one minute at a time.','#dtPlayBtn'],
   ['Open a trade','Set shares, an optional stop and target, then Buy / Long or Sell / Short.','#dtOrderPanel'],
   ['Size it right','The Position sizer works out shares that keep a loss inside your risk budget.','#mainContent > #dtGrid'],
   ['Close out','Positions close automatically at the bell. Check Your numbers and Journal after.',null],
  ],
  terms:[['Long / short','Long makes money if the price rises. Short makes money if it falls.'],['Stop loss','A price where you exit to cap the loss.'],['Risk per trade','The most you\'ll lose on one trade, often 1% of the account.']],
  tip:'Most new day traders lose money. Use this to build the habit that matters most: set your stop before you enter.',
 },
};

function guideSeen(t) { return !!getLearn().guides?.[t]; }

function setViewHead(t) {
 const vh = document.getElementById('viewHead');
 if (!vh) return;
 const g = t && TAB_GUIDES[t];
 if (!g) { vh.hidden = true; document.body.classList.remove('has-vh'); return; }
 vh.dataset.tab = t;
 vh.innerHTML = `
  <div class="vh-txt"><span class="vh-ico">${TG_ICONS[t] || ''}</span><div><h1>${g.title}</h1><p>${g.sub()}</p></div></div>
  <div class="vh-actions">
   ${g.action ? g.action() : ''}
   <button type="button" class="vh-btn vh-guide${guideSeen(t) ? '' : ' fresh'}" onclick="openTabGuide('${t}')" aria-haspopup="dialog">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span>How it works</span><i class="vh-dot" aria-hidden="true"></i>
   </button>
  </div>`;
 vh.hidden = false;
 document.body.classList.add('has-vh');
 vh.classList.remove('vh-in'); void vh.offsetWidth; vh.classList.add('vh-in');
}
function refreshViewHeadSub() {
 const vh = document.getElementById('viewHead'), t = vh?.dataset.tab;
 const p = vh && !vh.hidden && vh.querySelector('.vh-txt p');
 if (p && TAB_GUIDES[t]) p.textContent = TAB_GUIDES[t].sub();
}

let _tgLastFocus = null;
function openTabGuide(t) {
 const g = TAB_GUIDES[t]; if (!g) return;
 const box = document.getElementById('tabGuide'); if (!box) return;
 _tgLastFocus = document.activeElement;
 const fresh = !guideSeen(t);
 box.dataset.tab = t;
 box.querySelector('.tg-panel').innerHTML = `
  <header class="tg-head">
   <span class="tg-ico">${TG_ICONS[t] || ''}</span>
   <div><small>How it works</small><h2 id="tgTitle">${g.title}</h2></div>
   <button type="button" class="tg-x" onclick="closeTabGuide()" aria-label="Close guide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </header>
  <div class="tg-body">
   <p class="tg-lead">${g.lead}</p>
   <section class="tg-sec"><h3>Use it to</h3>
    <div class="tg-uses">${g.uses.map(([a, b], i) => `<div class="tg-use"><b><i>${i + 1}</i>${a}</b><span>${b}</span></div>`).join('')}</div>
   </section>
   <section class="tg-sec"><h3>How to use it</h3>
    <ol class="tg-steps">${g.steps.map(([a, b, sel]) => `<li><div><b>${a}</b><span>${b}</span></div>${sel ? `<button type="button" class="tg-show" onclick="tgShowMe('${sel}')">Show me</button>` : ''}</li>`).join('')}</ol>
   </section>
   <section class="tg-sec"><h3>Words to know</h3>
    <dl class="tg-terms">${g.terms.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl>
   </section>
   <div class="tg-tip"><b>Pro tip</b><p>${g.tip}</p></div>
  </div>
  <footer class="tg-foot">
   ${fresh ? '<span class="tg-xp">+10 XP for reading</span>' : '<span class="tg-xp done">Read</span>'}
   <button type="button" class="tg-ok" onclick="closeTabGuide(true)">Got it</button>
  </footer>`;
 box.hidden = false;
 box.setAttribute('aria-hidden', 'false');
 void box.offsetWidth;
 box.classList.add('open');
 box.querySelector('.tg-ok')?.focus({ preventScroll:true });
}
function closeTabGuide(done) {
 const box = document.getElementById('tabGuide');
 if (!box || box.hidden) return;
 const t = box.dataset.tab;
 if (done && t && !guideSeen(t)) {
  const s = getLearn(); s.guides = { ...(s.guides || {}), [t]: 1 }; saveLearn(s);
  learnAddXP(10);
  document.querySelector('.vh-guide')?.classList.remove('fresh');
 }
 box.classList.remove('open');
 box.setAttribute('aria-hidden', 'true');
 setTimeout(() => { if (!box.classList.contains('open')) box.hidden = true; }, 380);
 if (_tgLastFocus && document.body.contains(_tgLastFocus)) _tgLastFocus.focus({ preventScroll:true });
}
function tgShowMe(sel) {
 closeTabGuide(true);
 setTimeout(() => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.scrollIntoView({ behavior:'smooth', block:'center', inline:'nearest' });
  el.classList.remove('tg-spot'); void el.offsetWidth; el.classList.add('tg-spot');
  setTimeout(() => el.classList.remove('tg-spot'), 2600);
 }, 320);
}
document.addEventListener('keydown', e => {
 const box = document.getElementById('tabGuide');
 if (e.key === 'Escape' && box && !box.hidden) { e.stopPropagation(); closeTabGuide(); }
}, true);

/* ── Forecast UI ── */
function fcMoney(v) {
 const sym = {USD:'$',EUR:'€',GBP:'£',JPY:'¥'}[currency] || '$';
 const cv = v * ({USD:1,EUR:0.92,GBP:0.79,JPY:149.5}[currency] || 1);
 const a = Math.abs(cv);
 const s = a >= 10000 ? cv.toLocaleString('en-US', {maximumFractionDigits:0}) : a >= 1 ? cv.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : a >= 0.01 ? cv.toFixed(4) : cv.toPrecision(3);
 return sym + s;
}
function fcPctTxt(x, digits = 1) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(digits) + '%'; }

function fcSignalList(R, ticker) {
 const { sig, stats, mkt } = R, out = [];
 const simple = mode === 'simple' || mode === 'beginner';
 if (sig.s200 && sig.s50) {
  const vs = sig.price / sig.s200 - 1, golden = sig.s50 > sig.s200;
  const tone = vs > 0 && golden ? 'up' : vs < 0 && !golden ? 'down' : 'mixed';
  out.push({ k: simple ? 'Price trend' : 'Trend (200-day)', v: `${fcPctTxt(vs)} vs 200-day avg`, tone,
   why: tone === 'up' ? `${ticker} is above its 200-day average and its 50-day average is above the 200-day. Uptrends like this have tended to continue slightly more often than not.`
      : tone === 'down' ? `${ticker} is below its 200-day average and the 50-day is below the 200-day. Downtrends have tended to persist a little more often than they reverse.`
      : `The short and long trends disagree, so the trend adds little either way right now.` });
 }
 if (sig.mom != null) {
  const m = Math.exp(sig.mom) - 1;
  out.push({ k: simple ? 'Last 12 months' : 'Momentum (12-1 mo)', v: fcPctTxt(m, 0), tone: m > 0.1 ? 'up' : m < -0.1 ? 'down' : 'mixed',
   why: `Return over the past year, skipping the latest month. Assets with strong 12-month gains have historically done slightly better over the next few months, and weak ones slightly worse.` });
 }
 if (sig.rsi != null) {
  const r = sig.rsi;
  out.push({ k:'RSI (14-day)', v: r.toFixed(0) + (r > 70 ? ' overbought' : r < 30 ? ' oversold' : ''), tone: r > 70 ? 'down' : r < 30 ? 'up' : 'mixed',
   why: r > 70 ? 'Prices rose fast recently. After stretches like this, short pullbacks are a bit more common, so the next month is trimmed slightly.'
      : r < 30 ? 'Prices fell fast recently. After stretches like this, short bounces are a bit more common, so the next month is lifted slightly.'
      : 'Recent buying and selling pressure is balanced, so this has no effect on the forecast.' });
 }
 const calm = stats.volNow < stats.volNormal * 0.9, wild = stats.volNow > stats.volNormal * 1.15;
 out.push({ k: simple ? 'How much it swings' : 'Volatility', v: `${(stats.volNow * 100).toFixed(0)}%/yr ${calm ? 'calmer than usual' : wild ? 'choppier than usual' : 'about normal'}`, tone: wild ? 'down' : 'mixed',
  why: `Typical yearly swing is ${(stats.volNormal * 100).toFixed(0)}%. Right now it is ${(stats.volNow * 100).toFixed(0)}%. This sets how wide the price range is, and the model expects it to drift back toward normal.` });
 if (!R.P.isMarket && R.P.align) {
  out.push({ k: simple ? 'Moves with the market' : 'Beta to S&P 500', v: `${stats.beta.toFixed(2)}x${stats.corr != null ? ` · corr ${stats.corr.toFixed(2)}` : ''}`, tone:'mixed',
   why: `On a typical day ${ticker} moves about ${stats.beta.toFixed(1)}x as much as the S&P 500. Higher beta means a higher expected return in the model, but bigger drops when the market falls.` });
 }
 out.push({ k:'52-week high', v: stats.fromHigh > -0.005 ? 'At the high' : `${fcPctTxt(stats.fromHigh)} below`, tone: stats.fromHigh > -0.05 ? 'up' : stats.fromHigh < -0.25 ? 'down' : 'mixed',
  why: `Range over the past year: ${fcMoney(stats.lo52)} to ${fcMoney(stats.hi52)}. The biggest drop from a peak in that time was ${fcPctTxt(stats.maxDD, 0)}.` });
 if (mkt.above200 != null && !R.P.isMarket) {
  out.push({ k: simple ? 'Overall market' : 'Market backdrop', v: mkt.above200 ? 'S&P 500 in an uptrend' : 'S&P 500 in a downtrend', tone: mkt.above200 ? 'up' : 'down',
   why: `The S&P 500 is ${fcPctTxt(mkt.vs200)} vs its 200-day average. Most stocks rise and fall with the market, so this is useful context.` });
 }
 return out;
}

function fcOutlook(h) {
 return h.pUp >= 0.6 ? { cls:'up', txt:'Leaning up' } : h.pUp >= 0.53 ? { cls:'up', txt:'Slightly positive' } : h.pUp > 0.47 ? { cls:'mixed', txt:'Balanced' } : h.pUp > 0.4 ? { cls:'down', txt:'Slightly negative' } : { cls:'down', txt:'Leaning down' };
}

function fcHeadHTML(R, ticker, hz) {
 const h = R.horizons[hz], o = fcOutlook(h);
 const simple = mode === 'simple' || mode === 'beginner';
 return `
  <h3 class="fc-title"><b class="fc-${o.cls}">${o.txt}</b><span>${Math.round(h.pUp * 100)}% chance ${ticker} is higher in ${h.label}</span></h3>
  <p class="fc-sub">${simple ? 'Most likely price' : 'Median'} <b>${fcMoney(h.p50)}</b> (${fcPctTxt(h.p50 / R.price - 1)}). 8 in 10 outcomes land between <b>${fcMoney(h.p10)}</b> and <b>${fcMoney(h.p90)}</b>.</p>`;
}
function fcCasesHTML(R, hz) {
 const h = R.horizons[hz], simple = mode === 'simple' || mode === 'beginner';
 const cell = (cls, lbl, v, note) => `<div class="fc-case ${cls}"><span>${lbl}</span><b>${fcMoney(v)}</b><small>${fcPctTxt(v / R.price - 1)}${note ? ' · ' + note : ''}</small></div>`;
 return cell('bear', simple ? 'If it goes badly' : 'Bear case', h.p10, '1 in 10 lower')
  + cell('base', simple ? 'Most likely' : 'Median', h.p50, '')
  + cell('bull', simple ? 'If it goes well' : 'Bull case', h.p90, '1 in 10 higher')
  + `<div class="fc-case odds"><span>Chance higher</span><b>${Math.round(h.pUp * 100)}%</b><i><em style="width:${(h.pUp * 100).toFixed(0)}%"></em></i></div>`;
}

function fcHTML(R, ticker, hz) {
 const bt = R.backtest, yrs = Math.max(1, Math.round(R.stats.years));
 const sigs = fcSignalList(R, ticker);
 const asOf = new Date(R.asOf).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
 const covPct = bt.coverage == null ? null : Math.round(bt.coverage * 100);
 const d = R.drift;
 return `
 <div class="fc">
  <div class="fc-top">
   <div class="fc-head" id="fcHead">${fcHeadHTML(R, ticker, hz)}</div>
   <div class="fc-hz" role="group" aria-label="Forecast horizon">${R.horizons.map((h, i) => `<button type="button" class="${i === hz ? 'on' : ''}" onclick="fcSetHorizon(${i})">${h.id}</button>`).join('')}</div>
  </div>
  <div class="fc-chart" id="fcChart"><canvas></canvas><div class="fc-tip" hidden></div></div>
  <div class="fc-cases" id="fcCases">${fcCasesHTML(R, hz)}</div>
  <div class="fc-grid">
   <section class="fc-box">
    <h4>What's driving it</h4>
    <ul class="fc-sigs">${sigs.map(s => `<li class="fc-sig ${s.tone}" tabindex="0"><i></i><span>${s.k}</span><b>${s.v}</b><p>${s.why}</p></li>`).join('')}</ul>
   </section>
   <section class="fc-box fc-acc">
    <h4>How accurate is it?</h4>
    ${covPct != null ? `
    <div class="fc-acc-row">
     <span class="lv-ring lv-ring-lg" style="--p:${covPct}"><b>${covPct}%</b></span>
     <p>Over the last year, ${ticker}'s real price landed inside the 1-month 80% range <b>${covPct}%</b> of the time (${bt.n} weekly tests, aiming for 80%). The up or down call was right <b>${Math.round(bt.hit * 100)}%</b> of the time.</p>
    </div>` : `<p class="fc-muted">Not enough history yet to test this one fairly. Treat the range as a rough guide.</p>`}
    <details class="fc-how">
     <summary>How the model works</summary>
     <p>Built from ${yrs} year${yrs > 1 ? 's' : ''} of real daily prices (${R.source}, as of ${asOf}).</p>
     <ul>
      <li><b>Range width</b> comes from ${ticker}'s own volatility, which the model expects to drift from today's ${(R.stats.volNow * 100).toFixed(0)}% back toward its normal ${(R.stats.volNormal * 100).toFixed(0)}%.</li>
      <li><b>Expected return</b> starts at ${fcPctTxt(d.prior)} a year${R.P.kind === 'equity' ? ' (cash rate plus market risk premium, scaled by beta)' : ''}, then momentum ${fcPctTxt(d.mom)}, trend ${fcPctTxt(d.trend)} and long-run growth ${fcPctTxt(d.hist)} for ${fcPctTxt(d.e)} total.</li>
      <li><b>${FC_PATHS.toLocaleString()} simulated paths</b> reuse ${ticker}'s real past daily moves, so crashes and spikes show up as often as they did before.</li>
      <li><b>Self-check:</b> the same model was rerun every week over the last 2 years using only data available at the time, and the range was ${bt.scale > 1.02 ? 'widened' : bt.scale < 0.98 ? 'narrowed' : 'kept'} to match how ${ticker} actually moved.</li>
     </ul>
    </details>
   </section>
  </div>
  <p class="fc-foot">An estimate from past prices, not a promise or financial advice. ${mode === 'simple' || mode === 'beginner' ? 'Should you buy?' : 'AI analysis'} covers the business itself.</p>
 </div>`;
}

function fcSetHorizon(i) {
 const F = window._fc; if (!F) return;
 F.hz = i;
 document.querySelectorAll('.fc-hz button').forEach((b, j) => b.classList.toggle('on', j === i));
 const head = document.getElementById('fcHead'), cases = document.getElementById('fcCases');
 if (head) head.innerHTML = fcHeadHTML(F.R, F.ticker, i);
 if (cases) { cases.innerHTML = fcCasesHTML(F.R, i); cases.classList.remove('fc-pop'); void cases.offsetWidth; cases.classList.add('fc-pop'); }
 fcAnimateChart();
}

function fcColors() {
 const cs = getComputedStyle(document.body);
 const g = n => cs.getPropertyValue(n).trim();
 return { accent: g('--accent') || '#6c5ce7', green: g('--green') || '#00c97a', red: g('--red') || '#ff3860', text: g('--text') || '#111', text3: g('--text3') || '#888', border: g('--border') || 'rgba(0,0,0,.08)', card: g('--card') || '#fff' };
}
function fcAlpha(hex, a) {
 const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
 if (!m) return hex;
 const n = parseInt(m[1], 16);
 return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function fcDrawChart(progress = 1, hoverX = null) {
 const F = window._fc, host = document.getElementById('fcChart');
 if (!F || !host) return;
 const cv = host.querySelector('canvas'), tip = host.querySelector('.fc-tip');
 const R = F.R, P = R.P, h = R.horizons[F.hz];
 const W = host.clientWidth, Hh = host.clientHeight;
 if (!W || !Hh) return;
 const dpr = Math.min(window.devicePixelRatio || 1, 2);
 cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
 cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
 const ctx = cv.getContext('2d'); if (!ctx) return;
 ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
 ctx.clearRect(0, 0, W, Hh);
 const C = fcColors();
 const histN = Math.min(P.n, P.L([63, 126, 252, 378, 504][F.hz]));
 const start = P.n - histN;
 const fan = [{ d:0, p10:R.price, p25:R.price, p50:R.price, p75:R.price, p90:R.price }, ...R.fan.filter(f => f.d <= h.days)];
 const total = histN - 1 + h.days;
 const PADL = 8, PADR = 64, PADT = 14, PADB = 22;
 const cw = W - PADL - PADR, ch = Hh - PADT - PADB;
 let lo = Infinity, hi = -Infinity;
 for (let i = start; i < P.n; i++) { lo = Math.min(lo, P.c[i]); hi = Math.max(hi, P.c[i]); }
 fan.forEach(f => { lo = Math.min(lo, f.p10); hi = Math.max(hi, f.p90); });
 lo = Math.min(lo, R.price); hi = Math.max(hi, R.price);
 const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
 const X = i => PADL + (i / total) * cw;
 const Y = v => PADT + ch - (v - lo) / (hi - lo) * ch;
 const todayX = X(histN - 1);

 // end-of-horizon tags (placed first so axis labels can make room)
 const lastF = fan[fan.length - 1];
 const tags = [[lastF.p90, C.green, '#fff'], [lastF.p50, C.text, C.card], [lastF.p10, C.red, '#fff']];
 let prevTag = -99;
 const tagY = tags.map(([v]) => { let y = Y(v); if (y - prevTag < 18) y = prevTag + 18; prevTag = y; return y; });
 // grid + price labels
 ctx.font = '11px Geist, system-ui, sans-serif';
 ctx.textBaseline = 'middle';
 for (let g = 0; g <= 4; g++) {
  const v = lo + (hi - lo) * (g / 4), y = Y(v);
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PADL, Math.round(y) + .5); ctx.lineTo(W - PADR + 6, Math.round(y) + .5); ctx.stroke();
  if (progress >= 1 && tagY.some(ty => Math.abs(ty - y) < 14)) continue;
  ctx.fillStyle = C.text3; ctx.textAlign = 'left';
  ctx.fillText(fcMoney(v), W - PADR + 10, y);
 }
 // month labels on the history side
 ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
 let lastM = -1, lastX = -99;
 for (let i = start; i < P.n; i++) {
  const dt = new Date(P.t[i] * 1000), m = dt.getUTCMonth();
  if (m !== lastM) {
   const x = X(i - start);
   if (lastM !== -1 && x - lastX > 44 && x < todayX - 24) { ctx.fillStyle = C.text3; ctx.fillText(dt.toLocaleDateString('en-US', { month:'short', timeZone:'UTC' }) + (m === 0 ? ' ' + String(dt.getUTCFullYear()).slice(2) : ''), x, Hh - 6); lastX = x; }
   lastM = m;
  }
 }
 ctx.fillStyle = C.text3; ctx.fillText('Today', todayX, Hh - 6);
 ctx.textAlign = 'right'; ctx.fillText('+' + h.id, PADL + cw, Hh - 6);

 // history area + line
 const grad = ctx.createLinearGradient(0, PADT, 0, PADT + ch);
 grad.addColorStop(0, fcAlpha(C.text, 0.08)); grad.addColorStop(1, fcAlpha(C.text, 0));
 ctx.beginPath();
 for (let i = start; i < P.n; i++) ctx[i === start ? 'moveTo' : 'lineTo'](X(i - start), Y(P.c[i]));
 ctx.lineTo(todayX, PADT + ch); ctx.lineTo(X(0), PADT + ch); ctx.closePath();
 ctx.fillStyle = grad; ctx.fill();
 ctx.beginPath();
 for (let i = start; i < P.n; i++) ctx[i === start ? 'moveTo' : 'lineTo'](X(i - start), Y(P.c[i]));
 ctx.strokeStyle = C.text; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();

 // forecast cone, revealed left to right
 const fx = f => X(histN - 1 + f.d);
 ctx.save();
 ctx.beginPath(); ctx.rect(todayX, 0, (W - PADR - todayX) * progress + 1, Hh); ctx.clip();
 const band = (a, b, alpha) => {
  ctx.beginPath();
  fan.forEach((f, i) => ctx[i ? 'lineTo' : 'moveTo'](fx(f), Y(f[a])));
  for (let i = fan.length - 1; i >= 0; i--) ctx.lineTo(fx(fan[i]), Y(fan[i][b]));
  ctx.closePath(); ctx.fillStyle = fcAlpha(C.accent, alpha); ctx.fill();
 };
 band('p90', 'p10', 0.12);
 band('p75', 'p25', 0.2);
 ctx.beginPath();
 fan.forEach((f, i) => ctx[i ? 'lineTo' : 'moveTo'](fx(f), Y(f.p50)));
 ctx.setLineDash([6, 5]); ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
 ctx.restore();

 // today marker
 ctx.strokeStyle = fcAlpha(C.text3, 0.6); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(Math.round(todayX) + .5, PADT); ctx.lineTo(Math.round(todayX) + .5, PADT + ch); ctx.stroke(); ctx.setLineDash([]);
 ctx.beginPath(); ctx.arc(todayX, Y(R.price), 4, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill();
 ctx.strokeStyle = C.card; ctx.lineWidth = 2; ctx.stroke();

 // end tags
 if (progress >= 1) {
  tags.forEach(([v, col, ink], ti) => {
   const y = tagY[ti];
   ctx.fillStyle = col;
   ctx.beginPath(); ctx.roundRect(W - PADR + 4, y - 9, PADR - 6, 18, 5); ctx.fill();
   ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 10.5px Geist, system-ui, sans-serif';
   ctx.fillText(fcMoney(v), W - PADR + 4 + (PADR - 6) / 2, y + .5);
  });
 }

 // hover
 if (hoverX != null && tip) {
  const idx = Math.max(0, Math.min(total, Math.round((hoverX - PADL) / cw * total)));
  let html, px, py;
  if (idx <= histN - 1) {
   const i = start + idx;
   px = X(idx); py = Y(P.c[i]);
   html = `<small>${new Date(P.t[i] * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' })}</small><b>${fcMoney(P.c[i])}</b>`;
  } else {
   const dd = idx - (histN - 1);
   let a = fan[0], b = fan[fan.length - 1];
   for (let j = 1; j < fan.length; j++) if (fan[j].d >= dd) { a = fan[j - 1]; b = fan[j]; break; }
   const f = (b.d - a.d) ? (dd - a.d) / (b.d - a.d) : 0;
   const lerp = k => a[k] + (b[k] - a[k]) * f;
   px = X(idx); py = Y(lerp('p50'));
   const when = new Date(Date.now() + dd * (P.isCrypto ? 1 : 7 / 5) * 86400000);
   html = `<small>${when.toLocaleDateString('en-US', { month:'short', day:'numeric' })} (forecast)</small><b>${fcMoney(lerp('p50'))}</b><small>80% range ${fcMoney(lerp('p10'))} to ${fcMoney(lerp('p90'))}</small>`;
  }
  ctx.strokeStyle = fcAlpha(C.text3, 0.5); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(px) + .5, PADT); ctx.lineTo(Math.round(px) + .5, PADT + ch); ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fillStyle = idx <= histN - 1 ? C.text : C.accent; ctx.fill();
  ctx.strokeStyle = C.card; ctx.lineWidth = 2; ctx.stroke();
  tip.hidden = false; tip.innerHTML = html;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(4, Math.min(W - tw - 4, px + 12 > W - tw - PADR ? px - tw - 12 : px + 12)) + 'px';
  tip.style.top = Math.max(4, Math.min(Hh - tip.offsetHeight - 4, py - 22)) + 'px';
 } else if (tip) tip.hidden = true;
}

function fcAnimateChart() {
 const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
 if (reduce) return fcDrawChart(1);
 const t0 = performance.now(), dur = 700;
 const tick = now => {
  const k = Math.min(1, (now - t0) / dur);
  fcDrawChart(1 - Math.pow(1 - k, 3));
  if (k < 1 && window._fc) requestAnimationFrame(tick);
 };
 requestAnimationFrame(tick);
}

function fcBindChart() {
 const host = document.getElementById('fcChart'); if (!host) return;
 const cv = host.querySelector('canvas');
 const move = e => { const r = cv.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left; fcDrawChart(1, x); };
 cv.addEventListener('mousemove', move);
 cv.addEventListener('touchmove', e => { move(e); }, { passive:true });
 cv.addEventListener('mouseleave', () => fcDrawChart(1));
 cv.addEventListener('touchend', () => fcDrawChart(1));
 if (window._fcRO) window._fcRO.disconnect();
 window._fcRO = new ResizeObserver(() => fcDrawChart(1));
 window._fcRO.observe(host);
}

async function renderForecast(ticker, name, type) {
 const el = document.getElementById('predContent');
 if (!el) return;
 const isCrypto = type === 'c';
 const sym = ySym(ticker, type);
 el.innerHTML = `<div class="fc-loading"><span class="fc-spark"></span><b>Reading ${ticker}'s price history</b><small>Measuring trend, momentum and volatility, then running ${FC_PATHS.toLocaleString()} simulations</small></div>`;
 try {
  const [hist, mkt] = await Promise.all([getHistory(sym), sym === '^GSPC' ? Promise.resolve(null) : getHistory('^GSPC').catch(() => null)]);
  if (currentAsset?.ticker !== ticker || !document.body.contains(el)) return;
  await new Promise(r => setTimeout(r, 30));
  const day = new Date().toISOString().slice(0, 10);
  const R = fcCompute(hist, mkt, sym, isCrypto, sym + day);
  const prev = window._fc?.ticker === ticker ? window._fc.hz : 2;
  window._fc = { R, ticker, hz: prev };
  el.innerHTML = fcHTML(R, ticker, prev);
  fcBindChart();
  fcAnimateChart();
  el.querySelectorAll('.fc-sig').forEach(li => li.addEventListener('click', () => li.classList.toggle('open')));
 } catch (e) {
  if (!document.body.contains(el)) return;
  el.innerHTML = `<div class="fc-loading fc-err"><b>Couldn't load ${ticker}'s price history</b><small>The price data service didn't respond. Check your connection and try again.</small><button type="button" class="dash-btn dash-btn-main" onclick="renderForecast('${ticker}','${String(name).replace(/'/g, "\\'")}','${type}')">Try again</button></div>`;
 }
}

/* ════════════════════════════════
 AI ANALYSIS (client-side, no API)
════════════════════════════════ */



/* ════════════════════════════════
 FIT POLL — scales poll buttons to fill card height
════════════════════════════════ */
function fitPollCard(containerId) {
 const container = document.getElementById(containerId);
 if (!container) return;
 const card = container.closest('.card');
 if (!card) return;
 const hdr = card.querySelector('.card-hdr');
 const available = card.clientHeight - (hdr ? hdr.clientHeight : 0) - 32;
 const btns = container.querySelectorAll('.poll-btn');
 if (!btns.length) return;
 // Scale icon and text proportionally to available height per button
 const perBtn = (available / btns.length) * 0.14;
 const iconSize = Math.min(Math.max(perBtn * 0.20, 0.8), 1.2);
 const labelSize = Math.min(Math.max(perBtn * 0.11, 0.55), 0.8);
 const pctSize = Math.min(Math.max(perBtn * 0.11, 0.55), 0.8);
 const barH = Math.min(Math.max(perBtn * 0.03, 5), 8);
 btns.forEach(btn => {
 const icon = btn.querySelector('.poll-icon');
 const label = btn.querySelector('.poll-label');
 const pct = btn.querySelector('.poll-pct');
 const bar = btn.querySelector('.poll-bar-wrap');
 if (icon) icon.style.fontSize = iconSize + 'rem';
 if (label) label.style.fontSize = labelSize + 'rem';
 if (pct) pct.style.fontSize = pctSize + 'rem';
 if (bar) bar.style.height = barH + 'px';
 btn.style.padding = `${perBtn * 0.1}px 1.25rem`;
 });
}

/* ════════════════════════════════
 AI CHAT (client-side, no API)
════════════════════════════════ */

/* ════════════════════════════════
 DEEP KNOWLEDGE BASE — no API needed
════════════════════════════════ */

// CHAT_KB stub — forwards to KB for backward compatibility with getChatReply references
const CHAT_KB = {
 'what is': t => { const p=KB.profiles[t]; return p ? p.desc : `${t} is a publicly traded asset. Search Yahoo Finance for details.`; },
 'who runs': t => { const p=KB.profiles[t]; return p ? `${t} is led by ${p.ceo}.` : `Leadership info for ${t} is on Yahoo Finance → Profile.`; },
 'how does': t => { const p=KB.profiles[t]; if(!p) return `${t}'s business model can be found on Yahoo Finance → Financials.`;
 const rev={AAPL:'iPhone ~55% of revenue; growing Services segment (App Store, iCloud, Apple TV+) ~25%.',MSFT:'Azure cloud, Office 365 subscriptions, LinkedIn, Xbox, and Windows licenses.',GOOGL:'~80% advertising revenue — Google Search and YouTube ads. Remainder from Google Cloud.',TSLA:'EV sales, energy storage (Megapack/Powerwall), and a growing software/services stream.',NVDA:'Data center GPUs for AI training (~87% of revenue), gaming, automotive, and professional visualization.',META:'Advertising on Facebook, Instagram, and WhatsApp (~98% of revenue). Reality Labs burns ~$16B/yr.',AMZN:'AWS cloud (~55% of operating income), e-commerce, advertising ($46B+), and Prime subscriptions.',BTC:"Bitcoin has no earnings. Value comes from fixed 21M supply cap, network security, and store-of-value demand."};
 return rev[t] || p.desc; },
 'competitor':t => { const c={AAPL:'Samsung, Google (Pixel), Microsoft',MSFT:'Amazon AWS, Google Cloud, Salesforce',GOOGL:'Microsoft (Bing/Copilot), Meta (ads), Apple',TSLA:'BYD, Rivian, Ford EV, GM EV',NVDA:'AMD MI300X, Intel Gaudi, Google TPU',META:'TikTok, Snapchat, YouTube',AMZN:'Microsoft Azure, Google Cloud, Walmart',AMD:'NVIDIA, Intel',BTC:'Ethereum, gold (store of value)',ETH:'Solana, Avalanche, Cardano',SOL:'Ethereum, Avalanche'}; return c[t]?`${t}'s main competitors: ${c[t]}.`:`Use the Compare tab to see ${t} vs any competitor.`; },
 'risk': t => { const d=assetDataOrNull(t); const p=realProfile(t); if(d){const[,vol]=d;return `${t} has ~${vol}% annual volatility — ${vol>=70?'very high risk':vol>=40?'moderate risk':'lower risk'} for its category.`;} return p?p.reason.split(/[Rr]isks?:/)[1]?.split('.')[0]||'See AI Analysis card.':'Research on Yahoo Finance.'; },
 'volatility':t => { const d=assetDataOrNull(t); return d?`${t} estimated annual volatility: ~${d[1]}%. S&P 500 averages ~16%; crypto 60–100%+.`:`Volatility shown in the Price Prediction card above.`; },
 'dividend': t => { const pays=['AAPL','MSFT','JNJ','JPM','V','MA','WMT']; return `${pays.includes(t)?t+' pays a regular dividend.':t+' does not currently pay a dividend.'} Check Yahoo Finance → ${t} → Summary for current yield.`; },
};

const KB = {
 // ── COMPANY PROFILES ──
 profiles: {
 AAPL: {
 name:'Apple Inc.', founded:1976, ceo:'Tim Cook (since 2011)', hq:'Cupertino, California',
 desc:'Apple designs and sells consumer electronics (iPhone, Mac, iPad, AirPods, Apple Watch), software (iOS, macOS), and services (App Store, iCloud, Apple TV+, Apple Music, Apple Pay). The iPhone accounts for ~55% of revenue. Services is the fastest-growing and highest-margin segment at ~25% of revenue. Apple has over 2 billion active devices worldwide.',
 bull:'Massive installed base and brand loyalty. Services revenue growing 15%+/yr with ~70% gross margins. Largest share buyback program in history ($90B+/yr). Strong free cash flow machine. Expanding into financial services, health, and mixed reality (Vision Pro).',
 bear:'China accounts for ~18% of revenue — geopolitical risk and competition from Huawei. iPhone upgrade cycles slowing. Antitrust pressure on App Store fees. Vision Pro expensive and slow adoption. Tim Cook seen as less innovative than Jobs era.',
 financials:'Revenue ~$383B/yr. Net income ~$97B. Gross margin ~44%. EPS ~$6.50. P/E ~29x. $165B cash on hand. Pays $0.24/share quarterly dividend.',
 moat:'Brand, ecosystem lock-in (iMessage, AirPods, App Store), and the App Store 30% commission structure.',
 history:'Founded 1976 by Steve Jobs, Steve Wozniak, Mike Markkula. Near-bankruptcy in 1997. iMac (1998), iPod (2001), iPhone (2007) transformed the company. First $1 trillion market cap (2018), first $3 trillion (2022).',
 },
 MSFT: {
 name:'Microsoft Corporation', founded:1975, ceo:'Satya Nadella (since 2014)', hq:'Redmond, Washington',
 desc:'Microsoft makes Windows, Office 365, Azure cloud, Xbox, LinkedIn, GitHub, and Teams. Azure is the #2 cloud platform globally with ~22% market share. Under Nadella, Microsoft transformed from a declining PC company to a cloud-first AI powerhouse. Its $13B investment in OpenAI gives it an edge in AI integration across all products.',
 bull:'Azure growing 28%+ YoY. Copilot AI embedded in all Office products — $30/user/month premium. GitHub Copilot has 1.8M+ paid users. LinkedIn monetization expanding. Teams has 300M+ MAU. Consistent dividend grower.',
 bear:'Azure growth slightly decelerating from peak. Regulatory scrutiny of Activision acquisition and OpenAI partnership. High valuation at 35x earnings. Office still dependent on enterprise renewal cycles.',
 financials:'Revenue ~$227B/yr. Net income ~$88B. Gross margin ~69%. EPS ~$11.80. P/E ~35x. Dividend: $0.75/share quarterly.',
 moat:'Azure ecosystem, Office 365 enterprise contracts, LinkedIn data, GitHub developer lock-in, and OpenAI exclusivity.',
 history:'Founded 1975 by Bill Gates and Paul Allen. MS-DOS deal with IBM launched the company. Windows 95 era dominance. Nearly broken up by DOJ in 2000. Ballmer era stagnation. Nadella transformed company 2014+.',
 },
 GOOGL: {
 name:'Alphabet Inc. (Google)', founded:1998, ceo:'Sundar Pichai (since 2015)', hq:'Mountain View, California',
 desc:'Alphabet is Google\'s parent company. Google Search has ~92% global market share and generates most revenue through Search ads and YouTube ads. Google Cloud is #3 globally (~12% market share) and profitable. Other bets include Waymo (autonomous vehicles), Verily (health), and DeepMind (AI research).',
 bull:'Search remains unassailable despite AI competition. YouTube is the #2 search engine. Google Cloud growing 28%+ and recently profitable. DeepMind/Gemini AI models are world-class. Trading at one of the cheapest P/Es in big tech (~22x). Massive $70B+ buyback program.',
 bear:'AI-powered search (Perplexity, ChatGPT) could reduce search ad clicks over time. DOJ antitrust case could force changes to Google search deals. YouTube faces TikTok competition. Other Bets (Waymo, etc.) burn billions.',
 financials:'Revenue ~$305B/yr. Net income ~$74B. Gross margin ~56%. EPS ~$5.80. P/E ~22x. $110B+ cash. No dividend — massive buybacks instead.',
 moat:'Search dominance, Android ecosystem, YouTube content moat, Gmail/Google Workspace, and Chrome browser distribution.',
 history:'Founded 1998 by Larry Page and Sergey Brin at Stanford. IPO 2004 at $85/share. Gmail, Maps, YouTube (2005 acquisition) transformed consumer internet. Chrome launched 2008. Android acquisition 2005.',
 },
 TSLA: {
 name:'Tesla Inc.', founded:2003, ceo:'Elon Musk (founder)', hq:'Austin, Texas',
 desc:'Tesla makes electric vehicles (Model S, 3, X, Y, Cybertruck), Powerwall/Megapack energy storage, and solar panels. Also developing Full Self-Driving (FSD) software and a robotaxi network. Tesla has the largest EV charging network (Supercharger) which is now open to competitors.',
 bull:'Energy storage (Megapack) growing 200%+ YoY — could be as big as the car business. FSD improving rapidly with v12 pure neural net approach. Robotaxi could be transformative. Supercharger network as a profit center. Brand recognition and software-first approach unmatched in auto.',
 bear:'Aggressive price cuts crushed margins (from 29% to ~15% gross margin). BYD overtook Tesla in global EV sales. Elon Musk distracted by X/Twitter, SpaceX, DOGE. FSD still not truly autonomous after 10 years of promises. High P/E (~70x) prices in a future that may not arrive.',
 financials:'Revenue ~$97B/yr. Net income ~$15B. Gross margin ~17%. EPS ~$2.30 (auto), higher with energy. P/E ~70x. $18B cash.',
 moat:'Supercharger network, software/OTA updates, Gigafactory manufacturing efficiency, and brand loyalty.',
 history:'Founded 2003 by Martin Eberhard. Elon Musk joined 2004 and became CEO 2008. Roadster (2008), Model S (2012) saved company. IPO 2010 at $17/share. Joined S&P 500 in 2020.',
 },
 NVDA: {
 name:'NVIDIA Corporation', founded:1993, ceo:'Jensen Huang (co-founder)', hq:'Santa Clara, California',
 desc:'NVIDIA designs GPUs (graphics processing units). Started in gaming, now dominates AI training infrastructure with ~80% market share in data center AI GPUs. The H100 and H200 chips are the gold standard for training large language models like ChatGPT and Gemini. CUDA software ecosystem creates an enormous switching cost.',
 bull:'AI spending is a multi-decade megatrend. NVIDIA captures most of the margin in AI infrastructure. CUDA ecosystem means switching to AMD/Intel is very painful. Blackwell GPU architecture (next gen) already sold out. Inference demand growing as AI models deploy. Gross margins ~75%+.',
 bear:'Concentration risk — 40%+ of revenue from a handful of hyperscalers. AMD MI300X gaining ground. Intel Gaudi improving. Custom chips from Google (TPU), Amazon (Trainium), Meta reducing TAM. US export restrictions on China limit a major market. Valuation can compress fast if AI spending slows.',
 financials:'Revenue ~$96B/yr (FY2024), growing 122% YoY. Net income ~$56B. Gross margin ~75%. EPS ~$11.50. P/E ~35x forward.',
 moat:'CUDA software platform (20+ years of developer tools), H100/H200 GPU performance lead, and NVLink interconnect for multi-GPU systems.',
 history:'Founded 1993 by Jensen Huang, Chris Malachowsky, Curtis Priem. Near-bankrupt in 1996 before winning 3dfx era. GeForce GPU (1999). CUDA launched 2006. AI breakout with AlexNet 2012. Data center overtook gaming revenue 2023.',
 },
 META: {
 name:'Meta Platforms Inc.', founded:2004, ceo:'Mark Zuckerberg (founder)', hq:'Menlo Park, California',
 desc:'Meta owns Facebook (3B+ MAU), Instagram (2B+ MAU), WhatsApp (2B+ users), and Messenger. Makes money almost entirely from digital advertising — some of the most targeted ads on earth using AI and vast user data. Also developing Quest VR headsets and "metaverse" technology through Reality Labs.',
 bull:'2022-2023 "Year of Efficiency" cut headcount 25% and boosted margins dramatically. Advantage+ AI ad platform improving ad ROI for businesses. Reels competing well with TikTok. WhatsApp monetization barely started — enormous upside. Threads growing. Cheap valuation vs earnings power.',
 bear:'Reality Labs loses ~$16B/yr with unclear path to profitability. Teen users leaving for TikTok. EU regulatory fines and data privacy restrictions. Zuckerberg has total voting control — no accountability. Ad revenue cyclical.',
 financials:'Revenue ~$134B/yr. Net income ~$39B. Gross margin ~80%+. EPS ~$14.90. P/E ~27x.',
 moat:'Network effects (3B+ people are already on these platforms), vast user data for ad targeting, and Instagram/WhatsApp lock-in.',
 history:'Facebook founded 2004 at Harvard. IPO 2012. Instagram acquisition 2012 ($1B). WhatsApp acquisition 2014 ($19B). Renamed Meta 2021. Stock crashed 75% in 2022, recovered 400%+ by 2024.',
 },
 AMZN: {
 name:'Amazon.com Inc.', founded:1994, ceo:'Andy Jassy (since 2021)', hq:'Seattle, Washington',
 desc:'Amazon runs the world\'s largest e-commerce marketplace, AWS (the #1 cloud platform with ~32% market share), Prime Video, Alexa, Whole Foods, Ring, and a $46B+ advertising business. AWS is the profit engine — it generates the majority of Amazon\'s operating income despite being a fraction of total revenue.',
 bull:'AWS growing 17%+ YoY with $100B+ ARR. Advertising business growing 20%+. AI services (Bedrock, CodeWhisperer) on AWS. Prime membership 200M+ globally — sticky recurring revenue. Logistics network now a competitive moat. Margins expanding as retail efficiency improves.',
 bear:'Retail margins thin, subsidized by AWS. Antitrust pressure on marketplace practices. Google and Microsoft gaining cloud ground. Alexa struggling vs ChatGPT. High capex for AI infrastructure.',
 financials:'Revenue ~$590B/yr. Operating income ~$36B. AWS revenue ~$100B ARR. EPS ~$5.30 (rapidly growing). P/E ~35x.',
 moat:'AWS ecosystem, Prime flywheel, logistics network, marketplace network effects, and Alexa smart home penetration.',
 history:'Founded 1994 by Jeff Bezos as online bookstore. IPO 1997 at $18/share. AWS launched 2006. Kindle 2007. Acquired Whole Foods 2017. Bezos stepped down as CEO 2021.',
 },
 AMD: {
 name:'Advanced Micro Devices', founded:1969, ceo:'Lisa Su (since 2014)', hq:'Santa Clara, California',
 desc:'AMD designs CPUs and GPUs competing with Intel (CPUs) and NVIDIA (AI/gaming GPUs). Ryzen CPUs took 25%+ desktop market share from Intel. EPYC server CPUs growing fast. MI300X GPU for AI is gaining traction with hyperscalers as a NVIDIA alternative.',
 bull:'Lisa Su is one of the best CEOs in tech — consistent execution. EPYC server CPU market share growing from 5% to 25%+. MI300X is a credible alternative to H100 for AI inference workloads. Microsoft and Meta publicly using MI300X. Cheaper than NVIDIA on valuation.',
 bear:'NVIDIA\'s CUDA moat is extremely difficult to break — most AI code is written for CUDA. AMD GPU software stack (ROCm) still catching up. Intel Gaudi and custom chips competing. CPU market maturing.',
 financials:'Revenue ~$22B/yr. Net income ~$854M (ramping). Gross margin ~53%. EPS growing rapidly. P/E ~50x on forward earnings.',
 moat:'x86 CPU license (only Intel and AMD can make x86 chips), chiplet architecture efficiency, and growing EPYC server ecosystem.',
 history:'Founded 1969. Licensed x86 from Intel in 1982. Near-bankrupt multiple times. Lisa Su became CEO 2014, launched Zen architecture 2017 which transformed competitiveness.',
 },
 JPM: {
 name:'JPMorgan Chase & Co.', founded:2000, ceo:'Jamie Dimon (since 2005)', hq:'New York, New York',
 desc:'JPMorgan Chase is the largest US bank by assets ($3.9 trillion). Operates through Consumer Banking (Chase), Investment Banking (J.P. Morgan), Asset Management, and Commercial Banking. Consistently considered the best-managed large bank globally.',
 bull:'Best-in-class risk management — navigated 2008, 2020, and 2023 banking crises better than peers. Investment banking recovering. Rising rates boosted net interest income significantly. Acquired First Republic at a bargain in 2023 banking crisis. Jamie Dimon widely regarded as greatest banker of his generation.',
 bear:'If rates fall, net interest income (the spread between deposit rates and lending rates) compresses. Investment banking is cyclical. Increased regulatory capital requirements reduce ROE. Dimon retirement watch — he\'s irreplaceable.',
 financials:'Revenue ~$162B/yr. Net income ~$49B. EPS ~$16.50. P/E ~12x (banks trade at lower multiples). Dividend: $1.05/share quarterly (2.2% yield). Book value ~$105/share.',
 moat:'Scale advantages, brand trust, cross-selling across business lines, and massive tech investment ($15B/yr in technology).',
 history:'Formed from merger of JP Morgan and Bank One (2004). Jamie Dimon joined from Bank One. Acquired Bear Stearns (2008) and Washington Mutual (2008) during financial crisis. Acquired First Republic (2023).',
 },
 BTC: {
 name:'Bitcoin', founded:2009, ceo:'Satoshi Nakamoto (anonymous creator, no CEO)', hq:'Decentralized — no headquarters',
 desc:'Bitcoin is the first and largest cryptocurrency by market cap. It\'s a decentralized digital currency: no bank, government, or company controls it. Transactions are verified by miners and recorded on a public blockchain. Only 21 million BTC will ever exist — this scarcity is a core value proposition. Bitcoin is often called "digital gold."',
 bull:'Spot Bitcoin ETFs approved in US (Jan 2024) opened institutional floodgates — BlackRock, Fidelity now hold billions. Bitcoin halving (April 2024) reduced new supply by 50%. Inflation hedge narrative strengthening. El Salvador adopted as legal tender. Corporate treasuries (MicroStrategy, Tesla) holding BTC.',
 bear:'No earnings, no dividend — pure speculation on future demand. 70-90% drawdowns common in bear markets. US regulatory uncertainty. Mining uses enormous energy. Large holders (whales) can manipulate price. Competing stores of value (gold, other cryptos).',
 financials:'Market cap varies — check live price widget. 21M total supply cap. ~19.7M BTC currently in circulation. ~3.1M estimated lost forever. Mining reward: 3.125 BTC per block after April 2024 halving.',
 moat:'First-mover advantage, network effect (most liquidity), brand recognition as "cryptocurrency" to mainstream, and Lindy Effect (survived 15 years).',
 history:'Whitepaper published Oct 31, 2008 by Satoshi Nakamoto. Genesis block mined Jan 3, 2009. First transaction: 10,000 BTC for 2 pizzas (2010). Mt.Gox exchange collapse 2014. All-time high ~$69,000 (Nov 2021). Crypto winter -75% (2022). ETF approval and halving 2024.',
 },
 ETH: {
 name:'Ethereum', founded:2015, ceo:'Vitalik Buterin (creator)', hq:'Decentralized',
 desc:'Ethereum is a programmable blockchain — a global computer that runs smart contracts and decentralized apps (dApps). It\'s the backbone of DeFi (decentralized finance), NFTs, and most Web3 activity. ETH is the "gas" token used to pay for all transactions on the network. In 2022, Ethereum switched from energy-intensive Proof of Work to Proof of Stake (The Merge), reducing energy use by 99.95%.',
 bull:'Dominant smart contract platform with 60%+ DApp market share. The Merge made ETH deflationary — more ETH is burned in fees than created. Layer 2 networks (Arbitrum, Optimism) scaling Ethereum dramatically. Institutional staking demand growing. ETH ETFs approved 2024.',
 bear:'Solana, Avalanche, and other L1s offering faster/cheaper alternatives. High gas fees on mainnet price out small users. Vitalik\'s influence creates "benevolent dictator" centralization risk. Regulatory risk (SEC may classify as security).',
 financials:'Market cap varies. ~120M ETH in circulation (deflationary post-Merge). Staking yield: ~3.5-5%/yr. Annual fee burn: billions of dollars of ETH.',
 moat:'Network effects in DeFi/NFT ecosystem, developer mindshare (most blockchain devs know Solidity/EVM), and composability of protocols.',
 history:'Proposed by Vitalik Buterin in 2013 (age 19). ICO 2014. Mainnet launch 2015. DAO hack 2016 caused chain split (Ethereum Classic). CryptoKitties congestion 2017. DeFi Summer 2020. NFT boom 2021. The Merge (PoS) Sep 2022.',
 },
 SOL: {
 name:'Solana', founded:2020, ceo:'Anatoly Yakovenko (co-founder)', hq:'Decentralized / San Francisco',
 desc:'Solana is a high-performance blockchain capable of processing 65,000+ transactions per second at very low fees (fractions of a cent). It achieves this through a novel consensus mechanism called Proof of History combined with Proof of Stake. Popular for NFTs, DeFi, payments, and meme coins.',
 bull:'Fastest growing developer ecosystem in crypto. Firedancer upgrade (by Jump Trading) could 10x throughput. Major companies building on Solana (Visa, Shopify using for payments). Strong meme coin ecosystem (Pump.fun) driving transaction fees. Bonk, WIF, and other tokens drove SOL demand in 2024.',
 bear:'History of network outages (11 in 2022). Heavy VC token unlocks create persistent selling pressure. FTX/Alameda held $1B+ in SOL — their bankruptcy caused huge SOL selloff. Less decentralized than Ethereum (fewer validators).',
 financials:'Market cap varies. ~450M SOL in circulation. Staking yield ~6-7%/yr. TPS (real): ~3,000-4,000 under load.',
 moat:'Transaction speed + low fees combination unmatched by L1s. Proof of History innovation. Growing developer ecosystem.',
 history:'Mainnet launched March 2020. FTX collapse Nov 2022 caused 95% drawdown (from $260 to $8). Recovered 1,300%+ by early 2024. Breakpoint conference annually growing developer community.',
 },
 SPX: {
 name:'S&P 500 Index', founded:1957, ceo:'N/A — Index tracked by S&P Global', hq:'N/A',
 desc:'The S&P 500 tracks the 500 largest publicly traded companies in the US, weighted by market cap. Covers ~80% of US equity market value. Top holdings: Apple, Microsoft, NVIDIA, Amazon, Meta, Alphabet, Berkshire, Tesla, UnitedHealth, JPMorgan. Rebalanced quarterly. The "default benchmark" — when people say "the market," they usually mean the S&P 500.',
 bull:'Long-term average return ~10%/yr (7% real after inflation) over 100+ years. Diversification across 500 companies. Self-cleansing — winners replace losers automatically. No stock-picking required. Buffett recommends S&P 500 index funds for most investors.',
 bear:'Currently ~21x P/E — above historical average of ~15-17x. Top 10 stocks are ~34% of the index — concentration risk. US-only exposure. Drops 30-50% in recessions. No protection in bear markets.',
 financials:'Annual dividend yield ~1.4%. Historical 10yr return: ~12%/yr. Max drawdown: -57% (2008-2009). 2020 COVID crash: -34%. Average recovery time from corrections: ~4 months.',
 moat:'N/A — it\'s an index. You invest via ETFs: SPY (0.0945% expense ratio), VOO (0.03%), IVV (0.03%).',
 history:'Created 1957 replacing Dow Jones as main benchmark. 1,000% return from 1980 to 2000. Dot-com crash -49% (2000-2002). Financial crisis -57% (2007-2009). COVID crash -34% (Feb-Mar 2020). All-time highs by 2024.',
 },
 DJI: {
 name:'Dow Jones Industrial Average', founded:1896, ceo:'N/A — Index by S&P Dow Jones Indices', hq:'N/A',
 desc:'The Dow Jones tracks just 30 large blue-chip US companies including Apple, Microsoft, Goldman Sachs, Boeing, McDonald\'s, Visa, Nike, Johnson & Johnson, and Coca-Cola. Unlike the S&P 500, it\'s price-weighted (higher-priced stocks have more influence regardless of company size). The oldest and most famous US stock market index.',
 bull:'Blue-chip companies with strong balance sheets. Less volatile than NASDAQ. Good for conservative investors who want US equity exposure. Long track record — 130+ years.',
 bear:'Only 30 stocks — poor diversification vs S&P 500. Price weighting is illogical (Goldman Sachs at $400/share has more influence than Apple at $180). No tech-heavy upside. Significantly underperformed S&P 500 and NASDAQ over the past decade.',
 financials:'Dividend yield ~1.8%. 10yr annual return: ~9-10%/yr. Track via DIA ETF (0.16% expense ratio).',
 moat:'N/A — it\'s an index. Historical brand recognition only.',
 history:'Created 1896 by Charles Dow. Original 12 companies included GE, US Rubber, and Tennessee Coal. GE was the last original member (removed 2018). Crossed 1,000 in 1972. Crossed 10,000 in 1999. 30,000 for first time in 2020.',
 },
 IXIC: {
 name:'NASDAQ Composite Index', founded:1971, ceo:'N/A — Index by NASDAQ', hq:'N/A',
 desc:'The NASDAQ Composite tracks all ~3,300 stocks listed on the NASDAQ exchange. Heavily weighted towards technology: Apple, Microsoft, NVIDIA, Amazon, Meta, Google, Tesla make up a large portion. Highest-growth, highest-volatility of the three major US indexes.',
 bull:'Tech sector is the dominant driver of global economic growth. AI revolution benefits NASDAQ-heavy tech companies most. Over 20 years, NASDAQ has significantly outperformed both S&P 500 and Dow. Concentration in innovation leaders is a feature, not a bug.',
 bear:'Extremely vulnerable in rate-rising environments (growth stocks valued on future earnings). 2000-2002 dot-com crash: -78%. 2022 rate hike crash: -33%. Concentration risk — top 10 stocks are 50%+ of index. No defensive stocks.',
 financials:'Dividend yield ~0.7%. 10yr annual return: ~16%/yr. Track via QQQ ETF (0.20% expense ratio) which tracks NASDAQ 100 (top 100 non-financial NASDAQ stocks).',
 moat:'N/A — it\'s an index.',
 history:'Founded 1971 as first electronic stock exchange. NASDAQ 100 created 1985. Tech bubble peak March 2000 (~5,000). Bottom Oct 2002 (~1,100). Recovered 2015. COVID crash 2020 recovered in 6 months. All-time highs 2024.',
 },
 NFLX: {
 name:'Netflix Inc.', founded:1997, ceo:'Greg Peters & Ted Sarandos (co-CEOs)', hq:'Los Gatos, California',
 desc:'Netflix is the world\'s largest paid streaming service with 270M+ subscribers in 190+ countries. Started as a DVD-by-mail service, pivoted to streaming in 2007, then to original content production. Produces 500+ original titles per year including Stranger Things, Squid Game, Wednesday, and Bridgerton. Password-sharing crackdown in 2023 added tens of millions of paying subscribers.',
 bull:'Dominant streaming brand globally with no close second at scale. Advertising-supported tier opens a new revenue stream at higher margins long-term. Password crackdown re-accelerated subscriber growth. Margins expanding toward 25%+. Gaming content could expand TAM. Live events (WWE Raw, NFL games) adding stickiness.',
 bear:'Content spending ($17B/yr) is a fixed cost regardless of subscriber count. Competition from Disney+, Max, Apple TV+, Amazon Prime Video is intense and well-funded. Most major markets approaching saturation. Linear TV cord-cutting is accelerating churn pool — most potential subscribers already know Netflix exists.',
 financials:'Revenue ~$36B/yr. Operating margin ~26%. Net income ~$7B. EPS ~$15. P/E ~35x. Free cash flow positive and growing.',
 moat:'Brand recognition as the default streaming verb ("Netflix and chill"), content library breadth, recommendation algorithm, and global original content production pipeline.',
 history:'Founded 1997 by Reed Hastings and Marc Randolph as DVD rental. Launched streaming 2007. International expansion 2010. First original (House of Cards) 2013. Reed Hastings stepped back as CEO 2023.',
 },
 V: {
 name:'Visa Inc.', founded:1958, ceo:'Ryan McInerney (since 2023)', hq:'San Francisco, California',
 desc:'Visa operates the world\'s largest payment network connecting 4.3B+ cardholders, 130M+ merchants, and 15,000+ financial institutions in 200+ countries. Visa does NOT lend money or hold balances — it\'s purely a transaction processing network, making it an asset-light, near-zero-credit-risk business. Processes $15 trillion+ in annual payment volume.',
 bull:'Every swipe of a Visa card earns a fee. Global shift from cash to digital payments still has enormous runway — cash is still 40%+ of transactions globally. Pricing power: Visa has raised fees regularly with little merchant pushback. Stock buybacks have reduced share count by 25%+ over a decade. Near-monopoly with Mastercard.',
 bear:'Regulatory risk in EU/US to reduce interchange fees could hurt revenue. Real-time payment networks (Zelle, FedNow, India\'s UPI, Brazil\'s PIX) bypass card networks. Crypto payment rails could disintermediate cards long-term. Merchant coalitions occasionally push back on fees.',
 financials:'Revenue ~$35B/yr. Net income ~$18B. Net margin ~52%. EPS ~$9.50. P/E ~30x. Dividend: $0.52/share quarterly (~0.7% yield). Buybacks ~$15B/yr.',
 moat:'Two-sided network effects (merchants accept Visa because cardholders have it; cardholders use it because merchants accept it), brand trust, global infrastructure, and regulatory relationships.',
 history:'Founded 1958 as BankAmericard by Bank of America. Renamed Visa 1976. IPO 2008 — largest US IPO at the time ($17.9B). Acquired Visa Europe 2016.',
 },
 MA: {
 name:'Mastercard Inc.', founded:1966, ceo:'Michael Miebach (since 2021)', hq:'Purchase, New York',
 desc:'Mastercard is a global payment technology company operating a network connecting cardholders, financial institutions, and merchants in 210+ countries. Very similar business to Visa — processes over $9 trillion in annual payment volume. Growing services segment includes cybersecurity, data analytics, and consulting.',
 bull:'Duopoly with Visa in global card payments — nearly impossible to disrupt from outside. Services revenue (25%+ of revenue) growing faster than core network and at higher margins. More international exposure than Visa (stronger in Europe, Africa, Asia). Consistent double-digit EPS growth and buybacks.',
 bear:'Same regulatory risks as Visa on interchange fees. FedNow and real-time payment competition. Slightly smaller than Visa so less pricing power. Any merchant rebellion against fees affects both equally.',
 financials:'Revenue ~$25B/yr. Net income ~$11B. Net margin ~44%. EPS ~$12.50. P/E ~35x. Dividend: $0.66/share quarterly (~0.6% yield). Aggressive buybacks.',
 moat:'Two-sided network effects identical to Visa. Global acceptance, fraud protection infrastructure, and 60 years of financial institution relationships.',
 history:'Founded 1966 as Interbank Card Association. Renamed MasterCard 1979, Mastercard 2016. IPO 2006 at $39/share. Partnership with Apple Pay, Google Pay. Agreed to acquire Aiia and Nets (EU open banking).',
 },
 WMT: {
 name:'Walmart Inc.', founded:1962, ceo:'Doug McMillon (since 2014)', hq:'Bentonville, Arkansas',
 desc:'Walmart is the world\'s largest company by revenue (~$650B/yr) and the #1 US grocery retailer. Operates 10,500+ stores in 19 countries under Walmart, Sam\'s Club, and other banners. E-commerce growing 20%+/yr. Advertising business (Walmart Connect) is now a $3B+ high-margin revenue stream. Walmart+ membership competes with Amazon Prime.',
 bull:'Dominant grocery share creates recession resilience — people always need food. E-commerce logistics infrastructure becoming a competitive advantage. Advertising and Walmart+ create high-margin revenue layered on top of low-margin retail. International business (especially Flipkart in India, Sam\'s Club) has strong growth. Scale advantages in supply chain are impossible to replicate.',
 bear:'Core retail margins are very thin (~4%). Amazon is gaining grocery share with Whole Foods and Fresh. Stock trades at 28x earnings — premium valuation for a grocery retailer requires flawless execution. Labor costs are a major expense and rising. Thin margins mean small errors hurt disproportionately.',
 financials:'Revenue ~$650B/yr. Operating income ~$27B. EPS ~$2.35. P/E ~28x. Dividend: $0.83/share quarterly (~1.0% yield). Growing free cash flow.',
 moat:'Supply chain scale, Everyday Low Prices cost discipline, real estate footprint (stores as last-mile fulfillment), and Sam\'s Club membership model.',
 history:'Founded 1962 by Sam Walton in Rogers, Arkansas. IPO 1970. Became world\'s largest retailer 1990. Sam Walton died 1992. First $1 trillion in annual sales 2014.',
 },
 BAC: {
 name:'Bank of America', founded:1904, ceo:'Brian Moynihan (since 2010)', hq:'Charlotte, North Carolina',
 desc:'Bank of America is the #2 US bank by assets ($3.3 trillion). Operates through Consumer Banking, Global Wealth & Investment Management (Merrill Lynch), Global Banking, and Global Markets. Has 68M+ consumer and small business clients. Merrill Lynch is one of the largest wealth management businesses in the US.',
 bull:'Merrill Lynch wealth management provides stable fee income. Large consumer deposit base is sticky and low-cost. Rate sensitivity means it benefits when rates are high. Brian Moynihan has steadily improved efficiency ratio. Strong digital banking adoption (45M+ mobile users). Trading well below book value historically.',
 bear:'Holds billions in unrealized bond losses from buying long-duration Treasuries at near-zero yields in 2020-2021. Rate cuts compress net interest income. Less diversified internationally than JPMorgan. Moynihan lacks Dimon\'s star power with investors. Consumer credit losses rising.',
 financials:'Revenue ~$94B/yr. Net income ~$26B. EPS ~$3.30. P/E ~13x. Dividend: $0.24/share quarterly (~2.3% yield). Book value ~$34/share.',
 moat:'Consumer banking scale, Merrill Lynch brand and advisor relationships, and cross-selling across business lines.',
 history:'Founded 1904 as Bank of Italy in San Francisco. Renamed Bank of America 1930. Acquired Merrill Lynch in 2009 financial crisis. Ken Lewis era controversies followed by Brian Moynihan stabilization.',
 },
 INTC: {
 name:'Intel Corporation', founded:1968, ceo:'Pat Gelsinger resigned Dec 2024; interim leadership', hq:'Santa Clara, California',
 desc:'Intel invented the microprocessor and dominated computing for 50+ years. Makes CPUs (Core, Xeon), GPU (Arc), and is building Intel Foundry Services (IFS) to manufacture chips for other companies competing with TSMC. Revenue has declined significantly as AMD took CPU market share and Intel missed the AI chip wave entirely.',
 bull:'IFS foundry business could succeed long-term as governments want domestic chip manufacturing (CHIPS Act funding $8.5B). x86 installed base still enormous — Xeon servers run most data centers. Intel 18A process node showing promising results. Stock is cheap at 1x book value.',
 bear:'AMD Ryzen has taken 25%+ consumer CPU market share and is gaining in servers. NVIDIA dominates AI training/inference chips — Intel has no competitive product. IFS is losing billions and TSMC/Samsung have decade-long process node leads. Pat Gelsinger\'s turnaround failed; CEO transition creates uncertainty. Dividend was cut significantly.',
 financials:'Revenue ~$54B/yr (declining). Net loss in recent quarters. Gross margin ~38% (down from 60%+). EPS negative recently. $30B+ in debt. IFS losing ~$7B/yr.',
 moat:'x86 architecture license (shared only with AMD), massive installed enterprise base, CHIPS Act government support for US domestic manufacturing.',
 history:'Founded 1968 by Gordon Moore and Robert Noyce. Invented DRAM and microprocessor. IBM PC used Intel chips 1981. Dominated CPUs for 30+ years. AMD Zen architecture 2017 began competitive threat. Missed mobile (no Apple iPhone contract). Missed GPU computing. Gelsinger return as CEO 2021, resigned 2024.',
 },
 COIN: {
 name:'Coinbase Global Inc.', founded:2012, ceo:'Brian Armstrong (co-founder)', hq:'Remote (incorporated in Delaware)',
 desc:'Coinbase is the largest regulated US cryptocurrency exchange. Provides retail and institutional trading, custody, staking, and developer infrastructure (Base L2 blockchain). Revenue is highly correlated with crypto market activity — trading volumes spike during bull markets. Also operates Coinbase Wallet and growing subscription/services revenue.',
 bull:'Only major regulated US crypto exchange — benefits from institutional adoption (ETF custodian for BlackRock Bitcoin ETF). Base L2 is growing rapidly and positions Coinbase in the DeFi ecosystem. Crypto-friendly regulatory environment under Trump administration. Subscription revenue (staking, custody) provides more stable baseline. International expansion underway.',
 bear:'Revenue is extremely cyclical — lost $2.6B in 2022 bear market when trading volumes collapsed. SEC enforcement actions created regulatory uncertainty (lawsuit filed 2023, ongoing). Binance and international competitors offer lower fees. DEXs (Uniswap, etc.) take market share without intermediaries. Revenue depends on crypto prices staying elevated.',
 financials:'Revenue ~$6B/yr (highly variable). Net income varies widely with crypto cycles. EPS ~$4-8 in bull markets, negative in bear markets. Cash position $7B+.',
 moat:'Regulatory compliance infrastructure, institutional trust and custody relationships, Coinbase brand as safest US on-ramp, and Base L2 growing ecosystem.',
 history:'Founded 2012 by Brian Armstrong and Fred Ehrsam. First major regulated US exchange. IPO via direct listing April 2021 at $381/share. Stock crashed 90%+ in 2022 crypto winter. Recovered substantially with 2024 crypto bull run and ETF approvals.',
 },
 PLTR: {
 name:'Palantir Technologies', founded:2003, ceo:'Alex Karp (co-founder)', hq:'Denver, Colorado',
 desc:'Palantir builds data analytics and AI software for governments (Gotham platform) and commercial enterprises (Foundry and AIP platforms). Government work includes intelligence agencies (CIA, NSA, DOD) and allied militaries. AIP (Artificial Intelligence Platform) launched 2023 and is growing rapidly in commercial. Known for controversial government surveillance work and flamboyant CEO Alex Karp.',
 bull:'Government contracts are sticky, long-term, and classified — very hard to displace once embedded. AIP bootcamps converting commercial customers into large contracts at accelerating pace. US Army and other DoD contracts growing. NATO and allied government expansion. Rule of 40 score improving. Added to S&P 500 September 2024.',
 bear:'Trades at ~200x sales — one of the most expensive software companies in the world. Stock-based compensation is massive (~25% of revenue), diluting shareholders. Commercial growth has been slower than hoped despite AIP hype. Concentration in US government. Alex Karp\'s political statements and unconventional CEO style create risk.',
 financials:'Revenue ~$2.6B/yr, growing 25%+. GAAP net income now positive. EPS ~$0.12-0.15 (GAAP). P/S ~100x. P/E ~300x. SBC-adjusted metrics more favorable.',
 moat:'Deep integration into classified government infrastructure (impossible to rip out), proprietary ontology software for complex data, and AIP\'s growing customer lock-in.',
 history:'Founded 2003, funded early by CIA\'s In-Q-Tel. Built for counter-terrorism after 9/11. Used in Osama bin Laden operation. IPO via direct listing Sept 2020 at $10/share. AIP launch 2023 re-ignited commercial growth narrative.',
 },
 UBER: {
 name:'Uber Technologies Inc.', founded:2009, ceo:'Dara Khosrowshahi (since 2017)', hq:'San Francisco, California',
 desc:'Uber operates the world\'s largest ride-hailing network (Uber), food delivery (Uber Eats, #2 in US), and freight logistics (Uber Freight). Present in 70+ countries with 150M+ monthly active platform consumers. Reached GAAP profitability for the first time in 2023 after losing tens of billions since founding.',
 bull:'Network effects deepen with scale — more drivers = faster pickups = more riders = more demand for drivers. Delivery and ride-hail on the same app creates cross-sell. High-margin advertising on the app growing rapidly. Autonomous vehicle partnerships (Waymo rides available via Uber app) could expand margin rather than disrupt. International markets still growing.',
 bear:'Driver classification as employees (vs contractors) in some jurisdictions raises costs significantly. Waymo and Tesla Robotaxi threaten the driver model long-term. DoorDash has stronger delivery market position. Thin profitability margins can swing negative in competitive markets. Still burning cash in some international markets.',
 financials:'Revenue ~$40B/yr (gross bookings ~$140B). Operating income ~$1.4B. EPS ~$1.20. P/E ~25x. Free cash flow positive and growing.',
 moat:'Two-sided marketplace network effects, brand recognition as generic verb for ride-hailing, and multi-product platform (rides + eats + freight on one app).',
 history:'Founded 2009 by Travis Kalanick and Garrett Camp. Disrupted taxi industry globally. Kalanick ousted 2017 amid scandals. Khosrowshahi hired from Expedia. Sold SE Asia to Grab, China to Didi. IPO 2019 at $45/share. First profitable year 2023.',
 },
 SHOP: {
 name:'Shopify Inc.', founded:2006, ceo:'Tobi Lütke (founder)', hq:'Ottawa, Canada',
 desc:'Shopify is the leading e-commerce platform for businesses of all sizes, powering 10%+ of US e-commerce and 4.5M+ merchants globally. Merchants use Shopify to build online stores, manage inventory, accept payments (Shopify Payments), get working capital (Shopify Capital), and fulfill orders. Enterprise plan (Shopify Plus) serves larger brands.',
 bull:'Shopify Payments growing fast — takes a cut of every transaction, creating revenue that scales with merchant GMV. Shopify Capital generates high-yield lending revenue. Operating leverage: revenue growing faster than costs after 2022 efficiency drive. International expansion still early. Shopify is the default platform for new e-commerce businesses.',
 bear:'Amazon continues building its own merchant tools. Stock-based compensation ~15% of revenue is significant dilution. Valuation (~12x sales) requires continued strong execution. Consumer spending slowdowns directly hurt merchant GMV. Competition from WooCommerce (free), BigCommerce, and platforms specific to verticals.',
 financials:'Revenue ~$8.9B/yr, growing 23%+. Operating income ~$1.3B. Free operating margin ~17%. EPS ~$0.90 (GAAP). P/E ~80x forward.',
 moat:'Merchant switching costs (entire business infrastructure on Shopify), Shopify Payments lock-in (merchants get discounted rates), App Store ecosystem with 8,000+ integrations.',
 history:'Founded 2006 by Tobi Lütke who built his own snowboard shop software. IPO 2015 at $17/share (now split-adjusted). COVID 2020 accelerated e-commerce growth dramatically. Acquired logistics network 2023 then sold it to Flexport, returning to software focus.',
 },
 LLY: {
 name:'Eli Lilly and Company', founded:1876, ceo:'David Ricks (since 2017)', hq:'Indianapolis, Indiana',
 desc:'Eli Lilly is a global pharmaceutical company and the most valuable healthcare company in the world (2024). Known primarily for its GLP-1 drugs: Mounjaro (tirzepatide for diabetes) and Zepbound (tirzepatide for obesity). Also has major drugs in immunology (Taltz, Olumiant) and oncology. Pipeline includes Alzheimer\'s drug donanemab.',
 bull:'Obesity affects 42% of US adults — GLP-1 drugs address the largest unmet medical need in a generation. Tirzepatide shown to reduce cardiovascular events, sleep apnea, kidney disease — expanding indications. Pipeline is deep with cancer and Alzheimer\'s assets. Revenue growing 30%+/yr. Manufacturing capacity being expanded aggressively.',
 bear:'Manufacturing capacity constraints limiting supply and capping revenue potential. Government drug price negotiation (Inflation Reduction Act) may reduce drug pricing power. Novo Nordisk (Ozempic/Wegovy) competes directly. Patent cliffs eventually. Very high valuation (40x earnings) leaves no room for disappointment.',
 financials:'Revenue ~$45B/yr (growing 30%+). Net income ~$10B. Gross margin ~80%+. EPS ~$11. P/E ~45x. Dividend: $1.30/share quarterly (~0.8% yield).',
 moat:'GLP-1 manufacturing expertise (12-18 months to build new capacity), clinical trial data on cardiovascular outcomes, physician prescribing relationships, and pipeline depth.',
 history:'Founded 1876 by Colonel Eli Lilly. First to mass-produce insulin (1923). Prozac launch 1987 was transformative. Cymbalta, Cialis. Mounjaro FDA approved 2022. Zepbound obesity approval 2023. Became top 10 most valuable companies globally 2024.',
 },
 AVGO: {
 name:'Broadcom Inc.', founded:1991, ceo:'Hock Tan (since 2006)', hq:'Palo Alto, California',
 desc:'Broadcom is a diversified semiconductor and infrastructure software company. Makes networking chips (ASICs), storage controllers, and wireless connectivity components. Acquired CA Technologies (2018) and Symantec enterprise security (2019). The $69B acquisition of VMware (2023) transformed Broadcom into a hybrid cloud infrastructure software powerhouse.',
 bull:'Custom AI chips (XPUs) designed for Google, Meta, and ByteDance are a major growth driver — these companies want alternatives to NVIDIA GPUs for inference workloads. VMware provides stable, high-margin subscription software revenue with captive enterprise customers. Ethernet networking chips for AI data centers critical infrastructure. Hock Tan\'s acquisition track record is exceptional.',
 bear:'$69B VMware acquisition loaded the balance sheet with $67B+ in debt. VMware customers complaining loudly about 5-10x price increases post-acquisition — some churning. Cyclicality in non-AI semiconductor segments. NVIDIA custom chip competition could develop.',
 financials:'Revenue ~$51B/yr (FY2024). Net income ~$5.9B. Gross margin ~74%. EPS ~$4.84 (GAAP), ~$46 (non-GAAP adjusted). P/E ~35x non-GAAP. Dividend: $2.12/share quarterly (~1.3% yield).',
 moat:'Mission-critical network switch chips with multi-year design win cycles, VMware hypervisor deep enterprise lock-in, and custom ASIC design expertise for AI hyperscalers.',
 history:'Founded 1991 as HP division. Spun off, went through multiple mergers. Avago Technologies acquired Broadcom 2016 and took the Broadcom name. CA Technologies 2018. Symantec Enterprise Security 2019. VMware 2023 for $69B.',
 },
 XOM: {
 name:'ExxonMobil Corporation', founded:1870, ceo:'Darren Woods (since 2017)', hq:'Spring, Texas',
 desc:'ExxonMobil is the largest US oil and gas company and one of the most profitable companies in the world in high-oil-price environments. Operates upstream (oil/gas exploration and production), downstream (refining and chemicals), and lubricants. Pioneer Natural Resources acquisition (2024, $60B) added significant low-cost Permian Basin production.',
 bull:'Guyana offshore discovery is among the highest-margin, lowest-cost barrels in the world — ramping to 1.3M barrels/day by 2027. Pioneer acquisition doubles Permian production with low-cost assets. Strong free cash flow at $75+ oil prices. Committed to returning $20B+/yr to shareholders via dividends and buybacks. Dividend Aristocrat (40+ consecutive years of increases).',
 bear:'Oil prices are volatile and driven by OPEC+ geopolitics — could fall to $50-60 if global demand weakens. Long-term energy transition is a secular headwind for fossil fuel demand. Stranded asset risk as electric vehicles accelerate. Climate litigation risk. Upstream projects have 20-30 year payback periods in a world that may need less oil.',
 financials:'Revenue ~$400B/yr. Net income ~$36B. EPS ~$9. P/E ~14x. Dividend: $0.99/share quarterly (~3.4% yield). Buybacks $17.5B/yr.',
 moat:'Scale in upstream production, refining integration, and Guyana and Permian Basin asset quality that took decades to develop.',
 history:'Standard Oil of New Jersey (Exxon) and Standard Oil of New York (Mobil) — both descendants of Rockefeller\'s Standard Oil broken up in 1911. Merged 1999. Climate lawsuits. Activist investor Engine No. 1 won board seats 2021.',
 },
 BA: {
 name:'Boeing Company', founded:1916, ceo:'Kelly Ortberg (since Aug 2024)', hq:'Arlington, Virginia',
 desc:'Boeing is one of only two manufacturers of large commercial aircraft (with Airbus). Makes the 737, 767, 777, and 787 Dreamliner. Also a major US defense contractor (F-15, F/A-18, KC-46, Starliner). Has been in severe crisis since two 737 MAX crashes (2018-2019) killed 346 people, followed by a door-plug blowout on Alaska Airlines (Jan 2024).',
 bull:'Duopoly with Airbus means Boeing cannot permanently lose market share to zero — airlines need two suppliers. Backlog remains massive (5,600+ aircraft, ~$500B). New CEO Kelly Ortberg is an experienced aerospace executive (former Rockwell Collins CEO). Defense contracts provide some stability. When manufacturing quality stabilizes, free cash flow could recover significantly.',
 bear:'Manufacturing quality issues are systemic and will take years to fix. FAA production cap on 737 MAX limits cash generation. $60B+ in debt and burning cash. Spirit AeroSystems acquisition (fuselage manufacturer) adds complexity. Machinists union strike (2024) added further delays. Starliner space capsule failures damaged defense credibility. Airbus gaining market share that may never return.',
 financials:'Revenue ~$66B/yr. Net loss for multiple consecutive years. Operating cash flow deeply negative. Debt ~$60B. Significant equity dilution via share issuance.',
 moat:'Duopoly with Airbus (only two companies can build large commercial jets), massive certified aircraft backlog, and defense relationships.',
 history:'Founded 1916 by William Boeing in Seattle. B-17 and B-29 WWII. 707 jet era 1958. 747 Jumbo Jet 1969. Chicago HQ move 2001. 737 MAX certification scandal 2019. Two fatal crashes. Dave Calhoun CEO 2020, resigned 2024. Door plug blowout Jan 2024.',
 },
 },

 // ── INVESTING CONCEPTS ──
 concepts: {
 'stock':'A stock (also called a share or equity) is a small ownership piece of a company. If a company has 1 billion shares and you own 1,000, you own 0.0001% of the company. Stocks give you potential upside (if the company grows, your shares are worth more) and sometimes dividends (cash payments). Risk: companies can also decline or go bankrupt.',
 'etf':'An ETF (Exchange-Traded Fund) is a basket of stocks you can buy as one investment. SPY tracks the S&P 500 — buying one share of SPY is like owning tiny pieces of all 500 S&P 500 companies. ETFs are cheap (low fees), diversified, and trade on stock exchanges like regular stocks. Index ETFs are generally recommended over picking individual stocks.',
 'index fund':'An index fund tracks a market index (like the S&P 500 or NASDAQ) and holds all the stocks in it. Warren Buffett recommends S&P 500 index funds for most investors. Low fees, automatic diversification, and historically beat most professional fund managers over time.',
 'mutual fund':'A mutual fund is a pooled investment vehicle managed by a professional fund manager. Unlike ETFs, they trade once per day at the closing price. Usually higher fees than ETFs. Most actively managed mutual funds underperform index funds over 10+ years.',
 'dividend':'A dividend is a cash payment companies make to shareholders, usually quarterly. Example: Apple pays $0.24/share quarterly = $0.96/yr. If you own 100 shares, you receive $96/yr in cash regardless of stock price movement. Dividend yield = annual dividend ÷ stock price. High-yield dividend stocks: AT&T (~7%), Verizon (~7%), Realty Income (~5%).',
 'market cap':'Market capitalization = stock price × total shares outstanding. Tells you the total market value of a company. Mega-cap (>$200B): Apple, Microsoft. Large-cap ($10-200B): most S&P 500 companies. Mid-cap ($2-10B): growing companies. Small-cap (<$2B): higher risk, higher potential reward.',
 'pe ratio':'P/E ratio (Price-to-Earnings) = stock price ÷ annual earnings per share. Tells you how much investors are paying per dollar of earnings. P/E of 20 means investors pay $20 for every $1 of earnings. Historical S&P 500 average: ~15-17x. High P/E (40+): fast-growth companies priced for future growth. Low P/E (8-12): slow-growth, value stocks.',
 'eps':'EPS (Earnings Per Share) = net income ÷ total shares. If a company earns $10B with 10B shares, EPS = $1.00. Growing EPS means the company is becoming more profitable per share. Key metric for valuation.',
 'rsi':'RSI (Relative Strength Index) is a momentum indicator (0-100 scale). Above 70: overbought — stock may be due for a pullback. Below 30: oversold — stock may bounce. RSI is not a prediction — it just measures recent momentum. Works best combined with other signals. Invented by J. Welles Wilder in 1978.',
 'macd':'MACD (Moving Average Convergence Divergence) shows trend momentum by comparing a 12-day and 26-day exponential moving average. Bullish signal: MACD line crosses above signal line. Bearish signal: MACD line crosses below. Histogram shows the gap between the two lines. Add it to the chart using the indicator toolbar.',
 'bollinger bands':'Bollinger Bands are three lines: a 20-day moving average (middle), and two lines 2 standard deviations above/below. When price touches the upper band: potentially overbought. Lower band: potentially oversold. Bands narrow before big moves (volatility squeeze). Invented by John Bollinger.',
 'moving average':'A moving average smooths out price data by averaging prices over a period. 50-day MA and 200-day MA are most watched. Golden Cross: 50-day MA crosses above 200-day MA = bullish signal. Death Cross: 50-day crosses below 200-day = bearish signal.',
 'support resistance':'Support is a price level where a stock repeatedly bounces up — buyers step in. Resistance is a price level where a stock repeatedly gets rejected — sellers take profits. When a resistance level is broken, it often becomes the new support level.',
 'short selling':'Short selling is betting a stock will go down. You borrow shares, sell them, hope the price drops, then buy them back cheaper to return them. Profit = the difference. Risk: if the stock goes UP instead, your losses are theoretically unlimited. Very risky for beginners.',
 'options':'Options give you the right (but not obligation) to buy (call option) or sell (put option) a stock at a specific price (strike price) before a specific date (expiration). Calls profit when price goes up. Puts profit when price goes down. Options can expire worthless — you lose 100% of premium paid. Complex and risky.',
 'portfolio':'A portfolio is your collection of investments. Good portfolio management means diversification — spreading investments across different assets, sectors, and geographies so one bad investment doesn\'t destroy you. Rule of thumb: don\'t put more than 10% in any single stock.',
 'diversification':'Diversification means spreading investments across many different assets to reduce risk. If you own only Apple stock and Apple crashes 50%, your whole investment crashes. If you own Apple + Tesla + JPM + BTC + S&P 500 ETF, one crash hurts much less. "Don\'t put all your eggs in one basket."',
 'dollar cost averaging':'Dollar-cost averaging (DCA) means investing a fixed amount regularly (e.g. $100/month) regardless of price. When price is high, you buy fewer shares. When price is low, you buy more shares automatically. Over time this reduces the average price you paid and removes the stress of "timing the market."',
 'compound interest':'Compound interest is earning returns on your returns. $10,000 at 10%/yr: Year 1 = $11,000. Year 2 = $12,100. Year 10 = $25,937. Year 30 = $174,494. Einstein allegedly called it the 8th wonder of the world. Start investing early — time is your biggest advantage.',
 'bull market':'A bull market is a period of rising prices, typically defined as 20%+ rise from recent lows. US stock market has been in more bull markets than bear markets. Average bull market lasts ~4-5 years. Characterized by investor optimism and economic growth.',
 'bear market':'A bear market is a 20%+ decline from recent highs. Since 1900 the S&P 500 has had ~34 bear markets. Average bear market lasts ~9-16 months. Caused by recessions, financial crises, or valuation excess. The right strategy in a bear market: stay invested, keep buying, don\'t panic sell.',
 'inflation':'Inflation is the rise in prices over time. At 3% inflation, $100 today = $97 in purchasing power next year. Inflation erodes cash savings. Stocks historically beat inflation over long periods. Real return = nominal return minus inflation. The Fed targets 2% inflation.',
 'interest rates':'The Federal Reserve sets the federal funds rate, which influences all other rates. High rates: expensive to borrow money, bad for growth stocks and crypto, good for banks and savers. Low rates: cheap borrowing, good for growth stocks, real estate, crypto. 2022 rate hikes caused -30% stock crash.',
 'recession':'A recession is two consecutive quarters of negative GDP growth. During recessions: unemployment rises, company earnings fall, stocks typically drop 20-40%. But stocks usually recover 6-12 months before the recession officially ends. Historically, buying during recessions has been very profitable long-term.',
 'ipo':'An IPO (Initial Public Offering) is when a private company sells shares to the public for the first time. Recent notable IPOs: Reddit, Instacart, ARM. IPOs are risky — no trading history, often overpriced on day one, 6-month lockup expiry can cause selling. Most IPOs underperform the market in their first year.',
 'crypto wallet':'A crypto wallet stores your private keys — the password that proves you own your crypto. Hot wallets (Coinbase, MetaMask) are connected to the internet — convenient but hackable. Cold wallets (Ledger, Trezor) are offline hardware devices — much safer. "Not your keys, not your coins" — if your exchange gets hacked, you could lose everything.',
 'blockchain':'A blockchain is a distributed ledger — a database copied across thousands of computers worldwide. Each "block" of transactions is chained to the previous one using cryptography, making it nearly impossible to alter history. Bitcoin uses blockchain for transactions. Ethereum uses it for programmable smart contracts.',
 'halving':'Bitcoin halving happens every 4 years (~210,000 blocks). The mining reward is cut in half. April 2024: reward dropped from 6.25 BTC to 3.125 BTC per block. Historically, halvings reduce new supply and have preceded bull markets: 2012 halving → 2013 bull run. 2016 halving → 2017 bull run. 2020 halving → 2021 bull run.',
 'staking':'Staking means locking up crypto to help validate transactions on a Proof of Stake blockchain (like Ethereum). In return, you earn staking rewards (like interest). Ethereum staking yield: ~3.5-5%/yr. Solana: ~6-7%/yr. Risk: your staked crypto is locked and subject to price volatility.',
 'defi':'DeFi (Decentralized Finance) is financial services (lending, borrowing, trading) built on blockchains without banks. Examples: Uniswap (decentralized exchange), Aave (lending), Compound (lending). Offer high yields but also high risk — smart contract bugs, hacks, and rug pulls are common.',
 'nft':'An NFT (Non-Fungible Token) is a unique digital asset on a blockchain proving ownership of something — art, music, game items, etc. Unlike crypto coins, each NFT is unique. NFT market peaked 2021-2022 and crashed 95%+ since. Most are worthless. Some (CryptoPunks, Bored Apes) retain value as cultural artifacts.',
 },

 // ── GENERAL INVESTING QUESTIONS ──
 general: {
 'how much should i invest':'Most financial advisors suggest investing 10-20% of your income. Only invest money you won\'t need for at least 3-5 years. Never invest money you need for rent, food, or emergencies. Build a 3-6 month emergency fund first. Max out your 401(k) employer match before investing individually — that\'s a 50-100% instant return.',
 'where to start':'Start with: (1) Open a free brokerage account — Fidelity, Charles Schwab, or Robinhood. (2) Buy a simple S&P 500 index ETF (ticker: VOO or SPY). (3) Set up automatic monthly contributions. (4) Don\'t check it daily — invest and forget for years. Index funds beat most professional investors over 10+ years. Don\'t complicate it early on.',
 'how to pick stocks':'Most professional stock pickers underperform the S&P 500. If you do pick stocks: look for strong earnings growth (15%+/yr), wide competitive moat, reasonable P/E vs growth (PEG ratio), strong balance sheet (low debt), and management you trust. Only put 10% max in any single stock. Always buy with a long-term (3-5yr+) time horizon.',
 'tax on stocks':'In the US: stocks held under 1 year are taxed as ordinary income (up to 37%). Stocks held over 1 year: long-term capital gains tax (0%, 15%, or 20% depending on income). Tax-advantaged accounts: 401(k) and IRA let your investments grow tax-free or tax-deferred. Consult a tax professional for your specific situation.',
 'best stocks to buy':'No one reliably predicts which individual stocks will outperform. The honest answer: most people should buy low-cost S&P 500 index funds (VOO, SPY) and hold for decades. If you want to pick stocks, focus on companies with: strong competitive advantages, growing earnings, reasonable valuations, and industries you understand.',
 'how to read a stock chart':'A stock chart shows price over time. Key elements: (1) Candlesticks — green/red bars showing open, close, high, low for each period. (2) Volume — bars at bottom showing how many shares traded. (3) Moving averages — smooth lines showing average price over 50 or 200 days. (4) Support/resistance — horizontal levels where price repeatedly bounces or gets rejected.',
 'difference between stocks and crypto':'Stocks: ownership in real companies with earnings, employees, products. Regulated by SEC. Most survive long-term. Lower volatility. Crypto: digital assets with no underlying earnings. Less regulated. Many go to zero. Far higher volatility (Bitcoin can drop 80% in a bear market). Crypto is speculative; stocks are ownership.',
 }
};

function getChatReply(msg, ticker, name) {
 const m = msg.toLowerCase().trim();
 const p = realProfile(ticker);
 const d = assetDataOrNull(ticker);
 const kbp = KB.profiles[ticker];
 const tk = TICKERS.find(e => e.t === ticker);
 const isCrypto = tk?.k === 'c';
 const isIndex = tk?.k === 'i';

 // ── Helper: format a rich response ──
 function rich(title, body) {
 return `<strong>${title}</strong><br><br>${body}`;
 }
 const _real = realChatReply(m, ticker, rich);
 if (_real) return _real;

 // ── 1. COMPANY / ASSET IDENTITY ──
 if (m.match(/^(what is|what('s| is) a|tell me about|who is|what are|explain|describe)\s/)) {
 // Check concepts first
 for (const [concept, explanation] of Object.entries(KB.concepts)) {
 if (m.includes(concept)) return rich(concept.charAt(0).toUpperCase() + concept.slice(1), explanation);
 }
 if (kbp) return rich(`${ticker} — ${kbp.name}`, kbp.desc + `<br><br><strong>The bull case:</strong> ${kbp.bull}<br><br><strong>The bear case:</strong> ${kbp.bear}`);
 return CHAT_KB['what is'](ticker);
 }

 // ── 2. CONCEPTS — check if asking about investing terms ──
 for (const [concept, explanation] of Object.entries(KB.concepts)) {
 if (m.includes(concept) && !m.includes(ticker.toLowerCase())) {
 return rich(concept.charAt(0).toUpperCase() + concept.slice(1) + ' — Explained', explanation);
 }
 }

 // ── 3. GENERAL INVESTING QUESTIONS ──
 for (const [question, answer] of Object.entries(KB.general)) {
 const keywords = question.split(' ');
 if (keywords.filter(k => k.length > 3).every(k => m.includes(k)) || m.includes(question)) {
 return rich('Investing Guide', answer);
 }
 }

 // ── 4. CEO / LEADERSHIP ──
 if (m.match(/ceo|founder|who (runs|leads|started|created|made|built|owns)|leader|management|founded|created by/)) {
 if (kbp) return rich(`${ticker} — Leadership`, `<strong>CEO:</strong> ${kbp.ceo}<br><strong>Founded:</strong> ${kbp.founded}<br><strong>HQ:</strong> ${kbp.hq}<br><br>${kbp.history||''}`);
 return CHAT_KB['who runs'](ticker);
 }

 // ── 5. HISTORY / BACKGROUND ──
 if (m.match(/history|background|when (was|did|were)|how (old|long)|founded|started|origin|story|timeline/)) {
 if (kbp?.history) return rich(`${ticker} — History`, kbp.history);
 return CHAT_KB['what is'](ticker);
 }

 // ── 6. BUSINESS MODEL / HOW IT MAKES MONEY ──
 if (m.match(/how does .* (make|earn|generate)|business model|revenue|how (it|they|does .* ) make money|where does .* money come from|profit/)) {
 if (kbp) return rich(`How ${ticker} Makes Money`, CHAT_KB['how does'](ticker) + `<br><br><strong>Key financials:</strong> ${kbp.financials}`);
 return CHAT_KB['how does'](ticker);
 }

 // ── 7. FINANCIALS / EARNINGS ──
 if (m.match(/financials|earnings|revenue|profit|income|sales|balance sheet|eps|cash|debt|quarterly|annual/)) {
 if (kbp?.financials) return rich(`${ticker} — Financial Summary`, kbp.financials + `<br><br>For live data, check <a href="https://finance.yahoo.com/quote/${ticker}/financials" target="_blank" style="color:var(--accent2)">Yahoo Finance Financials ↗</a>`);
 return `For ${ticker}'s full financial data including revenue, earnings, and balance sheet, visit <a href="https://finance.yahoo.com/quote/${ticker}/financials" target="_blank" style="color:var(--accent2)">Yahoo Finance ↗</a>.`;
 }

 // ── 8. COMPETITIVE MOAT ──
 if (m.match(/moat|advantage|competitive|why (is it|does it|so) (good|strong|dominant|special)|unique|edge/)) {
 if (kbp?.moat) return rich(`${ticker} — Competitive Advantage`, kbp.moat + `<br><br><strong>Competitors:</strong> ${CHAT_KB['competitor'](ticker)}`);
 return CHAT_KB['competitor'](ticker);
 }

 // ── 9. BULL / BEAR CASE ──
 if (m.match(/bull case|why (buy|good|up|rise)|upside|reasons to buy|positive|pros|optimistic/)) {
 if (kbp?.bull) return rich(`${ticker} — The Bull Case `, kbp.bull);
 return p ? `Bull case for ${ticker}: ${p.reason.split(/[Rr]isks?:/)[0]}` : `Research ${ticker}'s growth drivers on Yahoo Finance.`;
 }
 if (m.match(/bear case|why (sell|bad|down|fall|drop)|downside|reasons (not|to avoid)|negative|cons|pessimistic|concern/)) {
 if (kbp?.bear) return rich(`${ticker} — The Bear Case `, kbp.bear);
 return p ? `Bear case for ${ticker}: Risks include ${p.reason.split(/[Rr]isks?:/)[1]?.split('.')[0] || 'market, sector, and company-specific risks.'}` : `Research ${ticker}'s risks on Yahoo Finance.`;
 }

 // ── 10. BUY / SELL / HOLD RECOMMENDATION ──
 if (m.match(/should i (buy|sell|hold|invest|get|purchase|avoid)|worth (buying|it)|good (buy|investment|stock)|recommend|would you buy/)) {
 if (p && kbp) {
 const pros = p.reason.split(/[Rr]isks?:/)[0].trim();
 const risks = p.reason.split(/[Rr]isks?:/)[1]?.split('.')[0]?.trim() || '';
 return rich(`${ticker} — ${p.verdict} (${p.score}/100)`,
 `<strong>Why consider buying:</strong> ${pros}<br><br>` +
 (risks ? `<strong>Key risks:</strong> ${risks}.<br><br>` : '') +
 `<strong>Moat:</strong> ${kbp.moat}<br><br>` +
 `<em> Not financial advice. Always diversify and only invest what you can afford to lose.</em>`);
 }
 if (p) return rich(`${ticker} — ${p.verdict}`, p.reason + `<br><br><em>Not financial advice.</em>`);
 return `For ${ticker}, evaluate: (1) Does it have a durable competitive advantage? (2) Is it growing revenue and earnings? (3) Is the valuation reasonable vs peers? (4) Can you hold through a 50% drawdown? Check Yahoo Finance for analyst ratings.`;
 }

 // ── 11. RISK ASSESSMENT ──
 if (m.match(/risk|risky|safe|volatile|dangerous|lose (money|everything)|downside|drawdown|crash|drop/)) {
 if (d && kbp) {
 const [beta, vol] = d;
 const level = vol >= 70 ? ' HIGH' : vol >= 40 ? ' MODERATE' : ' LOWER';
 return rich(`${ticker} — Risk Assessment: ${level}`,
 `• Annualized volatility: <strong>~${vol}%</strong> (${vol>=70?'very high — 50-80% drops possible in bear markets':vol>=40?'significant — 20-40% drops common':'moderate for its category'})<br>` +
 `• Beta: <strong>${beta}x</strong> (moves ${beta}x as much as the S&P 500)<br>` +
 `• Bear case: ${kbp.bear}<br><br>` +
 (isCrypto ? ` Crypto assets can lose 70-90%+ in bear markets. Only invest what you can afford to lose entirely.` :
 isIndex ? `Index funds reduce single-stock risk through diversification, but still drop 30-50% in recessions.` :
 `Individual stocks carry company-specific risk on top of market risk. Diversify across at least 10-20 stocks or use an index ETF.`));
 }
 return CHAT_KB['risk'](ticker);
 }

 // ── 12. PRICE PREDICTION ──
 if (m.match(/predict|forecast|future (price|value)|where (will|could) (it|the price)|price in (a year|6 months|2025|2026|2027|2028)|target price|price target|go up|go down|will it/)) {
 const F = window._fc?.ticker === ticker ? window._fc.R : null;
 if (F) {
  const line = (h) => `• <strong>${h.label}:</strong> most likely ${fcMoney(h.p50)} (${fcPctTxt(h.p50 / F.price - 1)}), 80% range ${fcMoney(h.p10)} to ${fcMoney(h.p90)}, ${Math.round(h.pUp * 100)}% chance higher`;
  return rich(`${ticker}: price outlook`,
   `From ${Math.max(1, Math.round(F.stats.years))} years of real daily prices, starting at ${fcMoney(F.price)}:<br><br>` +
   [F.horizons[1], F.horizons[2], F.horizons[4]].map(line).join('<br>') + '<br><br>' +
   (F.backtest.coverage != null ? `Over the last year the 1-month range caught the real price ${Math.round(F.backtest.coverage * 100)}% of the time.<br><br>` : '') +
   `<em>Statistical estimate only. No one can reliably predict prices.</em>`);
 }
 return `Open the <strong>AI forecast</strong> tab next to Chart. It reads ${ticker}'s real price history and shows the likely price range from 1 week to 1 year, what's driving it, and how accurate the model has been.`;
 }

 // ── 13. VOLATILITY / BETA ──
 if (m.match(/volatil|beta|how much (does it|does ${ticker.toLowerCase()}) (swing|move|fluctuat)|swing|stable/)) {
 if (d) {
 const [beta, vol] = d;
 return rich(`${ticker} — Volatility Profile`,
 `• <strong>Annual volatility:</strong> ~${vol}% — in a typical year, ${ticker}'s price moves up or down by about ${vol}% from its average<br>` +
 `• <strong>Beta:</strong> ${beta}x — ${beta>1.5?'much more volatile than the market':beta>1?'more volatile than the market':beta<0.8?'significantly less volatile than the market':'roughly in line with the market'}<br>` +
 `• <strong>Risk level:</strong> ${vol>=70?' Very high':vol>=50?' High':vol>=35?' Moderate-high':vol>=20?' Moderate':' Lower'}<br><br>` +
 `Compare: S&P 500 ~15-18% volatility. NASDAQ ~22%. Bitcoin ~70-80%. Gold ~12%.`);
 }
 return CHAT_KB['volatility'](ticker);
 }

 // ── 14. DIVIDENDS ──
 if (m.match(/dividend|income|yield|passive income|pay out|distribution/)) {
 const divData = {
 AAPL:'$0.96/yr ($0.24 quarterly), ~0.4% yield',MSFT:'$3.00/yr ($0.75 quarterly), ~0.7% yield',
 JPM:'$4.20/yr ($1.05 quarterly), ~2.2% yield',JNJ:'$4.76/yr ($1.19 quarterly), ~3.0% yield',
 V:'$2.08/yr ($0.52 quarterly), ~0.7% yield',MA:'$2.64/yr ($0.66 quarterly), ~0.6% yield',
 WMT:'$2.28/yr ($0.57 quarterly), ~1.0% yield',BAC:'$0.96/yr ($0.24 quarterly), ~2.3% yield',
 XOM:'$3.96/yr ($0.99 quarterly), ~3.4% yield',CVX:'$6.52/yr ($1.63 quarterly), ~4.0% yield',
 LLY:'$5.20/yr ($1.30 quarterly), ~0.8% yield',AVGO:'$8.40/yr ($2.10 quarterly), ~1.3% yield',
 AMGN:'$9.00/yr ($2.25 quarterly), ~2.9% yield',GILD:'$3.08/yr ($0.77 quarterly), ~3.5% yield',
 HON:'$4.32/yr ($1.08 quarterly), ~2.0% yield',CAT:'$5.20/yr ($1.30 quarterly), ~1.4% yield',
 DE:'$5.76/yr ($1.44 quarterly), ~1.5% yield',GE:'$0.28/yr ($0.07 quarterly), ~0.3% yield',
 };
 if (divData[ticker]) return rich(`${ticker} — Dividend`, `${ticker} pays a dividend of ${divData[ticker]}.<br><br>Dividend investors look for: consistent payment history, dividend growth, payout ratio <60%, and strong free cash flow to sustain payments.`);
 if (['TSLA','NVDA','AMZN','GOOGL','META','AMD'].includes(ticker)) return rich(`${ticker} — No Dividend`, `${ticker} does not pay a dividend. Growth companies like ${ticker} reinvest profits into the business rather than paying shareholders. This means your return comes entirely from stock price appreciation.`);
 if (isCrypto) return rich(`Crypto & Income`, `Traditional cryptocurrencies like ${ticker} don't pay dividends. However, you can earn yield through: (1) Staking — locking up your crypto to earn rewards (~3-7%/yr for ETH, ~6-7%/yr for SOL). (2) Lending platforms (higher risk). (3) Liquidity providing on DeFi protocols (highest yield, highest risk).`);
 return CHAT_KB['dividend'](ticker);
 }

 // ── 15. COMPETITORS ──
 if (m.match(/competitor|vs |versus|compared to|alternative|other (stocks|options|cryptos)|rivals|competition/)) {
 if (kbp?.moat) return rich(`${ticker} — Competitors & Moat`, `<strong>Main competitors:</strong> ${CHAT_KB['competitor'](ticker)}<br><br><strong>${ticker}'s competitive advantage:</strong> ${kbp.moat}`);
 return CHAT_KB['competitor'](ticker);
 }

 // ── 16. HOW TO BUY ──
 if (m.match(/how (to|do i|can i) (buy|purchase|invest|get)|where (to|can i) buy|which (app|broker|platform|account)|robinhood|fidelity|coinbase|schwab|etrade/)) {
 const brokerText = isCrypto
 ? `Best platforms for ${ticker}: <strong>Coinbase</strong> (easiest for beginners), <strong>Kraken</strong> (lower fees), or <strong>Robinhood</strong> (already have stocks there). For large amounts, Coinbase Advanced or Gemini.`
 : `Best platforms for ${ticker}: <strong>Fidelity</strong> or <strong>Schwab</strong> (best for long-term), <strong>Robinhood</strong> (simplest UI), <strong>Webull</strong> (good for charts). All are commission-free.`;
 return rich(`How to Buy ${ticker}`,
 `${brokerText}<br><br><strong>Step by step:</strong><br>1. Open a free account (takes 5 min)<br>2. Fund it via bank transfer (1-3 business days)<br>3. Search "${ticker}" and click Buy<br>4. Choose: <strong>Market order</strong> (buys immediately at current price) or <strong>Limit order</strong> (buys only at your target price)<br>5. Set up recurring automatic investments for dollar-cost averaging<br><br>You can buy fractional shares — you don't need to buy a whole share. $50/month in ${ticker} is a valid strategy.`);
 }

 // ── 17. LONG TERM OUTLOOK ──
 if (m.match(/long.?term|5 year|10 year|hold for|decade|years from now|future of|outlook/)) {
 if (d && kbp) {
 const [, vol, sector, growth5yr] = d;
 const val5 = (100*Math.pow(1+growth5yr/100,5)).toFixed(0);
 const val10 = (100*Math.pow(1+growth5yr/100,10)).toFixed(0);
 return rich(`${ticker} — Long-Term Outlook`,
 `<strong>${sector} sector, ${growth5yr}%/yr historical avg growth:</strong><br><br>` +
 `• Hypothetical 5yr growth: <strong>${val5}%</strong> of current price<br>` +
 `• Hypothetical 10yr growth: <strong>${val10}%</strong> of current price<br>` +
 `• Volatility: ±${vol}% annually — expect major ups and downs<br><br>` +
 `<strong>Bull case:</strong> ${kbp.bull.split('.')[0]}.<br>` +
 `<strong>Key risk:</strong> ${kbp.bear.split('.')[0]}.<br><br>` +
 `<em>Hypothetical only. Past growth rates do not guarantee future performance.</em>`);
 }
 }

 // ── 18. SHORT TERM / TRADING ──
 if (m.match(/short.?term|day trad|swing trad|this week|this month|trade|quick (profit|gain)/)) {
 return rich(`Short-Term Trading ${ticker}`,
 `Short-term trading is significantly riskier than long-term investing. Key things to watch:<br><br>` +
 `• <strong>RSI:</strong> Above 70 = overbought, below 30 = oversold<br>` +
 `• <strong>MACD:</strong> Line crossing above signal line = bullish momentum<br>` +
 `• <strong>Volume:</strong> High volume confirms price moves; low volume = weak signal<br>` +
 `• <strong>Support/resistance:</strong> Price levels where ${ticker} repeatedly bounces or gets rejected<br><br>` +
 `Use the Technical Analysis widget above for live buy/sell signals across multiple timeframes.<br><br>` +
 (isCrypto ? ` Crypto can move 10-20% in a single day. Never trade more than you can afford to lose.` :
 ` Even professional traders lose money short-term. Study before you trade real money.`));
 }

 // ── 19. MARKET CONDITIONS / MACRO ──
 if (m.match(/market (crash|correction|recession|bubble)|economy|inflation|interest rate|fed |federal reserve|macro|rate (hike|cut)/)) {
 if (d) {
 const [beta] = d;
 return rich(`Macro Impact on ${ticker}`, macroChatLine(ticker) +
 `<strong>Interest rates:</strong> When the Fed raises rates, growth stocks (especially tech and crypto) tend to fall as future earnings are worth less today. ${beta>1.5?`${ticker} has high beta (${beta}x) — very sensitive to rate changes.`:`${ticker} has ${beta<0.9?'defensive characteristics — less sensitive to rate changes.':'moderate sensitivity to interest rate changes.'}`}<br><br>` +
 `<strong>Inflation:</strong> High inflation → Fed raises rates → growth stocks/crypto fall. Moderate inflation (2-3%) is healthy for stocks.<br><br>` +
 `<strong>Recession:</strong> ${isCrypto?'Crypto typically falls sharply in risk-off environments. Bitcoin dropped 75%+ in 2022.':isIndex?`${ticker} drops in recessions but historically recovers fully within 1-3 years.`:`${d[0]<0.9?ticker+' is relatively defensive — it tends to hold up better than average in downturns.':ticker+' has high beta — it amplifies both gains and losses vs the market.'}`}<br><br>` +
 `<strong>Historical drawdowns for ${ticker}'s category:</strong> ${isCrypto?'Bitcoin: -85% (2018), -75% (2022)':isIndex?'S&P 500: -57% (2008-09), -34% (2020), -25% (2022)':'Individual stocks can drop 50-80%+ in severe bear markets.'}`);
 }
 }

 // ── 20. BEGINNER GUIDE ──
 if (m.match(/beginner|new to|first time|just start|don.t know|never invest|where do i (start|begin)|how do i (start|begin)|simple|explain (simply|like)|noob|novice/)) {
 return rich(`Beginner's Guide to ${ticker}`,
 `1 <strong>What it is:</strong> ${isCrypto?`A cryptocurrency — digital money not controlled by any bank or government.`:isIndex?`A market index — tracks ${ticker==='SPX'?'500 large US companies':'multiple companies'} in one investment.`:`A company stock — owning a share means owning a tiny piece of ${name}.`}<br><br>` +
 `2 <strong>How you make money:</strong> Price goes up → sell for profit. ${!isCrypto&&['AAPL','MSFT','JNJ','JPM','V','WMT'].includes(ticker)?'Also pays cash dividends regularly.':''}<br><br>` +
 `3 <strong>How to buy:</strong> Open a free account on ${isCrypto?'Coinbase or Kraken':'Robinhood, Fidelity, or Schwab'}. Search "${ticker}". Click Buy. Start with as little as $10.<br><br>` +
 `4 <strong>Risk:</strong> ${d?`This has ${d[1]}% annual volatility — could drop ${d[1]>=60?'50-80%':'20-40%'} in a bad year.`:'All investments can lose value.'} Only invest money you can afford to lose.<br><br>` +
 `5 <strong>Our take:</strong> ${p?`Analysis verdict: <strong>${p.verdict}</strong> (${p.score}/100) — see the AI Analysis card above.`:'Check the AI Analysis card above for our assessment.'}<br><br>` +
 `6 <strong>Pro tip:</strong> Don't put all your money in one investment. Use dollar-cost averaging (invest a fixed amount monthly).`);
 }

 // ── 21. COMPARISON / WHICH IS BETTER ──
 if (m.match(/better|vs |versus|or (aapl|msft|tsla|nvda|btc|eth|spy|googl|amzn)|compare|difference between/)) {
 return rich(`${ticker} — Comparison`,
 `Use the <strong>Compare tab</strong> at the top of the page to see ${ticker} side-by-side with any other investment — full charts, technical analysis, and price history for both.<br><br>` +
 (kbp ? `<strong>${ticker}'s unique strengths:</strong> ${kbp.moat}` : ''));
 }

 // ── 22. VALUATION — is it expensive / cheap? ──
 if (m.match(/expensive|cheap|overvalued|undervalued|valuation|worth it|fair value|overpriced|good price|pe |p\/e|price.to.earnings/)) {
 if (p && d) {
 const [beta, vol, sector, growth] = d;
 const peg = p.score >= 75 ? 'below' : p.score >= 58 ? 'roughly in line with' : 'above';
 const valVerdict = p.score >= 75 ? `At a score of ${p.score}/100, our model sees ${ticker} as reasonably valued or even undervalued relative to its growth potential.`
 : p.score >= 58 ? `At a score of ${p.score}/100, ${ticker} appears fairly valued — not a screaming bargain, but not obviously overpriced.`
 : `At a score of ${p.score}/100, our model flags ${ticker} as potentially overvalued relative to its fundamentals and growth rate.`;
 return rich(`${ticker} — Valuation`,
 `${valVerdict}<br><br>` +
 `<strong>Sector:</strong> ${sector} — typical P/E range varies widely by sector. Growth tech trades at 25-50x; financials 10-15x; utilities 15-20x.<br><br>` +
 `<strong>Historical avg growth:</strong> ~${growth}%/yr — a higher growth rate justifies a higher P/E (PEG ratio framework).<br><br>` +
 `<strong>Volatility:</strong> ~${vol}% annually — higher volatility stocks often trade at a discount to reflect uncertainty.<br><br>` +
 `For real-time P/E, P/S, and EV/EBITDA, check <a href="https://finance.yahoo.com/quote/${ticker}" target="_blank" style="color:var(--accent2)">Yahoo Finance ↗</a>.<br><br>` +
 `<em> Valuation alone doesn't determine returns — timing, sentiment, and earnings surprises matter too.</em>`);
 }
 return `Valuation depends on the current price vs earnings and growth rate. Check Yahoo Finance for ${ticker}'s live P/E, P/S, and analyst price targets.`;
 }

 // ── 23. ENTRY POINT — when to buy / dip / price target ──
 if (m.match(/when (to|should i) buy|good (entry|price|time to buy)|buy the dip|wait (to buy|for a dip)|price target|entry point|too (high|late)|already up a lot/)) {
 if (p && d) {
 const [, vol] = d;
 const dipRange = (vol * 0.35).toFixed(0);
 return rich(`${ticker} — When to Buy`,
 `Our verdict on ${ticker} is <strong style="color:${p.color}">${p.verdict}</strong> (${p.score}/100).<br><br>` +
 `<strong>Timing strategies:</strong><br>` +
 `• <strong>Dollar-cost averaging (DCA):</strong> Buy a fixed dollar amount monthly regardless of price — removes the stress of timing<br>` +
 `• <strong>Buy the dip:</strong> ${ticker} has ~${vol}% annual volatility, so pullbacks of ${dipRange}%+ can offer better entry points<br>` +
 `• <strong>Lump sum:</strong> Studies show lump-sum investing beats DCA ~65% of the time over 10yr periods<br>` +
 `• <strong>Limit orders:</strong> Set a target price below market and let the order fill automatically if ${ticker} drops<br><br>` +
 `<strong>General rule:</strong> The best time to invest in quality assets is usually "now" if you have a 3-5+ year horizon. Trying to time the exact bottom is nearly impossible.<br><br>` +
 `<em> Not financial advice. Always size your position so a 50% drop won't derail your financial plan.</em>`);
 }
 return `For timing, consider dollar-cost averaging — invest a fixed amount in ${ticker} monthly rather than trying to pick the perfect entry point. Check the Price Prediction tab for our statistical forecast.`;
 }

 // ── 24. SECTOR / INDUSTRY ──
 if (m.match(/sector|industry|space|field|category|type of (company|stock|asset)/)) {
 if (d) {
 const [beta, vol, sector, growth] = d;
 const sectorPeers = {
 Technology:['AAPL','MSFT','GOOGL','META'],Semiconductors:['NVDA','AMD','INTC','AVGO','QCOM'],
 Healthcare:['JNJ','LLY','AMGN','GILD'],Finance:['JPM','BAC','GS','WFC'],
 'E-Commerce':['AMZN','SHOP','EBAY'],Payments:['V','MA','PYPL'],
 Streaming:['NFLX','DIS','SPOT'],EV:['TSLA','RIVN','NIO','LCID'],
 Crypto:['BTC','ETH','SOL','BNB'],Energy:['XOM','CVX','COP'],
 Aerospace:['BA','LMT','RTX'],Software:['CRM','ORCL','ADBE','PLTR'],
 Industrials:['CAT','HON','DE','GE'],
 }[sector] || [];
 const peers = sectorPeers.filter(t => t !== ticker).slice(0,3);
 return rich(`${ticker} — Sector: ${sector}`,
 `${name} operates in the <strong>${sector}</strong> sector.<br><br>` +
 `<strong>Sector characteristics:</strong><br>` +
 `• Historical avg growth: ~${growth}%/yr<br>` +
 `• Volatility: ~${vol}% annually<br>` +
 `• Beta vs market: ${beta}x<br>` +
 (peers.length ? `<br><strong>Comparable companies:</strong> ${peers.join(', ')} — use the Compare tab to analyze side-by-side.<br>` : '') +
 `<br>Use the <strong>Screener tab</strong> to filter stocks by sector, verdict, and other criteria.`);
 }
 }

 // ── 25. NEWS / CATALYSTS ──
 if (m.match(/news|catalyst|upcoming|earnings|what.s happening|what happened|recent|latest|any updates|announcement/)) {
 if (kbp) {
 return rich(`${ticker} — Key Catalysts to Watch`,
 `The most important factors moving <strong>${ticker}</strong> right now:<br><br>` +
 `<strong>Bull catalysts:</strong> ${kbp.bull.split('.').slice(0,2).join('.')}.<br><br>` +
 `<strong>Risk factors:</strong> ${kbp.bear.split('.').slice(0,2).join('.')}.<br><br>` +
 `<strong>For real-time news:</strong> The news feed below the analysis is updated regularly. For live earnings calendar, analyst upgrades, and breaking news, check <a href="https://finance.yahoo.com/quote/${ticker}/news" target="_blank" style="color:var(--accent2)">Yahoo Finance News ↗</a>.`);
 }
 return `For the latest ${ticker} news and earnings calendar, check <a href="https://finance.yahoo.com/quote/${ticker}/news" target="_blank" style="color:var(--accent2)">Yahoo Finance ↗</a>. The simulated news feed below shows key themes to watch.`;
 }

 // ── 26. PORTFOLIO SIZING — how much to invest ──
 if (m.match(/how much (to|should i) (invest|buy|put|allocate)|position size|allocation|percentage|what percent|how many shares/)) {
 if (d) {
 const [, vol] = d;
 const maxPct = vol >= 70 ? 2 : vol >= 50 ? 5 : vol >= 35 ? 8 : 10;
 return rich(`${ticker} — Position Sizing`,
 `Based on ${ticker}'s volatility (~${vol}%/yr), here's a risk-adjusted sizing framework:<br><br>` +
 `• <strong>Conservative:</strong> 1-${Math.round(maxPct*0.5)}% of your portfolio<br>` +
 `• <strong>Moderate:</strong> ${Math.round(maxPct*0.5)}-${maxPct}% of your portfolio<br>` +
 `• <strong>Aggressive:</strong> ${maxPct}-${maxPct*2}% (only if you deeply understand ${ticker})<br><br>` +
 `<strong>Rule of thumb:</strong> Size positions so that if ${ticker} drops 50%, your overall portfolio drops no more than you can emotionally handle.<br><br>` +
 `${vol >= 60 ? ` ${ticker} is high-volatility. A $10,000 position could fall to $2,000-$4,000 in a severe bear market.` : `${ticker} has moderate volatility — standard diversification rules apply.`}<br><br>` +
 `<em>Always consult a financial advisor for personalized advice.</em>`);
 }
 }

 // ── 27. SUMMARY / OVERVIEW ──
 if (m.match(/summary|overview|tldr|give me the key|quick take|in a nutshell|brief|main points|key facts/)) {
 if (p && kbp && d) {
 const [beta, vol, sector] = d;
 return rich(`${ticker} — Quick Summary`,
 `<strong>Verdict:</strong> <span style="color:${p.color}">${p.verdict}</span> (${p.score}/100)<br>` +
 `<strong>Sector:</strong> ${sector} &nbsp;|&nbsp; <strong>Volatility:</strong> ~${vol}%/yr &nbsp;|&nbsp; <strong>Beta:</strong> ${beta}x<br><br>` +
 `<strong>In one sentence:</strong> ${kbp.desc.split('.')[0]}.<br><br>` +
 `<strong>Best reason to own it:</strong> ${kbp.bull.split('.')[0]}.<br>` +
 `<strong>Biggest risk:</strong> ${kbp.bear.split('.')[0]}.<br><br>` +
 `<strong>CEO:</strong> ${kbp.ceo} &nbsp;|&nbsp; <strong>Founded:</strong> ${kbp.founded} &nbsp;|&nbsp; <strong>HQ:</strong> ${kbp.hq}`);
 }
 if (p) return rich(`${ticker} — Summary`, `Verdict: <span style="color:${p.color}">${p.verdict}</span> (${p.score}/100)<br><br>${p.reason}`);
 }

 // ── 22. SPECIFIC TICKER CHAT_KB fallback ──
 for (const [key, fn] of Object.entries(CHAT_KB)) {
 if (m.includes(key)) {
 try { return fn(ticker); } catch { return fn(); }
 }
 }

 // ── 23. SMART FALLBACK — always tries to say something useful ──
 if (kbp) {
 // If the question mentions specific things about the company, give company overview
 const companyWords = kbp.name.toLowerCase().split(' ').concat([ticker.toLowerCase()]);
 if (companyWords.some(w => w.length > 3 && m.includes(w))) {
 return rich(`${ticker} — ${kbp.name}`,
 `${kbp.desc}<br><br><strong>Financials:</strong> ${kbp.financials}<br><br>` +
 `<strong>Competitive moat:</strong> ${kbp.moat}<br><br>` +
 `What else would you like to know? Try: "Should I buy ${ticker}?", "What are the risks?", "What's the long-term outlook?", or "How does ${ticker} make money?"`);
 }
 }

 // Final fallback with useful suggestions
 const suggestions = [
 `"Should I buy ${ticker}?"`,
 `"What are the risks of ${ticker}?"`,
 `"How does ${ticker} make money?"`,
 `"What's the long-term outlook?"`,
 `"What is RSI?"`,
 `"Explain ${isCrypto?'crypto':'stock market'} to a beginner"`,
 ];
 return `I can answer questions about <strong>${name} (${ticker})</strong> and general investing concepts. Try asking:<br><br>${suggestions.map(s=>`• ${s}`).join('<br>')}`;
}

function askChip(btn, question) {
 // Highlight the selected chip, reset others
 document.querySelectorAll('.chat-chip').forEach(c => c.classList.remove('used'));
 if(btn) btn.classList.add('used');
 // Get question from data-q attribute (avoids template literal escaping issues)
 const q = btn?.dataset?.q || question || '';
 const inp = document.getElementById('chatIn');
 if(inp) inp.value = q;
 sendChat();
}

function sendChat() {
 const inp = document.getElementById('chatIn');
 const box = document.getElementById('chatBox');
 if (!inp || !box) return;
 const msg = inp.value.trim();
 if (!msg) return;
 inp.value = '';

 const ticker = currentAsset?.ticker || '';
 const name = currentAsset?.name || '';

 // Add user message
 const userEl = document.createElement('div');
 userEl.style.cssText = 'align-self:flex-end;background:var(--accent);color:#fff;border-radius:12px;border-bottom-right-radius:3px;padding:9px 13px;font-size:.8rem;max-width:88%;line-height:1.5';
 userEl.textContent = msg;
 box.appendChild(userEl);
 box.scrollTop = box.scrollHeight;

 // Generate response
 setTimeout(() => {
 const reply = getChatReply(msg.toLowerCase(), ticker, name);
 const aiEl = document.createElement('div');
 aiEl.style.cssText = 'align-self:flex-start;background:var(--card2);border:1px solid var(--border2);border-radius:12px;border-bottom-left-radius:3px;padding:9px 13px;font-size:.8rem;color:var(--text);max-width:90%;line-height:1.5';
 aiEl.innerHTML = reply;
 box.appendChild(aiEl);
 box.scrollTop = box.scrollHeight;
 }, 400);
}


/* ════════════════════════════════
 WATCHLIST
════════════════════════════════ */
async function toggleWL(ticker, name, type) {
 const idx = watchlist.findIndex(w => w.ticker === ticker);
 if (idx >= 0) { watchlist.splice(idx,1); } else {
 watchlist.push({ticker,name,type});
 track('add_to_watchlist', { ticker });
 clMark('cl_watch');
 refreshChecklist();
 }
 await saveWL();
 const btn = document.getElementById('wlBtn');
 if (btn) btn.textContent = watchlist.some(w=>w.ticker===ticker) ? ' Saved' : '+ Watchlist';
}

function captureWlLoginSnapshot() {
 if (!user?.email || !watchlist.length) return;
 const key = 'ss_wl_snapshot_' + user.email;
 const existing = JSON.parse(localStorage.getItem(key)||'{}');
 const snap = {};
 watchlist.forEach(w => { snap[w.ticker] = ptDailyPrice(w.ticker); });
 // If no existing snapshot, save one and return (first login = baseline)
 if (!Object.keys(existing).length) {
 try { localStorage.setItem(key, JSON.stringify(snap)); } catch {}
 return;
 }
 // Store previous snapshot for delta display, then update
 try { localStorage.setItem('ss_wl_prev_snapshot_'+user.email, JSON.stringify(existing)); } catch {}
 try { localStorage.setItem(key, JSON.stringify(snap)); } catch {}
}

function getWlLoginDelta(ticker) {
 if (!user?.email) return null;
 const prev = JSON.parse(localStorage.getItem('ss_wl_prev_snapshot_'+user.email)||'{}');
 if (!prev[ticker]) return null;
 const current = ptDailyPrice(ticker);
 const old = prev[ticker];
 if (!old) return null;
 const pct = ((current - old) / old * 100);
 return pct;
}

function renderWatchlist() {
 const mc = document.getElementById('mainContent');
 if (!watchlist.length) {
 mc.innerHTML = `<div class="card"><div class="empty-state">
 <div class="empty-state-art"></div>
 <div class="empty-state-title">Your watchlist is empty</div>
 <div class="empty-state-sub">Keep an eye on stocks you're interested in. Search any stock and click <strong style="color:var(--gold)">+ Watchlist</strong> to track it here.</div>
 <button class="empty-state-btn" onclick="switchTab('s')">Search stocks →</button>
 </div></div>`;
 return;
 }

 const accentByType = {s:'rgba(108,92,231,.35)',i:'rgba(0,180,216,.35)',c:'rgba(245,158,11,.35)'};
 const textByType = {s:'var(--accent2)',i:'var(--teal)',c:'var(--gold)'};

 mc.innerHTML = `
 
 <div class="wl-grid">
 ${watchlist.map((w,i) => `
 <div class="wl-card" style="border-color:${accentByType[w.type]||'rgba(108,92,231,.35)'}">
 <button class="wl-rm" onclick="event.stopPropagation();rmWL(${i})" title="Remove"></button>
 <div class="wl-tick" style="color:${textByType[w.type]||'var(--accent2)'}">${w.ticker}</div>
 <div class="wl-n">${w.name}</div>
 ${(()=>{const d=getWlLoginDelta(w.ticker);if(d===null)return'';const up=d>=0;return `<div style="font-size:.62rem;color:${up?'var(--green)':'var(--red)'};margin-top:3px;display:flex;align-items:center;gap:2px"><span>${up?'▲':'▼'}</span><span>${up?'+':''}${d.toFixed(2)}% since login</span></div>`;})()}
 <!-- Live mini chart -->
 <div id="wl-tv-${i}" style="height:120px;margin-top:8px;border-radius:6px;overflow:hidden"></div>
 <button class="btn-go ${['bg-s','bg-i','bg-c'][['s','i','c'].indexOf(w.type)]||'bg-s'}"
 style="width:100%;margin-top:9px;padding:8px;font-size:.72rem;border-radius:8px"
 onclick="goAsset('${w.ticker}','${w.type}')">View Full Chart →</button>
 </div>`).join('')}
 </div>`;

 staggerCards(mc);

 // Inject live TradingView mini charts (shows current price, today's movement)
 setTimeout(() => {
 watchlist.forEach((w, i) => {
 injectTV('wl-tv-'+i, {
 autosize: true,
 symbol: tvSym(w.ticker, w.type),
 interval: 'D',
 timezone: 'Etc/UTC',
 theme,
 style: '3', // line chart — clean for mini view
 locale: 'en',
 enable_publishing: false,
 hide_top_toolbar: true,
 hide_legend: true,
 save_image: false,
 allow_symbol_change: false,
 withdateranges: false,
 hide_side_toolbar: true,
 range: '1D',
 }, 'advanced-chart');
 });
 }, 80);
}

function lookupTicker(ticker) {
 const found = TICKERS.find(e => e.t === ticker);
 goAsset(ticker, found?.k || 's');
}

function goAsset(ticker, type) {
 switchTab(type||'s', true);
 const siEl = document.getElementById('si');
 if (siEl) siEl.value = ticker;
 const found = TICKERS.find(e=>e.t===ticker);
 verifyTicker(ticker, found?.n||ticker, type||'s');
}

async function rmWL(i) { watchlist.splice(i,1); await saveWL(); renderWatchlist(); }

/* ════════════════════════════════
 COMPARE
════════════════════════════════ */
function renderCompare() {
 localStorage.setItem('ss_compare_used_'+(user?.email||''), '1');
 document.getElementById('mainContent').innerHTML = `
 
 <div class="cmp-row">
 <div>
 <div style="font-size:.62rem;color:var(--text3);letter-spacing:.08em;margin-bottom:4px">ASSET A</div>
 <div class="cmp-inp-wrap">
 <input class="cmp-inp" id="cA" placeholder="AAPL, Apple..." oninput="cmpAuto('A')"/>
 <div class="cmp-drop" id="cDA"></div>
 </div>
 </div>
 <div>
 <div style="font-size:.62rem;color:var(--text3);letter-spacing:.08em;margin-bottom:4px">ASSET B</div>
 <div class="cmp-inp-wrap">
 <input class="cmp-inp" id="cB" placeholder="TSLA, Bitcoin..." oninput="cmpAuto('B')"/>
 <div class="cmp-drop" id="cDB"></div>
 </div>
 </div>
 </div>
 <button class="btn-cmp" onclick="runCmp()"> Compare</button>
 <div id="cmpOut"><div class="empty" style="padding:2rem"><div class="empty-icon" style="font-size:2rem"></div><p>Enter two tickers above and click Compare.</p></div></div>`;
 staggerCards(document.getElementById('mainContent'));
}

function cmpAuto(side) {
 const inp=document.getElementById('c'+side), drop=document.getElementById('cD'+side);
 const res=searchT(inp.value.trim());
 if (res.length && inp.value.trim()) {
 drop.style.display='block';
 drop.innerHTML=res.map(r=>`<div class="sd-opt" onclick="document.getElementById('c${side}').value='${r.t}';document.getElementById('cD${side}').style.display='none'"><span class="sd-tick" style="color:${TC[r.k]}">${r.t}</span><span class="sd-name">${r.n}</span></div>`).join('');
 } else drop.style.display='none';
}

function runCmp() {
 const rA=resolveQ(document.getElementById('cA')?.value.trim()||'');
 const rB=resolveQ(document.getElementById('cB')?.value.trim()||'');
 if (!rA.t || !rB.t || rA.t===rB.t) { toast('Enter two different assets.','info',2500); return; }
 const symA=tvSym(rA.t,rA.k), symB=tvSym(rB.t,rB.k);
 const vA = verdictFor(rA.t), vB = verdictFor(rB.t);
 const aiA = vA ? { verdict: vA.verdict, color: VERDICT_COLOR[vA.verdict], score: vA.score } : {}, aiB = vB ? { verdict: vB.verdict, color: VERDICT_COLOR[vB.verdict], score: vB.score } : {};
 const dataA=assetData(rA.t), dataB=assetData(rB.t);
 // Real numbers for this pair: fetch once, then redraw
 const pairKey = rA.t + '|' + rB.t;
 if (runCmp._fetched !== pairKey && (statsStale(rA.t) || statsStale(rB.t) || factsStale(rA.t) || factsStale(rB.t) || !LIVE_Q[rA.t] || !LIVE_Q[rB.t])) {
  runCmp._fetched = pairKey;
  const pair = [[rA.t, rA.k || tickerKind(rA.t)], [rB.t, rB.k || tickerKind(rB.t)]];
  Promise.all([fetchStats(pair), fetchQuotes(pair), fetchFacts(pair)]).then(() => {
   if (document.getElementById('cmpOut') && tab === 'cmp') runCmp();
  });
 }
 const fA = factsFor(rA.t), fB = factsFor(rB.t);
 const targA = fA?.targetMean ? { avg: fA.targetMean } : null, targB = fB?.targetMean ? { avg: fB.targetMean } : null;
 const priceA=ptDailyPrice(rA.t), priceB=ptDailyPrice(rB.t);

 function statRow(labelA, valA, labelB, valB, highlight) {
 const better = highlight==='lower' ? (parseFloat(valA)<parseFloat(valB)?'A':'B') : (parseFloat(valA)>parseFloat(valB)?'A':'B');
 const ca = better==='A'?'var(--green)':'var(--text)';
 const cb = better==='B'?'var(--green)':'var(--text)';
 return `<tr style="border-bottom:1px solid var(--border)">
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${ca};text-align:right">${valA}</td>
 <td style="padding:.5rem .75rem;font-size:.7rem;color:var(--text3);text-align:center;white-space:nowrap">${labelA===labelB?labelA:labelA}</td>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${cb}">${valB}</td>
 </tr>`;
 }

 document.getElementById('cmpOut').innerHTML = `
 <!-- Header comparison -->
 <div class="two-col" style="margin-bottom:1rem">
 <div class="card" style="margin:0;border-top:3px solid var(--accent2)">
 <div style="padding:1rem;text-align:center">
 <div style="font-family:'Geist',sans-serif;font-size:1.2rem;font-weight:800;color:var(--accent2)">${rA.t}</div>
 <div style="font-size:.72rem;color:var(--text2);margin:.25rem 0">${rA.n||rA.t}</div>
 ${aiA.verdict?`<div style="font-size:.8rem;font-weight:700;color:${aiA.color||'var(--text)'};margin-top:.5rem">${aiA.verdict}</div>`:''}
 <div style="font-size:.88rem;font-weight:700;margin-top:.5rem">$${priceA.toLocaleString()}</div>
 </div>
 </div>
 <div class="card" style="margin:0;border-top:3px solid #3d9bff">
 <div style="padding:1rem;text-align:center">
 <div style="font-family:'Geist',sans-serif;font-size:1.2rem;font-weight:800;color:#3d9bff">${rB.t}</div>
 <div style="font-size:.72rem;color:var(--text2);margin:.25rem 0">${rB.n||rB.t}</div>
 ${aiB.verdict?`<div style="font-size:.8rem;font-weight:700;color:${aiB.color||'var(--text)'};margin-top:.5rem">${aiB.verdict}</div>`:''}
 <div style="font-size:.88rem;font-weight:700;margin-top:.5rem">$${priceB.toLocaleString()}</div>
 </div>
 </div>
 </div>

 <!-- Stats comparison table -->
 <div class="card" style="margin-bottom:1rem">
 <div class="card-hdr"><div class="card-hdr-title"> Side-by-Side Stats</div><div class="card-hdr-sub">Green = better metric</div></div>
 <table style="width:100%;border-collapse:collapse">
 <thead><tr style="border-bottom:1px solid var(--border)">
 <th style="padding:.5rem .75rem;font-size:.62rem;color:var(--accent2);text-align:right;letter-spacing:.06em">${rA.t}</th>
 <th style="padding:.5rem .75rem;font-size:.62rem;color:var(--text3);text-align:center;letter-spacing:.06em">METRIC</th>
 <th style="padding:.5rem .75rem;font-size:.62rem;color:#3d9bff;text-align:left;letter-spacing:.06em">${rB.t}</th>
 </tr></thead>
 <tbody id="cmpStatsBody">
 </tbody>
 </table>
 </div>

 <!-- Charts -->
 <div class="two-col" style="margin-bottom:.9rem">
 <div class="card" style="margin:0"><div class="card-hdr"><div class="card-hdr-title" style="color:var(--accent2)">${rA.t} — Price Chart</div></div><div id="cca" style="height:360px"></div></div>
 <div class="card" style="margin:0"><div class="card-hdr"><div class="card-hdr-title" style="color:#3d9bff">${rB.t} — Price Chart</div></div><div id="ccb" style="height:360px"></div></div>
 </div>
 <div class="two-col">
 <div class="card" style="margin:0"><div class="card-hdr"><div class="card-hdr-title">Technical — ${rA.t}</div></div><div id="cta" style="height:240px"></div></div>
 <div class="card" style="margin:0"><div class="card-hdr"><div class="card-hdr-title">Technical — ${rB.t}</div></div><div id="ctb" style="height:240px"></div></div>
 </div>`;

 // Fix the statRow template literals (they're inside a string, need to evaluate now)
 const tbody = document.getElementById('cmpStatsBody');
 if (tbody) tbody.innerHTML = `
 <tr style="border-bottom:1px solid var(--border)">
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${dataA[1]<=dataB[1]?'var(--green)':'var(--text)'};text-align:right">${dataA[1]}%</td>
 <td style="padding:.5rem .75rem;font-size:.7rem;color:var(--text3);text-align:center">Volatility</td>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${dataB[1]<=dataA[1]?'var(--green)':'var(--text)'}">${dataB[1]}%</td>
 </tr>
 <tr style="border-bottom:1px solid var(--border)">
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${dataA[3]>=dataB[3]?'var(--green)':'var(--text)'};text-align:right">${dataA[3]}% /yr</td>
 <td style="padding:.5rem .75rem;font-size:.7rem;color:var(--text3);text-align:center">Historical Growth</td>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${dataB[3]>=dataA[3]?'var(--green)':'var(--text)'}">${dataB[3]}% /yr</td>
 </tr>
 ${targA||targB ? `<tr style="border-bottom:1px solid var(--border)">
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;text-align:right">${targA?.avg?((targA.avg-priceA)/priceA*100).toFixed(1)+'%':'—'}</td>
 <td style="padding:.5rem .75rem;font-size:.7rem;color:var(--text3);text-align:center">Analyst Upside</td>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600">${targB?.avg?((targB.avg-priceB)/priceB*100).toFixed(1)+'%':'—'}</td>
 </tr>` : ''}
 ${aiA.score||aiB.score ? `<tr>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${(aiA.score||0)>=(aiB.score||0)?'var(--green)':'var(--text)'};text-align:right">${aiA.score?aiA.score+'/100':'—'}</td>
 <td style="padding:.5rem .75rem;font-size:.7rem;color:var(--text3);text-align:center">StockSight score</td>
 <td style="padding:.5rem .75rem;font-size:.78rem;font-weight:600;color:${(aiB.score||0)>=(aiA.score||0)?'var(--green)':'var(--text)'}">${aiB.score?aiB.score+'/100':'—'}</td>
 </tr>` : ''}`;

 setTimeout(() => {
 [['cca',symA],['ccb',symB]].forEach(([id,sym])=>injectTV(id,{autosize:true,symbol:sym,interval:'D',timezone:'Etc/UTC',theme,style:'1',locale:'en',enable_publishing:false,allow_symbol_change:false,save_image:false},'advanced-chart'));
 [['cta',symA],['ctb',symB]].forEach(([id,sym])=>injectTV(id,{symbol:sym,showIntervalTabs:true,locale:'en',colorTheme:theme,isTransparent:true,autosize:true},'technical-analysis'));
 }, 80);
}

/* ════════════════════════════════
 PORTFOLIO
════════════════════════════════ */
function renderPortfolio() {
 const mc = document.getElementById('mainContent');
 if (!holdings.length) {
 mc.innerHTML = `<div class="card"><div class="empty-state">
 <div class="empty-state-art"></div>
 <div class="empty-state-title">No holdings yet</div>
 <div class="empty-state-sub">Track your real investments here. Add your first stock or coin to see live P&L, how your money is split, and a year of real growth.</div>
 <button class="empty-state-btn" onclick="openHoldModal()">Add your first holding</button>
 </div></div>`;
 return;
 }

 const EXCHANGES = {
 AAPL:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',META:'NASDAQ',TSLA:'NASDAQ',
 NVDA:'NASDAQ',NFLX:'NASDAQ',AMD:'NASDAQ',PLTR:'NASDAQ',SNAP:'NYSE',
 JPM:'NYSE',BAC:'NYSE',WMT:'NYSE',JNJ:'NYSE',V:'NYSE',MA:'NYSE',DIS:'NYSE',
 UBER:'NYSE',COIN:'NASDAQ',CRM:'NYSE','BRK.B':'NYSE',
 SPX:'Via SPY (NYSE)',IXIC:'Via QQQ (NASDAQ)',DJI:'Via DIA (NYSE)',
 };
 const totalCost = holdings.reduce((s,h) => s + h.shares*h.buyPrice, 0);

 mc.innerHTML = `
 <div class="port-stats">
 <div class="card port-stat"><span>Market value</span><b id="portValue">—</b><small id="portValueNote">live prices</small></div>
 <div class="card port-stat"><span>Total P&amp;L</span><b id="portPL">—</b><small id="portPLPct">&nbsp;</small></div>
 <div class="card port-stat"><span>Today</span><b id="portDay">—</b><small id="portDayPct">&nbsp;</small></div>
 <div class="card port-stat"><span>Invested</span><b id="portTotalCost">$0.00</b><small>${holdings.length} position${holdings.length!==1?'s':''}</small></div>
 </div>

 <!-- Holdings table with P&L -->
 <div class="port-table-wrap" style="margin-bottom:1.25rem">
 <div class="port-table-hdr"><span>Your holdings <small id="portLiveTag" class="port-live-tag">Loading live prices</small></span><span class="port-hdr-actions"><button class="dash-btn" onclick="exportPortfolioCSV()">Export CSV</button><button class="dash-btn dash-btn-main" onclick="openHoldModal()">+ Add</button></span></div>
 <div style="overflow-x:auto">
 <table class="port-table">
 <thead><tr><th>ASSET</th><th>SHARES</th><th>AVG COST</th><th>PRICE NOW</th><th>VALUE</th><th>P&amp;L</th><th></th></tr></thead>
 <tbody>${holdings.map((h,i)=>{
 const exch = EXCHANGES[h.ticker] || ({s:'Stock',i:'Index fund',c:'Crypto'}[h.type||'s']);
 return `<tr>
 <td>
 <div class="td-tick" onclick="goAsset('${h.ticker}','${h.type||'s'}')">${h.ticker}</div>
 <div style="font-size:.6rem;color:var(--text3)">${h.name && h.name!==h.ticker ? escapeHTML(h.name) + ' · ' : ''}${exch}</div>
 </td>
 <td>${+Number(h.shares).toFixed(6)}</td>
 <td>$${Number(h.buyPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:h.buyPrice<1?6:2})}</td>
 <td id="port-now-${i}" class="port-num">—</td>
 <td id="port-val-${i}" class="port-num">—</td>
 <td id="port-pl-${i}" class="port-num">—</td>
 <td><button class="btn-rm" onclick="rmHolding(${i})" aria-label="Remove ${h.ticker}" title="Remove ${h.ticker}"></button></td>
 </tr>`;
 }).join('')}</tbody>
 </table>
 </div>
 </div>

 <!-- Portfolio Pie Chart -->
 <div class="card" style="margin-bottom:1.25rem">
 <div class="card-hdr">
 <div class="card-hdr-title"> Portfolio Allocation</div>
 <div class="card-hdr-sub">Cost basis breakdown by holding</div>
 </div>
 <div class="pie-wrap">
 <canvas id="portfolioPie" width="160" height="160" style="width:160px;height:160px;flex-shrink:0"></canvas>
 <div class="pie-legend" id="pieLegend"></div>
 </div>
 </div>

 <!-- P&L Line Chart -->
 <div class="card" style="margin-bottom:1.5rem">
 <div class="card-hdr">
 <div class="card-hdr-title"> Portfolio Growth</div>
 <div class="card-hdr-sub">Real prices, past 12 months</div>
 </div>
 <div style="padding:.5rem 1rem 1rem" id="plChartContainer"></div>
 </div>

 <!-- Rebalancing -->
 <div id="rebalancingContainer" style="margin-bottom:1rem"></div>

 <!-- What-if -->
 <div id="whatIfContainer" style="margin-bottom:1rem"></div>



 <!-- Live charts grid -->
 <div id="portLiveCharts" style="padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem">
 ${holdings.map((_,i)=>`<div class="card" style="margin:0">
 <div class="card-hdr"><div class="card-hdr-title" id="pct-${i}"></div></div>
 <div id="pc-${i}" style="height:280px"></div>
 </div>`).join('')}
 </div>`;

 staggerCards(mc);
 ssTabify('port', [
  { el: document.getElementById('portfolioPie')?.closest('.card'), label: 'Allocation', order: 0 },
  { el: document.getElementById('plChartContainer')?.closest('.card'), label: 'Growth', order: 1 },
  { el: document.getElementById('rebalancingContainer'), label: 'Rebalance', order: 2 },
  { el: document.getElementById('whatIfContainer'), label: 'What if', order: 3 },
  { el: document.getElementById('portLiveCharts'), label: 'Live charts', order: 4 },
 ]);

 setTimeout(() => {
 // Count-up animation for total invested
 countUp(document.getElementById('portTotalCost'), totalCost, 900, '$');
 updatePortfolioLive();
 fetchQuotes(holdings.map(h => [h.ticker, h.type || 's'])).then(() => { if (tab === 'port') updatePortfolioLive(true); });

 renderPortfolioPLChart('plChartContainer');
 renderRebalancingTool('rebalancingContainer');
 renderPortfolioWhatIf('whatIfContainer');

 // Draw Portfolio Pie Chart
 const pieCanvas = document.getElementById('portfolioPie');
 const legend = document.getElementById('pieLegend');
 if (pieCanvas && legend && holdings.length) {
 const PIE_COLORS = ['#6c5ce7','#00c97a','#00b4d8','#f59e0b','#ff3860','#a78bfa','#34d399','#60a5fa','#f472b6','#fb923c'];
 const total = holdings.reduce((s,h) => s + h.shares * h.buyPrice, 0) || 1;
 const slices = holdings.map((h,i) => ({
 label: h.ticker,
 value: h.shares * h.buyPrice,
 pct: (h.shares * h.buyPrice / total * 100),
 color: PIE_COLORS[i % PIE_COLORS.length],
 }));

 const ctx = pieCanvas.getContext('2d'); if (!ctx) return;
 const cx = 80, cy = 80, r = 72, inner = 42;
 let angle = -Math.PI / 2;
 ctx.clearRect(0, 0, 160, 160);

 slices.forEach(s => {
 const sweep = (s.pct / 100) * 2 * Math.PI;
 ctx.beginPath();
 ctx.moveTo(cx, cy);
 ctx.arc(cx, cy, r, angle, angle + sweep);
 ctx.closePath();
 ctx.fillStyle = s.color;
 ctx.fill();
 angle += sweep;
 });

 // Donut hole
 ctx.beginPath();
 ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
 ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--card').trim() || '#0c0c18';
 ctx.fill();

 // Center label
 ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#eeeef8';
 ctx.font = 'bold 11px Geist,sans-serif';
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 ctx.fillText(holdings.length + ' pos', cx, cy - 6);
 ctx.font = '10px Geist,sans-serif';
 ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || 'rgba(238,238,248,0.52)';
 ctx.fillText('$' + total.toLocaleString('en-US',{maximumFractionDigits:0}), cx, cy + 9);

 // Legend
 legend.innerHTML = slices.map(s => `
 <div class="pie-legend-row">
 <div class="pie-legend-dot" style="background:${s.color}"></div>
 <span class="pie-legend-label">${s.label}</span>
 <span class="pie-legend-pct">${s.pct.toFixed(1)}%</span>
 </div>`).join('');
 }

 // Inject live mini charts per holding
 holdings.forEach((h, i) => {
 // Use live mini chart (1D interval = most current price visible)
 injectTV('pc-'+i, {
 autosize:true, symbol:tvSym(h.ticker,h.type||'s'),
 interval:'D', timezone:'Etc/UTC', theme, style:'3',
 locale:'en', enable_publishing:false,
 allow_symbol_change:false, save_image:false,
 withdateranges:false, hide_side_toolbar:true,
 }, 'advanced-chart');
 });
 }, 80);
}

// Fills the Portfolio numbers from live quotes (cost basis stands in when a price is missing)
function updatePortfolioLive(final) {
 if (!document.getElementById('portValue')) return;
 const money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
 const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
 let value = 0, cost = 0, day = 0, prevValue = 0, live = 0;
 holdings.forEach((h, i) => {
  const q = LIVE_Q[h.ticker];
  const px = q?.price ?? null;
  const c = h.shares * h.buyPrice;
  cost += c;
  const now = document.getElementById('port-now-' + i), val = document.getElementById('port-val-' + i), pl = document.getElementById('port-pl-' + i);
  if (px == null) {
   value += c; prevValue += c;
   if (now) now.innerHTML = final ? '<span class="port-na" title="No live price for this symbol">n/a</span>' : '<span class="skel-txt"></span>';
   if (val) val.textContent = final ? money(c) : '—';
   if (pl) pl.textContent = final ? '—' : '';
   return;
  }
  live++;
  const v = h.shares * px, g = v - c, gp = c ? g / c * 100 : 0;
  value += v;
  if (q.prevClose) { day += h.shares * (px - q.prevClose); prevValue += h.shares * q.prevClose; } else prevValue += v;
  if (now) now.innerHTML = `${money(px)}${q.changePct != null ? `<small class="${q.changePct >= 0 ? 'up' : 'down'}">${pct(q.changePct)}</small>` : ''}`;
  if (val) val.textContent = money(v);
  if (pl) pl.innerHTML = `<b class="${g >= 0 ? 'up' : 'down'}">${g >= 0 ? '+' : ''}${money(g)}</b><small class="${g >= 0 ? 'up' : 'down'}">${pct(gp)}</small>`;
  const head = document.getElementById('pct-' + i);
  if (head) head.innerHTML = `${h.ticker}${h.name && h.name !== h.ticker ? ' · ' + escapeHTML(h.name) : ''} <span class="${g >= 0 ? 'up' : 'down'}" style="margin-left:6px;font-size:.72rem">${pct(gp)}</span>`;
 });
 const set = (id, html, cls) => { const el = document.getElementById(id); if (el) { el.innerHTML = html; if (cls !== undefined) el.className = cls; } };
 set('portValue', money(value));
 set('portValueNote', live === holdings.length ? 'live prices' : live ? `${live} of ${holdings.length} live` : final ? 'live prices unavailable' : 'loading prices');
 set('portPL', `${value - cost >= 0 ? '+' : ''}${money(value - cost)}`, value - cost >= 0 ? 'up' : 'down');
 set('portPLPct', cost ? pct((value - cost) / cost * 100) : '&nbsp;');
 set('portDay', live ? `${day >= 0 ? '+' : ''}${money(day)}` : '—', live ? (day >= 0 ? 'up' : 'down') : '');
 set('portDayPct', live && prevValue ? pct(day / prevValue * 100) : '&nbsp;');
 const tag = document.getElementById('portLiveTag');
 if (tag) { tag.textContent = live ? 'Live prices' : final ? 'Prices unavailable' : 'Loading live prices'; tag.classList.toggle('on', !!live); }
}

async function rmHolding(i) { holdings.splice(i,1); await saveH(); renderPortfolio(); }

/* ════════════════════════════════
 PROFILE PAGE
════════════════════════════════ */
function loadProfilePage() {
 syncSecurityUI();
 syncInstallUI();
 if (!user) return;
 refreshMyAvatar();
 document.getElementById('profUN').textContent = user.name;
 document.getElementById('profUE').textContent = user.email;
 document.getElementById('ov-n').textContent = user.name;
 document.getElementById('ov-e').textContent = user.email;
 const joined = new Date(user.createdAt);
 document.getElementById('ov-s').textContent = isNaN(joined) ? 'Not available' : joined.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
 // Portfolio summary counts
 const pos = document.getElementById('ov-positions');
 const cost = document.getElementById('ov-cost');
 if(pos) pos.textContent = holdings.length + ' position' + (holdings.length!==1?'s':'');
 if(cost) {
 const totalCost = holdings.reduce((s,h)=>s+(h.shares*h.buyPrice),0);
 cost.textContent = totalCost > 0 ? '$' + totalCost.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '$0.00';
 }
 // StockSight Score (#20)
 renderStockSightScore('ssScoreDisplay');
 // Portfolio name input
 const pni = document.getElementById('portNameInp');
 if(pni) pni.value = portfolioName !== 'My Portfolio' ? portfolioName : '';
 applyAllSettings(false);
 const dS=document.getElementById('dashPickS'), dI=document.getElementById('dashPickI'), dC=document.getElementById('dashPickC');
 if(dS) dS.textContent=dashPick.s||'AAPL';
 if(dI) dI.textContent=dashPick.i||'SPX';
 if(dC) dC.textContent=dashPick.c||'BTC';
 checkAndAwardBadges(true);
 renderBadges('badgesContainer');
 renderProfileStats();
 updateNotifToggleUI(localStorage.getItem('ss_browser_notifs') === '1');
 setHoldInputMode(typeof holdInputMode === 'string' ? holdInputMode : 'shares');
 checkMilestones();
 loadQuizResult();
 loadRiskTolerance();
 loadDivGrow();
 renderGoalsList(); loadGoals();
 renderSectorsList(); loadSectors();
 // Sync broker preference in settings
 const savedBroker = localStorage.getItem('ss_broker_'+(user?.email||''));
 const lbl = document.getElementById('currentBrokerLabel');
 if (lbl) lbl.textContent = savedBroker ? (BROKER_NAMES[savedBroker] || savedBroker) : 'Not set';
 ['robinhood','tastytrade','schwab','fidelity','etrade','webull','ibkr'].forEach(b => {
 const el = document.getElementById('bset-'+b);
 if (el) el.className = 'tog' + (b===savedBroker?' on-a':'');
 });
}

async function changePassword() {
 const curEl = document.getElementById('pw-cur');
 const newEl = document.getElementById('pw-new');
 const new2El = document.getElementById('pw-new2');
 const errEl = document.getElementById('pw-err');
 const okEl = document.getElementById('pw-ok');
 errEl.style.display='none'; okEl.style.display='none';

 const cur = curEl.value;
 const nw = newEl.value;
 const nw2 = new2El.value;
 const hadPassword = user?.hasPassword !== false;

 if(hadPassword && !cur) { errEl.textContent='Enter your current password.'; errEl.style.display='block'; return; }
 if(nw.length < 6) { errEl.textContent='New password must be at least 6 characters.'; errEl.style.display='block'; return; }
 if(nw !== nw2) { errEl.textContent='New passwords do not match.'; errEl.style.display='block'; return; }

 const r = await authApi('change-password', { current: cur, password: nw }, true);
 if (!r.ok) {
 if (r.status !== 401) { errEl.textContent = r.error; errEl.style.display='block'; }
 return;
 }
 // New token for this device; every other device is signed out
 setTok(r.token);
 if (user) { user.hasPassword = true; await setSess(user); }
 curEl.value=''; newEl.value=''; new2El.value='';
 okEl.textContent = hadPassword ? 'Password changed. Other devices were signed out.' : 'Password added. You can now also log in with your email.';
 okEl.style.display='block';
 syncSecurityUI();
 setTimeout(()=>{ okEl.style.display='none'; }, 4000);
}

// Google-only accounts have no password yet, so Settings offers to add one
function syncSecurityUI() {
 const noPw = user?.hasPassword === false;
 const cur = document.getElementById('pw-cur');
 if (cur) cur.style.display = noPw ? 'none' : '';
 cur?.parentElement?.classList.toggle('no-cur', noPw);
 const row = cur?.closest('.sg-row');
 const lbl = row?.querySelector('.sg-label'), desc = row?.querySelector('.sg-desc'), btn = row?.querySelector('.set-btn-main');
 if (lbl) lbl.textContent = noPw ? 'Add a password' : 'Change password';
 if (desc) desc.textContent = noPw ? 'You sign in with Google. Add a password to also log in with your email.' : 'Use at least 6 characters. Other devices get signed out.';
 if (btn) btn.textContent = noPw ? 'Add password' : 'Update password';
 const delPw = document.getElementById('deletePasswordInput');
 const delLbl = document.querySelector('label[for="deletePasswordInput"]');
 if (delPw) delPw.style.display = noPw ? 'none' : '';
 if (delLbl) delLbl.style.display = noPw ? 'none' : '';
}

function showP(name) {
 if (name === 'hold') { show('app'); switchTab('port'); setTimeout(openHoldModal, 300); return; }
 document.querySelectorAll('.psec').forEach(e=>e.classList.remove('on'));
 document.querySelectorAll('.pni').forEach(e=>e.classList.remove('on'));
 const sec = document.getElementById('p-'+name);
 const nav = document.getElementById('pni-'+name);
 if(sec) sec.classList.add('on');
 if(nav) nav.classList.add('on');
 // Populate notifications section when opened
 if(name==='notif') {
 syncDigestUI();
 const emailInp = document.getElementById('notif-email');
 if(emailInp && user?.email) emailInp.value = user.email;
 renderNotifAlerts();
 syncAlertMailUI();
 syncLeagueMailUI();
 }
}


/* ════════════════════════════════
 ADD HOLDING POPUP (Portfolio tab)
════════════════════════════════ */
let holdInputMode = 'shares';
let holdPick = null;
let _holdQuoteTimer = null;
const _holdQuoteState = {};

function openHoldModal(prefill) {
 if (!user) { requireAuth('Portfolio'); return; }
 const m = document.getElementById('holdModal'); if (!m) return;
 ['ph-t', 'ph-s', 'ph-p', 'ph-total'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
 holdPick = null;
 const err = document.getElementById('hErr'); if (err) err.textContent = '';
 const sug = document.getElementById('holdSugg'); if (sug) sug.hidden = true;
 setHoldInputMode(holdInputMode);
 m.classList.remove('off');
 void m.offsetWidth;
 m.classList.add('open');
 if (prefill) { document.getElementById('ph-t').value = prefill; holdTickerChanged(); }
 setTimeout(() => document.getElementById(prefill ? 'ph-s' : 'ph-t')?.focus(), 80);
}
function closeHoldModal() {
 const m = document.getElementById('holdModal'); if (!m) return;
 m.classList.remove('open');
 setTimeout(() => { if (!m.classList.contains('open')) m.classList.add('off'); }, 240);
}

function holdTypeFor(t) {
 if (holdPick?.t === t) return holdPick.k;
 const e = TICKERS.find(x => x.t === t);
 if (e) return e.k;
 return ['SPX', 'DJI', 'IXIC', 'RUT', 'VIX', 'NDX'].includes(t) ? 'i' : 's';
}
function holdTickerInput() {
 const inp = document.getElementById('ph-t'), box = document.getElementById('holdSugg');
 const q = inp.value.trim().toUpperCase();
 holdPick = null;
 if (!q) { box.hidden = true; updateHoldingPreview(); return; }
 const ql = q.toLowerCase();
 const score = e => (e.t === q ? 0 : e.t.startsWith(q) ? 1 : e.n.toLowerCase().startsWith(ql) ? 2 : 3) * 100 + e.t.length;
 const hits = TICKERS.filter(e => e.k !== 'i' && (e.t.startsWith(q) || e.n.toLowerCase().includes(ql))).sort((a, b) => score(a) - score(b)).slice(0, 6);
 box.innerHTML = hits.map(e => `<button type="button" role="option" onmousedown="event.preventDefault()" onclick="holdChoose('${e.t}','${e.k}')"><b>${e.t}</b><span>${escapeHTML(e.n)}</span><small>${e.k === 'c' ? 'Crypto' : 'Stock'}</small></button>`).join('');
 box.hidden = !hits.length;
 clearTimeout(_holdQuoteTimer);
 _holdQuoteTimer = setTimeout(holdTickerChanged, 450);
 updateHoldingPreview();
}
function holdKey(e) {
 const box = document.getElementById('holdSugg');
 if (e.key === 'Enter') {
  e.preventDefault();
  const first = !box.hidden && box.querySelector('button');
  if (first) first.click(); else addHolding();
 } else if (e.key === 'ArrowDown' && !box.hidden) {
  e.preventDefault(); box.querySelector('button')?.focus();
 } else if (e.key === 'Escape' && !box.hidden) {
  e.stopPropagation(); box.hidden = true;
 }
}
function holdSuggKey(e) {
 const btns = [...document.querySelectorAll('#holdSugg button')], i = btns.indexOf(document.activeElement);
 if (e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(btns.length - 1, i + 1)]?.focus(); }
 if (e.key === 'ArrowUp') { e.preventDefault(); i <= 0 ? document.getElementById('ph-t').focus() : btns[i - 1].focus(); }
}
function holdChoose(t, k) {
 document.getElementById('ph-t').value = t;
 holdPick = { t, k };
 document.getElementById('holdSugg').hidden = true;
 holdTickerChanged();
 document.getElementById(holdInputMode === 'amount' ? 'ph-total' : 'ph-s')?.focus();
}
async function holdTickerChanged() {
 const t = document.getElementById('ph-t')?.value.trim().toUpperCase();
 if (!t) return;
 if (!livePrice(t)) {
  _holdQuoteState[t] = 'loading'; updateHoldingPreview();
  await fetchQuotes([[t, holdTypeFor(t)]]);
 }
 _holdQuoteState[t] = livePrice(t) ? 'ok' : 'none';
 updateHoldingPreview();
}
function holdUseToday() {
 const t = document.getElementById('ph-t')?.value.trim().toUpperCase(), p = livePrice(t);
 if (!p) { const err = document.getElementById('hErr'); if (err) err.textContent = t ? `No live price for ${t} yet.` : 'Pick a ticker first.'; return; }
 document.getElementById('ph-p').value = p >= 1 ? p.toFixed(2) : p.toPrecision(4);
 updateHoldingPreview();
}

function setHoldInputMode(m) {
 holdInputMode = m === 'amount' ? 'amount' : 'shares';
 const sharesWrap = document.getElementById('holdSharesWrap'), amountWrap = document.getElementById('holdAmountWrap');
 if (!sharesWrap) return;
 sharesWrap.style.display = holdInputMode === 'shares' ? 'grid' : 'none';
 amountWrap.style.display = holdInputMode === 'amount' ? 'block' : 'none';
 document.getElementById('holdModeShares')?.classList.toggle('on', holdInputMode === 'shares');
 document.getElementById('holdModeAmount')?.classList.toggle('on', holdInputMode === 'amount');
 updateHoldingPreview();
}

function holdMoney(v) { return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 6 : 2 }); }

function updateHoldingPreview() {
 const preview = document.getElementById('holdingPreview'); if (!preview) return;
 const t = document.getElementById('ph-t')?.value.trim().toUpperCase();
 if (!t) { preview.hidden = true; return; }
 const live = livePrice(t), state = _holdQuoteState[t];
 const head = live ? `<span class="hp-now"><i class="live-dot"></i>${t} is <b>${holdMoney(live)}</b> right now</span>`
  : state === 'loading' ? `<span class="hp-now">Looking up ${t}'s live price...</span>`
  : state === 'none' ? `<span class="hp-now">No live price found for ${t}. Enter shares and the price you paid.</span>` : '';
 let body = '';
 if (holdInputMode === 'shares') {
  const shares = parseFloat(document.getElementById('ph-s')?.value) || 0;
  const buy = parseFloat(document.getElementById('ph-p')?.value) || 0;
  if (shares && buy) {
   body = `<span>You paid <b>${holdMoney(shares * buy)}</b> for ${+shares.toFixed(6)} share${shares === 1 ? '' : 's'}</span>`;
   if (live) {
    const pl = (live - buy) * shares, pct = (live / buy - 1) * 100;
    body += `<span>Worth <b>${holdMoney(shares * live)}</b> today, <b class="${pl >= 0 ? 'hp-up' : 'hp-down'}">${pl >= 0 ? '+' : '-'}${holdMoney(Math.abs(pl))} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</b></span>`;
   }
  }
 } else {
  const total = parseFloat(document.getElementById('ph-total')?.value) || 0;
  if (total && live) body = `<span>That buys about <b>${+(total / live).toFixed(6)} shares</b> at today's price</span>`;
 }
 preview.innerHTML = head + body;
 preview.hidden = !head && !body;
}

async function addHolding() {
 const t = document.getElementById('ph-t')?.value.trim().toUpperCase();
 const err = document.getElementById('hErr'); if (err) err.textContent = '';
 const fail = msg => { if (err) err.textContent = msg; const box = document.querySelector('#holdModal .modal-box'); box?.classList.remove('shake'); void box?.offsetWidth; box?.classList.add('shake'); };
 if (!t) return fail('Enter a ticker, like AAPL or BTC.');
 if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return fail('That doesn\'t look like a ticker. Try AAPL, BRK.B or BTC.');

 let shares = 0, buyPrice = 0;
 if (holdInputMode === 'shares') {
  shares = parseFloat(document.getElementById('ph-s')?.value);
  buyPrice = parseFloat(document.getElementById('ph-p')?.value);
  if (!shares || shares <= 0) return fail('Enter how many shares you own.');
  if (!buyPrice || buyPrice <= 0) return fail('Enter the price you paid per share.');
 } else {
  const total = parseFloat(document.getElementById('ph-total')?.value);
  if (!total || total <= 0) return fail('Enter the total amount you invested.');
  if (!livePrice(t)) await fetchQuotes([[t, holdTypeFor(t)]]);
  const live = livePrice(t);
  if (!live) return fail(`Couldn't get today's price for ${t}. Switch to Shares and price instead.`);
  buyPrice = live; shares = total / live;
 }

 const k = holdTypeFor(t);
 const name = TICKERS.find(e => e.t === t)?.n || t;
 const existing = holdings.find(h => h.ticker === t);
 let msg;
 if (existing) {
  const newShares = existing.shares + shares;
  existing.buyPrice = (existing.shares * existing.buyPrice + shares * buyPrice) / newShares;
  existing.shares = newShares;
  msg = `Added ${+shares.toFixed(4)} more ${t}. You now hold ${+newShares.toFixed(4)} at an average of ${holdMoney(existing.buyPrice)}.`;
 } else {
  holdings.push({ ticker: t, shares, buyPrice, type: k, name });
  msg = `${t} added to your portfolio.`;
  track('add_holding', { ticker: t });
 }
 closeHoldModal();
 checkMilestones();
 clMark('cl_holding');
 await saveH();
 refreshChecklist();
 if (tab === 'port' && !currentAsset) renderPortfolio();
 refreshViewHeadSub();
 launchConfetti();
 toast(msg, 'money', 4200);
}


async function saveHoldings(){
 await saveH();
 const ok=document.getElementById('saveOk');
 if(ok){ok.textContent=' Saved!';setTimeout(()=>ok.textContent='',2000);}
}

/* ════════════════════════════════
 AUTH MODAL
════════════════════════════════ */
function openModal(which){
 loadGSI(); // ready by the time someone taps "Continue with Google"
 const m = document.getElementById('modal');
 if (m) m.classList.remove('off');
 document.body.style.overflow = 'hidden';
 switchModal(which);
}
function openPrivacyPolicy(){ const m=document.getElementById('privacyModal'); if(m){m.classList.remove('off');document.body.style.overflow='hidden';loadLegal('privacy');} }
function closePrivacyPolicy(){ const m=document.getElementById('privacyModal'); if(m){m.classList.add('off');document.body.style.overflow='';} }
function openAboutCreator(){ const m=document.getElementById('aboutCreatorModal'); if(m){m.classList.remove('off');document.body.style.overflow='hidden';} }
function closeAboutCreator(){ const m=document.getElementById('aboutCreatorModal'); if(m){m.classList.add('off');document.body.style.overflow='';} }
function openTerms(){ const m=document.getElementById('termsModal'); if(m){m.classList.remove('off');document.body.style.overflow='hidden';loadLegal('terms');} }
// The pop-ups show the same text as stocksightai.com/privacy and /terms, so there's one copy to keep current
async function loadLegal(kind) {
 const box = document.getElementById(kind + 'Doc'), date = document.getElementById(kind + 'Updated');
 if (!box || box.dataset.loaded) return;
 try {
  const r = await fetch('/' + kind + '.html');
  if (!r.ok) throw new Error('legal');
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  box.innerHTML = doc.getElementById('doc').innerHTML;
  if (date) date.textContent = doc.querySelector('.updated')?.textContent || '';
  box.dataset.loaded = '1';
 } catch { box.innerHTML = `<p>Read it at <a href="/${kind}" target="_blank" rel="noopener">stocksightai.com/${kind}</a>.</p>`; }
}
function closeTerms(){ const m=document.getElementById('termsModal'); if(m){m.classList.add('off');document.body.style.overflow='';} }
let _fbType='general';
function openFeedback(){
 const m=document.getElementById('feedbackModal'); if(!m) return;
 m.classList.remove('off'); document.body.style.overflow='hidden';
 document.getElementById('feedbackSuccess').style.display='none';
 document.getElementById('feedbackForm').style.display='block';
 document.getElementById('feedbackText').value='';
 document.getElementById('feedbackEmail').value='';
 document.getElementById('feedbackErr').style.display='none';
 _fbType='general'; setFeedbackType('general');
}
function closeFeedback(){ const m=document.getElementById('feedbackModal'); if(m){m.classList.add('off');document.body.style.overflow='';} }
function setFeedbackType(t){
 _fbType=t;
 ['bug','feature','general'].forEach(type=>{
 const btn=document.getElementById('fbType'+type.charAt(0).toUpperCase()+type.slice(1));
 if(!btn) return;
 const active=type===t;
 btn.style.background=active?'rgba(108,92,231,.15)':'var(--card2)';
 btn.style.borderColor=active?'var(--accent)':'var(--border2)';
 btn.style.color=active?'var(--accent2)':'var(--text2)';
 });
}
async function submitFeedback(){
 const text=document.getElementById('feedbackText').value.trim();
 const email=document.getElementById('feedbackEmail').value.trim();
 const errEl=document.getElementById('feedbackErr');
 if(!text){ errEl.style.display='block'; return; }
 errEl.style.display='none';
 const subject=encodeURIComponent(`StockSight Feedback [${_fbType}]`);
 const body=encodeURIComponent(`Type: ${_fbType}\n\n${text}${email?'\n\nReply to: '+email:''}`);
 window.open(`https://mail.google.com/mail/?view=cm&to=stocksightai@gmail.com&su=${subject}&body=${body}`,'_blank');
 document.getElementById('feedbackForm').style.display='none';
 document.getElementById('feedbackSuccess').style.display='block';
 setTimeout(()=>closeFeedback(), 2500);
}
function closeModal(){
 const m = document.getElementById('modal');
 if (m) m.classList.add('off');
 document.body.style.overflow = '';
 clearFE();
 // Reset form fields so stale input/errors don't show on reopen
 ['su-fn','su-e','su-p','li-e','li-p'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
 // Reset forgot password panel state fully
 hideForgotPassword();
 const fp1 = document.getElementById('fpStep1'); if (fp1) fp1.style.display = 'block';
 const fp2 = document.getElementById('fpStep2'); if (fp2) fp2.style.display = 'none';
 const fpE = document.getElementById('fp-email'); if (fpE) fpE.value = '';
 const fpC = document.getElementById('fp-code'); if (fpC) fpC.value = '';
 const fpPw = document.getElementById('fp-newpw'); if (fpPw) fpPw.value = '';
 const fpCPw = document.getElementById('fp-confirmpw'); if (fpCPw) fpCPw.value = '';
 const fpOk = document.getElementById('fp-ok'); if (fpOk) fpOk.style.display = 'none';
 _fpEmail = '';
}
function switchModal(which){
 document.getElementById('f-signup').style.display = which==='signup'?'block':'none';
 document.getElementById('f-login').style.display = which==='login' ?'block':'none';
 clearFE();
}
function clearFE(){
 document.querySelectorAll('.field-err').forEach(e=>e.classList.remove('on'));
 document.querySelectorAll('.success-msg').forEach(e=>e.classList.remove('on'));
}

function validEmail(e) {
 // Must have: chars before @, an @, chars after @, a dot, at least 2 chars after the dot
 return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

async function doSignup(){
 clearFE();
 const firstName = document.getElementById('su-fn').value.trim();
 const email = document.getElementById('su-e').value.trim().toLowerCase();
 const pass = document.getElementById('su-p').value;
 let ok = true;
 if(!firstName){ document.getElementById('su-fne').classList.add('on'); ok=false; }
 if(!validEmail(email)){
 const ee = document.getElementById('su-ee');
 ee.textContent = email.length === 0 ? 'Enter your email address.' : !email.includes('@') ? 'Missing @ symbol — enter a real email.' : !email.includes('.') ? 'Missing domain — e.g. you@gmail.com' : 'Enter a valid email — e.g. you@gmail.com';
 ee.classList.add('on'); ok=false;
 }
 if(pass.length<6){ document.getElementById('su-pe').classList.add('on'); ok=false; }
 if(!ok) return;
 const name = firstName;
 const btn=document.getElementById('suBtn'); btn.disabled=true; btn.textContent='Creating...';
 const r = await authApi('signup', { name, email, password: pass });
 if (!r.ok) {
 btn.disabled=false; btn.textContent='Create account';
 if (r.code === 'exists') { document.getElementById('su-ex').classList.add('on'); return; }
 const ee = document.getElementById('su-ee');
 ee.textContent = r.error; ee.classList.add('on');
 return;
 }
 const u = await startSession(r);
 track('sign_up', { method: 'email' });
 document.getElementById('su-ok').classList.add('on'); btn.textContent=' Done!';
 setTimeout(()=>{
 closeModal();
 bootApp();
 loadUserData().then(()=>{ syncUserToSupabase(u); });
 },800);
}

// ── GOOGLE SIGN-IN ──────────────────────────────────────────
const GOOGLE_CLIENT_ID = '215107020140-9n8h7eaor1fl1rlvtnjf1vg5l6upu4ei.apps.googleusercontent.com';

let _gsiLoading = null;
function loadGSI() {
 if (typeof google !== 'undefined' && google.accounts) return Promise.resolve(true);
 if (!_gsiLoading) _gsiLoading = new Promise(done => {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => { initGSI(); done(true); };
  s.onerror = () => { _gsiLoading = null; done(false); };
  document.head.appendChild(s);
 });
 return _gsiLoading;
}
function initGSI() {
 if (typeof google === 'undefined' || !google.accounts || initGSI.done) return;
 initGSI.done = true;
 // Initialize ID token flow (for One Tap, if ever needed)
 google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential, ux_mode: 'popup' });
}

function clickGoogleSignIn() {
 if (typeof google === 'undefined' || !google.accounts) {
 // The popup has to open from the click itself, so if Google's script isn't here yet, fetch it and ask for one more tap
 loadGSI();
 showToast('Connecting to Google. Tap the button again in a second.', 'info', '');
 return;
 }
 // Use OAuth2 token client — opens a real browser popup (most reliable approach)
 try {
 const tokenClient = google.accounts.oauth2.initTokenClient({
 client_id: GOOGLE_CLIENT_ID,
 scope: 'openid email profile',
 callback: async (tokenResponse) => {
 if (tokenResponse.error) {
 showToast('Google sign-in failed: ' + tokenResponse.error, 'error', '');
 return;
 }
 await googleSignIn({ accessToken: tokenResponse.access_token });
 }
 });
 tokenClient.requestAccessToken({ prompt: 'select_account' });
 } catch(e) {
 console.error('GSI token client error:', e);
 // Fallback to ID token prompt
 google.accounts.id.prompt();
 }
}

// The server checks the Google token was issued to StockSight, then signs in or creates the account
async function googleSignIn(tokens) {
 const r = await authApi('google', tokens);
 if (!r.ok) { toast(r.error || 'Google sign-in failed. Please try again.', 'error'); return; }
 await startSession(r);
 track('login', { method: 'google' });
 closeModal();
 toast('Signed in with Google!', 'success');
 bootApp(); loadUserData();
}

// ID-token callback (One Tap / fallback)
async function handleGoogleCredential(response) {
 if (!response?.credential) { toast('Google sign-in failed. Please try again.', 'error'); return; }
 await googleSignIn({ idToken: response.credential });
}

// Init GSI once the script is loaded
window.addEventListener('load', () => setTimeout(loadGSI, 3000));
// ────────────────────────────────────────────────────────────

async function doLogin(){
 clearFE();
 const email = document.getElementById('li-e').value.trim().toLowerCase();
 const pass = document.getElementById('li-p').value;
 const btn = document.getElementById('liBtn');

 // Validate email format before even checking the database
 if (!validEmail(email)) {
 const err = document.getElementById('li-err');
 err.textContent = 'Enter a valid email address — e.g. you@gmail.com';
 err.classList.add('on');
 return;
 }

 btn.disabled=true; btn.textContent='Logging in...';
 let r = await authApi('login', { email, password: pass });
 // An account that only ever lived in this browser moves to the server on its first sign-in
 if (!r.ok && r.code === 'no_account') {
 const local = (await getU())[email];
 const matches = local && ((local.phash && (local.phash === await hashPassword(pass) || local.phash === hp(pass))) || (local.ph && local.ph === hp(pass)));
 if (matches) r = await authApi('signup', { name: local.name || email.split('@')[0], email, password: pass });
 }
 if (!r.ok) {
 const err = document.getElementById('li-err');
 err.textContent = r.code === 'no_account' || r.code === 'wrong' ? 'Incorrect email or password.' : r.error;
 err.classList.add('on');
 btn.disabled=false; btn.textContent='Log in';
 return;
 }
 const u = await startSession(r);
 track('login', { method: 'email' });
 document.getElementById('li-ok').classList.add('on'); btn.textContent=' Welcome back!';
 closeModal();
 setTimeout(()=>{
 bootApp();
 loadUserData().then(()=>{ syncUserToSupabase(u); setTimeout(captureWlLoginSnapshot, 200); });
 }, 300);
}

/* ════════════════════════════════
 PER-USER DATA RESET
 Clears non-user-scoped localStorage on login/signup
════════════════════════════════ */
function resetSessionData() {
 // Clear streak (re-counted per user per login)
 localStorage.removeItem('ss_streak');
 // Clear search history is already user-scoped (ss_searchhist_email)
 // Clear any leftover generic keys from previous sessions
 ['ss_searchhist_', 'ss_lastuser'].forEach(k => {
 if (localStorage.getItem(k)) localStorage.removeItem(k);
 });
}

/* ════════════════════════════════
 BROKER INTEGRATION
════════════════════════════════ */
let selectedBroker = null;
const BROKER_NAMES = {
 robinhood:'Robinhood', tastytrade:'Tastytrade',
 schwab:'Charles Schwab', fidelity:'Fidelity',
 etrade:'E*TRADE', webull:'Webull', ibkr:'Interactive Brokers',
};

function getBrokerURL(broker, ticker, assetType) {
 const t = ticker.toUpperCase().replace(/[^A-Z0-9]/g, '');
 if (assetType === 'i') return null;
 const urls = {
 robinhood: { s: `https://robinhood.com/stocks/${t}`, c: `https://robinhood.com/crypto/${t}` },
 fidelity: { s: `https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=${t}`, c: null },
 schwab: { s: `https://www.schwab.com/research/stocks/quotes/summary/${t}`, c: null },
 webull: { s: `https://www.webull.com/quote/${t.toLowerCase()}`, c: `https://www.webull.com/quote/crypto/${t.toLowerCase()}-usd` },
 tastytrade: { s: `https://tastytrade.com/tools/quote/${t}`, c: `https://tastytrade.com/tools/quote/${t}/usd` },
 ibkr: { s: `https://www.interactivebrokers.com/en/trading/search.php?symbol=${t}&type=STK`, c: `https://www.interactivebrokers.com/en/trading/search.php?symbol=${t}&type=CRYPTO` },
 etrade: { s: `https://us.etrade.com/what-we-offer/our-products/stocks?sym=${t}`, c: null },
 };
 const brokerMap = urls[broker];
 if (!brokerMap) return 'https://finance.yahoo.com/quote/' + t;
 const url = brokerMap[assetType] !== undefined ? brokerMap[assetType] : brokerMap['s'];
 return url || null;
}

function getBrokerDisplayName(broker) {
 return BROKER_NAMES[broker] || broker;
}

function handleInvestNow(ticker, assetType) {
 const broker = localStorage.getItem('ss_broker_'+(user?.email||''));
 if (!broker) {
 openBrokerModal();
 showToast('Select your broker first, then click Invest Now again', 'info');
 return;
 }
 if (assetType === 'i') {
 showToast("Indexes like " + ticker + " can't be bought directly — try an ETF like SPY or QQQ", 'info');
 return;
 }
 const url = getBrokerURL(broker, ticker, assetType);
 if (!url) {
 showToast(getBrokerDisplayName(broker) + " doesn't support " + (assetType==='c' ? 'crypto' : 'this asset type') + ' — try Robinhood or Webull', 'warn');
 return;
 }
 window.open(url, '_blank', 'noopener,noreferrer');
}

function selectBroker(id) {
 selectedBroker = id;
 document.querySelectorAll('.broker-opt').forEach(el => el.classList.remove('selected'));
 const el = document.getElementById('br-'+id);
 if (el) el.classList.add('selected');
}

function saveBroker() {
 if (!selectedBroker) { toast('Please select a broker first','warning'); return; }
 const saveBtn = document.querySelector('#brokerModal button[onclick="saveBroker()"]');
 if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
 try { localStorage.setItem('ss_broker_'+(user?.email||''), selectedBroker); } catch {}
 if (user?.email) {
 usersTable().update({ broker: selectedBroker }).eq('email', user.email)
 .then(({error}) => {
 if(error) console.warn('broker sync failed');
 if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Preference'; }
 });
 } else {
 if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Preference'; }
 }
 ['robinhood','tastytrade','schwab','fidelity','etrade','webull','ibkr'].forEach(b => {
 const el = document.getElementById('bset-'+b);
 if (el) el.className = 'tog' + (b===selectedBroker?' on-a':'');
 });
 const lbl = document.getElementById('currentBrokerLabel');
 if (lbl) lbl.textContent = BROKER_NAMES[selectedBroker] || selectedBroker;
 toast(`Broker set to ${BROKER_NAMES[selectedBroker]}! Click "Invest Now" on any stock. `, 'success');
 closeBrokerModal();
}

function closeBrokerModal() {
 const m = document.getElementById('brokerModal');
 if (m) m.style.display = 'none';
 document.body.style.overflow = '';
}

function openBrokerModal() {
 const m = document.getElementById('brokerModal');
 if (!m) return;
 const saved = localStorage.getItem('ss_broker_'+(user?.email||''));
 if (saved) {
 selectedBroker = saved;
 document.querySelectorAll('.broker-opt').forEach(el => el.classList.remove('selected'));
 const el = document.getElementById('br-'+saved);
 if (el) el.classList.add('selected');
 }
 m.style.display = 'flex';
 document.body.style.overflow = 'hidden';
}

function investNow(ticker, name) {
 handleInvestNow(ticker, currentAsset?.type || 's');
}

function setBrokerFromSettings(id) {
 selectedBroker = id;
 try { localStorage.setItem('ss_broker_'+(user?.email||''), id); } catch {}
 // Update toggle highlights
 ['robinhood','tastytrade','schwab','fidelity','etrade','webull','ibkr'].forEach(b => {
 const el = document.getElementById('bset-'+b);
 if (el) el.className = 'tog' + (b===id?' on-a':'');
 });
 // Update label
 const lbl = document.getElementById('currentBrokerLabel');
 if (lbl) lbl.textContent = BROKER_NAMES[id] || id;
 toast(`Preferred broker set to ${BROKER_NAMES[id]} `, 'success');
 clMark('cl_broker');
 refreshChecklist();
}

/* ════════════════════════════════
 TUTORIAL SYSTEM
════════════════════════════════ */
/* ════════════════════════════════
 INTERACTIVE TUTORIAL
════════════════════════════════ */
const TUTORIAL_STEPS = [
 {
 title: 'Welcome to StockSight',
 desc: 'This quick tour has you try the real thing. Each hands-on step earns 10 XP, and finishing the tour adds a 50 XP bonus. It takes about 2 minutes.',
 target: null, action: null,
 },
 {
 title: 'Your home screen',
 desc: 'Live markets, the day\'s biggest movers and your learning, all in one place. Every hands-on step in this tour earns XP.',
 target: '#mainContent', action: null,
 },
 {
 title: 'Search for a stock',
 desc: 'Type any company or ticker, like "Apple" or "AAPL". Search covers stocks, funds, indexes and crypto.',
 target: '#si',
 action: { prompt: 'Type a company name in the search bar', doneText: 'Search works. Press Next to keep going.', detect: 'search-input' },
 },
 {
 title: 'Switch market types',
 desc: 'Switch the home screen between Stocks, Indexes and Crypto. Everything on it updates right away.',
 target: '#marketFilter', showMarketFilter: true,
 action: { prompt: 'Tap Indexes or Crypto', doneText: 'The home screen just updated.', detect: 'market-filter' },
 },
 {
 title: 'Your watchlist', name: 'Watchlist', tab: 'w',
 desc: 'Keep an eye on stocks you like. On any stock page, tap Watch to add it here.',
 action: { prompt: 'Open the Watchlist tab', doneText: 'This is where your saved stocks live.' },
 },
 {
 title: 'Compare stocks', name: 'Compare', tab: 'cmp',
 desc: 'Put two stocks side by side: price history, performance and our verdict on each.',
 action: { prompt: 'Open Compare', doneText: 'Type two tickers to compare them.' },
 },
 {
 title: 'Stock screener', name: 'Screener', tab: 'screen',
 desc: 'Not sure where to start? Filter hundreds of stocks by sector, risk and growth.',
 action: { prompt: 'Open the Screener', doneText: 'Try setting a filter.' },
 },
 {
 title: 'Your portfolio', name: 'Portfolio', tab: 'port',
 desc: 'Add what you really own to track gains and losses and see your mix. It\'s saved to your account.',
 action: { prompt: 'Open Portfolio', doneText: 'Add a holding to start tracking.' },
 },
 {
 title: 'Paper trading', name: 'Practice', tab: 'pt',
 desc: 'Practice investing with $10,000 of pretend money at real prices, before you risk your own.',
 action: { prompt: 'Open Paper Trade', doneText: 'Try placing a practice trade.' },
 },
 {
 title: 'Day trade simulator', name: 'Day Trade', tab: 'day',
 desc: 'Replay real minute-by-minute trading days with $25,000 of pretend cash.',
 action: { prompt: 'Open Day Trade', doneText: 'Watch the price bars tick by.' },
 },
 {
 title: 'Your profile',
 desc: 'Your photo, settings, badges and leagues live here.',
 target: '#appHdrActions',
 action: { prompt: 'Tap your profile picture', doneText: 'That\'s your control panel.', detect: 'profile-click' },
 },
 {
 title: 'You\'re all set',
 desc: 'Press Finish to collect your 50 XP bonus, then try today\'s challenge in Learn to keep leveling up.',
 target: null, action: null,
 },
];
// Where each tab lives: the sidebar on big screens, the bottom bar (or its More sheet) on phones
const TUT_TAB_TARGET = { w: ['#tab-w', '#mbn-w'], pt: ['#tab-pt', '#mbn-pt'], cmp: ['#tab-cmp', '#mbn-more'], screen: ['#tab-screen', '#mbn-more'], port: ['#tab-port', '#mbn-more'], day: ['#tab-day', '#mbn-more'] };

let tutStep = 0;
let tutListeners = [];
let tutTarget = null;

function tutorialActive() {
 const el = document.getElementById('tutorialOverlay');
 return !!el && el.style.display !== 'none';
}
const tutVisible = el => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
function tutFindTarget(step) {
 const sels = step.tab ? (TUT_TAB_TARGET[step.tab] || []) : [step.target, step.mobileTarget].filter(Boolean);
 for (const s of sels) { const el = document.querySelector(s); if (tutVisible(el)) return el; }
 return null;
}

// Darkens everything except a hole around the target. The target itself is never moved or re-layered,
// so it stays fully usable (typing, tapping) wherever it sits in the page.
function tutPlace() {
 if (!tutorialActive()) return;
 const card = document.getElementById('tutCard'), spot = document.getElementById('tutSpotlight');
 const shades = ['T', 'B', 'L', 'R'].map(k => document.getElementById('tutShade' + k));
 if (!card || shades.some(s => !s)) return;
 const W = innerWidth, H = innerHeight;
 const el = tutTarget && tutVisible(tutTarget) ? tutTarget : null;
 if (!el) {
  shades[0].style.cssText = `left:0;top:0;width:${W}px;height:${H}px`;
  shades.slice(1).forEach(s => { s.style.cssText = 'display:none'; });
  spot.style.cssText = 'display:none';
  card.style.cssText = 'top:50%;left:50%;transform:translate(-50%,-50%)';
  return;
 }
 const r = el.getBoundingClientRect(), pad = 6;
 const x0 = Math.max(0, r.left - pad), y0 = Math.max(0, r.top - pad), x1 = Math.min(W, r.right + pad), y1 = Math.min(H, r.bottom + pad);
 shades[0].style.cssText = `left:0;top:0;width:${W}px;height:${y0}px`;
 shades[1].style.cssText = `left:0;top:${y1}px;width:${W}px;height:${Math.max(0, H - y1)}px`;
 shades[2].style.cssText = `left:0;top:${y0}px;width:${x0}px;height:${Math.max(0, y1 - y0)}px`;
 shades[3].style.cssText = `left:${x1}px;top:${y0}px;width:${Math.max(0, W - x1)}px;height:${Math.max(0, y1 - y0)}px`;
 spot.style.cssText = `display:block;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px;border-radius:12px`;
 const cardW = Math.min(300, W - 24), cardH = card.offsetHeight || 240;
 const top = H - y1 >= cardH + 24 ? y1 + 14 : y0 >= cardH + 24 ? y0 - cardH - 14 : Math.max(12, H - cardH - 12);
 const left = Math.min(Math.max(12, r.left), W - cardW - 12);
 card.style.cssText = `top:${top}px;left:${left}px;bottom:auto;transform:none`;
}
addEventListener('resize', () => { if (tutorialActive()) { tutTarget = tutFindTarget(TUTORIAL_STEPS[tutStep]); tutPlace(); } });
addEventListener('scroll', () => { if (tutorialActive()) tutPlace(); }, true);

function skipStepAction() {
 const step = TUTORIAL_STEPS[tutStep];
 if (!step?.action) return;
 cleanTutListeners();
 document.getElementById('tutActionPrompt')?.classList.remove('show');
 document.getElementById('tutSpotlight')?.classList.remove('pulse');
 const doneTxt = document.getElementById('tutDoneText');
 if (doneTxt) doneTxt.textContent = 'Step skipped. Press Next to continue.';
 document.getElementById('tutDoneBadge')?.classList.add('show');
 const btn = document.getElementById('tutNextBtn');
 if (btn) btn.disabled = false;
}

function startTutorial() {
 tutStep = 0;
 document.getElementById('tutorialOverlay').style.display = 'block';
 renderTutStep();
}

function tutShowMarketFilter(on) {
 const mf = document.getElementById('marketFilter');
 if (!mf) return;
 if (on && !('tutPrev' in mf.dataset)) { mf.dataset.tutPrev = mf.style.display; if (getComputedStyle(mf).display === 'none') mf.style.display = 'flex'; }
 if (!on && 'tutPrev' in mf.dataset) { mf.style.display = mf.dataset.tutPrev; delete mf.dataset.tutPrev; }
}

function renderTutStep() {
 const step = TUTORIAL_STEPS[tutStep];
 const $ = id => document.getElementById(id);
 const card = $('tutCard'), spot = $('tutSpotlight'), btn = $('tutNextBtn'), prompt = $('tutActionPrompt'), done = $('tutDoneBadge'), skipBtn = $('tutSkipBtn');
 if (!card) return;
 cleanTutListeners();
 tutShowMarketFilter(!!step.showMarketFilter);

 const tourXp = getLearn().tour;
 $('tutStepLabel').innerHTML = `<span>Step ${tutStep + 1} of ${TUTORIAL_STEPS.length}</span>${step.action ? `<span class="tut-xp${tourXp.includes(tutStep) ? ' got' : ''}">${tourXp.includes(tutStep) ? 'XP earned' : '+10 XP'}</span>` : ''}`;
 $('tutTitle').textContent = step.title;
 $('tutDesc').textContent = step.desc;
 btn.textContent = tutStep === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next →';
 $('tutDots').innerHTML = `<div class="tut-prog"><i style="width:${((tutStep + 1) / TUTORIAL_STEPS.length * 100).toFixed(0)}%"></i></div>`;

 tutTarget = step.target || step.tab ? tutFindTarget(step) : null;
 if (step.action) {
  const viaMore = step.tab && tutTarget?.id === 'mbn-more';
  $('tutActionText').textContent = viaMore ? `Tap More, then ${step.name}` : step.action.prompt;
  $('tutDoneText').textContent = step.action.doneText;
  prompt.classList.add('show');
  done.classList.remove('show');
  btn.disabled = true;
  if (skipBtn) skipBtn.style.display = 'inline-block';
  attachTutAction(step);
 } else {
  prompt.classList.remove('show');
  done.classList.remove('show');
  btn.disabled = false;
  if (skipBtn) skipBtn.style.display = 'none';
 }
 spot.classList.toggle('pulse', !!step.action);
 tutPlace();
 requestAnimationFrame(tutPlace);   // again once the card has its final height
}

function tutMarkDone() {
 const btn = document.getElementById('tutNextBtn');
 if (!btn || !btn.disabled) return;
 document.getElementById('tutActionPrompt').classList.remove('show');
 document.getElementById('tutDoneBadge').classList.add('show');
 btn.disabled = false;
 const ls = getLearn();
 if (!ls.tour.includes(tutStep)) {
  ls.tour.push(tutStep);
  saveLearn(ls);
  learnAddXP(10);
  const chip = document.querySelector('#tutStepLabel .tut-xp');
  if (chip) { chip.classList.add('got'); chip.textContent = 'XP earned'; }
 }
 document.getElementById('tutSpotlight').classList.remove('pulse');
 cleanTutListeners();
 btn.focus({ preventScroll: true });
}

function attachTutAction(step) {
 const detect = step.action.detect;
 const on = (el, type, fn = tutMarkDone) => { if (!el) return; el.addEventListener(type, fn); tutListeners.push({ el, type, fn }); };
 if (detect === 'search-input') { const el = document.getElementById('si'); on(el, 'input', () => { if (el.value.trim()) tutMarkDone(); }); }
 if (detect === 'market-filter') document.querySelectorAll('.mf-pill').forEach(el => on(el, 'click'));
 if (detect === 'profile-click') on(document.getElementById('appHdrActions'), 'click');
 // Tab steps finish in tutOnTab(), whichever way the tab was opened (sidebar, bottom bar or More)
}
function tutOnTab(t) {
 if (tutorialActive() && TUTORIAL_STEPS[tutStep]?.tab === t) setTimeout(() => { tutMarkDone(); tutTarget = tutFindTarget(TUTORIAL_STEPS[tutStep]); tutPlace(); }, 200);
}

function cleanTutListeners() {
 tutListeners.forEach(({el,type,fn}) => el.removeEventListener(type,fn));
 tutListeners = [];
}

function tutNext() {
 tutStep++;
 if (tutStep >= TUTORIAL_STEPS.length) {
  const ls = getLearn();
  if (!ls.tourDone) {
   ls.tourDone = true;
   saveLearn(ls);
   learnAddXP(50);
   setTimeout(() => toast('Tour complete! 50 XP bonus added.', 'success', 3200), 300);
   try { launchConfetti(); } catch {}
  }
  skipTutorial();
  return;
 }
 renderTutStep();
}

function skipTutorial() {
 tutTarget = null;
 tutShowMarketFilter(false);
 cleanTutListeners();
 document.getElementById('tutorialOverlay').style.display = 'none';
 try { localStorage.setItem('ss_tutorial_done_'+(user?.email||''), '1'); } catch {}
 if (user?.email) {
 usersTable().update({ tutorial_done: true }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('tutorial sync failed'); });
 }
 // Step 3: broker (only if not already set and not dismissed)
 if (!localStorage.getItem('ss_broker_'+(user?.email||'')) && !localStorage.getItem('ss_broker_dismiss_'+(user?.email||''))) {
 setTimeout(openBrokerModal, 400);
 }
}

function checkShowTutorial() {
 const done = localStorage.getItem('ss_tutorial_done_'+(user?.email||''));
 if (!done) { closeBrokerModal(); setTimeout(startTutorial, 400); }
}

function checkShowBrokerPrompt() {
 const saved = localStorage.getItem('ss_broker_'+(user?.email||''));
 const dismissed = localStorage.getItem('ss_broker_dismiss_'+(user?.email||''));
 if (!saved && !dismissed) setTimeout(openBrokerModal, 400);
}
function dismissBrokerPrompt() {
 try { localStorage.setItem('ss_broker_dismiss_'+(user?.email||''), '1'); } catch {}
 closeBrokerModal();
 showToast("Got it — you can set your broker anytime in Settings", 'info');
}

['su-fn','su-e','su-p'].forEach(id=>document.getElementById(id)?.addEventListener('keydown',e=>{if(e.key==='Enter')doSignup();}));
['li-e','li-p'].forEach(id=>document.getElementById(id)?.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();}));
document.addEventListener('keydown', e => { if(e.key==='Escape'){ closeHelp(); closeModal(); closeBrokerModal(); if (tutorialActive()) skipTutorial(); } });

/* ════════════════════════════════
 ONBOARDING QUESTIONNAIRE
════════════════════════════════ */
const obAnswers = { experience: null, risk: null, goal: null, sectors: [] };

function startOnboarding() {
 obAnswers.experience = null; obAnswers.risk = null;
 obAnswers.goal = null; obAnswers.sectors = [];
 document.getElementById('onboardingOverlay').style.display = 'flex';
 obGoStep(1);
}

function obGoStep(n) {
 document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
 const step = document.getElementById('ob-step-'+n);
 if (step) step.classList.add('active');
 const bar = document.getElementById('obProgressBar');
 if (bar) bar.style.width = (n / 4 * 100) + '%';
}

function obSelect(step, el, value) {
 // Deselect others in this step
 el.closest('.ob-options').querySelectorAll('.ob-opt').forEach(o => o.classList.remove('selected'));
 el.classList.add('selected');
 // Save answer
 if (step === 1) obAnswers.experience = value;
 if (step === 2) obAnswers.risk = value;
 if (step === 3) obAnswers.goal = value;
 // Enable next button
 const btn = document.getElementById('ob-next-'+step);
 if (btn) btn.classList.add('ready');
 const hint = document.getElementById('ob-hint-'+step);
 if (hint) hint.style.opacity = '0';
}

function obToggleSector(el, sector) {
 el.classList.toggle('selected');
 if (el.classList.contains('selected')) {
 el.style.borderColor = 'var(--accent)';
 el.style.background = 'rgba(108,92,231,.12)';
 el.style.color = 'var(--accent2)';
 if (!obAnswers.sectors.includes(sector)) obAnswers.sectors.push(sector);
 } else {
 el.style.borderColor = 'var(--border)';
 el.style.background = 'var(--card)';
 el.style.color = 'var(--text2)';
 obAnswers.sectors = obAnswers.sectors.filter(s => s !== sector);
 }
}

function obToggleAllSectors(btn) {
 const chips = document.querySelectorAll('.ob-sector-chip:not(#ob-select-all)');
 const allSelected = btn.style.borderColor === 'var(--accent)' || btn.dataset.on === '1';
 chips.forEach(c => {
 if(allSelected) { c.style.borderColor='var(--border)';c.style.background='var(--card)';c.style.color='var(--text2)';c.dataset.val=''; }
 else { c.style.borderColor='var(--accent)';c.style.background='rgba(108,92,231,.12)';c.style.color='var(--accent2)'; }
 });
 if(allSelected){ btn.style.borderColor='var(--border)';btn.style.background='var(--card)';btn.style.color='var(--text2)';btn.dataset.on='0'; }
 else { btn.style.borderColor='var(--accent)';btn.style.background='rgba(108,92,231,.12)';btn.style.color='var(--accent2)';btn.dataset.on='1'; }
}

function obNext(step) {
 const btn = document.getElementById('ob-next-'+step);
 if (!btn.classList.contains('ready')) return;
 obGoStep(step + 1);
}

function finishOnboarding() {
 try {
 const onboardingData = { ...obAnswers, completedAt: new Date().toISOString() };
 localStorage.setItem('ss_onboarding_'+(user?.email||''), JSON.stringify(onboardingData));
 if (user?.email) {
 usersTable().update({ onboarding_done: true }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('onboarding sync failed'); });
 }
 if (obAnswers.experience === 'beginner' || obAnswers.experience === 'some') {
 mode = 'simple'; if (user) user.mode = 'simple';
 } else if (obAnswers.experience === 'advanced') {
 mode = 'advanced'; if (user) user.mode = 'advanced';
 }
 } catch {}
 document.getElementById('onboardingOverlay').style.display = 'none';
 // Step 2: tutorial
 closeBrokerModal(); // ensure broker modal isn't open
 setTimeout(startTutorial, 400);
}

function checkShowOnboarding() {
 const done = localStorage.getItem('ss_onboarding_'+(user?.email||''));
 if (!done) {
 obAnswers.experience = null; obAnswers.risk = null;
 obAnswers.goal = null; obAnswers.sectors = [];
 startOnboarding();
 return true;
 }
 return false;
}

/* ════════════════════════════════
 DELETE ACCOUNT
════════════════════════════════ */
function showDeleteConfirm() {
 syncSecurityUI();
 document.getElementById('deleteStep1').style.display = 'none';
 document.getElementById('deleteStep2').style.display = 'block';
 document.getElementById('deleteConfirmInput').value = '';
 document.getElementById('deletePasswordInput').value = '';
 document.getElementById('deleteConfirmBtn').disabled = true;
 document.getElementById('deleteConfirmBtn').style.opacity = '.5';
 const err = document.getElementById('deleteErr');
 if (err) { err.style.display = 'none'; err.textContent = ''; }
}

function hideDeleteConfirm() {
 document.getElementById('deleteStep1').style.display = 'block';
 document.getElementById('deleteStep2').style.display = 'none';
}

function validateDeleteInputs() {
 const word = document.getElementById('deleteConfirmInput')?.value;
 const pass = document.getElementById('deletePasswordInput')?.value;
 const btn = document.getElementById('deleteConfirmBtn');
 const err = document.getElementById('deleteErr');
 const ready = word === 'DELETE' && (pass.length > 0 || user?.hasPassword === false);
 btn.disabled = !ready;
 btn.style.opacity = ready ? '1' : '.5';
 if (err) { err.style.display = 'none'; err.textContent = ''; }
}

async function deleteAccount() {
 if (!user) return;
 const pass = document.getElementById('deletePasswordInput')?.value || '';
 const word = document.getElementById('deleteConfirmInput')?.value || '';
 const btn = document.getElementById('deleteConfirmBtn');
 const err = document.getElementById('deleteErr');

 if (word !== 'DELETE') {
 err.textContent = 'Please type DELETE to confirm.';
 err.style.display = 'block'; return;
 }

 btn.textContent = 'Deleting...'; btn.disabled = true; btn.style.opacity = '.7';
 const r = await authApi('delete', { password: pass, confirm: word }, true);
 if (!r.ok) {
 btn.textContent = 'Yes, delete my account'; btn.disabled = false; btn.style.opacity = '1';
 if (r.status === 401) return;
 err.textContent = r.error;
 err.style.display = 'block';
 if (r.status === 403) document.getElementById('deletePasswordInput').style.borderColor = 'var(--red)';
 return;
 }

 try {
 const users = await getU();
 delete users[user.email];
 await setU(users);
 // Clear all localStorage keys for this user
 const email = user.email;
 ['ss_notes_','ss_alerts_','ss_searchhist_','ss_streak',
 'ss_broker_','ss_broker_prompted_','ss_tutorial_done_',
 'ss_watchlist_','ss_holdings_','ss_poll_','ss_lb_opt_'].forEach(k => {
 localStorage.removeItem(k + email);
 localStorage.removeItem(k);
 });
 await delSess();
 setTok('');
 user = null;
 guestSearchCount = 0;
 nudgeDismissed = false;
 searchHistory = [];
 watchlist = [];
 holdings = [];
 toast('Account deleted. Sorry to see you go.', 'info', 3000);
 setTimeout(() => {
 show('gate');
 updateGateUserCount();
 }, 1500);
 } catch(e) {
 btn.textContent = 'Yes, delete my account';
 btn.disabled = false; btn.style.opacity = '1';
 err.textContent = 'Something went wrong. Please try again.';
 err.style.display = 'block';
 }
}

/* ════════════════════════════════
 CUSTOM HOMEPAGE — PIN STOCKS
════════════════════════════════ */
function getPinnedStocks() {
 try { return JSON.parse(localStorage.getItem('ss_pins_'+(user?.email||''))||'[]'); } catch { return []; }
}
function savePinnedStocks(pins) {
 try { localStorage.setItem('ss_pins_'+(user?.email||''), JSON.stringify(pins)); } catch {}
}
function togglePin(t, n, k) {
 let pins = getPinnedStocks();
 const idx = pins.findIndex(p => p.t === t);
 if (idx >= 0) { pins.splice(idx, 1); }
 else if (pins.length < 6) { pins.push({t, n, k}); }
 else { toast('Max 6 pinned stocks', 'warning'); return; }
 savePinnedStocks(pins);
 renderHome(marketFilter || tab);
}
function unpinStock(t) {
 const pins = getPinnedStocks().filter(p => p.t !== t);
 savePinnedStocks(pins);
 renderHome(marketFilter || tab);
}
function clearPins() {
 savePinnedStocks([]);
 renderHome(marketFilter || tab);
}
function toggleCustomizePanel() {
 const panel = document.getElementById('customizePanel');
 if (!panel) return;
 panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

/* ════════════════════════════════
 STOCK OF THE DAY
════════════════════════════════ */

/* ════════════════════════════════
 TRENDING ON STOCKSIGHT
════════════════════════════════ */
function trackSearch(ticker) {
 if (!ticker) return;
 // Local count — powers badges + the offline fallback ranking
 try {
 const key = 'ss_trending';
 const data = JSON.parse(localStorage.getItem(key)||'{}');
 data[ticker] = (data[ticker]||0) + 1;
 localStorage.setItem(key, JSON.stringify(data));
 } catch {}
 // Community count, recorded by the server (once per person, ticker and day)
 const t = String(ticker).toUpperCase();
 if (!TREND_TICKER_RE.test(t)) return;
 fetch('/api/community', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'search', ticker: t }), keepalive: true }).catch(() => {});
}
const TREND_TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

function renderTrending(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = `
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(108,92,231,.07),rgba(108,92,231,.02))">
 <div class="card-hdr-title"> Trending on StockSight</div>
 <div class="card-hdr-sub">What the most people looked up today · live</div>
 </div>
 <div style="padding:.75rem 1rem" id="${containerId}_inner">
 <div style="font-size:.75rem;color:var(--text3);text-align:center;padding:1rem 0">Loading live data...</div>
 </div>`;
 // Tickers reach onclick only through data attributes, and only if they look like tickers
 const row = (t, i, note) => {
  const found = TICKERS.find(e => e.t === t) || { t, n: t, k: 's' };
  return `<div data-t="${escapeHTML(t)}" data-k="${escapeHTML(found.k)}" onclick="goAsset(this.dataset.t,this.dataset.k)" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer;transition:all .15s"
 onmouseover="this.style.paddingLeft='6px'" onmouseout="this.style.paddingLeft='0'">
 <div style="font-size:.7rem;font-weight:700;color:var(--text3);width:16px;text-align:center">${i+1}</div>
 <div style="flex:1;min-width:0">
 <div style="font-size:.82rem;font-weight:700;color:var(--text)">${escapeHTML(t)}</div>
 <div style="font-size:.62rem;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(found.n)}</div>
 </div>
 ${note ? `<div style="font-size:.62rem;color:var(--text3)">${note}</div>` : ''}
 <div style="font-size:.68rem;color:var(--accent2)">→</div>
 </div>`;
 };
 fetch('/api/community?trending=1&days=1').then(r => r.ok ? r.json() : null).catch(() => null).then(d => {
  const inner = document.getElementById(containerId+'_inner');
  if (!inner) return;
  const list = (d?.trending || []).filter(x => TREND_TICKER_RE.test(x?.ticker || ''));
  if (list.length) {
   inner.innerHTML = list.map((x, i) => row(x.ticker, i, x.people >= 3 ? `${x.people} people` : '')).join('');
   return;
  }
  // Nothing yet today: say so, and offer this device's own most-viewed tickers
  let mine = [];
  try { mine = Object.entries(JSON.parse(localStorage.getItem('ss_trending') || '{}')).sort((a, b) => b[1] - a[1]).map(([t]) => t).filter(t => TREND_TICKER_RE.test(t)).slice(0, 5); } catch {}
  inner.innerHTML = `<div style="font-size:.78rem;color:var(--text3);padding:.25rem 0 .5rem">No one has looked anything up yet today. Search a stock to start the list.</div>` +
   (mine.length ? `<div style="font-size:.68rem;font-weight:700;color:var(--text2);margin:.35rem 0 .1rem">Your most viewed</div>${mine.map((t, i) => row(t, i, '')).join('')}` : '');
 });
}

/* ════════════════════════════════
 PAPER TRADING
════════════════════════════════ */
let ptCurrentTicker = '';
let ptCurrentPrice = 100;
let ptSide = 'buy';
let ptInputMode = 'shares';

/* ── PAPER TRADING PRICE ENGINE ──
 Seeded daily simulation: same ticker+day = same price.
 Holdings store {shares, avgCost} so P&L = (currentPrice - avgCost) * shares
*/
const PT_BASE_PRICES = {
 AAPL:222,MSFT:415,GOOGL:170,AMZN:195,META:550,TSLA:175,NVDA:875,NFLX:700,
 AMD:175,JPM:220,BAC:40,WMT:85,JNJ:155,V:285,MA:495,DIS:110,UBER:75,
 COIN:210,PLTR:25,INTC:21,ORCL:145,PYPL:68,SPOT:420,SHOP:115,CRM:305,
 'BRK.B':370,SNAP:11,HOOD:22,RBLX:36,RIVN:11,SOFI:14,HIMS:28,RDDT:70,
 LLY:840,AVGO:175,CRWD:325,NET:95,DDOG:135,ARM:115,
 BTC:67000,ETH:3500,SOL:155,BNB:580,XRP:0.55,DOGE:0.14,ADA:0.45,
 AVAX:38,LINK:18,LTC:85,SPX:5200,IXIC:16400,DJI:38500,RUT:2050,
};

function ptSimPrice(ticker) {
 const base = PT_BASE_PRICES[ticker] || 100;
 const daysSinceEpoch = Math.floor(Date.now() / 86400000);
 let seed = 0;
 for (let i = 0; i < ticker.length; i++) seed = (seed * 31 + ticker.charCodeAt(i)) | 0;
 seed = Math.abs(seed + daysSinceEpoch * 1000003);
 const vol = (ASSET_DATA[ticker]?.[1] || 30) / 100 / Math.sqrt(252);
 const drift = (ASSET_DATA[ticker]?.[3] || 10) / 100 / 252;
 let price = base;
 for (let d = 60; d > 0; d--) {
 const daySeed = Math.abs(seed + d * 7919);
 const z = ((daySeed % 10000) / 5000) - 1;
 price *= Math.exp(drift - 0.5*vol*vol + vol*z);
 if (price < 0.0001) price = 0.0001;
 }
 return parseFloat(price.toFixed(price < 1 ? 6 : price < 10 ? 3 : 2));
}


/* ── Live prices for paper trading ──
 Paper trades use the real market price. The last real price seen is remembered,
 so the simulation below is only used for a ticker that has never been priced. */
let _pxCache = (() => { try { return JSON.parse(localStorage.getItem('ss_px_cache') || '{}') || {}; } catch { return {}; } })();
let _pxSaveT = null;
function rememberPrices(map) {
 Object.entries(map).forEach(([t, q]) => { if (q?.price) _pxCache[t] = { p: q.price, pc: q.prevClose ?? null, at: Date.now() }; });
 clearTimeout(_pxSaveT);
 _pxSaveT = setTimeout(() => { try { localStorage.setItem('ss_px_cache', JSON.stringify(_pxCache)); } catch {} }, 400);
}
function hasRealPrice(t) { return !!(LIVE_Q[t]?.price || _pxCache[t]?.p); }
function ptDailyPrice(ticker) {
 return LIVE_Q[ticker]?.price || _pxCache[ticker]?.p || ptSimPrice(ticker);
}
function ptDailyPrice_yesterday(ticker) {
 const q = LIVE_Q[ticker];
 if (q?.price) return q.prevClose || q.price;
 const c = _pxCache[ticker];
 if (c?.p) return c.pc || c.p;
 return ptSimPrice_yesterday(ticker);
}

// Every ticker the signed-in user cares about, priced in one request
let _liveRefreshing = null;
function refreshLivePrices() {
 if (_liveRefreshing) return _liveRefreshing;
 if (Date.now() - (refreshLivePrices._last || 0) < 15000) return Promise.resolve();
 refreshLivePrices._last = Date.now();
 const pt = user ? getPtPortfolio() : { holdings: {} };
 const set = new Map();
 const add = (t, k) => { if (t && !set.has(t) && set.size < 40) set.set(t, k || (TICKERS.find(e => e.t === t)?.k) || 's'); };
 Object.keys(pt.holdings || {}).forEach(t => add(t));
 (user ? getPtPendingOrders() : []).forEach(o => add(o.ticker));
 (holdings || []).forEach(h => add(h.ticker, h.type));
 (watchlist || []).forEach(w => add(w.ticker, w.type));
 if (!set.size) return Promise.resolve();
 fetchStats([...set.entries()]).catch(() => {});
 _liveRefreshing = fetchQuotes([...set.entries()]).then(() => {
  _liveRefreshing = null;
  const migrated = ptMigrateToLive();
  const filled = processPendingOrders();
  renderRail();
  if (!currentAsset && tab === 'port') updatePortfolioLive(true);
  if (!currentAsset && tab === 'pt' && (migrated || filled || !refreshLivePrices._shownPt)) { refreshLivePrices._shownPt = true; renderPaperTradeTab(); }
 }).catch(() => { _liveRefreshing = null; });
 return _liveRefreshing;
}

// One-time move of an existing paper account from simulated to live prices.
// Shares are rescaled so the account value and every gain or loss stay exactly the same.
function ptMigrateToLive() {
 if (!user) return false;
 const pt = getPtPortfolio();
 if (pt.live) return false;
 const tickers = Object.keys(pt.holdings || {});
 const pending = getPtPendingOrders();
 if (!tickers.length && !pending.length) return false;
 if (![...tickers, ...pending.map(o => o.ticker)].every(t => LIVE_Q[t]?.price || !TICKERS.some(e => e.t === t))) return false;
 const ratio = t => { const real = LIVE_Q[t]?.price, sim = ptSimPrice(t); return real && sim ? sim / real : 1; };
 tickers.forEach(t => {
  const h = pt.holdings[t], r = ratio(t);
  if (r === 1) return;
  if (typeof h === 'object' && h) pt.holdings[t] = { shares: h.shares * r, avgCost: (h.avgCost || ptSimPrice(t)) / r };
  else pt.holdings[t] = Number(h) * r;
 });
 if (pending.length) {
  pending.forEach(o => { const r = ratio(o.ticker); o.shares = o.shares * r; o.price = LIVE_Q[o.ticker]?.price || o.price; });
  savePtPendingOrders(pending);
 }
 pt.live = 1;
 savePtPortfolio(pt);
 if (tickers.length) setTimeout(() => toast('Paper trading now uses live market prices. Your positions were converted at today\'s prices, so your account value and gains are unchanged.', 'info', 7000), 600);
 return true;
}
setInterval(() => { if (user && document.visibilityState === 'visible') refreshLivePrices(); }, 120000);
document.addEventListener('visibilitychange', () => { if (user && document.visibilityState === 'visible') refreshLivePrices(); });

/* ════════════════════════════════
 PAPER TRADING LEADERBOARD
════════════════════════════════ */
function lbDisplayName(email) {
 if (!email) return 'Anonymous';
 const local = email.split('@')[0];
 if (local.length <= 3) return local + '***';
 return local.slice(0, 3) + '***';
}

async function loadLeaderboard() {
 const el = document.getElementById('leaderboardList');
 if (!el) return;
 try {
 const data = await sbRead('pt_leaderboard?select=display_name,value,return_pct,holdings_count,updated_at&order=value.desc&limit=15');
 if (!data || !data.length) {
 el.innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--text3);font-size:.78rem">No entries yet — make a trade and opt in to be the first!</div>`;
 return;
 }
 const myEmail = user?.email || '';
 el.innerHTML = data.map((row, i) => {
 const rank = i + 1;
 const isMe = row.display_name === lbDisplayName(myEmail);
 const retColor = row.return_pct >= 0 ? 'var(--green)' : 'var(--red)';
 const retBg = row.return_pct >= 0 ? 'rgba(0,201,122,.12)' : 'rgba(255,56,96,.1)';
 const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
 return `<div class="lb-row${isMe ? '" style="background:rgba(245,158,11,.05);border-left:2px solid var(--gold)' : ''}">
 <div class="lb-rank${rank <= 3 ? ' top' : ''}">${medal}</div>
 <div class="lb-name" style="${isMe ? 'color:var(--gold)' : ''}">${escapeHTML(row.display_name)}${isMe ? ' <span style="font-size:.6rem;opacity:.7">(you)</span>' : ''}</div>
 <div class="lb-val" style="color:${retColor}">$${Number(row.value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div class="lb-ret" style="color:${retColor};background:${retBg}">${row.return_pct >= 0 ? '+' : ''}${Number(row.return_pct).toFixed(1)}%</div>
 </div>`;
 }).join('');
 } catch(e) {
 el.innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--text3);font-size:.78rem">Couldn't load leaderboard.</div>`;
 }
}

async function upsertLeaderboard(pt, portfolioValue) {
 if (!user?.email) return;
 const optedIn = safeParse('ss_lb_opt_'+user.email, false);
 if (!optedIn) return;
 const returnPct = (portfolioValue - 10000) / 10000 * 100;
 const holdingsCount = Object.keys(pt.holdings || {}).length;
 const { error } = await accountApi('POST', { leaderboard: { value: portfolioValue, return_pct: returnPct, holdings_count: holdingsCount } });
 if (error) console.warn('Leaderboard update failed:', error.message);
}

function toggleLeaderboardOpt() {
 if (!user?.email) { toast('Sign in to appear on the leaderboard', 'info'); return; }
 const key = 'ss_lb_opt_'+user.email;
 const current = safeParse(key, false);
 const next = !current;
 localStorage.setItem(key, JSON.stringify(next));
 const tog = document.getElementById('lb-opt-tog');
 const lbl = document.getElementById('lb-tog-label');
 if (tog) tog.className = 'notif-tog' + (next ? ' on' : '');
 if (lbl) lbl.textContent = next ? 'Showing my rank' : 'Hidden';
 if (next) {
 // Immediately upsert current portfolio
 const pt = getPtPortfolio();
 let val = pt.cash;
 Object.entries(pt.holdings).forEach(([t, h]) => { val += (typeof h === 'object' ? h.shares : h) * ptDailyPrice(t); });
 upsertLeaderboard(pt, val).then(() => loadLeaderboard());
 toast('You\'re on the leaderboard! ', 'success');
 } else {
 // Remove from leaderboard
 accountApi('POST', { leaderboard: null }).then(() => loadLeaderboard());
 toast('Removed from leaderboard', 'info');
 }
}

/* ════════════════════════════════
 BROWSER PUSH NOTIFICATIONS
════════════════════════════════ */
async function requestBrowserNotifPermission() {
 if (!('Notification' in window)) { toast('Your browser doesn\'t support notifications', 'warn'); return; }
 const perm = await Notification.requestPermission();
 if (perm === 'granted') {
 localStorage.setItem('ss_browser_notifs', '1');
 updateNotifToggleUI(true);
 toast('Browser notifications enabled! ', 'success');
 new Notification('StockSight Alerts Active', { body: 'You\'ll be notified when your watchlist stocks make big moves.' });
 checkWatchlistNotifications();
 } else {
 localStorage.setItem('ss_browser_notifs', '0');
 updateNotifToggleUI(false);
 toast('Notification permission denied. Enable in browser settings.', 'warn', 4000);
 }
}

function toggleBrowserNotifs() {
 const enabled = localStorage.getItem('ss_browser_notifs') === '1';
 if (enabled) {
 localStorage.setItem('ss_browser_notifs', '0');
 updateNotifToggleUI(false);
 toast('Browser notifications off', 'info');
 } else {
 if (Notification.permission === 'granted') {
 localStorage.setItem('ss_browser_notifs', '1');
 updateNotifToggleUI(true);
 toast('Browser notifications on ', 'success');
 checkWatchlistNotifications();
 } else {
 requestBrowserNotifPermission();
 }
 }
}

function updateNotifToggleUI(on) {
 const tog = document.getElementById('browser-notif-tog');
 const lbl = document.getElementById('browser-notif-lbl');
 if (tog) { tog.className = 'notif-tog' + (on ? ' on' : ''); tog.setAttribute('aria-checked', String(!!on)); }
 if (lbl) lbl.textContent = on ? 'On' : 'Off';
}

async function checkWatchlistNotifications() {
 if (localStorage.getItem('ss_browser_notifs') !== '1') return;
 if (!('Notification' in window) || Notification.permission !== 'granted') return;
 if (!watchlist?.length) return;
 const today = new Date().toDateString();
 const notifiedKey = 'ss_notif_fired_' + today;
 const alreadyFired = safeParse(notifiedKey, {});
 const q = await fetchQuotes(watchlist.map(w => [w.ticker, w.type]));
 watchlist.forEach(w => {
  const t = w.ticker, live = q[t];
  if (alreadyFired[t] || !live?.price || !live.prevClose) return;
  const changePct = (live.price / live.prevClose - 1) * 100;
  if (Math.abs(changePct) < 3) return;
  try {
   new Notification(`${t} moved ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}% today`, {
    body: `Now at $${live.price.toLocaleString('en-US',{maximumFractionDigits:live.price<1?6:2})}. Open StockSight for the full picture.`,
    tag: t,
   });
  } catch {}
  alreadyFired[t] = true;
 });
 try { localStorage.setItem(notifiedKey, JSON.stringify(alreadyFired)); } catch {}
}

function ptSimPrice_yesterday(ticker) {
 const base = PT_BASE_PRICES[ticker] || 100;
 const daysSinceEpoch = Math.floor(Date.now() / 86400000) - 1;
 let seed = 0;
 for (let i = 0; i < ticker.length; i++) seed = (seed * 31 + ticker.charCodeAt(i)) | 0;
 seed = Math.abs(seed + daysSinceEpoch * 1000003);
 const vol = (ASSET_DATA[ticker]?.[1] || 30) / 100 / Math.sqrt(252);
 const drift = (ASSET_DATA[ticker]?.[3] || 10) / 100 / 252;
 let price = base;
 for (let d = 60; d > 0; d--) {
 const daySeed = Math.abs(seed + d * 7919);
 const z = ((daySeed % 10000) / 5000) - 1;
 price *= Math.exp(drift - 0.5*vol*vol + vol*z);
 if (price < 0.0001) price = 0.0001;
 }
 return parseFloat(price.toFixed(price < 1 ? 6 : price < 10 ? 3 : 2));
}

function getPtPortfolio() {
 let pt = null;
 try { pt = JSON.parse(localStorage.getItem('ss_pt_'+(user?.email||'')) || 'null'); } catch {}
 // Accounts that saved holdings before ever paper trading synced an empty {}: treat that as a fresh start
 if (!pt || typeof pt !== 'object') pt = {};
 if (!('cash' in pt)) pt.cash = 10000;
 if (!pt.holdings || typeof pt.holdings !== 'object') pt.holdings = {};
 return pt;
}
function savePtPortfolio(pt) {
 try { localStorage.setItem('ss_pt_'+(user?.email||''), JSON.stringify(pt)); } catch {}
 renderRail();
 if (user?.email) {
 const prefs = safeParse('ss3_p_'+user.email, {});
 usersTable().update({ portfolio: { holdings: holdings||[], paper_trade: pt, prefs } }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('savePT sync failed'); });
 // Update leaderboard if opted in
 let portfolioValue = pt.cash;
 Object.entries(pt.holdings || {}).forEach(([t, h]) => { portfolioValue += (typeof h === 'object' ? h.shares : h) * ptDailyPrice(t); });
 upsertLeaderboard(pt, portfolioValue);
 }
}

function getPtPendingOrders() {
 try { return JSON.parse(localStorage.getItem('ss_pt_pending_'+(user?.email||'')) || '[]'); }
 catch { return []; }
}
function savePtPendingOrders(orders) {
 try { localStorage.setItem('ss_pt_pending_'+(user?.email||''), JSON.stringify(orders)); } catch {}
 if (user?.email) {
 usersTable().update({ pending_orders: orders }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('savePending sync failed'); });
 }
}

// Auto-execute all pending orders when market opens.
// Returns true if any orders were processed (caller can re-render).
function processPendingOrders() {
 if (!isMarketOpen()) return false;
 const orders = getPtPendingOrders();
 if (!orders.length) return false;
 const stale = orders.some(o => !LIVE_Q[o.ticker] || Date.now() - LIVE_Q[o.ticker].at > 10 * 60000);
 if (stale && orders.some(o => TICKERS.some(e => e.t === o.ticker))) { refreshLivePrices(); return false; }
 if (!getPtPortfolio().live) return false;
 const pt = getPtPortfolio();
 let processed = 0;
 orders.forEach(o => {
 const execPrice = ptDailyPrice(o.ticker);
 if (o.side === 'buy') {
 // Cash was already reserved at placement — charge today's open price, refund difference
 const execTotal = o.shares * execPrice;
 const reserved = o.total;
 const refund = Math.max(0, reserved - execTotal);
 const extraCharge = Math.max(0, execTotal - reserved);
 // If today's price means we'd need MORE cash than reserved, cancel the order
 if (extraCharge > pt.cash + 0.01) {
 pt.cash += reserved; // refund reserved cash
 toast(` Pending BUY for ${o.ticker} cancelled — price rose to $${execPrice.toLocaleString()} and you don't have enough cash`, 'warn', 5000);
 } else {
 if (extraCharge > 0) pt.cash -= extraCharge;
 if (refund > 0) pt.cash += refund;
 const existing = pt.holdings[o.ticker];
 if (existing && typeof existing === 'object') {
 const newShares = existing.shares + o.shares;
 pt.holdings[o.ticker] = { shares: newShares, avgCost: (existing.shares * existing.avgCost + o.shares * execPrice) / newShares };
 } else {
 pt.holdings[o.ticker] = { shares: (typeof existing === 'number' ? existing : 0) + o.shares, avgCost: execPrice };
 }
 const refundNote = refund > 0 ? ` · $${refund.toFixed(2)} refunded` : '';
 if (!pt.trade_log) pt.trade_log = [];
 pt.trade_log.push({date: new Date().toISOString(), ticker: o.ticker, side: 'BUY', shares: o.shares, price: execPrice, total: o.shares * execPrice});
 toast(` Pending BUY filled: ${o.shares.toFixed(4)} ${o.ticker} @ $${execPrice.toLocaleString()}${refundNote}`, 'success', 4500);
 }
 } else {
 // Sell — shares were not removed from holdings, execute now
 const holding = pt.holdings[o.ticker];
 const ownedShares = holding ? (typeof holding === 'object' ? holding.shares : holding) : 0;
 const execShares = Math.min(o.shares, ownedShares);
 if (execShares <= 0.0001) {
 toast(` Pending SELL for ${o.ticker} cancelled — no shares held`, 'warn', 4000);
 } else {
 const avgCost = holding?.avgCost || execPrice;
 pt.cash += execShares * execPrice;
 const newShares = ownedShares - execShares;
 if (newShares <= 0.0001) delete pt.holdings[o.ticker];
 else pt.holdings[o.ticker] = { shares: newShares, avgCost };
 const pl = (execPrice - avgCost) * execShares;
 const plStr = pl >= 0 ? `+$${pl.toFixed(2)}` : `-$${Math.abs(pl).toFixed(2)}`;
 if (!pt.trade_log) pt.trade_log = [];
 pt.trade_log.push({date: new Date().toISOString(), ticker: o.ticker, side: 'SELL', shares: execShares, price: execPrice, total: execShares * execPrice, pl});
 toast(` Pending SELL filled: ${execShares.toFixed(4)} ${o.ticker} @ $${execPrice.toLocaleString()} · P&L: ${plStr}`, 'success', 4500);
 }
 }
 processed++;
 });
 if (processed > 0) {
 savePtPortfolio(pt);
 savePtPendingOrders([]);
 clMark('cl_paper');
 checkMilestones();
 refreshChecklist();
 }
 return processed > 0;
}

function cancelPendingOrder(orderId) {
 const orders = getPtPendingOrders();
 const order = orders.find(o => o.id === orderId);
 if (!order) return;
 if (order.side === 'buy') {
 // Refund the cash that was reserved
 const pt = getPtPortfolio();
 pt.cash += order.total;
 savePtPortfolio(pt);
 toast(`Order cancelled — $${order.total.toFixed(2)} returned to cash`, 'info', 3000);
 } else {
 toast(`Sell order for ${order.ticker} cancelled`, 'info', 3000);
 }
 savePtPendingOrders(orders.filter(o => o.id !== orderId));
 renderPaperTradeTab();
}

function openPtModal(ticker, name) {
 if (!requireAuth('Paper Trading')) return;
 ptCurrentTicker = ticker;
 ptCurrentPrice = ptDailyPrice(ticker);
 const kind = TICKERS.find(e => e.t === ticker)?.k || (currentAsset?.ticker === ticker ? currentAsset.type : 's');
 fetchQuotes([[ticker, kind]]).then(q => {
  const p = q[ticker]?.price;
  if (!p || ptCurrentTicker !== ticker || document.getElementById('ptModal')?.style.display === 'none') return;
  ptCurrentPrice = p;
  const td = document.getElementById('ptTickerDisplay');
  if (td) td.innerHTML = `<span style="color:var(--accent2)">${ticker}</span> · $${p.toLocaleString('en-US',{maximumFractionDigits:p<1?6:2})} <span class="pt-live"><i class="live-dot"></i>live</span>`;
  ['ptShares','ptDollars'].forEach(id => document.getElementById(id)?.dispatchEvent(new Event('input')));
 });
 const pt = getPtPortfolio();
 document.getElementById('ptCashDisplay').textContent = '$' + pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 document.getElementById('ptTickerDisplay').innerHTML = `<span style="color:var(--accent2)">${ticker}</span> · $${ptCurrentPrice.toLocaleString()}`;
 document.getElementById('ptShares').value = '';
 const ptDollarsEl = document.getElementById('ptDollars');
 if (ptDollarsEl) ptDollarsEl.value = '';
 document.getElementById('ptTotal').textContent = '$0.00';
 document.getElementById('ptErr').style.display = 'none';
 setPtSide('buy');
 setPtInputMode('shares');
 // Show market status
 const isCrypto2 = isCryptoTicker(ticker) || ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','LTC','DOT','MATIC','SHIB','UNI','ATOM'].includes(ticker);
 const mktOpen = isCrypto2 || isMarketOpen();
 const mktEl = document.getElementById('ptMarketStatus');
 if (mktEl) {
 mktEl.innerHTML = isCrypto2
 ? `<span style="color:var(--green)">● 24/7 — Crypto trades anytime</span>`
 : mktOpen
 ? `<span style="color:var(--green)">● Market Open — trades execute immediately</span>`
 : `<span style="color:var(--gold)"> Market Closed — order will queue &amp; execute at next open (Mon–Fri 9:30 AM ET)</span>`;
 }
 // Update button label to reflect live vs queued
 const btnEl = document.getElementById('ptSubmitBtn');
 if (btnEl) {
 if (mktOpen) {
 btnEl.textContent = 'Place Paper Trade';
 btnEl.style.background = 'linear-gradient(135deg,var(--teal),#0077b6)';
 } else {
 btnEl.textContent = ' Queue Order for Market Open';
 btnEl.style.background = 'linear-gradient(135deg,#d97706,#b45309)';
 }
 }
 document.getElementById('ptModal').style.display = 'flex';
 updatePtCoach(ticker, 'buy');
}

function closePtModal() {
 document.getElementById('ptModal').style.display = 'none';
 const s = document.getElementById('ptSuccess');
 if (s) s.style.display = 'none';
}

function showPtSuccess(type, ticker, shares, total, pl) {
 const s = document.getElementById('ptSuccess');
 const icon = document.getElementById('ptSuccessIcon');
 const title = document.getElementById('ptSuccessTitle');
 const detail = document.getElementById('ptSuccessDetail');
 const note = document.getElementById('ptSuccessNote');
 if (!s || !icon || !title || !detail) return;

 const isQueued = type === 'queued';
 const isSell = type === 'sell';

 if (isQueued) {
 icon.style.background = 'rgba(245,158,11,.15)';
 icon.style.border = '2px solid rgba(245,158,11,.4)';
 icon.textContent = '⏳';
 title.style.color = 'var(--gold)';
 title.textContent = 'Order Queued';
 detail.textContent = `${shares.toFixed(4)} shares of ${ticker} will execute at the next market open (Mon–Fri 9:30 AM ET).`;
 note.textContent = 'You can cancel it from the Paper Trading tab.';
 } else if (isSell) {
 const isProfit = pl >= 0;
 icon.style.background = isProfit ? 'rgba(0,201,122,.12)' : 'rgba(255,56,96,.08)';
 icon.style.border = `2px solid ${isProfit ? 'rgba(0,201,122,.4)' : 'rgba(255,56,96,.3)'}`;
 icon.textContent = isProfit ? '💰' : '📉';
 title.style.color = isProfit ? 'var(--green)' : 'var(--red)';
 title.textContent = isProfit ? 'Sold for a Profit' : 'Sold at a Loss';
 detail.innerHTML = `Sold ${shares.toFixed(4)} <strong>${ticker}</strong> @ $${ptCurrentPrice.toLocaleString()}<br>Realized P&L: <strong style="color:${isProfit?'var(--green)':'var(--red)'}">${isProfit?'+':''}$${pl.toFixed(2)}</strong>`;
 note.textContent = `$${total.toFixed(2)} returned to your cash balance.`;
 } else {
 icon.style.background = 'rgba(0,201,122,.12)';
 icon.style.border = '2px solid rgba(0,201,122,.4)';
 icon.textContent = '✅';
 title.style.color = 'var(--green)';
 title.textContent = 'Trade Placed';
 detail.innerHTML = `Bought ${shares.toFixed(4)} <strong>${ticker}</strong> @ $${ptCurrentPrice.toLocaleString()}<br>Total cost: <strong>$${total.toFixed(2)}</strong>`;
 note.textContent = 'Your holdings have been updated.';
 }

 s.style.display = 'flex';
 setTimeout(() => { closePtModal(); if (tab === 'pt') renderPaperTradeTab(); }, 2200);
}

function updatePtCoach(ticker, side) {
 const panel = document.getElementById('ptCoachPanel');
 const textEl = document.getElementById('ptCoachText');
 if (!panel || !textEl) return;

 const d = assetDataOrNull(ticker);
 const _v = verdictFor(ticker);
 const ai = _v ? { verdict: _v.verdict, score: _v.score, color: VERDICT_COLOR[_v.verdict] } : null;
 const pt = getPtPortfolio();

 if (!d) { panel.style.display = 'none'; return; }

 const [beta, vol, sector, growth] = d;
 const tips = [];

 // Analyst verdict
 if (ai) {
 const verdictEmoji = ai.verdict === 'Buy' ? '✅' : ai.verdict === 'Hold' ? '⚠️' : '❌';
 tips.push(`${verdictEmoji} Analysts rate ${ticker} a <strong>${ai.verdict}</strong> — ${ai.reason ? ai.reason.split('.')[0] : 'based on current fundamentals'}.`);
 }

 // Risk level coaching
 if (beta >= 1.5) tips.push(`⚡ High volatility (β ${beta}x) — this stock swings hard. Only invest what you're OK losing short-term.`);
 else if (beta < 0.8) tips.push(`🛡️ Low volatility (β ${beta}x) — relatively stable. Good for conservative portfolios.`);

 // Sector concentration
 const sectorHoldings = Object.entries(pt.holdings).filter(([t]) => ASSET_DATA[t]?.[2] === sector);
 const sectorValue = sectorHoldings.reduce((s, [t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 return s + shares * ptDailyPrice(t);
 }, 0);
 const totalValue = Object.entries(pt.holdings).reduce((s, [t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 return s + shares * ptDailyPrice(t);
 }, pt.cash);
 const sectorPct = totalValue > 0 ? (sectorValue / totalValue * 100) : 0;
 if (side === 'buy' && sectorPct > 35) tips.push(`📊 You already have ${sectorPct.toFixed(0)}% of your portfolio in ${sector}. Buying more increases concentration risk.`);
 else if (side === 'buy' && sector) tips.push(`📂 Sector: <strong>${sector}</strong> · ${growth}%/yr estimated growth.`);

 // Cash warning
 const cashPct = pt.cash / totalValue * 100;
 if (side === 'buy' && cashPct < 15) tips.push(`💵 You have only ${cashPct.toFixed(0)}% cash left. Keep some reserves for opportunities.`);

 // Sell coaching
 if (side === 'sell') {
 const holding = pt.holdings[ticker];
 if (holding) {
 const avgCost = holding.avgCost || ptDailyPrice(ticker);
 const currentPrice = ptDailyPrice(ticker);
 const plPct = (currentPrice - avgCost) / avgCost * 100;
 if (plPct > 0) tips.push(`📈 You're up <strong style="color:var(--green)">+${plPct.toFixed(1)}%</strong> on ${ticker}. Taking profits is smart — consider selling only part of your position.`);
 else tips.push(`📉 You're down <strong style="color:var(--red)">${plPct.toFixed(1)}%</strong> on ${ticker}. Selling locks in the loss — only do it if you've changed your thesis.`);
 } else {
 tips.push(`ℹ️ You don't hold ${ticker} yet. You can only sell shares you own.`);
 }
 }

 if (!tips.length) { panel.style.display = 'none'; return; }
 textEl.innerHTML = tips.map(t => `<div style="margin-bottom:.35rem">${t}</div>`).join('');
 panel.style.display = 'block';
}

function setPtInputMode(mode) {
 ptInputMode = mode;
 const sharesWrap = document.getElementById('ptSharesWrap');
 const dollarsWrap = document.getElementById('ptDollarsWrap');
 const sharesBtn = document.getElementById('ptModeShares');
 const dollarsBtn = document.getElementById('ptModeDollars');
 if (!sharesWrap || !dollarsWrap) return;
 if (mode === 'shares') {
 sharesWrap.style.display = 'block'; dollarsWrap.style.display = 'none';
 sharesBtn.style.cssText += ';border-color:rgba(108,92,231,.5);background:rgba(108,92,231,.12);color:var(--accent2)';
 dollarsBtn.style.cssText += ';border-color:var(--border);background:var(--card2);color:var(--text2)';
 } else {
 sharesWrap.style.display = 'none'; dollarsWrap.style.display = 'block';
 dollarsBtn.style.cssText += ';border-color:rgba(108,92,231,.5);background:rgba(108,92,231,.12);color:var(--accent2)';
 sharesBtn.style.cssText += ';border-color:var(--border);background:var(--card2);color:var(--text2)';
 }
 updatePtTotal();
}

function setPtSide(side) {
 ptSide = side;
 const buyBtn = document.getElementById('ptBuyBtn');
 const sellBtn = document.getElementById('ptSellBtn');
 if (buyBtn) { buyBtn.style.borderColor = side==='buy' ? 'rgba(0,201,122,.6)':'var(--border)'; buyBtn.style.background = side==='buy' ? 'rgba(0,201,122,.18)':'var(--card2)'; buyBtn.style.color = side==='buy' ? 'var(--green)':'var(--text2)'; }
 if (sellBtn) { sellBtn.style.borderColor = side==='sell' ? 'rgba(255,56,96,.5)':'var(--border)'; sellBtn.style.background = side==='sell' ? 'rgba(255,56,96,.1)':'var(--card2)'; sellBtn.style.color = side==='sell' ? 'var(--red)':'var(--text2)'; }
 updatePtTotal();
 if (ptCurrentTicker) updatePtCoach(ptCurrentTicker, side);
}

function updatePtTotal() {
 let shares = 0, total = 0;
 if (ptInputMode === 'shares') {
 shares = parseFloat(document.getElementById('ptShares')?.value) || 0;
 total = shares * ptCurrentPrice;
 } else {
 total = parseFloat(document.getElementById('ptDollars')?.value) || 0;
 shares = ptCurrentPrice > 0 ? total / ptCurrentPrice : 0;
 }
 const lbl = document.getElementById('ptTotalLabel');
 const tot = document.getElementById('ptTotal');
 if (lbl) lbl.textContent = shares > 0 ? `≈ ${shares.toFixed(4)} shares` : (ptInputMode==='shares' ? 'Estimated total' : 'Shares you\'ll get');
 if (tot) tot.textContent = '$' + total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function ptQuickAmount(dollars) {
 setPtInputMode('dollars');
 const inp = document.getElementById('ptDollars');
 if (inp) { inp.value = dollars; updatePtTotal(); }
}

function isMarketOpen() {
 // NYSE/NASDAQ: Mon-Fri 9:30 AM - 4:00 PM Eastern Time.
 // Uses Intl.DateTimeFormat.formatToParts() — the only reliable cross-timezone way
 // to extract ET hour/minute/weekday without locale-string parsing ambiguity.
 try {
 const now = new Date();
 const parts = new Intl.DateTimeFormat('en-US', {
 timeZone: 'America/New_York',
 weekday: 'short',
 hour: '2-digit',
 minute: '2-digit',
 hour12: false,
 }).formatToParts(now);
 const get = type => parts.find(p => p.type === type)?.value ?? '0';
 const day = get('weekday'); // 'Mon','Tue','Wed','Thu','Fri','Sat','Sun'
 let hour = parseInt(get('hour'), 10); // 0-23 (hour12:false)
 if (hour === 24) hour = 0; // some engines emit 24 for midnight
 const min = parseInt(get('minute'), 10);
 if (day === 'Sat' || day === 'Sun') return false;
 const timeVal = hour * 60 + min;
 return timeVal >= 9 * 60 + 30 && timeVal < 16 * 60;
 } catch {
 return false; // Intl not supported — fail safe (no silent auto-executions)
 }
}

function executePtTrade() {
 const errEl = document.getElementById('ptErr');
 errEl.style.display = 'none';

 const isCrypto = isCryptoTicker(ptCurrentTicker) || ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','LTC',
 'DOT','MATIC','SHIB','UNI','ATOM','ARB','OP','INJ','SUI','PEPE','WIF'].includes(ptCurrentTicker);

 // Parse input first — needed for both the live and pending-order paths
 let shares = 0, total = 0;
 if (ptInputMode === 'shares') {
 shares = parseFloat(document.getElementById('ptShares')?.value);
 if (!shares || shares <= 0) { errEl.textContent = 'Enter a valid number of shares.'; errEl.style.display='block'; return; }
 total = shares * ptCurrentPrice;
 } else {
 total = parseFloat(document.getElementById('ptDollars')?.value);
 if (!total || total <= 0) { errEl.textContent = 'Enter a valid dollar amount.'; errEl.style.display='block'; return; }
 shares = total / ptCurrentPrice;
 }

 const pt = getPtPortfolio();
 // A brand-new or fully converted account trades at live prices from here on
 if (!Object.keys(pt.holdings || {}).length && !getPtPendingOrders().length) pt.live = 1;

 // ── MARKET CLOSED: queue as a pending order ────────────────────────────────
 if (!isCrypto && !isMarketOpen()) {
 if (ptSide === 'buy') {
 if (total > pt.cash + 0.01) {
 errEl.textContent = `Not enough cash. You have $${pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}.`;
 errEl.style.display = 'block'; return;
 }
 pt.cash -= total; // reserve cash immediately so it can't be double-spent
 savePtPortfolio(pt);
 } else {
 // For sells: verify shares exist and aren't already tied up in another pending sell
 const holding = pt.holdings[ptCurrentTicker];
 const ownedShares = holding ? (typeof holding === 'object' ? holding.shares : holding) : 0;
 const alreadyPending = getPtPendingOrders()
 .filter(o => o.ticker === ptCurrentTicker && o.side === 'sell')
 .reduce((s, o) => s + o.shares, 0);
 const available = ownedShares - alreadyPending;
 if (available < 0.0001) {
 errEl.textContent = `You don't own any shares of ${ptCurrentTicker}${alreadyPending > 0 ? ' (all shares already in pending sell orders)' : ''}.`;
 errEl.style.display = 'block'; return;
 }
 if (shares > available + 0.0001) {
 errEl.textContent = `Only ${available.toFixed(4)} shares available — ${alreadyPending.toFixed(4)} already in pending sell orders.`;
 errEl.style.display = 'block'; return;
 }
 }
 const order = {
 id: 'ptord_' + Date.now(),
 ticker: ptCurrentTicker,
 side: ptSide,
 shares,
 price: ptCurrentPrice,
 total,
 placedAt: Date.now()
 };
 const pending = getPtPendingOrders();
 pending.push(order);
 savePtPendingOrders(pending);
 showPtSuccess('queued', ptCurrentTicker, shares, total, 0);
 return;
 }

 // ── LIVE TRADE: market is open ─────────────────────────────────────────────
 if (ptSide === 'buy') {
 if (total > pt.cash + 0.01) { errEl.textContent = `Not enough cash. You have $${pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}.`; errEl.style.display='block'; return; }
 pt.cash -= total;
 const existing = pt.holdings[ptCurrentTicker];
 if (existing && typeof existing === 'object') {
 const newShares = existing.shares + shares;
 pt.holdings[ptCurrentTicker] = { shares: newShares, avgCost: (existing.shares * existing.avgCost + shares * ptCurrentPrice) / newShares };
 } else {
 pt.holdings[ptCurrentTicker] = { shares: (typeof existing === 'number' ? existing : 0) + shares, avgCost: ptCurrentPrice };
 }
 if (!pt.trade_log) pt.trade_log = [];
 pt.trade_log.push({date: new Date().toISOString(), ticker: ptCurrentTicker, side: 'BUY', shares, price: ptCurrentPrice, total});
 showPtSuccess('buy', ptCurrentTicker, shares, total, 0);
 } else {
 const holding = pt.holdings[ptCurrentTicker];
 const ownedShares = holding ? (typeof holding === 'object' ? holding.shares : holding) : 0;
 if (shares > ownedShares + 0.0001) { errEl.textContent = `You only own ${ownedShares.toFixed(4)} shares of ${ptCurrentTicker}.`; errEl.style.display='block'; return; }
 const actualShares = Math.min(shares, ownedShares);
 pt.cash += actualShares * ptCurrentPrice;
 const avgCost = holding?.avgCost || ptCurrentPrice;
 const realizedPL = (ptCurrentPrice - avgCost) * actualShares;
 const newShares = ownedShares - actualShares;
 if (newShares <= 0.0001) delete pt.holdings[ptCurrentTicker];
 else pt.holdings[ptCurrentTicker] = { shares: newShares, avgCost };
 if (!pt.trade_log) pt.trade_log = [];
 pt.trade_log.push({date: new Date().toISOString(), ticker: ptCurrentTicker, side: 'SELL', shares: actualShares, price: ptCurrentPrice, total: actualShares * ptCurrentPrice, pl: realizedPL});
 showPtSuccess('sell', ptCurrentTicker, actualShares, actualShares * ptCurrentPrice, realizedPL);
 }
 savePtPortfolio(pt);
 track('paper_trade', { ticker: ptCurrentTicker, side: ptSide });
 clMark('cl_paper');
 checkMilestones();
 refreshChecklist();
}

/* Paper Trading Portfolio tab in Portfolio section */
function renderPaperPortfolio(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 processPendingOrders(); // execute any queued orders if market just opened
 const pt = getPtPortfolio();
 const pending = getPtPendingOrders();
 const entries = Object.entries(pt.holdings);
 let portfolioValue = pt.cash;
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 portfolioValue += shares * ptDailyPrice(t);
 });
 const totalReturn = portfolioValue - 10000;
 const retColor = totalReturn >= 0 ? 'var(--green)' : 'var(--red)';

 el.innerHTML = `
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:1.25rem">
 <div class="pt-stat"><div class="pt-stat-val">$${portfolioValue.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="pt-stat-lbl">TOTAL VALUE</div></div>
 <div class="pt-stat"><div class="pt-stat-val">$${pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="pt-stat-lbl">CASH</div></div>
 <div class="pt-stat"><div class="pt-stat-val" style="color:${retColor}">${totalReturn>=0?'+':''}$${Math.abs(totalReturn).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="pt-stat-lbl">TOTAL P&L</div></div>
 </div>
 ${pending.length > 0 ? `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:.625rem .875rem;margin-bottom:.875rem;display:flex;align-items:center;justify-content:space-between">
 <span style="font-size:.72rem;color:var(--gold)"> ${pending.length} pending order${pending.length>1?'s':''} — executes at market open</span>
 <button onclick="switchTab('pt')" style="font-size:.65rem;padding:3px 8px;border-radius:6px;border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.12);color:var(--gold);cursor:pointer;font-family:inherit">View →</button>
 </div>` : ''}
 ${entries.length === 0 ? `<div class="empty-state" style="padding:1.5rem">
 <div class="empty-state-art" style="font-size:2.5rem"></div>
 <div class="empty-state-title" style="font-size:.9rem">No paper trades yet</div>
 <div class="empty-state-sub" style="font-size:.73rem">Click " Paper Trade" on any stock page to start.</div>
 </div>` :
 `<div style="display:flex;flex-direction:column;gap:6px">
 ${entries.map(([t, h])=>{
 const shares = typeof h === 'object' ? h.shares : h;
 const avgCost = typeof h === 'object' ? h.avgCost : ptDailyPrice(t);
 const curPrice = ptDailyPrice(t);
 const val = shares * curPrice;
 const pl = (curPrice - avgCost) * shares;
 const plPct = ((curPrice - avgCost) / avgCost * 100);
 const plColor = pl >= 0 ? 'var(--green)' : 'var(--red)';
 return `<div style="display:flex;align-items:center;gap:10px;padding:.625rem .875rem;background:var(--card2);border:1px solid var(--border);border-radius:9px">
 <div style="font-family:'Geist',sans-serif;font-weight:800;color:var(--accent2);font-size:.88rem;width:60px">${t}</div>
 <div style="flex:1;font-size:.75rem;color:var(--text2)">${shares.toFixed(4)} shares<br><span style="font-size:.65rem;color:var(--text3)">avg $${avgCost.toFixed(2)}</span></div>
 <div style="text-align:right">
 <div style="font-size:.82rem;font-weight:700">$${val.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div style="font-size:.65rem;color:${plColor}">${pl>=0?'+':''}$${Math.abs(pl).toFixed(2)} (${plPct>=0?'+':''}${plPct.toFixed(1)}%)</div>
 </div>
 <button onclick="openPtModal('${t}','${t}')" style="font-size:.65rem;padding:4px 8px;border-radius:6px;border:1px solid var(--border2);background:var(--card);cursor:pointer;color:var(--text2)">Trade</button>
 </div>`;
 }).join('')}
 </div>`}
 <button onclick="if(confirm('Reset paper trading portfolio to $10,000?')){savePtPortfolio({cash:10000,holdings:{}});renderPaperPortfolio('${containerId}');toast('Portfolio reset to $10,000 ','success')}"
 style="margin-top:1rem;background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 14px;font-family:inherit;font-size:.72rem;cursor:pointer;color:var(--text3)">↺ Reset to $10,000</button>`;
}

/* ════════════════════════════════
 PAPER TRADE TAB
════════════════════════════════ */
function sharePtCard() {
 const pt = getPtPortfolio();
 const entries = Object.entries(pt.holdings);
 let portfolioValue = pt.cash;
 entries.forEach(([t, h]) => { portfolioValue += (typeof h === 'object' ? h.shares : h) * ptDailyPrice(t); });
 const totalReturn = portfolioValue - 10000;
 const totalReturnPct = (totalReturn / 10000 * 100);
 const isUp = totalReturn >= 0;

 const W = 1080, H = 608;
 const canvas = document.createElement('canvas');
 canvas.width = W; canvas.height = H;
 const ctx = canvas.getContext('2d');

 // Background
 ctx.fillStyle = '#141414';
 ctx.fillRect(0, 0, W, H);

 // Subtle grid lines
 ctx.strokeStyle = 'rgba(255,255,255,0.03)';
 ctx.lineWidth = 1;
 for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
 for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

 // Glow blob
 const grd = ctx.createRadialGradient(W*0.15, H*0.4, 0, W*0.15, H*0.4, 320);
 grd.addColorStop(0, isUp ? 'rgba(0,201,122,0.12)' : 'rgba(255,56,96,0.12)');
 grd.addColorStop(1, 'transparent');
 ctx.fillStyle = grd;
 ctx.fillRect(0, 0, W, H);

 // Top accent line
 const accentColor = isUp ? '#00c97a' : '#ff3860';
 ctx.fillStyle = accentColor;
 ctx.fillRect(0, 0, W, 4);

 // Logo area
 ctx.fillStyle = 'rgba(108,92,231,0.2)';
 roundRect(ctx, 48, 44, 42, 42, 12);
 ctx.fill();
 ctx.strokeStyle = 'rgba(108,92,231,0.6)';
 ctx.lineWidth = 1.5;
 roundRect(ctx, 48, 44, 42, 42, 12);
 ctx.stroke();
 // Chart icon in logo
 ctx.strokeStyle = '#a89cff';
 ctx.lineWidth = 2.5;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.beginPath();
 ctx.moveTo(58, 76); ctx.lineTo(64, 66); ctx.lineTo(70, 70); ctx.lineTo(78, 58); ctx.lineTo(82, 62);
 ctx.stroke();
 // Logo text
 ctx.fillStyle = '#eeeef8';
 ctx.font = '700 22px Geist, Geist, sans-serif';
 ctx.fillText('Stock', 100, 68);
 ctx.fillStyle = '#a89cff';
 ctx.fillText('Sight', 148, 68);

 // "PAPER TRADING" label
 ctx.fillStyle = 'rgba(255,255,255,0.25)';
 ctx.font = '600 11px Geist, sans-serif';
 ctx.letterSpacing = '0.12em';
 ctx.fillText('PAPER TRADING', 100, 84);

 // Big return number
 const retStr = (isUp ? '+' : '') + totalReturnPct.toFixed(2) + '%';
 ctx.fillStyle = accentColor;
 ctx.font = '900 112px Geist, Geist, sans-serif';
 ctx.fillText(retStr, 48, 260);

 // Return label
 ctx.fillStyle = 'rgba(238,238,248,0.45)';
 ctx.font = '500 18px Geist, sans-serif';
 ctx.fillText('total return from $10,000 starting capital', 52, 296);

 // Portfolio value
 ctx.fillStyle = '#eeeef8';
 ctx.font = '700 32px Geist, Geist, sans-serif';
 ctx.fillText('$' + portfolioValue.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}), 52, 352);
 ctx.fillStyle = 'rgba(238,238,248,0.4)';
 ctx.font = '500 15px Geist, sans-serif';
 ctx.fillText('portfolio value', 52, 374);

 // Divider
 ctx.strokeStyle = 'rgba(255,255,255,0.08)';
 ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(48, 400); ctx.lineTo(W - 48, 400); ctx.stroke();

 // Holdings (up to 4)
 const topHoldings = entries.sort((a, b) => {
 const va = (typeof a[1] === 'object' ? a[1].shares : a[1]) * ptDailyPrice(a[0]);
 const vb = (typeof b[1] === 'object' ? b[1].shares : b[1]) * ptDailyPrice(b[0]);
 return vb - va;
 }).slice(0, 4);

 if (topHoldings.length > 0) {
 ctx.fillStyle = 'rgba(238,238,248,0.3)';
 ctx.font = '600 11px Geist, sans-serif';
 ctx.fillText('TOP POSITIONS', 52, 436);
 topHoldings.forEach(([t, h], i) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const avgCost = typeof h === 'object' ? h.avgCost : ptDailyPrice(t);
 const cur = ptDailyPrice(t);
 const pl = (cur - avgCost) / avgCost * 100;
 const plColor = pl >= 0 ? '#00c97a' : '#ff3860';
 const x = 52 + i * 248;
 ctx.fillStyle = 'rgba(255,255,255,0.06)';
 roundRect(ctx, x, 448, 228, 72, 10);
 ctx.fill();
 ctx.strokeStyle = 'rgba(255,255,255,0.08)';
 ctx.lineWidth = 1;
 roundRect(ctx, x, 448, 228, 72, 10);
 ctx.stroke();
 ctx.fillStyle = '#a89cff';
 ctx.font = '800 18px Geist, Geist, sans-serif';
 ctx.fillText(t, x + 16, 472);
 ctx.fillStyle = plColor;
 ctx.font = '700 14px Geist, Geist, sans-serif';
 ctx.fillText((pl >= 0 ? '+' : '') + pl.toFixed(1) + '%', x + 16, 496);
 ctx.fillStyle = 'rgba(238,238,248,0.3)';
 ctx.font = '500 12px Geist, sans-serif';
 ctx.fillText(shares + ' shares', x + 80, 496);
 });
 } else {
 ctx.fillStyle = 'rgba(238,238,248,0.25)';
 ctx.font = '500 15px Geist, sans-serif';
 ctx.fillText('No positions yet — just holding $' + pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' cash', 52, 460);
 }

 // Bottom right watermark
 ctx.fillStyle = 'rgba(238,238,248,0.2)';
 ctx.font = '500 14px Geist, sans-serif';
 ctx.textAlign = 'right';
 ctx.fillText('stocksightai.com', W - 48, H - 32);
 ctx.fillStyle = 'rgba(238,238,248,0.12)';
 ctx.font = '500 12px Geist, sans-serif';
 ctx.fillText('Paper trading · not financial advice', W - 48, H - 14);

 // Download
 const link = document.createElement('a');
 link.download = 'stocksight-portfolio.png';
 link.href = canvas.toDataURL('image/png');
 link.click();
 toast('Portfolio card saved! Post it on X or Reddit 🚀', 'success', 4000);
}

/* ── Share a stock as an image (1080x1350, fits Instagram, LinkedIn and X) ──
 Drawn from the same research the stock page shows: verdict, analyst target, risk and a year of real prices. */
const CARD_COLORS = { 'Strong Buy': '#a78bfa', 'Buy': '#a78bfa', 'Hold': '#f2b544', 'Sell': '#f87171' };
function loadImg(src) {
 return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
}
async function drawStockCard({ ticker, name, R, closes }) {
 const W = 1080, H = 1350, P = 72;
 const c = document.createElement('canvas'); c.width = W; c.height = H;
 const x = c.getContext('2d');
 await Promise.all(['400 30px Geist', '600 30px Geist', '700 30px Geist', '800 30px Geist'].map(f => document.fonts.load(f).catch(() => {})));
 const f = R.facts || {}, st = R.stats || {}, price = R.price;
 const font = (w, px) => `${w} ${px}px Geist, system-ui, sans-serif`;
 const text = (t, X, Y, w, px, color, align = 'left') => { x.font = font(w, px); x.fillStyle = color; x.textAlign = align; x.fillText(t, X, Y); };
 const box = (X, Y, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(X, Y, w, h, r); else x.rect(X, Y, w, h); };

 await drawCardChrome(x, W, H, P, ticker);

 // Ticker, name, price
 text(ticker, P, 262, 800, 128, '#f6f1ff');
 text(name.length > 34 ? name.slice(0, 33) + '…' : name, P, 318, 400, 36, 'rgba(246,241,255,0.6)');
 const ret = st.ret1y ?? f.change52w;
 if (price) {
  text(fmtPx(price), P, 412, 700, 64, '#f6f1ff');
  if (ret != null) {
   x.font = font(700, 64); const pw = x.measureText(fmtPx(price)).width;
   const up = ret >= 0, label = `${up ? '+' : ''}${(ret * 100).toFixed(1)}% past year`;
   x.font = font(700, 26); const lw = x.measureText(label).width + 32;
   x.fillStyle = up ? 'rgba(167,139,250,0.16)' : 'rgba(248,113,113,0.14)';
   box(P + pw + 22, 368, lw, 48, 24); x.fill();
   text(label, P + pw + 22 + lw / 2, 401, 700, 26, up ? '#c4b5fd' : '#fca5a5', 'center');
  }
 }

 // A year of real prices
 if (closes.length > 20) {
  const cx0 = P, cy0 = 460, cw = W - P * 2, ch = 300;
  const lo = Math.min(...closes), hi = Math.max(...closes), span = hi - lo || 1;
  const px = i => cx0 + i / (closes.length - 1) * cw, py = v => cy0 + ch - (v - lo) / span * ch;
  const fill = x.createLinearGradient(0, cy0, 0, cy0 + ch);
  fill.addColorStop(0, 'rgba(139,92,246,0.32)'); fill.addColorStop(1, 'rgba(139,92,246,0)');
  x.beginPath(); closes.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
  x.lineTo(px(closes.length - 1), cy0 + ch); x.lineTo(cx0, cy0 + ch); x.closePath(); x.fillStyle = fill; x.fill();
  x.beginPath(); closes.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
  x.lineWidth = 5; x.lineJoin = 'round'; x.strokeStyle = '#a78bfa'; x.shadowColor = 'rgba(167,139,250,0.6)'; x.shadowBlur = 18; x.stroke(); x.shadowBlur = 0;
  x.beginPath(); x.arc(px(closes.length - 1), py(closes[closes.length - 1]), 10, 0, Math.PI * 2); x.fillStyle = '#ede9fe'; x.fill();
 }

 // Verdict and two numbers
 const vy = 820, col = CARD_COLORS[R.verdict] || '#a78bfa';
 x.fillStyle = 'rgba(255,255,255,0.045)'; x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 2;
 box(P, vy, W - P * 2, 250, 28); x.fill(); x.stroke();
 text('STOCKSIGHT VERDICT', P + 40, vy + 62, 700, 22, 'rgba(246,241,255,0.5)');
 text(R.verdict, P + 40, vy + 140, 800, 72, col);
 text(`${R.score}/100`, P + 40, vy + 196, 600, 30, 'rgba(246,241,255,0.62)');
 const up = f.targetMean && price ? f.targetMean / price - 1 : null;
 const stats = [];
 if (up != null) stats.push(['Analyst target', fmtPx(f.targetMean), `${up >= 0 ? '+' : ''}${(up * 100).toFixed(0)}% from today`]);
 if (st.vol != null) stats.push(['Risk', st.vol >= 0.7 ? 'Very high' : st.vol >= 0.4 ? 'High' : st.vol >= 0.25 ? 'Moderate' : 'Lower', `swings ~${Math.round(st.vol * 100)}% a year`]);
 stats.slice(0, 2).forEach(([label, val, sub], i) => {
  const sx = P + 470 + i * 240;
  text(label, sx, vy + 62, 600, 22, 'rgba(246,241,255,0.5)');
  text(val, sx, vy + 132, 700, 42, '#f6f1ff');
  text(sub, sx, vy + 178, 400, 22, 'rgba(246,241,255,0.55)');
 });

 // Where to see the rest
 text('Full breakdown at', P, 1170, 400, 28, 'rgba(246,241,255,0.55)');
 text(`stocksightai.com/?stock=${ticker}`, P, 1214, 700, 34, '#f6f1ff');
 text('Real market data. Not financial advice.', W - P, 1214, 400, 22, 'rgba(246,241,255,0.4)', 'right');
 return c;
}
// Text, font and rounded-box helpers for drawing share images on a canvas
function cardKit(x) {
 const font = (w, px) => `${w} ${px}px Geist, system-ui, sans-serif`;
 return {
  font,
  text: (t, X, Y, w, px, color, align = 'left') => { x.font = font(w, px); x.fillStyle = color; x.textAlign = align; x.fillText(t, X, Y); },
  box: (X, Y, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(X, Y, w, h, r); else x.rect(X, Y, w, h); },
 };
}
// The shared look of every share image: near-black with violet light, a planet at the bottom, the logo and today's date
async function drawCardChrome(x, W, H, P, seedStr) {
 await Promise.all(['400 30px Geist', '600 30px Geist', '700 30px Geist', '800 30px Geist'].map(ft => document.fonts.load(ft).catch(() => {})));
 const { font, text, box } = cardKit(x);
 // Background: near-black with violet light, and a planet rising at the bottom
 x.fillStyle = '#07050b'; x.fillRect(0, 0, W, H);
 const glow = (cx, cy, r, a) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, `rgba(124,74,230,${a})`); g.addColorStop(1, 'rgba(124,74,230,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); };
 glow(W * 0.85, 120, 620, 0.32); glow(W * 0.1, H, 760, 0.38);
 let seed = String(seedStr).split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 233280, 7);
 const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
 for (let i = 0; i < 90; i++) { x.fillStyle = `rgba(255,255,255,${0.12 + rnd() * 0.4})`; x.fillRect(rnd() * W, rnd() * H, 1.6, 1.6); }
 x.save(); x.beginPath(); x.arc(W / 2, H + 1160, 1250, 0, Math.PI * 2);
 x.shadowColor = 'rgba(170,125,255,0.7)'; x.shadowBlur = 70; x.fillStyle = '#06040a'; x.fill(); x.restore();
 x.save(); x.beginPath(); x.arc(W / 2, H + 1160, 1250, Math.PI * 1.05, Math.PI * 1.95); x.lineWidth = 3; x.strokeStyle = 'rgba(225,210,255,0.85)'; x.stroke(); x.restore();

 // Brand
 try { const logo = await loadImg('/stocksight-logo-96.png'); x.save(); box(P, 64, 52, 52, 13); x.clip(); x.drawImage(logo, P, 64, 52, 52); x.restore(); } catch {}
 x.font = font(600, 34); x.textAlign = 'left'; x.fillStyle = '#f6f1ff'; x.fillText('Stock', P + 66, 101);
 const sw = x.measureText('Stock').width; x.fillStyle = '#b49cfc'; x.fillText('Sight', P + 66 + sw, 101);
 text(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), W - P, 101, 500, 26, 'rgba(246,241,255,0.45)', 'right');
}
// Share an image: the share sheet on phones (Instagram, Messages, ...); on computers, save it and copy the link
async function shareImage(canvas, { file: fileName, text: shareText, url, type, id }) {
 const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
 const file = new File([blob], fileName, { type: 'image/png' });
 const sheet = !!navigator.canShare?.({ files: [file] });
 track('share', { method: sheet ? 'share_sheet' : 'download', content_type: type, item_id: id });
 if (sheet) {
  try { await navigator.share({ files: [file], text: `${shareText} ${url}` }); return; }
  catch (e) { if (e?.name === 'AbortError') return; }
 }
 const a = document.createElement('a');
 a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
 setTimeout(() => URL.revokeObjectURL(a.href), 5000);
 try { await navigator.clipboard.writeText(url); toast('Image saved and link copied. Paste the link with your post.', 'success', 4500); }
 catch { toast(`Image saved. Link: ${url}`, 'success', 5000); }
}

async function shareStockCard(ticker, type) {
 const rs = window._rs;
 if (!rs || rs.ticker !== ticker || !rs.R) { toast(`Still loading ${ticker}. Try again in a second.`, 'info'); return; }
 const btn = document.querySelector('.b-share');
 if (btn) btn.disabled = true;
 try {
  let closes = [];
  try { closes = (await getHistory(ySym(ticker, type))).c.slice(-252); } catch {}
  const canvas = await drawStockCard({ ticker, name: rsName(ticker, rs.R.facts), R: rs.R, closes });
  await shareImage(canvas, { file: `stocksight-${ticker}.png`, text: `${ticker} on StockSight: ${rs.R.verdict}, ${rs.R.score}/100`, url: `https://stocksightai.com/?stock=${encodeURIComponent(ticker)}`, type: 'stock_card', id: ticker });
 } catch (e) {
  console.warn('share card:', e);
  toast('Could not make the image. Please try again.', 'error');
 } finally {
  if (btn) btn.disabled = false;
 }
}

function roundRect(ctx, x, y, w, h, r) {
 ctx.beginPath();
 ctx.moveTo(x + r, y);
 ctx.lineTo(x + w - r, y);
 ctx.quadraticCurveTo(x + w, y, x + w, y + r);
 ctx.lineTo(x + w, y + h - r);
 ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
 ctx.lineTo(x + r, y + h);
 ctx.quadraticCurveTo(x, y + h, x, y + h - r);
 ctx.lineTo(x, y + r);
 ctx.quadraticCurveTo(x, y, x + r, y);
 ctx.closePath();
}

function renderRiskLab(pt, entries) {
 if (!entries || entries.length === 0) return '';

 // Compute weighted beta and sector breakdown
 let totalInvested = 0;
 const sectorMap = {};
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const val = shares * ptDailyPrice(t);
 totalInvested += val;
 const sector = ASSET_DATA[t]?.[2] || 'Other';
 sectorMap[sector] = (sectorMap[sector] || 0) + val;
 });
 const totalPortfolio = totalInvested + pt.cash;

 let weightedBeta = 0;
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const val = shares * ptDailyPrice(t);
 const beta = assetData(t)[0] ?? 1;
 weightedBeta += (val / (totalPortfolio || 1)) * beta;
 });
 // Cash contributes 0 beta
 weightedBeta = parseFloat(weightedBeta.toFixed(2));

 const betaColor = weightedBeta >= 1.5 ? 'var(--red)' : weightedBeta >= 1.0 ? 'var(--gold)' : 'var(--green)';
 const betaLabel = weightedBeta >= 1.5 ? 'High Risk' : weightedBeta >= 1.0 ? 'Moderate Risk' : 'Low Risk';

 // Sector bars
 const sortedSectors = Object.entries(sectorMap).sort((a,b) => b[1]-a[1]);
 const sectorColors = ['var(--teal)','var(--accent2)','var(--green)','var(--gold)','var(--red)','#a78bfa','#fb923c','#38bdf8'];
 const sectorBars = sortedSectors.map(([s, v], i) => {
 const pct = totalPortfolio > 0 ? v / totalPortfolio * 100 : 0;
 const overconc = pct > 40;
 return `<div style="margin-bottom:.5rem">
 <div style="display:flex;justify-content:space-between;font-size:.7rem;margin-bottom:3px">
 <span style="color:var(--text2)">${s}${overconc ? ' ⚠️' : ''}</span>
 <span style="color:${overconc ? 'var(--gold)' : 'var(--text3)'};font-weight:600">${pct.toFixed(1)}%</span>
 </div>
 <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
 <div style="height:100%;border-radius:3px;background:${sectorColors[i%sectorColors.length]};width:${Math.min(pct,100)}%;transition:width .4s ease"></div>
 </div>
 </div>`;
 }).join('');

 // Crash scenarios (drop 10/20/30/40%)
 const crashRows = [10, 20, 30, 40].map(drop => {
 const marketDrop = drop / 100;
 let newValue = pt.cash;
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const beta = assetData(t)[0] ?? 1;
 const currentVal = shares * ptDailyPrice(t);
 const stockDrop = Math.min(marketDrop * beta, 0.99);
 newValue += currentVal * (1 - stockDrop);
 });
 const loss = totalPortfolio - newValue;
 const lossFromStart = 10000 - newValue;
 return `<div style="display:grid;grid-template-columns:80px 1fr auto;align-items:center;gap:10px;padding:.5rem 0;border-bottom:1px solid var(--border)">
 <div style="font-size:.72rem;font-weight:700;color:var(--text2)">Market −${drop}%</div>
 <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
 <div style="height:100%;border-radius:3px;background:rgba(255,56,96,.6);width:${Math.min(loss/totalPortfolio*100,100)}%"></div>
 </div>
 <div style="font-size:.72rem;text-align:right">
 <div style="font-weight:700;color:var(--red)">−$${loss.toFixed(0)}</div>
 <div style="font-size:.6rem;color:var(--text3)">Portfolio: $${newValue.toFixed(0)}</div>
 </div>
 </div>`;
 }).join('');

 return `<div class="card" style="margin-top:1rem;border-color:rgba(255,56,96,.2)">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(255,56,96,.07),rgba(255,56,96,.02))">
 <div>
 <div class="card-hdr-title" style="color:var(--red)">🔬 Risk Lab</div>
 <div class="card-hdr-sub">Portfolio risk analysis & crash simulator</div>
 </div>
 <div style="background:rgba(255,56,96,.1);border:1px solid rgba(255,56,96,.3);border-radius:8px;padding:6px 14px;text-align:center">
 <div style="font-size:1.1rem;font-weight:800;color:${betaColor}">${weightedBeta}x</div>
 <div style="font-size:.58rem;color:${betaColor};font-weight:600;letter-spacing:.06em">${betaLabel.toUpperCase()}</div>
 </div>
 </div>
 <div style="padding:1rem;display:grid;grid-template-columns:1fr 1fr;gap:1.25rem">
 <div>
 <div style="font-size:.62rem;color:var(--text3);letter-spacing:.08em;font-weight:600;margin-bottom:.625rem">SECTOR EXPOSURE</div>
 ${sectorBars}
 <div style="font-size:.62rem;color:var(--text3);margin-top:.5rem">Cash: ${(pt.cash/totalPortfolio*100).toFixed(1)}% · ${pt.cash >= totalPortfolio * 0.1 ? '✅ Good buffer' : '⚠️ Low reserves'}</div>
 </div>
 <div>
 <div style="font-size:.62rem;color:var(--text3);letter-spacing:.08em;font-weight:600;margin-bottom:.625rem">CRASH SIMULATOR</div>
 <div style="font-size:.68rem;color:var(--text3);margin-bottom:.5rem">Beta-weighted impact on your portfolio if markets drop:</div>
 ${crashRows}
 <div style="font-size:.62rem;color:var(--text3);margin-top:.625rem">Based on each stock's beta vs. market. Cash is protected.</div>
 </div>
 </div>
 </div>`;
}

function renderPaperTradeTab() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;

 // Re-sync from Supabase on first open so cross-device data is fresh
 if (user?.email && !renderPaperTradeTab._synced && !renderPaperTradeTab._syncing) {
  renderPaperTradeTab._syncing = true;
  usersTable().select('portfolio').eq('email', user.email).single()
   .then(({data}) => {
    const sbPt = data?.portfolio?.paper_trade;
    renderPaperTradeTab._syncing = false;
    renderPaperTradeTab._synced = true;
    if (sbPt) {
     try { localStorage.setItem('ss_pt_'+user.email, JSON.stringify(sbPt)); } catch {}
     renderPaperTradeTab();
    }
   }).catch(()=>{ renderPaperTradeTab._syncing = false; renderPaperTradeTab._synced = true; });
 }

 // Auto-execute any pending orders if the market just opened
 const didProcess = processPendingOrders();

 const pt = getPtPortfolio();
 const pendingOrders = getPtPendingOrders();
 const entries = Object.entries(pt.holdings);
 let portfolioValue = pt.cash;
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 portfolioValue += shares * ptDailyPrice(t);
 });
 const totalReturn = portfolioValue - 10000;
 const totalReturnPct = totalReturn / 10000 * 100;
 const retColor = totalReturn >= 0 ? 'var(--green)' : 'var(--red)';

 // Build market status — use formatToParts for reliable cross-timezone ET extraction
 const now = new Date();
 const etParts = new Intl.DateTimeFormat('en-US', {
 timeZone: 'America/New_York',
 weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
 }).formatToParts(now);
 const etGet = type => etParts.find(p => p.type === type)?.value ?? '0';
 const etDayStr = etGet('weekday');
 let etHours = parseInt(etGet('hour'), 10); if (etHours === 24) etHours = 0;
 const etMins = parseInt(etGet('minute'), 10);
 const etTimeVal = etHours * 60 + etMins;
 const isWeekend = etDayStr === 'Sat' || etDayStr === 'Sun';
 const isStockOpen = !isWeekend && etTimeVal >= 9*60+30 && etTimeVal < 16*60;
 const isPreMarket = !isWeekend && etTimeVal >= 4*60 && etTimeVal < 9*60+30;
 const isAfterHours = !isWeekend && etTimeVal >= 16*60 && etTimeVal < 20*60;
 const etTimeStr = new Intl.DateTimeFormat('en-US', {
 timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
 }).format(now);

 let stockStatus, stockColor, stockBg;
 if (isStockOpen) { stockStatus='● Open'; stockColor='var(--green)'; stockBg='rgba(0,201,122,.08)'; }
 else if (isPreMarket) { stockStatus='◑ Pre-Market'; stockColor='var(--gold)'; stockBg='rgba(245,158,11,.08)'; }
 else if (isAfterHours) { stockStatus='◑ After Hours'; stockColor='var(--gold)'; stockBg='rgba(245,158,11,.08)'; }
 else { stockStatus='○ Closed'; stockColor='var(--red)'; stockBg='rgba(255,56,96,.06)'; }

 mc.innerHTML = `
 <!-- Market Status Banner -->
 <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem;margin-bottom:1.5rem">
 <div style="background:${stockBg};border:1px solid ${stockColor}44;border-radius:12px;padding:.875rem 1rem">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;font-weight:600;margin-bottom:5px">STOCKS &amp; INDEXES</div>
 <div style="font-size:.88rem;font-weight:700;color:${stockColor}">${stockStatus}</div>
 <div style="font-size:.62rem;color:var(--text3);margin-top:3px">NYSE/NASDAQ · ${etTimeStr} ET</div>
 <div style="font-size:.6rem;color:var(--text3);margin-top:1px">${isStockOpen ? 'Trades execute now' : isPreMarket ? 'Opens 9:30 AM ET' : isAfterHours ? 'Closed 4:00 PM ET' : isWeekend ? 'Opens Mon 9:30 AM ET' : 'Opens 9:30 AM ET'}</div>
 </div>
 <div style="background:rgba(0,201,122,.06);border:1px solid rgba(0,201,122,.3);border-radius:12px;padding:.875rem 1rem">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;font-weight:600;margin-bottom:5px">CRYPTO</div>
 <div style="font-size:.88rem;font-weight:700;color:var(--green)">● Always Open</div>
 <div style="font-size:.62rem;color:var(--text3);margin-top:3px">24 / 7 / 365</div>
 <div style="font-size:.6rem;color:var(--text3);margin-top:1px">BTC, ETH, SOL &amp; more</div>
 </div>
 <div style="background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:.875rem 1rem">
 <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;font-weight:600;margin-bottom:5px">YOUR CASH</div>
 <div style="font-size:.88rem;font-weight:700;color:var(--accent2)">$${pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div style="font-size:.62rem;color:var(--text3);margin-top:3px">Available to trade</div>
 <div style="font-size:.6rem;color:var(--text3);margin-top:1px">of $10,000 starting capital</div>
 </div>
 </div>

 <!-- Header -->
 <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem">
 <div>
 <div style="font-family:'Geist',sans-serif;font-size:1.5rem;font-weight:800;letter-spacing:-.02em"> Paper Trading</div>
 <div style="font-size:.8rem;color:var(--text2);margin-top:4px">Practice investing with $10,000 of virtual money — no real risk</div>
 </div>
 <div class="pt-actions" style="display:flex;gap:8px;flex-wrap:wrap">
 <button class="pt-btn" onclick="switchTab('s');setTimeout(()=>toast('Search for a stock and click Paper Trade','info',3000),100)">
 + New Trade
 </button>
 <button onclick="sharePtCard()" style="background:linear-gradient(135deg,rgba(108,92,231,.25),rgba(108,92,231,.1));color:var(--accent2);border:1px solid rgba(108,92,231,.35);border-radius:10px;padding:9px 14px;font-family:inherit;font-size:.78rem;font-weight:700;cursor:pointer;transition:all .2s" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='none'">
 📤 Share
 </button>
 <button onclick="if(confirm('Reset paper portfolio to $10,000? All trades will be lost.')){savePtPortfolio({cash:10000,holdings:{}});renderPaperTradeTab();toast('Portfolio reset! ','success')}"
 style="background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:9px 14px;font-family:inherit;font-size:.78rem;cursor:pointer;color:var(--text2)">
 ↺ Reset
 </button>
 ${user ? `<button onclick="toast('Syncing...','info',1500);renderPaperTradeTab._synced=false;renderPaperTradeTab._syncing=false;renderPaperTradeTab();setTimeout(()=>toast('Synced!','success',2000),1600)"
 style="background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:9px 14px;font-family:inherit;font-size:.78rem;cursor:pointer;color:var(--teal)">
 ↻ Sync
 </button>` : ''}
 </div>
 </div>

 <!-- Pending Orders -->
 ${pendingOrders.length > 0 ? `
 <div class="card" style="margin-bottom:1.5rem;border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.03)">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(245,158,11,.1),rgba(245,158,11,.03))">
 <div class="card-hdr-title" style="color:var(--gold)"> Pending Orders
 <span style="margin-left:6px;background:var(--gold);color:#000;font-size:.6rem;font-weight:800;padding:2px 7px;border-radius:20px">${pendingOrders.length}</span>
 </div>
 <div class="card-hdr-sub">Queued outside market hours — auto-execute at next open · Mon–Fri 9:30 AM ET</div>
 </div>
 <div style="padding:.25rem .5rem .75rem">
 ${pendingOrders.map(o => {
 const sideColor = o.side === 'buy' ? 'var(--green)' : 'var(--red)';
 const sideBg = o.side === 'buy' ? 'rgba(0,201,122,.12)' : 'rgba(255,56,96,.1)';
 const sideBdr = o.side === 'buy' ? 'rgba(0,201,122,.3)' : 'rgba(255,56,96,.25)';
 const placed = new Date(o.placedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
 const cashNote = o.side === 'buy'
 ? `<span style="color:var(--text3);font-size:.62rem">$${o.total.toFixed(2)} reserved from cash</span>`
 : `<span style="color:var(--text3);font-size:.62rem">${o.shares.toFixed(4)} shares reserved</span>`;
 return `<div style="display:flex;align-items:center;gap:10px;padding:.625rem .5rem;border-bottom:1px solid var(--border)">
 <div style="background:${sideBg};border:1px solid ${sideBdr};border-radius:7px;padding:4px 10px;font-size:.72rem;font-weight:800;color:${sideColor};flex-shrink:0;text-transform:uppercase">${o.side}</div>
 <div style="flex:1;min-width:0">
 <div style="display:flex;align-items:baseline;gap:6px">
 <span style="font-family:'Geist',sans-serif;font-weight:800;color:var(--accent2);font-size:.88rem">${o.ticker}</span>
 <span style="font-size:.75rem;color:var(--text)">${o.shares.toFixed(4)} shares</span>
 <span style="font-size:.72rem;color:var(--text2)">@ $${o.price.toLocaleString()}</span>
 </div>
 <div style="margin-top:2px;display:flex;gap:10px;align-items:center">${cashNote}<span style="color:var(--text3);font-size:.6rem">Placed ${placed}</span></div>
 </div>
 <button onclick="cancelPendingOrder('${o.id}')"
 style="background:rgba(255,56,96,.1);border:1px solid rgba(255,56,96,.3);color:var(--red);border-radius:7px;padding:5px 11px;font-family:inherit;font-size:.7rem;font-weight:700;cursor:pointer;flex-shrink:0;white-space:nowrap">
 Cancel
 </button>
 </div>`;
 }).join('')}
 </div>
 </div>` : ''}

 <!-- Stats row -->
 <div id="pt-stats-row" style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem">
 <div class="pt-stat">
 <div class="pt-stat-val">$${portfolioValue.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div class="pt-stat-lbl">TOTAL VALUE</div>
 </div>
 <div class="pt-stat">
 <div class="pt-stat-val">$${pt.cash.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div class="pt-stat-lbl">CASH AVAILABLE${pendingOrders.filter(o=>o.side==='buy').length > 0 ? ` <span style="color:var(--gold);font-size:.55rem">(${pendingOrders.filter(o=>o.side==='buy').length} buy order${pendingOrders.filter(o=>o.side==='buy').length>1?'s':''} reserved)</span>` : ''}</div>
 </div>
 <div class="pt-stat">
 <div class="pt-stat-val" style="color:${retColor}">${totalReturn>=0?'+':''}$${Math.abs(totalReturn).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div class="pt-stat-lbl">TOTAL P&L</div>
 </div>
 <div class="pt-stat">
 <div class="pt-stat-val" style="color:${retColor}">${totalReturn>=0?'+':''}${totalReturnPct.toFixed(2)}%</div>
 <div class="pt-stat-lbl">RETURN %</div>
 </div>
 </div>

 <!-- Holdings -->
 ${entries.length === 0 ? `
 <div class="card">
 <div style="padding:3rem;text-align:center">
 <div style="font-size:3rem;margin-bottom:1rem"></div>
 <div style="font-family:'Geist',sans-serif;font-size:1.1rem;font-weight:800;margin-bottom:8px">No paper trades yet</div>
 <div style="font-size:.82rem;color:var(--text2);margin-bottom:1.5rem;line-height:1.65">Search for any stock and click the <strong style="color:var(--teal)"> Paper Trade</strong> button to place your first virtual trade.</div>
 <button class="pt-btn" onclick="switchTab('s');setTimeout(()=>toast('Search for a stock and click Paper Trade','info',3000),100)">
 Start Trading →
 </button>
 </div>
 </div>` : `
 <div class="card" style="margin-bottom:1.5rem">
 <div class="card-hdr">
 <div class="card-hdr-title"> Open Positions</div>
 <div class="card-hdr-sub">${entries.length} position${entries.length!==1?'s':''} · click to trade</div>
 </div>
 <div style="padding:0 .5rem .5rem">
 <table class="pt-pos-table" style="width:100%;border-collapse:collapse">
 <thead>
 <tr style="font-size:.62rem;color:var(--text3);letter-spacing:.08em">
 <th style="text-align:left;padding:.75rem .5rem;border-bottom:1px solid var(--border)">TICKER</th>
 <th style="text-align:right;padding:.75rem .5rem;border-bottom:1px solid var(--border)">SHARES</th>
 <th style="text-align:right;padding:.75rem .5rem;border-bottom:1px solid var(--border)">AVG COST</th>
 <th style="text-align:right;padding:.75rem .5rem;border-bottom:1px solid var(--border)">CUR PRICE</th>
 <th style="text-align:right;padding:.75rem .5rem;border-bottom:1px solid var(--border)">VALUE / P&L</th>
 <th style="text-align:right;padding:.75rem .5rem;border-bottom:1px solid var(--border)">% OF PORT</th>
 <th style="text-align:center;padding:.75rem .5rem;border-bottom:1px solid var(--border)">ACTION</th>
 </tr>
 </thead>
 <tbody>
 ${entries.map(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const avgCost = typeof h === 'object' ? h.avgCost : ptDailyPrice(t);
 const curPrice = ptDailyPrice(t);
 const val = shares * curPrice;
 const pl = (curPrice - avgCost) * shares;
 const plPct = (curPrice - avgCost) / avgCost * 100;
 const pct = (val / portfolioValue * 100).toFixed(1);
 const found = TICKERS.find(e => e.t === t) || {n: t};
 const plColor = pl >= 0 ? 'var(--green)' : 'var(--red)';
 return `<tr style="border-bottom:1px solid var(--border);transition:background .15s" onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background='transparent'">
 <td style="padding:.875rem .5rem">
 <div style="cursor:pointer" onclick="goAsset('${t}','${found.k || 's'}')">
 <div style="font-family:'Geist',sans-serif;font-weight:800;color:var(--accent2)">${t}</div>
 <div style="font-size:.65rem;color:var(--text3)">${found.n}</div>
 </div>
 </td>
 <td style="text-align:right;padding:.875rem .5rem;font-size:.82rem">${shares.toFixed(4)}</td>
 <td style="text-align:right;padding:.875rem .5rem;font-size:.78rem;color:var(--text3)">$${avgCost.toFixed(2)}<br><span style="font-size:.7rem">avg cost</span></td>
 <td style="text-align:right;padding:.875rem .5rem;font-size:.82rem">$${curPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:curPrice<1?6:2})}</td>
 <td style="text-align:right;padding:.875rem .5rem">
 <div style="font-size:.88rem;font-weight:700">$${val.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
 <div style="font-size:.65rem;color:${plColor}">${pl>=0?'+':''}$${Math.abs(pl).toFixed(2)} (${plPct>=0?'+':''}${plPct.toFixed(1)}%)</div>
 </td>
 <td style="text-align:right;padding:.875rem .5rem;font-size:.82rem;color:var(--text2)">${pct}%</td>
 <td style="text-align:center;padding:.875rem .5rem">
 <div style="display:flex;gap:4px;justify-content:center">
 <button onclick="openPtModal('${t}','${t}')" style="background:rgba(0,201,122,.1);border:1px solid rgba(0,201,122,.3);color:var(--green);border-radius:6px;padding:4px 10px;font-family:inherit;font-size:.7rem;font-weight:700;cursor:pointer">Buy</button>
 <button onclick="openPtModal('${t}','${t}');setTimeout(()=>setPtSide('sell'),50)" style="background:rgba(255,56,96,.08);border:1px solid rgba(255,56,96,.25);color:var(--red);border-radius:6px;padding:4px 10px;font-family:inherit;font-size:.7rem;font-weight:700;cursor:pointer">Sell</button>
 </div>
 </td>
 </tr>`;
 }).join('')}
 </tbody>
 </table>
 </div>
 </div>

 <!-- Allocation bar -->
 <div class="card">
 <div class="card-hdr">
 <div class="card-hdr-title"> Allocation</div>
 <div class="card-hdr-sub">How your virtual portfolio is split</div>
 </div>
 <div style="padding:1rem">
 <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:.875rem;gap:2px">
 ${[...entries.map(([t,h])=>({t,val:(typeof h==='object'?h.shares:h)*ptDailyPrice(t)})), {t:'Cash',val:pt.cash}]
 .sort((a,b)=>b.val-a.val)
 .map(({t,val},i)=>{
 const pct=(val/portfolioValue*100).toFixed(1);
 const colors=['#6c5ce7','#00c97a','#00b4d8','#f59e0b','#ff3860','#a78bfa','#34d399'];
 return `<div style="flex:${pct};background:${colors[i%colors.length]};min-width:2px" title="${t}: ${pct}%"></div>`;
 }).join('')}
 </div>
 <div style="display:flex;flex-wrap:wrap;gap:.5rem">
 ${[...entries.map(([t,h])=>({t,val:(typeof h==='object'?h.shares:h)*ptDailyPrice(t)})), {t:'Cash ',val:pt.cash}]
 .sort((a,b)=>b.val-a.val)
 .map(({t,val},i)=>{
 const colors=['#6c5ce7','#00c97a','#00b4d8','#f59e0b','#ff3860','#a78bfa','#34d399'];
 return `<div style="display:flex;align-items:center;gap:5px;font-size:.7rem">
 <div style="width:8px;height:8px;border-radius:2px;background:${colors[i%colors.length]};flex-shrink:0"></div>
 <span style="color:var(--text2)">${t}</span>
 <span style="color:var(--text);font-weight:700">${(val/portfolioValue*100).toFixed(1)}%</span>
 </div>`;
 }).join('')}
 </div>
 </div>
 </div>

 </div>`}

 <!-- Risk Lab -->
 ${renderRiskLab(pt, entries)}

 <!-- Portfolio Insight (AI Rebalancing) -->
 <div class="card" style="margin-top:1rem;border-color:rgba(168,85,247,.25)">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(168,85,247,.02))">
 <div class="card-hdr-title" style="color:var(--green)">🧠 Portfolio Insight</div>
 <div class="card-hdr-sub">AI-powered concentration analysis &amp; rebalancing suggestion</div>
 </div>
 <div style="padding:1rem;display:flex;flex-direction:column;gap:.75rem">
 <button onclick="showPtInsight()" style="background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(168,85,247,.12));color:#a855f7;border:1px solid rgba(168,85,247,.4);border-radius:10px;padding:10px 20px;font-family:inherit;font-size:.82rem;font-weight:700;cursor:pointer;align-self:flex-start">Get AI Insight</button>
 <div id="pt-insight-result" style="font-size:.82rem;color:var(--text2);line-height:1.65;display:none"></div>
 </div>
 </div>

 <!-- Trade History -->
 ${(()=>{
 const log = (pt.trade_log||[]).slice().reverse();
 if (!log.length) return '';
 return `<div class="card" style="margin-top:1rem">
 <div class="card-hdr">
 <div class="card-hdr-title">📋 Trade History</div>
 <div class="card-hdr-sub">${log.length} trade${log.length!==1?'s':''} · newest first</div>
 </div>
 <div style="overflow-x:auto;padding:0 .5rem .5rem">
 <table style="width:100%;border-collapse:collapse;font-size:.78rem;min-width:520px">
 <thead><tr style="font-size:.62rem;color:var(--text3);letter-spacing:.08em">
 <th style="text-align:left;padding:.625rem .5rem;border-bottom:1px solid var(--border)">DATE</th>
 <th style="text-align:left;padding:.625rem .5rem;border-bottom:1px solid var(--border)">TICKER</th>
 <th style="text-align:center;padding:.625rem .5rem;border-bottom:1px solid var(--border)">SIDE</th>
 <th style="text-align:right;padding:.625rem .5rem;border-bottom:1px solid var(--border)">SHARES</th>
 <th style="text-align:right;padding:.625rem .5rem;border-bottom:1px solid var(--border)">PRICE</th>
 <th style="text-align:right;padding:.625rem .5rem;border-bottom:1px solid var(--border)">TOTAL</th>
 <th style="text-align:right;padding:.625rem .5rem;border-bottom:1px solid var(--border)">P&amp;L</th>
 </tr></thead>
 <tbody>
 ${log.map(e=>{
 const d=new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
 const sideColor=e.side==='BUY'?'var(--green)':'var(--red)';
 const sideBg=e.side==='BUY'?'rgba(0,201,122,.12)':'rgba(255,56,96,.1)';
 const plCell=e.side==='BUY'?'<span style="color:var(--text3)">—</span>':`<span style="color:${e.pl>=0?'var(--green)':'var(--red)'};font-weight:600">${e.pl>=0?'+':''}$${Math.abs(e.pl).toFixed(2)}</span>`;
 return `<tr style="border-bottom:1px solid var(--border)">
 <td style="padding:.5rem .5rem;color:var(--text3);font-size:.7rem;white-space:nowrap">${d}</td>
 <td style="padding:.5rem .5rem;font-family:'Geist',sans-serif;font-weight:800;color:var(--accent2)">${e.ticker}</td>
 <td style="padding:.5rem .5rem;text-align:center"><span style="background:${sideBg};color:${sideColor};border-radius:5px;padding:2px 8px;font-size:.65rem;font-weight:800">${e.side}</span></td>
 <td style="padding:.5rem .5rem;text-align:right">${(+e.shares).toFixed(4)}</td>
 <td style="padding:.5rem .5rem;text-align:right">$${(+e.price).toLocaleString()}</td>
 <td style="padding:.5rem .5rem;text-align:right;font-weight:600">$${(+e.total).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
 <td style="padding:.5rem .5rem;text-align:right">${plCell}</td>
 </tr>`;
 }).join('')}
 </tbody>
 </table>
 </div>
 </div>`;
 })()}

 <!-- Community Leaderboard (always visible) -->
 <div class="card" style="margin-top:1rem">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(245,158,11,.07),rgba(245,158,11,.02))">
 <div>
 <div class="card-hdr-title" style="color:var(--gold)">🏆 Community Leaderboard</div>
 <div class="card-hdr-sub">Top virtual portfolios · updates on every trade · opt-in only</div>
 </div>
 <div style="display:flex;align-items:center;gap:8px">
 <span style="font-size:.68rem;color:var(--text3)" id="lb-tog-label">${safeParse('ss_lb_opt_'+(user?.email||''), false) ? 'Showing my rank' : 'Hidden'}</span>
 <div class="notif-tog${safeParse('ss_lb_opt_'+(user?.email||''), false) ? ' on' : ''}" id="lb-opt-tog" onclick="toggleLeaderboardOpt()" title="Show/hide my portfolio on the leaderboard"></div>
 </div>
 </div>
 <div id="leaderboardList" style="padding:.25rem 0">
 <div style="text-align:center;padding:1.5rem;color:var(--text3);font-size:.78rem">Loading rankings...</div>
 </div>
 </div>`;

 // Load leaderboard async after render
 setTimeout(loadLeaderboard, 50);
}

function showPtInsight() {
 const el = document.getElementById('pt-insight-result');
 if (!el) return;
 const pt = getPtPortfolio();
 const entries = Object.entries(pt.holdings);
 if (!entries.length) { el.style.display='block'; el.textContent='No holdings yet. Place some trades first to get a rebalancing suggestion.'; return; }
 const SECTOR_MAP = {
 AAPL:'Tech',MSFT:'Tech',GOOGL:'Tech',META:'Tech',NVDA:'Tech',AMZN:'Tech',
 AMD:'Tech',INTC:'Tech',CRM:'Tech',ADBE:'Tech',TSLA:'Tech',NFLX:'Tech',
 JPM:'Finance',GS:'Finance',BAC:'Finance',WFC:'Finance',MS:'Finance',V:'Finance',MA:'Finance',
 XOM:'Energy',CVX:'Energy',COP:'Energy',BP:'Energy',
 JNJ:'Healthcare',PFE:'Healthcare',MRK:'Healthcare',ABBV:'Healthcare',UNH:'Healthcare',
 WMT:'Consumer',COST:'Consumer',MCD:'Consumer',KO:'Consumer',PG:'Consumer',
 BTC:'Crypto',ETH:'Crypto',SOL:'Crypto',BNB:'Crypto',DOGE:'Crypto',
 };
 const sectorTotals = {};
 let totalVal = 0;
 entries.forEach(([t, h]) => {
 const shares = typeof h === 'object' ? h.shares : h;
 const val = shares * ptDailyPrice(t);
 const sector = SECTOR_MAP[t] || ASSET_DATA[t]?.[2] || 'Other';
 sectorTotals[sector] = (sectorTotals[sector] || 0) + val;
 totalVal += val;
 });
 if (!totalVal) { el.style.display='block'; el.textContent='Add some holdings to see an insight.'; return; }
 const sorted = Object.entries(sectorTotals).sort((a,b)=>b[1]-a[1]);
 const topSector = sorted[0][0];
 const topPct = (sorted[0][1]/totalVal*100).toFixed(0);
 const allSectors = ['Tech','Finance','Energy','Healthcare','Consumer','Crypto','Other'];
 const missing = allSectors.filter(s => !sectorTotals[s]);
 const suggest = missing.length ? missing[0] : sorted[sorted.length-1][0];
 el.style.display = 'block';
 el.innerHTML = `<strong style="color:var(--accent2)">Your portfolio is ${topPct}% in ${topSector}.</strong> ${topPct > 40 ? `That's a high concentration — consider diversifying into <strong style="color:var(--green)">${suggest}</strong> to reduce sector risk.` : `Good diversification overall! Adding exposure to <strong style="color:var(--green)">${suggest}</strong> could further reduce concentration risk.`}`;
}

/* ════════════════════════════════
 PAGE TRANSITIONS + SKELETON SCREENS
════════════════════════════════ */
// Bumped on every tab switch so a render queued for an old view never draws over a new one
let _viewSeq = 0;
function fadeMainContent(renderFn) {
 const mc = document.getElementById('mainContent');
 if (!mc) { renderFn(); return; }
 const seq = _viewSeq;
 // Exit phase
 mc.classList.add('page-exit');
 setTimeout(() => {
 if (seq !== _viewSeq) { mc.classList.remove('page-exit'); return; }
 renderFn();
 mc.classList.remove('page-exit');
 mc.classList.remove('page-enter');
 // Force reflow so animation restarts cleanly
 void mc.offsetWidth;
 mc.classList.add('page-enter');
 setTimeout(() => { mc.classList.remove('page-enter'); mc.style.willChange = 'auto'; }, 400);
 }, 140);
}

function showHomeSkeleton() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 mc.innerHTML = `
 <div class="skel-card">
 <div class="skel skel-title"></div>
 <div style="height:320px" class="skel skel-block"></div>
 </div>
 <div class="skel-card">
 <div class="skel skel-title"></div>
 <div style="height:500px" class="skel skel-block"></div>
 </div>`;
}

function showWatchlistSkeleton() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 mc.innerHTML = `
 <div class="skel skel-line" style="width:120px;height:14px;margin-bottom:1rem"></div>
 <div class="skel-wl-grid">
 ${Array(6).fill(0).map(()=>`
 <div class="skel-wl-card">
 <div class="skel skel-line" style="width:60px;height:18px;margin-bottom:8px"></div>
 <div class="skel skel-line" style="width:110px;height:11px;margin-bottom:12px"></div>
 <div class="skel skel-block" style="height:120px;margin-bottom:10px"></div>
 <div class="skel skel-block" style="height:32px"></div>
 </div>`).join('')}
 </div>`;
}

function showPortfolioSkeleton() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 mc.innerHTML = `
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin-bottom:1.25rem">
 ${Array(4).fill(0).map(()=>`<div class="skel-card" style="margin:0;height:80px"><div class="skel skel-line" style="width:60%;height:10px;margin-bottom:10px"></div><div class="skel skel-block" style="height:28px;width:70%"></div></div>`).join('')}
 </div>
 <div class="skel-card" style="margin-bottom:1rem">
 <div class="skel skel-title"></div>
 ${Array(4).fill(0).map(()=>`<div class="skel-port-row"><div class="skel skel-line" style="width:50px;height:14px"></div><div style="flex:1"></div><div class="skel skel-line" style="width:70px;height:14px"></div></div>`).join('')}
 </div>
 <div class="skel-card" style="height:200px"><div class="skel skel-title"></div><div class="skel skel-block" style="height:140px"></div></div>`;
}

function showAssetSkeleton() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 mc.innerHTML = `
 <div class="skel-card" style="padding:1.75rem;margin-bottom:2rem">
 <div style="display:flex;gap:1rem;align-items:center">
 <div><div class="skel skel-block" style="width:120px;height:36px"></div><div class="skel skel-line" style="width:180px;margin-top:8px"></div></div>
 <div style="margin-left:auto"><div class="skel skel-block" style="width:100px;height:48px"></div></div>
 </div>
 </div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem">
 <div class="skel-card" style="height:300px"><div class="skel skel-title"></div><div class="skel skel-block" style="height:220px"></div></div>
 <div class="skel-card" style="height:300px"><div class="skel skel-title"></div><div class="skel skel-block" style="height:220px"></div></div>
 </div>
 <div class="skel-card" style="height:520px"><div class="skel skel-title"></div><div class="skel skel-block" style="height:440px"></div></div>`;
}

/* ════════════════════════════════
 ANALYST PRICE TARGETS
════════════════════════════════ */
/* ════════════════════════════════
 ELI5 EARNINGS SUMMARIES
════════════════════════════════ */
const EARNINGS_SUMMARIES = {
 AAPL:{ quarter:'Q2 FY2025', date:'May 1, 2025', beat:true, revenue:'$95.4B', eps:'$1.65',
  headline:'Apple beat expectations, driven by strong iPhone 16 sales and a record Services quarter.',
  bullets:['Made $95.4 billion in revenue — more than Wall Street expected','iPhone 16 sold well globally, especially in India and China','The App Store, iCloud, and Apple TV+ together hit a record $26.6B','CEO Tim Cook said Apple Intelligence (their AI features) is driving people to upgrade their phones'],
  bottomLine:'A steady, profitable quarter. Nothing explosive, but Apple keeps printing money.' },
 MSFT:{ quarter:'Q3 FY2025', date:'Apr 30, 2025', beat:true, revenue:'$70.1B', eps:'$3.46',
  headline:'Microsoft crushed it — mostly because companies are spending big on their AI cloud.',
  bullets:['Made $70.1B in revenue, beating expectations comfortably','Azure (their cloud) grew 33% — AI tools like Copilot are driving the demand','Office 365 subscriptions keep growing as businesses add AI features','CEO Satya Nadella said every customer they talk to is asking about AI infrastructure'],
  bottomLine:'If you believe AI is the future, Microsoft is right in the middle of it.' },
 GOOGL:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:true, revenue:'$90.2B', eps:'$2.81',
  headline:'Google had a great quarter — advertising is booming and their cloud is accelerating.',
  bullets:['Made $90.2B in revenue — beat expectations by a solid margin','Google Search ad revenue grew 10% as businesses spent more on digital ads','Google Cloud grew 28%, competing hard with Amazon and Microsoft','YouTube ad revenue hit $8.9B — people are watching more video than ever'],
  bottomLine:'Google is still the king of ads, and their cloud business is catching up fast.' },
 AMZN:{ quarter:'Q1 2025', date:'May 1, 2025', beat:true, revenue:'$155.7B', eps:'$1.59',
  headline:'Amazon had a massive quarter — their cloud and advertising businesses are on fire.',
  bullets:['Made $155.7B in total revenue — way more than expected','AWS (Amazon Web Services, their cloud) grew 17% and is wildly profitable','Advertising revenue hit $13.9B — sellers pay Amazon to show their products','CEO Andy Jassy said AI infrastructure spending will only accelerate from here'],
  bottomLine:'Amazon is no longer just a store. Cloud and ads are where the real money is.' },
 META:{ quarter:'Q1 2025', date:'Apr 30, 2025', beat:true, revenue:'$42.3B', eps:'$6.43',
  headline:'Meta had a record quarter — their AI ad tools are making advertisers spend more.',
  bullets:['Made $42.3B in revenue, well above what analysts expected','AI-powered ad targeting is working — advertisers are seeing better results and spending more','Daily active users across Facebook, Instagram, and WhatsApp hit 3.43 billion','CEO Zuckerberg said they\'re investing heavily in AI infrastructure — $60-65B this year'],
  bottomLine:'Meta turned things around completely. Ads are booming and the metaverse stuff is a side note now.' },
 NVDA:{ quarter:'Q1 FY2026', date:'May 28, 2025', beat:true, revenue:'$44.1B', eps:'$0.96',
  headline:'NVIDIA absolutely smashed expectations — AI demand for their chips keeps going up.',
  bullets:['Made $44.1B in revenue — almost doubled compared to a year ago','Their data center chips (H100, B100) are what every AI company wants and can\'t get enough of','Gross margins are extremely high at ~75% — each chip sold is extremely profitable','CEO Jensen Huang said demand for Blackwell AI chips exceeds supply right now'],
  bottomLine:'NVIDIA prints money because the entire world is racing to build AI and needs their chips to do it.' },
 TSLA:{ quarter:'Q1 2025', date:'Apr 22, 2025', beat:false, revenue:'$19.3B', eps:'$0.27',
  headline:'Tesla missed expectations — deliveries dropped and profits got squeezed.',
  bullets:['Made $19.3B in revenue — below what analysts expected','Delivered 336,681 cars in Q1, down 13% from the same time last year','Profit margins fell as Tesla cut prices to compete with cheaper Chinese EVs','CEO Elon Musk mentioned Full Self-Driving and a cheaper model coming, but gave no firm dates'],
  bottomLine:'A rough quarter. Tesla is in a tough spot with rising competition and Musk\'s attention split across multiple companies.' },
 NFLX:{ quarter:'Q1 2025', date:'Apr 15, 2025', beat:true, revenue:'$10.5B', eps:'$6.61',
  headline:'Netflix had a strong quarter — more subscribers and higher revenue per user.',
  bullets:['Made $10.5B in revenue, above expectations','Added 4.6 million new subscribers — the password-sharing crackdown keeps driving sign-ups','The cheaper, ad-supported plan now has 55M+ subscribers worldwide','They announced a price hike in several countries — users stayed anyway'],
  bottomLine:'Netflix figured out how to grow again. Ads + cracking down on password sharing was the right move.' },
 AMD:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:true, revenue:'$7.4B', eps:'$0.96',
  headline:'AMD beat expectations — their AI chips are gaining serious traction against NVIDIA.',
  bullets:['Made $7.4B in revenue, above what analysts expected','Data center revenue hit $3.7B as big tech companies buy their MI300X AI chips','Their consumer laptop chips (Ryzen) continued to gain market share vs Intel','CEO Lisa Su said demand for AI accelerators is growing faster than anyone predicted'],
  bottomLine:'AMD is the main challenger to NVIDIA in AI chips. Still a distant #2, but gaining ground.' },
 INTC:{ quarter:'Q1 2025', date:'Apr 24, 2025', beat:false, revenue:'$12.7B', eps:'-$0.19',
  headline:'Intel lost money again — their turnaround is taking longer than expected.',
  bullets:['Made $12.7B in revenue — roughly in line with low expectations','Lost money on a per-share basis as their chip factories burn cash','Their foundry business (making chips for others) is still deeply unprofitable','New CEO Lip-Bu Tan is restructuring the company, but it will take years'],
  bottomLine:'Intel is in a difficult rebuilding phase. They missed the AI wave and are paying for it.' },
 META:{ quarter:'Q1 2025', date:'Apr 30, 2025', beat:true, revenue:'$42.3B', eps:'$6.43',
  headline:'Meta had a record quarter driven by AI-powered advertising.',
  bullets:['Revenue of $42.3B crushed Wall Street expectations','AI ad tools are delivering better results for advertisers — they\'re spending more','3.43 billion people use Facebook, Instagram or WhatsApp daily','Zuckerberg plans to spend $60-65B on AI infrastructure in 2025 alone'],
  bottomLine:'Meta is back. Ads are booming and AI investments are paying off.' },
 JPM:{ quarter:'Q1 2025', date:'Apr 11, 2025', beat:true, revenue:'$46.0B', eps:'$5.07',
  headline:'JPMorgan had a strong quarter — higher interest rates mean they make more on loans.',
  bullets:['Made $46.0B in net revenue, ahead of expectations','Net interest income (what they earn on loans) remained strong despite rate uncertainty','Investment banking fees surged as more companies did deals','CEO Jamie Dimon warned about global economic uncertainty but called the consumer "resilient"'],
  bottomLine:'When rates are high, banks make money. JPMorgan is the strongest bank in the US.' },
 BAC:{ quarter:'Q1 2025', date:'Apr 15, 2025', beat:true, revenue:'$27.4B', eps:'$0.90',
  headline:'Bank of America beat expectations — consumer spending stayed healthy.',
  bullets:['Made $27.4B in revenue, above estimates','Net interest income grew as they benefit from higher interest rates','Consumer banking deposits are stable — customers kept their money in','CEO Brian Moynihan said the US economy is holding up better than feared'],
  bottomLine:'Solid quarter. Big banks are benefiting from the higher interest rate environment.' },
 WMT:{ quarter:'Q1 FY2026', date:'May 15, 2025', beat:true, revenue:'$165.6B', eps:'$0.61',
  headline:'Walmart crushed it — people are shopping more and their ad business is booming.',
  bullets:['Made $165.6B in revenue, beating expectations','US comparable store sales grew 4.6% — people are buying more groceries and everyday items','Walmart\'s advertising business (showing ads to shoppers) grew 50% — it\'s now a big profit driver','E-commerce grew 22% as more people order groceries and goods for delivery'],
  bottomLine:'Walmart is firing on all cylinders. They\'re not just a store anymore — they\'re an ad and delivery business too.' },
 DIS:{ quarter:'Q2 FY2025', date:'May 7, 2025', beat:true, revenue:'$23.6B', eps:'$1.45',
  headline:'Disney beat expectations — streaming finally turned profitable.',
  bullets:['Made $23.6B in revenue, above estimates','Disney+ streaming turned a profit for the first time — a huge milestone','Theme parks revenue stayed strong despite higher ticket prices','CEO Bob Iger said they\'re focused on making streaming the core of the company'],
  bottomLine:'Disney is figuring out streaming profitability. Parks keep printing money too.' },
 UBER:{ quarter:'Q1 2025', date:'May 7, 2025', beat:true, revenue:'$11.5B', eps:'$0.83',
  headline:'Uber had a great quarter — more rides, more deliveries, more money.',
  bullets:['Made $11.5B in revenue, beating expectations','Gross bookings hit $42.8B — a record for the company','Rides and Uber Eats both grew double-digits globally','CEO Dara Khosrowshahi said autonomous vehicles are an opportunity, not a threat'],
  bottomLine:'Uber is solidly profitable now and growing fast. The ride-sharing wars are basically over — Uber won.' },
 COIN:{ quarter:'Q1 2025', date:'May 8, 2025', beat:true, revenue:'$2.0B', eps:'$1.94',
  headline:'Coinbase had a great quarter as crypto prices surged and trading picked up.',
  bullets:['Made $2.0B in revenue — way above what analysts expected','Transaction revenue jumped as Bitcoin and other cryptos saw big price moves','Subscription revenue (staking, custody fees) provides more stable income','CEO Brian Armstrong said regulatory clarity in the US is finally improving'],
  bottomLine:'When crypto is hot, Coinbase makes money. This was a very good crypto environment quarter.' },
 PLTR:{ quarter:'Q1 2025', date:'May 5, 2025', beat:true, revenue:'$884M', eps:'$0.13',
  headline:'Palantir crushed it — US government and commercial AI deals are accelerating.',
  bullets:['Made $884M in revenue, well above expectations','US commercial revenue grew 71% — companies are buying their AI software','US government revenue grew 45% — defense and intelligence agencies spending more','CEO Alex Karp said Palantir is the only company doing what they do at scale'],
  bottomLine:'Palantir is expensive but growing fast. Government AI contracts are a huge advantage.' },
 SNAP:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:false, revenue:'$1.36B', eps:'-$0.08',
  headline:'Snap struggled — ad revenue growth slowed and they\'re still losing money.',
  bullets:['Made $1.36B in revenue — roughly in line but still growing slowly','Daily active users grew to 460M, but growth is slowing in key markets','Still not consistently profitable despite years of trying','Competition from Instagram Reels and TikTok keeps squeezing them'],
  bottomLine:'Snap is in a tough spot. They\'re caught between TikTok and Instagram with no clear advantage.' },
 RBLX:{ quarter:'Q1 2025', date:'May 7, 2025', beat:true, revenue:'$1.0B', eps:'-$0.28',
  headline:'Roblox grew users and revenue, but is still burning cash.',
  bullets:['Made $1.0B in revenue for the first time ever — a big milestone','Daily active users hit 97.8M — mostly kids and teens playing games','Bookings (what people spend in the game) grew 16%','Still losing money as they invest heavily in the platform'],
  bottomLine:'Roblox is growing but not yet profitable. Long-term bet on kids staying on the platform.' },
 CRM:{ quarter:'Q1 FY2026', date:'May 28, 2025', beat:true, revenue:'$9.8B', eps:'$2.58',
  headline:'Salesforce beat expectations — their AI product Agentforce is gaining traction.',
  bullets:['Made $9.8B in revenue, above estimates','Agentforce (their AI agent product) signed 5,000+ customers already','Subscription revenue grew steadily as businesses keep using their CRM software','CEO Marc Benioff called Agentforce a "breakthrough" and the next chapter of AI'],
  bottomLine:'Salesforce is betting big on AI agents. Early results are encouraging.' },
 SPOT:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:true, revenue:'€4.19B', eps:'€2.52',
  headline:'Spotify had a great quarter — more listeners, higher prices, better profits.',
  bullets:['Made €4.19B in revenue, beating expectations','Monthly active users hit 678M — still growing despite price hikes','Premium subscribers hit 268M — people are willing to pay more for music','Profit margins improved significantly as they raised prices and cut costs'],
  bottomLine:'Spotify\'s strategy is working. Higher prices plus more users equals much better profits.' },
 SHOP:{ quarter:'Q1 2025', date:'May 8, 2025', beat:true, revenue:'$2.36B', eps:'$0.31',
  headline:'Shopify had a strong quarter — small businesses keep using their platform to sell online.',
  bullets:['Made $2.36B in revenue, above expectations','Gross Merchandise Volume (total sales through Shopify) grew 23% to $74.8B','More merchants signed up as they expanded internationally','CEO Tobi Lütke said they\'re focused on making Shopify the default for commerce everywhere'],
  bottomLine:'Shopify is the backbone of e-commerce for millions of small businesses. Steady and growing.' },
 V:{ quarter:'Q2 FY2025', date:'Apr 22, 2025', beat:true, revenue:'$9.6B', eps:'$2.76',
  headline:'Visa had a solid quarter — people kept swiping their cards around the world.',
  bullets:['Made $9.6B in revenue, above estimates','Payments volume grew 8% as consumer spending stayed healthy','Cross-border travel payments surged — people are still traveling a lot','CEO Ryan McInerney said the global shift from cash to card payments is still early'],
  bottomLine:'Visa makes money every time someone swipes a card. Consumer spending held up, so they did too.' },
 MA:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:true, revenue:'$7.3B', eps:'$3.73',
  headline:'Mastercard had a strong quarter — same story as Visa, spending stayed healthy.',
  bullets:['Made $7.3B in revenue, beating expectations','Switched volume (cards processed) grew 12% globally','Services revenue (fraud tools, data, analytics) growing faster than core payments','Cross-border volume up 15% — international travel and shopping remains strong'],
  bottomLine:'Mastercard and Visa are essentially duopolies. As long as people spend money, they make money.' },
 ORCL:{ quarter:'Q3 FY2025', date:'Mar 11, 2025', beat:true, revenue:'$14.1B', eps:'$1.47',
  headline:'Oracle had a great quarter — AI cloud demand is fueling their best growth in years.',
  bullets:['Made $14.1B in revenue, comfortably beating estimates','Cloud infrastructure (OCI) grew 49% — companies use it to train AI models','CEO Larry Ellison said demand for their AI cloud is "staggering"','Remaining performance obligations (future contracts signed) hit $130B — a massive backlog'],
  bottomLine:'Oracle used to be boring. Now they\'re an AI infrastructure company growing faster than ever.' },
 PYPL:{ quarter:'Q1 2025', date:'Apr 29, 2025', beat:true, revenue:'$7.9B', eps:'$1.33',
  headline:'PayPal beat expectations — their new CEO is cutting costs and improving margins.',
  bullets:['Made $7.9B in revenue, above estimates','Total payment volume grew 4% to $417B','Profit margins improved significantly as they cut costs and focused on profitability','CEO Alex Chriss said they\'re focused on "profitable growth" over chasing user numbers'],
  bottomLine:'PayPal is in a turnaround phase. Less about growth, more about being efficient and profitable.' },
 HOOD:{ quarter:'Q1 2025', date:'Apr 30, 2025', beat:true, revenue:'$927M', eps:'$0.37',
  headline:'Robinhood had a massive quarter — crypto trading went crazy and customers spent more.',
  bullets:['Made $927M in revenue — way above expectations, nearly doubled year-over-year','Crypto trading revenue surged as Bitcoin hit new highs','Gold subscribers (paid tier) grew to 3M+ customers','CEO Vlad Tenev said they\'re expanding into banking and retirement accounts'],
  bottomLine:'When markets are hot and crypto is up, Robinhood makes a lot of money. High risk, high reward type of company.' },
 RIVN:{ quarter:'Q1 2025', date:'May 6, 2025', beat:false, revenue:'$1.24B', eps:'-$0.48',
  headline:'Rivian is still losing money but production is ramping up.',
  bullets:['Made $1.24B in revenue — roughly in line with estimates','Produced 14,611 vehicles in Q1 — still small but growing','Partnership with Volkswagen brought in important cash and technology','CEO RJ Scaringe said their cheaper R2 SUV is still on track for 2026'],
  bottomLine:'Rivian is a bet on the future. They\'re burning cash now but if the R2 succeeds, it could be a big deal.' },
};




function quickTargetsHTML(ticker, price) {
 if (!price) return '';
 const fmt = v => v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
 return `<div class="asset-quick"><span>Quick targets from $${fmt(price)}</span>${[[-10,'-10%'],[5,'+5%'],[10,'+10%'],[20,'+20%'],[50,'+50%']].map(([pct,label]) => {
  const target = fmt(price * (1 + pct / 100));
  return `<button type="button" onclick="document.getElementById('alertInp_${ticker}').value='${target}'">${label}<small>$${target}</small></button>`;
 }).join('')}</div>`;
}



/* ════════════════════════════════
 ACHIEVEMENT BADGES
════════════════════════════════ */
const BADGES = [
 // ── GETTING STARTED ──
 { id:'first_login', icon:'🚀', name:'First Launch', desc:'Logged in for the first time', check: () => true },
 { id:'first_search', icon:'🔍', name:'Explorer', desc:'Searched for your first stock', check: () => searchHistory.length > 0 },
 { id:'first_watch', icon:'⭐', name:'Watchlister', desc:'Added your first stock to your watchlist', check: () => watchlist.length > 0 },
 { id:'first_holding', icon:'💼', name:'Investor', desc:'Added your first portfolio holding', check: () => holdings.length > 0 },
 { id:'first_paper', icon:'🎮', name:'Paper Trader', desc:'Placed your first paper trade', check: () => Object.keys(getPtPortfolio().holdings).length > 0 },
 { id:'first_vote', icon:'🗳️', name:'Voter', desc:'Voted on your first community stock poll', check: () => { try{return Object.keys(safeParse('ss_votes_'+(user?.email||''),{})).length > 0;}catch{return false;} } },
 { id:'onboarded', icon:'🎓', name:'Graduate', desc:'Completed the onboarding questionnaire', check: () => !!localStorage.getItem('ss_onboarding_'+(user?.email||'')) },
 { id:'tutorial_done', icon:'📚', name:'Trained', desc:'Completed the interactive tutorial', check: () => !!localStorage.getItem('ss_tutorial_done_'+(user?.email||'')) },
 { id:'broker_set', icon:'🔗', name:'Connected', desc:'Linked a preferred broker to your account', check: () => !!localStorage.getItem('ss_broker_'+(user?.email||'')) },
 // ── STREAKS ──
 { id:'streak_3', icon:'🔥', name:'On Fire', desc:'3-day visit streak', check: () => { try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=3;}catch{return false;} } },
 { id:'streak_7', icon:'💥', name:'Week Warrior', desc:'7-day visit streak', check: () => { try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=7;}catch{return false;} } },
 { id:'streak_14', icon:'⚡', name:'Fortnight', desc:'14-day visit streak', check: () => { try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=14;}catch{return false;} } },
 { id:'streak_30', icon:'🏆', name:'Legend', desc:'30-day visit streak', check: () => { try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=30;}catch{return false;} } },
 { id:'streak_100', icon:'👑', name:'Unstoppable', desc:'100-day visit streak', check: () => { try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=100;}catch{return false;} } },
 // ── SEARCHING ──
 { id:'five_searches', icon:'📊', name:'Market Nerd', desc:'Searched 5+ different stocks', check: () => { try{return Object.keys(safeParse('ss_trending',{})).length >= 5;}catch{return false;} } },
 { id:'twenty_searches', icon:'🧠', name:'Research Machine', desc:'Searched 20+ different stocks', check: () => { try{return Object.keys(safeParse('ss_trending',{})).length >= 20;}catch{return false;} } },
 { id:'fifty_searches', icon:'🔭', name:'Wall Street Nerd', desc:'Searched 50+ different stocks', check: () => { try{return Object.keys(safeParse('ss_trending',{})).length >= 50;}catch{return false;} } },
 // ── WATCHLIST ──
 { id:'five_watchlist', icon:'📋', name:'Collector', desc:'Added 5+ stocks to your watchlist', check: () => watchlist.length >= 5 },
 { id:'ten_watchlist', icon:'🗂️', name:'Curator', desc:'Added 10+ stocks to your watchlist', check: () => watchlist.length >= 10 },
 // ── PORTFOLIO ──
 { id:'five_holdings', icon:'💎', name:'Diversified', desc:'Tracking 5+ portfolio holdings', check: () => holdings.length >= 5 },
 { id:'ten_holdings', icon:'🏦', name:'Fund Manager', desc:'Tracking 10+ portfolio holdings', check: () => holdings.length >= 10 },
 // ── PAPER TRADING ──
 { id:'paper_profit', icon:'📈', name:'In the Green', desc:'Paper portfolio value above $10,000', check: () => ptAccountValue() > 10050 },
 { id:'paper_big', icon:'💰', name:'Paper Millionaire', desc:'Paper portfolio value above $15,000', check: () => ptAccountValue() > 15000 },
 { id:'paper_five_pos', icon:'🎯', name:'Active Trader', desc:'Held 5+ different paper positions at once', check: () => Object.keys(getPtPortfolio().holdings).length >= 5 },
 // ── VOTING ──
 { id:'five_votes', icon:'🗣️', name:'Pundit', desc:'Voted on 5+ stock polls', check: () => { try{return Object.keys(safeParse('ss_votes_'+(user?.email||''),{})).length >= 5;}catch{return false;} } },
 { id:'ten_votes', icon:'📣', name:'Community Voice', desc:'Voted on 10+ stock polls', check: () => { try{return Object.keys(safeParse('ss_votes_'+(user?.email||''),{})).length >= 10;}catch{return false;} } },
 // ── DISCOVERY ──
 { id:'screener_used', icon:'🔎', name:'Screener Pro', desc:'Used the stock screener', check: () => !!localStorage.getItem('ss_screener_used_'+(user?.email||'')) },
 { id:'compare_used', icon:'⚖️', name:'Analyst', desc:'Compared two stocks side by side', check: () => !!localStorage.getItem('ss_compare_used_'+(user?.email||'')) },
 { id:'prediction_used', icon:'🔮', name:'Oracle', desc:'Checked the AI price prediction tab', check: () => !!localStorage.getItem('ss_prediction_used_'+(user?.email||'')) },
 { id:'custom_home', icon:'📌', name:'Homemaker', desc:'Pinned stocks to your custom homepage', check: () => getPinnedStocks().length > 0 },
 { id:'digest_sub', icon:'📬', name:'Subscriber', desc:'Subscribed to the weekly digest email', check: () => !!localStorage.getItem('ss_digest_'+(user?.email||'')) },
 // ── MARKETS ──
 { id:'crypto_search', icon:'₿', name:'Crypto Curious', desc:'Searched for your first cryptocurrency', check: () => searchHistory.some(h=>h.k==='c') },
 { id:'index_search', icon:'📉', name:'Index Watcher', desc:'Looked up your first market index', check: () => searchHistory.some(h=>h.k==='i') },
 { id:'dark_mode', icon:'🌙', name:'Night Owl', desc:'Picked a theme on purpose', check: () => !!themeChoice },
 { id:'after_hours', icon:'🌃', name:'After Hours', desc:'Used StockSight outside market hours (before 9am or after 4pm)', check: () => { const h=new Date().getHours(); return h<9||h>=16; } },
 { id:'early_bird', icon:'🌅', name:'Early Bird', desc:'Used StockSight before 8am', check: () => new Date().getHours() < 8 },
 { id:'night_trader', icon:'🦉', name:'Night Trader', desc:'Used StockSight after midnight', check: () => new Date().getHours() < 4 },
 { id:'weekend_warrior', icon:'📅', name:'Weekend Warrior', desc:'Checked stocks on the weekend', check: () => [0,6].includes(new Date().getDay()) },
 { id:'lesson_first', icon:'📘', name:'Student', desc:'Finished your first lesson', check: () => Object.values(getLearn().lessons).some(l => l.read) },
 { id:'quiz_ace', icon:'🎯', name:'Sharp Shooter', desc:'Got every answer right on a lesson quiz', check: () => Object.values(getLearn().lessons).some(l => l.best === 3) },
 { id:'level_3', icon:'⭐', name:'Rising Analyst', desc:'Reached learning Level 3', check: () => learnLevel(getLearn().xp).n >= 3 },
 { id:'lessons_all', icon:'🏅', name:'Scholar', desc:'Finished every lesson and quiz', check: () => LEARN_LIB.full && allLessonIds().every(lessonDone) },
 { id:'lessons_10', icon:'📚', name:'Bookworm', desc:'Finished 10 lessons and their quizzes', check: () => Object.values(getLearn().lessons).filter(l => l.read && l.best != null).length >= 10 },
 { id:'track_done', icon:'🧭', name:'Track Star', desc:'Finished every lesson in a track', check: () => LEARN_LIB.tracks.some(t => t.lessons.length && t.lessons.every(lessonDone)) },
 { id:'daily_first', icon:'⚡', name:'Daily Brain', desc:'Finished a daily challenge', check: () => !!getLearn().dlast },
 { id:'learn_streak_7', icon:'🔥', name:'On a Roll', desc:'Did the daily challenge 7 days in a row', check: () => getLearn().dstreak >= 7 },
 { id:'stock_study', icon:'🔍', name:'Stock Detective', desc:'Finished a real-stock lesson', check: () => Object.values(getLearn().stocks).some(v => v.best != null) },
 { id:'league_join', icon:'🤝', name:'Team Player', desc:'Started or joined a league with friends', check: () => (safeParse('ss_lg_'+(user?.email||''), {}).n || 0) > 0 },
 { id:'league_champ', icon:'🏆', name:'Champion', desc:'Won a week in one of your leagues', check: () => (safeParse('ss_lg_'+(user?.email||''), {}).wins || 0) > 0 },
 { id:'checklist_done', icon:'✅', name:'Ready to Go', desc:'Completed the getting started checklist', check: () => isChecklistComplete() },
 // ── SECRET ──
 { id:'secret_1', icon:'🎰', name:'Lucky Dip', desc:'You found it! Searched for a stock that doesn\'t exist — curiosity rewarded.',
 check: () => !!localStorage.getItem('ss_secret1_'+(user?.email||'')), secret: true },
 { id:'secret_2', icon:'🕰️', name:'Time Traveler', desc:'You found it! Visited StockSight at exactly midnight.',
 check: () => { const n=new Date(); return n.getHours()===0 && n.getMinutes()===0; }, secret: true },
];

function ptAccountValue() {
 try {
  const pt = getPtPortfolio();
  return (Number(pt.cash) || 0) + Object.entries(pt.holdings || {}).reduce((sum, [t, h]) => sum + (typeof h === 'object' && h ? Number(h.shares) || 0 : Number(h) || 0) * ptDailyPrice(t), 0);
 } catch { return 0; }
}

function getEarnedBadges() {
 try { return JSON.parse(localStorage.getItem('ss_badges_'+(user?.email||''))||'[]'); } catch { return []; }
}

function checkAndAwardBadges(silent=false) {
 if (!user) return [];
 const earned = new Set(getEarnedBadges());
 const newlyEarned = [];
 BADGES.forEach(b => {
 if (!earned.has(b.id)) {
 try { if (b.check()) { earned.add(b.id); newlyEarned.push(b); } } catch {}
 }
 });
 if (newlyEarned.length) {
 localStorage.setItem('ss_badges_'+(user?.email||''), JSON.stringify([...earned]));
 if (!silent) {
 newlyEarned.forEach((b, i) => {
 setTimeout(() => toast(`Badge unlocked: ${b.icon} ${b.name}. ${b.desc}`, 'star', 4000), i * 1300);
 });
 }
 }
 return [...earned];
}

const BADGE_GROUPS = [
 ['Getting started', ['first_login','first_search','first_watch','first_holding','first_paper','first_vote','onboarded','tutorial_done','broker_set','checklist_done']],
 ['Learning', ['lesson_first','quiz_ace','level_3','lessons_10','track_done','lessons_all','daily_first','learn_streak_7','stock_study']],
 ['Streaks', ['streak_3','streak_7','streak_14','streak_30','streak_100']],
 ['Research', ['five_searches','twenty_searches','fifty_searches','crypto_search','index_search','screener_used','compare_used','prediction_used']],
 ['Portfolio and trading', ['five_watchlist','ten_watchlist','five_holdings','ten_holdings','paper_profit','paper_big','paper_five_pos','custom_home']],
 ['Community', ['five_votes','ten_votes','digest_sub','league_join','league_champ']],
 ['Just for fun', ['dark_mode','after_hours','early_bird','night_trader','weekend_warrior','secret_1','secret_2']],
];

function renderBadges(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 const earned = new Set(checkAndAwardBadges(true));
 const visible = BADGES.filter(b => !b.secret || earned.has(b.id));
 const earnedCount = BADGES.filter(b => earned.has(b.id)).length;
 const pct = Math.round(earnedCount / BADGES.length * 100);
 const next = BADGES.filter(b => !b.secret && !earned.has(b.id)).slice(0, 3);
 const s = getLearn();
 const lv = learnLevel(s.xp);
 const byId = Object.fromEntries(BADGES.map(b => [b.id, b]));
 const card = b => {
  const isEarned = earned.has(b.id);
  if (b.secret && !isEarned) return `<div class="ach-badge secret" title="A secret badge. Keep exploring."><span class="ach-ico">?</span><b>Secret</b><small>Discover it yourself</small></div>`;
  return `<div class="ach-badge ${isEarned ? 'earned' : 'locked'}" title="${escapeHTML(b.desc)}"><span class="ach-ico">${b.icon}</span><b>${b.name}</b><small>${b.desc}</small></div>`;
 };
 el.innerHTML = `
 <div class="ach-hero">
  <div class="ach-sum">
   <span class="lv-ring lv-ring-lg" style="--p:${pct}"><b>${earnedCount}</b></span>
   <div><h3>${earnedCount} of ${BADGES.length} badges</h3><p>${pct}% collected. ${visible.length < BADGES.length ? 'Some are secret.' : ''}</p></div>
  </div>
  <div class="ach-sum">
   <span class="lv-ring lv-ring-lg" style="--p:${lv.pct.toFixed(0)}"><b>${lv.n}</b></span>
   <div><h3>Level ${lv.n}: ${lv.name}</h3><p>${s.xp} learning XP. <button type="button" class="set-link" onclick="show('app');setTimeout(openLearnHub,200)">Open lessons</button></p></div>
  </div>
 </div>
 ${next.length ? `<div class="ach-next"><h4>Up next</h4><div>${next.map(b => `<div class="ach-next-item"><span class="ach-ico">${b.icon}</span><span><b>${b.name}</b><small>${b.desc}</small></span></div>`).join('')}</div></div>` : ''}
 ${(() => {
  const groups = BADGE_GROUPS.map(([title, ids]) => {
   const list = ids.map(id => byId[id]).filter(Boolean);
   return { title, list, got: list.filter(b => earned.has(b.id)).length };
  });
  const sel = Math.min(window._achGroup || 0, groups.length - 1);
  return `<div class="ach-tabs" role="tablist">${groups.map((g, i) => `<button type="button" role="tab" class="${i === sel ? 'on' : ''}" onclick="achGroup(${i})"><span>${g.title}</span><small>${g.got}/${g.list.length}</small></button>`).join('')}</div>
  <div class="ach-groups">${groups.map((g, i) => `<section class="ach-group${i === sel ? ' on' : ''}"><header><h4>${g.title}</h4><span>${g.got}/${g.list.length}</span></header><div class="ach-grid">${g.list.map(card).join('')}</div></section>`).join('')}</div>`;
 })()}`;
}

function achGroup(i) {
 window._achGroup = i;
 document.querySelectorAll('.ach-tabs button').forEach((b, j) => b.classList.toggle('on', j === i));
 document.querySelectorAll('.ach-groups .ach-group').forEach((g, j) => g.classList.toggle('on', j === i));
}

function renderProfileStats() {
 const el = document.getElementById('ovStats');
 if (!el || !user) return;
 const lv = learnLevel(getLearn().xp);
 const earned = getEarnedBadges().length;
 const streak = (safeParse('ss_streak_' + user.email, {}).streak) || 0;
 const value = ptAccountValue();
 el.innerHTML = [
  ['Learning level', `${lv.n}`, lv.name, "showP('rewards')"],
  ['Badges', `${earned}/${BADGES.length}`, 'Achievements', "showP('rewards')"],
  ['Day streak', `${streak}`, streak === 1 ? 'day' : 'days', ''],
  ['Paper account', railMoney(value), `${value >= 10000 ? '+' : ''}${((value - 10000) / 100).toFixed(1)}% all time`, "show('app');switchTab('pt')"],
 ].map(([label, val, sub, act]) => `<button type="button" class="set-stat" ${act ? `onclick="${act}"` : 'disabled'}><span>${label}</span><b>${val}</b><small>${sub}</small></button>`).join('');
}

// ── Investor Profile Quiz ─────────────────────────────────────────────────
const QUIZ_QUESTIONS = [
  {
    q: 'How would you react if your portfolio dropped 20% in a month?',
    opts: [
      { label: "I'd sell everything to stop the bleeding", score: 0 },
      { label: "I'd be worried but hold and wait", score: 1 },
      { label: "I'd see it as a buying opportunity", score: 2 },
    ]
  },
  {
    q: 'What is your main investing goal?',
    opts: [
      { label: 'Preserve what I have — safety first', score: 0 },
      { label: 'Steady growth over time', score: 1 },
      { label: 'Maximum growth, I can handle swings', score: 2 },
    ]
  },
  {
    q: 'How long do you plan to hold your investments?',
    opts: [
      { label: 'Less than 2 years', score: 0 },
      { label: '2–7 years', score: 1 },
      { label: '7+ years', score: 2 },
    ]
  },
  {
    q: 'Which would you choose?',
    opts: [
      { label: 'A guaranteed 4% return every year', score: 0 },
      { label: 'A likely 9% return with some risk', score: 1 },
      { label: 'A possible 20% return with high risk', score: 2 },
    ]
  },
  {
    q: 'How much investing experience do you have?',
    opts: [
      { label: "I'm just getting started", score: 0 },
      { label: "I've been investing for 1–3 years", score: 1 },
      { label: "I'm experienced and follow markets closely", score: 2 },
    ]
  },
];

const QUIZ_PROFILES = [
  {
    type: 'Conservative Investor',
    emoji: '🛡️',
    color: '#4d8fff',
    desc: 'You prioritize protecting your capital over high returns. You prefer stable, lower-risk investments like bonds, dividend stocks, and blue-chips. Slow and steady wins the race for you.',
  },
  {
    type: 'Moderate Investor',
    emoji: '⚖️',
    color: '#f59e0b',
    desc: "You're comfortable with some risk in exchange for better returns. You likely prefer a mix of growth stocks and stable assets, balancing opportunity with caution.",
  },
  {
    type: 'Aggressive Investor',
    emoji: '🚀',
    color: '#00c97a',
    desc: "You're in it for maximum growth and aren't afraid of volatility. You're drawn to high-growth stocks, emerging tech, and crypto — and you know the market rewards patience.",
  },
];

let _quizStep = 0;
let _quizAnswers = [];

function openQuizModal() {
  _quizStep = 0;
  _quizAnswers = [];
  document.getElementById('quizModal').style.display = 'flex';
  renderQuizStep();
}

function closeQuizModal() {
  document.getElementById('quizModal').style.display = 'none';
}

function renderQuizStep() {
  const q = QUIZ_QUESTIONS[_quizStep];
  const wrap = document.getElementById('quiz-q-wrap');
  const nextBtn = document.getElementById('quiz-next-btn');
  const backBtn = document.getElementById('quiz-back-btn');
  const bar = document.getElementById('quiz-progress-bar');
  const label = document.getElementById('quiz-progress-label');

  bar.style.width = (((_quizStep + 1) / QUIZ_QUESTIONS.length) * 100) + '%';
  label.textContent = (_quizStep + 1) + ' of ' + QUIZ_QUESTIONS.length;
  backBtn.style.display = _quizStep > 0 ? 'block' : 'none';
  nextBtn.textContent = _quizStep === QUIZ_QUESTIONS.length - 1 ? 'See my results ✓' : 'Next →';

  const selected = _quizAnswers[_quizStep];
  wrap.innerHTML = `
    <div style="font-size:.95rem;font-weight:700;font-family:'Geist',sans-serif;color:var(--text);line-height:1.45;margin-bottom:1rem">${q.q}</div>
    <div style="display:flex;flex-direction:column;gap:9px">
      ${q.opts.map((o, i) => `
        <button onclick="quizSelect(${i})" id="qopt-${i}" style="text-align:left;background:${selected===i?'var(--accent)':'var(--card2)'};border:1.5px solid ${selected===i?'var(--accent)':'var(--border2)'};color:${selected===i?'#fff':'var(--text)'};border-radius:12px;padding:13px 16px;font-family:inherit;font-size:.84rem;font-weight:600;cursor:pointer;transition:all .15s;line-height:1.4">
          <span style="display:inline-block;width:22px;height:22px;border-radius:50%;border:2px solid ${selected===i?'rgba(255,255,255,.5)':'var(--border2)'};margin-right:10px;vertical-align:middle;background:${selected===i?'rgba(255,255,255,.25)':'transparent'};flex-shrink:0"></span>
          ${o.label}
        </button>
      `).join('')}
    </div>
  `;

  const isAnswered = _quizAnswers[_quizStep] !== undefined;
  nextBtn.style.opacity = isAnswered ? '1' : '.4';
  nextBtn.style.pointerEvents = isAnswered ? 'auto' : 'none';
}

function quizSelect(i) {
  _quizAnswers[_quizStep] = i;
  renderQuizStep();
}

function quizNext() {
  if (_quizAnswers[_quizStep] === undefined) return;
  if (_quizStep < QUIZ_QUESTIONS.length - 1) {
    _quizStep++;
    renderQuizStep();
  } else {
    finishQuiz();
  }
}

function quizBack() {
  if (_quizStep > 0) { _quizStep--; renderQuizStep(); }
}

function finishQuiz() {
  const total = _quizAnswers.reduce((s, answerIdx, qi) => s + QUIZ_QUESTIONS[qi].opts[answerIdx].score, 0);
  const max = QUIZ_QUESTIONS.length * 2;
  const pct = total / max;
  const profileIdx = pct < 0.35 ? 0 : pct < 0.7 ? 1 : 2;
  const profile = QUIZ_PROFILES[profileIdx];

  // Save to user object and Supabase
  if (user) {
    user.investor_profile = profileIdx;
    localStorage.setItem('ss_investor_profile_' + user.email, profileIdx);
    usersTable().update({ investor_profile: profileIdx }).eq('email', user.email).then(()=>{});
  }

  closeQuizModal();
  renderQuizResult(profile);
}

function renderQuizResult(profile, silent) {
  // quiz section
  const banner = document.getElementById('quiz-result-banner');
  const empty = document.getElementById('quiz-empty-state');
  const typeEl = document.getElementById('quiz-result-type');
  const descEl = document.getElementById('quiz-result-desc');
  if (banner) {
    banner.style.background = profile.color + '14';
    banner.style.borderColor = profile.color + '44';
    typeEl.innerHTML = `<span style="color:${profile.color}">${profile.emoji} ${profile.type}</span>`;
    descEl.textContent = profile.desc;
    banner.style.display = 'block';
    empty.style.display = 'none';
  }
  // overview card
  const ovResult = document.getElementById('ov-quiz-result');
  const ovEmpty = document.getElementById('ov-quiz-empty');
  const ovType = document.getElementById('ov-quiz-type');
  const ovDesc = document.getElementById('ov-quiz-desc');
  if (ovResult) {
    ovType.innerHTML = `<span style="color:${profile.color}">${profile.emoji} ${profile.type}</span>`;
    ovDesc.textContent = profile.desc;
    ovResult.style.display = 'block';
    ovEmpty.style.display = 'none';
  }
  if (!silent) toast('Investor profile saved!', 'success');
}

function loadQuizResult() {
  if (!user) return;
  const saved = localStorage.getItem('ss_investor_profile_' + user.email);
  if (saved === null || saved === '') return;
  const profileIdx = parseInt(saved);
  if (isNaN(profileIdx) || profileIdx < 0 || profileIdx > 2) return;
  renderQuizResult(QUIZ_PROFILES[profileIdx], true);
}

// ── Risk Tolerance ──────────────────────────────────────────
// ── Risk Tolerance Cards ────────────────────────────────────
const RISK_OPTS = [
  {v:1, label:'Very Low',   icon:'🛡️', desc:'Bonds, cash, stable assets only',          color:'#4d8fff'},
  {v:2, label:'Low',        icon:'🔵', desc:'Mostly stable stocks and ETFs',             color:'#6c8fff'},
  {v:3, label:'Medium',     icon:'⚖️', desc:'Mix of growth and stable',                  color:'#f59e0b'},
  {v:4, label:'High',       icon:'📈', desc:'Growth stocks, some volatility ok',          color:'#ff8c00'},
  {v:5, label:'Very High',  icon:'🔥', desc:'Aggressive growth, crypto, options',         color:'#ff3860'},
];
function renderRiskOptions() {
  const el = document.getElementById('risk-options');
  if (!el) return;
  el.innerHTML = RISK_OPTS.map(o => `
    <button id="risk-opt-${o.v}" onclick="selectRisk(${o.v})"
      style="display:flex;align-items:center;gap:12px;background:var(--card2);border:1.5px solid var(--border2);border-radius:10px;padding:10px 14px;cursor:pointer;text-align:left;transition:all .15s;width:100%;font-family:inherit">
      <span style="font-size:1.2rem;flex-shrink:0">${o.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:.82rem;font-weight:700;color:var(--text);font-family:'Geist',sans-serif">${o.label}</div>
        <div style="font-size:.7rem;color:var(--text3);margin-top:1px">${o.desc}</div>
      </div>
    </button>`).join('');
}
function selectRisk(v) {
  RISK_OPTS.forEach(o => {
    const btn = document.getElementById('risk-opt-' + o.v);
    if (!btn) return;
    const active = o.v === v;
    btn.style.background = active ? o.color + '1a' : 'var(--card2)';
    btn.style.borderColor = active ? o.color : 'var(--border2)';
    btn.querySelector('div > div').style.color = active ? o.color : 'var(--text)';
  });
  if (!user) return;
  user.risk_tolerance = v;
  localStorage.setItem('ss_risk_' + user.email, v);
  usersTable().update({ risk_tolerance: v }).eq('email', user.email).then(()=>{});
  toast('Risk tolerance saved', 'success');
}
function loadRiskTolerance() {
  renderRiskOptions();
  if (!user) return;
  const saved = localStorage.getItem('ss_risk_' + user.email) || user.risk_tolerance;
  if (!saved) return;
  const v = parseInt(saved);
  if (isNaN(v)) return;
  user.risk_tolerance = v;
  setTimeout(() => selectRisk(v), 50);
}

// ── Investment Style Cards ──────────────────────────────────
const STYLE_OPTS = [
  {v:1, label:'Income Focus',    icon:'💰', desc:'Dividends, REITs, high-yield bonds',       color:'#00c97a'},
  {v:2, label:'Income + Growth', icon:'📊', desc:'Dividend growers and stable stocks',        color:'#00b4d8'},
  {v:3, label:'Balanced',        icon:'⚖️', desc:'Mix of income and growth assets',           color:'#6c5ce7'},
  {v:4, label:'Growth + Income', icon:'📈', desc:'Mostly growth with some dividends',         color:'#f59e0b'},
  {v:5, label:'Growth Focus',    icon:'🚀', desc:'High-growth stocks, reinvest everything',   color:'#ff3860'},
];
function renderStyleOptions() {
  const el = document.getElementById('style-options');
  if (!el) return;
  el.innerHTML = STYLE_OPTS.map(o => `
    <button id="style-opt-${o.v}" onclick="selectStyle(${o.v})"
      style="display:flex;align-items:center;gap:12px;background:var(--card2);border:1.5px solid var(--border2);border-radius:10px;padding:10px 14px;cursor:pointer;text-align:left;transition:all .15s;width:100%;font-family:inherit">
      <span style="font-size:1.2rem;flex-shrink:0">${o.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:.82rem;font-weight:700;color:var(--text);font-family:'Geist',sans-serif">${o.label}</div>
        <div style="font-size:.7rem;color:var(--text3);margin-top:1px">${o.desc}</div>
      </div>
    </button>`).join('');
}
function selectStyle(v) {
  STYLE_OPTS.forEach(o => {
    const btn = document.getElementById('style-opt-' + o.v);
    if (!btn) return;
    const active = o.v === v;
    btn.style.background = active ? o.color + '1a' : 'var(--card2)';
    btn.style.borderColor = active ? o.color : 'var(--border2)';
    btn.querySelector('div > div').style.color = active ? o.color : 'var(--text)';
  });
  if (!user) return;
  user.invest_style = v;
  localStorage.setItem('ss_divgrow_' + user.email, v);
  usersTable().update({ invest_style: v }).eq('email', user.email).then(()=>{});
  toast('Investment style saved', 'success');
}
function loadDivGrow() {
  renderStyleOptions();
  if (!user) return;
  const saved = localStorage.getItem('ss_divgrow_' + user.email) || user.invest_style;
  if (!saved) return;
  const v = parseInt(saved);
  if (isNaN(v)) return;
  user.invest_style = v;
  setTimeout(() => selectStyle(v), 50);
}

// ── Investment Goals ────────────────────────────────────────
const DEFAULT_GOALS = ['Retirement','Buy a house','Build long-term wealth','Generate passive income','Learn investing','Save for college'];

function renderGoalsList() {
  const el = document.getElementById('goals-list');
  if (!el) return;
  // Merge default goals with any custom ones stored
  let allGoals = [...DEFAULT_GOALS];
  try {
    const saved = localStorage.getItem('ss_goals_all_' + (user?.email||''));
    if (saved) {
      const parsed = JSON.parse(saved);
      parsed.forEach(g => { if (!allGoals.includes(g)) allGoals.push(g); });
    }
  } catch(e) {}

  el.innerHTML = allGoals.map(g => {
      return `<div style="display:flex;align-items:center;gap:8px">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:.82rem;color:var(--text);flex:1">
        <input type="checkbox" data-goal="${g}" onchange="saveGoals()" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0">
        ${g}
      </label>
      <button onclick="deleteGoal('${g.replace(/'/g,"\\'")}',this)" title="Remove" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:.8rem;padding:2px 6px;border-radius:4px;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">✕</button>
    </div>`;
  }).join('') + `
  <div style="display:flex;gap:8px;margin-top:6px">
    <input id="goal-custom-inp" type="text" placeholder="Add your own goal…" maxlength="48"
      style="flex:1;background:var(--card2);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:7px 10px;font-family:inherit;font-size:.8rem;outline:none"
      onkeydown="if(event.key==='Enter')addCustomGoal()"
      onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border2)'">
    <button onclick="addCustomGoal()" style="background:var(--card2);border:1px solid var(--border2);color:var(--accent2);border-radius:8px;padding:7px 12px;font-family:inherit;font-size:.8rem;font-weight:700;cursor:pointer;white-space:nowrap">+ Add</button>
  </div>`;
}

function addCustomGoal() {
  const inp = document.getElementById('goal-custom-inp');
  if (!inp) return;
  const val = inp.value.trim();
  if (!val) return;
  inp.value = '';
  // Persist the full goal list (all goals)
  const allGoals = getAllGoals();
  if (allGoals.includes(val)) { toast('Goal already exists', 'warn'); return; }
  allGoals.push(val);
  localStorage.setItem('ss_goals_all_' + (user?.email||''), JSON.stringify(allGoals));
  renderGoalsList();
  // auto-check the new goal
  setTimeout(() => {
    const cb = document.querySelector(`#goals-list input[data-goal="${val}"]`);
    if (cb) { cb.checked = true; saveGoals(); }
  }, 50);
}

function deleteGoal(g, btn) {
  let allGoals = getAllGoals().filter(x => x !== g);
  localStorage.setItem('ss_goals_all_' + (user?.email||''), JSON.stringify(allGoals));
  // also uncheck from saved checked list
  try {
    const saved = JSON.parse(localStorage.getItem('ss_goals_' + (user?.email||'')) || '[]');
    const updated = saved.filter(x => x !== g);
    localStorage.setItem('ss_goals_' + (user?.email||''), JSON.stringify(updated));
    if (user) user.investment_goals = updated;
  } catch(e) {}
  renderGoalsList();
  loadGoals();
}

function getAllGoals() {
  let all = [...DEFAULT_GOALS];
  try {
    const saved = JSON.parse(localStorage.getItem('ss_goals_all_' + (user?.email||'')) || '[]');
    saved.forEach(g => { if (!all.includes(g)) all.push(g); });
  } catch(e) {}
  return all;
}

async function saveGoals() {
  if (!user) return;
  const checked = [...document.querySelectorAll('#goals-list input[type=checkbox]:checked')].map(c => c.dataset.goal);
  user.investment_goals = checked;
  localStorage.setItem('ss_goals_' + user.email, JSON.stringify(checked));
  await usersTable().update({ investment_goals: JSON.stringify(checked) }).eq('email', user.email);
  toast('Goals saved', 'success');
}
function loadGoals() {
  if (!user) return;
  let saved = localStorage.getItem('ss_goals_' + user.email);
  if (!saved && user.investment_goals) saved = typeof user.investment_goals === 'string' ? user.investment_goals : JSON.stringify(user.investment_goals);
  if (!saved) return;
  try {
    const goals = JSON.parse(saved);
    user.investment_goals = goals;
    // restore custom goals into the all-goals list so they show up
    const allKey = 'ss_goals_all_' + user.email;
    if (!localStorage.getItem(allKey)) {
      const customs = goals.filter(g => !DEFAULT_GOALS.includes(g));
      if (customs.length) localStorage.setItem(allKey, JSON.stringify([...DEFAULT_GOALS, ...customs]));
    }
    document.querySelectorAll('#goals-list input[type=checkbox]').forEach(cb => {
      cb.checked = goals.includes(cb.dataset.goal);
    });
  } catch(e) {}
}

// ── Preferred Sectors ───────────────────────────────────────
function renderSectorsList() {
  const el = document.getElementById('sectors-list');
  if (!el) return;
  el.innerHTML = ['Technology','Healthcare','Finance','Energy','Consumer','Crypto','Defense','Real Estate','Industrials','Retail'].map(s=>`
    <button data-sector="${s}" onclick="toggleSector(this)" style="background:var(--card2);border:1px solid var(--border2);color:var(--text2);border-radius:20px;padding:6px 14px;font-family:inherit;font-size:.76rem;font-weight:600;cursor:pointer;transition:all .15s">${s}</button>`).join('');
}
function toggleSector(btn) {
  const active = [...document.querySelectorAll('#sectors-list button.sector-on')];
  if (btn.classList.contains('sector-on')) {
    btn.classList.remove('sector-on');
    btn.style.background = 'var(--card2)';
    btn.style.borderColor = 'var(--border2)';
    btn.style.color = 'var(--text2)';
  } else {
    if (active.length >= 3) { toast('Pick up to 3 sectors', 'warn'); return; }
    btn.classList.add('sector-on');
    btn.style.background = 'rgba(108,92,231,.18)';
    btn.style.borderColor = 'var(--accent)';
    btn.style.color = 'var(--accent2)';
  }
  saveSectors();
}
async function saveSectors() {
  if (!user) return;
  const selected = [...document.querySelectorAll('#sectors-list button.sector-on')].map(b => b.dataset.sector);
  user.preferred_sectors = selected;
  localStorage.setItem('ss_sectors_' + user.email, JSON.stringify(selected));
  await usersTable().update({ preferred_sectors: JSON.stringify(selected) }).eq('email', user.email);
  const msg = document.getElementById('sector-save-msg');
  if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
}
function loadSectors() {
  if (!user) return;
  let saved = localStorage.getItem('ss_sectors_' + user.email);
  if (!saved && user.preferred_sectors) saved = typeof user.preferred_sectors === 'string' ? user.preferred_sectors : JSON.stringify(user.preferred_sectors);
  if (!saved) return;
  try {
    const sectors = JSON.parse(saved);
    user.preferred_sectors = sectors;
    document.querySelectorAll('#sectors-list button').forEach(btn => {
      if (sectors.includes(btn.dataset.sector)) {
        btn.classList.add('sector-on');
        btn.style.background = 'rgba(108,92,231,.18)';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent2)';
      }
    });
  } catch(e) {}
}

// ── Stocks For You ──────────────────────────────────────────
const SECTOR_TICKERS = {
  Technology: ['AAPL','MSFT','NVDA','META','GOOGL','AMD'],
  Healthcare: ['JNJ','UNH','PFE','ABBV','MRK','LLY'],
  Finance: ['JPM','BAC','GS','MS','V','MA'],
  Energy: ['XOM','CVX','COP','SLB','OXY','BP'],
  Consumer: ['AMZN','TSLA','NKE','SBUX','MCD','TGT'],
  Crypto: ['BTC','ETH','SOL','BNB','XRP'],
  Defense: ['LMT','RTX','NOC','GD','BA'],
  'Real Estate': ['AMT','PLD','EQIX','SPG','O'],
  Industrials: ['CAT','DE','HON','GE','MMM'],
  Retail: ['WMT','COST','TGT','HD','LOW'],
};
function renderStocksForYou() {
  const el = document.getElementById('stocks-for-you');
  if (!el) return;
  const sectors = user?.preferred_sectors || [];
  const profileIdx = user?.investor_profile ?? -1;
  if (!sectors.length && profileIdx < 0) { el.style.display = 'none'; return; }

  let picks = [];
  sectors.forEach(s => { if (SECTOR_TICKERS[s]) picks.push(...SECTOR_TICKERS[s].slice(0,2)); });

  // fallback by profile if no sectors set
  if (!picks.length) {
    picks = profileIdx === 0 ? ['JNJ','V','MCD','PG','KO','WMT'] :
            profileIdx === 2 ? ['NVDA','TSLA','AMD','SOL','ETH','META'] :
            ['AAPL','MSFT','AMZN','GOOGL','JPM','UNH'];
  }

  picks = [...new Set(picks)].slice(0, 6);
  el.style.display = 'block';

  const profileName = profileIdx >= 0 ? QUIZ_PROFILES[profileIdx].type : null;
  const sectorLabel = sectors.length ? sectors.join(', ') : 'your profile';

  el.innerHTML = `
  <div style="font-size:.62rem;color:var(--text3);letter-spacing:.08em;font-weight:700;margin-bottom:.75rem"> STOCKS FOR YOU${profileName ? ` · ${profileName.toUpperCase()}` : ''}</div>
  <div style="font-size:.74rem;color:var(--text3);margin-bottom:.875rem">${sectors.length ? 'Based on your interest in ' + sectorLabel : 'Matched to your investor type'}</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">
    ${picks.map(t => {
      const found = TICKERS.find(e=>e.t===t);
      const tp = ['BTC','ETH','SOL','BNB','XRP'].includes(t) ? 'c' : 's';
      return `<button onclick="goAsset('${t}','${tp}')" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:8px 14px;font-family:inherit;cursor:pointer;transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
        <div style="font-size:.78rem;font-weight:800;color:var(--accent2);font-family:'Geist',sans-serif">${t}</div>
        ${found ? `<div style="font-size:.65rem;color:var(--text3);margin-top:1px">${found.n.slice(0,16)}</div>` : ''}
      </button>`;
    }).join('')}
  </div>`;
}


function showMsg(el, txt, color) {
 if (!el) return;
 el.textContent = txt; el.style.color = color; el.style.display = 'block';
 setTimeout(() => { el.style.display = 'none'; }, 4000);
}

/* ════════════════════════════════
 ONBOARDING CHECKLIST
════════════════════════════════ */
const CHECKLIST_ITEMS = [
 { id:'cl_search', label:'Search for your first stock', icon:'', action: ()=>{ const si=document.getElementById('si'); if(si){si.focus();} } },
 { id:'cl_watch', label:'Add a stock to your watchlist', icon:'', action: ()=>switchTab('s') },
 { id:'cl_holding', label:'Add your first portfolio holding', icon:'', action: ()=>{ show('app'); switchTab('port'); setTimeout(openHoldModal, 300); } },
 { id:'cl_paper', label:'Place your first paper trade', icon:'', action: ()=>switchTab('pt') },
 { id:'cl_screener', label:'Try the stock screener', icon:'', action: ()=>switchTab('screen') },
 { id:'cl_broker', label:'Set your preferred broker', icon:'', action: ()=>{ show('profile'); showP('set'); } },
];

function getChecklistState() {
 try { return JSON.parse(localStorage.getItem('ss_checklist_'+(user?.email||''))||'[]'); } catch { return []; }
}

function markChecklistDone(id) {
 const done = new Set(getChecklistState());
 if (!done.has(id)) {
 done.add(id);
 localStorage.setItem('ss_checklist_'+(user?.email||''), JSON.stringify([...done]));
 if (done.size === CHECKLIST_ITEMS.length) {
 setTimeout(() => { launchConfetti(); toast(' Getting started checklist complete! You\'re all set.', 'star', 5000); }, 300);
 }
 }
}

function isChecklistComplete() {
 const done = new Set(getChecklistState());
 return CHECKLIST_ITEMS.every(i => done.has(i.id));
}

function renderOnboardingChecklist(containerId) {
 const el = document.getElementById(containerId);
 if (!el || !user || isChecklistComplete()) { if(el) el.style.display='none'; return; }
 const done = new Set(getChecklistState());
 const pct = Math.round(done.size / CHECKLIST_ITEMS.length * 100);

 el.innerHTML = `
 <div class="ob-check-card">
 <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.875rem">
 <div>
 <div style="font-family:'Geist',sans-serif;font-size:.92rem;font-weight:800"> Getting Started</div>
 <div style="font-size:.68rem;color:var(--text2);margin-top:2px">${done.size} of ${CHECKLIST_ITEMS.length} done</div>
 </div>
 <div style="text-align:right">
 <div style="font-size:.88rem;font-weight:800;color:var(--accent2)">${pct}%</div>
 <button onclick="document.getElementById('${containerId}').style.display='none';ssApplyTabGroups()" style="background:none;border:none;font-size:.72rem;color:var(--text3);cursor:pointer;font-family:inherit">Dismiss</button>
 </div>
 </div>
 <div style="height:5px;background:var(--border);border-radius:3px;margin-bottom:.875rem;overflow:hidden">
 <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .5s ease"></div>
 </div>
 ${CHECKLIST_ITEMS.map(item => {
 const isDone = done.has(item.id);
 return `<div class="ob-check-item" onclick="(${item.action.toString()})()">
 <div class="ob-check-circle ${isDone?'done':''}">${isDone?'':''}</div>
 <span class="ob-check-label ${isDone?'done':''}">${item.icon} ${item.label}</span>
 ${!isDone ? '<span class="ob-check-arrow">→</span>' : ''}
 </div>`;
 }).join('')}
 </div>`;
}

// Auto-mark checklist items when actions happen
function clMark(id) { if(user) { markChecklistDone(id); } }

function refreshChecklist() {
 const wrap = document.getElementById('obChecklistWrap');
 if (wrap) renderOnboardingChecklist('obChecklistWrap');
}

/* ════════════════════════════════
 MILESTONE CONFETTI
════════════════════════════════ */
function checkMilestones() {
 if (!user) return;
 const key = 'ss_milestones_'+(user?.email||'');
 const fired = new Set(safeParse(key, []));

 const milestones = [
 { id:'first_holding', check: ()=> holdings.length >= 1, msg:' First holding added! Welcome to the investor club.' },
 { id:'five_holdings', check: ()=> holdings.length >= 5, msg:' 5 holdings! You\'re building a diversified portfolio.' },
 { id:'first_paper', check: ()=> Object.keys(getPtPortfolio().holdings).length >= 1, msg:' First paper trade placed! Practice makes perfect.' },
 { id:'first_watch', check: ()=> watchlist.length >= 1, msg:' First stock saved to watchlist!' },
 { id:'streak_7', check: ()=>{ try{return (safeParse('ss_streak_'+(user?.email||''),{})).streak>=7;}catch{return false;}}, msg:' 7-day streak! You\'re on fire.' },
 { id:'checklist_done', check: ()=> isChecklistComplete(), msg:' Getting started checklist complete!' },
 { id:'paper_profit', check: () => ptAccountValue() > 10050, msg:' Paper portfolio in the green! Great start.' },
 ];

 let anyNew = false;
 milestones.forEach(m => {
 if (!fired.has(m.id) && m.check()) {
 fired.add(m.id);
 anyNew = true;
 setTimeout(() => { launchConfetti(); toast(m.msg, 'star', 4000); }, 500);
 }
 });
 if (anyNew) localStorage.setItem(key, JSON.stringify([...fired]));
}

/* ════════════════════════════════
 KEYBOARD SHORTCUTS
════════════════════════════════ */
let _lastSearchQuery = '';
let _lastSearchResults = null;

document.addEventListener('keydown', e => {
 // Don't fire when typing in inputs
 const tag = document.activeElement?.tagName;
 if (tag === 'INPUT' || tag === 'TEXTAREA') {
 if (e.key === 'Escape') { document.activeElement.blur(); document.getElementById('sdrop').style.display='none'; }
 return;
 }
 if (e.metaKey || e.ctrlKey || e.altKey) return;
 switch(e.key) {
 case 's': case 'S': e.preventDefault(); document.getElementById('si')?.focus(); break;
 case 'h': case 'H': e.preventDefault(); goHome(); break;
 case 'p': case 'P': e.preventDefault(); if(requireAuth('Portfolio')) switchTab('port'); break;
 case 'w': case 'W': e.preventDefault(); if(requireAuth('Watchlist')) switchTab('w'); break;
 case 't': case 'T': e.preventDefault(); if(requireAuth('Paper Trading')) switchTab('pt'); break;
 case 'Escape': e.preventDefault(); if(currentAsset) { currentAsset=null; renderHome(tab); } break;
 case '?': e.preventDefault(); showKeyboardShortcuts(); break;
 }
});

function showKeyboardShortcuts() {
 const existing = document.getElementById('kbShortcutsModal');
 if (existing) { existing.remove(); return; }
 const el = document.createElement('div');
 el.id = 'kbShortcutsModal';
 el.style.cssText = 'position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(4px)';
 el.innerHTML = `<div style="background:var(--card);border:1px solid var(--border2);border-radius:16px;padding:1.75rem;max-width:380px;width:calc(100%-2rem);box-shadow:0 24px 64px rgba(0,0,0,.5)">
 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800"> Keyboard Shortcuts</div>
 <button onclick="document.getElementById('kbShortcutsModal').remove()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:1.1rem"></button>
 </div>
 ${[['S','Focus search bar'],['H','Go to homepage'],['P','Open portfolio'],['W','Open watchlist'],['T','Paper trading'],['Esc','Go back / close stock page'],['?','Show this help']]
 .map(([k,d])=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border)">
 <span style="font-size:.78rem;color:var(--text2)">${d}</span>
 <kbd style="background:var(--card2);border:1px solid var(--border2);border-radius:5px;padding:2px 8px;font-family:monospace;font-size:.78rem;color:var(--text)">${k}</kbd>
 </div>`).join('')}
 <div style="margin-top:.875rem;font-size:.65rem;color:var(--text3)">Press ? anytime to show this panel</div>
 </div>`;
 el.addEventListener('click', e => { if(e.target===el) el.remove(); });
 document.body.appendChild(el);
}
/* ════════════════════════════════
 PRICE ALERTS
════════════════════════════════ */
function addPriceAlert(ticker, targetPrice, direction) {
 if (!requireAuth('Price Alerts')) return;
 if (!targetPrice || isNaN(targetPrice)) { toast('Enter a valid price first', 'info', 2000); return; }
 const alerts = getAlerts();
 if (alerts.find(a=>a.ticker===ticker&&a.direction===direction)) { toast(`Alert already set for ${ticker} ${direction}`, 'info',2000); return; }
 alerts.push({ticker, targetPrice:parseFloat(targetPrice), direction, fired:false, createdAt:Date.now()});
 saveAlerts(alerts);
 toast(` Alert set: ${ticker} ${direction} $${parseFloat(targetPrice).toLocaleString()}`, 'success', 3000);
 const el = document.getElementById('alertSection_'+ticker); if(el) renderAlertsSection('alertSection_'+ticker, ticker);
}
function removeAlert(ticker, direction) {
 saveAlerts(getAlerts().filter(a=>!(a.ticker===ticker&&a.direction===direction)));
 const el = document.getElementById('alertSection_'+ticker); if(el) renderAlertsSection('alertSection_'+ticker, ticker);
 toast('Alert removed','info',2000);
}
// Checks every alert against live market prices (never simulated ones)
async function checkAlerts() {
 if (!user) return;
 const alerts = getAlerts();
 const open = alerts.filter(a => !a.fired);
 if (!open.length) return;
 await fetchQuotes([...new Set(open.map(a => a.ticker))].map(t => [t, TICKERS.find(e => e.t === t)?.k || 's']));
 const fmt = v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2 });
 const notify = (title, body) => { if ('Notification' in window && Notification.permission === 'granted') { try { new Notification(title, { body }); } catch {} } };
 const today = new Date().toISOString().slice(0, 10);
 let changed = false;
 open.forEach(a => {
  const cur = livePrice(a.ticker);
  if (cur == null) return;
  if (a.direction !== 'above' && a.direction !== 'below') { a.direction = cur < a.targetPrice ? 'above' : 'below'; changed = true; return; }
  if ((a.direction === 'above' && cur >= a.targetPrice) || (a.direction === 'below' && cur <= a.targetPrice)) {
   a.fired = true; a.firedAt = Date.now(); changed = true;
   toast(`Alert: ${a.ticker} is ${a.direction} ${fmt(a.targetPrice)} (now ${fmt(cur)})`, 'star', 6000);
   notify(`${a.ticker} price alert`, `Now ${fmt(cur)}. Your target was ${fmt(a.targetPrice)}.`);
   return;
  }
  // A heads-up once a day when it's close
  if (Math.abs(cur - a.targetPrice) / a.targetPrice < 0.05) {
   const key = `ss_alert_near_${a.ticker}_${a.direction}`;
   if (localStorage.getItem(key) === today) return;
   localStorage.setItem(key, today);
   toast(`${a.ticker} is within 5% of your ${fmt(a.targetPrice)} alert (now ${fmt(cur)})`, 'warning', 6000);
   notify(`${a.ticker} is near your alert`, `Now ${fmt(cur)}. Your alert is ${fmt(a.targetPrice)}.`);
  }
 });
 if (changed) saveAlerts(alerts);
}
function renderAlertsSection(containerId, ticker) {
 const el = document.getElementById(containerId); if(!el) return;
 const alerts = getAlerts().filter(a => a.ticker === ticker);
 if (!alerts.length) { el.innerHTML = ''; return; }
 el.innerHTML = `<ul class="alert-list">${alerts.map(a => `<li class="${a.fired ? 'fired' : ''}">
   <span>${a.direction === 'above' ? '▲ Above' : a.direction === 'below' ? '▼ Below' : 'At'} <b>$${a.targetPrice.toLocaleString()}</b>${a.fired ? ' · hit' : ''}</span>
   <button type="button" aria-label="Remove alert" onclick="removeAlertAt('${ticker}',${a.targetPrice},'${a.direction || ''}')">Remove</button></li>`).join('')}</ul>`;
}
// Settings, Notifications: every alert across all stocks
function renderNotifAlerts() {
 const list = document.getElementById('notif-alerts-list');
 if (!list) return;
 const alerts = getAlerts();
 if (!alerts.length) { list.innerHTML = `<div style="font-size:.74rem;color:var(--text3)">No alerts yet. Open any stock and use the Alerts tab.</div>`; return; }
 list.innerHTML = `<ul class="alert-list">${alerts.map(a => `<li class="${a.fired ? 'fired' : ''}">
   <span><b class="al-t" onclick="verifyTicker('${a.ticker}')">${a.ticker}</b> ${a.direction === 'above' ? 'above' : a.direction === 'below' ? 'below' : 'at'} <b>$${a.targetPrice.toLocaleString()}</b>${a.fired ? ' · hit' : ''}</span>
   <button type="button" aria-label="Remove alert" onclick="removeAlertAt('${a.ticker}',${a.targetPrice},'${a.direction || ''}')">Remove</button></li>`).join('')}</ul>`;
}
// Email when an alert is hit (on unless turned off here or from an email's link)
const alertMailOn = () => !!user?.email && localStorage.getItem('ss_alertmail_' + user.email) !== '0';
function syncAlertMailUI() {
 const tog = document.getElementById('alert-mail-tog'), lbl = document.getElementById('alert-mail-lbl');
 const on = alertMailOn();
 if (tog) { tog.className = 'notif-tog' + (on ? ' on' : ''); tog.setAttribute('aria-checked', String(on)); }
 if (lbl) lbl.textContent = on ? 'On' : 'Off';
}
async function toggleAlertEmails() {
 if (!requireAuth('Alert emails')) return;
 const on = !alertMailOn();
 const { error } = await usersTable().update({ alert_emails: on });
 if (error) { toast('Could not save that. Please try again.', 'error'); return; }
 try { localStorage.setItem('ss_alertmail_' + user.email, on ? '1' : '0'); } catch {}
 syncAlertMailUI();
 toast(on ? "We'll email you when an alert is hit." : 'Alert emails turned off.', on ? 'success' : 'info', 3000);
}
function removeAlertAt(ticker, target, direction) {
 saveAlerts(getAlerts().filter(a => !(a.ticker === ticker && a.targetPrice === target && (a.direction || '') === direction)));
 renderAlertBadge(ticker);
 if (document.getElementById('notif-alerts-list')) renderNotifAlerts();
 toast('Alert removed', 'info', 2000);
}
setTimeout(()=>{ if(user) checkAlerts(); }, 2500);

/* ════════════════════════════════
 PORTFOLIO P&L LINE CHART
════════════════════════════════ */
// What today's holdings were worth each day over the past year, against the S&P 500 (real prices)
async function renderPortfolioPLChart(containerId) {
 const el = document.getElementById(containerId);
 if (!el || !holdings.length) return;
 el.innerHTML = `<div class="fc-loading pg-load"><span class="fc-spark"></span><small>Loading a year of real prices for your holdings</small></div>`;
 const hs = await Promise.all(holdings.map(h => getHistory(ySym(h.ticker, h.type || 's')).catch(() => null)));
 const mkt = await getHistory('^GSPC').catch(() => null);
 if (!document.body.contains(el)) return;
 const start = Date.now() / 1000 - 365 * 86400;
 const base = (mkt || hs.find(Boolean));
 if (!base) { el.innerHTML = `<p class="fc-muted pg-empty">Price history isn't available right now. Try again in a minute.</p>`; return; }
 const days = base.t.filter(ts => ts >= start);
 const series = new Float64Array(days.length);
 let used = 0;
 holdings.forEach((h, i) => {
  const H = hs[i];
  if (!H) return;
  used++;
  let j = 0;
  days.forEach((ts, k) => {
   while (j + 1 < H.t.length && H.t[j + 1] <= ts + 43200) j++;
   series[k] += h.shares * H.c[H.t[j] <= ts + 43200 ? j : 0];
  });
 });
 if (!used) { el.innerHTML = `<p class="fc-muted pg-empty">No price history found for these symbols.</p>`; return; }
 let spx = null;
 if (mkt) {
  const m0 = mkt.t.findIndex(ts => ts >= days[0]);
  spx = days.map((ts, k) => series[0] * mkt.c[m0 + k] / mkt.c[m0]);
 }
 const ret = series[series.length - 1] / series[0] - 1;
 const mret = spx ? spx[spx.length - 1] / spx[0] - 1 : null;
 const fmtP = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
 el.innerHTML = `
  <div class="pg-head">
   <div><span>Your holdings, 1 year</span><b class="${ret >= 0 ? 'up' : 'down'}">${fmtP(ret)}</b></div>
   ${mret != null ? `<div><span>S&amp;P 500</span><b>${fmtP(mret)}</b></div><p>${ret >= mret ? 'Ahead of' : 'Behind'} the market by ${Math.abs((ret - mret) * 100).toFixed(1)} points</p>` : ''}
  </div>
  <div class="pg-chart"><canvas></canvas><div class="fc-tip" hidden></div></div>
  <p class="pg-note">What your current holdings would have been worth each day, using real closing prices${used < holdings.length ? ` (${holdings.length - used} without history left out)` : ''}. It doesn't know when you actually bought.</p>`;
 const host = el.querySelector('.pg-chart'), cv = host.querySelector('canvas'), tip = host.querySelector('.fc-tip');
 const draw = (hoverX = null, prog = 1) => {
  const W = host.clientWidth, Hh = host.clientHeight;
  if (!W || !Hh) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, Hh);
  const C = fcColors();
  const all = [...series, ...(spx || [])];
  let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
  const PL = 6, PR = 58, PT = 8, PB = 20, cw = W - PL - PR, ch = Hh - PT - PB;
  const X = k => PL + k / (days.length - 1) * cw, Y = v => PT + ch - (v - lo) / (hi - lo) * ch;
  ctx.font = '11px Geist, system-ui, sans-serif'; ctx.textBaseline = 'middle';
  for (let g = 0; g <= 3; g++) {
   const v = lo + (hi - lo) * g / 3, y = Math.round(Y(v)) + .5;
   ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR + 4, y); ctx.stroke();
   ctx.fillStyle = C.text3; ctx.textAlign = 'left'; ctx.fillText('$' + Math.round(v).toLocaleString(), W - PR + 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  let lastM = -1, lastX = -99;
  days.forEach((ts, k) => { const d = new Date(ts * 1000), m = d.getUTCMonth(); if (m !== lastM) { const x = X(k); if (lastM !== -1 && x - lastX > 40 && x < W - PR - 16) { ctx.fillText(d.toLocaleDateString('en-US', { month:'short', timeZone:'UTC' }), x, Hh - 4); lastX = x; } lastM = m; } });
  const n = Math.max(2, Math.round(days.length * prog));
  if (spx) {
   ctx.beginPath(); for (let k = 0; k < n; k++) ctx[k ? 'lineTo' : 'moveTo'](X(k), Y(spx[k]));
   ctx.setLineDash([4, 4]); ctx.strokeStyle = fcAlpha(C.text3.startsWith('#') ? C.text3 : C.text, 0.7); ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
  }
  const col = ret >= 0 ? C.green : C.red;
  const grad = ctx.createLinearGradient(0, PT, 0, PT + ch); grad.addColorStop(0, fcAlpha(col, 0.22)); grad.addColorStop(1, fcAlpha(col, 0));
  ctx.beginPath(); for (let k = 0; k < n; k++) ctx[k ? 'lineTo' : 'moveTo'](X(k), Y(series[k]));
  ctx.lineTo(X(n - 1), PT + ch); ctx.lineTo(X(0), PT + ch); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); for (let k = 0; k < n; k++) ctx[k ? 'lineTo' : 'moveTo'](X(k), Y(series[k]));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  if (hoverX != null) {
   const k = Math.max(0, Math.min(days.length - 1, Math.round((hoverX - PL) / cw * (days.length - 1))));
   const x = X(k);
   ctx.strokeStyle = fcAlpha(C.text, 0.25); ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, PT); ctx.lineTo(Math.round(x) + .5, PT + ch); ctx.stroke();
   ctx.beginPath(); ctx.arc(x, Y(series[k]), 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
   tip.hidden = false;
   tip.innerHTML = `<small>${new Date(days[k] * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' })}</small><b>$${Math.round(series[k]).toLocaleString()}</b>${spx ? `<small>S&amp;P 500 same start: $${Math.round(spx[k]).toLocaleString()}</small>` : ''}`;
   const tw = tip.offsetWidth;
   tip.style.left = Math.max(4, Math.min(W - tw - 4, x + 12 > W - tw - PR ? x - tw - 12 : x + 12)) + 'px';
   tip.style.top = '6px';
  } else tip.hidden = true;
 };
 cv.addEventListener('mousemove', e => draw(e.clientX - cv.getBoundingClientRect().left));
 cv.addEventListener('mouseleave', () => draw());
 new ResizeObserver(() => draw()).observe(host);
 if (matchMedia('(prefers-reduced-motion: reduce)').matches) draw();
 else { const t0 = performance.now(); const tick = now => { const k = Math.min(1, (now - t0) / 800); draw(null, 1 - Math.pow(1 - k, 3)); if (k < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
}

/* ════════════════════════════════
 EXPORT PORTFOLIO CSV
════════════════════════════════ */
function exportPortfolioCSV() {
 if(!holdings.length){toast('No holdings to export','info',2000);return;}
 const rows=[['Ticker','Name','Type','Shares','Buy Price','Current Price','Market Value','P&L ($)','P&L (%)']];
 holdings.forEach(h=>{
 const cur=ptDailyPrice(h.ticker); const val=h.shares*cur;
 const pl=(cur-h.buyPrice)*h.shares; const plPct=((cur-h.buyPrice)/h.buyPrice*100).toFixed(2);
 rows.push([h.ticker,h.name||h.ticker,h.type||'s',h.shares.toFixed(4),h.buyPrice.toFixed(2),cur.toFixed(2),val.toFixed(2),pl.toFixed(2),plPct+'%']);
 });
 const a=document.createElement('a');
 a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(rows.map(r=>r.join(',')).join('\n'));
 a.download=`stocksight-portfolio-${new Date().toISOString().slice(0,10)}.csv`; a.click();
 toast(' Portfolio exported as CSV!','success',2500);
}

/* ════════════════════════════════
 ECONOMIC CALENDAR
════════════════════════════════ */

/* ════════════════════════════════
 CRYPTO FEAR & GREED
════════════════════════════════ */

/* ════════════════════════════════
 AI STOCK RECOMMENDATIONS
════════════════════════════════ */
function getAIRecommendations() {
 try {
 const prefs=safeParse('ss_onboarding_'+(user?.email||''), {});
 const sectors=prefs.sectors||[]; if(!sectors.length) return null;
 const sectorMap={'Technology':['AAPL','MSFT','GOOGL','NVDA','META'],'Financials':['JPM','V','MA','GS','BAC'],'Healthcare':['JNJ','LLY','UNH','ABBV','PFE'],'Energy':['XOM','CVX','NEE','COP','SLB'],'Consumer':['AMZN','WMT','COST','NKE','SBUX'],'Crypto':['BTC','ETH','SOL','BNB','XRP'],'Semiconductors':['NVDA','AMD','AVGO','QCOM','INTC'],'Cybersecurity':['CRWD','NET','ZS','OKTA','PANW'],'AI & Data':['NVDA','PLTR','MSFT','META','GOOGL'],'Clean Energy':['NEE','ENPH','FSLR','RUN','PLUG'],'Biotech':['MRNA','BNTX','REGN','VRTX','GILD'],'Cloud & SaaS':['CRM','NOW','SNOW','DDOG','WDAY'],'EV & Autos':['TSLA','RIVN','F','GM','LCID'],'Media & Entertainment':['META','NFLX','DIS','SNAP','RBLX'],'Real Estate':['AMT','PLD','EQIX','SPG','O'],'Industrials':['CAT','HON','GE','BA','UPS'],'Retail':['COST','TGT','HD','WMT','ETSY'],'Telecom':['T','VZ','TMUS','CMCSA','CHTR'],'Aerospace':['LMT','RTX','NOC','GD','BA'],'Commodities':['GLD','SLV','USO','GOLD','FCX']};
 const seen=new Set(watchlist.map(w=>w.ticker)); const recs=[];
 sectors.forEach(sec=>{(sectorMap[sec]||[]).slice(0,2).forEach(t=>{if(!seen.has(t)&&recs.length<6){seen.add(t);recs.push({ticker:t,sector:sec});}});});
 return recs.slice(0,6);
 } catch { return null; }
}

/* ════════════════════════════════
 PORTFOLIO REBALANCING
════════════════════════════════ */
function renderRebalancingTool(containerId) {
 const el=document.getElementById(containerId); if(!el||!holdings.length){if(el)el.innerHTML='';return;}
 const totalVal=holdings.reduce((s,h)=>s+h.shares*ptDailyPrice(h.ticker),0);
 const cur={'Stocks':0,'Indexes':0,'Crypto':0};
 holdings.forEach(h=>{const cat=(h.type||'s')==='c'?'Crypto':(h.type||'s')==='i'?'Indexes':'Stocks';cur[cat]+=(h.shares*ptDailyPrice(h.ticker));});
 const target={'Stocks':60,'Indexes':20,'Crypto':20};
 el.innerHTML=`<div class="card adv-only"><div class="card-hdr"><div class="card-hdr-title"> Portfolio Rebalancer</div><div class="card-hdr-sub">Your current allocation vs a balanced 60/20/20 target</div></div>
 <div style="padding:1rem">
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.875rem">
 ${Object.entries(target).map(([cat,t])=>{
 const cv=cur[cat]||0; const cp=totalVal?(cv/totalVal*100):0; const diff=cp-t;
 const color=Math.abs(diff)<5?'var(--green)':Math.abs(diff)<15?'var(--gold)':'var(--red)';
 return `<div style="background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:.875rem">
 <div style="font-size:.6rem;color:var(--text3);font-weight:600;margin-bottom:3px">${cat.toUpperCase()}</div>
 <div style="font-family:'Geist',sans-serif;font-size:1rem;font-weight:800">${cp.toFixed(1)}%</div>
 <div style="font-size:.6rem;color:var(--text3)">target: ${t}%</div>
 <div style="font-size:.63rem;font-weight:700;color:${color};margin-top:3px">${diff>5?'▲ Over ':diff<-5?'▼ Under ':' '}${Math.abs(diff).toFixed(1)}%</div>
 <div style="height:3px;background:var(--border);border-radius:2px;margin-top:5px;overflow:hidden"><div style="height:100%;width:${Math.min(100,cp/t*100)}%;background:${color};border-radius:2px"></div></div>
 </div>`;
 }).join('')}
 </div>
 <div style="font-size:.68rem;color:var(--text3);line-height:1.6"> <strong style="color:var(--text2)">To rebalance:</strong> Sell from over-weight categories and buy into under-weight ones to reduce concentration risk.</div>
 </div></div>`;
}

/* ════════════════════════════════
 PORTFOLIO WHAT-IF (HISTORICAL)
════════════════════════════════ */
function renderPortfolioWhatIf(containerId) {
 const el=document.getElementById(containerId); if(!el||!holdings.length){if(el)el.innerHTML='';return;}
 const currentVal=holdings.reduce((s,h)=>s+h.shares*ptDailyPrice(h.ticker),0);
 const periods=[{label:'3 months ago',months:3},{label:'6 months ago',months:6},{label:'1 year ago',months:12}];
 el.innerHTML=`<div class="card adv-only"><div class="card-hdr"><div class="card-hdr-title"> What If You'd Bought Earlier?</div><div class="card-hdr-sub">Estimated gain if you had held your current portfolio for longer</div></div>
 <div style="padding:1rem">
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.875rem">
 ${periods.map(p=>{
 let pastVal=0;
 holdings.forEach(h=>{const d=assetData(h.ticker,[1,30,'Stock',10]);const pastP=ptDailyPrice(h.ticker)/Math.pow(1+d[3]/100,p.months/12);pastVal+=h.shares*pastP;});
 const gain=currentVal-pastVal; const pct=(gain/pastVal*100); const c=gain>=0?'var(--green)':'var(--red)';
 return `<div style="background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:.875rem;text-align:center">
 <div style="font-size:.6rem;color:var(--text3);margin-bottom:3px">${p.label.toUpperCase()}</div>
 <div style="font-size:.72rem;color:var(--text3)">Cost: $${Math.round(pastVal).toLocaleString()}</div>
 <div style="font-family:'Geist',sans-serif;font-size:.95rem;font-weight:800;color:${c};margin-top:3px">${gain>=0?'+':''}$${Math.round(gain).toLocaleString()}</div>
 <div style="font-size:.65rem;color:${c}">${pct>=0?'+':''}${pct.toFixed(1)}%</div>
 </div>`;
 }).join('')}
 </div>
 <div style="font-size:.63rem;color:var(--text3)"> Estimates based on historical growth rates. Past returns don't guarantee future results.</div>
 </div></div>`;
}

/* ════════════════════════════════
 NEWS SENTIMENT GUIDE
════════════════════════════════ */

/* ════════════════════════════════
 PRICE ALERT REAL-TIME CHECK (every 5 min)
════════════════════════════════ */
setInterval(() => { if(user) checkAlerts(); }, 5 * 60 * 1000);

/* ════════════════════════════════
 PENDING PAPER-TRADE ORDER WATCHER (every 60s)
 Silently processes queued orders the moment the market opens,
 even if the user never leaves the Paper Trade tab.
════════════════════════════════ */
setInterval(() => {
 if (!user) return;
 const pending = getPtPendingOrders();
 if (!pending.length) return;
 const filled = processPendingOrders();
 if (filled && tab === 'pt') renderPaperTradeTab(); // live re-render if on the tab
}, 60 * 1000);

/* ════════════════════════════════
 NOTIFICATION CENTER
════════════════════════════════ */
function getNotifications() {
 try { return JSON.parse(localStorage.getItem('ss_notifs_'+(user?.email||''))||'[]'); } catch { return []; }
}
function addNotification(msg, type='info') {
 if (!user) return;
 const notifs = getNotifications();
 notifs.unshift({ msg, type, ts: Date.now() });
 if (notifs.length > 30) notifs.pop();
 try { localStorage.setItem('ss_notifs_'+(user?.email||''), JSON.stringify(notifs)); } catch {}
 updateNotifBadge();
}
function updateNotifBadge() {
 const btn = document.getElementById('notifBtn'); if(!btn) return;
 const notifs = getNotifications();
 const unread = notifs.filter(n => !n.read).length;
 btn.innerHTML = `${icon('bell',16)}${unread > 0 ? `<span style="position:absolute;top:-3px;right:-3px;background:var(--red);color:#fff;font-size:.5rem;font-weight:800;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;line-height:1">${unread > 9 ? '9+' : unread}</span>` : ''}`;
}
function openNotificationCenter() {
 const existing = document.getElementById('notifPanel'); if(existing){existing.remove();return;}
 const notifs = getNotifications();
 // Mark all read
 notifs.forEach(n=>n.read=true);
 try { localStorage.setItem('ss_notifs_'+(user?.email||''), JSON.stringify(notifs)); } catch {}
 updateNotifBadge();
 const panel = document.createElement('div');
 panel.id = 'notifPanel';
 panel.style.cssText = 'position:fixed;top:56px;right:12px;width:320px;max-width:calc(100vw - 24px);background:var(--card);border:1px solid var(--border2);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.4);z-index:9200;max-height:420px;overflow-y:auto';
 panel.innerHTML = `
 <div style="padding:.875rem 1rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--card)">
 <div style="font-family:'Geist',sans-serif;font-size:.88rem;font-weight:800"> Notifications</div>
 <button onclick="document.getElementById('notifPanel')?.remove()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:.85rem">&#x2715;</button>
 </div>
 ${notifs.length === 0 ? `<div style="padding:2rem;text-align:center;font-size:.78rem;color:var(--text3)">No notifications yet.<br>Price alerts, badges, and milestones will appear here.</div>` :
 notifs.map(n => {
 const icons = {info:icon('message-circle',14),success:icon('check-circle',14),star:icon('award',14),money:icon('dollar-sign',14),error:icon('x-circle',14)};
 const age = Date.now()-n.ts; const ageStr = age<60000?'just now':age<3600000?Math.floor(age/60000)+'m ago':age<86400000?Math.floor(age/3600000)+'h ago':Math.floor(age/86400000)+'d ago';
 return `<div style="padding:.75rem 1rem;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start">
 <div style="font-size:1rem;flex-shrink:0">${icons[n.type]||''}</div>
 <div style="flex:1"><div style="font-size:.77rem;color:var(--text);line-height:1.5">${escapeHTML(n.msg)}</div><div style="font-size:.6rem;color:var(--text3);margin-top:3px">${ageStr}</div></div>
 </div>`;
 }).join('')}`;
 document.body.appendChild(panel);
 setTimeout(() => document.addEventListener('click', function handler(e) {
 if(!panel.contains(e.target)&&e.target.id!=='notifBtn'){panel.remove();document.removeEventListener('click',handler);}
 }), 100);
}

/* ════════════════════════════════
 AVATAR / PROFILE CUSTOMIZATION
════════════════════════════════ */
/* ════════════════════════════════
 STREAK TRACKING
════════════════════════════════ */
function updateStreak() {
 if (!user) return;
 const key = 'ss_streak_' + (user?.email || '');
 try {
 const data = JSON.parse(localStorage.getItem(key) || '{}');
 const today = new Date().toDateString();
 const yesterday = new Date(Date.now() - 86400000).toDateString();
 if (data.lastVisit === today) return; // already counted today
 if (data.lastVisit === yesterday) {
 data.streak = (data.streak || 1) + 1;
 } else {
 data.streak = 1; // reset streak
 }
 data.lastVisit = today;
 localStorage.setItem(key, JSON.stringify(data));
 if (user?.email) {
 usersTable().update({ streak_count: data.streak, streak_last_date: today }).eq('email', user.email)
 .then(({error}) => { if(error) console.warn('streak sync failed'); });
 }
 if (data.streak >= 7) checkMilestones();
 } catch {}
}

/* ════════════════════════════════
 AVATAR HELPER
════════════════════════════════ */

/* ════════════════════════════════
 SCREENER
════════════════════════════════ */
const NARRATIVE_MAP = [
 { tags:['ai','artificial intelligence','machine learning','chatgpt','openai'], tickers:['NVDA','MSFT','GOOGL','META','AMZN','PLTR','CRM','AMD','ORCL'], label:'AI & Machine Learning' },
 { tags:['crypto','bitcoin','blockchain','btc','eth','ethereum','coin'], tickers:['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','COIN','HOOD'], label:'Crypto' },
 { tags:['safe','low risk','stable','conservative','defensive','boring'], beta:'low', vol:'low', label:'Low Risk / Stable' },
 { tags:['risky','volatile','speculative','aggressive','yolo','high risk'], beta:'high', vol:'high', label:'High Risk / Volatile' },
 { tags:['dividend','income','passive income','yield'], sectors:['Financials','Healthcare','Energy','Consumer Staples'], label:'Dividend / Income' },
 { tags:['tech','technology','software','saas','cloud'], sectors:['Technology'], label:'Technology' },
 { tags:['energy','oil','gas','petroleum','renewable','solar','wind'], sectors:['Energy'], label:'Energy' },
 { tags:['healthcare','pharma','biotech','medicine','drug','hospital'], sectors:['Healthcare'], label:'Healthcare' },
 { tags:['finance','banking','bank','financial','payment','fintech'], sectors:['Financials'], label:'Financials' },
 { tags:['retail','consumer','shopping','ecommerce','e-commerce','store'], sectors:['Consumer Discretionary','Retail'], label:'Retail / Consumer' },
 { tags:['growth','fast growing','high growth','momentum','up'], minGrowth:20, label:'High Growth' },
 { tags:['value','cheap','undervalued','affordable','bargain'], beta:'low', minGrowth:0, maxGrowth:10, label:'Value Stocks' },
 { tags:['index','market','etf','s&p','nasdaq','dow'], types:['i'], label:'Market Indexes' },
 { tags:['buy','strong buy','analysts like','recommended'], verdict:'Buy', label:'Analyst Buy Picks' },
 { tags:['cybersecurity','security','hacking','cyber'], tickers:['CRWD','PLTR','MSFT','GOOGL','AMZN'], label:'Cybersecurity' },
 { tags:['space','rocket','satellite','aerospace','defense'], tickers:['RIVN','TSLA','AMZN','MSFT'], label:'Space & Aerospace' },
 { tags:['electric','ev','electric vehicle','tesla','car'], tickers:['TSLA','RIVN','GM','F'], label:'Electric Vehicles' },
 { tags:['social media','social','instagram','facebook','tiktok','twitter','x'], tickers:['META','SNAP','RBLX','SPOT'], label:'Social Media' },
 { tags:['streaming','video','movies','tv','entertainment','netflix'], tickers:['NFLX','DIS','SPOT','RBLX'], label:'Streaming & Entertainment' },
 { tags:['beginner','easy','simple','safe start','new investor'], beta:'low', vol:'low', label:'Beginner-Friendly' },
];

function parseNarrativeQuery(query) {
 const q = query.toLowerCase().trim();
 if (!q) return null;
 let best = null, bestScore = 0;
 NARRATIVE_MAP.forEach(rule => {
 const score = rule.tags.reduce((s, tag) => s + (q.includes(tag) ? tag.split(' ').length : 0), 0);
 if (score > bestScore) { bestScore = score; best = rule; }
 });
 if (bestScore === 0) return null;
 return best;
}

function applyNarrativeResults(rule) {
 const el = document.getElementById('scr-results');
 const cnt = document.getElementById('scr-count');
 if (!el) return;

 const allStocks = Object.keys(ASSET_DATA).map(t => scrRow(t));

 let results = [];
 if (rule.tickers) {
 results = rule.tickers.map(t => allStocks.find(s => s.t === t) || scrRow(t));
 } else {
 results = allStocks.filter(s => {
 if (rule.sectors && !rule.sectors.includes(s.sector)) return false;
 if (rule.beta === 'low' && s.beta >= 1) return false;
 if (rule.beta === 'high' && s.beta < 1) return false;
 if (rule.vol === 'low' && s.vol >= 30) return false;
 if (rule.vol === 'high' && s.vol < 30) return false;
 if (rule.minGrowth !== undefined && s.growth < rule.minGrowth) return false;
 if (rule.maxGrowth !== undefined && s.growth > rule.maxGrowth) return false;
 if (rule.verdict && !(s.verdict || '').endsWith(rule.verdict)) return false;
 if (rule.types && !rule.types.includes(s.k)) return false;
 return true;
 }).sort((a,b) => b.growth - a.growth);
 }

 if (cnt) cnt.textContent = `${results.length} results for "${rule.label}"`;
 renderScreenerTable(results, el);
}

/* ════════════════════════════════
 DAY TRADING
 Intraday replay simulator, trade journal, and position sizer.

 Prices are SIMULATED, not live market data. Each session's minute bars are
 generated deterministically from ticker + date using the same geometric
 Brownian motion engine as paper trading, then pinned to that day's close with
 a Brownian bridge so the intraday path and the daily close agree. A given
 ticker/day always replays identically.
════════════════════════════════ */

const DT_BARS = 390;            // one bar per minute, 9:30 to 16:00
const DT_START_CASH = 25000;    // mirrors the US pattern-day-trader minimum
const dtBarCache = {};

// Deterministic 32-bit RNG so replays are reproducible
function dtRng(seed) {
 let s = seed >>> 0;
 return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function dtSeedFor(ticker, dayIdx) {
 let seed = 0;
 for (let i = 0; i < ticker.length; i++) seed = (seed * 31 + ticker.charCodeAt(i)) | 0;
 return Math.abs(seed + dayIdx * 1000003);
}

// That day's closing price — same walk as ptDailyPrice, but for any date
function dtDayClose(ticker, dayIdx) {
 const base = PT_BASE_PRICES[ticker] || 100;
 const seed = dtSeedFor(ticker, dayIdx);
 const vol = (ASSET_DATA[ticker]?.[1] || 30) / 100 / Math.sqrt(252);
 const drift = (ASSET_DATA[ticker]?.[3] || 10) / 100 / 252;
 let price = base;
 for (let d = 60; d > 0; d--) {
 const daySeed = Math.abs(seed + d * 7919);
 const z = ((daySeed % 10000) / 5000) - 1;
 price *= Math.exp(drift - 0.5 * vol * vol + vol * z);
 if (price < 0.0001) price = 0.0001;
 }
 return price;
}

// 390 minute closes: opens with an overnight gap, lands exactly on the close
// Real one-minute sessions from the last two weeks (/api/history?intraday=1)
const DT_REAL = {};
const _dtRealReq = {};
function dtLoadReal(ticker) {
 if (DT_REAL[ticker]) return Promise.resolve(DT_REAL[ticker]);
 if (!_dtRealReq[ticker]) {
  _dtRealReq[ticker] = fetch('/api/history?intraday=1&symbol=' + encodeURIComponent(ySym(ticker, 's')))
   .then(r => r.ok ? r.json() : null).catch(() => null)
   .then(d => {
    const sessions = d?.sessions || [];
    if (!sessions.length) { setTimeout(() => delete _dtRealReq[ticker], 60000); return null; }
    DT_REAL[ticker] = { sessions, byDay: Object.fromEntries(sessions.map(x => [x.day, x])) };
    return DT_REAL[ticker];
   });
 }
 return _dtRealReq[ticker];
}
function dtIsReal(ticker, dayIdx) { return !!DT_REAL[ticker]?.byDay[dayIdx]; }

function dtIntradayBars(ticker, dayIdx) {
 const key = ticker + '|' + dayIdx;
 if (dtBarCache[key]) return dtBarCache[key];
 const real = DT_REAL[ticker]?.byDay[dayIdx];
 if (real) return (dtBarCache[key] = { open: real.open, prevClose: real.prevClose, close: real.close, bars: real.bars, real: true });

 const prevClose = dtDayClose(ticker, dayIdx - 1);
 const close = dtDayClose(ticker, dayIdx);
 const annVol = (ASSET_DATA[ticker]?.[1] || 30) / 100;
 const rnd = dtRng(dtSeedFor(ticker, dayIdx) ^ 0x5f3759df);

 const gap = (rnd() - 0.5) * (annVol / Math.sqrt(252)) * 0.8;
 const open = prevClose * Math.exp(gap);
 const sigma = (annVol / Math.sqrt(252)) / Math.sqrt(DT_BARS) * 1.7;

 // Random walk in log space
 const walk = [];
 let acc = 0;
 for (let i = 0; i < DT_BARS; i++) {
 let z = 0; for (let k = 0; k < 6; k++) z += rnd();   // ~normal via CLT
 acc += sigma * (z - 3);
 walk.push(acc);
 }

 // Brownian bridge: remove the endpoint drift so the path wanders freely but
 // always finishes on the real close.
 const end = walk[DT_BARS - 1];
 const logOpen = Math.log(open), logClose = Math.log(close);
 const bars = [];
 for (let i = 0; i < DT_BARS; i++) {
 const f = (i + 1) / DT_BARS;
 bars.push(Math.exp(logOpen + (logClose - logOpen) * f + (walk[i] - end * f)));
 }

 const out = { open, prevClose, close, bars };
 dtBarCache[key] = out;
 return out;
}

function dtRound(p) { return parseFloat(p.toFixed(p < 1 ? 6 : p < 10 ? 3 : 2)); }

// Bar index -> wall clock label (bar 0 = 9:30 AM)
function dtClock(i) {
 const m = 570 + Math.min(i, DT_BARS - 1);
 const h24 = Math.floor(m / 60), mm = m % 60;
 const h = h24 > 12 ? h24 - 12 : h24;
 return `${h}:${String(mm).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function dtDateLabel(dayIdx) {
 return new Date(dayIdx * 86400000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const DT_TICKERS = ['AAPL','TSLA','NVDA','AMD','META','AMZN','MSFT','COIN','PLTR','SOFI','HOOD','RIVN'];

/* ── Session state ── */
let dtS = null;

function dtRandomDay(ticker) {
 // A real recent session when we have them, otherwise a simulated weekday in the past year
 const real = ticker && DT_REAL[ticker]?.sessions;
 if (real?.length) {
  const pool = real.filter(x => !dtS || x.day !== dtS.dayIdx);
  return (pool.length ? pool : real)[Math.floor(Math.random() * (pool.length || real.length))].day;
 }
 let d = Math.floor(Date.now() / 86400000) - (1 + Math.floor(Math.random() * 300));
 while ([0, 6].includes(new Date(d * 86400000).getUTCDay())) d--;
 return d;
}

function dtNewSession(ticker, dayIdx) {
 dtPause();
 const tk = ticker || (dtS && dtS.ticker) || 'AAPL';
 dtS = {
 ticker: tk,
 dayIdx: dayIdx != null ? dayIdx : dtRandomDay(tk),
 i: 0, playing: false, speed: 5, timer: null,
 cash: DT_START_CASH, pos: null, sessionTrades: []
 };
}

function dtPrice() { return dtIntradayBars(dtS.ticker, dtS.dayIdx).bars[Math.min(dtS.i, DT_BARS - 1)]; }
function dtUnrealized() {
 if (!dtS.pos) return 0;
 const p = dtPrice(), q = dtS.pos;
 return (q.dir === 'long' ? p - q.entry : q.entry - p) * q.shares;
}

/* ── Playback ── */
function dtPause() {
 if (dtS && dtS.timer) { clearInterval(dtS.timer); dtS.timer = null; }
 if (dtS) dtS.playing = false;
}

function dtPlay() {
 if (!dtS || dtS.playing || dtS.i >= DT_BARS - 1) return;
 dtS.playing = true;
 dtS.timer = setInterval(dtTick, Math.max(16, Math.round(400 / dtS.speed)));
 dtRefresh();
}

function dtTogglePlay() { dtS.playing ? (dtPause(), dtRefresh()) : dtPlay(); }

function dtSetSpeed(v) {
 dtS.speed = v;
 if (dtS.playing) { dtPause(); dtPlay(); } else dtRefresh();
}

function dtTick() {
 if (dtS.i >= DT_BARS - 1) { dtPause(); dtRefresh(); return; }
 dtS.i++;

 // Stops and targets fill at the next observed price, not at the trigger —
 // so a fast move slips through your stop, the way it does in real life.
 if (dtS.pos) {
 const p = dtPrice(), q = dtS.pos;
 if (q.stop && ((q.dir === 'long' && p <= q.stop) || (q.dir === 'short' && p >= q.stop))) { dtExit('Stop loss'); }
 else if (q.target && ((q.dir === 'long' && p >= q.target) || (q.dir === 'short' && p <= q.target))) { dtExit('Target hit'); }
 }

 // Day trading means no overnight holds — flatten at the bell
 if (dtS.i >= DT_BARS - 1) {
 dtPause();
 if (dtS.pos) { dtExit('Market close'); return; }
 }
 dtRefresh();
}

function dtStep() { if (dtS.i < DT_BARS - 1) { dtPause(); dtTick(); } }

/* ── Orders ── */
function dtEnter(dir) {
 if (dtS.pos) { showToast('Close your open position first', 'info'); return; }
 if (dtS.i >= DT_BARS - 1) { showToast('Market is closed — start a new day', 'info'); return; }
 const shares = Math.floor(parseFloat(document.getElementById('dtShares')?.value) || 0);
 if (!shares || shares < 1) { showToast('Enter a share count', 'warn'); return; }
 const price = dtPrice();
 if (shares * price > dtS.cash) { showToast('Not enough buying power', 'warn'); return; }

 const stopRaw = parseFloat(document.getElementById('dtStop')?.value);
 const tgtRaw = parseFloat(document.getElementById('dtTarget')?.value);
 dtS.pos = {
 dir, shares, entry: price, entryIdx: dtS.i,
 stop: isFinite(stopRaw) && stopRaw > 0 ? stopRaw : null,
 target: isFinite(tgtRaw) && tgtRaw > 0 ? tgtRaw : null
 };
 dtRefresh();
}

function dtExit(reason) {
 if (!dtS.pos) return;
 const q = dtS.pos, exit = dtPrice();
 const pnl = (q.dir === 'long' ? exit - q.entry : q.entry - exit) * q.shares;
 dtS.cash += pnl;

 // R-multiple only means something when the trade had a defined stop
 const riskPerShare = q.stop ? Math.abs(q.entry - q.stop) : null;
 const r = riskPerShare ? pnl / (riskPerShare * q.shares) : null;

 const trade = {
 id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
 ticker: dtS.ticker, date: dtDateLabel(dtS.dayIdx),
 dir: q.dir, shares: q.shares,
 entry: dtRound(q.entry), exit: dtRound(exit),
 pnl: parseFloat(pnl.toFixed(2)),
 r: r != null ? parseFloat(r.toFixed(2)) : null,
 entryTime: dtClock(q.entryIdx), exitTime: dtClock(dtS.i),
 hour: Math.floor((570 + q.entryIdx) / 60),   // 24h entry hour, for time-of-day analysis
 held: dtS.i - q.entryIdx,
 reason: reason || 'Manual',
 setup: '', emotion: ''
 };
 dtS.pos = null;
 dtS.sessionTrades.push(trade);

 const j = dtJournal(); j.unshift(trade); dtSaveJournal(j.slice(0, 300));
 showToast(`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} — ${reason}`, pnl >= 0 ? 'success' : 'warn');
 dtRefresh(); dtRenderJournal();
}

/* ── Journal ── */
function dtJournalKey() { return 'ss_dtj_' + (user?.email || 'guest'); }
function dtJournal() { const j = safeParse(dtJournalKey(), []); return Array.isArray(j) ? j : []; }
function dtSaveJournal(list) { try { localStorage.setItem(dtJournalKey(), JSON.stringify(list)); } catch {} }

function dtTag(id, field, value) {
 const j = dtJournal();
 const row = j.find(t => t.id === id);
 if (!row) return;
 row[field] = value;
 dtSaveJournal(j);
 dtRenderJournal();
}

function dtClearJournal() {
 if (!confirm('Delete every logged trade? This cannot be undone.')) return;
 dtSaveJournal([]); dtRenderJournal();
}

// The numbers that actually tell a trader whether they have an edge
function dtStats(j) {
 const n = j.length;
 if (!n) return null;
 const wins = j.filter(t => t.pnl > 0), losses = j.filter(t => t.pnl < 0);
 const gross = wins.reduce((a, t) => a + t.pnl, 0);
 const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
 const avgWin = wins.length ? gross / wins.length : 0;
 const avgLoss = losses.length ? grossLoss / losses.length : 0;
 const winRate = wins.length / n;
 const rs = j.filter(t => t.r != null).map(t => t.r);
 return {
 n, winRate,
 net: j.reduce((a, t) => a + t.pnl, 0),
 avgWin, avgLoss,
 // Expectancy: what one average trade is worth
 expectancy: winRate * avgWin - (1 - winRate) * avgLoss,
 profitFactor: grossLoss ? gross / grossLoss : (gross > 0 ? Infinity : 0),
 avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
 best: Math.max(...j.map(t => t.pnl)),
 worst: Math.min(...j.map(t => t.pnl))
 };
}

/* ── Shareable trading report card ──────────────────────────────
 The hook: most traders can't tell you their expectancy. This puts it on a
 card they can post. Renders to canvas and downloads as PNG, same approach
 as sharePtCard(). */

// Extra breakdowns the stats panel doesn't show
function dtDeepStats(j) {
 const byHour = {};
 j.forEach(t => {
 if (typeof t.hour !== 'number') return;
 byHour[t.hour] = (byHour[t.hour] || 0) + t.pnl;
 });
 const hours = Object.entries(byHour).map(([h, p]) => ({ h: +h, pnl: p }));
 hours.sort((a, b) => b.pnl - a.pnl);

 const bySetup = {};
 j.forEach(t => { if (t.setup) bySetup[t.setup] = (bySetup[t.setup] || 0) + t.pnl; });
 const setups = Object.entries(bySetup).map(([s, p]) => ({ s, pnl: p })).sort((a, b) => b.pnl - a.pnl);

 const hourLabel = h => {
 const ampm = h >= 12 ? 'PM' : 'AM';
 const hh = h > 12 ? h - 12 : (h === 0 ? 12 : h);
 return `${hh}${ampm}`;
 };
 return {
 // Only meaningful once trades are spread across more than one hour
 best: hours.length > 1 ? hours[0] : null,
 worst: hours.length > 1 ? hours[hours.length - 1] : null,
 topSetup: setups.length ? setups[0] : null,
 hourLabel
 };
}

function shareDayCard() {
 const j = dtJournal();
 const s = dtStats(j);
 if (!s) { showToast('Take a few trades first, then your card will have something to say', 'info'); return; }

 const d = dtDeepStats(j);
 const W = 1080, H = 760;
 const canvas = document.createElement('canvas');
 canvas.width = W; canvas.height = H;
 const ctx = canvas.getContext('2d');
 if (!ctx) return;

 const GREEN = '#00c97a', RED = '#ff3860', INK = '#eeeef8', MUTE = 'rgba(238,238,248,0.42)';
 const good = s.expectancy >= 0;
 const accent = good ? GREEN : RED;

 // Background
 ctx.fillStyle = '#161618';
 ctx.fillRect(0, 0, W, H);
 const glow = ctx.createRadialGradient(W * 0.86, -60, 0, W * 0.86, -60, 620);
 glow.addColorStop(0, 'rgba(108,92,231,0.20)');
 glow.addColorStop(1, 'rgba(108,92,231,0)');
 ctx.fillStyle = glow;
 ctx.fillRect(0, 0, W, H);
 ctx.fillStyle = accent;
 ctx.fillRect(0, 0, W, 4);

 // Logo
 ctx.fillStyle = 'rgba(108,92,231,0.2)';
 roundRect(ctx, 48, 44, 42, 42, 12); ctx.fill();
 ctx.strokeStyle = 'rgba(108,92,231,0.6)'; ctx.lineWidth = 1.5;
 roundRect(ctx, 48, 44, 42, 42, 12); ctx.stroke();
 ctx.strokeStyle = '#a89cff'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 ctx.beginPath();
 ctx.moveTo(58, 76); ctx.lineTo(64, 66); ctx.lineTo(70, 70); ctx.lineTo(78, 58); ctx.lineTo(82, 62);
 ctx.stroke();
 ctx.fillStyle = INK; ctx.font = '700 22px Geist, Geist, sans-serif';
 ctx.fillText('Stock', 100, 68);
 // Measure rather than hardcode the offset, or the two halves overlap
 ctx.fillStyle = '#a89cff';
 ctx.fillText('Sight', 100 + ctx.measureText('Stock').width, 68);
 ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '600 11px Geist, sans-serif';
 ctx.fillText('TRADING REPORT CARD', 100, 86);

 // Hero: expectancy, the number most traders can't name
 const exp = (s.expectancy >= 0 ? '+$' : '-$') + Math.abs(s.expectancy).toFixed(2);
 ctx.fillStyle = accent; ctx.font = '900 116px Geist, Geist, sans-serif';
 ctx.fillText(exp, 48, 236);
 ctx.fillStyle = MUTE; ctx.font = '500 19px Geist, sans-serif';
 ctx.fillText('expectancy: what one average trade is worth', 52, 274);

 ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(48, 314); ctx.lineTo(W - 48, 314); ctx.stroke();

 // Core stat row
 const box = (x, y, w, h, label, value, color) => {
 ctx.fillStyle = 'rgba(255,255,255,0.05)';
 roundRect(ctx, x, y, w, h, 12); ctx.fill();
 ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
 roundRect(ctx, x, y, w, h, 12); ctx.stroke();
 ctx.fillStyle = color || INK; ctx.font = '800 30px Geist, Geist, sans-serif';
 ctx.fillText(value, x + 18, y + 46);
 ctx.fillStyle = 'rgba(238,238,248,0.32)'; ctx.font = '600 11px Geist, sans-serif';
 ctx.fillText(label, x + 18, y + 70);
 };

 const bw = (W - 96 - 3 * 16) / 4;
 box(48, 346, bw, 88, 'TRADES', String(s.n));
 box(48 + (bw + 16), 346, bw, 88, 'WIN RATE', (s.winRate * 100).toFixed(0) + '%', s.winRate >= 0.5 ? GREEN : '#f5b543');
 box(48 + (bw + 16) * 2, 346, bw, 88, 'PROFIT FACTOR',
 s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2),
 s.profitFactor >= 1.5 ? GREEN : s.profitFactor >= 1 ? '#f5b543' : RED);
 box(48 + (bw + 16) * 3, 346, bw, 88, 'NET P&L',
 (s.net >= 0 ? '+$' : '-$') + Math.abs(s.net).toFixed(0), s.net >= 0 ? GREEN : RED);

 // Behavioural row — the part traders rarely measure about themselves
 const bw2 = (W - 96 - 2 * 16) / 3;
 box(48, 452, bw2, 88, 'AVG R MULTIPLE',
 s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R',
 s.avgR == null ? MUTE : s.avgR >= 0 ? GREEN : RED);
 box(48 + (bw2 + 16), 452, bw2, 88, 'BEST HOUR',
 d.best ? d.hourLabel(d.best.h) : '—', d.best ? GREEN : MUTE);
 box(48 + (bw2 + 16) * 2, 452, bw2, 88, 'TOUGHEST HOUR',
 d.worst ? d.hourLabel(d.worst.h) : '—', d.worst ? RED : MUTE);

 // One-line read on the numbers
 ctx.fillStyle = 'rgba(255,255,255,0.05)';
 roundRect(ctx, 48, 560, W - 96, 92, 14); ctx.fill();
 ctx.strokeStyle = `${accent}44`; ctx.lineWidth = 1;
 roundRect(ctx, 48, 560, W - 96, 92, 14); ctx.stroke();

 const verdict = s.n < 30
 ? `${s.n} trades is still mostly luck. Come back at 30+.`
 : good
 ? `Positive expectancy over ${s.n} trades. That edge is the whole game.`
 : `Negative expectancy over ${s.n} trades. The size of your losses is the problem.`;
 ctx.fillStyle = INK; ctx.font = '600 21px Geist, sans-serif';
 ctx.fillText(verdict, 72, 600);
 ctx.fillStyle = MUTE; ctx.font = '500 16px Geist, sans-serif';
 ctx.fillText(d.topSetup ? `Best setup: ${d.topSetup.s}` : 'Tag your setups to see which ones actually pay', 72, 630);

 // Watermark
 ctx.textAlign = 'right';
 ctx.fillStyle = 'rgba(238,238,248,0.28)'; ctx.font = '600 16px Geist, sans-serif';
 ctx.fillText('stocksightai.com', W - 48, H - 44);
 ctx.fillStyle = 'rgba(238,238,248,0.14)'; ctx.font = '500 13px Geist, sans-serif';
 ctx.fillText('Free trade journal & day trading simulator', W - 48, H - 22);
 ctx.textAlign = 'left';

 const link = document.createElement('a');
 link.download = 'stocksight-report-card.png';
 link.href = canvas.toDataURL('image/png');
 link.click();
 showToast('Report card saved. Post it and tag us.', 'success');
}

/* ── Position sizer ── */
function dtCalcSize() {
 const acct = parseFloat(document.getElementById('psAcct')?.value);
 const riskPct = parseFloat(document.getElementById('psRisk')?.value);
 const entry = parseFloat(document.getElementById('psEntry')?.value);
 const stop = parseFloat(document.getElementById('psStop')?.value);
 const target = parseFloat(document.getElementById('psTarget')?.value);
 const out = document.getElementById('psOut');
 if (!out) return;

 if (![acct, riskPct, entry, stop].every(v => isFinite(v) && v > 0) || entry === stop) {
 out.innerHTML = `<div style="font-size:.72rem;color:var(--text3)">Fill in account, risk %, entry and stop to size the trade.</div>`;
 return;
 }
 const riskDollars = acct * (riskPct / 100);
 const perShare = Math.abs(entry - stop);
 const shares = Math.floor(riskDollars / perShare);
 const cost = shares * entry;
 const rr = isFinite(target) && target > 0 ? Math.abs(target - entry) / perShare : null;

 out.innerHTML = `
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
 <div class="dt-stat"><div class="dt-stat-v" style="color:var(--accent2)">${shares.toLocaleString()}</div><div class="dt-stat-l">SHARES</div></div>
 <div class="dt-stat"><div class="dt-stat-v">$${riskDollars.toFixed(2)}</div><div class="dt-stat-l">AT RISK</div></div>
 <div class="dt-stat"><div class="dt-stat-v">$${cost.toLocaleString('en-US',{maximumFractionDigits:0})}</div><div class="dt-stat-l">POSITION SIZE</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${rr==null?'var(--text3)':rr>=2?'var(--green)':rr>=1?'var(--gold)':'var(--red)'}">${rr==null?'—':rr.toFixed(2)+':1'}</div><div class="dt-stat-l">REWARD : RISK</div></div>
 </div>
 ${cost > acct ? `<div style="font-size:.7rem;color:var(--red);margin-top:.625rem">That position costs more than the account. Widen the stop or lower the risk %.</div>` : ''}
 ${rr != null && rr < 1 ? `<div style="font-size:.7rem;color:var(--gold);margin-top:.625rem">Your target is closer than your stop. You'd need to win more than half your trades just to break even.</div>` : ''}`;
}

/* ── Broker CSV import ──────────────────────────────────────────
 Brokers export executions (individual fills), not round-trip trades, and every
 broker uses different column names. So: parse the file, guess the columns,
 let the user correct the guess, then FIFO-match fills into completed trades.
 Everything happens in the browser — no upload, no credentials, no backend. */

let dtImport = null;

// RFC4180-ish parser: handles quoted fields, escaped quotes, and CRLF
function dtParseCSV(text) {
 const rows = []; let row = [], field = '', inQ = false;
 text = text.replace(/\r\n?/g, '\n');
 for (let i = 0; i < text.length; i++) {
 const c = text[i];
 if (inQ) {
 if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
 else field += c;
 } else if (c === '"') inQ = true;
 else if (c === ',') { row.push(field); field = ''; }
 else if (c === '\n') { row.push(field); field = ''; if (row.some(v => v.trim() !== '')) rows.push(row); row = []; }
 else field += c;
 }
 row.push(field);
 if (row.some(v => v.trim() !== '')) rows.push(row);
 return rows;
}

// Order matters within a list: earlier hints win. Avoid words that collide
// across fields ("activity" would otherwise steal "Activity Date" for side).
const DT_COL_HINTS = {
 date:   ['activity date','trade date','run date','settlement date','date/time','date','filled at','executed','settled','time'],
 symbol: ['symbol','ticker','instrument','security','stock','underlying'],
 side:   ['trans code','transaction code','buy/sell','side','action','transaction type','activity type','trans','description','type'],
 qty:    ['quantity','qty','shares','filled qty','units','size'],
 price:  ['fill price','average price','avg price','executed price','trade price','unit price','price ($)','price']
};

// Brokers often stack account junk above the real header, so score each of the
// first few rows and take the one that looks most like a header.
function dtFindHeader(rows) {
 let best = 0, bestScore = -1;
 for (let r = 0; r < Math.min(rows.length, 12); r++) {
 const cells = rows[r].map(c => c.trim().toLowerCase());
 let score = 0;
 Object.values(DT_COL_HINTS).forEach(hints => {
 if (cells.some(c => hints.some(h => c === h || c.includes(h)))) score++;
 });
 if (score > bestScore) { bestScore = score; best = r; }
 }
 return { index: best, score: bestScore };
}

// Two passes so exact header matches claim their column before fuzzy ones do,
// and a claimed column can't be stolen by a second field.
function dtGuessCols(headers) {
 const low = headers.map(h => h.trim().toLowerCase());
 const keys = ['date', 'symbol', 'side', 'qty', 'price'];
 const map = { date: null, symbol: null, side: null, qty: null, price: null };
 const taken = new Set();

 keys.forEach(k => {
 const i = low.findIndex((h, idx) => !taken.has(idx) && DT_COL_HINTS[k].includes(h));
 if (i >= 0) { map[k] = i; taken.add(i); }
 });
 keys.forEach(k => {
 if (map[k] != null) return;
 const i = low.findIndex((h, idx) => !taken.has(idx) && DT_COL_HINTS[k].some(x => h.includes(x)));
 if (i >= 0) { map[k] = i; taken.add(i); }
 });
 return map;
}

// "$1,234.50", "(45.20)" -> 1234.5, -45.2
function dtNum(s) {
 if (s == null) return NaN;
 let v = String(s).trim().replace(/[$,\s]/g, '');
 let neg = false;
 if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
 const n = parseFloat(v);
 return isFinite(n) ? (neg ? -n : n) : NaN;
}

function dtParseDate(s) {
 if (!s) return null;
 const raw = String(s).trim().split(/\s+as of\s+/i)[0];
 // A bare YYYY-MM-DD parses as UTC midnight, which lands on the previous day
 // in any timezone behind UTC. Build it as a local date instead.
 const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
 const d = new Date(raw);
 return isNaN(d.getTime()) ? null : d;
}

// Normalize the many ways brokers spell a direction
function dtSide(s) {
 const v = String(s || '').toLowerCase();
 if (/sell\s*short|short\s*sell|sell to open/.test(v)) return 'short';
 if (/buy to cover|cover/.test(v)) return 'cover';
 if (/\bbuy\b|bought|purchase|\bbot\b/.test(v)) return 'buy';
 if (/\bsell\b|sold|\bsale\b/.test(v)) return 'sell';
 return null;
}

// FIFO-match fills into completed round trips. Opens a long or short depending
// on which side arrives first, so both directions work without extra config.
function dtBuildTrades(rows, map) {
 const fills = [];
 rows.forEach(r => {
 const side = dtSide(r[map.side]);
 const sym = String(r[map.symbol] || '').trim().toUpperCase().split(/\s+/)[0];
 const qty = Math.abs(dtNum(r[map.qty]));
 const price = Math.abs(dtNum(r[map.price]));
 const date = dtParseDate(r[map.date]);
 if (!side || !sym || !isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0 || !date) return;
 fills.push({ side, sym, qty, price, date });
 });
 fills.sort((a, b) => a.date - b.date);

 const open = {};          // symbol -> [{dir, qty, price, date}]
 const trades = [], skipped = [];

 fills.forEach(f => {
 const lots = open[f.sym] || (open[f.sym] = []);
 const closesLong = (f.side === 'sell');
 const closesShort = (f.side === 'buy' || f.side === 'cover');
 const wantDir = closesLong ? 'long' : closesShort ? 'short' : null;

 let qty = f.qty;
 while (qty > 0 && lots.length && lots[0].dir === wantDir) {
 const lot = lots[0];
 const n = Math.min(qty, lot.qty);
 const pnl = (lot.dir === 'long' ? f.price - lot.price : lot.price - f.price) * n;
 const days = Math.max(0, Math.round((f.date - lot.date) / 86400000));
 trades.push({
 id: 'imp-' + f.sym + '-' + f.date.getTime() + '-' + trades.length,
 ticker: f.sym,
 date: f.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
 dir: lot.dir, shares: n,
 entry: parseFloat(lot.price.toFixed(4)), exit: parseFloat(f.price.toFixed(4)),
 pnl: parseFloat(pnl.toFixed(2)), r: null,
 entryTime: lot.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
 exitTime: f.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
 heldLabel: days === 0 ? 'intraday' : days + 'd',
 hour: lot.date.getHours(),
 reason: 'Imported', setup: '', emotion: '', src: 'csv'
 });
 lot.qty -= n; qty -= n;
 if (lot.qty <= 1e-9) lots.shift();
 }
 // Anything left over opens a new position in this direction
 if (qty > 0) {
 const dir = (f.side === 'buy') ? 'long' : (f.side === 'short' ? 'short' : null);
 if (dir) lots.push({ dir, qty, price: f.price, date: f.date });
 else skipped.push(f);
 }
 });

 const stillOpen = Object.values(open).reduce((a, l) => a + l.length, 0);
 return { trades, parsedFills: fills.length, stillOpen, skipped: skipped.length };
}

const DT_SETUPS = ['Breakout','Pullback','Reversal','Momentum','VWAP bounce','News','Other'];
const DT_EMOTIONS = ['Calm','Confident','FOMO','Revenge','Hesitant'];

function dtOnFile(input) {
 const file = input.files && input.files[0];
 if (!file) return;
 if (file.size > 8 * 1024 * 1024) { showToast('That file is larger than 8MB', 'warn'); return; }
 const reader = new FileReader();
 reader.onload = e => {
 try {
 const rows = dtParseCSV(String(e.target.result));
 if (rows.length < 2) { showToast("That file doesn't look like a CSV", 'warn'); return; }
 const hdr = dtFindHeader(rows);
 const headers = rows[hdr.index].map(h => h.trim());
 const body = rows.slice(hdr.index + 1).filter(r => r.length >= headers.length - 2);
 dtImport = { fileName: file.name, headers, body, map: dtGuessCols(headers), result: null };
 dtRecompute();
 } catch (err) {
 showToast('Could not read that file', 'warn');
 }
 };
 reader.readAsText(file);
 input.value = '';
}

function dtRecompute() {
 if (!dtImport) return;
 const m = dtImport.map;
 dtImport.result = (m.date != null && m.symbol != null && m.side != null && m.qty != null && m.price != null)
 ? dtBuildTrades(dtImport.body, m)
 : null;
 dtRenderImport();
}

function dtSetMap(key, val) {
 if (!dtImport) return;
 dtImport.map[key] = val === '' ? null : +val;
 dtRecompute();
}

function dtCancelImport() { dtImport = null; dtRenderImport(); }

function dtDoImport() {
 if (!dtImport?.result?.trades?.length) return;
 const j = dtJournal();
 const seen = new Set(j.map(t => t.id));
 const fresh = dtImport.result.trades.filter(t => !seen.has(t.id));
 dtSaveJournal([...fresh, ...j].slice(0, 1000));
 showToast(`Imported ${fresh.length} trade${fresh.length === 1 ? '' : 's'}`, 'success');
 dtImport = null;
 dtRenderImport();
 dtRenderJournal();
}

function dtRenderImport() {
 const el = document.getElementById('dtImportPanel');
 if (!el) return;

 if (!dtImport) {
 el.innerHTML = `
 <div style="padding:1rem">
 <label style="display:block;border:2px dashed var(--border2);border-radius:14px;padding:1.5rem;text-align:center;cursor:pointer">
 <input type="file" accept=".csv,text/csv" onchange="dtOnFile(this)" style="display:none">
 <div style="font-size:1.6rem;margin-bottom:.5rem">📄</div>
 <div style="font-size:.85rem;font-weight:700;color:var(--text);margin-bottom:4px">Choose your broker's CSV</div>
 <div style="font-size:.72rem;color:var(--text3)">Your file is read in the browser and never uploaded anywhere</div>
 </label>
 <div style="font-size:.68rem;color:var(--text3);margin-top:.875rem;line-height:1.7">
 <b style="color:var(--text2)">Where to find it:</b>
 Robinhood → Account → Statements → Reports ·
 Schwab → Accounts → History → Export ·
 Fidelity → Activity → Download ·
 E*TRADE → Transactions → Download ·
 Webull → Account → Statements
 </div>
 </div>`;
 return;
 }

 const { headers, map, result, fileName } = dtImport;
 const sel = (key, label) => `
 <div>
 <label class="dt-lbl">${label}</label>
 <select class="dt-inp" style="font-size:.72rem;padding:7px 8px" onchange="dtSetMap('${key}',this.value)">
 <option value="">— not set —</option>
 ${headers.map((h, i) => `<option value="${i}" ${map[key] === i ? 'selected' : ''}>${escapeHTML(h || 'col ' + (i + 1))}</option>`).join('')}
 </select>
 </div>`;

 const preview = result && result.trades.length
 ? `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-top:.875rem">
 ${result.trades.slice(0, 6).map(t => `
 <div style="display:grid;grid-template-columns:56px 1fr 1fr 80px;gap:8px;padding:.5rem .75rem;border-bottom:1px solid var(--border);font-size:.68rem;align-items:center">
 <div style="font-weight:700">${escapeHTML(t.ticker)}</div>
 <div style="color:var(--text3)">${escapeHTML(t.dir)} · ${t.shares} sh · ${escapeHTML(t.heldLabel)}</div>
 <div style="color:var(--text2)">$${t.entry} → $${t.exit}</div>
 <div style="text-align:right;font-weight:700;color:${t.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</div>
 </div>`).join('')}
 ${result.trades.length > 6 ? `<div style="padding:.5rem .75rem;font-size:.66rem;color:var(--text3)">+ ${result.trades.length - 6} more</div>` : ''}
 </div>`
 : '';

 el.innerHTML = `
 <div style="padding:1rem">
 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;gap:1rem">
 <div style="font-size:.75rem;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(fileName)}</div>
 <button class="dt-ctrl" style="font-size:.65rem;padding:6px 12px;flex-shrink:0" onclick="dtCancelImport()">Cancel</button>
 </div>

 <div style="font-size:.66rem;color:var(--text3);margin-bottom:.5rem">We guessed these columns. Fix any that look wrong.</div>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.5rem;margin-bottom:.875rem">
 ${sel('date', 'DATE')}${sel('symbol', 'SYMBOL')}${sel('side', 'BUY / SELL')}${sel('qty', 'QUANTITY')}${sel('price', 'PRICE')}
 </div>

 ${!result
 ? `<div style="font-size:.72rem;color:var(--gold)">Pick a column for each field above to continue.</div>`
 : result.trades.length === 0
 ? `<div style="font-size:.72rem;color:var(--gold);line-height:1.6">Read ${result.parsedFills} usable row${result.parsedFills === 1 ? '' : 's'} but couldn't pair any into completed trades. Check that the buy/sell and price columns are mapped correctly.</div>`
 : `<div style="display:flex;gap:.625rem;flex-wrap:wrap;margin-bottom:.25rem">
 <div class="dt-stat" style="flex:1;min-width:96px"><div class="dt-stat-v" style="color:var(--accent2)">${result.trades.length}</div><div class="dt-stat-l">ROUND TRIPS</div></div>
 <div class="dt-stat" style="flex:1;min-width:96px"><div class="dt-stat-v">${result.parsedFills}</div><div class="dt-stat-l">FILLS READ</div></div>
 <div class="dt-stat" style="flex:1;min-width:96px"><div class="dt-stat-v" style="color:${result.stillOpen ? 'var(--gold)' : 'var(--text)'}">${result.stillOpen}</div><div class="dt-stat-l">STILL OPEN</div></div>
 </div>
 ${preview}
 ${result.stillOpen ? `<div style="font-size:.66rem;color:var(--text3);margin-top:.625rem">${result.stillOpen} position${result.stillOpen === 1 ? '' : 's'} never sold in this file, so ${result.stillOpen === 1 ? 'it has' : 'they have'} no P&amp;L yet and won't be imported.</div>` : ''}
 <button class="dt-trade-btn" style="width:100%;background:var(--accent);margin-top:.875rem" onclick="dtDoImport()">Add ${result.trades.length} trade${result.trades.length === 1 ? '' : 's'} to journal</button>`}
 </div>`;
}

function renderDayTradeTab() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 if (!dtS) dtNewSession();
 const tk = dtS.ticker;
 const isReal = dtIsReal(tk, dtS.dayIdx);
 if (!DT_REAL[tk]) {
  dtLoadReal(tk).then(R => {
   const fresh = dtS && dtS.ticker === tk && dtS.i === 0 && !dtS.pos && !dtS.sessionTrades.length && !dtS.playing;
   if (R && fresh) dtNewSession(tk);
   if (tab === 'day' && !currentAsset && dtS.ticker === tk) renderDayTradeTab();
  });
 }
 const loadingReal = !DT_REAL[tk] && _dtRealReq[tk];

 mc.innerHTML = `
 <div class="card" style="margin-bottom:1.25rem">
 <div class="card-hdr">
 <div>
 <div class="card-hdr-title">Day Trade Simulator</div>
 <div class="card-hdr-sub">${isReal ? `Replaying the real ${tk} session from ${dtDateLabel(dtS.dayIdx)}, minute by minute. Positions close at the bell.` : loadingReal ? 'Loading real trading sessions...' : 'Simulated session (real minute data unavailable). Positions close at the bell.'}</div>
 </div>
 <div style="display:flex;gap:8px;align-items:center">
 <select class="dt-sel" style="font-size:.75rem;padding:8px 10px" onchange="dtNewSession(this.value);renderDayTradeTab()">
 ${DT_TICKERS.map(t => `<option value="${t}" ${t === dtS.ticker ? 'selected' : ''}>${t}</option>`).join('')}
 </select>
 <button class="dt-ctrl" onclick="dtNewSession(dtS.ticker);renderDayTradeTab()" title="${DT_REAL[tk] ? `Pick another of the last ${DT_REAL[tk].sessions.length} real sessions` : 'Start another session'}">New day</button>
 </div>
 </div>

 <div style="padding:1rem">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem;margin-bottom:.875rem">
 <div>
 <div style="display:flex;align-items:baseline;gap:12px">
 <span id="dtPriceEl" style="font-family:'Geist',sans-serif;font-size:2rem;font-weight:800"></span>
 <span id="dtChgEl" style="font-size:.9rem;font-weight:700"></span>
 </div>
 <div style="font-size:.68rem;color:var(--text3);margin-top:3px">
 <span id="dtClockEl"></span> · ${dtDateLabel(dtS.dayIdx)} · prev close $<span id="dtPrevEl"></span> <span class="dt-src ${isReal ? 'real' : ''}">${isReal ? 'Real session' : 'Simulated'}</span>
 </div>
 </div>
 <div style="text-align:right">
 <div id="dtEquityEl" style="font-family:'Geist',sans-serif;font-size:1.3rem;font-weight:800"></div>
 <div style="font-size:.6rem;color:var(--text3);letter-spacing:.07em">ACCOUNT EQUITY</div>
 </div>
 </div>

 <div id="dtChartWrap" style="position:relative;background:var(--card2);border:1px solid var(--border);border-radius:12px;overflow:hidden">
 <canvas id="dtChart" style="width:100%;height:260px;display:block"></canvas>
 </div>

 <div style="height:5px;background:var(--border);border-radius:3px;margin-top:.75rem;overflow:hidden">
 <div id="dtProgress" style="height:100%;background:var(--accent);width:0%"></div>
 </div>

 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:.875rem">
 <button class="dt-ctrl" id="dtPlayBtn" onclick="dtTogglePlay()" style="min-width:92px"></button>
 <button class="dt-ctrl" onclick="dtStep()">Step +1m</button>
 <div style="width:1px;height:22px;background:var(--border2);margin:0 4px"></div>
 <span style="font-size:.6rem;color:var(--text3);letter-spacing:.07em">SPEED</span>
 ${[1, 5, 20, 60].map(s => `<button class="dt-ctrl dt-spd" data-s="${s}" onclick="dtSetSpeed(${s})">${s}x</button>`).join('')}
 </div>
 </div>
 </div>

 <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem" id="dtGrid">
 <div class="card" style="margin:0">
 <div class="card-hdr"><div class="card-hdr-title">Order Ticket</div></div>
 <div style="padding:1rem" id="dtOrderPanel"></div>
 </div>

 <div class="card" style="margin:0">
 <div class="card-hdr">
 <div>
 <div class="card-hdr-title">Position Sizer</div>
 <div class="card-hdr-sub">How many shares keeps your loss inside your risk budget</div>
 </div>
 </div>
 <div style="padding:1rem">
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:.625rem;margin-bottom:.875rem">
 <div><label class="dt-lbl">ACCOUNT ($)</label><input id="psAcct" class="dt-inp" type="number" value="25000" oninput="dtCalcSize()"></div>
 <div><label class="dt-lbl">RISK PER TRADE (%)</label><input id="psRisk" class="dt-inp" type="number" value="1" step="0.25" oninput="dtCalcSize()"></div>
 <div><label class="dt-lbl">ENTRY ($)</label><input id="psEntry" class="dt-inp" type="number" step="0.01" oninput="dtCalcSize()"></div>
 <div><label class="dt-lbl">STOP ($)</label><input id="psStop" class="dt-inp" type="number" step="0.01" oninput="dtCalcSize()"></div>
 <div style="grid-column:1/-1"><label class="dt-lbl">TARGET ($) — OPTIONAL</label><input id="psTarget" class="dt-inp" type="number" step="0.01" oninput="dtCalcSize()"></div>
 </div>
 <div id="psOut"></div>
 </div>
 </div>
 </div>

 <div class="card" style="margin-bottom:1.25rem">
 <div class="card-hdr">
 <div>
 <div class="card-hdr-title">Your Numbers</div>
 <div class="card-hdr-sub">Across every logged trade — this is what tells you if you have an edge</div>
 </div>
 <button class="dt-ctrl on" onclick="shareDayCard()" style="flex-shrink:0">Share card</button>
 </div>
 <div style="padding:1rem" id="dtStatsPanel"></div>
 </div>

 <div class="card" style="margin-bottom:1.25rem">
 <div class="card-hdr">
 <div>
 <div class="card-hdr-title">Import Real Trades</div>
 <div class="card-hdr-sub">Upload your broker's trade history to see your actual numbers</div>
 </div>
 </div>
 <div id="dtImportPanel"></div>
 </div>

 <div class="card">
 <div class="card-hdr">
 <div>
 <div class="card-hdr-title">Trade Journal</div>
 <div class="card-hdr-sub">Tag each trade — patterns show up fast</div>
 </div>
 <button class="dt-ctrl" onclick="dtClearJournal()" style="font-size:.65rem;padding:6px 12px">Clear</button>
 </div>
 <div id="dtJournalPanel"></div>
 </div>`;

 dtRefresh();
 dtRenderJournal();
 dtRenderImport();
 dtCalcSize();
}

function dtRefresh() {
 if (!dtS || !document.getElementById('dtChart')) return;
 const day = dtIntradayBars(dtS.ticker, dtS.dayIdx);
 const p = dtPrice();
 const chg = (p - day.prevClose) / day.prevClose * 100;
 const up = chg >= 0;
 const closed = dtS.i >= DT_BARS - 1;

 const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
 set('dtPriceEl', '$' + dtRound(p).toLocaleString('en-US', { minimumFractionDigits: 2 }));
 set('dtChgEl', `<span style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : ''}${chg.toFixed(2)}%</span>`);
 set('dtClockEl', closed ? 'Market closed' : dtClock(dtS.i));
 set('dtPrevEl', dtRound(day.prevClose).toFixed(2));

 const equity = dtS.cash + dtUnrealized();
 const eq = document.getElementById('dtEquityEl');
 if (eq) {
 eq.textContent = '$' + equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
 eq.style.color = equity >= DT_START_CASH ? 'var(--green)' : 'var(--red)';
 }

 const pb = document.getElementById('dtPlayBtn');
 if (pb) { pb.textContent = closed ? 'Day over' : dtS.playing ? '⏸ Pause' : '▶ Play'; pb.disabled = closed; pb.style.opacity = closed ? '.5' : '1'; }
 document.querySelectorAll('.dt-spd').forEach(b => b.classList.toggle('on', +b.dataset.s === dtS.speed));
 const pr = document.getElementById('dtProgress');
 if (pr) pr.style.width = (dtS.i / (DT_BARS - 1) * 100).toFixed(1) + '%';

 dtDrawChart();
 dtRenderOrderPanel();
}

function dtRenderOrderPanel() {
 const el = document.getElementById('dtOrderPanel');
 if (!el) return;
 const closed = dtS.i >= DT_BARS - 1;

 if (dtS.pos) {
 const q = dtS.pos, u = dtUnrealized(), win = u >= 0;
 const rNow = q.stop ? u / (Math.abs(q.entry - q.stop) * q.shares) : null;
 el.innerHTML = `
 <div style="background:${win ? 'rgba(0,201,122,.08)' : 'rgba(255,56,96,.07)'};border:1px solid ${win ? 'rgba(0,201,122,.3)' : 'rgba(255,56,96,.3)'};border-radius:12px;padding:1rem;margin-bottom:.875rem">
 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
 <div>
 <span style="font-family:'Geist',sans-serif;font-weight:800;font-size:1rem">${q.shares} ${dtS.ticker}</span>
 <span style="font-size:.65rem;font-weight:700;padding:3px 9px;border-radius:6px;margin-left:8px;background:${q.dir === 'long' ? 'rgba(0,201,122,.15)' : 'rgba(255,56,96,.15)'};color:${q.dir === 'long' ? 'var(--green)' : 'var(--red)'}">${q.dir.toUpperCase()}</span>
 </div>
 <div style="text-align:right">
 <div style="font-family:'Geist',sans-serif;font-size:1.2rem;font-weight:800;color:${win ? 'var(--green)' : 'var(--red)'}">${win ? '+' : ''}$${u.toFixed(2)}</div>
 ${rNow != null ? `<div style="font-size:.6rem;color:var(--text3)">${rNow >= 0 ? '+' : ''}${rNow.toFixed(2)}R</div>` : ''}
 </div>
 </div>
 <div style="display:flex;gap:1.25rem;font-size:.68rem;color:var(--text2)">
 <span>Entry <b style="color:var(--text)">$${dtRound(q.entry).toFixed(2)}</b> at ${dtClock(q.entryIdx)}</span>
 ${q.stop ? `<span>Stop <b style="color:var(--red)">$${q.stop.toFixed(2)}</b></span>` : ''}
 ${q.target ? `<span>Target <b style="color:var(--green)">$${q.target.toFixed(2)}</b></span>` : ''}
 </div>
 </div>
 <button class="dt-trade-btn" style="width:100%;background:var(--accent)" onclick="dtExit('Manual exit')">Close position</button>
 ${!q.stop ? `<div style="font-size:.68rem;color:var(--gold);margin-top:.75rem">No stop set. You're deciding your exit under pressure, which is when most traders freeze.</div>` : ''}`;
 return;
 }

 el.innerHTML = `
 <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.625rem;margin-bottom:.875rem">
 <div><label class="dt-lbl">SHARES</label><input id="dtShares" class="dt-inp" type="number" value="100" min="1"></div>
 <div><label class="dt-lbl">STOP ($)</label><input id="dtStop" class="dt-inp" type="number" step="0.01" placeholder="optional"></div>
 <div><label class="dt-lbl">TARGET ($)</label><input id="dtTarget" class="dt-inp" type="number" step="0.01" placeholder="optional"></div>
 </div>
 <div style="display:flex;gap:.625rem">
 <button class="dt-trade-btn" style="background:var(--green)" onclick="dtEnter('long')" ${closed ? 'disabled style="opacity:.4;background:var(--green)"' : ''}>Buy / Long</button>
 <button class="dt-trade-btn" style="background:var(--red)" onclick="dtEnter('short')" ${closed ? 'disabled style="opacity:.4;background:var(--red)"' : ''}>Sell / Short</button>
 </div>
 <div style="font-size:.68rem;color:var(--text3);margin-top:.75rem">Buying power $${dtS.cash.toLocaleString('en-US', { maximumFractionDigits: 0 })}${closed ? ' · market closed, start a new day' : ''}</div>`;
}

function dtDrawChart() {
 const cv = document.getElementById('dtChart');
 if (!cv) return;
 const wrap = cv.parentElement;
 // Redraw whenever the chart's box changes size, so it never stretches
 if (!wrap._dtObs) { wrap._dtObs = true; new ResizeObserver(() => { if (document.body.contains(cv)) dtDrawChart(); }).observe(wrap); }
 if (!wrap.clientWidth) return;
 const dpr = window.devicePixelRatio || 1;
 const W = wrap.clientWidth, H = Math.max(160, Math.round(cv.getBoundingClientRect().height) || 260);
 cv.width = W * dpr; cv.height = H * dpr;
 const ctx = cv.getContext('2d');
 ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
 ctx.clearRect(0, 0, W, H);

 const day = dtIntradayBars(dtS.ticker, dtS.dayIdx);
 // Only scale to what has happened so far — showing the full day's range
 // would leak the future and defeat the point of the replay.
 const seen = day.bars.slice(0, dtS.i + 1);
 const q = dtS.pos;
 const marks = [day.prevClose, ...(q ? [q.entry, q.stop, q.target].filter(Boolean) : [])];
 let lo = Math.min(...seen, ...marks), hi = Math.max(...seen, ...marks);
 const pad = (hi - lo) * 0.12 || hi * 0.01;
 lo -= pad; hi += pad;

 const PL = 8, PR = 62, PT = 12, PB = 20;
 const x = i => PL + (i / (DT_BARS - 1)) * (W - PL - PR);
 const y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

 // Previous close reference
 ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(PL, y(day.prevClose)); ctx.lineTo(W - PR, y(day.prevClose)); ctx.stroke();
 ctx.setLineDash([]);
 ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '10px Geist, sans-serif'; ctx.textAlign = 'left';
 ctx.fillText('prev close', W - PR + 6, y(day.prevClose) + 3);

 // Price path
 const last = seen[seen.length - 1];
 const up = last >= day.prevClose;
 const col = up ? '#00c97a' : '#ff3860';
 const grad = ctx.createLinearGradient(0, PT, 0, H - PB);
 grad.addColorStop(0, up ? 'rgba(0,201,122,.28)' : 'rgba(255,56,96,.25)');
 grad.addColorStop(1, 'rgba(0,0,0,0)');

 ctx.beginPath(); ctx.moveTo(x(0), y(seen[0]));
 seen.forEach((v, i) => ctx.lineTo(x(i), y(v)));
 ctx.lineTo(x(seen.length - 1), H - PB); ctx.lineTo(x(0), H - PB); ctx.closePath();
 ctx.fillStyle = grad; ctx.fill();

 ctx.beginPath(); ctx.moveTo(x(0), y(seen[0]));
 seen.forEach((v, i) => ctx.lineTo(x(i), y(v)));
 ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

 // Live price dot + label
 const lx = x(seen.length - 1), ly = y(last);
 ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
 ctx.fillStyle = col; ctx.font = '700 11px Geist, sans-serif';
 ctx.fillText('$' + dtRound(last).toFixed(2), Math.min(lx + 8, W - PR + 4), ly + 3);

 // Position overlays
 if (q) {
 const line = (v, c, label) => {
 if (!v) return;
 ctx.strokeStyle = c; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
 ctx.beginPath(); ctx.moveTo(PL, y(v)); ctx.lineTo(W - PR, y(v)); ctx.stroke();
 ctx.setLineDash([]);
 ctx.fillStyle = c; ctx.font = '600 10px Geist, sans-serif';
 ctx.fillText(label, W - PR + 6, y(v) + 3);
 };
 line(q.entry, 'rgba(168,156,255,.9)', 'entry');
 line(q.stop, 'rgba(255,56,96,.9)', 'stop');
 line(q.target, 'rgba(0,201,122,.9)', 'target');
 ctx.beginPath(); ctx.arc(x(q.entryIdx), y(q.entry), 3.5, 0, Math.PI * 2);
 ctx.fillStyle = '#a89cff'; ctx.fill();
 }

 // Session clock ticks
 ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.font = '9px Geist, sans-serif'; ctx.textAlign = 'center';
 [0, 90, 180, 270, 389].forEach(i => ctx.fillText(dtClock(i).replace(':00', ''), x(i), H - 6));
 ctx.textAlign = 'left';
}

function dtRenderJournal() {
 const j = dtJournal();
 const sp = document.getElementById('dtStatsPanel');
 const jp = document.getElementById('dtJournalPanel');
 if (!sp || !jp) return;

 const s = dtStats(j);
 if (!s) {
 sp.innerHTML = `<div style="font-size:.75rem;color:var(--text3);text-align:center;padding:1rem 0">No trades yet. Take one in the simulator and your numbers show up here.</div>`;
 jp.innerHTML = `<div style="font-size:.75rem;color:var(--text3);text-align:center;padding:1.75rem 0">Your journal is empty.</div>`;
 return;
 }

 const c = v => v >= 0 ? 'var(--green)' : 'var(--red)';
 sp.innerHTML = `
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.625rem">
 <div class="dt-stat"><div class="dt-stat-v">${s.n}</div><div class="dt-stat-l">TRADES</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${s.winRate >= .5 ? 'var(--green)' : 'var(--gold)'}">${(s.winRate * 100).toFixed(0)}%</div><div class="dt-stat-l">WIN RATE</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${c(s.net)}">${s.net >= 0 ? '+' : ''}$${s.net.toFixed(0)}</div><div class="dt-stat-l">NET P&amp;L</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${c(s.expectancy)}">${s.expectancy >= 0 ? '+' : ''}$${s.expectancy.toFixed(2)}</div><div class="dt-stat-l">PER TRADE</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${s.profitFactor >= 1.5 ? 'var(--green)' : s.profitFactor >= 1 ? 'var(--gold)' : 'var(--red)'}">${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}</div><div class="dt-stat-l">PROFIT FACTOR</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:${s.avgR == null ? 'var(--text3)' : c(s.avgR)}">${s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R'}</div><div class="dt-stat-l">AVG R</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:var(--green)">+$${s.best.toFixed(0)}</div><div class="dt-stat-l">BEST</div></div>
 <div class="dt-stat"><div class="dt-stat-v" style="color:var(--red)">$${s.worst.toFixed(0)}</div><div class="dt-stat-l">WORST</div></div>
 </div>
 <div style="font-size:.7rem;color:var(--text2);margin-top:.875rem;line-height:1.6">
 ${s.expectancy >= 0
 ? `Your average trade makes <b style="color:var(--green)">$${s.expectancy.toFixed(2)}</b>. Over ${s.n} trades that edge is what compounds — but ${s.n < 30 ? 'under 30 trades is still mostly luck' : 'keep sample size in mind'}.`
 : `Your average trade loses <b style="color:var(--red)">$${Math.abs(s.expectancy).toFixed(2)}</b>. ${s.winRate >= .5 ? 'You win often but your losses are bigger than your wins — the fix is usually tighter stops or letting winners run.' : 'Both your hit rate and your ratio need work. Try halving your size while you experiment.'}`}
 </div>`;

 jp.innerHTML = `
 <div class="dt-jrow" style="color:var(--text3);font-size:.58rem;letter-spacing:.07em;font-weight:600;border-bottom:1px solid var(--border2)">
 <div>DATE</div><div>TICKER</div><div class="dt-hide">ENTRY → EXIT</div><div>SETUP / FEEL</div><div style="text-align:right">P&amp;L</div><div style="text-align:right">R</div>
 </div>
 ${j.slice(0, 60).map(t => `
 <div class="dt-jrow">
 <div style="color:var(--text3)">${t.date.replace(/,? \d{4}$/, '')}</div>
 <div>
 <div style="font-weight:700">${escapeHTML(t.ticker)}</div>
 <div style="font-size:.55rem;color:${t.dir === 'long' ? 'var(--green)' : 'var(--red)'}">${t.dir.toUpperCase()}</div>
 </div>
 <div class="dt-hide" style="color:var(--text2)">
 $${t.entry} → $${t.exit}
 <div style="font-size:.55rem;color:var(--text3)">${t.entryTime} · ${escapeHTML(t.heldLabel || (t.held + 'm'))} · ${escapeHTML(t.reason)}</div>
 </div>
 <div style="display:flex;gap:5px">
 <select class="dt-sel" onchange="dtTag('${t.id}','setup',this.value)">
 <option value="">setup…</option>
 ${DT_SETUPS.map(o => `<option ${t.setup === o ? 'selected' : ''}>${o}</option>`).join('')}
 </select>
 <select class="dt-sel" onchange="dtTag('${t.id}','emotion',this.value)">
 <option value="">feel…</option>
 ${DT_EMOTIONS.map(o => `<option ${t.emotion === o ? 'selected' : ''}>${o}</option>`).join('')}
 </select>
 </div>
 <div style="text-align:right;font-weight:700;color:${c(t.pnl)}">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</div>
 <div style="text-align:right;color:${t.r == null ? 'var(--text3)' : c(t.r)}">${t.r == null ? '—' : (t.r >= 0 ? '+' : '') + t.r.toFixed(1) + 'R'}</div>
 </div>`).join('')}`;
}

function renderScreener() {
 clMark('cl_screener');
 refreshChecklist();
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 localStorage.setItem('ss_screener_used_' + (user?.email || ''), '1');

 const sectors = [...new Set(Object.values(ASSET_DATA).map(d => d[2]))].filter(Boolean);
 const examples = ['AI stocks','Safe dividend','High growth tech','Crypto','Cybersecurity','Beginner-friendly','Streaming','Electric vehicles'];

 mc.innerHTML = `
 <!-- AI Narrative Search -->
 <div class="card" style="margin-bottom:1rem;border-color:rgba(168,85,247,.3)">
 <div class="card-hdr" style="background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(168,85,247,.02))">
 <div class="card-hdr-title" style="color:var(--green)">🔍 Find Stocks by Idea</div>
 <div class="card-hdr-sub">Describe what you're looking for in plain English</div>
 </div>
 <div style="padding:1rem">
 <div style="display:flex;gap:8px;margin-bottom:.75rem">
 <input id="scr-narrative" type="text" placeholder='Try: "safe dividend stocks" or "high growth AI companies"'
 style="flex:1;background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:11px 14px;color:var(--text);font-family:inherit;font-size:.85rem;outline:none;transition:border-color .2s"
 onfocus="this.style.borderColor='#a855f7'" onblur="this.style.borderColor='var(--border2)'"
 onkeydown="if(event.key==='Enter')runNarrativeSearch()"/>
 <button onclick="runNarrativeSearch()" style="background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(168,85,247,.15));color:#a855f7;border:1px solid rgba(168,85,247,.4);border-radius:10px;padding:11px 20px;font-family:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap">Search →</button>
 </div>
 <div style="display:flex;flex-wrap:wrap;gap:6px">
 ${examples.map(ex => `<button onclick="document.getElementById('scr-narrative').value='${ex}';runNarrativeSearch()" style="background:var(--card2);border:1px solid var(--border2);border-radius:20px;padding:4px 12px;font-family:inherit;font-size:.7rem;color:var(--text2);cursor:pointer;transition:all .15s" onmouseover="this.style.borderColor='#a855f7';this.style.color='#a855f7'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text2)'">${ex}</button>`).join('')}
 </div>
 </div>
 </div>

 <!-- Saved Presets -->
 <div id="scr-presets-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:.875rem">
 <span style="font-size:.72rem;color:var(--text3);font-weight:600;letter-spacing:.06em;white-space:nowrap">SAVED:</span>
 <div id="scr-preset-pills" style="display:flex;gap:6px;flex-wrap:wrap;flex:1"></div>
 <div style="display:flex;gap:6px;align-items:center;margin-left:auto">
 <input id="scr-preset-name" type="text" placeholder="Preset name…" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:6px 10px;color:var(--text);font-family:inherit;font-size:.75rem;outline:none;width:120px" />
 <button onclick="saveScreenerPreset()" style="background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(168,85,247,.12));color:#a855f7;border:1px solid rgba(168,85,247,.4);border-radius:8px;padding:6px 12px;font-family:inherit;font-size:.75rem;font-weight:700;cursor:pointer;white-space:nowrap">Save</button>
 </div>
 </div>

 <!-- Classic Filters -->
 <div id="scr-filter-row" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1rem;align-items:center">
 <select id="scr-sector" onchange="clearNarrative();applyScreener()" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:.78rem;outline:none">
 <option value="all">All Sectors</option>
 ${sectors.map(s => `<option value="${s}">${s}</option>`).join('')}
 </select>
 <select id="scr-risk" onchange="clearNarrative();applyScreener()" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:.78rem;outline:none">
 <option value="all">All Risk Levels</option>
 <option value="low">Low Risk (β &lt; 1)</option>
 <option value="high">High Risk (β ≥ 1)</option>
 </select>
 <select id="scr-growth" onchange="clearNarrative();applyScreener()" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:.78rem;outline:none">
 <option value="0">Any Growth</option>
 <option value="10">10%+ Growth</option>
 <option value="20">20%+ Growth</option>
 <option value="30">30%+ Growth</option>
 </select>
 <select id="scr-rsi" onchange="clearNarrative();applyScreener()" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:.78rem;outline:none">
 <option value="all">Any RSI</option>
 <option value="oversold">Oversold (RSI &lt; 35)</option>
 <option value="neutral">Neutral (RSI 35–65)</option>
 <option value="overbought">Overbought (RSI &gt; 65)</option>
 </select>
 <select id="scr-verdict" onchange="clearNarrative();applyScreener()" style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:7px 10px;color:var(--text);font-family:inherit;font-size:.78rem;outline:none">
 <option value="all">Any Verdict</option>
 <option value="Buy">Verdict: Buy</option>
 <option value="Hold">Verdict: Hold</option>
 <option value="Sell">Verdict: Sell</option>
 </select>
 <span id="scr-count" style="font-size:.72rem;color:var(--text3);margin-left:auto"></span>
 </div>
 <div id="scr-results"></div>`;
 applyScreener();
 renderScreenerPresets();
}

function renderScreenerPresets() {
 const container = document.getElementById('scr-preset-pills');
 if (!container) return;
 const presets = JSON.parse(localStorage.getItem('ss_scr_presets')||'[]');
 if (!presets.length) { container.innerHTML = '<span style="font-size:.72rem;color:var(--text3);font-style:italic">None saved yet</span>'; return; }
 container.innerHTML = presets.map((p,i) => `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.35);border-radius:20px;padding:4px 10px 4px 12px;font-size:.72rem;color:#a855f7;font-weight:600;cursor:pointer" onclick="loadScreenerPreset(${i})" title="Click to apply">${p.name}<button onclick="event.stopPropagation();deleteScreenerPreset(${i})" style="background:none;border:none;color:rgba(168,85,247,.7);cursor:pointer;font-size:.7rem;padding:0;line-height:1;margin-left:2px">✕</button></span>`).join('');
}
function saveScreenerPreset() {
 const name = (document.getElementById('scr-preset-name')?.value||'').trim();
 if (!name) { toast('Enter a preset name first','info',2000); return; }
 const presets = JSON.parse(localStorage.getItem('ss_scr_presets')||'[]');
 if (presets.length >= 5) { toast('Max 5 presets — delete one first','info',2500); return; }
 const filters = {
 sector: document.getElementById('scr-sector')?.value||'all',
 risk: document.getElementById('scr-risk')?.value||'all',
 growth: document.getElementById('scr-growth')?.value||'0',
 rsi: document.getElementById('scr-rsi')?.value||'all',
 verdict: document.getElementById('scr-verdict')?.value||'all',
 };
 presets.push({name, filters});
 localStorage.setItem('ss_scr_presets', JSON.stringify(presets));
 if (document.getElementById('scr-preset-name')) document.getElementById('scr-preset-name').value = '';
 renderScreenerPresets();
 toast(`Preset "${name}" saved!`,'success',2000);
}
function loadScreenerPreset(i) {
 const presets = JSON.parse(localStorage.getItem('ss_scr_presets')||'[]');
 const p = presets[i]; if (!p) return;
 const f = p.filters;
 if (document.getElementById('scr-sector')) document.getElementById('scr-sector').value = f.sector||'all';
 if (document.getElementById('scr-risk')) document.getElementById('scr-risk').value = f.risk||'all';
 if (document.getElementById('scr-growth')) document.getElementById('scr-growth').value = f.growth||'0';
 if (document.getElementById('scr-rsi')) document.getElementById('scr-rsi').value = f.rsi||'all';
 if (document.getElementById('scr-verdict')) document.getElementById('scr-verdict').value = f.verdict||'all';
 clearNarrative();
 applyScreener();
 toast(`Preset "${p.name}" applied`,'success',1800);
}
function deleteScreenerPreset(i) {
 const presets = JSON.parse(localStorage.getItem('ss_scr_presets')||'[]');
 presets.splice(i, 1);
 localStorage.setItem('ss_scr_presets', JSON.stringify(presets));
 renderScreenerPresets();
}

function clearNarrative() {
 const el = document.getElementById('scr-narrative');
 if (el) el.value = '';
}

function runNarrativeSearch() {
 const q = document.getElementById('scr-narrative')?.value || '';
 if (!q.trim()) { applyScreener(); return; }
 const rule = parseNarrativeQuery(q);
 if (!rule) {
 const cnt = document.getElementById('scr-count');
 if (cnt) cnt.textContent = 'No match — try "AI stocks" or "safe dividend"';
 applyScreener();
 return;
 }
 applyNarrativeResults(rule);
}

function renderScreenerTable(filtered, el, page = 0) {
 const fitRows = matchMedia('(min-width:1024px) and (min-height:620px)').matches && el.clientHeight > 220;
 const SCR_PAGE = fitRows ? Math.max(4, Math.floor((el.clientHeight - 44 - 56) / 40)) : 10;
 renderScreenerTable._h = el.clientHeight;
 renderScreenerTable._last = { filtered, el };
 const pages = Math.max(1, Math.ceil(filtered.length / SCR_PAGE));
 page = Math.min(Math.max(0, page), pages - 1);
 renderScreenerTable._page = page;
 const shown = filtered.slice(page * SCR_PAGE, page * SCR_PAGE + SCR_PAGE);
 if (!filtered.length) {
 el.innerHTML = `<div class="empty-state">
 <div class="empty-state-art" style="font-size:2.5rem"></div>
 <div class="empty-state-title" style="font-size:.9rem">No stocks match</div>
 <div class="empty-state-sub" style="font-size:.73rem">Try a different search or adjust the filters above.</div>
 <button class="empty-state-btn" onclick="clearNarrative();document.getElementById('scr-sector').value='all';document.getElementById('scr-risk').value='all';document.getElementById('scr-growth').value='0';applyScreener()">Reset</button>
 </div>`; return;
 }
 el.innerHTML = `<div class="card" style="overflow:auto">
 <table class="scr-table" style="width:100%;border-collapse:collapse;font-size:.78rem">
 <thead><tr style="border-bottom:1px solid var(--border)">
 <th style="padding:.5rem .875rem;text-align:left;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600">TICKER</th>
 <th style="padding:.5rem .875rem;text-align:left;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600">NAME</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600">SECTOR</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600" title="How much it moves compared with the S&amp;P 500 (2 years of weekly prices)">BETA</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600" title="Typical yearly price swing, from the last year of daily prices">VOLATILITY</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600" title="14-day RSI from real closing prices">RSI</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600" title="Average yearly price growth over the last 5 years">5Y GROWTH</th>
 <th style="padding:.5rem .875rem;text-align:center;color:var(--text3);font-size:.62rem;letter-spacing:.06em;font-weight:600">AI</th>
 </tr></thead>
 <tbody>${shown.map(s => {
 const rsi = s.rsi;
 const rsiColor = rsi == null ? 'var(--text3)' : rsi < 35 ? 'var(--green)' : rsi > 65 ? 'var(--red)' : 'var(--text2)';
 const rsiLabel = rsi == null ? '—' : rsi < 35 ? `${rsi} ↓` : rsi > 65 ? `${rsi} ↑` : `${rsi}`;
 const volColor = s.vol >= 60 ? 'var(--red)' : s.vol >= 35 ? 'var(--gold)' : 'var(--text2)';
 const verdict = s.verdict || '—';
 const vColor = verdict==='Buy'||verdict==='Strong Buy' ? 'var(--green)' : verdict==='Sell' ? 'var(--red)' : 'var(--gold)';
 return `<tr style="border-bottom:1px solid var(--border);cursor:pointer" onclick="goAsset('${s.t}','${s.k || 's'}')" onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background=''">
 <td style="padding:.625rem .875rem;font-family:'Geist',sans-serif;font-weight:800;color:var(--accent2);white-space:nowrap">${s.t}${s.live === false ? `<small class="scr-yrs" title="No real price data for this one yet, so these numbers are estimates">est.</small>` : ''}</td>
 <td style="padding:.625rem .875rem;color:var(--text2)">${s.name}</td>
 <td style="padding:.625rem .875rem;text-align:center;color:var(--text3);font-size:.72rem">${s.sector||''}</td>
 <td style="padding:.625rem .875rem;text-align:center;font-variant-numeric:tabular-nums">${s.beta}x</td>
 <td style="padding:.625rem .875rem;text-align:center;color:${volColor};font-variant-numeric:tabular-nums">${s.vol}%</td>
 <td style="padding:.625rem .875rem;text-align:center;color:${rsiColor};font-weight:600;font-variant-numeric:tabular-nums">${rsiLabel}</td>
 <td style="padding:.625rem .875rem;text-align:center;font-variant-numeric:tabular-nums;color:${s.growth>=20?'var(--green)':s.growth>=10?'var(--gold)':s.growth<0?'var(--red)':'var(--text2)'}"${s.years && s.years < 4.5 ? ` title="Only ${s.years.toFixed(1)} years of price history so far"` : ''}>${fmtGrowth(s.growth)}${s.years && s.years < 4.5 ? `<small class="scr-yrs">${Math.max(1, Math.round(s.years))}y</small>` : ''}</td>
 <td style="padding:.625rem .875rem;text-align:center;font-size:.68rem;font-weight:700;color:${vColor}">${verdict}</td>
 </tr>`;
 }).join('')}</tbody>
 </table>
 ${pages > 1 ? `<div class="scr-pager">
 <span>${page * SCR_PAGE + 1}-${Math.min(filtered.length, (page + 1) * SCR_PAGE)} of ${filtered.length}</span>
 <div>
 <button type="button" class="dash-btn" onclick="scrPage(-1)" ${page === 0 ? 'disabled' : ''}>Previous</button>
 <button type="button" class="dash-btn" onclick="scrPage(1)" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
 </div>
 </div>` : ''}
 </div>`;
 if (fitRows || matchMedia('(min-width:1024px) and (min-height:620px)').matches) requestAnimationFrame(() => {
  if (el.isConnected && el.clientHeight > 220 && el.clientHeight !== renderScreenerTable._h) renderScreenerTable(filtered, el, page);
 });
}

window.addEventListener('resize', () => {
 clearTimeout(renderScreenerTable._rt);
 renderScreenerTable._rt = setTimeout(() => {
  const last = renderScreenerTable._last;
  if (!last || !last.el.isConnected || last.el.clientHeight === renderScreenerTable._h) return;
  renderScreenerTable(last.filtered, last.el, 0);
 }, 150);
});

function scrPage(delta) {
 const last = renderScreenerTable._last;
 if (last) renderScreenerTable(last.filtered, last.el, (renderScreenerTable._page || 0) + delta);
}

// One screener row: real numbers when available, the hand-entered estimate otherwise
function scrRow(t) {
 const d = assetData(t), st = liveStats(t);
 const found = TICKERS.find(tk => tk.t === t);
 return { t, name: found?.n || t, beta: d[0], vol: d[1], sector: d[2], growth: d[3], k: found?.k || tickerKind(t),
  rsi: st?.rsi != null ? Math.round(st.rsi) : null, ret1y: st?.ret1y ?? null, years: st?.years ?? null, live: !!st, verdict: verdictFor(t)?.verdict || null };
}

function applyScreener() {
 const el = document.getElementById('scr-results'); if (!el) return;
 const sector = document.getElementById('scr-sector')?.value || 'all';
 const risk = document.getElementById('scr-risk')?.value || 'all';
 const minGrow = parseFloat(document.getElementById('scr-growth')?.value || '0');
 const rsiFilter = document.getElementById('scr-rsi')?.value || 'all';
 const verdictFilter = document.getElementById('scr-verdict')?.value || 'all';

 const universe = Object.keys(ASSET_DATA);
 const liveCount = universe.filter(t => liveStats(t)).length;
 const stale = universe.some(statsStale) || universe.some(factsStale);
 if (stale && !applyScreener._loading && Date.now() - (applyScreener._tried || 0) > 60000) {
  applyScreener._loading = true;
  applyScreener._tried = Date.now();
  Promise.all([fetchStats(universe.map(t => [t, tickerKind(t)])), fetchFacts(universe.map(t => [t, tickerKind(t)]))]).then(() => {
   applyScreener._loading = false;
   applyScreener._failed = !universe.some(t => liveStats(t));
   if (document.getElementById('scr-results')) {
    const q = document.getElementById('scr-narrative')?.value.trim();
    q ? runNarrativeSearch() : applyScreener();
   }
  });
 }
 if (!liveCount && applyScreener._loading) {
  el.innerHTML = `<div class="card scr-loading"><span class="fc-spark"></span><b>Crunching real prices</b><small>Working out volatility, beta, growth and RSI for ${universe.length} assets from 5 years of daily data</small></div>`;
  const cnt0 = document.getElementById('scr-count'); if (cnt0) cnt0.textContent = '';
  return;
 }
 const all = universe.map(t => scrRow(t));

 const filtered = all.filter(s =>
 (sector === 'all' || s.sector === sector) &&
 (risk === 'all' || (risk === 'low' ? s.beta < 1 : s.beta >= 1)) &&
 (minGrow <= 0 || s.growth >= minGrow) &&
 (rsiFilter === 'all' || (s.rsi != null && (rsiFilter === 'oversold' ? s.rsi < 35 : rsiFilter === 'overbought' ? s.rsi > 65 : s.rsi >= 35 && s.rsi <= 65))) &&
 (verdictFilter === 'all' || (s.verdict || '').endsWith(verdictFilter))
 ).sort((a,b) => b.growth - a.growth);

 const cnt = document.getElementById('scr-count');
 if (cnt) cnt.innerHTML = `${filtered.length} found <span class="scr-src ${liveCount ? 'on' : ''}" title="${liveCount ? 'Volatility, beta, growth and RSI are calculated from real daily prices (Yahoo Finance), refreshed every few hours' : 'Real numbers are unavailable right now, so these are estimates'}">${liveCount ? 'Real data' : applyScreener._failed ? 'Estimates' : 'Loading real data'}</span>`;
 renderScreenerTable(filtered, el);
}

/* ════════════════════════════════
 EARNINGS CALENDAR (dynamic, never stale)
════════════════════════════════ */


const PRIVATE_COMPANIES = {
 'SPACEX':{'name':'SpaceX','desc':'Privately held aerospace company by Elon Musk. Not publicly traded.'},
 'OPENAI':{'name':'OpenAI','desc':'Privately held AI company. Not publicly traded.'},
 'STRIPE':{'name':'Stripe','desc':'Privately held payments company. Not publicly traded.'},
 'KLARNA':{'name':'Klarna','desc':'Privately held BNPL company. Not publicly traded.'},
 'DATABRICKS':{'name':'Databricks','desc':'Privately held data & AI company. Not publicly traded.'},
 'CHIME':{'name':'Chime','desc':'Privately held fintech company. Not publicly traded.'},
 'EPIC':{'name':'Epic Games','desc':'Privately held video game company. Not publicly traded.'},
};

async function verifyTicker(ticker, name, type, overrideSym) {
 if (!ticker) return;
 const upper = ticker.toUpperCase();
 // Normalize type
 const k = type === 'crypto' ? 'c' : type === 'index' ? 'i' : type === 'stock' ? 's' : (type || 's');
 const local = TICKERS.find(e => e.t === upper);
 if (local) { renderAsset(upper, local.n, local.k, overrideSym); return; }
 const priv = PRIVATE_COMPANIES[upper];
 if (priv) { renderNotFound(upper, priv.name, k, 'private', priv.desc, []); return; }
 try {
 const res = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(upper)}&hl=1&exchange=&lang=en&search_type=undefined&domain=production&sort_by_country=US`);
 const data = await res.json();
 const match = data?.symbols?.find(s => s.symbol?.toUpperCase() === upper || s.symbol?.toUpperCase().endsWith(':'+upper));
 if (match) {
 const sym = (match.prefix ? match.prefix + ':' : '') + match.symbol;
 const assetType = k || (match.type === 'crypto' ? 'c' : match.type === 'index' ? 'i' : 's');
 renderAsset(upper, match.description || name || upper, assetType, sym);
 return;
 }
 } catch {}
 const suggestions = TICKERS.filter(t2 => t2.n.toLowerCase().includes(upper.toLowerCase()) || t2.t.startsWith(upper.slice(0,2))).slice(0,4).map(t2=>t2.t);
 renderNotFound(upper, name || upper, k, 'notfound', null, suggestions);
}

function renderNotFound(ticker, name, type, reason, privateInfo, suggestions) {
 currentAsset = ticker;
 const mc = document.getElementById('mainContent');
 const ss = document.getElementById('searchSection');
 if (ss) ss.style.display = 'none';
 if (!mc) return;
 if (user && reason === 'notfound') {
 try { localStorage.setItem('ss_secret1_'+(user?.email||''), '1'); } catch {}
 setTimeout(() => checkAndAwardBadges(), 500);
 }
 const isPrivate = reason === 'private';
 const color = isPrivate ? 'var(--gold)' : 'var(--red)';
 mc.innerHTML = `
 <button onclick="currentAsset=null;var _s=document.getElementById('searchSection');if(_s)_s.style.display='block';renderHome(tab);" style="background:none;border:none;color:var(--text2);font-family:inherit;font-size:.82rem;cursor:pointer;padding:0;margin-bottom:1.5rem;display:inline-flex;align-items:center;gap:5px;transition:color .15s" onmouseover="this.style.color='var(--accent2)'" onmouseout="this.style.color='var(--text2)'">← Back</button>
 <div style="text-align:center;padding:3rem 1rem">
 <div style="font-size:3.5rem;margin-bottom:1rem">${isPrivate ? '🔒' : '🔍'}</div>
 <div style="font-family:'Geist',sans-serif;font-size:1.3rem;font-weight:800;color:${color};margin-bottom:.5rem">${isPrivate ? 'Private Company' : 'Stock Not Found'}</div>
 <div style="font-size:.88rem;color:var(--text2);margin-bottom:1rem">
 ${isPrivate ? `<strong>${name}</strong> is privately held.<br><span style="font-size:.78rem;color:var(--text3)">${privateInfo||''}</span>` : `We couldn't find a stock with the symbol <strong style="color:var(--accent2)">${ticker}</strong>.`}
 </div>
 ${suggestions?.length ? `<div style="font-size:.75rem;color:var(--text3);margin-bottom:.75rem">Did you mean:</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${suggestions.map(s=>`<button onclick="goAsset('${s}','s')" class="sh-chip" style="font-size:.82rem;padding:6px 14px">${s}</button>`).join('')}</div>` : ''}
 </div>`;
}


/* ════════════════════════════════
 SIMULATED NEWS FEED
════════════════════════════════ */
function renderNewsCards(containerId, ticker, name) {
 const el = document.getElementById(containerId);
 if (!el) return;
 const seed = ticker.split('').reduce((a,c) => a + c.charCodeAt(0), 0);
 const templates = [
 {src:'Reuters', sentiment:'bullish', headlines:[`${name} beats earnings expectations, raises full-year guidance`,`Analysts upgrade ${ticker} after strong quarterly results`,`${name} announces $2B share buyback program`]},
 {src:'Bloomberg', sentiment:'neutral', headlines:[`${ticker} stock flat as investors await Fed decision`,`${name} CFO discusses growth strategy in exclusive interview`,`Market volatility keeps ${ticker} range-bound this week`]},
 {src:'CNBC', sentiment:'bearish', headlines:[`${name} shares slip on broader market selloff`,`Analysts flag margin pressure risks for ${ticker}`,`Institutional investors reduce exposure to ${ticker}`]},
 {src:'WSJ', sentiment:'bullish', headlines:[`${name} sees accelerating demand in key segments`,`${ticker} quietly becoming the AI play no one talks about`,`Why ${name} could be the decade's best long-term hold`]},
 {src:'MarketWatch',sentiment:'neutral',headlines:[`${ticker} consolidates near support ahead of earnings`,`Here's what ${name}'s latest SEC filing actually says`,`5 things to watch with ${ticker} this quarter`]},
 ];
 const sentColors = {bullish:'var(--green)', bearish:'var(--red)', neutral:'var(--gold)'};
 const sentBg = {bullish:'rgba(0,201,122,.1)', bearish:'rgba(255,56,96,.1)', neutral:'rgba(245,158,11,.1)'};
 const cards = [0,1,2,3,4].map(i => {
 const t = templates[(seed + i) % templates.length];
 const hl = t.headlines[(seed * (i+1)) % t.headlines.length];
 const minsAgo = [12, 38, 75, 220, 442][i];
 const timeStr = minsAgo < 60 ? `${minsAgo}m ago` : `${Math.floor(minsAgo/60)}h ago`;
 return `<div style="padding:.875rem;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s" onmouseover="this.style.background='var(--card2)'" onmouseout="this.style.background=''">
 <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
 <span style="font-size:.6rem;font-weight:700;padding:2px 8px;border-radius:10px;background:${sentBg[t.sentiment]};color:${sentColors[t.sentiment]};border:1px solid ${sentColors[t.sentiment]}33">${t.sentiment.toUpperCase()}</span>
 <span style="font-size:.62rem;color:var(--text3);font-weight:600">${t.src}</span>
 <span style="font-size:.6rem;color:var(--text3);margin-left:auto">${timeStr}</span>
 </div>
 <div style="font-size:.78rem;color:var(--text);line-height:1.55;font-weight:500">${hl}</div>
 </div>`;
 }).join('');
 const section = document.createElement('div');
 section.innerHTML = `<div class="card" style="margin-bottom:1rem;overflow:hidden">
 <div class="card-hdr">
 <div class="card-hdr-title"> Latest News</div>
 <div class="card-hdr-sub" style="font-size:.6rem;color:var(--text3)">simulated for demo</div>
 </div>
 ${cards}
 </div>`;
 el.appendChild(section);
}

/* ════════════════════════════════
 SECTION TABS + ONE-SCREEN LAYOUTS
 Secondary cards fold into tabbed cards; each view is tagged so CSS can
 lay it out as a single screen on desktop.
════════════════════════════════ */
function ssTabSelect(wrap, i, save) {
 const tabs = wrap.querySelectorAll(':scope > .ss-tabs-bar > .ss-tab');
 const panels = wrap.querySelectorAll(':scope > .ss-tabs-body > .ss-panel');
 if (!tabs[i]) i = 0;
 tabs.forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-selected', j === i); b.tabIndex = j === i ? 0 : -1; });
 panels.forEach((p, j) => p.classList.toggle('on', j === i));
 if (save && tabs[i] && !wrap.dataset.ssNosave) { try { localStorage.setItem('ss_tab_' + wrap.dataset.ssGroup, tabs[i].textContent); } catch {} }
 tabs[i]?.dispatchEvent(new CustomEvent('ss-show'));
 window.dispatchEvent(new Event('resize'));
 ssInk(wrap.querySelector(':scope > .ss-tabs-bar'));
}

function ssBindTabs(wrap) {
 if (!wrap) return;
 const bar = wrap.querySelector(':scope > .ss-tabs-bar');
 const tabs = [...bar.querySelectorAll(':scope > .ss-tab')];
 tabs.forEach((b, j) => { b.onclick = () => ssTabSelect(wrap, j, true); b.tabIndex = b.classList.contains('on') ? 0 : -1; });
 requestAnimationFrame(() => ssInk(bar));
 bar.onkeydown = e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const cur = tabs.findIndex(b => b.classList.contains('on'));
  const n = (cur + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  ssTabSelect(wrap, n, true);
  tabs[n].focus();
  e.preventDefault();
 };
}

// items: [{el, label, order}]. Items sharing a label share one panel.
function ssTabify(key, items, anchor) {
 items = items.filter(it => it.el && it.el.isConnected && !it.el.closest('.ss-tabs'));
 let wrap = document.querySelector(`.ss-tabs[data-ss-group="${key}"]`);
 if (!items.length || (!wrap && new Set(items.map(i => i.label)).size < 2)) return wrap;
 if (!wrap) {
  wrap = document.createElement('section');
  wrap.className = 'card ss-tabs';
  wrap.dataset.ssGroup = key;
  wrap.innerHTML = '<div class="ss-tabs-bar" role="tablist"></div><div class="ss-tabs-body"></div>';
  if (anchor && anchor.isConnected) anchor.after(wrap); else items[0].el.before(wrap);
 }
 const bar = wrap.querySelector(':scope > .ss-tabs-bar');
 const body = wrap.querySelector(':scope > .ss-tabs-body');
 items.forEach((it, n) => {
  const order = it.order ?? n;
  const oldParent = it.el.parentElement;
  const tabs = [...bar.querySelectorAll(':scope > .ss-tab')];
  const same = tabs.findIndex(b => b.textContent === it.label);
  if (same >= 0) {
   const panel = body.children[same];
   panel.appendChild(it.el);
   panel.classList.toggle('multi', panel.children.length > 1);
  } else {
   const btn = document.createElement('button');
   btn.type = 'button'; btn.className = 'ss-tab'; btn.setAttribute('role', 'tab');
   btn.textContent = it.label; btn.dataset.order = order;
   const panel = document.createElement('div');
   panel.className = 'ss-panel'; panel.setAttribute('role', 'tabpanel');
   panel.appendChild(it.el);
   const before = tabs.findIndex(b => Number(b.dataset.order ?? -99) > order);
   if (before >= 0) { tabs[before].before(btn); body.children[before].before(panel); }
   else if (tabs.length) { tabs[tabs.length - 1].after(btn); body.appendChild(panel); }
   else { bar.prepend(btn); body.appendChild(panel); }
  }
  if (oldParent && !oldParent.id && !oldParent.children.length && !oldParent.textContent.trim()) oldParent.remove();
 });
 ssBindTabs(wrap);
 const tabs = [...bar.querySelectorAll(':scope > .ss-tab')];
 const cur = tabs.findIndex(b => b.classList.contains('on'));
 let saved = null;
 if (!wrap.dataset.ssNosave) { try { saved = localStorage.getItem('ss_tab_' + key); } catch {} }
 ssTabSelect(wrap, cur >= 0 ? cur : Math.max(0, tabs.findIndex(b => b.textContent === saved)), false);
 return wrap;
}

const SS_TAB_ROOTS = ['mainContent', 'homeSections', 'cmpOut'];
const SS_TAB_GROUPS = [
 { key: 'home', when: mc => mc.querySelector('.dash-stage'), anchor: () => null, items: [
  [mc => mc.querySelector('#obChecklistWrap .ob-check-card') && mc.querySelector('#obChecklistWrap'), 'Get started', 0],
  [/Top movers/i, 'Top movers', 1],
  [/Daily Market Brief|happening in markets|going on today/i, 'Market pulse', 2],
  [/^Fear & Greed|scared or greedy|scared or excited/i, 'Market pulse', 2],
  [/Crypto Fear/i, 'Market pulse', 2],
  [/Sector Heatmap|industries|types of businesses/i, 'Sectors', 3],
  [/News Feed|market news|in the news/i, 'News', 4],
  [/Upcoming Earnings/i, 'Calendar', 5], [/Economic Calendar/i, 'Calendar', 5],
  [/Stock of the Day/i, 'Spotlight', 6], [/Trending on/i, 'Spotlight', 6], [/Recommended for You/i, 'Spotlight', 6],
 ] },
 { key: 'pt', when: () => ssFindCard(/^Open Positions/i), anchor: () => ssFindCard(/^Open Positions/i), items: [
  [/Pending Orders/i, 'Pending', 0], [/^Allocation/i, 'Allocation', 1], [/Risk Lab/i, 'Risk lab', 2],
  [/Portfolio Insight/i, 'Insight', 3], [/Trade History/i, 'History', 4], [/Leaderboard/i, 'Leaderboard', 5], [/^Stress test/i, 'Stress test', 2.5],
 ] },
 { key: 'day', when: () => ssFindCard(/Order Ticket/i), anchor: mc => mc.querySelector('#dtGrid'), items: [
  [/Position Sizer/i, 'Position sizer', 0], [/Your Numbers/i, 'Your numbers', 1], [/Trade Journal/i, 'Journal', 2], [/Import Real Trades/i, 'Import trades', 3],
 ] },
 { key: 'cmp', when: mc => mc.querySelector('#cca'), anchor: mc => mc.querySelector('#cmpOut .two-col:has(#cca)'), items: [
  [mc => mc.querySelector('#cmpOut .two-col:has(#cca)'), 'Price charts', 0],
  [mc => mc.querySelector('#cmpOut .two-col:has(#cta)'), 'Technical', 1],
 ] },
];

function ssCardTitle(card) {
 return (card.querySelector(':scope > .card-hdr .card-hdr-title')?.textContent || '').replace(/[^\w&$.,'?!—\- ]/g, '').trim();
}

function ssFindCard(re) {
 const mc = document.getElementById('mainContent');
 return [...mc.querySelectorAll('.card')].find(c =>
  !c.closest('.ss-tabs') && !c.parentElement.closest('.card') && c.style.display !== 'none' && re.test(ssCardTitle(c)));
}

function ssPanelFor(card) {
 const p = card.parentElement;
 return p && p.id && !SS_TAB_ROOTS.includes(p.id) && p.children.length === 1 ? p : card;
}

// Marks the pieces of each view so the one-screen grid CSS can place them
function ssTagLayout(mc) {
 const v = mc.dataset.view;
 const kids = [...mc.children];
 if (v === 'pt') {
  kids.find(k => !k.classList.contains('card') && /STOCKS &(amp;)? INDEXES/i.test(k.textContent.slice(0, 160)))?.classList.add('pt-status');
  kids.find(k => !k.classList.contains('card') && k.querySelector('.pt-btn'))?.classList.add('pt-head');
  ssFindCard(/^Open Positions/i)?.classList.add('pt-pos');
 } else if (v === 'day') {
  ssFindCard(/Day Trade Simulator/i)?.classList.add('dt-sim');
 } else if (v === 'port') {
  if (kids[0] && !kids[0].classList.contains('card')) kids[0].classList.add('port-sum');
 } else if (v === 'screen') {
  kids.find(k => k.classList.contains('card') && k.querySelector('#scr-narrative'))?.classList.add('scr-idea');
 } else if (v === 'cmp') {
  kids[0]?.classList.add('cmp-intro');
  const out = document.getElementById('cmpOut');
  if (out) {
   out.querySelector(':scope > .two-col:not(:has(#cca)):not(:has(#cta))')?.classList.add('cmp-heads');
   [...out.children].find(k => k.classList.contains('card'))?.classList.add('cmp-stats');
  }
 }
}

function ssApplyTabGroups() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 const ob = mc.querySelector('.ss-panel > #obChecklistWrap');
 if (ob && (!ob.querySelector('.ob-check-card') || ob.style.display === 'none')) {
  const panel = ob.parentElement, wrap = panel.closest('.ss-tabs');
  const i = [...panel.parentElement.children].indexOf(panel);
  wrap.querySelectorAll(':scope > .ss-tabs-bar > .ss-tab')[i]?.remove();
  wrap.after(ob);
  panel.remove();
  ssBindTabs(wrap);
  ssTabSelect(wrap, 0, false);
 }
 SS_TAB_GROUPS.forEach(g => {
  if (!g.when(mc)) return;
  const items = g.items.map(([find, label, order]) => {
   if (typeof find === 'function') { const el = find(mc); return el ? { el, label, order } : null; }
   const card = ssFindCard(find);
   return card ? { el: ssPanelFor(card), label, order } : null;
  }).filter(Boolean);
  ssTabify(g.key, items, g.anchor(mc));
 });
 ssTagLayout(mc);
}

(() => {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 let queued = false;
 const obs = new MutationObserver(() => {
  if (queued) return;
  queued = true;
  setTimeout(() => {
   queued = false;
   obs.disconnect();
   try { ssApplyTabGroups(); } finally { obs.observe(mc, { childList: true, subtree: true }); }
  }, 40);
 });
 obs.observe(mc, { childList: true, subtree: true });
})();


/* ── Motion helpers ── */
function moveNavPill() {
 const bar = document.getElementById('tabBar');
 if (!bar) return;
 let pill = bar.querySelector(':scope > .nav-pill');
 if (!pill) { pill = document.createElement('span'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); bar.prepend(pill); }
 const on = bar.querySelector('.tab[class*="on-"]');
 if (!on || !on.offsetHeight) { pill.style.opacity = '0'; bar.classList.remove('has-pill'); return; }
 const first = !bar.classList.contains('has-pill');
 if (first) pill.style.transition = 'none';
 pill.style.transform = `translateY(${on.offsetTop}px)`;
 pill.style.height = on.offsetHeight + 'px';
 pill.style.opacity = '1';
 bar.classList.add('has-pill');
 if (first) { void pill.offsetWidth; pill.style.transition = ''; }
}
function ssInk(bar) {
 if (!bar) return;
 const on = bar.querySelector(':scope > .ss-tab.on');
 if (!on || !on.offsetWidth) return;
 const first = !bar.classList.contains('has-ink');
 bar.style.setProperty('--ink-x', on.offsetLeft + 'px');
 bar.style.setProperty('--ink-w', on.offsetWidth + 'px');
 bar.classList.add('has-ink');
 if (first) requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('ink-anim')));
}
window.addEventListener('resize', () => {
 moveNavPill();
 document.querySelectorAll('.ss-tabs-bar.has-ink').forEach(ssInk);
});
// Whatever a tab renders eases in, in order
(() => {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 new MutationObserver(muts => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const added = new Set();
  muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1 && n.parentNode === mc) added.add(n); }));
  if (!added.size) return;
  let i = 0;
  [...mc.children].forEach(c => {
   if (!added.has(c)) return;
   c.style.setProperty('--mc-d', Math.min(i++, 8) * 45 + 'ms');
   c.classList.remove('mc-in'); void c.offsetWidth; c.classList.add('mc-in');
  });
 }).observe(mc, { childList: true });
})();

/* ════════════════════════════════
 MARKETS PAGE: live readings
 /api/market (CNN Fear & Greed, crypto Fear & Greed, US economic calendar),
 sector funds and index levels from /api/quotes, earnings dates from /api/fundamentals.
════════════════════════════════ */
let _mktReq = null, _mktAt = 0;
function getMarketData() {
 if (!_mktReq || Date.now() - _mktAt > 10 * 60000) {
  _mktAt = Date.now();
  _mktReq = fetch('/api/market').then(r => r.ok ? r.json() : null).catch(() => null).then(d => { if (!d) _mktAt = 0; return d; });
 }
 return _mktReq;
}
const SECTOR_ETFS = [
 ['Technology', 'XLK'], ['Semiconductors', 'SMH'], ['Software', 'IGV'], ['Communication', 'XLC'], ['Consumer Discretionary', 'XLY'],
 ['Consumer Staples', 'XLP'], ['Financials', 'XLF'], ['Healthcare', 'XLV'], ['Biotech', 'IBB'], ['Energy', 'XLE'],
 ['Utilities', 'XLU'], ['Industrials', 'XLI'], ['Aerospace & Defense', 'ITA'], ['Materials', 'XLB'], ['Real Estate', 'XLRE'],
 ['Retail', 'XRT'], ['Clean Energy', 'ICLN'], ['Cybersecurity', 'CIBR'], ['Gold', 'GLD'], ['Bitcoin', 'BTC'],
];
const sectorItems = () => SECTOR_ETFS.map(([, t]) => [t, t === 'BTC' ? 'c' : 's']);
const EARN_WATCH = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V', 'MA', 'LLY', 'UNH', 'XOM', 'WMT', 'COST', 'NFLX', 'AMD', 'ORCL', 'CRM', 'ADBE', 'INTC', 'DIS', 'BAC', 'KO', 'PEP', 'NKE', 'PLTR', 'UBER', 'COIN'];
const etTime = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
const fgColor = s => s < 25 ? 'var(--red)' : s < 45 ? '#f97316' : s <= 55 ? 'var(--gold)' : s <= 75 ? '#84cc16' : 'var(--green)';

function fgGaugeSVG(score) {
 const seg = (a0, a1, col) => {
  const p = a => [100 + 80 * Math.cos(Math.PI * (1 - a / 100)), 100 - 80 * Math.sin(Math.PI * (1 - a / 100))];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A 80 80 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${col}" stroke-width="14" fill="none" stroke-linecap="butt"/>`;
 };
 const ang = Math.PI * (1 - score / 100), nx = 100 + 64 * Math.cos(ang), ny = 100 - 64 * Math.sin(ang);
 return `<svg viewBox="0 0 200 112" class="fg-gauge" role="img" aria-label="Gauge at ${score} of 100">
  ${seg(0.5, 24.5, 'var(--red)')}${seg(25.5, 44.5, '#f97316')}${seg(45.5, 55.5, 'var(--gold)')}${seg(56.5, 75.5, '#84cc16')}${seg(76.5, 99.5, 'var(--green)')}
  <line x1="100" y1="100" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--text)" stroke-width="3" stroke-linecap="round" class="fg-needle"/>
  <circle cx="100" cy="100" r="6" fill="var(--text)"/>
  <text x="18" y="111" font-size="9" fill="var(--text3)">Fear</text><text x="182" y="111" font-size="9" fill="var(--text3)" text-anchor="end">Greed</text>
 </svg>`;
}

async function renderFearGreed(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = `<div class="fg-box">${rsLoading('Reading market sentiment')}</div>`;
 const d = await getMarketData();
 if (!document.body.contains(el)) return;
 const g = d?.fearGreed;
 if (!g) { el.innerHTML = '<p class="fc-muted" style="padding:1rem">Sentiment data is unavailable right now.</p>'; return; }
 const cmp = (label, v) => v == null ? '' : `<div><span>${label}</span><b style="color:${fgColor(v)}">${v}</b></div>`;
 el.innerHTML = `
  <div class="fg-box">
   ${fgGaugeSVG(g.score)}
   <div class="fg-read"><b style="color:${fgColor(g.score)}">${g.score}</b><span>${escapeHTML(g.rating)}</span></div>
   <div class="fg-cmp">${cmp('Yesterday', g.previousClose)}${cmp('1 week ago', g.weekAgo)}${cmp('1 month ago', g.monthAgo)}${cmp('1 year ago', g.yearAgo)}</div>
   <p class="fg-note">${/fear/i.test(g.rating) ? 'Investors are nervous. Fear can mean prices are on sale, or that trouble is coming.' : /greed/i.test(g.rating) ? 'Investors are confident. Greed can push prices higher, but extreme greed often comes before pullbacks.' : 'Investors are neither scared nor greedy right now.'} Source: ${escapeHTML(g.source)}.</p>
  </div>`;
}

async function renderCryptoFearGreed(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = rsLoading();
 const d = await getMarketData();
 if (!document.body.contains(el)) return;
 const g = d?.cryptoFearGreed;
 if (!g) { el.innerHTML = '<p class="fc-muted" style="padding:1rem">Crypto sentiment is unavailable right now.</p>'; return; }
 el.innerHTML = `
  <div class="fg-box fg-sm">
   ${fgGaugeSVG(g.score)}
   <div class="fg-read"><b style="color:${fgColor(g.score)}">${g.score}</b><span>${escapeHTML(g.rating)}</span></div>
   <div class="fg-cmp">${g.yesterday != null ? `<div><span>Yesterday</span><b style="color:${fgColor(g.yesterday)}">${g.yesterday}</b></div>` : ''}${g.weekAgo != null ? `<div><span>1 week ago</span><b style="color:${fgColor(g.weekAgo)}">${g.weekAgo}</b></div>` : ''}</div>
   <p class="fg-note">Built from crypto price swings, trading volume, social media and Bitcoin's share of the market. Source: alternative.me.</p>
  </div>`;
}

async function renderSectorHeatmap(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = `<div class="heatmap-grid">${SECTOR_ETFS.map(([n]) => `<div class="hm-cell hm-skel"><div class="hm-name">${n}</div><div class="hm-pct"><span class="skel-txt"></span></div></div>`).join('')}</div>`;
 const q = await fetchQuotes(sectorItems());
 if (!document.body.contains(el)) return;
 const rows = SECTOR_ETFS.map(([name, t]) => ({ name, t, pct: q[t]?.changePct ?? null })).filter(r => r.pct != null);
 if (!rows.length) { el.innerHTML = '<p class="fc-muted" style="padding:1rem">Sector prices are unavailable right now.</p>'; return; }
 el.innerHTML = `<div class="heatmap-grid">${rows.map(s => {
  const up = s.pct >= 0, k = Math.min(1, Math.abs(s.pct) / 2.5);
  const bg = up ? `color-mix(in srgb,var(--green) ${Math.round(6 + k * 26)}%,var(--card))` : `color-mix(in srgb,var(--red) ${Math.round(6 + k * 26)}%,var(--card))`;
  return `<button type="button" class="hm-cell" style="background:${bg}" onclick="goAsset('${s.t}','${s.t === 'BTC' ? 'c' : 's'}')" title="${s.name} via ${s.t}">
   <div class="hm-name">${s.name}</div><div class="hm-pct" style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : ''}${s.pct.toFixed(2)}%</div><small class="hm-etf">${s.t}</small>
  </button>`;
 }).join('')}</div><p class="fg-note" style="padding:0 1rem .75rem">Today's change in each sector's main fund (sector ETFs). Tap a tile to research it.</p>`;
}

// Today's brief, written from live numbers
function getDailyBrief() {
 setTimeout(fillDailyBrief, 60);
 return `<div id="dailyBrief" class="brief"><span class="skel-txt" style="width:92%"></span><span class="skel-txt" style="width:80%"></span><span class="skel-txt" style="width:66%"></span></div>`;
}
async function fillDailyBrief() {
 const el = document.getElementById('dailyBrief');
 if (!el) return;
 const idx = [['SPX', 'i'], ['IXIC', 'i'], ['DJI', 'i'], ['VIX', 'i']];
 const [q, mk] = await Promise.all([fetchQuotes([...idx, ...sectorItems()]), getMarketData()]);
 fetchFacts(EARN_WATCH.map(t => [t, 's'])).then(() => { const e = document.getElementById('briefEarn'); if (e) e.outerHTML = briefEarnings(); });
 if (!document.body.contains(el)) return;
 const pct = t => q[t]?.changePct;
 const say = (v, d = 1) => v == null ? 'flat' : `${v >= 0 ? 'up' : 'down'} ${Math.abs(v).toFixed(d)}%`;
 const open = typeof isMarketOpen === 'function' && isMarketOpen();
 const parts = [];
 if (q.SPX) parts.push(`${open ? 'So far today' : 'At the last close'}, the <b>S&amp;P 500</b> is ${say(pct('SPX'))} at ${Math.round(q.SPX.price).toLocaleString()}, the <b>Nasdaq</b> is ${say(pct('IXIC'))} and the <b>Dow</b> is ${say(pct('DJI'))}.`);
 const secs = SECTOR_ETFS.filter(([, t]) => t !== 'BTC' && t !== 'GLD').map(([n, t]) => ({ n, v: pct(t) })).filter(s => s.v != null).sort((a, b) => b.v - a.v);
 if (secs.length > 2) parts.push(`${secs[0].n} led (${secs[0].v >= 0 ? '+' : ''}${secs[0].v.toFixed(1)}%) while ${secs[secs.length - 1].n} lagged (${secs[secs.length - 1].v >= 0 ? '+' : ''}${secs[secs.length - 1].v.toFixed(1)}%).`);
 if (q.VIX) parts.push(`The VIX "fear gauge" is ${q.VIX.price.toFixed(1)}, ${q.VIX.price < 15 ? 'which is calm' : q.VIX.price < 20 ? 'about normal' : q.VIX.price < 30 ? 'which is elevated' : 'which signals high stress'}.`);
 const fg = mk?.fearGreed;
 if (fg) parts.push(`The Fear &amp; Greed Index reads <b>${fg.score}</b> (${escapeHTML(fg.rating.toLowerCase())})${fg.previousClose != null ? `, ${fg.score > fg.previousClose ? 'up' : fg.score < fg.previousClose ? 'down' : 'unchanged'} from ${fg.previousClose} yesterday` : ''}.`);
 if (q.BTC) parts.push(`Bitcoin is ${say(pct('BTC'))} at ${fmtPx(q.BTC.price).replace(/\.\d+$/, '')}.`);
 const next = (mk?.econ || []).find(e => new Date(e.date) > Date.now() && e.impact === 'High') || (mk?.econ || []).find(e => new Date(e.date) > Date.now());
 if (next) parts.push(`Next big release: <b>${escapeHTML(next.title)}</b>, ${etTime(next.date)}${next.forecast ? ` (forecast ${escapeHTML(next.forecast)})` : ''}.`);
 el.innerHTML = parts.length ? `<p>${parts.join(' ')}</p>${briefEarnings()}<small class="brief-src">Written from live prices (Yahoo Finance), CNN's Fear &amp; Greed Index and the economic calendar.</small>` : '<p>Live market numbers are unavailable right now.</p>';
}
function briefEarnings() {
 const soon = upcomingEarnings(7);
 return soon.length ? `<p id="briefEarn">Reporting earnings this week: ${soon.slice(0, 6).map(e => `<button type="button" class="brief-tk" onclick="goAsset('${e.t}','s')">${e.t}</button> ${new Date(e.ts * 1000).toLocaleDateString('en-US', { weekday: 'short' })}`).join(', ')}.</p>` : '<p id="briefEarn" hidden></p>';
}
function upcomingEarnings(days) {
 const now = Date.now();
 return EARN_WATCH.map(t => ({ t, f: factsFor(t) })).filter(x => x.f?.nextEarnings)
  .map(x => ({ t: x.t, ts: x.f.nextEarnings, eps: x.f.nextEpsEstimate, name: rsName(x.t, x.f) }))
  .filter(e => e.ts * 1000 > now - 86400000 && e.ts * 1000 < now + days * 86400000)
  .sort((a, b) => a.ts - b.ts);
}

async function renderEarningsCalendar(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 if (!upcomingEarnings(45).length) el.innerHTML = rsLoading('Checking report dates');
 await fetchFacts(EARN_WATCH.map(t => [t, 's']));
 if (!document.body.contains(el)) return;
 const list = upcomingEarnings(45);
 if (!list.length) { el.innerHTML = '<p class="fc-muted">No big-company earnings in the next six weeks.</p>'; return; }
 el.innerHTML = `<ul class="ec-list">${list.slice(0, 12).map(e => {
  const dd = Math.round((e.ts * 1000 - Date.now()) / 86400000);
  return `<li><button type="button" onclick="goAsset('${e.t}','s')"><span class="ec-date"><b>${new Date(e.ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</b><small>${dd <= 0 ? 'Today' : dd === 1 ? 'Tomorrow' : `in ${dd} days`}</small></span><span class="ec-name"><b>${e.t}</b><small>${escapeHTML(e.name)}</small></span><span class="ec-eps">${e.eps != null ? `<small>EPS est.</small><b>$${e.eps.toFixed(2)}</b>` : ''}</span></button></li>`;
 }).join('')}</ul><p class="fg-note">Report dates and estimates from Yahoo Finance.</p>`;
}

const ECON_EXPLAIN = [
 [/FOMC|Federal Funds|Fed Chair|Powell|Interest Rate/i, 'The Federal Reserve sets interest rates. Lower rates usually help stocks; higher rates usually weigh on them.'],
 [/CPI|Consumer Price/i, 'Measures how fast prices are rising. Hotter inflation can mean higher interest rates for longer.'],
 [/PCE/i, 'The Fed\'s favorite inflation gauge. It moves rate expectations.'],
 [/Non-Farm|Payrolls|Unemployment|Jobless|Employment|ADP/i, 'A read on the job market. Strong hiring means a healthy economy, but can also keep rates high.'],
 [/GDP/i, 'The total size of the US economy. Two shrinking quarters in a row is a common definition of recession.'],
 [/Retail Sales/i, 'How much Americans spent at stores. Consumer spending drives most of the economy.'],
 [/PMI|ISM/i, 'A survey of purchasing managers. Above 50 means the sector is growing, below 50 means it\'s shrinking.'],
 [/Consumer (Confidence|Sentiment)/i, 'How optimistic people feel. Confident consumers tend to spend more.'],
 [/PPI|Producer Price/i, 'Prices businesses pay. It often hints at where consumer inflation is heading.'],
 [/Housing|Home Sales|Building Permits|Housing Starts/i, 'A read on the housing market, which is very sensitive to interest rates.'],
 [/Treasury|Auction|Bond/i, 'Government bond sales. Weak demand can push interest rates up.'],
];
async function renderEconomicCalendar(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 el.innerHTML = `<div class="card"><div class="card-hdr"><div class="card-hdr-title">Economic Calendar</div><div class="card-hdr-sub">US releases this week and next · live</div></div><div id="econBody" style="padding:.25rem 1rem 1rem">${rsLoading()}</div></div>`;
 const d = await getMarketData();
 const body = document.getElementById('econBody');
 if (!body) return;
 const all = d?.econ || [];
 const upcoming = all.filter(e => new Date(e.date) > Date.now() - 6 * 3600e3);
 const ev = upcoming.length ? upcoming : all.slice(-10).reverse();
 const sub = el.querySelector('.card-hdr-sub');
 if (sub && !upcoming.length && ev.length) sub.textContent = 'Latest US releases · next week’s schedule posts on the weekend';
 if (!ev.length) { body.innerHTML = '<p class="fc-muted">The economic calendar is unavailable right now.</p>'; return; }
 body.innerHTML = `<ul class="econ-list">${ev.slice(0, 14).map(e => {
  const why = ECON_EXPLAIN.find(([re]) => re.test(e.title))?.[1];
  return `<li class="econ-${e.impact.toLowerCase()}"><div class="econ-top"><span class="econ-time">${etTime(e.date)}</span><b>${escapeHTML(e.title)}</b><em>${e.impact}</em></div>
   ${e.forecast || e.previous || e.actual ? `<div class="econ-nums">${e.actual ? `<span>Actual <b>${escapeHTML(e.actual)}</b></span>` : ''}${e.forecast ? `<span>Forecast <b>${escapeHTML(e.forecast)}</b></span>` : ''}${e.previous ? `<span>Previous <b>${escapeHTML(e.previous)}</b></span>` : ''}</div>` : ''}
   ${why ? `<p>${why}</p>` : ''}</li>`;
 }).join('')}</ul><p class="fg-note">Schedule from the Forex Factory calendar feed. Times are US Eastern.</p>`;
}
async function renderNewsSentimentGuide(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 const d = await getMarketData();
 if (!document.body.contains(el)) return;
 const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
 const ev = (d?.econ || []).filter(e => new Date(e.date).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === today);
 el.innerHTML = ev.length ? `<div class="news-today"><span>Today:</span>${ev.map(e => `<em class="econ-${e.impact.toLowerCase()}">${escapeHTML(e.title)} · ${new Date(e.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET</em>`).join('')}</div>` : '';
}

async function renderStockOfDay(containerId) {
 const el = document.getElementById(containerId);
 if (!el) return;
 const pool = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'META', 'AMZN', 'GOOGL', 'AMD', 'NFLX', 'PLTR', 'JPM', 'V', 'COIN', 'SOFI', 'RDDT', 'HIMS', 'CRWD', 'NET', 'SNOW', 'DDOG', 'COST', 'LLY', 'AVGO', 'UBER', 'SHOP'];
 const dayIdx = Math.floor(Date.now() / 86400000);
 const t = pool[dayIdx % pool.length];
 const found = TICKERS.find(e => e.t === t) || { t, n: t, k: 's' };
 el.innerHTML = `<div class="card-hdr"><div class="card-hdr-title">Stock of the Day</div><div class="card-hdr-sub">A new company every day · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></div><div class="sotd-body">${rsLoading()}</div>`;
 await Promise.all([fetchFacts([[t, found.k]]), fetchStats([[t, found.k], ['SPX', 'i']]), fetchQuotes([[t, found.k]])]);
 const body = el.querySelector('.sotd-body');
 if (!body) return;
 const R = verdictFor(t);
 if (!R) { body.innerHTML = `<p class="fc-muted">Data for ${t} is unavailable right now.</p>`; return; }
 const P = researchPoints(R), f = R.facts, st = R.stats, col = VERDICT_COLOR[R.verdict];
 const up = f.targetMean && R.price ? f.targetMean / R.price - 1 : null;
 body.innerHTML = `
  <button type="button" class="sotd-main" onclick="goAsset('${t}','${found.k}')">
   <div class="sotd-top"><div><b>${t}</b><span>${escapeHTML(rsName(t, f))}</span></div><div class="sotd-v"><small>Verdict</small><b style="color:${col}">${R.verdict}</b><span>${R.score}/100</span></div></div>
   <div class="sotd-stats">
    <div><small>Past year</small><b class="${(st.ret1y ?? 0) >= 0 ? 'up' : 'down'}">${fmtSigned(st.ret1y, 0)}</b></div>
    <div><small>Analyst target</small><b>${up != null ? fmtSigned(up, 0) : '—'}</b></div>
    <div><small>Swings a year</small><b>${st.vol != null ? fmtPlain(st.vol, 0) : '—'}</b></div>
   </div>
   ${P.good[0] ? `<p class="sotd-why"><b>Why it stands out:</b> ${P.good[0].mid}</p>` : ''}
   ${P.bad[0] ? `<p class="sotd-why bad"><b>Watch:</b> ${P.bad[0].mid}</p>` : ''}
   <span class="sotd-cta">Open the full research →</span>
  </button>`;
}

async function renderAIRecommendations(containerId) {
 const el = document.getElementById(containerId);
 if (!el || !user) return;
 const recs = getAIRecommendations();
 if (!recs || !recs.length) { el.innerHTML = ''; return; }
 await Promise.all([fetchFacts(recs.map(r => [r.ticker, tickerKind(r.ticker)])), fetchStats(recs.map(r => [r.ticker, tickerKind(r.ticker)]))]);
 if (!document.body.contains(el)) return;
 el.innerHTML = `<div class="card" style="margin-bottom:1rem">
  <div class="card-hdr"><div class="card-hdr-title">Recommended for You</div><div class="card-hdr-sub">From the sectors you picked · scored on real data</div></div>
  <div class="recs">${recs.map(r => {
   const f = TICKERS.find(x => x.t === r.ticker) || { n: r.ticker, k: 's' }, R = verdictFor(r.ticker);
   return `<button type="button" onclick="goAsset('${r.ticker}','${f.k || 's'}')"><b>${r.ticker}</b><small>${escapeHTML(f.n.slice(0, 22))}</small><em>${escapeHTML(r.sector)}</em>${R ? `<span style="color:${VERDICT_COLOR[R.verdict]}">${R.verdict} · ${R.score}</span>` : ''}</button>`;
  }).join('')}</div></div>`;
}

/* ════════════════════════════════
 RIGHT RAIL — practice portfolio, watchlist quotes, market news
════════════════════════════════ */
const NEWS_TOPIC_IMAGES = [
 [/nvidia|chip|semiconductor|\bamd\b|intel|tsmc|broadcom|\bai\b|openai/i, 'chips'],
 [/bitcoin|crypto|ether|coinbase|blockchain|tokeni/i, 'crypto'],
 [/\bfed\b|powell|interest rate|rate cut|inflation|treasur|yield|\bcpi\b|jobs|economy|tariff/i, 'fed'],
 [/\boil\b|opec|crude|energy|natural gas|exxon|chevron/i, 'energy'],
 [/tesla|\bev\b|electric vehicle|\bford\b|\bgm\b|automak/i, 'autos'],
 [/retail|walmart|target|amazon|consumer|shopp|costco|spending/i, 'retail'],
 [/earnings|revenue|profit|guidance|quarter|\bceo\b|merger|acquisition|\bdeal\b|\bipo\b/i, 'earnings'],
 [/wall street|\bdow\b|s&p|nasdaq|stocks|market/i, 'wall-street'],
];
const NEWS_FALLBACK_IMAGES = ['markets', 'markets-2', 'bull', 'mobile-trading'];
const RAIL_POPULAR = [
 {ticker:'AAPL', name:'Apple', type:'s'}, {ticker:'NVDA', name:'NVIDIA', type:'s'},
 {ticker:'MSFT', name:'Microsoft', type:'s'}, {ticker:'TSLA', name:'Tesla', type:'s'},
 {ticker:'BTC', name:'Bitcoin', type:'c'},
];
let _railNews = null, _railNewsLoading = false, _railWlKey = '';

function newsImageFor(title, i) {
 const hit = NEWS_TOPIC_IMAGES.find(([re]) => re.test(title));
 return `/images/news/${hit ? hit[1] : NEWS_FALLBACK_IMAGES[i % NEWS_FALLBACK_IMAGES.length]}.jpg`;
}

function railTimeAgo(ms) {
 if (!ms) return '';
 const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
 if (m < 60) return `${m}m ago`;
 const h = Math.round(m / 60);
 return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function railMoney(n, signed=false) {
 const s = Math.abs(n).toLocaleString('en-US', {style:'currency', currency:'USD'});
 if (!signed) return n < 0 ? '-' + s : s;
 return (n >= 0 ? '+' : '-') + s;
}

function railVisible() {
 const el = document.getElementById('ssRail');
 return !!el && el.offsetParent !== null;
}

function renderRail() {
 const el = document.getElementById('ssRail');
 if (!el) return;
 if (!el.dataset.ready) {
  el.innerHTML = `
  <section class="rail-sec" id="railPort"></section>
  <section class="rail-sec">
   <div class="rail-h"><h3 id="railWlTitle">Watchlist</h3><button type="button" class="rail-link" id="railWlLink" onclick="switchTab('w')">View all</button></div>
   <div id="railWl" class="rail-wl"></div>
  </section>
  <section class="rail-sec">
   <div class="rail-h"><h3>Market news</h3></div>
   <div id="railNews" class="rail-news"></div>
  </section>
  <p class="rail-legal">StockSight is for information only and is not financial advice. Always do your own research before investing.</p>`;
  el.dataset.ready = '1';
 }
 renderRailPortfolio();
 if (!railVisible()) return;
 renderRailWatchlist();
 renderRailNews();
}

const RAIL_COLLAPSE_BTN = `<button type="button" class="rail-collapse" onclick="toggleRail(false)" aria-label="Hide this panel" data-tip="Hide panel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg></button>`;

function toggleRail(open) {
 const shell = document.querySelector('.ss-shell');
 if (!shell) return;
 const collapsed = open === undefined ? !shell.classList.contains('rail-collapsed') : !open;
 shell.classList.toggle('rail-collapsed', collapsed);
 try { localStorage.setItem('ss_rail_collapsed', collapsed ? '1' : '0'); } catch {}
 const t = document.getElementById('railToggle');
 if (t) { t.setAttribute('aria-pressed', String(!collapsed)); t.dataset.tip = collapsed ? 'Show portfolio panel' : 'Hide portfolio panel'; }
 setTimeout(() => { window.dispatchEvent(new Event('resize')); if (!collapsed) renderRail(); }, 460);
}
try {
 if (localStorage.getItem('ss_rail_collapsed') === '1') {
  document.querySelector('.ss-shell')?.classList.add('rail-collapsed');
  const t = document.getElementById('railToggle');
  if (t) { t.setAttribute('aria-pressed', 'false'); t.dataset.tip = 'Show portfolio panel'; }
 }
} catch {}

function renderRailPortfolio() {
 const box = document.getElementById('railPort');
 if (!box) return;
 if (!user) {
  box.innerHTML = `
  <div class="rail-h"><h3>Paper trading</h3>${RAIL_COLLAPSE_BTN}</div>
  <p class="rail-muted">Make a free account to paper trade with $10,000 of pretend money and follow how you do.</p>
  <button type="button" class="rail-cta" onclick="openModal('signup')">Create free account</button>`;
  return;
 }
 const pt = getPtPortfolio();
 const rows = Object.entries(pt.holdings || {})
  .map(([t, h]) => {
   const shares = typeof h === 'object' && h ? Number(h.shares) || 0 : Number(h) || 0;
   const p = ptDailyPrice(t);
   const avg = typeof h === 'object' && h && h.avgCost ? Number(h.avgCost) : null;
   return { t, shares, value: shares * p, day: shares * (p - ptDailyPrice_yesterday(t)), pl: avg ? (p - avg) / avg * 100 : null };
  })
  .filter(r => r.shares > 0)
  .sort((a, b) => b.value - a.value);
 const cash = Number(pt.cash) || 0;
 const invested = rows.reduce((s, r) => s + r.value, 0);
 const total = cash + invested;
 const pl = total - 10000;
 const day = rows.reduce((s, r) => s + r.day, 0);

 const slices = rows.slice(0, 4).map((r, i) => ({ label: r.t, value: r.value, cls: 'd' + (i + 1) }));
 const other = rows.slice(4).reduce((s, r) => s + r.value, 0);
 if (other > 0) slices.push({ label: 'Other', value: other, cls: 'd5' });
 if (cash > 0) slices.push({ label: 'Cash', value: cash, cls: 'dc' });
 const C = 2 * Math.PI * 30;
 let offset = 0;
 const arcs = slices.map(s => {
  const len = total > 0 ? (s.value / total) * C : 0;
  const arc = `<circle class="${s.cls}" cx="38" cy="38" r="30" fill="none" stroke-width="10" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
  offset += len;
  return arc;
 }).join('');
 const pct = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

 box.innerHTML = `
 <div class="rail-h"><h3>Paper trading</h3><div class="rail-h-actions"><button type="button" class="rail-link" onclick="switchTab('pt')">Trade</button>${RAIL_COLLAPSE_BTN}</div></div>
 <div class="rail-port">
  <div>
   <div class="rail-label">Account value</div>
   <div class="rail-big">${railMoney(total)}</div>
   <div class="rail-delta ${pl >= 0 ? 'up' : 'dn'}">${railMoney(pl, true)} (${(pl / 100).toFixed(2)}%) all time</div>
  </div>
  <svg class="rail-donut" width="76" height="76" viewBox="0 0 76 76" role="img" aria-label="Where your money is">
   <circle class="dbg" cx="38" cy="38" r="30" fill="none" stroke-width="10"/>${arcs}
  </svg>
 </div>
 ${rows.length ? `<div class="rail-pos">
  ${rows.slice(0, 4).map((r, i) => `<button type="button" class="rail-pos-row" onclick="goAsset('${r.t}','${TICKERS.find(e => e.t === r.t)?.k || 's'}')">
   <i class="d${i + 1}"></i><b>${escapeHTML(r.t)}</b><span class="rp-sh">${+r.shares.toFixed(4)} sh</span><span class="rp-val">${railMoney(r.value)}</span>${r.pl === null ? '<span></span>' : `<span class="${r.pl >= 0 ? 'up' : 'dn'}">${pct(r.pl)}</span>`}
  </button>`).join('')}
  ${rows.length > 4 ? `<button type="button" class="rail-pos-more" onclick="switchTab('pt')">+${rows.length - 4} more positions</button>` : ''}
 </div>` : `<div class="rail-empty"><p>No positions yet. Buy your first stock with pretend money.</p><button type="button" class="rail-cta" onclick="switchTab('pt')">Make a practice trade</button></div>`}
 <div class="rail-stats rail-stats-2">
  <div><span>Today</span><b class="${day >= 0 ? 'up' : 'dn'}">${railMoney(day, true)}</b></div>
  <div><span>Buying power</span><b>${railMoney(cash)}</b></div>
 </div>`;
}

function renderRailWatchlist() {
 const box = document.getElementById('railWl');
 if (!box) return;
 const mine = user && watchlist.length ? watchlist.slice(0, 8) : null;
 const list = mine || RAIL_POPULAR;
 document.getElementById('railWlTitle').textContent = mine ? 'Watchlist' : 'Popular right now';
 document.getElementById('railWlLink').hidden = !mine;
 const key = theme + '|' + list.map(w => w.ticker).join(',');
 if (key === _railWlKey && box.childElementCount) return;
 _railWlKey = key;
 box.innerHTML = `<div id="railWlTv" style="height:${list.length * 46 + 52}px"></div>`;
 injectTV('railWlTv', {
  colorTheme: theme, isTransparent: true, locale: 'en', showSymbolLogo: true, height: '100%',
  symbolsGroups: [{ name: mine ? 'Watchlist' : 'Popular', symbols: list.map(w => ({ name: tvSym(w.ticker, w.type || 's'), displayName: w.name || w.ticker })) }],
 }, 'market-quotes');
}

function renderRailNews() {
 const box = document.getElementById('railNews');
 if (!box) return;
 if (_railNews) { paintRailNews(box); return; }
 if (_railNewsLoading) return;
 _railNewsLoading = true;
 box.innerHTML = Array.from({length: 4}, () => '<div class="rail-news-skel"><i></i><div><b></b><b></b></div></div>').join('');
 fetch('/api/news')
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(d => { _railNews = (d.items || []).filter(n => /^https?:\/\//i.test(n.link)).slice(0, 6); paintRailNews(box); })
  .catch(() => { box.innerHTML = '<p class="rail-muted">News is unavailable right now. Check back in a few minutes.</p>'; })
  .finally(() => { _railNewsLoading = false; });
}

function paintRailNews(box) {
 if (!_railNews.length) { box.innerHTML = '<p class="rail-muted">No headlines yet today.</p>'; return; }
 box.innerHTML = _railNews.map((n, i) => {
  const local = newsImageFor(n.title, i);
  const img = /^https:\/\//i.test(n.image || '') ? n.image : local;
  return `<a class="rail-news-item" href="${escapeHTML(n.link)}" target="_blank" rel="noopener noreferrer">
   <img src="${escapeHTML(img)}" data-fallback="${local}" alt="" width="72" height="52" loading="lazy" onerror="if(!this.src.endsWith(this.dataset.fallback)){this.src=this.dataset.fallback}">
   <div><div class="rail-news-title">${escapeHTML(n.title)}</div><div class="rail-news-meta">${escapeHTML(n.source)}<span>${railTimeAgo(n.published)}</span></div></div>
  </a>`;
 }).join('');
}

new MutationObserver(() => { _railWlKey = ''; if (railVisible()) renderRailWatchlist(); })
 .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(min-width:1280px)').addEventListener('change', e => { if (e.matches) renderRail(); });

/* ════════════════════════════════
 TICKER TAPE
════════════════════════════════ */
function initTickerTape() {
 const TAPE_TICKERS = [
 {sym:'SPY', base:525.40, type:'s'}, {sym:'QQQ', base:449.80, type:'s'},
 {sym:'DIA', base:398.20, type:'s'}, {sym:'AAPL', base:189.30, type:'s'},
 {sym:'NVDA', base:875.40, type:'s'}, {sym:'TSLA', base:248.60, type:'s'},
 {sym:'MSFT', base:415.20, type:'s'}, {sym:'GOOGL', base:172.80, type:'s'},
 {sym:'META', base:496.30, type:'s'}, {sym:'AMZN', base:182.50, type:'s'},
 {sym:'BTC', base:67420, type:'c'}, {sym:'ETH', base:3840, type:'c'},
 {sym:'SOL', base:162.40, type:'c'}, {sym:'VIX', base:14.80, type:'i'},
 ];
 const prices = {};
 TAPE_TICKERS.forEach(t => {
 const seed = t.sym.charCodeAt(0) * 13 + (t.sym.charCodeAt(1) || 0) * 7;
 prices[t.sym] = t.base * (1 + ((seed % 20) - 10) / 100);
 });
 function buildItems() {
 return TAPE_TICKERS.map(t => {
 const p = prices[t.sym];
 const chg = ((p - t.base) / t.base * 100);
 const up = chg >= 0;
 const fmt = p >= 1000 ? p.toFixed(0) : p.toFixed(2);
 return `<div class="tk-item" onclick="document.getElementById('si').value='${t.sym}';doSearch()">
 <span class="tk-sym">${t.sym}</span>
 <span class="tk-chg ${up?'up':'dn'}">${up?'▲':'▼'} ${Math.abs(chg).toFixed(2)}%</span>
 </div>`;
 }).join('');
 }
 function updateTape() {
 TAPE_TICKERS.forEach(t => { prices[t.sym] *= (1 + (Math.random() - 0.498) * 0.003); });
 const inner = document.getElementById('tickerInner');
 if (!inner) return;
 const html = buildItems();
 inner.innerHTML = html + html;
 }
 updateTape();
 setInterval(updateTape, 8000);
}

/* ════════════════════════════════
 GATE PREVIEW ANIMATION
════════════════════════════════ */
function animateGatePreview() {
 const canvas = document.getElementById('prevChart');
 if (!canvas) return;
 const ctx = canvas.getContext('2d'); if (!ctx) return;
 canvas.width = (canvas.offsetWidth || 300) * devicePixelRatio;
 canvas.height = 50 * devicePixelRatio;
 ctx.scale(devicePixelRatio, devicePixelRatio);
 const W = canvas.offsetWidth || 300, H = 50;
 const pts = [];
 let v = 30;
 for (let i = 0; i < 40; i++) {
 v += (Math.random() - 0.42) * 4;
 v = Math.max(8, Math.min(44, v));
 pts.push(v);
 }
 const min = Math.min(...pts), max = Math.max(...pts);
 const x = i => (i / (pts.length - 1)) * W;
 const y = v => H - ((v - min) / (max - min || 1)) * (H - 8) - 4;
 ctx.beginPath();
 ctx.moveTo(x(0), y(pts[0]));
 pts.forEach((p, i) => i && ctx.lineTo(x(i), y(p)));
 ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
 const grad = ctx.createLinearGradient(0, 0, 0, H);
 grad.addColorStop(0, 'rgba(0,201,122,0.2)');
 grad.addColorStop(1, 'rgba(0,201,122,0)');
 ctx.fillStyle = grad; ctx.fill();
 ctx.beginPath();
 ctx.moveTo(x(0), y(pts[0]));
 pts.forEach((p, i) => i && ctx.lineTo(x(i), y(p)));
 ctx.strokeStyle = '#00c97a'; ctx.lineWidth = 1.5;
 ctx.lineJoin = 'round'; ctx.stroke();
 const priceEl = document.getElementById('prevPrice');
 if (!priceEl) return;
 let base = 187.20;
 window._gatePreviewInterval = setInterval(() => {
 if (!document.getElementById('prevPrice')) { clearInterval(window._gatePreviewInterval); return; }
 base += (Math.random() - 0.46) * 0.15;
 base = Math.max(185, Math.min(193, base));
 const up = base > 187.20;
 priceEl.textContent = '$' + base.toFixed(2);
 priceEl.style.color = up ? 'var(--green)' : 'var(--red)';
 }, 1800);
}
animateGatePreview();

/* ════════════════════════════════
 HELP & FAQ PANEL
════════════════════════════════ */
const FAQ_DATA = [
 {
 q: 'What is StockSight?',
 a: 'StockSight is a free stock market dashboard that lets you track stocks, crypto, and indexes, view AI-powered analysis, set price alerts, and practice investing with paper trading — all in one place.'
 },
 {
 q: 'What is Paper Trading?',
 a: 'Paper trading lets you buy and sell stocks with virtual money ($10,000 to start) so you can practice investing without any real financial risk. All trades use simulated prices based on real market data.'
 },
 {
 q: 'Why does my trade go "Pending"?',
 a: 'Trades placed while the market is closed (before 9:30 AM or after 4:00 PM ET, or on weekends) are queued as pending. They execute automatically when the market opens. You can cancel pending orders anytime.'
 },
 {
 q: 'How do I use the "Invest Now" button?',
 a: 'First, select your broker in Settings (the gear icon on your profile page). Once set, clicking "Invest Now" will open your broker\'s page for that stock in a new tab so you can place a real trade.'
 },
 {
 q: 'What do the AI signals mean?',
 a: '"Strong Buy", "Buy", "Hold", "Sell", and "Strong Sell" signals are generated from a blend of technical indicators including RSI, moving averages, volume trends, and momentum. They are for informational purposes only — not financial advice.'
 },
 {
 q: 'How do price alerts work?',
 a: 'Set a target price for any stock or crypto. When the asset\'s simulated price crosses your threshold, you\'ll receive an in-app notification. You can manage all alerts in the Alerts tab.'
 },
 {
 q: 'What is the daily streak?',
 a: 'Your streak tracks how many consecutive days you\'ve logged in and used StockSight. Visit every day to keep your streak alive and unlock streak milestone badges.'
 },
 {
 q: 'Can I use StockSight without an account?',
 a: 'Yes! You can browse stocks, view charts, and explore the dashboard as a guest. An account is required for paper trading, price alerts, notes, streaks, and personalized settings.'
 },
 {
 q: 'Is my data safe?',
 a: 'Your data is securely backed up to the cloud via Supabase. Your watchlist, portfolio, paper trades, alerts, notes, and settings all sync automatically whenever you make a change. If you ever clear your browser data, simply log back in and everything will be fully restored. Your password is hashed with SHA-256 and never stored in plain text.'
 },
 {
 q: 'How do I restart the tutorial?',
 a: 'Open this Help panel and click the "Restart Tutorial" quick-action button at the top. The interactive walkthrough will start from the beginning.'
 }
];

function buildFAQ() {
 return FAQ_DATA.map((item, i) => `
 <div class="faq-item" id="faq-${i}">
 <div class="faq-q" onclick="toggleFAQ(${i})">
 <span>${escapeHTML(item.q)}</span>
 <span class="faq-chevron">▼</span>
 </div>
 <div class="faq-a">${escapeHTML(item.a)}</div>
 </div>`).join('');
}

function toggleFAQ(i) {
 const el = document.getElementById('faq-' + i);
 if (!el) return;
 el.classList.toggle('open');
}

function openHelp() {
 const overlay = document.getElementById('helpOverlay');
 const panel = document.getElementById('helpPanel');
 if (!overlay || !panel) return;
 // Build FAQ on first open
 const faqContainer = document.getElementById('helpFaqList');
 if (faqContainer && !faqContainer.children.length) {
 faqContainer.innerHTML = buildFAQ();
 }
 overlay.classList.add('open');
 panel.classList.add('open');
 document.body.style.overflow = 'hidden';
}

function closeHelp() {
 const overlay = document.getElementById('helpOverlay');
 const panel = document.getElementById('helpPanel');
 if (!overlay || !panel) return;
 overlay.classList.remove('open');
 panel.classList.remove('open');
 document.body.style.overflow = '';
}

function restartTutorial() {
 closeHelp();
 localStorage.removeItem('ss_tutorial_done_' + (user?.email || ''));
 setTimeout(startTutorial, 300);
}

/* ════════════════════════════════
 PROFILE PHOTOS
 Picked here, cropped to a 256px square JPEG, and uploaded through /api/user to our own storage.
 Without a photo, people show their initials. The ring around it comes from their learning level.
════════════════════════════════ */
const AVATAR_URL_RE = /^https?:\/\/[^\s"'<>]+\/storage\/v1\/object\/public\/avatars\/[0-9a-f]{24}\.jpg(\?v=[a-z0-9]+)?$/;
const avatarUrlOf = a => typeof a === 'string' && AVATAR_URL_RE.test(a) ? a : null;
const myAvatarUrl = () => user ? avatarUrlOf(localStorage.getItem('ss_avatar_' + user.email)) : null;
function initialsOf(name) {
 const p = String(name || '').trim().split(/\s+/).filter(Boolean);
 return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() : '?';
}
function avatarHTML(url, name, size = 32, ring = '') {
 const u = avatarUrlOf(url);
 return `<span class="av${ring ? ' ring-' + ring : ''}" style="--av:${size}px"><b aria-hidden="true">${escapeHTML(initialsOf(name))}</b>${u ? `<img src="${escapeHTML(u)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>`;
}
const myRing = () => ringForLevel(learnLevel(getLearn().xp).n);
const myAvatarHTML = size => user ? avatarHTML(myAvatarUrl(), user.name, size, myRing()) : '';
const CAMERA_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
function refreshMyAvatar() {
 if (!user) return;
 const h = document.getElementById('hdrAvatar');
 if (h) h.innerHTML = myAvatarHTML(30);
 const p = document.getElementById('profAv');
 if (p) p.innerHTML = myAvatarHTML(52) + `<span class="av-cam" aria-hidden="true">${CAMERA_ICO}</span>`;
 const big = document.getElementById('photoPreview');
 if (big) big.innerHTML = myAvatarHTML(64);
 const rm = document.getElementById('photoRemoveBtn');
 if (rm) rm.hidden = !myAvatarUrl();
}

let _photo = null;
function openPhotoPicker() {
 if (!requireAuth('Profile photos')) return;
 const inp = document.createElement('input');
 inp.type = 'file';
 inp.accept = 'image/*';
 inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) loadPhoto(f); };
 inp.click();
}
function loadPhoto(file) {
 if (file.size > 25e6) { toast('That photo is too large. Try one under 25 MB.', 'error'); return; }
 const url = URL.createObjectURL(file);
 const img = new Image();
 img.onload = () => openPhotoCrop(img, url);
 img.onerror = () => { URL.revokeObjectURL(url); toast("That file couldn't be opened as a photo. Try a JPG or PNG.", 'error'); };
 img.src = url;
}
function openPhotoCrop(img, url) {
 _photo = { img, url, zoom: 1, cx: img.naturalWidth / 2, cy: img.naturalHeight / 2 };
 lessonOverlay('photoTitle', `
  <h2 id="photoTitle" class="lesson-title" style="margin:0 0 4px">Your profile photo</h2>
  <p class="ph-hint">Drag to position it and use the slider to zoom. Friends see it in your leagues.</p>
  <div class="ph-crop"><canvas id="photoCanvas" width="560" height="560" aria-label="Photo preview"></canvas></div>
  <label class="lc-sl ph-zoom"><span>Zoom</span><b></b><input type="range" min="1" max="4" step="0.01" value="1" oninput="photoZoom(this.value)" style="--fill:0%"></label>
  <p class="lg-err" id="photoErr" role="alert"></p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="photoCancel()">Cancel</button><button type="button" class="lesson-cta" id="photoSave" onclick="photoSave()">Save photo</button></div>`, 'ph-box');
 const c = document.getElementById('photoCanvas');
 let drag = null;
 c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx: _photo.cx, cy: _photo.cy }; c.setPointerCapture(e.pointerId); });
 c.addEventListener('pointermove', e => {
  if (!drag || !_photo) return;
  const side = photoSide(), k = side / c.getBoundingClientRect().width;
  _photo.cx = drag.cx - (e.clientX - drag.x) * k;
  _photo.cy = drag.cy - (e.clientY - drag.y) * k;
  drawPhoto(c);
 });
 c.addEventListener('pointerup', () => { drag = null; });
 c.addEventListener('pointercancel', () => { drag = null; });
 drawPhoto(c);
}
const photoSide = () => Math.min(_photo.img.naturalWidth, _photo.img.naturalHeight) / _photo.zoom;
function drawPhoto(canvas) {
 if (!_photo || !canvas) return;
 const { img } = _photo, side = photoSide(), W = img.naturalWidth, H = img.naturalHeight;
 _photo.cx = Math.max(side / 2, Math.min(W - side / 2, _photo.cx));
 _photo.cy = Math.max(side / 2, Math.min(H - side / 2, _photo.cy));
 const ctx = canvas.getContext('2d');
 ctx.imageSmoothingQuality = 'high';
 ctx.clearRect(0, 0, canvas.width, canvas.height);
 ctx.drawImage(img, _photo.cx - side / 2, _photo.cy - side / 2, side, side, 0, 0, canvas.width, canvas.height);
}
function photoZoom(v) {
 if (!_photo) return;
 _photo.zoom = +v;
 const inp = document.querySelector('.ph-zoom input');
 if (inp) inp.style.setProperty('--fill', `${((v - 1) / 3 * 100).toFixed(1)}%`);
 drawPhoto(document.getElementById('photoCanvas'));
}
function photoCancel() { if (_photo?.url) URL.revokeObjectURL(_photo.url); _photo = null; closeLesson(); }
async function photoSave() {
 if (!_photo) return;
 const btn = document.getElementById('photoSave'), err = document.getElementById('photoErr');
 const out = document.createElement('canvas');
 out.width = out.height = 256;
 drawPhoto(out);
 const data = out.toDataURL('image/jpeg', 0.86);
 btn.disabled = true; btn.textContent = 'Saving...'; err.textContent = '';
 const { data: d, error } = await accountApi('POST', { avatar: data });
 if (error || !d?.avatar) { btn.disabled = false; btn.textContent = 'Save photo'; err.textContent = error?.message || "Your photo couldn't be saved. Please try again."; return; }
 try { localStorage.setItem('ss_avatar_' + user.email, d.avatar); } catch {}
 photoCancel();
 refreshMyAvatar();
 track('profile_photo', { action: 'set' });
 toast('Profile photo updated', 'success', 2200);
}
async function removePhoto() {
 if (!user) return;
 const { error } = await accountApi('POST', { avatar: null });
 if (error) { toast(error.message || "Your photo couldn't be removed. Please try again.", 'error'); return; }
 try { localStorage.removeItem('ss_avatar_' + user.email); } catch {}
 refreshMyAvatar();
 toast('Profile photo removed', 'info', 2000);
}

/* ════════════════════════════════
 LEVEL REWARDS: every level unlocks something you can see or use
 Rings show around your photo everywhere, including your friends' leagues. Streak freezes keep a
 daily-challenge streak alive through a missed day. Teal and Ruby are extra app colors.
════════════════════════════════ */
const LEVEL_REWARDS = [
 { n: 2, kind: 'ring', title: 'Bronze profile ring', desc: 'A bronze ring around your photo, in your leagues and everywhere else.' },
 { n: 3, kind: 'freeze', title: 'Streak freeze', desc: 'Miss a day and your daily-challenge streak survives. You can hold up to 3.' },
 { n: 4, kind: 'color', title: 'Teal and Ruby app colors', desc: 'Two new colors for the whole app, in Settings, Preferences.' },
 { n: 5, kind: 'ring', title: 'Silver ring and a streak freeze', desc: 'Your ring turns silver, plus one more streak freeze.' },
 { n: 6, kind: 'ring', title: 'Gold profile ring', desc: 'A gold ring your friends will notice.' },
 { n: 7, kind: 'freeze', title: 'Another streak freeze', desc: 'One more freeze to protect your streak.' },
 { n: 8, kind: 'legend', title: 'Legend ring', desc: 'An animated ring only Legends have. From here, every level adds a streak freeze.' },
];
const ringForLevel = n => n >= 8 ? 'legend' : n >= 6 ? 'gold' : n >= 5 ? 'silver' : n >= 2 ? 'bronze' : '';   // same as ringOf in api/_leagues.js
const freezesForLevel = n => (n >= 3) + (n >= 5) + (n >= 7) + Math.max(0, n - 8);
const MAX_FREEZES = 3;
const rewardsAt = n => n > 8 ? [{ n, kind: 'freeze', title: 'Streak freeze', desc: 'Every level from here adds a streak freeze.' }] : LEVEL_REWARDS.filter(r => r.n === n);
const nextRewardAfter = n => LEVEL_REWARDS.find(r => r.n > n) || { n: n + 1, kind: 'freeze', title: 'Streak freeze', desc: 'Every level from here adds a streak freeze.' };
const REWARD_ICONS = {
 ring: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/>',
 freeze: '<line x1="12" y1="2" x2="12" y2="22"/><line x1="4.9" y1="6.5" x2="19.1" y2="17.5"/><line x1="19.1" y1="6.5" x2="4.9" y2="17.5"/>',
 color: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.4-.15-.75-.4-1-.25-.3-.4-.65-.4-1.05 0-.85.65-1.45 1.5-1.45H16c3.3 0 6-2.7 6-6 0-4.95-4.5-9-10-9z"/>',
 legend: '<path d="M2 18l2-11 5 5 3-7 3 7 5-5 2 11z"/><line x1="4" y1="21" x2="20" y2="21"/>',
};
const rewardIcon = k => DASH_ICON(REWARD_ICONS[k] || REWARD_ICONS.ring);
// Hand out the streak freezes for levels reached since last time (older progress gets its share once)
function grantFreezes(s) {
 const n = learnLevel(s.xp).n;
 if (s.freezeLevel == null) { s.freezeLevel = n; s.freezes = Math.min(MAX_FREEZES, freezesForLevel(n)); return; }
 if (n > s.freezeLevel) { s.freezes = Math.min(MAX_FREEZES, (s.freezes || 0) + freezesForLevel(n) - freezesForLevel(s.freezeLevel)); s.freezeLevel = n; }
}
const daysFrom = (a, b) => Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5);
// A streak is alive if you played today or yesterday, or your freezes cover the days you missed
function streakAlive(s, today = learnToday()) {
 if (!s.dstreak || !s.dlast) return false;
 const gap = daysFrom(s.dlast, today);
 return gap <= 1 || gap - 1 <= (s.freezes || 0);
}
const ACCENT_LOCKS = { teal: 4, ruby: 4 };
const accentUnlocked = c => !ACCENT_LOCKS[c] || learnLevel(getLearn().xp).n >= ACCENT_LOCKS[c];
function rewardsHubHTML(s, lv) {
 const nx = nextRewardAfter(lv.n);
 return `
 <div class="hub-reward">
  <span class="hr-ico">${rewardIcon(nx.kind)}</span>
  <div class="hr-txt"><span>Next reward at Level ${nx.n}</span><b>${escapeHTML(nx.title)}</b></div>
  <span class="hr-xp">${Math.max(0, (nx.n <= LEARN_LEVELS.length ? LEARN_LEVELS[nx.n - 1].min : lv.next) - s.xp)} XP to go</span>
 </div>
 <details class="hub-rewards"><summary>All level rewards${s.freezes ? ` · ${s.freezes} streak freeze${s.freezes > 1 ? 's' : ''} saved` : ''}</summary>
  <ul>${LEVEL_REWARDS.map(r => `<li class="${lv.n >= r.n ? 'got' : ''}"><span class="hr-ico">${lv.n >= r.n ? learnIcon('check') : rewardIcon(r.kind)}</span><div><b>Level ${r.n}: ${escapeHTML(r.title)}</b><span>${escapeHTML(r.desc)}</span></div></li>`).join('')}</ul>
 </details>`;
}

/* ════════════════════════════════
 LEAGUES: private leaderboards with friends (server: api/_leagues.js via /api/community)
 The score is XP earned this week. It resets every Monday; last week's winner is shown here and emailed.
════════════════════════════════ */
let _lg = null, _lgAt = 0, _lgReq = null;
const LG_ICON = '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>';
async function lgApi(q, body) {
 try {
  const r = await fetch('/api/community' + (q ? '?' + q : ''), {
   method: body ? 'POST' : 'GET',
   headers: { ...(getTok() ? { Authorization: 'Bearer ' + getTok() } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
   body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && user && getTok()) { await sessionExpired(); return { error: 'Please sign in again.', status: 401 }; }
  return r.ok ? d : { error: d.error || 'Something went wrong. Please try again.', status: r.status };
 } catch { return { error: 'Could not reach StockSight. Check your connection and try again.', status: 0 }; }
}
function loadLeagues(force) {
 if (!user) return Promise.resolve(null);
 if (!force && _lg && Date.now() - _lgAt < 60000) return Promise.resolve(_lg);
 if (!_lgReq) {
  _lgReq = lgApi('leagues=1').then(d => {
   _lgReq = null;
   if (d.error) return _lg;
   _lg = d; _lgAt = Date.now();
   try { localStorage.setItem('ss_lg_' + user.email, JSON.stringify({ n: d.leagues.length, wins: d.wins || 0 })); } catch {}
   return d;
  });
 }
 return _lgReq;
}
function timeLeft(ms) {
 const h = Math.max(0, Math.floor((ms - Date.now()) / 36e5)), d = Math.floor(h / 24);
 return d >= 1 ? `${d} day${d > 1 ? 's' : ''} ${h % 24} hr` : `${Math.max(1, h)} hr`;
}
// What changed since you last looked: someone passed you, or you won last week
function lgNotices(d) {
 if (!user || !d?.leagues?.length) return;
 const key = 'ss_lg_seen_' + user.email, seen = safeParse(key, {}), notes = [];
 let party = false;
 d.leagues.forEach(l => {
  const prev = seen[l.code];
  if (l.lastWinner?.me && prev?.won !== d.week) { notes.unshift(`You won ${l.name} last week with ${l.lastWinner.weekXp} XP.`); party = true; }
  else if (prev && prev.week === d.week && l.rank && prev.rank && l.rank > prev.rank) {
   const above = l.top.find(r => r.rank === l.rank - 1);
   notes.push(above && !above.me ? `${above.name} passed you in ${l.name}. You're #${l.rank} now.` : `You slipped to #${l.rank} in ${l.name}.`);
  }
  seen[l.code] = { week: d.week, rank: l.rank, won: l.lastWinner?.me ? d.week : prev?.won };
 });
 try { localStorage.setItem(key, JSON.stringify(seen)); } catch {}
 if (notes.length) setTimeout(() => { toast(notes[0], party ? 'success' : 'info', 5000); if (party) { try { launchConfetti(); } catch {} } }, 1800);
}

function lgCardHTML(l) {
 return `<button type="button" class="lg-card" onclick="openLeague('${l.code}')">
  <div class="lg-card-h"><b>${escapeHTML(l.name)}</b><span>${l.members} ${l.members === 1 ? 'member' : 'members'}</span></div>
  <div class="lg-card-m"><span class="lg-rank">#${l.rank || '-'}</span><span>${l.weekXp} XP this week</span><span class="lg-faces">${l.top.map(r => avatarHTML(lgAvatar(r), r.name, 26, r.ring)).join('')}</span></div>
  ${l.lastWinner ? `<div class="lg-last">${learnIcon('check')}Last week: ${l.lastWinner.me ? 'you won' : `${escapeHTML(l.lastWinner.name)} won`} with ${l.lastWinner.weekXp} XP</div>` : ''}
 </button>`;
}
function lgEmptyHTML() {
 return `<div class="lg-empty">
  <span class="lg-empty-ico">${DASH_ICON(LG_ICON)}</span>
  <h2>Compete with your friends</h2>
  <p>Start a private league and send your friends the link. Everyone earns XP from lessons and the daily challenge, and the board resets every Monday.</p>
 </div>`;
}
async function renderLeaguesView() {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 const seq = _viewSeq;
 try { history.replaceState(history.state, '', '/leagues'); } catch {}
 mc.innerHTML = '<div class="lg-page"><div class="lc-load lc-load-lg"><i></i><i></i><i></i></div></div>';
 const d = await loadLeagues(true);
 if (seq !== _viewSeq || tab !== 'leagues') return;
 if (!d) { mc.innerHTML = `<div class="lg-page">${lgEmptyHTML()}<p class="lg-err">Leagues aren't loading right now. Try again in a minute.</p></div>`; return; }
 mc.innerHTML = `<div class="lg-page">
  <div class="lg-week"><span>This week ends in <b>${timeLeft(d.endsAt)}</b></span><span>Score: XP earned this week</span></div>
  ${d.leagues.length ? `<div class="lg-list">${d.leagues.map(lgCardHTML).join('')}</div>` : lgEmptyHTML()}
  <div class="lg-actions"><button type="button" class="lesson-cta" onclick="openLeagueCreate()">Start a league</button><button type="button" class="dash-btn" onclick="openLeagueJoin()">Join with a code</button></div>
  <div class="lg-how"><b>How to earn XP</b><span>Lessons, today's challenge, practice rounds and real-stock lessons in Learn. Today's challenge alone is worth up to 70 XP.</span><button type="button" class="dash-btn" onclick="switchTab('learn')">Go to Learn</button></div>
 </div>`;
 refreshViewHeadSub();
}
async function openLeague(code) {
 if (tab !== 'leagues') { switchTab('leagues', true); await new Promise(r => setTimeout(r, 160)); }
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 const seq = _viewSeq;
 mc.innerHTML = '<div class="lg-page"><div class="lc-load lc-load-lg"><i></i><i></i><i></i></div></div>';
 const d = await lgApi('league=' + encodeURIComponent(code));
 if (seq !== _viewSeq) return;
 if (d.error) { mc.innerHTML = `<div class="lg-page"><button type="button" class="lg-back" onclick="renderLeaguesView()">${DASH_ICON('<polyline points="15 18 9 12 15 6"/>')}All leagues</button><p class="lg-err">${escapeHTML(d.error)}</p></div>`; return; }
 const me = d.members.find(m => m.me), above = me && me.rank > 1 ? d.members[me.rank - 2] : null, next = me && d.members[me.rank];
 const dot = t => /[.!?]$/.test(t) ? t : t + '.';   // names like "Tess R." already end in one
 const status = !me ? '' : d.members.length < 2 ? 'Invite friends to start competing.'
  : me.rank === 1 ? (me.weekXp > next.weekXp ? dot(`You're in first, ${me.weekXp - next.weekXp} XP ahead of ${escapeHTML(next.name)}`) : dot(`You're tied for first with ${escapeHTML(next.name)}`))
  : dot(`You're #${me.rank}. Earn ${above.weekXp - me.weekXp + 1} XP to pass ${escapeHTML(above.name)}`);
 const dailyDone = getLearn().daily?.date === learnToday() && getLearn().daily.done;
 mc.innerHTML = `<div class="lg-page">
  <button type="button" class="lg-back" onclick="renderLeaguesView()">${DASH_ICON('<polyline points="15 18 9 12 15 6"/>')}All leagues</button>
  <div class="lg-head"><div><h2>${escapeHTML(d.name)}</h2><span>${d.members.length} of ${d.max} members · resets in ${timeLeft(d.endsAt)}</span></div>
   <button type="button" class="lesson-cta lg-invite-btn" onclick="lgInvite('${d.code}')">${DASH_ICON('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>')}Invite</button></div>
  ${status ? `<div class="lg-status"><span>${status}</span><button type="button" class="dash-btn" onclick="${dailyDone ? 'startPractice()' : 'startDaily()'}">${dailyDone ? 'Practice for XP' : "Today's challenge"}</button></div>` : ''}
  <ol class="lg-board">${d.members.map(m => `<li class="lg-row${m.me ? ' me' : ''}">
   <span class="lg-pos${m.rank <= 3 ? ' p' + m.rank : ''}">${m.rank}</span>
   ${avatarHTML(lgAvatar(m), m.name, 38, m.ring)}
   <span class="lg-who"><b>${escapeHTML(m.name)}${m.me ? ' <em>you</em>' : ''}${m.owner ? ' <em>runs it</em>' : ''}</b><span>Level ${m.level} · ${escapeHTML(m.title)}${m.streak ? ` · ${m.streak}-day streak` : ''}</span></span>
   <span class="lg-xp">${m.weekXp}<small>XP</small></span>
   ${!m.me ? `<button type="button" class="lg-kick" aria-label="More for ${escapeHTML(m.name)}" onclick="lgMemberMenu('${d.code}','${m.id}','${jsq(m.name)}',${m.avatar ? 1 : 0},${d.owner ? 1 : 0})">${DASH_ICON('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>')}</button>` : ''}
  </li>`).join('')}</ol>
  ${d.lastWeek.length ? `<div class="lg-podium"><b>Last week</b>${d.lastWeek.map((r, i) => `<span><i>${i + 1}</i>${escapeHTML(r.name)}${r.me ? ' (you)' : ''} · ${r.weekXp} XP</span>`).join('')}</div>` : ''}
  <div class="lg-code"><div><span>Invite code</span><b>${d.code}</b></div><button type="button" class="dash-btn" onclick="lgInvite('${d.code}')">Share link</button></div>
  <div class="lg-foot">
   ${d.owner ? `<button type="button" class="dash-btn" onclick="lgRename('${d.code}','${jsq(d.name)}')">Rename</button>` : ''}
   <button type="button" class="dash-btn" onclick="lgConfirm('leave','${d.code}','','${jsq(d.name)}')">Leave league</button>
   ${!d.owner ? `<button type="button" class="dash-btn lg-quiet" onclick="lgReport('${d.code}','','league','${jsq(d.name)}')">Report league name</button>` : ''}
   ${d.owner ? `<button type="button" class="dash-btn lg-danger" onclick="lgConfirm('delete','${d.code}','','${jsq(d.name)}')">Delete league</button>` : ''}
  </div>
 </div>`;
}

function lgFormModal(title, sub, inputHTML, action, label) {
 lessonOverlay('lgmTitle', `<div class="lg-modal">
  <h2 id="lgmTitle" class="lesson-title">${title}</h2><p class="ph-hint">${sub}</p>
  ${inputHTML}
  <p class="lg-err" id="lgErr" role="alert"></p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="closeLesson()">Cancel</button><button type="button" class="lesson-cta" id="lgGo" onclick="${action}">${label}</button></div>
 </div>`, 'lg-box');
 setTimeout(() => document.querySelector('.lg-modal input')?.focus(), 60);
}
function openLeagueCreate() {
 if (!requireAuth('Leagues')) return;
 lgFormModal('Start a league', "Name it, then send your friends the link. Everyone's score is the XP they earn each week.",
  '<input class="lg-input" id="lgName" maxlength="30" autocomplete="off" placeholder="Roommates, Econ class, Family" onkeydown="if(event.key===\'Enter\')lgCreate()" oninput="document.getElementById(\'lgErr\').textContent=\'\'">',
  'lgCreate()', 'Create league');
}
function openLeagueJoin() {
 if (!requireAuth('Leagues')) return;
 lgFormModal('Join a league', 'Enter the 6-character code from your invite.',
  '<input class="lg-input lg-code-in" id="lgCode" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123" oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,\'\');document.getElementById(\'lgErr\').textContent=\'\'" onkeydown="if(event.key===\'Enter\')lgJoin(this.value)">',
  "lgJoin(document.getElementById('lgCode').value)", 'Join');
}
async function lgCreate() {
 const name = document.getElementById('lgName')?.value.trim() || '', err = document.getElementById('lgErr'), btn = document.getElementById('lgGo');
 if (name.length < 2) { err.textContent = 'Give your league a name (2 to 30 characters).'; return; }
 btn.disabled = true;
 const d = await lgApi(null, { action: 'league-create', name });
 btn.disabled = false;
 if (d.error) { err.textContent = d.error; return; }
 closeLesson();
 track('league_create');
 _lg = null;
 toast(`${d.name} is ready. Send your friends the link.`, 'success', 3500);
 await openLeague(d.code);
 lgInvite(d.code, true);
}
async function lgJoin(code) {
 code = String(code || '').toUpperCase().trim();
 const err = document.getElementById('lgErr');
 if (!/^[A-Z2-9]{6}$/.test(code)) { if (err) err.textContent = 'Codes are 6 letters and numbers, like ABC123.'; return; }
 const d = await lgApi(null, { action: 'league-join', code });
 if (d.error) { if (err) err.textContent = d.error; else toast(d.error, 'error', 4000); return; }
 closeLesson();
 _lg = null;
 track('league_join');
 toast(d.already ? `You're already in ${d.name}.` : `You joined ${d.name}. Earn XP to climb the board.`, 'success', 3500);
 const ob = document.getElementById('onboardingOverlay');
 if (!ob || getComputedStyle(ob).display === 'none') openLeague(d.code);
 loadLeagues(true).then(() => { checkAndAwardBadges?.(); renderDashLeague(); });
}
async function lgInvite(code, auto) {
 const name = _lg?.leagues?.find(l => l.code === code)?.name || document.querySelector('.lg-head h2')?.textContent || 'my league';
 const url = `${location.origin}/join/${code}`;
 const text = `Join my StockSight league "${name}". We earn XP from investing lessons and see who tops the board each week. Code: ${code}`;
 track('league_invite', { method: navigator.share ? 'share_sheet' : 'copy' });
 if (navigator.share) { try { await navigator.share({ title: `Join ${name} on StockSight`, text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
 try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied. Paste it in a group chat.', 'success', 3000); }
 catch { if (!auto) prompt('Copy this invite link:', url); }
}
function lgRename(code, name) {
 lgFormModal('Rename league', 'Everyone in the league sees the new name.',
  `<input class="lg-input" id="lgName" maxlength="30" autocomplete="off" value="${escapeHTML(name)}" onkeydown="if(event.key==='Enter')lgDoRename('${code}')">`,
  `lgDoRename('${code}')`, 'Save');
}
async function lgDoRename(code) {
 const name = document.getElementById('lgName')?.value.trim() || '';
 const d = await lgApi(null, { action: 'league-rename', code, name });
 if (d.error) { document.getElementById('lgErr').textContent = d.error; return; }
 closeLesson(); _lg = null; openLeague(code);
}
function lgConfirm(kind, code, member, name) {
 const t = {
  leave: ['Leave this league?', `You'll leave ${escapeHTML(name)}. You can rejoin later with the code.`, 'Leave'],
  delete: ['Delete this league?', `${escapeHTML(name)} and its board are deleted for everyone. This can't be undone.`, 'Delete league'],
  remove: [`Remove ${escapeHTML(name)}?`, 'They can rejoin only with a new invite.', 'Remove'],
 }[kind];
 lessonOverlay('lgmTitle', `<div class="lg-modal"><h2 id="lgmTitle" class="lesson-title">${t[0]}</h2><p class="ph-hint">${t[1]}</p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="closeLesson()">Cancel</button><button type="button" class="lesson-cta lg-danger-btn" onclick="lgDo('${kind}','${code}','${member}')">${t[2]}</button></div></div>`, 'lg-box');
}
// Photos you've hidden in leagues (by member id), on this device only
const lgHiddenKey = () => 'ss_hidden_av_' + (user?.email || '');
const lgHidden = () => new Set(safeParse(lgHiddenKey(), []));
const lgAvatar = r => (r.id && lgHidden().has(r.id) ? null : r.avatar);
function lgMemberMenu(code, member, name, hasPhoto, owner) {
 const hidden = lgHidden().has(member), n = escapeHTML(name);
 const item = (label, sub, act, danger) => `<button type="button" class="lg-menu-item${danger ? ' lg-danger' : ''}" onclick="${act}"><b>${label}</b><span>${sub}</span></button>`;
 lessonOverlay('lgmTitle', `<div class="lg-modal"><h2 id="lgmTitle" class="lesson-title">${n}</h2>
  <div class="lg-menu">
   ${hasPhoto || hidden ? item(hidden ? 'Show their photo' : 'Hide their photo', hidden ? 'See their profile photo again' : 'Only on your screen. They won\'t know.', `lgToggleHide('${code}','${member}')`) : ''}
   ${hasPhoto ? item('Report their photo', "If it's offensive or not okay for a stock app", `lgReport('${code}','${member}','photo','${jsq(name)}')`) : ''}
   ${item('Report their name', "If it's offensive or pretends to be someone", `lgReport('${code}','${member}','name','${jsq(name)}')`)}
   ${owner ? item('Remove from league', 'They can rejoin only with a new invite', `lgConfirm('remove','${code}','${member}','${jsq(name)}')`, true) : ''}
  </div>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="closeLesson()">Close</button></div></div>`, 'lg-box');
}
function lgSetHidden(member, on) {
 const set = lgHidden();
 if (on) set.add(member); else set.delete(member);
 try { localStorage.setItem(lgHiddenKey(), JSON.stringify([...set].slice(-500))); } catch {}
}
function lgToggleHide(code, member) {
 const on = !lgHidden().has(member);
 lgSetHidden(member, on);
 closeLesson();
 toast(on ? 'Photo hidden. Only you see the change.' : 'Photo shown again.', 'info', 2500);
 openLeague(code);
}
function lgReport(code, member, what, name) {
 const t = { photo: ['Report this photo?', `We'll review ${escapeHTML(name)}'s profile photo and remove it if it breaks the rules.`],
  name: ['Report this name?', `We'll review the name "${escapeHTML(name)}" and reset it if it breaks the rules.`],
  league: ['Report the league name?', `We'll review "${escapeHTML(name)}" and rename the league if it breaks the rules.`] }[what];
 lgFormModal(t[0], t[1] + ' The person you report won\'t know who reported them.',
  '<textarea class="lg-input lg-note" id="lgNote" maxlength="300" rows="3" placeholder="What\'s wrong? (optional)"></textarea>',
  `lgSendReport('${code}','${member}','${what}')`, 'Send report');
}
async function lgSendReport(code, member, what) {
 const btn = document.getElementById('lgGo'), err = document.getElementById('lgErr');
 if (btn) btn.disabled = true;
 const d = await lgApi(null, { action: 'league-report', code, member, what, note: document.getElementById('lgNote')?.value || '' });
 if (btn) btn.disabled = false;
 if (d.error) { if (err) err.textContent = d.error; return; }
 closeLesson();
 track('league_report', { what });
 // A reported photo is hidden for the reporter straight away
 const hide = what === 'photo' && !lgHidden().has(member);
 if (hide) { lgSetHidden(member, true); openLeague(code); }
 toast(hide ? "Thanks. We'll take a look, and their photo is hidden for you." : "Thanks. We'll take a look.", 'success', 4000);
}
async function lgDo(kind, code, member) {
 const d = await lgApi(null, kind === 'remove' ? { action: 'league-remove', code, member } : { action: kind === 'delete' ? 'league-delete' : 'league-leave', code });
 closeLesson();
 if (d.error) { toast(d.error, 'error', 4000); return; }
 _lg = null;
 if (kind === 'remove') openLeague(code); else { toast(kind === 'delete' ? 'League deleted' : 'You left the league', 'info', 2500); renderLeaguesView(); }
}

// Invite links: stocksightai.com/join/ABC123 (or ?league=ABC123); /leagues opens the leagues page
function leagueDeepLink() {
 if (/^\/learn\/?$/.test(location.pathname)) return { learn: true };   // the app's Learn shortcut
 const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/);
 const code = (m?.[1] || new URLSearchParams(location.search).get('league') || '').toUpperCase();
 if (/^[A-Z2-9]{6}$/.test(code)) return { join: code };
 if (/^\/leagues\/?$/.test(location.pathname)) return { view: true };
 return null;
}
function openLeagueDeepLink() {
 const dl = leagueDeepLink();
 if (!dl) return false;
 try { history.replaceState(null, '', dl.view ? '/leagues' : '/'); } catch {}
 if (dl.learn) { setTimeout(() => (user ? switchTab('learn') : requireAuth('Learn')), user ? 450 : 600); return true; }
 if (dl.view) { if (user) setTimeout(() => switchTab('leagues'), 450); else setTimeout(() => requireAuth('Leagues'), 600); return true; }
 setTimeout(() => openJoinInvite(dl.join), 700);
 return true;
}
async function openJoinInvite(code) {
 const p = await lgApi('invite=' + encodeURIComponent(code));
 if (p.error) { toast(p.error, 'error', 4000); return; }
 lessonOverlay('lgmTitle', `<div class="lg-modal lg-join">
  <span class="lg-empty-ico">${DASH_ICON(LG_ICON)}</span>
  <h2 id="lgmTitle" class="lesson-title">Join ${escapeHTML(p.name)}?</h2>
  <p class="ph-hint">${p.by ? `${escapeHTML(p.by)} invited you. ` : ''}${p.members} ${p.members === 1 ? 'person competes' : 'people compete'} on XP from investing lessons. The board resets every Monday.</p>
  ${p.full ? '<p class="lg-err">This league is full.</p>' : ''}
  <p class="lg-err" id="lgErr" role="alert"></p>
  <div class="lesson-nav"><button type="button" class="dash-btn" onclick="closeLesson()">Not now</button>
   <button type="button" class="lesson-cta" ${p.full ? 'disabled' : ''} onclick="${user ? `lgJoin('${p.code}')` : `lgJoinAfterSignup('${p.code}')`}">${user ? 'Join league' : 'Sign up free to join'}</button></div>
 </div>`, 'lg-box');
}
function lgJoinAfterSignup(code) {
 try { sessionStorage.setItem('ss_pending_league', code); } catch {}
 closeLesson();
 openModal('signup');
}
// After signing in or up from an invite: finish joining
function lgAfterLogin() {
 let code = null;
 try { code = sessionStorage.getItem('ss_pending_league'); sessionStorage.removeItem('ss_pending_league'); } catch {}
 if (code && /^[A-Z2-9]{6}$/.test(code)) setTimeout(() => lgJoin(code), 900);
}

// The league card on the home screen
async function renderDashLeague() {
 const el = document.getElementById('dashLeague');
 if (!el) return;
 if (!user) {
  el.innerHTML = `<button type="button" class="lg-dash promo" onclick="requireAuth('Leagues')"><span class="lg-dash-ico">${DASH_ICON(LG_ICON)}</span><span class="lg-dash-txt"><b>Compete with friends</b><span>Sign up free to start a league</span></span></button>`;
  return;
 }
 const d = await loadLeagues();
 if (!d || !document.getElementById('dashLeague')) return;
 if (!d.leagues.length) {
  el.innerHTML = `<button type="button" class="lg-dash promo" onclick="openLeagueCreate()"><span class="lg-dash-ico">${DASH_ICON(LG_ICON)}</span><span class="lg-dash-txt"><b>Compete with friends</b><span>Start a league and see who learns the most each week</span></span></button>`;
  return;
 }
 const l = [...d.leagues].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
 const above = l.rank > 1 ? l.top.find(r => r.rank === l.rank - 1) : null;
 el.innerHTML = `<button type="button" class="lg-dash" onclick="openLeague('${l.code}')">
  <span class="lg-dash-ico">${DASH_ICON(LG_ICON)}</span>
  <span class="lg-dash-txt"><b>${escapeHTML(l.name)}: you're #${l.rank} of ${l.members}</b><span>${above ? `${above.weekXp - l.weekXp + 1} XP to pass ${escapeHTML(above.name)}` : l.members > 1 ? 'You lead this week. Keep it up.' : 'Invite friends to compete'} · resets in ${timeLeft(d.endsAt)}</span></span>
  <span class="lg-faces">${l.top.map(r => avatarHTML(lgAvatar(r), r.name, 26, r.ring)).join('')}</span>
 </button>`;
}

// League results email (on unless turned off here or from an email's link)
const leagueMailOn = () => !!user?.email && localStorage.getItem('ss_lgmail_' + user.email) !== '0';
function syncLeagueMailUI() {
 const tog = document.getElementById('league-mail-tog'), lbl = document.getElementById('league-mail-lbl'), on = leagueMailOn();
 if (tog) { tog.className = 'notif-tog' + (on ? ' on' : ''); tog.setAttribute('aria-checked', String(on)); }
 if (lbl) lbl.textContent = on ? 'On' : 'Off';
}
async function toggleLeagueEmails() {
 if (!requireAuth('League emails')) return;
 const on = !leagueMailOn();
 const { error } = await usersTable().update({ league_emails: on });
 if (error) { toast('Could not save that. Please try again.', 'error'); return; }
 try { localStorage.setItem('ss_lgmail_' + user.email, on ? '1' : '0'); } catch {}
 syncLeagueMailUI();
 toast(on ? "We'll email your league results each Monday." : 'League emails turned off.', on ? 'success' : 'info', 3000);
}

/* ════════════════════════════════
 LEARN PAGE (Learn tab): the same hub as the pop-up, as a full page
════════════════════════════════ */
function renderLearnView() {
 const mc = document.getElementById('mainContent');
 if (!mc || !user) return;
 mc.innerHTML = `<div class="learn-page"><div id="learnHubBody">${learnHubHTML()}</div></div>`;
 if (!LEARN_LIB.full) loadLessonLibrary();
}
Object.assign(TG_ICONS, {
 learn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LEARN_ICONS.book}</svg>`,
 leagues: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LG_ICON}</svg>`,
});
Object.assign(TAB_GUIDES, {
 learn: {
  title: 'Learn',
  sub: () => { const lv = learnLevel(getLearn().xp); return `Level ${lv.n}: ${lv.name} · ${getLearn().xp} XP`; },
  lead: 'Short lessons with hands-on cards, a new 5-question challenge every day, and endless practice built from real market data. Everything earns XP, and XP unlocks rewards and climbs your leagues.',
  uses: [['Learn the basics', 'Six starter lessons cover how the market works.'], ['Build a habit', "Today's challenge takes two minutes and keeps your streak going."], ['Never run out', 'Practice rounds and real-stock lessons are always fresh.']],
  steps: [['Start a lesson', 'Pick any lesson. Read the cards, try the hands-on ones, then take the quiz.', null], ["Do today's challenge", 'Five questions from today\'s market. Missed questions come back later for review.', null], ['Collect rewards', 'Each level unlocks something: profile rings, streak freezes and new app colors.', null]],
  terms: [['XP', 'Points for learning. Lessons, challenges and practice all earn it.'], ['Streak', "Days in a row you've finished today's challenge."], ['Streak freeze', 'Saves your streak through a missed day. Earned by leveling up.']],
  tip: "Today's challenge is the fastest way to earn XP for your leagues.",
 },
 leagues: {
  title: 'Leagues',
  sub: () => _lg?.leagues?.length ? `${_lg.leagues.length} league${_lg.leagues.length > 1 ? 's' : ''} · resets Monday` : 'Compete with friends every week',
  lead: 'Private leaderboards with your friends. Everyone earns XP from lessons and the daily challenge, the board resets every Monday, and the winner is announced in the app and by email.',
  uses: [['Stay motivated', 'A little friendly competition keeps you coming back.'], ['Learn together', 'Start one for your class, club or group chat.'], ['Win the week', 'Top the board by Sunday night to win.']],
  steps: [['Start a league', 'Tap Start a league and give it a name.', null], ['Invite friends', 'Share the link or the 6-character code.', null], ['Earn XP', 'Lessons, today\'s challenge and practice all count toward this week.', null]],
  terms: [['Weekly XP', 'XP earned since Monday (UTC). It resets each week.'], ['Invite code', 'Six letters and numbers that let someone join.'], ['Ring', 'The ring around a photo shows the person\'s level.']],
  tip: 'Leagues of 3 to 10 friends are the most fun. Anyone can join with the link.',
 },
});

/* ════════════════════════════════
 PHONE LAYOUT ("clean native"): big titles, simple lists, a 5-tab bar with a More sheet
════════════════════════════════ */
const isPhone = () => matchMedia('(max-width: 768px)').matches;
const PHONE_TITLES = { s: 'Markets', i: 'Markets', c: 'Markets', w: 'Watchlist', learn: 'Learn', leagues: 'Leagues', pt: 'Practice', port: 'Portfolio', screen: 'Screener', cmp: 'Compare', day: 'Day Trade' };
function setPhoneTitle(t) {
 const el = document.getElementById('mTitle');
 if (el) el.textContent = PHONE_TITLES[t] || 'StockSight';
}
const MORE_ITEMS = [
 ['leagues', 'Leagues', LG_ICON],
 ['port', 'Portfolio', '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'],
 ['screen', 'Screener', '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>'],
 ['cmp', 'Compare', '<path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'],
 ['day', 'Day Trade', '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'],
];
function openMoreSheet() {
 closeMoreSheet();
 const ov = document.createElement('div');
 ov.className = 'more-ov';
 ov.id = 'moreSheet';
 const light = document.documentElement.getAttribute('data-theme') === 'light';
 ov.innerHTML = `<div class="more-box" role="dialog" aria-modal="true" aria-label="More">
  <div class="more-grab" aria-hidden="true"></div>
  <div class="more-grid">${MORE_ITEMS.map(([t, label, ico]) => `<button type="button" class="more-item${tab === t ? ' on' : ''}" onclick="closeMoreSheet();switchTab('${t}')"><span>${DASH_ICON(ico)}</span>${label}</button>`).join('')}</div>
  <div class="more-list">
   <button type="button" onclick="closeMoreSheet();${user ? "show('profile')" : "openModal('login')"}">${user ? myAvatarHTML(26) : DASH_ICON('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')}<span>${user ? 'Profile and settings' : 'Log in or sign up'}</span></button>
   <button type="button" onclick="closeMoreSheet();toggleTheme()">${DASH_ICON(light ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>')}<span>${light ? 'Dark mode' : 'Light mode'}</span></button>
   <button type="button" onclick="closeMoreSheet();openHelp()">${DASH_ICON('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>')}<span>Help and FAQ</span></button>
  </div>
 </div>`;
 ov.addEventListener('click', e => { if (e.target === ov) closeMoreSheet(); });
 document.body.appendChild(ov);
 requestAnimationFrame(() => ov.classList.add('in'));
}
function closeMoreSheet() { document.getElementById('moreSheet')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMoreSheet(); });

// Today's prices with a small intraday line, for the phone lists
const SPARK_Q = {};
async function fetchSparks(items) {
 const fresh = Date.now() - 60000, need = items.filter(([t]) => !SPARK_Q[t] || SPARK_Q[t].at < fresh);
 if (need.length) {
  const map = {};
  need.forEach(([t, k]) => { map[ySym(t, k)] = t; });
  try {
   const r = await fetch('/api/quotes?spark=1&symbols=' + encodeURIComponent(Object.keys(map).join(',')));
   if (r.ok) {
    const { quotes } = await r.json();
    for (const [s, q] of Object.entries(quotes || {})) if (map[s]) { SPARK_Q[map[s]] = { ...q, at: Date.now() }; LIVE_Q[map[s]] = { ...q, at: Date.now() }; }
   }
  } catch {}
 }
 return Object.fromEntries(items.map(([t]) => [t, SPARK_Q[t] || null]));
}
function miniSpark(c, up) {
 if (!c || c.length < 2) return '<svg class="ph-spark" viewBox="0 0 64 26" aria-hidden="true"></svg>';
 const lo = Math.min(...c), hi = Math.max(...c), n = c.length;
 const pts = c.map((v, i) => `${(i / (n - 1) * 64).toFixed(1)},${(23 - (v - lo) / (hi - lo || 1) * 20).toFixed(1)}`).join(' ');
 return `<svg class="ph-spark ${up ? 'up' : 'dn'}" viewBox="0 0 64 26" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
const phName = t => TICKERS.find(e => e.t === t)?.n || t;
const phPrice = v => v == null ? '—' : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
function phRowHTML([t, k], q) {
 const ch = q?.changePct, up = ch == null ? true : ch >= 0;
 return `<button type="button" class="ph-row" onclick="goAsset('${jsq(t)}','${k}')">
  <span class="ph-tk"><b>${escapeHTML(t)}</b><small>${escapeHTML(phName(t))}</small></span>
  ${miniSpark(q?.spark, up)}
  <span class="ph-px"><b>${phPrice(q?.price)}</b><i class="${ch == null ? '' : up ? 'up' : 'dn'}">${ch == null ? '—' : `${up ? '+' : ''}${ch.toFixed(2)}%`}</i></span>
 </button>`;
}
const PH_MOVER_POOL = { s: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'NFLX', 'AMD', 'INTC', 'JPM', 'V', 'WMT', 'DIS', 'PLTR', 'COIN', 'UBER', 'SMCI'], c: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'BNB', 'LINK', 'LTC'] };
function renderPhoneHome(t) {
 const mc = document.getElementById('mainContent');
 if (!mc) return;
 const seq = _viewSeq;
 mc.dataset.view = 'home';
 const wl = user && watchlist.length ? watchlist.slice(0, 10).map(w => [w.ticker, w.type || tickerKind(w.ticker)]) : null;
 const idx = [['SPX', 'i'], ['IXIC', 'i'], ['DJI', 'i'], ['VIX', 'i']];
 const L = {
  s: [[wl ? 'Your watchlist' : 'Popular stocks', wl || ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'META'].map(x => [x, 's']), wl ? "switchTab('w')" : ''], ['Market indexes', idx]],
  i: [['US indexes', [...idx.slice(0, 3), ['RUT', 'i'], ['VIX', 'i']]], ['World markets', [['FTSE', 'i'], ['NI225', 'i'], ['DAX', 'i'], ['HSI', 'i']]]],
  c: [['Crypto', ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA'].map(x => [x, 'c'])]],
 }[t] || [];
 const skeleton = n => Array.from({ length: n }, () => '<div class="ph-row ph-skel"><span></span><span></span><span></span></div>').join('');
 mc.innerHTML = `<div class="ph-home">
  ${L.map(([title, items, edit], i) => `<section class="ph-sec"><div class="ph-sec-h"><h2>${title}</h2>${edit ? `<button type="button" onclick="${edit}">See all</button>` : ''}</div><div class="ph-list" id="phList${i}">${skeleton(items.length)}</div></section>`).join('')}
  ${PH_MOVER_POOL[t] ? '<section class="ph-sec" id="phMoversSec"><div class="ph-sec-h"><h2>Biggest moves today</h2></div><div class="ph-movers" id="phMovers"></div></section>' : ''}
  <section class="dash-learn">${learnRowHTML()}</section>
  <section class="dash-league" id="dashLeague"></section>
 </div>`;
 renderDashLeague();
 const all = L.flatMap(([, items]) => items);
 fetchSparks(all).then(Q => {
  if (seq !== _viewSeq) return;
  L.forEach(([, items], i) => { const el = document.getElementById('phList' + i); if (el) el.innerHTML = items.map(it => phRowHTML(it, Q[it[0]])).join(''); });
 });
 if (PH_MOVER_POOL[t]) {
  const pool = PH_MOVER_POOL[t].map(x => [x, t]);
  fetchQuotes(pool).then(Q => {
   if (seq !== _viewSeq) return;
   const el = document.getElementById('phMovers');
   if (!el) return;
   const top = pool.filter(([x]) => Q[x]?.changePct != null).sort((a, b) => Math.abs(Q[b[0]].changePct) - Math.abs(Q[a[0]].changePct)).slice(0, 4);
   if (!top.length) { document.getElementById('phMoversSec')?.remove(); return; }
   el.innerHTML = top.map(([x, k]) => { const c = Q[x].changePct; return `<button type="button" class="ph-mover" onclick="goAsset('${x}','${k}')"><b>${x}</b><i class="${c >= 0 ? 'up' : 'dn'}">${c >= 0 ? '+' : ''}${c.toFixed(1)}%</i></button>`; }).join('');
  });
 }
}

// The Leagues line inside the Learn hub
function hubLeagueHTML() {
 if (!user) return '';
 const l = _lg?.leagues?.length ? [..._lg.leagues].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0] : null;
 if (!_lg) loadLeagues().then(d => { if (d && document.getElementById('learnHubBody')) refreshLearnRow(); });
 return `<button type="button" class="hub-league" onclick="closeLesson();switchTab('leagues')">
  <span class="hm-ico">${DASH_ICON(LG_ICON)}</span>
  <span class="hl-txt"><b>${l ? `${escapeHTML(l.name)}: you're #${l.rank} this week` : 'Leagues'}</b><span>${l ? `${l.weekXp} XP so far · resets Monday` : 'Start one with friends and race for XP each week'}</span></span>
  ${DASH_ICON('<polyline points="9 18 15 12 9 6"/>')}
 </button>`;
}

// The offline screen (sw.js). Having one is also part of what lets app stores and browsers install StockSight.
if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });

/* ════════════════════════════════
 DEEPER TOOLS on stock pages and portfolios
 Valuation: a discounted cash flow (DCF) sandbox with every input shown and adjustable.
 Stress test: a hype check, a data-only bear case, interest-rate sensitivity and past crashes.
 Options: implied volatility, expected move, put/call ratios, unusual activity and hedge cost.
 Portfolios: how today's holdings would have done through past crises.
 All from real prices and filings (Yahoo Finance). Approximations are labeled as such.
════════════════════════════════ */
const pct1 = v => v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
const pct0 = v => v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`;
const sgn0 = v => v == null || !Number.isFinite(v) ? '—' : Math.round(Math.abs(v) * 100) === 0 ? '0%' : `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%`;
const usd = v => v == null || !Number.isFinite(v) ? '—' : v < 0 ? '−' + usd(-v) : (v >= 1e9 ? fmtBig(v) : fmtPx(v));
const insightNote = t => `<p class="in-note">${t}</p>`;
const inLoading = t => `<div class="lc-load"><i></i><i></i><i></i></div><p class="in-note" style="text-align:center">${t}</p>`;
const inSection = (title, body, sub = '') => `<section class="in-sec"><h4>${title}</h4>${sub ? `<p class="in-sub">${sub}</p>` : ''}${body}</section>`;

/* ── Price history helpers ── */
// Weekly closes since 2000 (for crash windows), cached per symbol
const _longReq = new Map();
function getLongHistory(sym) {
 if (!_longReq.has(sym)) {
  _longReq.set(sym, fetch('/api/history?range=since2000&symbol=' + encodeURIComponent(sym))
   .then(r => (r.ok ? r.json() : null)).catch(() => null)
   .then(d => { if (!d?.t?.length) { setTimeout(() => _longReq.delete(sym), 60000); return null; } return d; }));
 }
 return _longReq.get(sym);
}
const toTs = iso => Date.parse(iso + 'T12:00:00Z') / 1000;
// Index of the last close on or before a date; null if the history doesn't reach back that far
function idxAt(h, ts) {
 if (!h?.t?.length || ts < h.t[0] || ts > h.t[h.t.length - 1] + 8 * 86400) return null;
 let lo = 0, hi = h.t.length - 1;
 while (lo < hi) { const m = (lo + hi + 1) >> 1; if (h.t[m] <= ts) lo = m; else hi = m - 1; }
 return lo;
}
// S&P 500 peak-to-bottom dates
const CRISES = [
 { name: 'Dot-com crash', short: 'Dot-com crash, 2000', start: '2000-03-24', end: '2002-10-09' },
 { name: '2008 financial crisis', short: '2008 financial crisis', start: '2007-10-09', end: '2009-03-09' },
 { name: '2011 debt-ceiling scare', short: '2011 debt scare', start: '2011-04-29', end: '2011-10-03' },
 { name: 'Late-2018 selloff', short: 'Late-2018 selloff', start: '2018-09-20', end: '2018-12-24' },
 { name: 'COVID crash', short: 'COVID crash, 2020', start: '2020-02-19', end: '2020-03-23' },
 { name: '2022 rate-hike bear market', short: '2022 rate hikes', start: '2022-01-03', end: '2022-10-12' },
 { name: '2025 tariff shock', short: '2025 tariff shock', start: '2025-02-19', end: '2025-04-08' },
];
// Return over a crisis, and how many months until the start level came back
function crisisMove(h, c) {
 const i0 = idxAt(h, toTs(c.start)), i1 = idxAt(h, toTs(c.end));
 if (i0 == null || i1 == null || i1 <= i0) return null;
 const move = h.c[i1] / h.c[i0] - 1;
 let rec = null;
 for (let k = i1; k < h.c.length; k++) if (h.c[k] >= h.c[i0]) { rec = Math.max(1, Math.round((h.t[k] - h.t[i1]) / 2629800)); break; }
 return { move, recovered: rec };
}
const betaOf = t => liveStats(t)?.beta ?? ASSET_DATA[t]?.[0] ?? (tickerKind(t) === 'c' ? 2 : 1);

/* ── Hype check: is the price running ahead of the business? ── */
function hypeCheck(R) {
 const f = R.facts || {}, st = R.stats || {}, px = R.price;
 const sig = [];
 const add = (hot, warm, text) => sig.push({ level: hot ? 2 : warm ? 1 : 0, text });
 const stretch = f.twoHundredDayAvg && px ? px / f.twoHundredDayAvg - 1 : null;
 if (stretch != null) add(stretch > 0.35, stretch > 0.15, `The price is ${sgn0(stretch)} versus its 200-day average.`);
 const ret = st.ret1y ?? f.change52w;
 if (ret != null) add(ret > 1, ret > 0.5, `It's ${sgn0(ret)} over the past year.`);
 if (st.rsi != null) add(st.rsi > 78, st.rsi > 68, `Its 14-day RSI is ${st.rsi.toFixed(0)} (above 70 often means it ran up fast).`);
 const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE > 0 ? f.trailingPE : null;
 if (R.kind === 'stock') {
  if (pe) add(pe > 80, pe > 40, `It trades at ${pe.toFixed(0)} times earnings.`);
  else if (f.priceToSales) add(f.priceToSales > 25, f.priceToSales > 10, `It has no profit yet and trades at ${f.priceToSales.toFixed(0)} times sales.`);
 }
 if (f.shortPctFloat != null) add(f.shortPctFloat > 0.2, f.shortPctFloat > 0.1, `${pct0(f.shortPctFloat)} of its shares are sold short.`);
 const score = sig.reduce((s, x) => s + x.level, 0);
 const label = score >= 6 ? 'Overheated' : score >= 4 ? 'Hot' : score >= 2 ? 'Warm' : 'Calm';
 return { label, score, sig, stretch };
}
function hypeHTML(R) {
 const H = hypeCheck(R);
 const tone = { Calm: 'ok', Warm: 'mid', Hot: 'warn', Overheated: 'bad' }[H.label];
 const lead = {
  Calm: 'Nothing suggests the price is running on hype.',
  Warm: 'Some signs the price has run up faster than usual.',
  Hot: 'The price has run well ahead of where it usually trades. Hype-driven runs often cool off.',
  Overheated: 'Several signs of a hype-driven run. Prices like this can fall fast when attention moves on.',
 }[H.label];
 return inSection('Hype check', `
  <div class="in-hype ${tone}"><b>${H.label}</b><span>${lead}</span></div>
  <ul class="in-list">${H.sig.map(s => `<li class="l${s.level}">${s.text}</li>`).join('')}</ul>
  ${insightNote(H.label === 'Hot' || H.label === 'Overheated'
   ? "StockSight's verdict never uses news or social media buzz, and a run like this can't raise its score: price momentum counts for 10% and is capped when the price is stretched."
   : "StockSight's verdict never uses news or social media buzz. If the price ever runs far above its usual level, that can't raise the score: price momentum counts for 10% and is capped when the price is stretched.")}`);
}

/* ── The bear case, from the data only (no momentum, no analyst optimism) ── */
function bearScenarios(R) {
 const f = R.facts || {}, st = R.stats || {}, px = R.price, out = [];
 if (!px) return out;
 if (f.targetLow > 0 && f.analysts >= 3) out.push([`The lowest analyst target (${fmtPx(f.targetLow)})`, f.targetLow / px - 1]);
 const pe = f.forwardPE > 0 ? f.forwardPE : f.trailingPE > 0 ? f.trailingPE : null;
 if (R.kind === 'stock' && pe > 20) out.push([`If investors paid 20 times earnings (about the long-run market average) instead of ${pe.toFixed(0)}`, 20 / pe - 1]);
 if (st.maxDD != null && st.maxDD < -0.05) out.push(['A repeat of its worst drop in the past year', st.maxDD]);
 if (f.fiftyTwoWeekLow > 0) out.push([`Back to its 52-week low (${fmtPx(f.fiftyTwoWeekLow)})`, f.fiftyTwoWeekLow / px - 1]);
 return out.filter(([, v]) => v < -0.01);
}
function bearCaseHTML(R, P) {
 const sc = bearScenarios(R), bad = (P?.bad || []).map(p => p.mid);
 return inSection('The bear case', `
  ${bad.length ? `<ul class="in-list">${bad.slice(0, 6).map(b => `<li class="l1">${b}</li>`).join('')}</ul>` : '<p class="in-sub">The numbers show no major weak spots right now.</p>'}
  ${sc.length ? `<div class="in-scen"><b>What the downside could look like</b>${sc.map(([l, v]) => `<div><span>${l}</span><em>${sgn0(v)}</em></div>`).join('')}</div>` : ''}
  ${insightNote('Scenarios, not predictions. Built only from the business numbers and price history, leaving out momentum and analyst optimism on purpose.')}`,
  'The data-backed case against it, so you see both sides.');
}

/* ── Interest rates and the economy ── */
const _macroCache = {};
async function macroFor(t, k) {
 if (_macroCache[t]) return _macroCache[t];
 const sym = ySym(t, k);
 const [s, y, irx, oil, usdIdx, vix, longS, longSpx] = await Promise.all([
  getHistory(sym), getHistory('^TNX'), getHistory('^IRX').catch(() => null), getHistory('CL=F').catch(() => null),
  getHistory('DX-Y.NYB').catch(() => null), getHistory('^VIX').catch(() => null), getLongHistory(sym), getLongHistory('^GSPC'),
 ]);
 // Weekly stock returns against weekly changes in the 10-year Treasury yield, on matching dates
 const yAt = new Map(y.t.map((ts, i) => [Math.floor(ts / 86400), y.c[i]]));
 const pts = [];
 for (let i = 0; i < s.t.length; i++) { const v = yAt.get(Math.floor(s.t[i] / 86400)); if (v != null) pts.push([s.c[i], v]); }
 const r = [], dy = [];
 for (let i = 5; i < pts.length; i += 5) { r.push(pts[i][0] / pts[i - 5][0] - 1); dy.push(pts[i][1] - pts[i - 5][1]); }
 let sens = null, corr = null;
 if (r.length > 40) {
  const mr = rsAvg(r), my = rsAvg(dy);
  let cov = 0, vy = 0, vr = 0;
  for (let i = 0; i < r.length; i++) { cov += (r[i] - mr) * (dy[i] - my); vy += (dy[i] - my) ** 2; vr += (r[i] - mr) ** 2; }
  sens = vy ? cov / vy : null;
  corr = vy && vr ? cov / Math.sqrt(vy * vr) : null;
 }
 const chg = (h, n = 63) => h?.c?.length > n ? { now: h.c[h.c.length - 1], then: h.c[h.c.length - 1 - n] } : null;
 const hike = CRISES.find(c => c.name.startsWith('2022'));
 const out = {
  sens, corr, weeks: r.length,
  y10: chg(y), y3m: chg(irx), oil: chg(oil), dollar: chg(usdIdx), vix: vix?.c?.length ? vix.c[vix.c.length - 1] : null,
  hike: longS ? crisisMove(longS, hike) : null, hikeSpx: longSpx ? crisisMove(longSpx, hike) : null,
 };
 _macroCache[t] = out;
 return out;
}
function macroHTML(t, M) {
 const name = rsName(t, window._rs?.R?.facts);
 let sensLine = 'Not enough matching history to measure it.';
 if (M.sens != null) {
  const per = M.sens * 0.25, weak = Math.abs(M.corr) < 0.1;
  sensLine = weak
   ? `Over the past ${Math.round(M.weeks / 52)} years, ${name} has had little connection to interest-rate moves (correlation ${M.corr.toFixed(2)}).`
   : `Over the past ${Math.round(M.weeks / 52)} years, when the 10-year Treasury yield rose 0.25 points in a week, ${name} tended to move <b>${sgn0(per)}</b> that week (correlation ${M.corr.toFixed(2)}). ${per < -0.004 ? 'Rising rates have tended to hurt it.' : per > 0.004 ? 'It has tended to do better when rates rise, as banks and energy companies often do.' : 'The effect has been small.'}`;
 }
 const delta = (o, unit, n = 2) => o ? `${o.now >= o.then ? 'Up' : 'Down'} from ${o.then.toFixed(n)}${unit} three months ago` : 'not available';
 const pctDelta = o => o ? `${sgn0(o.now / o.then - 1)} over three months` : 'not available';
 return inSection('Interest rates and the economy', `
  <p class="in-p">${sensLine}</p>
  ${M.hike ? `<p class="in-p">In the <b>2022 rate-hike bear market</b>, when the Fed raised rates fastest in 40 years, ${name} moved <b>${sgn0(M.hike.move)}</b> versus <b>${sgn0(M.hikeSpx?.move)}</b> for the S&amp;P 500.</p>` : ''}
  <div class="in-grid">
   <div><span>10-year Treasury yield</span><b>${M.y10 ? M.y10.now.toFixed(2) + '%' : '—'}</b><small>${delta(M.y10, '%')}</small></div>
   <div><span>3-month T-bill (follows the Fed's rate)</span><b>${M.y3m ? M.y3m.now.toFixed(2) + '%' : '—'}</b><small>${delta(M.y3m, '%')}</small></div>
   <div><span>Oil (WTI)</span><b>${M.oil ? fmtPx(M.oil.now) : '—'}</b><small>${pctDelta(M.oil)}</small></div>
   <div><span>US dollar index</span><b>${M.dollar ? M.dollar.now.toFixed(1) : '—'}</b><small>${pctDelta(M.dollar)}</small></div>
   <div><span>VIX (market fear gauge)</span><b>${M.vix != null ? M.vix.toFixed(1) : '—'}</b><small>${M.vix == null ? '' : M.vix > 25 ? 'high: markets are nervous' : M.vix < 15 ? 'low: markets are calm' : 'normal range'}</small></div>
  </div>
  ${insightNote('Inflation shows up in bond yields and oil prices, which move first. Measured from real daily prices; past relationships can change.')}`,
  'How it has reacted to rate changes, and where rates stand now.');
}
// A line for the chat's macro answer, once the numbers are in
function macroChatLine(t) {
 const M = _macroCache[t];
 if (!M || M.sens == null) return `<em>Open the Stress test tab for ${t}'s measured sensitivity to interest rates.</em><br><br>`;
 const per = M.sens * 0.25;
 const link = Math.abs(M.corr) < 0.1
  ? `over the past ${Math.round(M.weeks / 52)} years, ${t} has had little connection to weekly interest-rate moves (correlation ${M.corr.toFixed(2)}).`
  : `when the 10-year yield rose 0.25 points in a week, ${t} moved about ${sgn0(per)} on average (correlation ${M.corr.toFixed(2)}).`;
 return `<strong>Measured, not guessed:</strong> ${link}${M.hike ? ` In 2022's rate hikes it moved ${sgn0(M.hike.move)} vs ${sgn0(M.hikeSpx?.move)} for the S&P 500.` : ''}<br><br>`;
}

/* ── Past crashes, for one asset ── */
function crashesHTML(t, h, spx) {
 const beta = betaOf(t);
 const rows = CRISES.map(c => {
  const s = crisisMove(spx, c);
  if (!s) return null;
  const m = h ? crisisMove(h, c) : null;
  const est = !m;
  const move = m ? m.move : Math.max(-0.95, beta * s.move);
  return { c, s, move, est, rec: m?.recovered };
 }).filter(Boolean);
 if (!rows.length) return '';
 _crashShare.stock = { t, rows: rows.map(x => ({ c: x.c, spx: x.s.move, you: x.move, est: x.est })) };
 return inSection('Past crashes', `
  <div class="in-table-wrap"><table class="in-table">
   <thead><tr><th>Crash</th><th>S&amp;P 500</th><th>${t}</th><th>Back to its old price</th></tr></thead>
   <tbody>${rows.map(x => `<tr><td>${x.c.name}<small>${x.c.start.slice(0, 7)} to ${x.c.end.slice(0, 7)}</small></td><td class="dn">${sgn0(x.s.move)}</td><td class="${x.move < 0 ? 'dn' : 'up'}">${sgn0(x.move)}${x.est ? '<sup>est</sup>' : ''}</td><td>${x.est ? '—' : x.rec == null ? 'not yet' : x.rec < 12 ? `${x.rec} mo` : `${(x.rec / 12).toFixed(1)} yr`}</td></tr>`).join('')}</tbody>
  </table></div>
  ${rows.some(x => x.est) ? insightNote(`<sup>est</sup> ${t} wasn't trading yet, so this is its beta (${beta.toFixed(2)}) times the S&amp;P 500's move: a rough guess.`) : ''}
  ${insightNote('From the start of each crash to the S&amp;P 500\'s bottom, using weekly closing prices (dividends included). Approximate.')}
  ${crashShareBtn('stock', `Share ${t}'s crash test`)}`,
  'How it held up when the whole market fell.');
}

function renderStressTab() {
 const el = document.getElementById('rsStress'), S = window._rs;
 if (!el || !S?.R) return;
 const { R, P } = S, t = S.ticker, k = S.type || tickerKind(t);
 el.innerHTML = `<div class="in-pane">${R.kind === 'stock' || R.kind === 'crypto' ? hypeHTML(R) : ''}${R.kind === 'stock' ? bearCaseHTML(R, P) : ''}<div id="inMacro">${inLoading('Measuring how it reacts to interest rates')}</div><div id="inCrash"></div></div>`;
 const seq = t;
 macroFor(t, k).then(M => { if (window._rs?.ticker === seq) { const m = document.getElementById('inMacro'); if (m) m.innerHTML = macroHTML(t, M); } })
  .catch(() => { const m = document.getElementById('inMacro'); if (m) m.innerHTML = insightNote("Rate data didn't load. Try again in a minute."); });
 Promise.all([getLongHistory(ySym(t, k)), getLongHistory('^GSPC')]).then(([h, spx]) => {
  if (window._rs?.ticker !== seq || !spx) return;
  const c = document.getElementById('inCrash');
  if (c) c.innerHTML = crashesHTML(t, h, spx);
 });
}

/* ── Valuation: a DCF sandbox ── */
let _dcf = null;
function dcfDefaults(R) {
 const f = R.facts || {}, px = R.price;
 const g = rsClamp(f.revenueGrowth ?? f.earningsGrowth ?? 0.05, -0.05, 0.3);
 const rf = rsClamp((livePrice('US10Y') ?? 4.3) / 100, 0.01, 0.08);
 const beta = rsClamp(R.stats?.beta ?? f.beta5y ?? 1, 0.6, 2);
 return {
  fcf: f.fcfReported ?? f.freeCashflow, shares: f.marketCap && px ? f.marketCap / px : null,
  netCash: (f.totalCash || 0) - (f.totalDebt || 0),
  g1: Math.round(g * 1000) / 1000, g2: Math.round(g * 500) / 1000, tg: 0.025,
  disc: Math.round(rsClamp(rf + beta * 0.05, 0.06, 0.14) * 1000) / 1000, rf, beta,
 };
}
function dcfValue(p) {
 if (!(p.fcf > 0) || !(p.shares > 0) || p.disc <= p.tg + 0.005) return null;
 let cf = p.fcf, pv = 0;
 const flows = [];
 for (let y = 1; y <= 10; y++) { cf *= 1 + (y <= 5 ? p.g1 : p.g2); flows.push(cf); pv += cf / (1 + p.disc) ** y; }
 const tv = cf * (1 + p.tg) / (p.disc - p.tg), tvPv = tv / (1 + p.disc) ** 10;
 return { perShare: (pv + tvPv + p.netCash) / p.shares, pv, tvPv, flows };
}
// The growth rate (first five years, half that after) that makes the model equal today's price
function impliedGrowth(p, price) {
 let lo = -0.5, hi = 1.5;
 const at = g => dcfValue({ ...p, g1: g, g2: g / 2 })?.perShare ?? -Infinity;
 if (at(hi) < price || at(lo) > price) return null;
 for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(m) < price) lo = m; else hi = m; }
 return (lo + hi) / 2;
}
const DCF_INPUTS = [
 ['fcf', 'Free cash flow, last 12 months', null, null, null],
 ['g1', 'Cash-flow growth, years 1 to 5', -0.1, 0.4, 0.005],
 ['g2', 'Cash-flow growth, years 6 to 10', -0.05, 0.25, 0.005],
 ['disc', 'Discount rate (your required return)', 0.05, 0.15, 0.0025],
 ['tg', 'Growth forever after year 10', 0, 0.04, 0.0025],
];
function dcfHTML(R) {
 const f = R.facts || {};
 if (R.kind !== 'stock') return `<div class="in-pane">${insightNote('A cash-flow valuation needs a company\'s own cash flows. Funds, indexes and crypto don\'t have them, so there\'s nothing to value this way.')}</div>`;
 const base = dcfDefaults(R);
 // Banks and insurers move customers' money through their cash flow, so a DCF says nothing about them
 if (/Bank|Insurance|Mortgage|Capital Markets/i.test(f.industry || '')) {
  const pb = f.priceToBook, roe = f.roe;
  return `<div class="in-pane">${inSection('Valuation sandbox', `<p class="in-p">${rsName(R.t, f)} is a ${/Insurance/i.test(f.industry) ? 'insurer' : 'bank or lender'}. Its cash flow is mostly customers' money moving in and out, so a cash-flow (DCF) valuation doesn't work for it.</p>
   <p class="in-p">The usual guides are <b>price-to-book</b> (what you pay for each $1 of the company's net worth)${pb != null ? `, which is <b>${pb.toFixed(2)}</b>` : ''}, and <b>return on equity</b> (profit on that net worth)${roe != null ? `, which is <b>${pct1(roe)}</b>` : ''}. A price-to-book well above 1 is reasonable only when the return on equity is high.</p>`)}</div>`;
 }
 if (!(base.fcf > 0) || !base.shares) {
  return `<div class="in-pane">${inSection('Valuation sandbox', `<p class="in-p">${rsName(R.t, f)} ${base.fcf != null ? `had ${usd(base.fcf)} of free cash flow over the past year` : "doesn't report free cash flow"}, so a cash-flow valuation can't give a meaningful answer yet. That's common for young or fast-growing companies; price-to-sales and growth are better guides for now.</p>`)}</div>`;
 }
 _dcf = { t: R.t, base, p: { ...base }, price: R.price };
 return `<div class="in-pane">${inSection('Valuation sandbox (DCF)', `
  <div class="dcf-out" id="dcfOut"></div>
  <div class="lc-sliders dcf-sl">${DCF_INPUTS.map(([k, label, min, max, step]) => k === 'fcf'
   ? `<label class="lc-sl"><span>${label}</span><b data-dv="fcf"></b><input type="range" data-dk="fcf" min="${(base.fcf * 0.3).toFixed(0)}" max="${(base.fcf * 2).toFixed(0)}" step="${(base.fcf / 100).toFixed(0)}" value="${base.fcf}" oninput="dcfSet(this)"></label>`
   : `<label class="lc-sl"><span>${label}</span><b data-dv="${k}"></b><input type="range" data-dk="${k}" min="${min}" max="${max}" step="${step}" value="${base[k]}" oninput="dcfSet(this)"></label>`).join('')}</div>
  <button type="button" class="dash-btn" onclick="dcfReset()">Reset to the starting numbers</button>
  <details class="dcf-src"><summary>Where every starting number comes from</summary><ul>
   <li><b>Free cash flow:</b> ${usd(base.fcf)} over the last 12 months${f.fcfReported != null ? ` (cash from operations minus spending on equipment and buildings${f.fcfAsOf ? `, through ${f.fcfAsOf}` : ''})` : ''}, from the company's reports via Yahoo Finance.</li>
   <li><b>Growth:</b> starts at the latest yearly revenue growth${f.revenueGrowth == null ? ' (not reported, so 5%)' : ''}, capped between −5% and 30%, then half that for years 6 to 10.</li>
   <li><b>Discount rate:</b> the 10-year Treasury yield (${pct1(base.rf)}) plus its beta (${base.beta.toFixed(2)}) times a 5% extra return investors expect from stocks.</li>
   <li><b>Shares:</b> market cap ÷ price = ${(base.shares / 1e9).toFixed(2)} billion. <b>Net cash:</b> cash minus debt = ${usd(base.netCash)}.</li>
   <li>The value of all future cash, shrunk to today's dollars, plus net cash, divided by shares.</li>
  </ul></details>
  ${insightNote("A DCF is only as good as its inputs: small changes in growth or the discount rate move the answer a lot. That's why you can change them. Not financial advice.")}`,
  'What the business could be worth from the cash it produces. Change any number and the value updates.')}</div>`;
}
function dcfRun() {
 if (!_dcf) return;
 const { p, price } = _dcf, box = document.getElementById('dcfOut');
 document.querySelectorAll('[data-dv]').forEach(b => {
  const k = b.dataset.dv;
  b.textContent = k === 'fcf' ? usd(p.fcf) : pct1(p[k]);
  const inp = document.querySelector(`[data-dk="${k}"]`);
  if (inp) inp.style.setProperty('--fill', `${((inp.value - inp.min) / (inp.max - inp.min) * 100).toFixed(1)}%`);
 });
 if (!box) return;
 const v = dcfValue(p);
 if (!v) { box.innerHTML = '<p class="in-p">The discount rate has to be above the forever growth rate for the math to work.</p>'; return; }
 const gap = v.perShare / price - 1, ig = impliedGrowth(p, price), tvShare = v.tvPv / (v.pv + v.tvPv);
 const maxF = Math.max(...v.flows);
 box.innerHTML = `
  <div class="dcf-head"><div><span>Value per share</span><b>${fmtPx(v.perShare)}</b></div><div><span>Today's price</span><b>${fmtPx(price)}</b></div>
   <div><span>Difference</span><b class="${gap >= 0 ? 'up' : 'dn'}">${sgn0(gap)}</b></div></div>
  <p class="in-p">${gap >= 0.1 ? `With these numbers, it's worth about <b>${pct0(gap)} more</b> than today's price.` : gap <= -0.1 ? `With these numbers, today's price is about <b>${pct0(-gap / (1 + gap))} above</b> what the cash flows support.` : 'With these numbers, today\'s price is about right.'}
   ${ig != null ? ` Today's price assumes cash flow grows about <b>${pct1(ig)} a year</b> for five years (half that after).` : ''}</p>
  <div class="dcf-bars" aria-label="Projected free cash flow, years 1 to 10">${v.flows.map((x, i) => `<i style="height:${Math.max(4, x / maxF * 100).toFixed(0)}%" title="Year ${i + 1}: ${usd(x)}"></i>`).join('')}</div>
  <p class="in-note">Projected free cash flow, years 1 to 10. ${pct0(tvShare)} of the value comes from after year 10, which is the most uncertain part.</p>`;
}
function dcfSet(inp) { if (!_dcf) return; _dcf.p[inp.dataset.dk] = +inp.value; dcfRun(); }
function dcfReset() {
 if (!_dcf) return;
 _dcf.p = { ..._dcf.base };
 document.querySelectorAll('[data-dk]').forEach(i => { i.value = _dcf.base[i.dataset.dk]; });
 dcfRun();
}

/* ── Options pulse ── */
async function renderOptionsTab() {
 const el = document.getElementById('rsOpts'), S = window._rs;
 if (!el || !S) return;
 const t = S.ticker, k = S.type || tickerKind(t);
 if (k === 'c' || k === 'i') { el.innerHTML = `<div class="in-pane">${insightNote('Options data is shown for stocks and funds.')}</div>`; return; }
 el.innerHTML = `<div class="in-pane">${inLoading('Reading the options market')}</div>`;
 let o = null;
 try { const r = await fetch(`/api/fundamentals?options=1&symbol=${encodeURIComponent(ySym(t, k))}`); if (r.ok) o = await r.json(); } catch {}
 if (window._rs?.ticker !== t || !document.getElementById('rsOpts')) return;
 if (!o) { el.innerHTML = `<div class="in-pane">${insightNote(`No options data for ${t} right now. Not every stock has listed options.`)}</div>`; return; }
 const hv = liveStats(t)?.vol;
 const exp = new Date(o.expiry + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
 const pc = o.putCallVolume;
 const pcWord = pc == null ? '' : pc > 1 ? 'more puts than calls: traders are hedging or bearish' : pc < 0.7 ? 'more calls than puts: traders lean bullish' : 'a fairly even mix';
 el.innerHTML = `<div class="in-pane">${inSection('Options pulse', `
  <div class="in-grid">
   <div><span>Implied volatility</span><b>${pct0(o.iv)}</b><small>${hv != null && o.iv != null ? `options expect ${o.iv > hv * 1.15 ? 'bigger swings than' : o.iv < hv * 0.85 ? 'smaller swings than' : 'about the same swings as'} its past year (${pct0(hv)})` : 'the yearly swing options are pricing in'}</small></div>
   <div><span>Expected move by ${exp}</span><b>±${pct1(o.expectedMovePct)}</b><small>±${fmtPx(o.expectedMove)}: about a 2 in 3 chance it ends inside this range</small></div>
   <div><span>Put/call ratio</span><b>${pc ?? '—'}</b><small>${pcWord}${o.putCallOpenInterest != null ? ` (open positions: ${o.putCallOpenInterest})` : ''}</small></div>
   <div><span>Protect your shares</span><b>${o.protectivePut ? pct1(o.protectivePut.costPct) : '—'}</b><small>${o.protectivePut ? `a ${fmtPx(o.protectivePut.strike)} put costs about ${fmtPx(o.protectivePut.cost)} a share and limits losses below that price until ${exp}` : 'no put prices available'}</small></div>
  </div>`, `The ${exp} expiry, ${o.days} days out.`)}
  ${inSection('Unusual activity', o.unusual.length ? `
   <div class="in-table-wrap"><table class="in-table">
    <thead><tr><th>Contract</th><th>Expires</th><th>Volume</th><th>Open interest</th><th>Volume ÷ open</th></tr></thead>
    <tbody>${o.unusual.map(u => `<tr><td>${fmtPx(u.strike)} <b class="${u.type === 'call' ? 'up' : 'dn'}">${u.type}</b></td><td>${new Date(u.expiry + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td><td>${u.volume.toLocaleString()}</td><td>${u.openInterest.toLocaleString()}</td><td>${u.openInterest ? (u.volume / u.openInterest).toFixed(1) + '×' : 'new'}</td></tr>`).join('')}</tbody>
   </table></div>
   ${insightNote('Contracts that traded more than twice their open positions (and at least 500 contracts): a sign of big new bets. Calls profit if the price rises, puts if it falls. One trade can also be a hedge, so treat it as a clue, not a signal.')}`
   : '<p class="in-sub">No contracts with unusually heavy trading in the next few expiries.</p>')}
  ${insightNote('Options data from Yahoo Finance, can be delayed. Options are risky and many expire worthless. New to them? <a href="#" onclick="openLesson(\'options\');return false">Read the options lesson</a>.')}
 </div>`;
}

/* ── Fill the new tabs when a stock page's data arrives ── */
function fillInsights(c, D) {
 const R = D?.R;
 if (!R) return;
 window._rs = Object.assign(window._rs || {}, { type: c.type });
 const dcf = document.getElementById('rsDcf');
 if (dcf) { dcf.innerHTML = dcfHTML(R); dcfRun(); }
 if (document.getElementById('rsStress')) renderStressTab();
 if (document.getElementById('rsOpts')) renderOptionsTab();
 // The DCF's discount rate uses today's 10-year yield; refresh once it's in
 if (R.kind === 'stock' && livePrice('US10Y') == null) fetchQuotes([['US10Y', 'i']]).then(() => {
  if (window._rs?.ticker === c.ticker && _dcf?.t === c.ticker && JSON.stringify(_dcf.p) === JSON.stringify(_dcf.base)) { const el = document.getElementById('rsDcf'); if (el) { el.innerHTML = dcfHTML(R); dcfRun(); } }
 });
}

/* ── Portfolio stress test (Portfolio and Paper Trade) ── */
function portfolioPositions(kind) {
 if (kind === 'pt') {
  const pt = getPtPortfolio();
  const pos = Object.entries(pt.holdings || {}).map(([t, h]) => { const sh = typeof h === 'object' && h ? Number(h.shares) || 0 : Number(h) || 0; return { t, k: tickerKind(t), sh, value: sh * ptDailyPrice(t) }; }).filter(p => p.value > 0);
  return { pos, cash: Number(pt.cash) || 0 };
 }
 const pos = holdings.map(h => ({ t: h.ticker, k: h.type || tickerKind(h.ticker), sh: Number(h.shares) || 0, value: (Number(h.shares) || 0) * (livePrice(h.ticker) ?? Number(h.buyPrice) ?? 0) })).filter(p => p.value > 0);
 return { pos, cash: 0 };
}
// The last result for each page, kept while the holdings stay the same: Paper Trade redraws itself as prices update
const _stressLast = {};
const stressSig = pos => pos.map(p => `${p.t}:${p.sh}`).sort().join(',');
function mountPortfolioStress(kind) {
 if (tab !== kind) return;
 const mc = document.getElementById('mainContent');
 if (!mc || document.getElementById('stressCard')) return;
 const { pos } = portfolioPositions(kind);
 if (!pos.length) return;
 const last = _stressLast[kind]?.sig === stressSig(pos) ? _stressLast[kind].html : null;
 mc.insertAdjacentHTML('beforeend', `<section class="card in-card" id="stressCard">
  <div class="card-hdr"><div class="card-hdr-title">Stress test: past crashes</div><div class="card-hdr-sub">How today's ${kind === 'pt' ? 'practice portfolio' : 'holdings'} would have done in real market crashes</div></div>
  <div class="asset-pad" id="stressBody">${last || `<button type="button" class="dash-btn dash-btn-main" onclick="runPortfolioStress('${kind}')">Run the stress test</button>`}</div>
 </section>`);
 // A tab in the tools panel: the one-screen desktop grid has no room for another card
 // Mounted in the same step as the page draw, so the panel can reopen on this tab if it was the last one used
 const wrap = ssTabify(kind, [{ el: document.getElementById('stressCard'), label: 'Stress test', order: kind === 'pt' ? 2.5 : 3.5 }]);
 let saved = null;
 try { saved = localStorage.getItem('ss_tab_' + kind); } catch {}
 const i = wrap && saved === 'Stress test' ? [...wrap.querySelectorAll(':scope > .ss-tabs-bar > .ss-tab')].findIndex(b => b.textContent === saved) : -1;
 if (i >= 0) ssTabSelect(wrap, i, false);
}
async function runPortfolioStress(kind) {
 const box = document.getElementById('stressBody');
 if (!box) return;
 const { pos, cash } = portfolioPositions(kind);
 _stressLast[kind] = { sig: stressSig(pos), html: inLoading('Replaying past crashes with your holdings') };
 box.innerHTML = _stressLast[kind].html;
 const total = pos.reduce((s, p) => s + p.value, 0) + cash;
 await fetchStats(pos.map(p => [p.t, p.k])).catch(() => null);
 const [spx, ...hists] = await Promise.all([getLongHistory('^GSPC'), ...pos.map(p => getLongHistory(ySym(p.t, p.k)))]);
 const out = () => document.getElementById('stressBody');   // the page may have redrawn while this ran
 if (!out()) { delete _stressLast[kind]; return; }
 if (!spx) { delete _stressLast[kind]; out().innerHTML = insightNote("Price history didn't load. Try again in a minute."); return; }
 const estNames = new Set();
 const rows = CRISES.map(c => {
  const s = crisisMove(spx, c);
  if (!s) return null;
  let change = 0, est = false;
  pos.forEach((p, i) => {
   const m = hists[i] ? crisisMove(hists[i], c) : null;
   if (!m) { estNames.add(p.t); est = true; }
   change += p.value * (m ? m.move : Math.max(-0.95, betaOf(p.t) * s.move));
  });
  return { c, s, port: total ? change / total : 0, dollars: change, est };
 }).filter(Boolean);
 const worst = rows.reduce((a, b) => (b.port < a.port ? b : a), rows[0]);
 const html = `
  <p class="in-p">Your worst case: the <b>${worst.c.name}</b>, about <b class="${worst.port < 0 ? 'dn' : 'up'}">${sgn0(worst.port)}</b>, or ${worst.dollars < 0 ? 'a loss of ' : ''}${usd(Math.abs(worst.dollars))} of today's ${usd(total)}${kind === 'pt' && cash ? ' (cash in the account stays put)' : ''}.</p>
  <div class="in-table-wrap"><table class="in-table">
   <thead><tr><th>Crash</th><th>S&amp;P 500</th><th>Your portfolio</th></tr></thead>
   <tbody>${rows.map(x => `<tr><td>${x.c.name}<small>${x.c.start.slice(0, 7)} to ${x.c.end.slice(0, 7)}</small></td><td class="dn">${sgn0(x.s.move)}</td><td class="${x.port < 0 ? 'dn' : 'up'}">${sgn0(x.port)}<small>${x.dollars < 0 ? '−' : '+'}${usd(Math.abs(x.dollars))} today</small></td></tr>`).join('')}</tbody>
  </table></div>
  ${estNames.size ? insightNote(`Some holdings weren't trading during every crash (${[...estNames].slice(0, 6).join(', ')}${estNames.size > 6 ? ' and more' : ''}). For those, it uses each one's beta times the S&amp;P 500's move: a rough guess.`) : ''}
  ${insightNote("Today's holdings, replayed from the start of each crash to the market's bottom using weekly closing prices. Past crashes won't repeat exactly. Not financial advice.")}
  <div class="in-actions">${crashShareBtn(kind, 'Share my crash test')}<button type="button" class="dash-btn" onclick="runPortfolioStress('${kind}')">Run again</button></div>`;
 _crashShare[kind] = { tickers: [...pos].sort((a, b) => b.value - a.value).map(p => p.t), rows: rows.map(x => ({ c: x.c, spx: x.s.move, you: x.port, est: x.est })) };
 _stressLast[kind] = { sig: stressSig(pos), html };
 if (out()) out().innerHTML = html;
 track('stress_test', { kind });
}
/* ── Crash test share card ── */
// Rows behind the last crash table on each page: { stock: { t, rows }, port: { tickers, rows }, pt: { tickers, rows } }
const _crashShare = {};
const crashShareBtn = (kind, label) => `<button type="button" class="dash-btn dash-btn-main in-share" onclick="shareCrashTest('${kind}', this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>${label}</button>`;
// Percentages only, never dollars, so people can share it without showing what they own in money
async function drawCrashCard({ who, title, sub, rows }) {
 const W = 1080, H = 1350, P = 72;
 const c = document.createElement('canvas'); c.width = W; c.height = H;
 const x = c.getContext('2d');
 await drawCardChrome(x, W, H, P, title);
 const { font, text, box } = cardKit(x);
 const pc = v => { const n = Math.round(Math.abs(v) * 100); return `${n && v > 0 ? '+' : n && v < 0 ? '\u2212' : ''}${n}%`; };
 const dim = 'rgba(246,241,255,0.55)', faint = 'rgba(246,241,255,0.4)', ink = '#f6f1ff', violet = '#a78bfa', red = '#fca5a5', green = '#86efac';

 text('CRASH TEST', P, 186, 700, 24, '#b49cfc');
 // One line if it fits at 50px or more; otherwise two lines at 56px
 let tpx = 60;
 for (; tpx >= 50; tpx -= 2) { x.font = font(800, tpx); if (x.measureText(title).width <= W - P * 2) break; }
 const lines = [];
 if (tpx < 50) {
  tpx = 56; x.font = font(800, tpx);
  const at = title.indexOf(' vs. ');
  if (at > 0 && x.measureText(title.slice(0, at)).width <= W - P * 2 && x.measureText(title.slice(at + 1)).width <= W - P * 2) lines.push(title.slice(0, at), title.slice(at + 1));
  else for (const w of title.split(' ')) { const l = lines.length ? `${lines[lines.length - 1]} ${w}` : w; if (lines.length && x.measureText(l).width <= W - P * 2) lines[lines.length - 1] = l; else lines.push(w); }
 } else lines.push(title);
 lines.slice(0, 2).forEach((l, i) => text(l, P, 254 + i * 66, 800, tpx, ink));
 const subY = 254 + (Math.min(lines.length, 2) - 1) * 66 + 54;   // everything below follows the title's height
 if (sub) text(sub, P, subY, 400, 28, dim);

 // Headline numbers: the worst drop, and how often it fell less than the market
 const worst = rows.reduce((a, b) => (b.you < a.you ? b : a), rows[0]);
 const beat = rows.filter(r => r.you > r.spx).length;
 const hy = subY + 64, hh = 186;
 x.fillStyle = 'rgba(255,255,255,0.045)'; x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 2;
 box(P, hy, W - P * 2, hh, 28); x.fill(); x.stroke();
 x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect(W / 2, hy + 30, 2, hh - 60);
 text('WORST DROP', P + 40, hy + 52, 700, 21, faint);
 text(pc(worst.you), P + 40, hy + 128, 800, 76, worst.you < 0 ? red : green);
 text(`${worst.c.short || worst.c.name} (S&P 500 ${pc(worst.spx)})`, P + 40, hy + 164, 400, 22, dim);
 text('BEAT THE S&P 500', W / 2 + 40, hy + 52, 700, 21, faint);
 text(`${beat} of ${rows.length}`, W / 2 + 40, hy + 128, 800, 76, '#c4b5fd');
 text('crashes where it fell less', W / 2 + 40, hy + 164, 400, 22, dim);

 // One row per crash: the S&P 500 (grey) over `who` (violet), on one scale
 const ly = hy + hh + 56;
 x.fillStyle = 'rgba(246,241,255,0.35)'; box(P, ly - 15, 18, 18, 4); x.fill();
 text('S&P 500', P + 30, ly, 600, 22, dim);
 x.font = font(600, 22); const lw = x.measureText('S&P 500').width;
 x.fillStyle = violet; box(P + 30 + lw + 36, ly - 15, 18, 18, 4); x.fill();
 text(who, P + 30 + lw + 66, ly, 600, 22, dim);
 const est = rows.some(r => r.est);
 const bx = 430, bw = 470, top = ly + 30, rh = Math.min(58, ((est ? 1080 : 1110) - top) / rows.length);
 const max = Math.max(0.2, ...rows.flatMap(r => [Math.abs(r.spx), Math.abs(r.you)]));
 const bar = (v, y, h, col) => { const w = Math.max(4, Math.min(1, Math.abs(v) / max) * bw); x.fillStyle = col; box(bx, y, w, h, h / 2); x.fill(); return w; };
 rows.forEach((r, i) => {
  const y = top + i * rh;
  if (i) { x.fillStyle = 'rgba(255,255,255,0.06)'; x.fillRect(P, y - 4, W - P * 2, 1); }
  text(`${r.c.short || r.c.name}${r.est ? '*' : ''}`, P, y + 33, 600, 25, ink);
  const w1 = bar(r.spx, y + 8, 15, 'rgba(246,241,255,0.35)');
  text(pc(r.spx), bx + w1 + 12, y + 22, 600, 19, dim);
  const w2 = bar(r.you, y + 29, 17, r.you < 0 ? violet : green);
  text(pc(r.you), bx + w2 + 12, y + 45, 800, 22, r.you < 0 ? ink : green);
 });
 const after = top + rows.length * rh;
 if (est) text("* Estimated: not everything was trading yet, so it uses each one's beta times the S&P 500's move.", P, after + 26, 400, 19, faint);

 text('Run your own crash test at', P, 1170, 400, 28, dim);
 text('stocksightai.com', P, 1214, 700, 34, ink);
 text("Past crashes won't repeat exactly. Not financial advice.", W - P, 1214, 400, 20, faint, 'right');
 return c;
}
async function shareCrashTest(kind, btn) {
 const d = _crashShare[kind];
 if (!d?.rows?.length) { toast('Run the crash test first.', 'info'); return; }
 if (btn) btn.disabled = true;
 try {
  let card;
  if (kind === 'stock') {
   const name = rsName(d.t, window._rs?.ticker === d.t ? window._rs.R?.facts : null);
   card = { who: d.t, title: `${name} vs. ${d.rows.length} market crashes`, sub: name === d.t ? 'Crash by crash, against the S&P 500' : `${d.t}, crash by crash, against the S&P 500`, rows: d.rows };
  } else {
   const shown = d.tickers.slice(0, 6).join(' \u00b7 ') + (d.tickers.length > 6 ? ` +${d.tickers.length - 6} more` : '');
   card = { who: kind === 'pt' ? 'My practice portfolio' : 'My portfolio', title: `${kind === 'pt' ? 'My practice portfolio' : 'My portfolio'} vs. ${d.rows.length} market crashes`, sub: shown, rows: d.rows };
  }
  const canvas = await drawCrashCard(card);
  const worst = d.rows.reduce((a, b) => (b.you < a.you ? b : a), d.rows[0]);
  const url = kind === 'stock' ? `https://stocksightai.com/stock/${encodeURIComponent(d.t)}` : 'https://stocksightai.com';
  const line = kind === 'stock'
   ? `${d.t} vs. ${d.rows.length} market crashes on StockSight. Worst: ${sgn0(worst.you)} in the ${worst.c.name}.`
   : `My portfolio vs. ${d.rows.length} market crashes. Worst: ${sgn0(worst.you)} in the ${worst.c.name}. Run yours on StockSight:`;
  await shareImage(canvas, { file: `stocksight-crash-test${kind === 'stock' ? '-' + d.t : ''}.png`, text: line, url, type: 'crash_card', id: kind === 'stock' ? d.t : kind });
 } catch (e) {
  console.warn('crash card:', e);
  toast('Could not make the image. Please try again.', 'error');
 } finally {
  if (btn) btn.disabled = false;
 }
}

// Add the Stress test tab to Portfolio and Paper Trade whenever they draw
{
 const wrap = name => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); try { mountPortfolioStress(name === 'renderPortfolio' ? 'port' : 'pt'); } catch (e) { console.warn('stress tab', e); } return r; }; };
 wrap('renderPortfolio');
 wrap('renderPaperTradeTab');
}

// Extra lines for the chat's bear-case answer
function bearChatExtra(R) {
 const sc = R ? bearScenarios(R) : [];
 return sc.length ? '<br><br><strong>What the downside could look like</strong><br>' + sc.map(([l, v]) => `• ${l}: ${sgn0(v)}`).join('<br>') : '';
}
