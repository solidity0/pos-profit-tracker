import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp, Timestamp, writeBatch, setLogLevel } from 'firebase/firestore';
import emu from './emulator.cjs';
const T = () => ({ termsAcceptedAt: serverTimestamp(), termsVersion: '2026-10-27' });
setLogLevel('silent');
const cfg = { apiKey:'x', projectId:'ledger-3c7f0', authDomain:'x' };
const accounts = { A:'0xxeZTLlaAeTzTgpezc58hwDxXp2', SA:'LDtRV9smFfdcudaBjiWixXyyg9A2', B:'ownerBuid0000000000000000002', SB:'staffBuid0000000000000000003', X:'strangerUid000000000000000001' };
// B owns a business, so its email is confirmed; U signed up but never confirmed theirs.
accounts.U = 'unverifiedUid0000000000000004';
await emu.reset(Object.entries(accounts).map(([k, uid]) => ({ uid, email: k.toLowerCase()+'@mt.test', verified: k === 'B' })));
async function as(k){ const app = initializeApp(cfg, k); const auth=getAuth(app); connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true}); const db=getFirestore(app); connectFirestoreEmulator(db,'127.0.0.1',8080); await signInWithEmailAndPassword(auth,k.toLowerCase()+'@mt.test','secret123'); return db; }
const db = { A: await as('A'), SA: await as('SA'), B: await as('B'), SB: await as('SB'), X: await as('X'), U: await as('U') };
const { A, SA, B, SB, X, U } = accounts;
let pass=0, fail=0;
async function expect(label, allow, fn){ let ok; try{ await fn(); ok=true; }catch(e){ ok=false; if(e.code!=='permission-denied') console.log('   (',e.code,e.message,')'); } const good=ok===allow; good?pass++:fail++; console.log(`${good?'PASS':'FAIL'}  ${allow?'allow':'deny '}  ${label}`); }
const tx = (by, extra={}) => ({ amount:1000, date:new Date().toISOString(), loggedBy:by, deleted:false, createdAt:serverTimestamp(), ...extra });
const biz = (o, ...p) => doc(db[o], 'businesses', ...p);

// legacy single-business data (seeded with admin access)
await fetch('http://127.0.0.1:8080/v1/projects/ledger-3c7f0/databases/(default)/documents/staff/'+SA,{method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify({fields:{name:{stringValue:'Chizoba'}}})});
await fetch('http://127.0.0.1:8080/v1/projects/ledger-3c7f0/databases/(default)/documents/transactions/legacy1',{method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify({fields:{loggedBy:{stringValue:SA},deleted:{booleanValue:false},amount:{integerValue:'5'}}})});

console.log('--- creating businesses');
await expect('B creates a business without accepting the terms', false, ()=>setDoc(biz('B', B), { name:'B Stores', ownerUid:B }));
await expect('B creates a business pre-marked not suspended', false, ()=>setDoc(biz('B', B), { name:'B Stores', ownerUid:B, suspended:false, ...T() }));
await expect('B creates a business with a fake acceptance time', false, ()=>setDoc(biz('B', B), { name:'B Stores', ownerUid:B, termsAcceptedAt: Timestamp.fromDate(new Date(0)), termsVersion:'x' }));
await expect('U creates a business without confirming their email', false, ()=>setDoc(biz('U', U), { name:'U Stores', ownerUid:U, ...T() }));
await expect('B creates its own business (terms accepted)', true, ()=>setDoc(biz('B', B), { name:'B Stores', ownerUid:B, ...T() }));
await expect('X creates a business under B\'s id', false, ()=>setDoc(biz('X', B), { name:'hijack', ownerUid:X, ...T() }));
await expect('X creates own business naming someone else owner', false, ()=>setDoc(biz('X', X), { name:'x', ownerUid:B, ...T() }));
await expect('X takes over B\'s business doc', false, ()=>updateDoc(biz('X', B), { name:'hijack' }));
await expect('B renames own business', true, ()=>updateDoc(biz('B', B), { name:'B Stores Ltd' }));
await expect('B changes owner of own business', false, ()=>updateDoc(biz('B', B), { ownerUid:X }));

