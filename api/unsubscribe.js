// Unsubscribe from the weekly digest with the signed link in every email.
// GET  shows a confirm button (link scanners in inboxes open GET links, so GET never unsubscribes)
// POST unsubscribes; mail apps also POST here for one-click unsubscribe (RFC 8058)
import { readUnsubscribe, patchUser, fail } from './_auth.js';

const page = (title, body, form = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · StockSight</title>
<script>try { if (localStorage.getItem('ss_theme') === 'light') document.documentElement.setAttribute('data-theme', 'light'); } catch (e) {}</script>
<style>
/* Same theme as the site: dark unless this device picked light */
:root{--bg:#0f0f13;--card:#16161c;--ink:#ececf1;--ink2:#a4a4b4;--line:rgba(255,255,255,.09);--accent:#8b5cf6;color-scheme:dark}
:root[data-theme="light"]{--bg:#f6f6f9;--card:#fff;--ink:#15151d;--ink2:#585869;--line:#e8e8ef;--accent:#6d28d9;color-scheme:light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);
 font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:0 16px}
main{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px 28px;text-align:center}
.logo{font-weight:800;font-size:20px;letter-spacing:-.02em;color:var(--ink);text-decoration:none}.logo span{color:var(--accent)}
h1{font-size:22px;margin:22px 0 8px;letter-spacing:-.01em}p{color:var(--ink2);line-height:1.55;margin:0 0 20px}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:12px;padding:13px 22px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
a.sub{display:block;margin-top:14px;color:var(--ink2);font-size:14px}
</style></head><body><main><a class="logo" href="https://stocksightai.com">Stock<span>Sight</span></a>
<h1>${title}</h1><p>${body}</p>${form}</main></body></html>`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const email = readUnsubscribe(req.query?.e, req.query?.s);
  if (!email) {
    return res.status(400).send(page('Link not valid', 'This unsubscribe link is incomplete or has expired. You can turn the weekly digest off any time in StockSight under Settings → Notifications.',
      '<a class="btn" href="https://stocksightai.com">Open StockSight</a>'));
  }
  if (req.method === 'GET') {
    return res.status(200).send(page('Stop the weekly digest?', `We'll stop sending the Monday market digest to <b>${email.replace(/[<>&"]/g, '')}</b>.`,
      `<form method="post"><button type="submit">Unsubscribe</button></form><a class="sub" href="https://stocksightai.com">Keep getting it</a>`));
  }
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  try {
    await patchUser(email, { digest: false });
  } catch (e) {
    console.error('unsubscribe:', e.message);
    return res.status(500).send(page('Something went wrong', 'We could not update your settings. Please try again in a minute.'));
  }
  return res.status(200).send(page("You're unsubscribed", 'You won\'t get the weekly digest anymore. Changed your mind? Turn it back on in StockSight under Settings → Notifications.',
    '<a class="btn" href="https://stocksightai.com">Open StockSight</a>'));
}
