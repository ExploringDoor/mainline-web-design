// Vercel serverless function: receives the intake form, emails Adam via SendGrid,
// and sends the lead a short, fully static auto-reply. No npm dependencies (Node 18+ fetch).
//
// Required env (Vercel project > Settings > Environment Variables):
//   SENDGRID_API_KEY   SendGrid API key with Mail Send permission
// Optional:
//   CONTACT_TO         where leads land (default adam.mainlinewebdesign@gmail.com)
//   CONTACT_FROM       a sender verified in SendGrid (default = CONTACT_TO)
//   TURNSTILE_SECRET   if set, a Cloudflare Turnstile token is required on every submission
//   ALLOWED_HOSTS      comma list of allowed Origin hosts (default mainline-webdesign.com,www.mainline-webdesign.com)
//
// Accepts JSON (the page's fetch) and application/x-www-form-urlencoded (the no-JS fallback,
// which gets a 303 back to /?sent=1#contact). Both require a same-site Origin when one is sent.
// If SENDGRID_API_KEY is missing the function returns 503 and the page falls back to a
// pre-filled email, so the form never dead-ends.

var TO_DEFAULT = 'adam.mainlinewebdesign@gmail.com';
var HOSTS_DEFAULT = 'mainline-webdesign.com,www.mainline-webdesign.com';
var MAX = { name: 120, email: 200, org: 160, url: 300, notes: 4000, other: 80 };
var hits = {}; // per-instance soft backstop only; real abuse control is Turnstile + SendGrid limits

function clean(v, max, keepLines) {
  if (v === undefined || v === null) return '';
  var s = String(v);
  s = keepLines ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, '');
  return s.trim().slice(0, max || 200);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= MAX.email; }
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch (e) { return ''; } }
function send(res, status, obj) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); }

function readBody(req) {
  // Vercel pre-parses the body; anything other than undefined means the stream is already consumed.
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
    return Promise.resolve({});
  }
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (c) { data += c; if (data.length > 20000) { data = data.slice(0, 20000); } });
    req.on('end', function () {
      var ct = String(req.headers['content-type'] || '');
      if (ct.indexOf('application/x-www-form-urlencoded') === 0) { var o = {}; new URLSearchParams(data).forEach(function (v, k) { o[k] = v; }); return resolve(o); }
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', function () { resolve({}); });
  });
}

async function sendgrid(key, msg) {
  var r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
  if (r.status >= 300) {
    var t = '';
    try { t = await r.text(); } catch (e) {}
    throw new Error('SendGrid ' + r.status + ' ' + t.slice(0, 300));
  }
}

