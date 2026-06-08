export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, code, name } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Missing email or code' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'StockSight <onboarding@resend.dev>',
        to: email,
        subject: 'Your StockSight password reset code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#05050e;color:#ffffff;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#6c5ce7,#a29bfe);padding:28px 32px;text-align:center">
              <h1 style="margin:0;font-size:24px;font-weight:900;color:#fff">StockSight</h1>
              <p style="margin:4px 0 0;font-size:14px;color:rgba(255,255,255,0.8)">Password Reset</p>
            </div>
            <div style="padding:32px">
              <p style="margin:0 0 8px;color:#ccc;font-size:15px">Hi${name ? ' ' + name : ''},</p>
              <p style="margin:0 0 24px;color:#ccc;font-size:15px">Here is your 6-digit reset code:</p>
              <div style="background:rgba(108,92,231,0.15);border:2px dashed rgba(108,92,231,0.5);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
                <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#a29bfe">${code}</span>
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