console.log('--- migration of the original ledger (A)');
await expect('A reads the old top-level ledger', true, ()=>getDocs(collection(db.A,'transactions')));
await expect('B reads the old top-level ledger', false, ()=>getDocs(collection(db.B,'transactions')));
await expect('A copies an old entry logged by its salesperson', true, ()=>setDoc(biz('A', A,'transactions','legacy1'), { loggedBy:SA, deleted:false, amount:5, createdAt: Timestamp.fromDate(new Date(Date.now()-86400e3)) }));
await expect('A (the admin, email not confirmed) creates business + links its salesperson in one batch', true, ()=>{ const b=writeBatch(db.A); b.set(doc(db.A,'businesses',A,'staff',SA),{name:'Chizoba'}); b.set(doc(db.A,'users',SA),{businessId:A, role:'staff'}); b.set(biz('A',A),{name:'Triumph',ownerUid:A, ...T()}); return b.commit(); });

console.log('--- B adds a salesperson');
await expect('B links SB to B (with staff entry)', true, ()=>{ const b=writeBatch(db.B); b.set(doc(db.B,'businesses',B,'staff',SB),{name:'Sam',active:true}); b.set(doc(db.B,'users',SB),{businessId:B, role:'staff'}); return b.commit(); });
await expect("B claims A's salesperson login", false, ()=>setDoc(doc(db.B,'users',SA),{businessId:B, role:'staff'}));
await expect('X (no business) links a login to itself', false, ()=>setDoc(doc(db.X,'users','someoneUid'),{businessId:X, role:'staff'}));
await expect('B links a login to another business', false, ()=>setDoc(doc(db.B,'users','someoneUid'),{businessId:A, role:'staff'}));
await expect('B links a login as owner role', false, ()=>setDoc(doc(db.B,'users','someoneUid2'),{businessId:B, role:'owner'}));
await expect('SB points itself at business A', false, ()=>setDoc(doc(db.SB,'users',SB),{businessId:A, role:'staff'}));
await expect('SB reads its own users entry', true, ()=>getDoc(doc(db.SB,'users',SB)));
await expect("A reads SB's users entry", false, ()=>getDoc(doc(db.A,'users',SB)));

console.log('--- separation between businesses');
await expect('SB logs in B', true, ()=>setDoc(biz('SB', B,'transactions','sb1'), tx(SB)));
await expect('SA logs in A', true, ()=>setDoc(biz('SA', A,'transactions','sa1'), tx(SA)));
await expect('A reads B transactions', false, ()=>getDocs(collection(db.A,'businesses',B,'transactions')));
await expect('B reads A transactions', false, ()=>getDocs(collection(db.B,'businesses',A,'transactions')));
await expect('SB reads A transactions', false, ()=>getDocs(collection(db.SB,'businesses',A,'transactions')));
await expect('SB writes into A', false, ()=>setDoc(biz('SB', A,'transactions','x1'), tx(SB)));
await expect('SA reads B settings', false, ()=>getDoc(biz('SA', B,'settings','shop')));
await expect('SA adds itself to B staff', false, ()=>setDoc(biz('SA', B,'staff',SA), {name:'me'}));
await expect('X reads B business', false, ()=>getDoc(biz('X', B)));
await expect('B reads own transactions', true, ()=>getDocs(collection(db.B,'businesses',B,'transactions')));
await setDoc(biz('B', B,'transactions','b1'), tx(B));
await expect("SB lists its own entries", true, ()=>getDocs(query(collection(db.SB,'businesses',B,'transactions'), where('loggedBy','==',SB))));
await expect("SB lists all of B's entries (for the log)", true, ()=>getDocs(collection(db.SB,'businesses',B,'transactions')));
await expect("SB reads the owner's entry (for the log)", true, ()=>getDoc(biz('SB', B,'transactions','b1')));
await expect("SB lists the owner's entries (for the log)", true, ()=>getDocs(query(collection(db.SB,'businesses',B,'transactions'), where('loggedBy','==',B))));
await expect("SB reads its own entry", true, ()=>getDoc(biz('SB', B,'transactions','sb1')));

