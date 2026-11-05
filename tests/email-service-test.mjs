// Tests for the email service, against the local Auth emulator. Run via ./run.sh.
import { createVerify } from 'node:crypto';
import { startEmailService, APP_ORIGIN } from './email-service-harness.mjs';

let failures = 0;
const check = (label, ok, extra='') => { if(!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${label}${extra?'  ['+extra+']':''}`); };

const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const auth = (path, body) => fetch(`${AUTH}/${path}?key=test`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) }).then(r=>r.json());
const codeIn = (html) => new URL(html.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('oobCode');

const svc = await startEmailService();
const post = (path, body, headers={}) => fetch(svc.url + path, {
  method:'POST', headers:{ 'Content-Type':'application/json', Origin: APP_ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body)
});

// ---------- password reset ----------
await auth('accounts:signUp', { email:'reset-me@test.com', password:'oldpass1', returnSecureToken:true });
let res = await post('/reset', { email:' Reset-Me@test.com ' });
check('a reset request succeeds', res.status === 200, String(res.status));
check('it comes from the app\'s address only', res.headers.get('access-control-allow-origin') === APP_ORIGIN);
let mail = svc.state.sent.at(-1);
check('one email goes to that address', svc.state.sent.length === 1 && mail.to[0].email === 'reset-me@test.com', JSON.stringify(mail && mail.to));
check('it is sent as Ledger', mail.sender.name === 'Ledger' && mail.sender.email === 'sender@test.com' && mail.replyTo.email === 'sender@test.com');
check('the subject says Ledger', mail.subject === 'Reset your Ledger password', mail.subject);
check('the Brevo key is sent to Brevo', mail.headers['api-key'] === 'brevo-test-key');
for(const [name, part] of [['message', mail.htmlContent], ['plain-text copy', mail.textContent]]){
  check(`the ${name} never names the provider`, !/firebase|ledger-3c7f0|identitytoolkit|apiKey/i.test(part));
}
const link = new URL(mail.htmlContent.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&'));
check('the link opens Ledger\'s own page', link.origin === APP_ORIGIN && link.pathname === '/index.html' && link.searchParams.get('mode') === 'resetPassword', link.href);
check('the plain-text copy has the same link', mail.textContent.includes(link.href));
const done = await auth('accounts:resetPassword', { oobCode: link.searchParams.get('oobCode'), newPassword:'newpass1' });
check('the code in the email really changes the password', done.email === 'reset-me@test.com', JSON.stringify(done));
check('the new password works', !!(await auth('accounts:signInWithPassword', { email:'reset-me@test.com', password:'newpass1', returnSecureToken:true })).idToken);

// ---------- nobody can use it to look up accounts ----------
const before = svc.state.sent.length;
res = await post('/reset', { email:'nobody-here@test.com' });
check('an unknown email gets the same answer', res.status === 200 && (await res.json()).ok === true);
check('...and no email is sent', svc.state.sent.length === before);

// ---------- the Google token ----------
const assertion = svc.state.tokenRequests[0].get('assertion').split('.');
const verifier = createVerify('RSA-SHA256').update(`${assertion[0]}.${assertion[1]}`);
check('the Google token request is signed with the service account key', verifier.verify(svc.state.publicKey, Buffer.from(assertion[2], 'base64url')));
const claims = JSON.parse(Buffer.from(assertion[1], 'base64url'));
check('...for the right account and scope', claims.iss === 'ledger-test@test.iam.gserviceaccount.com' && claims.scope.endsWith('/identitytoolkit') && claims.exp - claims.iat === 3600);
check('the token is reused, not fetched for every email', svc.state.tokenRequests.length === 1, String(svc.state.tokenRequests.length));

// ---------- confirm your email ----------
const user = await auth('accounts:signUp', { email:'new-owner@test.com', password:'secret123', returnSecureToken:true });
res = await post('/verify', { idToken: user.idToken });
mail = svc.state.sent.at(-1);
check('a signed-in person can get their confirmation email', res.status === 200 && mail.to[0].email === 'new-owner@test.com');
check('it says Ledger and never names the provider', mail.subject === 'Confirm your email for Ledger' && !/firebase|ledger-3c7f0/i.test(mail.htmlContent + mail.textContent), mail.subject);
const verified = await auth('accounts:update', { oobCode: codeIn(mail.htmlContent) });
check('the code in the email really confirms it', verified.emailVerified === true, JSON.stringify(verified));
const again = svc.state.sent.length;
const fresh = await auth('accounts:signInWithPassword', { email:'new-owner@test.com', password:'secret123', returnSecureToken:true });
res = await post('/verify', { idToken: fresh.idToken });
check('an already confirmed person gets no second email', res.status === 200 && svc.state.sent.length === again);
res = await post('/verify', { idToken:'not-a-token' });
check('a made-up token is refused', res.status === 401, String(res.status));
check('...and sends nothing', svc.state.sent.length === again);

// ---------- bad requests ----------
const count = svc.state.sent.length;
res = await post('/reset', { email:'reset-me@test.com' }, { Origin:'https://evil.example' });
check('another website is refused', res.status === 403, String(res.status));
res = await fetch(svc.url + '/reset', { method:'OPTIONS', headers:{ Origin:'https://evil.example', 'Access-Control-Request-Method':'POST' } });
check('...and its browser check fails too', res.status === 403, String(res.status));
res = await fetch(svc.url + '/reset', { method:'OPTIONS', headers:{ Origin: APP_ORIGIN, 'Access-Control-Request-Method':'POST' } });
check('the app\'s browser check passes', res.status === 204 && res.headers.get('access-control-allow-methods').includes('POST'), String(res.status));
res = await fetch(svc.url + '/reset', { headers:{ Origin: APP_ORIGIN } });
check('GET is refused', res.status === 405, String(res.status));
res = await post('/send', { email:'reset-me@test.com' });
check('unknown paths are refused', res.status === 404, String(res.status));
res = await post('/reset', 'not json');
check('broken JSON is refused', res.status === 400, String(res.status));
res = await post('/reset', 'null');
check('an empty body is refused', res.status === 400, String(res.status));
for(const email of ['nope', 'a b@test.com', '', 42]){
  res = await post('/reset', { email });
  check(`a bad email is refused (${email})`, res.status === 400, String(res.status));
}
res = await post('/reset', { email: 'a'.repeat(300) + '@test.com' });
check('an overlong email is refused', res.status === 400, String(res.status));
res = await post('/verify', { idToken:'x'.repeat(9000) });
check('an oversized request is refused', res.status === 413, String(res.status));
check('none of those sent anything', svc.state.sent.length === count);

// ---------- when Brevo fails, the app is told so it can use its backup ----------
svc.state.brevoStatus = 401;
res = await post('/reset', { email:'reset-me@test.com' });
const failBody = await res.text();
check('a Brevo failure is reported', res.status === 502, String(res.status));
check('...without any detail leaking out', failBody === '{"error":"send_failed"}', failBody);
svc.state.brevoStatus = 201;
await svc.close();

// ---------- limits ----------
const limited = await startEmailService({ addressLimit: 1, ipLimit: 3 });
const postLimited = (body) => fetch(limited.url + '/reset', { method:'POST', headers:{ 'Content-Type':'application/json', Origin: APP_ORIGIN, 'CF-Connecting-IP':'203.0.113.9' }, body: JSON.stringify(body) });
res = await postLimited({ email:'reset-me@test.com' });
check('the first email to an address goes out', res.status === 200 && limited.state.sent.length === 1);
res = await postLimited({ email:'RESET-ME@test.com' });
check('a second one straight after looks the same but sends nothing', res.status === 200 && limited.state.sent.length === 1, String(limited.state.sent.length));
res = await postLimited({ email:'nobody-here@test.com' });
check('a third request is still allowed', res.status === 200);
res = await postLimited({ email:'nobody-here@test.com' });
check('too many requests from one connection are slowed down', res.status === 429, String(res.status));
await limited.close();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
