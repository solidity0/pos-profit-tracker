// Helpers for talking to the local Firebase emulators (started by run.sh).
const PROJECT = 'ledger-3c7f0';
const AUTH = 'http://127.0.0.1:9099';
const DB = 'http://127.0.0.1:8080';
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

// Wipe every document and login, then create the given logins: [{ uid, email, verified? }].
async function reset(accounts = []){
  await fetch(`${DB}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  for(const a of accounts){
    await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { method: 'POST', headers: ADMIN,
      body: JSON.stringify({ localId: a.uid, email: a.email, password: a.password || 'secret123', emailVerified: !!a.verified }) });
  }
}

// Write a document with admin rights (bypassing the rules), in Firestore REST format.
function adminWrite(path, fields){
  return fetch(`${DB}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ fields }) });
}

// Open the "confirm your email" link the emulator would have emailed to this address.
async function verifyEmail(email){
  const { oobCodes = [] } = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = oobCodes.filter(c => c.email === email && c.requestType === 'VERIFY_EMAIL').pop();
  if(!code) return false;
  return (await fetch(code.oobLink)).ok;
}

// The accounts the browser tests use.
const TEST_ACCOUNTS = [
  { uid: '0xxeZTLlaAeTzTgpezc58hwDxXp2', email: 'owner@test.com' },   // the original owner and platform admin
  { uid: 'LDtRV9smFfdcudaBjiWixXyyg9A2', email: 'staff@test.com' },   // their salesperson
  { uid: 'strangerUid000000000000000001', email: 'stranger@test.com' } // a login with no business
];

module.exports = { PROJECT, AUTH, DB, ADMIN, reset, adminWrite, verifyEmail, TEST_ACCOUNTS };
