// Runs the real email service (../email-service/worker.js) in Node for the tests. Firebase is
// the local emulator; Google's token endpoint and Brevo are stand-ins that record what they got.
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../email-service/worker.js';

export const APP_ORIGIN = 'http://127.0.0.1:8000';

function limiter(limit){
  const seen = {};
  return { limit: async ({ key }) => { seen[key] = (seen[key] || 0) + 1; return { success: seen[key] <= limit }; } };
}

export async function startEmailService({ port = 0, ipLimit = null, addressLimit = null } = {}){
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const state = { sent: [], tokenRequests: [], brevoStatus: 201, publicKey };
  let base = '';
  const env = {
    APP_URL: `${APP_ORIGIN}/index.html?emulator=1`, APP_ORIGIN, PROJECT_ID: 'ledger-3c7f0', WEB_API_KEY: 'test',
    SENDER_NAME: 'Ledger', SENDER_EMAIL: 'sender@test.com', BREVO_API_KEY: 'brevo-test-key',
    IDENTITY_BASE: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com'
  };
  if(ipLimit) env.IP_LIMIT = limiter(ipLimit);
  if(addressLimit) env.ADDRESS_LIMIT = limiter(addressLimit);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if(req.url === '/_token'){
      state.tokenRequests.push(new URLSearchParams(body.toString()));
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ access_token:'owner', expires_in:3600 })); // the emulator's admin token
    }
    if(req.url === '/_brevo'){
      if(state.brevoStatus < 300) state.sent.push({ headers: req.headers, ...JSON.parse(body.toString()) });
      res.writeHead(state.brevoStatus, { 'Content-Type':'application/json' });
      return res.end('{}');
    }
    const request = new Request(`${base}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
    });
    const reply = await worker.fetch(request, env);
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(await reply.text());
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  env.BREVO_URL = `${base}/_brevo`;
  env.SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'ledger-test@test.iam.gserviceaccount.com', token_uri: `${base}/_token`,
    private_key: privateKey.export({ type:'pkcs8', format:'pem' })
  });
  return { url: base, state, env, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