console.log('--- salesperson limits inside B');
await expect('SB logs as owner B', false, ()=>setDoc(biz('SB', B,'transactions','sb2'), tx(B)));
await expect('SB backdates createdAt', false, ()=>setDoc(biz('SB', B,'transactions','sb3'), tx(SB,{createdAt: Timestamp.fromDate(new Date(0))})));
await expect('SB edits an amount', false, ()=>updateDoc(biz('SB', B,'transactions','sb1'), {amount:1}));
await expect('SB hard-deletes', false, ()=>deleteDoc(biz('SB', B,'transactions','sb1')));
await expect('SB soft-deletes own entry', true, ()=>updateDoc(biz('SB', B,'transactions','sb1'), {deleted:true, deletedBy:SB, deletedAt:serverTimestamp()}));
await expect('SB writes B settings', false, ()=>setDoc(biz('SB', B,'settings','shop'), {json:'{}'}));
await expect('SB re-activates itself', false, ()=>updateDoc(biz('SB', B,'staff',SB), {active:true}));
await expect('B removes SB', true, ()=>updateDoc(biz('B', B,'staff',SB), {active:false}));
await expect('removed SB reads B', false, ()=>getDocs(collection(db.SB,'businesses',B,'transactions')));
await expect('removed SB logs in B', false, ()=>setDoc(biz('SB', B,'transactions','sb9'), tx(SB)));
await expect("A deletes B's salesperson link", false, ()=>deleteDoc(doc(db.A,'users',SB)));
await expect('B deletes SB users link (permanent removal)', true, ()=>deleteDoc(doc(db.B,'users',SB)));
console.log('--- platform admin (A) and suspension');
await expect('admin lists all businesses', true, ()=>getDocs(collection(db.A,'businesses')));
await expect('a non-admin owner lists all businesses', false, ()=>getDocs(collection(db.B,'businesses')));
await expect("admin reads B's team (who runs it)", true, ()=>getDocs(collection(db.A,'businesses',B,'staff')));
await expect("admin reads B's transactions", false, ()=>getDocs(collection(db.A,'businesses',B,'transactions')));
await expect("admin renames B", false, ()=>updateDoc(biz('A', B), { name:'renamed' }));
await expect('B suspends someone else', false, ()=>updateDoc(biz('B', A), { suspended:true }));
await expect('admin suspends B', true, ()=>updateDoc(biz('A', B), { suspended:true, suspendedAt: serverTimestamp() }));
await expect('suspended B still reads its business doc (to show the message)', true, ()=>getDoc(biz('B', B)));
await expect('suspended B reads its transactions', false, ()=>getDocs(collection(db.B,'businesses',B,'transactions')));
await expect('suspended B logs a transaction', false, ()=>setDoc(biz('B', B,'transactions','b9'), tx(B)));
await expect('suspended B changes settings', false, ()=>setDoc(biz('B', B,'settings','shop'), {json:'{}'}));
await expect('suspended B adds a salesperson', false, ()=>setDoc(biz('B', B,'staff','newUid'), {name:'n'}));
await expect('suspended B lifts its own suspension', false, ()=>updateDoc(biz('B', B), { suspended:false }));
await expect('suspended B renames itself', false, ()=>updateDoc(biz('B', B), { name:'sneaky' }));
await expect('admin restores B', true, ()=>updateDoc(biz('A', B), { suspended:false, suspendedAt:null }));
await expect('restored B reads its transactions again', true, ()=>getDocs(collection(db.B,'businesses',B,'transactions')));
console.log('--- usernames');
{
  const { initializeApp: ia } = await import('firebase/app');
  const anonApp = ia(cfg, 'anon'); const anon = getFirestore(anonApp); connectFirestoreEmulator(anon,'127.0.0.1',8080);
  await expect('B claims username "sam" for SB', true, ()=>setDoc(doc(db.B,'usernames','sam'), { email:'sb@mt.test', businessId:B }));
  await expect('anyone signed out can look up "sam"', true, ()=>getDoc(doc(anon,'usernames','sam')));
  await expect('nobody can list all usernames', false, ()=>getDocs(collection(anon,'usernames')));
  await expect('A takes over "sam"', false, ()=>setDoc(doc(db.A,'usernames','sam'), { email:'x@mt.test', businessId:A }));
  await expect('A deletes "sam"', false, ()=>deleteDoc(doc(db.A,'usernames','sam')));
  await expect('X (no business) claims a username', false, ()=>setDoc(doc(db.X,'usernames','xname'), { email:'x@mt.test', businessId:X }));
  await expect('B claims a username for another business', false, ()=>setDoc(doc(db.B,'usernames','other'), { email:'o@mt.test', businessId:A }));
  await expect('B claims a badly formed username', false, ()=>setDoc(doc(db.B,'usernames','Bad Name!'), { email:'o@mt.test', businessId:B }));
  await expect('B adds extra fields to a username', false, ()=>setDoc(doc(db.B,'usernames','sam2'), { email:'o@mt.test', businessId:B, uid:'x' }));
  await expect('SB (a salesperson) claims a username', false, ()=>setDoc(doc(db.SB,'usernames','sbname'), { email:'sb@mt.test', businessId:SB }));
  await expect('B releases "sam"', true, ()=>deleteDoc(doc(db.B,'usernames','sam')));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
