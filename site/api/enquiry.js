'use strict';

/**
 * Backend for the cloned TeddyPups site.
 *
 * The original site is a Next.js App Router app whose enquiry form calls a
 * single Server Action ("sendEnquiry", id 60511b831cc28fb1119755d4e9b131681b895e56aa)
 * and renders purely from the state that action returns:
 *
 *   { ok: false, errors: { <field>: <message> }, message: "..." }   -> validation errors
 *   { ok: false, errors: { website: "..." } }                       -> honeypot trip (hidden by UI)
 *   { ok: true }                                                    -> success screen
 *
 * This file speaks the same wire protocol (multipart form-action request in,
 * React flight "text/x-component" response out) so the mirrored client bundle
 * works completely unchanged.
 *
 * Delivery: if RESEND_API_KEY + ENQUIRY_TO_EMAIL are set the enquiry is emailed;
 * otherwise it is written to the function log.
 */

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === 'string') return resolve(Buffer.from(req.body, 'utf8'));
    const chunks = [];
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    };
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', done);
    req.on('error', reject);
    if (req.readableEnded) done();
  });
}

function parseMultipart(buf, boundary) {
  const fields = {};
  const delim = Buffer.from('--' + boundary, 'latin1');
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let part = buf.slice(start, next);
    pos = next;
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.slice(2);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headers = part.slice(0, sep).toString('latin1');
    const value = part.slice(sep + 4).toString('utf8');
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (!nameMatch) continue;
    // encodeReply() names FormData entries "_<refIndex>_<field>" (e.g. "_1_name").
    const name = nameMatch[1].replace(/^_\d+_/, '');
    if (name === '0' || name === '1') continue; // reply model, not a form field
    fields[name] = value;
  }
  return fields;
}

function parseUrlEncoded(text) {
  const fields = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const v = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    fields[k.replace(/^_\d+_/, '')] = v;
  }
  return fields;
}

function validate(f) {
  const name = (f.name || '').trim();
  const phone = (f.phone || '').trim();
  const email = (f.email || '').trim();
  const area = (f.area || '').trim();
  const message = (f.message || '').trim();
  const puppyId = (f.puppyId || '').trim();
  const website = (f.website || '').trim();

  const errors = {};
  // The two messages below are byte-identical to the live site's.
  if (name.length < 2 || name.length > 80) errors.name = 'Please tell us your name.';
  if (phone.replace(/\D/g, '').length < 6) {
    errors.phone = 'Add a phone or WhatsApp number we can reach, with country code.';
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.email = "That email address doesn't look right.";
  }
  if (area.length > 80) errors.area = 'Please shorten your area to 80 characters or less.';
  if (message.length > 2000) errors.message = 'Please keep your message under 2000 characters.';

  return { errors, clean: { name, phone, email, area, message, puppyId, website } };
}

function flightResponse(state, buildId) {
  const root = JSON.stringify({ a: '$@1', q: '', i: false, b: buildId });
  return '0:' + root + '\n1:' + JSON.stringify(state) + '\n';
}

function puppyLabel(id) {
  return id || 'Any puppy / not sure yet';
}

function renderText(e, page) {
  return [
    'New enquiry from the website',
    '',
    'Name:     ' + e.name,
    'Phone:    ' + e.phone,
    'Email:    ' + (e.email || '-'),
    'Area:     ' + (e.area || '-'),
    'Puppy:    ' + puppyLabel(e.puppyId),
    'Page:     ' + page,
    '',
    'Message:',
    e.message || '(none)',
  ].join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderHtml(e, page) {
  const row = (label, value) =>
    '<tr><td style="padding:6px 12px 6px 0;color:#6b5546;white-space:nowrap">' + label +
    '</td><td style="padding:6px 0"><strong>' + escapeHtml(value) + '</strong></td></tr>';
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#2a170e">' +
    '<h2 style="margin:0 0 4px">New website enquiry</h2>' +
    '<table style="border-collapse:collapse;font-size:15px">' +
    row('Name', e.name) +
    row('Phone', e.phone) +
    row('Email', e.email || '-') +
    row('Area', e.area || '-') +
    row('Puppy', puppyLabel(e.puppyId)) +
    row('Page', page) +
    '</table>' +
    '<p style="margin:18px 0 6px;color:#6b5546">Message</p>' +
    '<pre style="margin:0;white-space:pre-wrap;font:inherit">' + escapeHtml(e.message || '(none)') + '</pre>' +
    '</div>';
}

async function deliver(enquiry, page) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ENQUIRY_TO_EMAIL;
  if (!key || !to) {
    console.log('[enquiry] RESEND_API_KEY/ENQUIRY_TO_EMAIL not set, enquiry not emailed:',
      JSON.stringify(enquiry));
    return;
  }
  const from = process.env.ENQUIRY_FROM_EMAIL || 'TeddyPups Website <onboarding@resend.dev>';
  const body = {
    from,
    to: [to],
    subject: 'New enquiry - ' + enquiry.name + (enquiry.area ? ' (' + enquiry.area + ')' : ''),
    html: renderHtml(enquiry, page),
    text: renderText(enquiry, page),
  };
  if (enquiry.email) body.reply_to = enquiry.email;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()));
  console.log('[enquiry] emailed to', to);
}

function send(res, state, buildId) {
  const payload = flightResponse(state, buildId);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/x-component; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(payload);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('Method Not Allowed');
  }

  const buildId = process.env.NEXT_BUILD_ID || 'teddypups-static';

  let fields;
  try {
    const raw = await readRawBody(req);
    const ct = String(req.headers['content-type'] || '');
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    fields = m ? parseMultipart(raw, (m[1] || m[2]).trim()) : parseUrlEncoded(raw.toString('utf8'));
  } catch (err) {
    console.error('[enquiry] could not read request body', err);
    return send(res, { ok: false, errors: {}, message: 'Something went wrong. Please try again.' }, buildId);
  }

  // Honeypot: only bots fill this. The UI filters "website" out of its error
  // list, so the submission is silently discarded.
  if ((fields.website || '').trim()) {
    console.log('[enquiry] honeypot tripped from', req.headers['x-forwarded-for'] || 'unknown ip');
    return send(res, { ok: false, errors: { website: 'Please leave this field empty.' } }, buildId);
  }

  const { errors, clean } = validate(fields);
  if (Object.keys(errors).length) {
    return send(res, {
      ok: false,
      errors,
      message: 'Please check the highlighted fields.',
    }, buildId);
  }

  const referer = String(req.headers.referer || req.headers.referrer || '');
  const page = referer ? referer.replace(/^https?:\/\/[^/]+/, '') || '/' : '/';

  try {
    await deliver(clean, page);
  } catch (err) {
    console.error('[enquiry] delivery failed', err);
    return send(res, {
      ok: false,
      errors: {},
      message: 'We could not send your enquiry just now. Please try again, or message us on WhatsApp.',
    }, buildId);
  }

  console.log('[enquiry] accepted', JSON.stringify({ ...clean, page }));
  return send(res, { ok: true }, buildId);
};

module.exports.config = { api: { bodyParser: false } };
