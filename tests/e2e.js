// Browser tests for the whole app, against the local emulators. Run via ./run.sh (see README.md).
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const emu = require('./emulator.cjs');
const FB = path.join(__dirname, 'node_modules/firebase/');
const JSPDF = path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const PAGE = 'http://127.0.0.1:8000/index.html?emulator=1';
let failures = 0;
const check = (label, ok, extra='') => { if(!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${label}${extra?'  ['+extra+']':''}`); };
async function ctx(b, name){
  // Service workers are tested separately (pwa.js); here they'd get in the way of the routes below.
  const c = await b.newContext({ viewport:{width:390,height:844}, colorScheme:'light', serviceWorkers:'block', acceptDownloads:true });
  await c.route('https://www.gstatic.com/firebasejs/**', r => { const f = path.basename(new URL(r.request().url()).pathname); r.fulfill({ path: FB + f, contentType:'text/javascript' }); });
  await c.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf/**', r => r.fulfill({ path: JSPDF, contentType:'text/javascript' }));
  await c.route('https://fonts.googleapis.com/**', r => r.abort());
  // Performance Overview's Filter / Summary / Reports panels start open in these tests.
  await c.addInitScript(()=>{ try{ if(!localStorage.getItem('ledger_perfOpen')) localStorage.setItem('ledger_perfOpen', JSON.stringify({ perfFilters:true, perfTotals:true, perfReports:true })); }catch(e){} });
  await c.addInitScript(()=>{ window.__appShown = false; document.addEventListener('DOMContentLoaded', ()=>{ const el = document.getElementById('appWrap'); new MutationObserver(()=>{ if(el.style.display !== 'none') window.__appShown = true; }).observe(el, { attributes:true, attributeFilter:['style'] }); }); });
  const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(name+': '+e.message));
  p.on('console', m => { if(m.type()==='error' && !/net::ERR|Failed to load resource/.test(m.text())) p.errs.push(name+' console: '+m.text().slice(0,200)); });
  return { c, p };
}
async function signIn(p, email, pw, as){ await p.goto(PAGE); await p.waitForSelector('#authForm', { state:'visible' });
  await p.click(`#authRole button[data-val="${as || (email.startsWith('owner') ? 'owner' : 'staff')}"]`);
  await p.fill('#authEmail', email); await p.fill('#authPassword', pw); await p.click('#authSubmit'); }
async function logTx(p, type, amount, fee){
  await p.click(`#typeSeg button[data-val="${type}"]`); await p.fill('#amount', amount); await p.fill('#customerFee', fee); await p.click('#addBtn');
}
const logCount = p => p.$$eval('#logList .log-item:not(.deleted)', e => e.length);
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms=8000){ const t = Date.now(); while(Date.now()-t < ms){ try{ if(await fn()) return true; }catch(e){} await wait(200); } return false; }