async function turnstileOk(secret, token, ip) {
  if (!token) return false;
  try {
    var r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret, response: token, remoteip: ip })
    });
    var j = await r.json();
    return !!(j && j.success);
  } catch (e) { return false; }
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'POST only' }); }

  var ct = String(req.headers['content-type'] || '').toLowerCase();
  var isJson = ct.indexOf('application/json') === 0;
  var isForm = ct.indexOf('application/x-www-form-urlencoded') === 0;
  if (!isJson && !isForm) return send(res, 415, { ok: false, error: 'Unsupported content type.' });

  var allowed = String(process.env.ALLOWED_HOSTS || HOSTS_DEFAULT).split(',').map(function (h) { return h.trim().toLowerCase(); }).filter(Boolean);
  var origin = req.headers.origin ? hostOf(req.headers.origin) : '';
  var referer = req.headers.referer ? hostOf(req.headers.referer) : '';
  var reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().split(':')[0];
  if (reqHost && allowed.indexOf(reqHost) < 0 && !/\.vercel\.app$/.test(reqHost)) allowed.push(reqHost); // preview deployments
  if (origin && allowed.indexOf(origin) < 0) return send(res, 403, { ok: false, error: 'Cross-site submissions are not accepted.' });
  if (isForm && !origin && referer && allowed.indexOf(referer) < 0) return send(res, 403, { ok: false, error: 'Cross-site submissions are not accepted.' });

  if (Number(req.headers['content-length'] || 0) > 20000) return send(res, 413, { ok: false, error: 'Message too long.' });

  var ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || 'unknown';
  var now = Date.now();
  hits[ip] = (hits[ip] || []).filter(function (t) { return now - t < 600000; });
  if (hits[ip].length >= 5) return send(res, 429, { ok: false, error: 'Too many submissions from this connection. Email ' + TO_DEFAULT + ' directly.', fallback: true });

  var b = await readBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};

  // Honeypot: real users never fill this. Pretend success so bots move on.
  if (clean(b.website2, 50)) { hits[ip].push(now); return isForm ? redirectDone(res) : send(res, 200, { ok: true }); }

  var f = {
    name: clean(b.name, MAX.name),
    email: clean(b.email, MAX.email).toLowerCase(),
    org: clean(b.org, MAX.org),
    orgType: clean(b.orgType, MAX.other),
    sport: clean(b.sport, MAX.other),
    teams: clean(b.teams, MAX.other),
    current: clean(b.current, MAX.other),
    url: clean(b.url, MAX.url),
    notes: clean(b.notes, MAX.notes, true),
    ref: clean(b.ref, MAX.other),
    page: clean(b.page, MAX.url)
  };
  if (!f.name || !validEmail(f.email) || !f.org) return send(res, 400, { ok: false, error: 'Name, a valid email, and your league or organization are required.' });

  var tsSecret = process.env.TURNSTILE_SECRET;
  if (tsSecret) {
    var ok = await turnstileOk(tsSecret, clean(b['cf-turnstile-response'] || b.turnstile, 2048), ip);
    if (!ok) return send(res, 400, { ok: false, error: 'Please complete the verification and try again.' });
  }

  var key = process.env.SENDGRID_API_KEY;
  var to = process.env.CONTACT_TO || TO_DEFAULT;
  var from = process.env.CONTACT_FROM || to;
  if (!key) return send(res, 503, { ok: false, error: 'Mail is not configured yet.', fallback: true });

  hits[ip].push(now);

  var subject = 'New inquiry: ' + f.org.replace(/\s+/g, ' ').slice(0, 80) + (f.orgType ? ' (' + f.orgType + ')' : '');
  var rows = [
    ['Name', f.name], ['Email', f.email], ['Organization', f.org], ['Type', f.orgType], ['Sport', f.sport],
    ['Teams', f.teams], ['Using today', f.current], ['Current site', f.url], ['Referred by', f.ref], ['From page', f.page], ['IP', ip]
  ].filter(function (r) { return r[1]; });
  var text = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + '\n\nWhat they need:\n' + (f.notes || '(blank)') + '\n';
  var html = '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a">' +
    '<h2 style="margin:0 0 12px;font-size:18px">New inquiry from mainline-webdesign.com</h2>' +
    '<table style="border-collapse:collapse">' + rows.map(function (r) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap">' + esc(r[0]) + '</td><td style="padding:4px 0">' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>' +
    '<h3 style="margin:18px 0 6px;font-size:14px">What they need</h3>' +
    '<p style="white-space:pre-wrap;margin:0;line-height:1.5">' + esc(f.notes || '(blank)') + '</p>' +
    '<p style="margin:18px 0 0;color:#64748b;font-size:12px">Reply to this email to answer them directly.</p></div>';

  // Fully static auto-reply: nothing from the request is echoed, so the endpoint cannot be used to relay text.
  var replyText = 'Thanks for reaching out to Main Line Web Design.\n\nI read every inquiry myself and will get back to you within 24 hours with a first take and a couple of questions.\n\nIn the meantime, the interactive demo is a good way to see how the admin side works:\nhttps://mainline-webdesign.com/demo.html#admin\n\nAdam Miller\nMain Line Web Design\nhttps://mainline-webdesign.com\n';

  try {
    await sendgrid(key, {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Main Line Web Design' },
      reply_to: { email: f.email },
      subject: subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
    });
    try {
      await sendgrid(key, {
        personalizations: [{ to: [{ email: f.email }] }],
        from: { email: from, name: 'Adam Miller, Main Line Web Design' },
        reply_to: { email: to },
        subject: 'Got it, thanks for reaching out',
        content: [{ type: 'text/plain', value: replyText }]
      });
    } catch (e) { console.error('auto-reply failed', e.message); }
    return isForm ? redirectDone(res) : send(res, 200, { ok: true });
  } catch (e) {
    console.error('send failed', e.message);
    return send(res, 502, { ok: false, error: 'Could not send right now.', fallback: true });
  }
};

function redirectDone(res) { res.statusCode = 303; res.setHeader('Location', '/?sent=1#contact'); res.end(); }
