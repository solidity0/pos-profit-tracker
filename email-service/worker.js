// Copyright (c) 2026 Triumph Enterprise. All rights reserved. See LICENSE.
// Ledger's email service (a Cloudflare Worker): sends the password reset and "confirm your
// email" emails through Brevo, in Ledger's own words, with links that open Ledger's own page.
// Firebase still creates the one-time codes; it just no longer writes or sends the emails.
// Deploy steps are in README.md. The two keys are Cloudflare secrets, never in this file.
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_BODY = 8192;

function b64url(bytes){
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

// A short-lived Google token, signed with the service account's private key.
let cachedToken = null;
async function googleToken(env){
  if(cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlText(JSON.stringify({ alg:'RS256', typ:'JWT' })) + '.' + b64urlText(JSON.stringify({
    iss: sa.client_email, scope: GOOGLE_SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600
  }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(signature) })
  });
  if(!res.ok) throw new Error('google token ' + res.status);
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

const identityBase = (env) => env.IDENTITY_BASE || 'https://identitytoolkit.googleapis.com';

// Returns the one-time code, or null when no login has that email.
async function createCode(env, requestType, email){
  const res = await fetch(`${identityBase(env)}/v1/projects/${env.PROJECT_ID}/accounts:sendOobCode`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + await googleToken(env) },
    body: JSON.stringify({ requestType, email, returnOobLink: true })
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    const reason = (data.error && data.error.message) || '';
    if(reason.startsWith('EMAIL_NOT_FOUND') || reason.startsWith('USER_DISABLED')) return null;
    throw new Error('create code ' + res.status + ' ' + reason.split(' ')[0]);
  }
  const code = new URL(data.oobLink).searchParams.get('oobCode');
  if(!code) throw new Error('create code: no code');
  return code;
}

// Returns the signed-in person behind an ID token, or null if the token isn't valid.
async function lookupUser(env, idToken){
  const res = await fetch(`${identityBase(env)}/v1/accounts:lookup?key=${encodeURIComponent(env.WEB_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ idToken })
  });
  if(!res.ok) return null;
  const data = await res.json().catch(()=>({}));
  return (data.users && data.users[0]) || null;
}

function ledgerLink(env, mode, code){
  const url = new URL(env.APP_URL);
  url.searchParams.set('mode', mode);
  url.searchParams.set('oobCode', code);
  return url.toString();
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function emailHtml(heading, intro, link, buttonText, outro){
  return `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
<h2 style="margin:0 0 16px;">${esc(heading)}</h2>
<p style="margin:0 0 16px;line-height:1.5;">${esc(intro)}</p>
<p style="margin:0 0 16px;"><a href="${esc(link)}">${esc(buttonText)}</a></p>
<p style="margin:0;line-height:1.5;">${esc(outro)}</p>
</body></html>`;
}

async function sendEmail(env, to, subject, html, text, tag){
  const res = await fetch(env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Accept:'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: env.SENDER_NAME, email: env.SENDER_EMAIL },
      replyTo: { name: env.SENDER_NAME, email: env.SENDER_EMAIL },
      to: [{ email: to }],
      subject, htmlContent: html, textContent: text, tags: [tag]
    })
  });
  if(!res.ok) throw new Error('brevo ' + res.status);
}

async function sendReset(env, email){
  const code = await createCode(env, 'PASSWORD_RESET', email);
  if(!code) return;
  const link = ledgerLink(env, 'resetPassword', code);
  const intro = `We received a request to reset the password for your Ledger account (${email}). Follow the link below to choose a new one.`;
  const outro = "If you didn't request this, you can safely ignore this email.";
  await sendEmail(env, email, 'Reset your Ledger password',
    emailHtml('Reset your password', intro, link, 'Reset password', outro),
    `Reset your password\n\n${intro}\n\n${link}\n\n${outro}`, 'password-reset');
}

async function sendVerify(env, email){
  const code = await createCode(env, 'VERIFY_EMAIL', email);
  if(!code) return;
  const link = ledgerLink(env, 'verifyEmail', code);
  const intro = 'Follow the link below to confirm this email address and finish setting up Ledger.';
  const outro = "If you didn't create a Ledger account, you can safely ignore this email.";
  await sendEmail(env, email, 'Confirm your email for Ledger',
    emailHtml('Confirm your email address', intro, link, 'Confirm email address', outro),
    `Confirm your email address\n\n${intro}\n\n${link}\n\n${outro}`, 'verify-email');
}

// Limits are off only where the binding doesn't exist (they're set in wrangler.toml).
async function allowed(limiter, key){
  if(!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export default {
  async fetch(request, env){
    const cors = {
      'Access-Control-Allow-Origin': env.APP_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type':'application/json' } });

    if(request.headers.get('Origin') !== env.APP_ORIGIN) return reply(403, { error:'forbidden' });
    if(request.method === 'OPTIONS') return new Response(null, { status:204, headers:cors });
    if(request.method !== 'POST') return reply(405, { error:'method' });
    const path = new URL(request.url).pathname;
    if(path !== '/reset' && path !== '/verify') return reply(404, { error:'not_found' });

    const raw = await request.text();
    if(raw.length > MAX_BODY) return reply(413, { error:'too_large' });
    let body;
    try{ body = JSON.parse(raw); }catch(e){ return reply(400, { error:'bad_json' }); }
    if(!body || typeof body !== 'object') return reply(400, { error:'bad_json' });

    if(!await allowed(env.IP_LIMIT, request.headers.get('CF-Connecting-IP') || 'unknown')) return reply(429, { error:'slow_down' });

    try{
      if(path === '/reset'){
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if(email.length > 254 || !EMAIL_RE.test(email)) return reply(400, { error:'bad_email' });
        // The same answer whether or not the email has a login, or was just sent one,
        // so nobody can use this to find out who has an account.
        if(await allowed(env.ADDRESS_LIMIT, email)) await sendReset(env, email);
        return reply(200, { ok:true });
      }
      if(typeof body.idToken !== 'string' || !body.idToken) return reply(400, { error:'bad_token' });
      const user = await lookupUser(env, body.idToken);
      if(!user || !user.email) return reply(401, { error:'bad_token' });
      if(!user.emailVerified && await allowed(env.ADDRESS_LIMIT, user.email.toLowerCase())) await sendVerify(env, user.email);
      return reply(200, { ok:true });
    }catch(err){
      // No addresses or codes in the logs. The app falls back to Firebase's email on this.
      console.error('send failed: ' + (err && err.message));
      return reply(502, { error:'send_failed' });
    }
  }
};