(async()=>{
  await emu.reset(emu.TEST_ACCOUNTS);
  const b = await chromium.launch();
  // ---------- the original ledger, before businesses ----------
  const admin = emu.adminWrite;
  const tenDaysAgo = new Date(Date.now() - 10*86400e3).toISOString();
  await admin('staff/LDtRV9smFfdcudaBjiWixXyyg9A2', { name:{ stringValue:'Test Staff' } });
  await admin('transactions/oldtop-1', { id:{stringValue:'oldtop-1'}, loggedBy:{ stringValue:'LDtRV9smFfdcudaBjiWixXyyg9A2' }, loggedByName:{stringValue:'Test Staff'}, deleted:{ booleanValue:false }, date:{ stringValue: tenDaysAgo }, createdAt:{ timestampValue: tenDaysAgo }, provider:{stringValue:'Moniepoint'}, type:{stringValue:'Withdrawal'}, amount:{integerValue:'4000'}, customerFee:{integerValue:'100'}, baseFee:{integerValue:'20'}, providerFee:{integerValue:'60'}, netProfit:{integerValue:'40'} });

  // a salesperson signing in before the owner has moved the ledger
  const Early = await ctx(b, 'early'); const ep = Early.p;
  await signIn(ep, 'staff@test.com', 'secret123');
  check('salesperson before the move is told to wait for the owner', await until(async()=> /moving to the new version/.test(await ep.textContent('#authBlocked'))), await ep.textContent('#authBlocked'));
  await Early.c.close();

  // ---------- owner ----------
  const O = await ctx(b, 'owner'); const op = O.p;
  const now = Date.now();
  const legacy = [
    { id:'legacy-1', date:new Date(now-60*86400e3).toISOString(), provider:'Moniepoint', type:'Withdrawal', amount:50000, customerFee:500, baseFee:100, vatAmt:0, stampAmt:0, autosaveAmt:40, providerFee:140, netProfit:360 },
    { id:'legacy-2', date:new Date(now-3*86400e3).toISOString(), provider:'Opay', type:'Transfer', amount:20000, customerFee:300, baseFee:20, vatAmt:1.5, stampAmt:50, autosaveAmt:0, providerFee:71.5, netProfit:228.5 },
    { id:'legacy-3', date:new Date(now-1*86400e3).toISOString(), provider:'Moniepoint', type:'Withdrawal', amount:10000, customerFee:200, baseFee:50, vatAmt:0, stampAmt:0, autosaveAmt:40, providerFee:90, netProfit:110 }
  ];
  await op.addInitScript(l => { if(!localStorage.getItem('seeded')){ localStorage.setItem('ledger_transactions', JSON.stringify(l)); localStorage.setItem('seeded','1'); } }, legacy);
  await signIn(op, 'owner@test.com', 'wrong-pass');
  check('wrong password is rejected with a clear message', await until(async()=> (await op.textContent('#authStatus')) === 'Wrong email or password.'), await op.textContent('#authStatus'));
  await op.fill('#authPassword','secret123'); await op.click('#authSubmit');
  check('original owner is asked to name their business', await until(()=> op.isVisible('#setupForm')) && /moves into it/.test(await op.textContent('#setupIntro')));
  await op.fill('#setupBizName', 'Triumph Ventures'); await op.fill('#setupOwnerName', 'Uweribe'); await op.click('#setupSubmit');
  check('setup without ticking the terms box is refused', await until(async()=> /Tick the box to agree/.test(await op.textContent('#authStatus'))) && !(await op.isVisible('#appWrap')), await op.textContent('#authStatus'));
  await op.check('#setupTerms'); await op.click('#setupSubmit');
  check('owner signs in and sees the app', await until(()=> op.isVisible('#appWrap'), 20000));
  check('header shows the business', await until(async()=> /^Triumph Ventures · /.test(await op.textContent('#whoLabel'))), await op.textContent('#whoLabel'));
  check('owner sees Performance Overview + Settings', await op.isVisible('#perfCard') && await op.isVisible('#settingsCard'));
  // team names + import
  await fetch('http://127.0.0.1:8080/v1/projects/ledger-3c7f0/databases/(default)/documents/staff/LDtRV9smFfdcudaBjiWixXyyg9A2', { method:'PATCH', headers:{ Authorization:'Bearer owner', 'Content-Type':'application/json' }, body: JSON.stringify({ fields:{ name:{ stringValue:'Test Staff' } } }) });
  await op.click('#settingsToggle');
  check('settings open without a password', await op.isVisible('#settingsContent'));
  check('import offers the 3 old transactions', await until(async()=> (await op.textContent('#importBtn')) === 'Upload 3 transactions'), await op.textContent('#importBtn'));
  const names = await op.$$('#teamInputs input');
  await names[0].fill('Uweribe'); await names[0].dispatchEvent('change');
  await op.click('#importBtn');
  check('old transactions upload', await until(async()=> /Uploaded 3 transactions/.test(await op.textContent('#importStatus'))), await op.textContent('#importStatus'));
  check('once uploaded, the old-records box goes away', await until(async()=> !(await op.isVisible('#importSection'))));
  check('header shows owner name', await until(async()=> (await op.textContent('#whoLabel')) === 'Triumph Ventures · Uweribe · OWNER'), await op.textContent('#whoLabel'));
  await op.click('#settingsDoneBtn');

  // ---------- staff ----------
  const St = await ctx(b, 'staff'); const sp = St.p;
  await signIn(sp, 'staff@test.com', 'secret123', 'owner');
  check('salesperson login with "Business Owner" chosen is refused', await until(async()=> /STAFF login — choose "STAFF"/.test(await sp.textContent('#authStatus'))), await sp.textContent('#authStatus'));
  check('...and stays on the sign-in screen', await sp.isVisible('#authForm') && !(await sp.isVisible('#appWrap')));
  check('...and the app never appeared, not even briefly', (await sp.evaluate(()=> window.__appShown)) === false);
  await signIn(sp, 'staff@test.com', 'secret123');
  check('staff signs in', await until(()=> sp.isVisible('#appWrap')));
  check('staff header shows their name', await until(async()=> (await sp.textContent('#whoLabel')) === 'Triumph Ventures · Test Staff · STAFF'), await sp.textContent('#whoLabel'));
  check('staff sees the total deducted box', await sp.isVisible('#machineTotal'));
  check('staff sees Performance Overview (with money in/out under Filter), not Settings', await sp.isVisible('#perfCard') && !!(await sp.$('#perfFilters #volumeBody')) && !(await sp.isVisible('#settingsCard')));
  await logTx(sp, 'Withdrawal', '20000', '300');
  await logTx(sp, 'Transfer', '15000', '250');
  check('staff sees its 2 entries', await until(async()=> (await logCount(sp)) === 2), String(await logCount(sp)));
  check('staff see the cost of each entry in the log', await until(async()=> /cost -₦/.test(await sp.textContent('#logList'))), (await sp.textContent('#logList')).replace(/\s+/g,' ').slice(0,160));
  const staffRowText = await sp.textContent('#logList .log-item');
  check('staff log shows profit and cost', /cost -₦/.test(staffRowText) && /profit\s*₦/i.test(staffRowText), staffRowText.replace(/\s+/g,' ').slice(0,140));

  // ---------- owner sees them live ----------
  await op.click('#logToggle');
  check('owner sees staff entries live (+ 1 imported from yesterday? no: today only)', await until(async()=> (await logCount(op)) === 2), String(await logCount(op)));
  const ownerRow = (await op.textContent('#logList .log-item')).replace(/\s+/g,' ');
  check('owner row says who logged it and shows cost', /by: Test Staff/.test(ownerRow) && /cost/.test(ownerRow), ownerRow.slice(0,160));
  await op.click('#summaryToggle');
  check('owner totals today = 2 transactions', await until(async()=> (await op.textContent('#txCount')).startsWith('2 transactions')), await op.textContent('#txCount'));

  // ---------- staff deletes (two taps), owner still sees it ----------
  await sp.click('#logList .del');
  check('one tap on delete only asks to confirm', /tap again to delete/.test(await sp.textContent('#logList .del')) && (await logCount(sp)) === 2, await sp.textContent('#logList .del'));
  await wait(3300);
  check('...and goes back to "delete" if not confirmed', (await sp.textContent('#logList .del')).trim() === 'delete' && (await logCount(sp)) === 2);
  await sp.click('#logList .del'); await wait(400); await sp.click('#logList .del');
  check('staff no longer sees deleted entry', await until(async()=> (await logCount(sp)) === 1));
  check('owner sees it struck through with who deleted it', await until(async()=> /Deleted by Test Staff/.test(await op.textContent('#logList'))));
  check('owner totals drop to 1', await until(async()=> (await op.textContent('#txCount')).startsWith('1 transaction')), await op.textContent('#txCount'));
  await op.click('#logList .restore');
  check('owner restore brings it back for staff', await until(async()=> (await logCount(sp)) === 2));

  // ---------- offline logging ----------
  check('connection status shows Connected in green while online', (await sp.textContent('#syncBadge')) === 'Connected' && await sp.$eval('#syncBadge', e=> e.classList.contains('online')), await sp.textContent('#syncBadge'));
  await St.c.setOffline(true);
  await logTx(sp, 'Withdrawal', '5000', '150');
  check('offline: entry shows on staff phone at once', await until(async()=> (await logCount(sp)) === 3));
  check('offline: badge says waiting to upload', await until(async()=> /⏳ 1 to upload/.test(await sp.textContent('#syncBadge'))), await sp.textContent('#syncBadge'));
  await wait(1500);
  check('offline: owner does not have it yet', (await logCount(op)) === 2, String(await logCount(op)));
  await St.c.setOffline(false);
  check('back online: a green "Connected" shows once it has uploaded', await until(async()=> (await sp.textContent('#syncBadge')) === 'Connected' && await sp.$eval('#syncBadge', e=> e.classList.contains('online')), 30000), await sp.textContent('#syncBadge'));
  check('back online: owner receives it', await until(async()=> (await logCount(op)) === 3, 30000), String(await logCount(op)));
  check('owner sees it was logged offline', await until(async()=> /logged offline · uploaded/.test(await op.textContent('#logList'))));
  check('back online: it stays showing Connected', await wait(5000) || (await sp.textContent('#syncBadge')) === 'Connected', await sp.textContent('#syncBadge'));

  // ---------- owner filters ----------
  await op.click('#periodTabs button[data-val="all"]');
  check('All Time includes the 60-day-old imported entry and the moved old ledger', await until(async()=> (await op.textContent('#txCount')).startsWith('7 transactions')), await op.textContent('#txCount'));
  await op.click('#loggedByFilter button:has-text("Test Staff")');
  check('Logged-by filter: Test Staff = 4 (incl. moved entry)', await until(async()=> (await op.textContent('#txCount')).startsWith('4 transactions')), await op.textContent('#txCount'));
  await op.click('#loggedByFilter button:has-text("Uweribe")');
  check('Logged-by filter: owner = 3 imported', await until(async()=> (await op.textContent('#txCount')).startsWith('3 transactions')), await op.textContent('#txCount'));
  await op.click('#loggedByFilter button:has-text("Everyone")');

  // ---------- staff view of the whole shop ----------
  await sp.click('#summaryToggle');
  await sp.click('#periodTabs button[data-val="all"]');
  check("staff All Time counts only the staff member's own entries", await until(async()=> (await sp.textContent('#txCount')).startsWith('4 transactions')), await sp.textContent('#txCount'));
  check('staff sees net profit, VAT and stamp duty amounts', /₦/.test(await sp.textContent('#netProfit')) && /^−₦/.test(await sp.textContent('#sumVat')) && /^−₦/.test(await sp.textContent('#sumStamp')), (await sp.textContent('#sumVat')) + ' / ' + (await sp.textContent('#sumStamp')));
  check('staff sees the Moniepoint/OPay fee amount', /^−₦/.test(await sp.textContent('#sumBaseFee')), await sp.textContent('#sumBaseFee'));
  check('staff: auto-save row is hidden', !(await sp.isVisible('#sumAutosaveRow')));
  check('owner: auto-save row is shown', await until(()=> op.isVisible('#sumAutosaveRow')));
  await sp.click('#logToggle');
  await until(async()=> /Withdrawal/.test(await sp.textContent('#logList')));
  const importedRows = await sp.$$eval('#logList .log-item', els => els.filter(e => /₦10,000|₦20,000\.|₦50,000/.test(e.textContent) && !/by: /.test(e.textContent) ).length);
  const importedLabelled = await sp.$$eval('#logList .log-item', els => els.filter(e => /imported/.test(e.textContent)).length);
  check('imported rows show without "by"/"imported" labels', importedLabelled === 0, `labelled=${importedLabelled}`);
  const staffDeletable = await sp.$$eval('#logList .log-item', els => els.filter(e => e.querySelector('.del')).map(e => /by: Test Staff/.test(e.textContent)));
  check('staff can only delete their own entries', staffDeletable.length === 3 && staffDeletable.every(Boolean), JSON.stringify(staffDeletable));
  await sp.click('#periodTabs button[data-val="today"]');
  await sp.click('#logToggle');

  // ---------- settings sync to staff ----------
  await op.click('#settingsToggle');
  await op.fill('#mp_transfer', '30'); await op.dispatchEvent('#mp_transfer','change');
  await sp.click('#typeSeg button[data-val="Transfer"]'); await sp.fill('#amount','5000');
  check('owner rate change reaches staff (₦30 + 7.5% VAT = ₦32.25, auto-save ₦0)', await until(async()=> (await sp.$eval('#machineTotal', e=>e.textContent)) === '₦32.25', 10000), await sp.textContent('#machineTotal'));
  await op.click('#settingsDoneBtn');

  await op.screenshot({ path: OUT + '/owner.png', fullPage: false });
  await sp.click('#logToggle').catch(()=>{});
  await sp.evaluate(()=> document.querySelector('#txLogCard').scrollIntoView());
  await sp.screenshot({ path: OUT + '/staff.png' });
  await op.evaluate(()=> document.querySelector('#txLogCard').scrollIntoView());
  await op.screenshot({ path: OUT + '/owner-log.png' });

  // ---------- owner adds a salesperson from Settings ----------
  await op.click('#settingsToggle');
  // Trainee: a label only. Tick it for Test Staff, then untick it.
  {
    const box = `.team-trainee-input[data-uid="${emu.TEST_ACCOUNTS[1].uid}"]`;
    await until(()=> op.isVisible(box));
    await op.check(box);
    check('owner can mark staff as a Trainee', await until(async()=> /STAFF \(TRAINEE\)/.test(await op.textContent('#teamInputs'))), await op.textContent('#teamInputs'));
    check("...the trainee's own header says STAFF (TRAINEE)", await until(async()=> / · STAFF \(TRAINEE\)$/.test(await sp.textContent('#whoLabel'))), await sp.textContent('#whoLabel'));
    check('...and their entries say "by: Test Staff (TRAINEE)"', await until(async()=> /by: Test Staff \(TRAINEE\)/.test(await op.textContent('#logList'))));
    await op.uncheck(box);
    check('...unticking it makes them STAFF again', await until(async()=> / · STAFF$/.test(await sp.textContent('#whoLabel')) && !/TRAINEE/.test(await op.textContent('#logList'))), await sp.textContent('#whoLabel'));
  }
  await op.fill('#newStaffName', 'New Person'); await op.fill('#newStaffEmail', 'new@test.com'); await op.fill('#newStaffUsername', 'newperson'); await op.fill('#newStaffPassword', 'start123');
  await op.click('#addStaffBtn');
  check('owner adds a salesperson from Settings', await until(async()=> /New Person added/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check('owner is still signed in as owner after adding', (await op.textContent('#whoLabel')) === 'Triumph Ventures · Uweribe · OWNER', await op.textContent('#whoLabel'));
  check('new person appears in Team list', await until(async()=> (await op.$$eval('#teamInputs .team-name-input', els => els.map(e=>e.value))).includes('New Person')));
  await op.fill('#newStaffName', 'Again'); await op.fill('#newStaffEmail', 'new@test.com'); await op.fill('#newStaffUsername', 'newperson'); await op.fill('#newStaffPassword', 'wrongpass');
  await op.click('#addStaffBtn');
  check('re-adding an existing login with the wrong password explains what to do', await until(async()=> /already has a login, but not with this password/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check('...and offers a password reset email', await op.isVisible('#addStaffResetBtn'));
  await op.fill('#newStaffName', ''); await op.fill('#newStaffEmail', ''); await op.fill('#newStaffPassword', '');
  const N = await ctx(b, 'newperson'); const np = N.p;
  await signIn(np, 'new@test.com', 'start123');
  check('new salesperson can sign in straight away', await until(async()=> (await np.textContent('#whoLabel')) === 'Triumph Ventures · New Person · STAFF'), await np.textContent('#whoLabel'));
  check('new salesperson cannot see Settings', !(await np.isVisible('#settingsCard')));
  await logTx(np, 'Withdrawal', '7000', '200');
  check("owner sees the new person's entry live", await until(async()=> /by: New Person/.test(await op.textContent('#logList'))));
  await wait(1000);
  if(!(await sp.isVisible('#logList'))) await sp.click('#logToggle');
  check("a salesperson's log shows another salesperson's entry", await until(async()=> /by: New Person/.test(await sp.textContent('#logList'))));
  if(!(await sp.isVisible('#summaryContent'))) await sp.click('#summaryToggle');
  await sp.click('#periodTabs button[data-val="today"]');
  const spToday = await sp.textContent('#txCount'); const opNames = await sp.$$eval('#logList .log-item', els => els.filter(e => /by: New Person/.test(e.textContent) && !e.querySelector('.del')).length);
  check("...but can't delete it, and it isn't in their totals", opNames >= 1 && /^3 transactions/.test(spToday), `${spToday} / undeletable=${opNames}`);
  check('a salesperson has no logged-by filter', !(await sp.isVisible('#loggedByFilter')));
  check('logged-by filter lists the new person', await until(async()=> (await op.$$eval('#loggedByFilter button', els => els.map(e=>e.textContent))).includes('New Person')));

  // ---------- remove / restore access ----------
  const staffRowRemove = await op.$('#teamInputs .team-row:has(input[data-uid="LDtRV9smFfdcudaBjiWixXyyg9A2"]) .team-remove');
  await staffRowRemove.click(); await wait(500); await staffRowRemove.click();
  check('removed salesperson is locked out while signed in', await until(async()=> /access to this ledger has been removed/.test(await sp.textContent('#authBlocked')), 15000), await sp.textContent('#authBlocked'));
  check('...and the app is hidden from them', !(await sp.isVisible('#appWrap')));
  check('owner sees "access removed" on their row', await until(async()=> /access removed/.test(await op.textContent('#teamInputs'))));
  await sp.reload();
  check('removed salesperson stays blocked after reload', await until(async()=> /doesn't have access|has been removed/.test(await sp.textContent('#authBlocked'))), await sp.textContent('#authBlocked'));
  await op.click('#teamInputs .team-restore');
  await wait(1000);
  await sp.reload();
  check('restored salesperson gets back in', await until(async()=> (await sp.textContent('#whoLabel')) === 'Triumph Ventures · Test Staff · STAFF', 15000), await sp.textContent('#whoLabel'));
  // ---------- salesperson with a username ----------
  await op.fill('#newStaffName', 'Uche'); await op.fill('#newStaffEmail', ''); await op.fill('#newStaffUsername', 'Uche'); await op.fill('#newStaffPassword', 'start123');
  await op.click('#addStaffBtn');
  check('adding a salesperson without an email is refused', await until(async()=> /Enter their name, email, username and a password/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  await op.fill('#newStaffEmail', 'uche@test.com'); await op.fill('#newStaffUsername', 'u!');
  await op.click('#addStaffBtn');
  check('a badly formed username is refused', await until(async()=> /Usernames are 3–30 characters/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  await op.fill('#newStaffUsername', 'Uche'); await op.click('#addStaffBtn');
  check('owner adds a salesperson with a username', await until(async()=> /Uche added ✓ They can sign in now with uche/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check('Team list shows the username and email', await until(async()=> /username: uche · uche@test\.com/.test(await op.textContent('#teamInputs'))), await op.textContent('#teamInputs'));
  await op.fill('#newStaffName', 'Other'); await op.fill('#newStaffEmail', 'other@test.com'); await op.fill('#newStaffUsername', 'uche'); await op.fill('#newStaffPassword', 'notTheirs1');
  await op.click('#addStaffBtn');
  check('a username already in use is reported as taken', await until(async()=> /username "uche" is already taken/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check("...and no login was created for the other email", (await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/ledger-3c7f0/accounts:lookup', { method:'POST', headers:{ Authorization:'Bearer owner', 'Content-Type':'application/json' }, body: JSON.stringify({ email:['other@test.com'] }) })).json()).users === undefined);
  await op.fill('#newStaffName', ''); await op.fill('#newStaffEmail', ''); await op.fill('#newStaffUsername', ''); await op.fill('#newStaffPassword', '');
  // give an existing email-login salesperson a username too (no delete needed)
  await op.fill('#newStaffName', 'New Person'); await op.fill('#newStaffEmail', 'new@test.com'); await op.fill('#newStaffUsername', 'newp'); await op.fill('#newStaffPassword', 'start123');
  await op.click('#addStaffBtn');
  check('an email-login salesperson can be given a username', await until(async()=> /New Person added back/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check('changing their username releases the old one', (await fetch('http://127.0.0.1:8080/v1/projects/ledger-3c7f0/databases/(default)/documents/usernames/newperson', { headers:{ Authorization:'Bearer owner' } })).status === 404);
  check('their Team row shows both username and email', await until(async()=> /username: newp · new@test\.com/.test(await op.textContent('#teamInputs'))), await op.textContent('#teamInputs'));
  const NP2 = await ctx(b, 'newp'); const n2 = NP2.p;
  await n2.goto(PAGE); await n2.waitForSelector('#authForm', { state:'visible' });
  await n2.click('#authRole button[data-val="staff"]'); await n2.fill('#authEmail', 'newp'); await n2.click('#authForgot');
  check('"Forgot password?" on a username with an email sends the reset to that email', await until(async()=> /reset link is on its way/.test(await n2.textContent('#authStatus'))), await n2.textContent('#authStatus'));
  await n2.fill('#authPassword', 'start123'); await n2.click('#authSubmit');
  check('...and they can sign in with the username', await until(async()=> (await n2.textContent('#whoLabel')) === 'Triumph Ventures · New Person · STAFF', 15000), await n2.textContent('#whoLabel'));
  await NP2.c.close();
  await op.fill('#newStaffName', ''); await op.fill('#newStaffEmail', ''); await op.fill('#newStaffUsername', ''); await op.fill('#newStaffPassword', '');
  const U = await ctx(b, 'uche'); const up = U.p;
  await up.goto(PAGE); await up.waitForSelector('#authForm', { state:'visible' });
  await up.click('#authRole button[data-val="staff"]'); await up.fill('#authEmail', 'uche'); await up.click('#authForgot');
  check('"Forgot password?" with the username sends the link to their email', await until(async()=> /reset link is on its way/.test(await up.textContent('#authStatus'))), await up.textContent('#authStatus'));
  await up.fill('#authEmail', 'UCHE'); await up.fill('#authPassword', 'start123'); await up.click('#authSubmit');
  check('salesperson signs in with just their username', await until(async()=> (await up.textContent('#whoLabel')) === 'Triumph Ventures · Uche · STAFF', 15000), await up.textContent('#whoLabel'));
  check('there is no "Change my password" card on the home page', !(await up.$('#passwordCard')));
  await U.c.close();

  // ---------- removed people leave the filter; permanent delete ----------
  const npRemove = await op.$('#teamInputs .team-row:has(input[value="New Person"]) .team-remove') || await op.$$eval('#teamInputs .team-row', rows => null);
  const npRow = async () => op.$('#teamInputs .team-row:has(.team-meta:has-text("new@test.com"))');
  await (await (await npRow()).$('.team-remove')).click(); await wait(500); await (await (await npRow()).$('.team-remove')).click();
  check('removed person disappears from the logged-by filter', await until(async()=> !(await op.$$eval('#loggedByFilter button', els => els.map(e=>e.textContent))).includes('New Person')), JSON.stringify(await op.$$eval('#loggedByFilter button', els => els.map(e=>e.textContent))));
  check('removed person can be deleted permanently (button shown)', await until(async()=> !!(await (await npRow()).$('.team-delete'))));
  await (await (await npRow()).$('.team-delete')).click(); await wait(500); await (await (await npRow()).$('.team-delete')).click();
  check('permanently deleted person leaves the Team list', await until(async()=> !(await npRow())));
  check("their past entry still shows their name", /by: New Person/.test(await op.textContent('#logList')));
  await np.reload();
  check('permanently deleted person is blocked', await until(async()=> /doesn't have access|has been removed/.test(await np.textContent('#authBlocked')), 15000), await np.textContent('#authBlocked'));
  // ...and can be added back later with the same email
  await op.fill('#newStaffName', 'New Person'); await op.fill('#newStaffEmail', 'new@test.com'); await op.fill('#newStaffUsername', 'newp'); await op.fill('#newStaffPassword', 'start123');
  await op.click('#addStaffBtn');
  check('a permanently deleted person can be added back with their email', await until(async()=> /New Person added back/.test(await op.textContent('#addStaffStatus'))), await op.textContent('#addStaffStatus'));
  check('...and is in the Team list again', await until(async()=> !!(await npRow())));
  await np.reload();
  check('...and can sign in again', await until(async()=> (await np.textContent('#whoLabel')) === 'Triumph Ventures · New Person · STAFF', 15000), await np.textContent('#whoLabel'));
  check('owner stayed signed in as owner', (await op.textContent('#whoLabel')) === 'Triumph Ventures · Uweribe · OWNER', await op.textContent('#whoLabel'));
  await op.click('#settingsDoneBtn');

  // ---------- old-ledger recopy ----------
  await op.click('#settingsToggle');
  check('the old-ledger box is hidden when nothing is missing', await until(async()=> /none/.test(await op.$eval('#legacySection', e => e.style.display)), 10000) && !(await op.isVisible('#legacySection')));
  await op.click('#settingsDoneBtn');
  await admin('transactions/oldtop-2', { id:{stringValue:'oldtop-2'}, loggedBy:{ stringValue:'LDtRV9smFfdcudaBjiWixXyyg9A2' }, deleted:{ booleanValue:false }, date:{ stringValue: tenDaysAgo }, createdAt:{ timestampValue: tenDaysAgo }, provider:{stringValue:'Opay'}, type:{stringValue:'Withdrawal'}, amount:{integerValue:'1000'}, customerFee:{integerValue:'100'}, baseFee:{integerValue:'10'}, providerFee:{integerValue:'10'}, netProfit:{integerValue:'90'} });
  await op.reload(); await until(()=> op.isVisible('#appWrap'), 20000);
  await op.click('#settingsToggle');
  check('the old-ledger box shows when an entry is missing', await until(()=> op.isVisible('#legacySection'), 10000));
  await op.click('#legacyRecopyBtn');
  check('recopy picks up an entry logged on the old version', await until(async()=> /Copied 1 missing entry/.test(await op.textContent('#legacyStatus'))), await op.textContent('#legacyStatus'));
  check('...and the box goes away once everything is copied', await until(async()=> !(await op.isVisible('#legacySection')), 10000));
  await op.fill('#bizNameInput', 'Triumph Ventures Ltd'); await op.dispatchEvent('#bizNameInput', 'change');
  check('owner can rename the business', await until(async()=> /^Triumph Ventures Ltd · /.test(await op.textContent('#whoLabel'))), await op.textContent('#whoLabel'));
  check("salesperson sees the new business name", await until(async()=> /^Triumph Ventures/.test(await sp.textContent('#whoLabel'))), await sp.textContent('#whoLabel'));
  await op.fill('#bizNameInput', 'Triumph Ventures'); await op.dispatchEvent('#bizNameInput', 'change');
  await until(async()=> /^Triumph Ventures · /.test(await op.textContent('#whoLabel')));
  await op.click('#settingsDoneBtn');

  // ---------- Withdraw+Transfer: the amount kept counts as the fee charged ----------
  {
    await op.click('#typeSeg button[data-val="WithdrawTransfer"]');
    await op.fill('#amount', '5200');
    await op.fill('#transferAmountsGrid .field:first-child .transfer-amount-input', '5000');
    await until(()=> op.isVisible('#remainingHandlingBalanceCheck'));
    await op.check('#remainingHandlingBalanceCheck');
    check('ticking "kept as service fee" hides the Service Fee box', !(await op.isVisible('#customerFee')));
    await op.click('#addBtn');
    const row = op.locator('#logList .log-item:has-text("withdrew ₦5,200")').first();
    check('the kept ₦200 is recorded as the fee charged', await until(async()=> /charged ₦200/.test(await row.textContent()) && !/loss/i.test(await row.textContent())), (await row.textContent().catch(()=>'')).replace(/\s+/g,' ').slice(0,200));
    await op.click('#typeSeg button[data-val="Withdrawal"]');
  }

  // ---------- custom date filter ----------
  {
    const ymd = n => { const d = new Date(); d.setDate(d.getDate()-n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    if(!(await op.isVisible('#summaryContent'))) await op.click('#summaryToggle');
    await op.click('#periodTabs button[data-val="all"]'); await wait(500);
    const all = parseInt(await op.textContent('#txCount'));
    await op.click('#periodTabs button[data-val="custom"]');
    await op.fill('#customStartDate', ymd(70)); await op.fill('#customEndDate', ymd(50));
    check('custom dates apply as soon as they are picked', await until(async()=> (await op.textContent('#txCount')).startsWith('1 transaction') && /Showing .* · 1 transaction/.test(await op.textContent('#customDateStatus'))), `${await op.textContent('#txCount')} / ${await op.textContent('#customDateStatus')}`);
    await op.fill('#customStartDate', ymd(0)); // later than the end date (50 days ago)
    check('a start date after the end date is swapped round', await until(async()=> (await op.$eval('#customStartDate', e=>e.value)) === ymd(50) && (await op.$eval('#customEndDate', e=>e.value)) === ymd(0) && parseInt(await op.textContent('#txCount')) === all - 1), `${await op.$eval('#customStartDate', e=>e.value)} ${await op.textContent('#txCount')} vs ${all - 1}`);
    await op.click('#applyDateFilterBtn');
    check('Apply confirms it was applied', await until(async()=> /Applied ✓/.test(await op.textContent('#applyDateFilterBtn'))));
    await op.click('#periodTabs button[data-val="today"]');
    check('leaving Custom clears its message', await until(async()=> (await op.textContent('#customDateStatus')) === ''));
  }

  // ---------- Volume Analysis follows the Filter ----------
  {
    const money = async () => [await op.textContent('#trendMoneyIn'), await op.textContent('#trendMoneyOut')].map(t => parseFloat(t.replace(/[^\d.]/g,'')) || 0);
    check('Volume Analysis has no date buttons of its own, and sits inside Filter', !(await op.$('#trendPeriodTabs')) && !(await op.$('#perfVolume')) && !!(await op.$('#perfFilters #trendMoneyIn')));
    await op.click('#periodTabs button[data-val="all"]'); await op.click('#providerFilter button[data-val="All"]'); await wait(400);
    const all = await money();
    check('the count under Transaction Log matches the filter', await until(async()=> (await op.textContent('#logCount')) === (await op.textContent('#txCount')).split(' · ')[0] && parseInt(await op.textContent('#logCount')) > 1), `${await op.textContent('#logCount')} vs ${await op.textContent('#txCount')}`);
    await op.click('#providerFilter button[data-val="Moniepoint"]'); await wait(400); const mp = await money();
    await op.click('#providerFilter button[data-val="Opay"]'); await wait(400); const opay = await money();
    check('Volume Analysis follows the provider filter', all[0] > 0 && all[0] === mp[0] + opay[0] && all[1] === mp[1] + opay[1] && (mp[0] !== all[0] || opay[0] !== all[0]), JSON.stringify({all, mp, opay}));
    await op.click('#providerFilter button[data-val="All"]');
    const ymd = n => { const d = new Date(); d.setDate(d.getDate()-n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    await op.click('#periodTabs button[data-val="custom"]');
    await op.fill('#customStartDate', ymd(3000)); await op.fill('#customEndDate', ymd(2999)); await wait(500);
    const none = await money();
    check("...and the Filter's dates (custom too)", none[0] === 0 && none[1] === 0, JSON.stringify(none));
    await op.click('#periodTabs button[data-val="today"]');
  }

  // ---------- calculator: full screen, back, sums ----------
  {
    await op.click('#calcToggle');
    const full = await op.evaluate(()=>{ const r = document.getElementById('calcCard').getBoundingClientRect(); return r.top === 0 && Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight; });
    check('calculator opens full screen with a Back button', full && await op.isVisible('#calcBackBtn'));
    const press = async ks => { for(const k of ks) await op.click(`#calcBody .calc-btn[data-calc="${k}"]`); };
    const shown = async () => (await op.textContent('#calcDisplay')).replace(/\s+/g,' ').trim();
    await press(['clear','5','0','%','3','=']); check('a digit after % starts a new number', (await shown()) === '3', await shown());
    await press(['clear','5','+','3','+','=']); check('= straight after an operator ignores it (5 + 3 + = is 8)', (await shown()) === '8', await shown());
    await press(['clear','0','.','1','+','0','.','2','=']); check('0.1 + 0.2 = 0.3', (await shown()) === '0.3', await shown());
    await press(['clear','5','0','+','1','0','%','=']); check('50 + 10% = 55', (await shown()) === '55', await shown());
    await press(['clear','1','0','/','0','=']); check('dividing by zero shows Error', (await shown()) === 'Error', await shown());
    await op.click('#calcBackBtn');
    check('Back returns to the home page', !(await op.isVisible('#calcBody')) && await op.isVisible('#calcToggle') && await op.isVisible('#entryCard'));
    await op.click('#calcToggle'); await op.goBack();
    check("the phone's own back button closes it too", await until(async()=> !(await op.isVisible('#calcBody')) && await op.isVisible('#appWrap')));
  }
  {
    const PC = await ctx(b, 'pc-calc'); const pc = PC.p;
    await pc.setViewportSize({ width: 1500, height: 900 });
    await signIn(pc, 'owner@test.com', 'secret123');
    await until(()=> pc.isVisible('#appWrap'), 20000);
    await pc.click('#calcToggle');
    const isFull = () => pc.evaluate(()=> document.getElementById('calcCard').classList.contains('calc-full'));
    const ch = await pc.evaluate(()=> [document.getElementById('calcCard').offsetHeight, document.getElementById('entryCard').offsetHeight]);
    check('on a computer the calculator opens as a dropdown', !(await isFull()) && await pc.isVisible('#calcBody') && await pc.isVisible('#calcExpandBtn'));
    check('...as tall as the Log a Transaction card', Math.abs(ch[0] - ch[1]) <= 2, JSON.stringify(ch));
    await pc.click('#calcExpandBtn');
    check('...the full-screen button opens it full screen, with no browser full-screen button', await isFull() && await pc.isVisible('#calcBackBtn') && !(await pc.isVisible('#calcExpandBtn')) && !(await pc.$('#calcFsBtn')));
    await pc.keyboard.type('7*6'); await pc.keyboard.press('Enter');
    check('...the keyboard works in it', (await pc.textContent('#calcDisplay')).trim() === '42', await pc.textContent('#calcDisplay'));
    await pc.keyboard.press('Escape');
    check('...and Esc goes back to the dropdown', await until(async()=> !(await isFull()) && await pc.isVisible('#calcBody')));
    await pc.click('#calcExpandBtn'); await pc.click('#calcBackBtn');
    check('...so does Back', await until(async()=> !(await isFull()) && await pc.isVisible('#calcBody')));
    await pc.click('#calcToggle');
    check('...and the heading closes the dropdown', await until(async()=> !(await pc.isVisible('#calcBody'))));
    // Settings on a computer: a dropdown as tall as Log a Transaction, with a full-screen button.
    await pc.click('#settingsToggle');
    const sh = await pc.evaluate(()=>{ const s = document.getElementById('settingsCard'), e = document.getElementById('entryCard'); return { full: s.classList.contains('settings-full'), s: s.offsetHeight, e: e.offsetHeight }; });
    check('on a computer settings open as a dropdown', !sh.full && await pc.isVisible('#settingsContent') && await pc.isVisible('#settingsExpandBtn'), JSON.stringify(sh));
    check('...as tall as the Log a Transaction card', Math.abs(sh.s - sh.e) <= 2, JSON.stringify(sh));
    await pc.click('#settingsExpandBtn');
    check('...the full-screen button opens them full screen', await pc.evaluate(()=> document.getElementById('settingsCard').classList.contains('settings-full')) && await pc.isVisible('#settingsBackBtn'));
    await pc.keyboard.press('Escape');
    check('...and Esc goes back to the dropdown', await until(async()=> !(await pc.evaluate(()=> document.getElementById('settingsCard').classList.contains('settings-full'))) && await pc.isVisible('#settingsContent')));
    await pc.click('#settingsExpandBtn'); await pc.click('#settingsBackBtn');
    check('...so does Back', await until(async()=> !(await pc.evaluate(()=> document.getElementById('settingsCard').classList.contains('settings-full'))) && await pc.isVisible('#settingsContent')));
    await pc.click('#settingsToggle');
    check('...and the heading closes the dropdown', await until(async()=> !(await pc.isVisible('#settingsContent'))));
    // Performance Overview / Tips column: never taller than Log a Transaction once open.
    const colH = () => pc.evaluate(()=> [document.getElementById('perfCard').parentElement.offsetHeight, document.getElementById('entryCard').offsetHeight]);
    await pc.click('#summaryToggle');
    for(const id of ['perfFilters','perfTotals','perfReports']) if(!(await pc.$eval('#'+id, e=>e.classList.contains('open')))) await pc.click('#'+id+' .perf-section-toggle');
    let ph = await colH();
    check('on a computer open Performance Overview is as tall as Log a Transaction', Math.abs(ph[0]-ph[1]) <= 2, JSON.stringify(ph));
    check('...and scrolls inside', await pc.$eval('#summaryContent', e=> e.scrollHeight > e.clientHeight));
    await pc.click('#safetyToggle'); ph = await colH();
    check('...also with Educational & Safety Tips open', Math.abs(ph[0]-ph[1]) <= 2, JSON.stringify(ph));
    await pc.click('#summaryToggle'); await pc.click('#safetyToggle');
    await PC.c.close();
  }

  // ---------- settings open full screen ----------
  {
    await op.click('#settingsToggle');
    const full = await op.evaluate(()=>{ const r = document.getElementById('settingsCard').getBoundingClientRect(); return r.top === 0 && Math.round(r.height) === innerHeight; });
    check('settings open full screen with a Back button', full && await op.isVisible('#settingsBackBtn') && await op.isVisible('#settingsContent'));
    await op.click('#settingsBackBtn');
    check('Back closes settings', !(await op.isVisible('#settingsContent')) && await op.isVisible('#settingsToggle'));
    await op.click('#settingsToggle'); await op.goBack();
    check("the phone's back button closes settings too", await until(async()=> !(await op.isVisible('#settingsContent')) && await op.isVisible('#appWrap')));
  }

  // ---------- old records on a second device ----------
  {
    const D2 = await ctx(b, 'second-device'); const dp = D2.p;
    const same = Object.assign({}, legacy[1], { id: 'other-device-copy-of-legacy-2' }); // already uploaded from the first device
    const fresh = { id:'only-on-device-2', date:new Date(now-5*86400e3).toISOString(), provider:'Moniepoint', type:'Withdrawal', amount:7300, customerFee:150, baseFee:37, vatAmt:0, stampAmt:0, autosaveAmt:0, providerFee:37, netProfit:113 };
    await dp.addInitScript(l => { if(!localStorage.getItem('seeded2')){ localStorage.setItem('ledger_transactions', JSON.stringify(l)); localStorage.setItem('seeded2','1'); } }, [legacy[0], same, fresh]);
    await signIn(dp, 'owner@test.com', 'secret123');
    await until(()=> dp.isVisible('#appWrap'), 20000);
    await dp.click('#settingsToggle');
    check('a second device only offers old records the cloud does not have yet', await until(async()=> (await dp.isVisible('#importSection')) && (await dp.textContent('#importBtn')) === 'Upload 1 transaction', 15000), await dp.textContent('#importBtn'));
    await dp.click('#importIgnoreBtn');
    check('Ignore hides the old-records box', !(await dp.isVisible('#importSection')));
    await dp.reload(); await until(()=> dp.isVisible('#appWrap'), 20000);
    await dp.click('#settingsToggle'); await wait(3000);
    check('...and it stays hidden on that device', !(await dp.isVisible('#importSection')));
    await D2.c.close();
  }

  // ---------- Performance Overview panels open and close ----------
  {
    const P = await ctx(b, 'panels'); const pp = P.p;
    await pp.addInitScript(()=>{ try{ if(!sessionStorage.getItem('x')){ localStorage.removeItem('ledger_perfOpen'); sessionStorage.setItem('x','1'); } }catch(e){} });
    await signIn(pp, 'owner@test.com', 'secret123');
    await until(()=> pp.isVisible('#appWrap'), 20000);
    await pp.click('#summaryToggle');
    check('Filter, Summary and Reports start closed', !(await pp.isVisible('#periodTabs')) && !(await pp.isVisible('#netProfit')) && !(await pp.isVisible('#csvBtn')) && await pp.isVisible('#perfTotals .perf-section-toggle'));
    await pp.click('#perfTotals .perf-section-toggle');
    check('tapping Summary opens just Summary', await pp.isVisible('#netProfit') && !(await pp.isVisible('#periodTabs')));
    await pp.reload(); await until(()=> pp.isVisible('#appWrap'), 20000); await pp.click('#summaryToggle');
    check('the phone remembers which panels were open', await until(()=> pp.isVisible('#netProfit')) && !(await pp.isVisible('#csvBtn')));
    await pp.click('#perfTotals .perf-section-toggle');
    check('tapping it again closes it', !(await pp.isVisible('#netProfit')));
    await P.c.close();
  }

  // ---------- reports and backups ----------
  if(!(await sp.isVisible('#summaryContent'))) await sp.click('#summaryToggle');
  await sp.click('#periodTabs button[data-val="all"]');
  await wait(800);
  {
    const [dl] = await Promise.all([ sp.waitForEvent('download'), sp.click('#sharePdfBtn') ]);
    const raw = fs.readFileSync(await dl.path(), 'latin1');
    check("salesperson's PDF covers only their own entries", /by Test Staff/.test(raw) && !/Uweribe/.test(raw));
  }
  check('salesperson sees Share PDF and Excel, but not Download PDF', await sp.isVisible('#sharePdfBtn') && await sp.isVisible('#csvBtn') && !(await sp.isVisible('#downloadPdfBtn')));
  check('owner sees Download PDF', await op.isVisible('#downloadPdfBtn'));
  {
    const [dl] = await Promise.all([ sp.waitForEvent('download'), sp.click('#csvBtn') ]);
    const rows = fs.readFileSync(await dl.path(), 'utf8').replace('\ufeff','').trim().split('\r\n');
    const head = rows[0].split(',');
    check("salesperson's spreadsheet has only their own entries", rows.length > 1 && rows.slice(1).every(r => r.split(',')[head.indexOf('Logged by')] === 'Test Staff'), rows.slice(1).map(r => r.split(',')[4]).join('|'));
    check("...without the owner-only columns", !head.includes('Auto-save') && !head.includes('Total cost') && head.includes('Net profit'), rows[0]);
  }
  // Deleted entries leave the owner's log two hours after they were deleted.
  {
    const ago = h => new Date(Date.now() - h*3600e3).toISOString();
    const delTx = (id, amount, h) => admin(`businesses/0xxeZTLlaAeTzTgpezc58hwDxXp2/transactions/${id}`, { id:{stringValue:id}, loggedBy:{ stringValue:'LDtRV9smFfdcudaBjiWixXyyg9A2' }, loggedByName:{stringValue:'Test Staff'}, deleted:{ booleanValue:true }, deletedBy:{ stringValue:'LDtRV9smFfdcudaBjiWixXyyg9A2' }, deletedAt:{ timestampValue: ago(h) }, date:{ stringValue: new Date().toISOString() }, createdAt:{ timestampValue: ago(h + 0.05) }, provider:{stringValue:'Moniepoint'}, type:{stringValue:'Withdrawal'}, amount:{integerValue:String(amount)}, customerFee:{integerValue:'100'}, baseFee:{integerValue:'20'}, providerFee:{integerValue:'20'}, netProfit:{integerValue:'80'} });
    await delTx('del-1h', 6111, 1); await delTx('del-3h', 6333, 3);
    check('an entry deleted an hour ago is still shown to the owner', await until(async()=> /6,111/.test(await op.textContent('#logList'))));
    check('an entry deleted three hours ago is gone from the log', !/6,333/.test(await op.textContent('#logList')));
  }
  {
    await op.click('#periodTabs button[data-val="all"]'); await wait(500);
    const shown = parseInt(await op.textContent('#txCount'));
    const [dl] = await Promise.all([ op.waitForEvent('download'), op.click('#csvBtn') ]);
    const csv = fs.readFileSync(await dl.path(), 'utf8'); const rows = csv.trim().split('\r\n');
    check('Excel download has a header and one row per entry shown', rows[0].replace('\ufeff','').startsWith('Date,Time,Provider,Type,Logged by,Amount') && rows.length - 1 === shown, `${rows.length - 1} rows vs ${shown}`);
    check('...named after the business', /^triumph-ventures-.*\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  }
  await logTx(sp, 'Transfer', '1234', '50');
  await until(async()=> /1,234/.test(await sp.textContent('#logList')));
  await sp.click('#logList .del'); await wait(400); await sp.click('#logList .del');
  await until(async()=> /Deleted by Test Staff/.test(await op.textContent('#logList')));
  await op.click('#settingsToggle');
  {
    const [dl] = await Promise.all([ op.waitForEvent('download'), op.click('#backupBtn') ]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    check('full backup includes old entries (60 days)', /legacy-1/.test(csv));
    check('full backup includes deleted entries', /,yes,Test Staff,/.test(csv));
  }
  await op.click('#settingsDoneBtn');

  // ---------- a wrong phone clock can't backdate an entry ----------
  const Clk = await ctx(b, 'clock'); const kp = Clk.p;
  await kp.addInitScript(() => { const shift = -2*86400e3; const RD = Date; class D extends RD { constructor(...a){ if(a.length) super(...a); else super(RD.now() + shift); } static now(){ return RD.now() + shift; } } window.Date = D; });
  await signIn(kp, 'staff@test.com', 'secret123');
  await until(()=> kp.isVisible('#appWrap'), 20000);
  const beforeClock = await logCount(op);
  await logTx(kp, 'Withdrawal', '7777', '100');
  check('entry from a phone 2 days behind reaches the owner', await until(async()=> (await logCount(op)) === beforeClock + 1, 15000));
  const clockItem = op.locator('#logList .log-item:has-text("7,777")').first();
  check("...dated by the server, not the phone", await until(async()=> /phone clock was 2 days behind/.test(await clockItem.textContent())), await clockItem.textContent().catch(()=>''));
  await Clk.c.close();

  // ---------- the owner's own username ----------
  await op.click('#settingsToggle');
  await op.fill('#ownerUsernameInput', 'uche'); await op.click('#ownerUsernameBtn');
  check("owner can't take a salesperson's username", await until(async()=> /already taken/.test(await op.textContent('#ownerUsernameStatus'))), await op.textContent('#ownerUsernameStatus'));
  await op.fill('#ownerUsernameInput', 'no good!'); await op.click('#ownerUsernameBtn');
  check('a badly formed owner username is refused', await until(async()=> /3–30 letters/.test(await op.textContent('#ownerUsernameStatus'))), await op.textContent('#ownerUsernameStatus'));
  await op.fill('#ownerUsernameInput', 'Uweribe'); await op.click('#ownerUsernameBtn');
  check('owner saves a username', await until(async()=> /Saved ✓/.test(await op.textContent('#ownerUsernameStatus'))) && (await op.$eval('#ownerUsernameInput', e=>e.value)) === 'uweribe', await op.textContent('#ownerUsernameStatus'));
  await op.click('#settingsDoneBtn');
  {
    const OU = await ctx(b, 'owner-username'); const up = OU.p;
    await signIn(up, 'uweribe', 'secret123', 'owner');
    check('owner signs in with their username', await until(async()=> /^Triumph Ventures · /.test(await up.textContent('#whoLabel')), 20000), await up.textContent('#whoLabel'));
    await OU.c.close();
  }

  // ---------- a new business owner signs up ----------
  const Ada = await ctx(b, 'ada'); const ap = Ada.p;
  await ap.goto(PAGE); await ap.waitForSelector('#authForm', { state:'visible' });
  check('sign-in screen offers "Create a business account"', await ap.isVisible('#showSignup'));
  await ap.click('#showSignup');
  await ap.fill('#signupBizName', 'Ada Stores'); await ap.fill('#signupOwnerName', 'Ada'); await ap.fill('#signupEmail', 'owner@test.com'); await ap.fill('#signupPhone', '0803 123 4567'); await ap.fill('#signupPassword', 'secret123'); await ap.check('#signupTerms'); await ap.click('#signupSubmit');
  check('signing up with an email that already has an account is refused', await until(async()=> /already has an account/.test(await ap.textContent('#authStatus'))), await ap.textContent('#authStatus'));
  check('sign-up form links the Terms of Use and Privacy Policy', !!(await ap.$('#signupForm a[href="terms.html"]')) && !!(await ap.$('#signupForm a[href="privacy.html"]')));
  await ap.fill('#signupEmail', 'ada@test.com'); await ap.fill('#signupPhone', '12345'); await ap.click('#signupSubmit');
  check('sign-up with a bad phone number is refused', await until(async()=> /valid phone number/.test(await ap.textContent('#authStatus'))) && !(await ap.isVisible('#verifyForm')), await ap.textContent('#authStatus'));
  await ap.fill('#signupPhone', '0803 123 4567');
  await ap.uncheck('#signupTerms'); await ap.fill('#signupEmail', 'ada@test.com'); await ap.click('#signupSubmit');
  check('sign-up without ticking the terms box is refused', await until(async()=> /Tick the box to agree/.test(await ap.textContent('#authStatus'))) && !(await ap.isVisible('#appWrap')), await ap.textContent('#authStatus'));
  await ap.check('#signupTerms'); await ap.fill('#signupUsername', 'uweribe'); await ap.click('#signupSubmit');
  check('sign-up with a taken username is refused', await until(async()=> /already taken/.test(await ap.textContent('#authStatus'))) && !(await ap.isVisible('#verifyForm')), await ap.textContent('#authStatus'));
  await ap.fill('#signupUsername', 'AdaStores'); await ap.click('#signupSubmit');
  check('a new owner is asked to confirm their email first', await until(async()=> await ap.isVisible('#verifyForm') && /ada@test\.com/.test(await ap.textContent('#verifyMsg')), 15000) && !(await ap.isVisible('#appWrap')));
  await ap.click('#verifyDone');
  check('...and can\'t continue before opening the link', await until(async()=> /Not confirmed yet/.test(await ap.textContent('#authStatus'))) && !(await ap.isVisible('#appWrap')), await ap.textContent('#authStatus'));
  await ap.reload();
  check('reopening the app goes back to the confirm-your-email step', await until(()=> ap.isVisible('#verifyForm'), 15000));
  check('the confirmation email was sent', await emu.verifyEmail('ada@test.com'));
  await ap.click('#verifyDone');
  check('a new owner waits for approval before using Ledger', await until(async()=> /waiting for approval/.test(await ap.textContent('#authBlocked')) && await ap.isVisible('#authBlocked'), 20000) && !(await ap.isVisible('#appWrap')), await ap.textContent('#authBlocked'));
  // the platform admin approves Ada from Settings
  await op.click('#settingsToggle'); await until(()=> op.isVisible('#adminRefreshBtn')); await op.click('#adminRefreshBtn');
  check('admin sees Ada waiting for approval, at the top of the list', await until(async()=> { const first = await op.$('#adminList .admin-biz'); return !!first && /Ada Stores/.test(await first.textContent()) && /Waiting for approval/.test(await first.textContent()); }) && /1 waiting for approval/.test(await op.textContent('#adminStatus')), await op.textContent('#adminStatus'));
  check('...showing the phone number given at sign-up', /0803 123 4567/.test(await op.textContent('#adminList .admin-biz.pending')), await op.textContent('#adminList .admin-biz.pending'));
  check('...and the admin\'s own business says MASTER ADMIN', /MASTER ADMIN/.test(await op.textContent('#adminList')));
  check('...with Approve and Decline, not Suspend', await op.isVisible('#adminList .admin-biz.pending .admin-approve') && await op.isVisible('#adminList .admin-biz.pending .admin-decline') && !(await op.$('#adminList .admin-biz.pending .admin-suspend')));
  await op.click('#adminList .admin-biz.pending .admin-decline');
  check('...Decline asks to confirm first', /Tap again to decline/.test(await op.textContent('#adminList .admin-biz.pending .admin-decline')));
  await wait(400); await op.click('#adminList .admin-biz.pending .admin-decline');
  check('a declined owner is told their account wasn\'t approved', await until(async()=> /wasn't approved/.test(await ap.textContent('#authBlocked')), 20000) && !(await ap.isVisible('#appWrap')), await ap.textContent('#authBlocked'));
  check('...and the admin list shows Declined, with "Approve after all"', await until(async()=> /Ada Stores[\s\S]*Status: Declined/.test(await op.textContent('#adminList')) && await op.isVisible('#adminList .admin-approve')), (await op.textContent('#adminList')).replace(/\s+/g,' ').slice(0,200));
  await op.click('#adminList .admin-approve');
  check('...approving it opens Ada\'s ledger by itself', await until(async()=> await ap.isVisible('#appWrap') && (await ap.textContent('#whoLabel')) === 'Ada Stores · Ada · OWNER', 20000), await ap.textContent('#whoLabel').catch(()=>''));
  check('...and the list shows Ada as Active', await until(async()=> /Ada Stores[\s\S]*Status: Active/.test(await op.textContent('#adminList'))), (await op.textContent('#adminList')).replace(/\s+/g,' ').slice(0,200));
  await op.click('#settingsBackBtn');
  check('new owner gets their own business', await until(async()=> (await ap.textContent('#whoLabel')) === 'Ada Stores · Ada · OWNER', 20000), await ap.textContent('#whoLabel'));
  check('the username chosen at sign-up is saved', await until(async()=> (await ap.$eval('#ownerUsernameInput', e=>e.value)) === 'adastores'), await ap.$eval('#ownerUsernameInput', e=>e.value));
  check('a new business starts with auto-save at ₦0', await until(async()=> (await ap.$eval('#autosaveFlat', e=>e.value)) === '0'), await ap.$eval('#autosaveFlat', e=>e.value));
  await ap.click('#summaryToggle'); await ap.click('#periodTabs button[data-val="all"]');
  check("new business starts empty (can't see Triumph's data)", await until(async()=> (await ap.textContent('#txCount')).startsWith('0 transactions')), await ap.textContent('#txCount'));
  const triumphBefore = await logCount(op);
  await logTx(ap, 'Withdrawal', '9000', '200');
  check('new owner can log in their own business', await until(async()=> (await ap.textContent('#txCount')).startsWith('1 transaction')), await ap.textContent('#txCount'));
  await wait(1500);
  check("Triumph doesn't see Ada's transaction", (await logCount(op)) === triumphBefore, `${triumphBefore} -> ${await logCount(op)}`);
  await ap.click('#settingsToggle');
  check("Ada's team has only Ada", await until(async()=> (await ap.$$('#teamInputs .team-row')).length === 1));
  await ap.fill('#newStaffName', 'Taken'); await ap.click('#addStaffBtn >> xpath=..//summary'); await ap.fill('#newStaffUid', 'LDtRV9smFfdcudaBjiWixXyyg9A2'); await ap.click('#addStaffByUidBtn');
  check("Ada can't take Triumph's salesperson", await until(async()=> /belongs to another business/.test(await ap.textContent('#addStaffStatus'))), await ap.textContent('#addStaffStatus'));
  check("Ada doesn't see the old-ledger section", !(await ap.isVisible('#legacySection')));
  check("Ada doesn't see the platform admin section", !(await ap.isVisible('#adminSection')));
  await ap.click('#settingsDoneBtn');

  // ---------- platform admin ----------
  await op.click('#settingsToggle');
  check('platform admin sees the admin section', await op.isVisible('#adminSection'));
  await op.click('#adminRefreshBtn');
  check('admin list shows both businesses', await until(async()=> /2 businesses/.test(await op.textContent('#adminStatus'))), await op.textContent('#adminStatus'));
  const adaRow = async () => op.$('#adminList .admin-biz:has-text("Ada Stores")');
  check("admin list shows Ada's owner email", /ada@test\.com/.test(await (await adaRow()).textContent()));
  await (await (await adaRow()).$('.admin-suspend')).click(); await wait(500); await (await (await adaRow()).$('.admin-suspend')).click();
  check('admin suspends Ada Stores', await until(async()=> /Suspended/.test(await (await adaRow()).textContent())));
  check('Ada is locked out straight away', await until(async()=> /has been suspended/.test(await ap.textContent('#authBlocked')), 15000), await ap.textContent('#authBlocked'));
  check("...and can't see the app", !(await ap.isVisible('#appWrap')));
  await ap.reload();
  check('Ada stays locked out after reload', await until(async()=> /has been suspended/.test(await ap.textContent('#authBlocked'))), await ap.textContent('#authBlocked'));
  await (await (await adaRow()).$('.admin-restore')).click();
  check('admin restores Ada Stores', await until(async()=> /Active/.test(await (await adaRow()).textContent())));
  await wait(800); await ap.reload();
  check('restored Ada gets back in', await until(async()=> (await ap.textContent('#whoLabel')) === 'Ada Stores · Ada · OWNER', 15000), await ap.textContent('#whoLabel'));
  await op.click('#settingsDoneBtn');
  await Ada.c.close();

  // ---------- legal pages + copyright ----------
  const L = await ctx(b, 'legal'); const lp = L.p;
  await lp.goto('http://127.0.0.1:8000/terms.html');
  check('Terms of Use page names the operator and contact', /Terms of Use/.test(await lp.textContent('h1')) && /Triumph Enterprise/.test(await lp.textContent('body')) && !!(await lp.$('a[href="mailto:victoryuweribe25@gmail.com"]')) && !/\[Operator name\]|\[contact email\]/.test(await lp.textContent('body')));
  await lp.goto('http://127.0.0.1:8000/privacy.html');
  check('Privacy Policy page loads', /Privacy Policy/.test(await lp.textContent('h1')) && /NDPA|Nigeria Data Protection/.test(await lp.textContent('body')));
  check('copyright shows in the app footer', /© 2026 Triumph Enterprise · Ledger · All rights reserved/.test(await op.textContent('#appWrap .legal-footer')));
  await L.c.close();

  // ---------- calculator from the sign-in screen ----------
  {
    const G = await ctx(b, 'guest-calc'); const gp = G.p;
    await gp.goto(PAGE); await gp.waitForSelector('#authForm', { state:'visible' });
    check('the sign-in screen has a Calculator button', await gp.isVisible('#authCalcBtn'));
    await gp.click('#authCalcBtn');
    check('...which opens the calculator full screen without signing in', await until(()=> gp.isVisible('#calcBody')) && !(await gp.isVisible('#appWrap')));
    for(const k of ['1','2','+','3','=']) await gp.click(`#calcBody .calc-btn[data-calc="${k}"]`);
    check('...and it works', (await gp.textContent('#calcDisplay')).trim() === '15', await gp.textContent('#calcDisplay'));
    await gp.click('#calcBackBtn');
    check('Back returns to the sign-in screen', await until(()=> gp.isVisible('#authForm')) && !(await gp.isVisible('#calcBody')));
    await G.c.close();
  }

  // ---------- login choice ----------
  const W = await ctx(b, 'wrongchoice'); const wp = W.p;
  await signIn(wp, 'owner@test.com', 'secret123', 'staff');
  check('owner login with "Salesperson" chosen is refused', await until(async()=> /BUSINESS OWNER login — choose "BUSINESS OWNER"/.test(await wp.textContent('#authStatus'))), await wp.textContent('#authStatus'));
  check('...and the app never appeared, not even briefly', (await wp.evaluate(()=> window.__appShown)) === false);
  await wp.reload(); await wp.waitForSelector('#authForm', { state:'visible' });
  check('nothing is pre-selected when the sign-in screen opens', !(await wp.$('#authRole button.active')) && /Choose how/.test(await wp.textContent('#authSub')), await wp.textContent('#authSub'));
  await wp.fill('#authEmail','owner@test.com'); await wp.fill('#authPassword','secret123'); await wp.click('#authSubmit');
  check('signing in without choosing is refused', await until(async()=> /Choose BUSINESS OWNER or STAFF first/.test(await wp.textContent('#authStatus'))) && !(await wp.isVisible('#appWrap')), await wp.textContent('#authStatus'));
  await wp.click('#authRole button[data-val="owner"]'); await wp.fill('#authEmail','owner@test.com'); await wp.fill('#authPassword','secret123'); await wp.click('#authSubmit');
  check('choosing Business Owner then lets the owner in', await until(async()=> (await wp.textContent('#whoLabel')) === 'Triumph Ventures · Uweribe · OWNER'), await wp.textContent('#whoLabel'));
  await wp.reload();
  check('a saved sign-in reopens without asking again', await until(()=> wp.isVisible('#appWrap')));

  // ---------- stranger ----------
  const X = await ctx(b, 'stranger'); const xp = X.p;
  await signIn(xp, 'stranger@test.com', 'secret123');
  check('unknown account is blocked', await until(async()=> /doesn't have access to (a|this) ledger/.test(await xp.textContent('#authBlocked'))));
  check('...and never sees the app', !(await xp.isVisible('#appWrap')));

  // ---------- sign out ----------
  await sp.click('#signOutBtn'); check('sign out asks to confirm', (await sp.textContent('#signOutBtn')) === 'Confirm'); await wait(600); await sp.click('#signOutBtn');
  check('staff signs out back to the sign-in form', await until(()=> sp.isVisible('#authForm')));
  check('after signing out, no option is selected for the next person', !(await sp.$('#authRole button.active')));
  // ---------- settings never carry over between businesses on the same phone ----------
  await op.click('#signOutBtn'); await wait(600); await op.click('#signOutBtn');
  await op.waitForSelector('#authForm', { state:'visible' });
  await op.click('#authRole button[data-val="owner"]'); await op.fill('#authEmail', 'adastores'); await op.fill('#authPassword', 'secret123'); await op.click('#authSubmit');
  check('a second owner signs in on the same phone', await until(async()=> (await op.textContent('#whoLabel')) === 'Ada Stores · Ada · OWNER', 15000), await op.textContent('#whoLabel'));
  check("...and starts with their own rates, not the previous business's", await until(async()=> (await op.$eval('#mp_transfer', e=>e.value)) === '20' && (await op.$eval('#autosaveFlat', e=>e.value)) === '0'), `${await op.$eval('#mp_transfer', e=>e.value)} / ${await op.$eval('#autosaveFlat', e=>e.value)}`);
  const errs = [...op.errs, ...sp.errs, ...xp.errs];
  check('no page errors', errs.length === 0, errs.join(' | ').slice(0,400));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await b.close(); process.exit(failures?1:0);
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
