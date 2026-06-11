// In-memory rate limit store — best-effort on Vercel (each instance is isolated).
// For strict enforcement across instances, swap this for Upstash Redis.
const ipHits = new Map();   // ip -> { count, resetAt }
const emailHits = new Map(); // email -> { count, resetAt }

const WINDOW_MS = 60 * 1000; // 1 minute
const IP_LIMIT = 5;           // max 5 requests/min per IP
const EMAIL_LIMIT = 3;        // max 3 requests/min per email

function isRateLimited(store, key, limit) {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= limit) return true;
  entry.count++;
  return false;
}

// Strict email regex (RFC 5321 practical subset)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
// Reset code must be exactly 6 digits
const CODE_RE = /^\d{6}$/;
// Name: optional, letters/spaces/hyphens only, max 60 chars
const NAME_RE = /^[a-zA-Z\s\-']{1,60}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Reject unexpected fields — only allow email, code, name
  const allowedFields = new Set(['email', 'code', 'name']);
  const bodyKeys = Object.keys(req.body || {});
  if (bodyKeys.some(k => !allowedFields.has(k))) {
    return res.status(400).json({ error: 'Unexpected fields in request' });
  }

  const { email, code, name } = req.body;

  // Type checks
  if (typeof email !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid input types' });
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid input types' });
  }

  // Sanitize — trim whitespace
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();
  const cleanName = name ? name.trim() : null;

  // Validate email
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Validate code
  if (!CODE_RE.test(cleanCode)) {
    return res.status(400).json({ error: 'Invalid reset code format' });
  }

  // Validate name if provided
  if (cleanName && !NAME_RE.test(cleanName)) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ipHits, ip, IP_LIMIT)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  // Rate limit by email
  if (isRateLimited(emailHits, cleanEmail, EMAIL_LIMIT)) {
    return res.status(429).json({ error: 'Too many requests for this email. Please wait a moment.' });
  }

  // API key must come from environment — never hardcode or expose client-side
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'StockSight <noreply@stocksightai.com>',
        to: cleanEmail,
        subject: 'Your StockSight password reset code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#05050e;color:#ffffff;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#6c5ce7,#a29bfe);padding:28px 32px;text-align:center">
              <h1 style="margin:0;font-size:24px;font-weight:900;color:#fff">StockSight</h1>
              <p style="margin:4px 0 0;font-size:14px;color:rgba(255,255,255,0.8)">Password Reset</p>
            </div>
            <div style="padding:32px">
              <p style="margin:0 0 8px;color:#ccc;font-size:15px">Hi${cleanName ? ' ' + cleanName : ''},</p>
              <p style="margin:0 0 24px;color:#ccc;font-size:15px">Here is your 6-digit reset code:</p>
              <div style="background:rgba(108,92,231,0.15);border:2px dashed rgba(108,92,231,0.5);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
                <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#a29bfe">${cleanCode}</span>
              </div>
              <p style="margin:0 0 8px;color:#888;font-size:13px">⏱ This code expires in <strong style="color:#fff">15 minutes</strong>.</p>
              <p style="margin:0;color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
            </div>
            <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.08);text-align:center">
              <p style="margin:0;color:#555;font-size:12px">StockSight · stocksightai.com</p>
            </div>
          </div>
        `
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(500).json({ error: result.message || 'Failed to send email' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Send reset email error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
