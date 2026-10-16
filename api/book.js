// Vercel serverless function: receives a "book a 15-minute call" request from /book.html,
// emails Adam the booking and the prospect a confirmation. Mirrors api/contact.js exactly
// (same origin check, honeypot, rate limit, SendGrid via fetch, no npm dependencies).
//
// Env (shared with contact.js):
//   SENDGRID_API_KEY   required; without it the function returns 503 and the page offers a mailto fallback
//   CONTACT_TO         where bookings land (default adam.mainlinewebdesign@gmail.com)
//   CONTACT_FROM       a sender verified in SendGrid
//   ALLOWED_HOSTS      comma list of allowed Origin hosts
//
// Security note: the prospect's confirmation email contains ONLY the formatted time and static copy.
// Nothing typed into the form is echoed back to them, so the endpoint cannot be used to relay text.

var TO_DEFAULT = 'adam.mainlinewebdesign@gmail.com';
var HOSTS_DEFAULT = 'mainline-webdesign.com,www.mainline-webdesign.com';
var TZ = 'America/New_York';
var CALL_MIN = 15;
var MIN_LEAD_MS = 30 * 60000;          // reject anything sooner than 30 min out (page enforces 3h; this is the backstop)
var MAX_AHEAD_MS = 60 * 86400000;      // and anything more than 60 days out
var MAX = { name: 120, email: 200, phone: 40, org: 160, notes: 2000, other: 80, url: 300 };
var hits = {};

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
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
    return Promise.resolve({});
  }
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (c) { data += c; if (data.length > 20000) { data = data.slice(0, 20000); } });
    req.on('end', function () { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}

async function sendgrid(key, msg) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    var r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: ctrl.signal
    });
    if (r.status >= 300) {
      var t = '';
      try { t = await r.text(); } catch (e) {}
      throw new Error('SendGrid ' + r.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 300));
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('SendGrid request timed out after 8s');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Formatting helpers. Node 18+ on Vercel ships full ICU, so time zones work here.
function fmtIn(d, tz, withZone) {
  var o = { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (withZone) o.timeZoneName = 'short';
  try { return d.toLocaleString('en-US', o); } catch (e) { return d.toUTCString(); }
}
function utcStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function gcalLink(start, title) {
  var end = new Date(start.getTime() + CALL_MIN * 60000);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
    '&dates=' + utcStamp(start) + '/' + utcStamp(end) +
    '&details=' + encodeURIComponent('15-minute call about a league website.');
}
function validTZ(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'POST only' }); }
  var ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') !== 0) return send(res, 415, { ok: false, error: 'Unsupported content type.' });

  var allowed = String(process.env.ALLOWED_HOSTS || HOSTS_DEFAULT).split(',').map(function (h) { return h.trim().toLowerCase(); }).filter(Boolean);
  var origin = req.headers.origin ? hostOf(req.headers.origin) : '';
  var reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().split(':')[0];
  if (reqHost && allowed.indexOf(reqHost) < 0 && !/\.vercel\.app$/.test(reqHost)) allowed.push(reqHost);
  if (origin && allowed.indexOf(origin) < 0) return send(res, 403, { ok: false, error: 'Cross-site submissions are not accepted.' });
  if (Number(req.headers['content-length'] || 0) > 20000) return send(res, 413, { ok: false, error: 'Message too long.' });

  var ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || 'unknown';
  var now = Date.now();
  hits[ip] = (hits[ip] || []).filter(function (t) { return now - t < 600000; });
  if (hits[ip].length >= 5) return send(res, 429, { ok: false, error: 'Too many bookings from this connection. Email ' + TO_DEFAULT + ' directly.', fallback: true });

  var b = await readBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};
  if (clean(b.website2, 50)) { hits[ip].push(now); return send(res, 200, { ok: true }); } // honeypot

  var f = {
    name: clean(b.name, MAX.name),
    email: clean(b.email, MAX.email).toLowerCase(),
    phone: clean(b.phone, MAX.phone),
    org: clean(b.org, MAX.org),
    notes: clean(b.notes, MAX.notes, true),
    tz: clean(b.tz, MAX.other),
    page: clean(b.page, MAX.url)
  };
  if (!f.name || !validEmail(f.email) || !f.phone || !f.org) return send(res, 400, { ok: false, error: 'Name, phone, a valid email, and your league are required.' });

  // The time is the one thing that must be exactly right: parse it, never trust a label.
  var start = new Date(String(b.startISO || ''));
  if (isNaN(start.getTime())) return send(res, 400, { ok: false, error: 'Pick a time first.' });
  if (start.getTime() < now + MIN_LEAD_MS) return send(res, 400, { ok: false, error: 'That time has passed. Pick a later one.' });
  if (start.getTime() > now + MAX_AHEAD_MS) return send(res, 400, { ok: false, error: 'That time is too far out. Pick one within the next two months.' });
  if (!validTZ(f.tz)) f.tz = TZ;

  var key = process.env.SENDGRID_API_KEY;
  var to = String(process.env.CONTACT_TO || TO_DEFAULT).trim().toLowerCase();
  var cf = String(process.env.CONTACT_FROM || '').trim().toLowerCase();
  var from = validEmail(cf) ? cf : 'hello@mainline-webdesign.com';
  if (!key) return send(res, 503, { ok: false, error: 'Mail is not configured yet.', fallback: true });

  hits[ip].push(now);

  var whenET = fmtIn(start, TZ, true);
  var whenTheirs = fmtIn(start, f.tz, true);
  var sameZone = (f.tz === TZ);
  var title = 'Call: ' + f.name + ' (' + f.org + ')';
  var adamCal = gcalLink(start, title);
  var theirCal = gcalLink(start, 'Call with Adam Miller (Main Line Web Design)');

  // ---- email to Adam ----
  var subject = 'Call booked: ' + f.org.replace(/\s+/g, ' ').slice(0, 60) + ' — ' + whenET;
  var rows = [
    ['When (Eastern)', whenET], sameZone ? null : ['Their local time', whenTheirs + ' (' + f.tz + ')'],
    ['Name', f.name], ['Phone (call this)', f.phone], ['Email', f.email], ['League / org', f.org], ['From page', f.page], ['IP', ip]
  ].filter(function (r) { return r && r[1]; });
  var text = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') + '\n\nNotes:\n' + (f.notes || '(blank)') + '\n\nAdd to your calendar: ' + adamCal + '\n';
  var html = '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#0f172a">' +
    '<h2 style="margin:0 0 12px;font-size:18px">Call booked from mainline-webdesign.com</h2>' +
    '<table style="border-collapse:collapse">' + rows.map(function (r) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap">' + esc(r[0]) + '</td><td style="padding:4px 0">' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>' +
    '<h3 style="margin:18px 0 6px;font-size:14px">Notes</h3>' +
    '<p style="white-space:pre-wrap;margin:0;line-height:1.5">' + esc(f.notes || '(blank)') + '</p>' +
    '<p style="margin:18px 0 0"><a href="' + esc(adamCal) + '" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Add to Google Calendar</a></p>' +
    '<p style="margin:14px 0 0;color:#64748b;font-size:12px">Reply to this email to reach them directly.</p></div>';

  // ---- confirmation to the prospect: formatted time + static copy only ----
  var line = sameZone ? whenET : (whenTheirs + ' (' + whenET + ')');
  var replyText = 'You\'re booked for a 15-minute call with Adam Miller at Main Line Web Design.\n\nWhen: ' + line + '\n\nI\'ll call the number you gave me. If something comes up, just reply to this email and we\'ll find another time.\n\nAdd it to your calendar: ' + theirCal + '\n\nAdam Miller\nMain Line Web Design\nhttps://mainline-webdesign.com\n';
  var replyHtml = '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">'
    + '<p style="margin:0 0 14px">You\'re booked for a 15-minute call with Adam Miller at Main Line Web Design.</p>'
    + '<p style="margin:0 0 14px"><strong>When:</strong> ' + esc(line) + '</p>'
    + '<p style="margin:0 0 14px">I\'ll call the number you gave me. If something comes up, just reply to this email and we\'ll find another time.</p>'
    + '<p style="margin:0 0 18px"><a href="' + esc(theirCal) + '" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Add to Google Calendar</a></p>'
    + '<p style="margin:18px 0 0">Adam Miller<br>Main Line Web Design<br><a href="https://mainline-webdesign.com" style="color:#2563eb;text-decoration:underline">mainline-webdesign.com</a></p>'
    + '</div>';

  try {
    await sendgrid(key, {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Main Line Web Design' },
      reply_to: { email: f.email },
      subject: subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
      tracking_settings: { click_tracking: { enable: false, enable_text: false } }
    });
    try {
      await sendgrid(key, {
        personalizations: [{ to: [{ email: f.email }] }],
        from: { email: from, name: 'Adam Miller, Main Line Web Design' },
        reply_to: { email: to },
        subject: 'Booked: your call with Adam, ' + whenTheirs,
        content: [{ type: 'text/plain', value: replyText }, { type: 'text/html', value: replyHtml }],
        tracking_settings: { click_tracking: { enable: false, enable_text: false } }
      });
    } catch (e) { console.error('confirmation failed', e.message); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('booking send failed', e.message);
    return send(res, 502, { ok: false, error: 'Could not send right now.', fallback: true });
  }
};
