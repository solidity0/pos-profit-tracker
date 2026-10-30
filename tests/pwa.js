// The app opens without internet once it has been loaded (service worker + offline data).
// Run via ./run.sh (see README.md).
const { chromium } = require('playwright');
const path = require('path');
const emu = require('./emulator.cjs');
const FB = path.join(__dirname, 'node_modules/firebase/');
const PAGE = 'http://127.0.0.1:8000/index.html?emulator=1';
let failures = 0;
const check = (label, ok, extra='') => { if(!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${label}${extra?'  ['+extra+']':''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms=10000){ const t = Date.now(); while(Date.now()-t < ms){ try{ if(await fn()) return true; }catch(e){} await wait(200); } return false; }

// Owners reach Tips and Settings through the side menu: like a person would, open it before
// tapping something inside it, and close it before tapping something on the page.
function sideAware(p){
  const realClick = p.click.bind(p);
  p.click = async (sel, opts) => {
    if(typeof sel === 'string' && sel !== '#sideMenuBtn' && sel !== '#sideCloseBtn' && sel !== '#sideBackdrop'){
      const st = await p.evaluate(s => {
        let el = null; try{ el = document.querySelector(s); }catch(e){}
        const d = document.getElementById('sideDrawer');
        return { inSide: !!(el && d && d.contains(el)), open: !!(d && d.classList.contains('open')), menu: document.body.classList.contains('has-side-menu'),
          full: !!document.querySelector('#settingsCard.settings-full, #safetyCard.tips-full') };
      }, sel).catch(()=> null);
      if(st && st.inSide && !st.open && st.menu){ await realClick('#sideMenuBtn'); await p.waitForTimeout(300); }
      if(st && !st.inSide && st.open && !st.full){ await realClick('#sideCloseBtn'); await p.waitForTimeout(300); }
    }
    return realClick(sel, opts);
  };
  return p;
}

(async()=>{
  await emu.reset(emu.TEST_ACCOUNTS);
  // a business to open
  await emu.adminWrite('businesses/' + emu.TEST_ACCOUNTS[0].uid, { name:{stringValue:'Offline Shop'}, ownerUid:{stringValue:emu.TEST_ACCOUNTS[0].uid}, ownerEmail:{stringValue:'owner@test.com'} });

  const b = await chromium.launch();
  const c = await b.newContext({ viewport:{ width:390, height:844 } });
  // Serve the libraries locally (also for the service worker's own requests, see run.sh).
  await c.route('https://www.gstatic.com/firebasejs/**', r => r.fulfill({ path: FB + path.basename(new URL(r.request().url()).pathname), contentType:'text/javascript' }));
  await c.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf/**', r => r.fulfill({ path: path.join(__dirname, 'node_modules/jspdf/dist/jspdf.umd.min.js'), contentType:'text/javascript' }));
  await c.route('https://fonts.googleapis.com/**', r => r.fulfill({ body:'', contentType:'text/css' }));
  // Settings categories start open in this test (what the page remembers is kept after that).
  await c.addInitScript(()=>{ try{ const k = 'ledger_perfOpen'; if(!localStorage.getItem(k)){ const o = {}; ['setCatAdmin','setCatBusiness','setCatTeam','setCatRates','setCatFees','setCatTips','setCatBackup'].forEach(id => o[id] = true); localStorage.setItem(k, JSON.stringify(o)); } }catch(e){} });
  const p = sideAware(await c.newPage()); const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.goto(PAGE);
  const manifest = await (await fetch('http://127.0.0.1:8000/manifest.webmanifest')).json();
  check('the app has an install manifest with icons', manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '512x512'));
  await p.waitForSelector('#authForm', { state:'visible' });
  await p.click('#authRole button[data-val="owner"]'); await p.fill('#authEmail', 'owner@test.com'); await p.fill('#authPassword', 'secret123'); await p.click('#authSubmit');
  check('owner signs in online', await until(async()=> /^Offline Shop · /.test(await p.textContent('#whoLabel')), 20000), await p.textContent('#whoLabel').catch(()=>''));
  check('service worker takes control', await until(()=> p.evaluate(()=> navigator.serviceWorker.ready.then(()=> !!navigator.serviceWorker.controller)), 15000) || (await p.reload(), await until(()=> p.evaluate(()=> !!navigator.serviceWorker.controller))));
  await until(()=> p.evaluate(async ()=> (await (await caches.open('ledger-v2')).keys()).length >= 8));
  await wait(1500);

  await p.fill('#amount', '4321'); await p.fill('#customerFee', '100'); await p.click('#addBtn');
  check('an entry logged online is saved', await until(async()=> /4,321/.test(await p.textContent('#logList')) && (await p.textContent('#syncBadge')) === 'Connected'), await p.textContent('#syncBadge'));
  await c.setOffline(true);
  await p.reload();
  check('with no internet the app still opens, signed in', await until(async()=> await p.isVisible('#appWrap') && /^Offline Shop · /.test(await p.textContent('#whoLabel')), 20000), await p.textContent('#whoLabel').catch(()=>''));
  if(!(await p.isVisible('#logContent'))) await p.click('#logToggle');
  check('...and shows the saved entries', await until(async()=> /4,321/.test(await p.textContent('#logList'))), (await p.textContent('#logList')).replace(/\s+/g,' ').slice(0,200));
  await p.fill('#amount', '2500'); await p.fill('#customerFee', '100'); await p.click('#addBtn');
  check('...and can log a new entry offline', await until(async()=> /2,500/.test(await p.textContent('#logList'))));
  check('...the status shows it is waiting to upload', await until(async()=> /⏳ 1 to upload/.test(await p.textContent('#syncBadge'))), await p.textContent('#syncBadge'));
  // Closing and reopening the app while offline keeps the entry that hasn't uploaded yet.
  await p.reload();
  await until(()=> p.isVisible('#appWrap'), 20000);
  if(!(await p.isVisible('#logContent'))) await p.click('#logToggle');
  check('...reopening the app offline keeps the not-yet-uploaded entry', await until(async()=> /2,500/.test(await p.textContent('#logList')) && /⏳ 1 to upload/.test(await p.textContent('#syncBadge')), 20000), await p.textContent('#syncBadge'));
  // The calculator works offline.
  await p.click('#calcToggle');
  for(const k of ['clear','1','2','*','3','=']) await p.click(`#calcBody .calc-btn[data-calc="${k}"]`);
  check('...the calculator works offline', (await p.textContent('#calcDisplay')).trim() === '36', await p.textContent('#calcDisplay'));
  await p.click('#calcBackBtn');
  // Settings: a rate change applies straight away offline (it uploads later).
  await p.click('#settingsToggle'); await until(()=> p.isVisible('#billFee'));
  await p.fill('#billFee', '77'); await p.dispatchEvent('#billFee', 'change');
  await p.click('#settingsBackBtn').catch(()=>{});
  await p.click('#typeSeg button[data-val="Bill"]'); await p.fill('#amount', '1000');
  check('...a rate changed offline applies at once', await until(async()=> /77/.test(await p.textContent('#machineBreakdown')) || /77/.test(await p.textContent('#machineTotal'))), (await p.textContent('#machineTotal')) + ' / ' + (await p.textContent('#machineBreakdown')));
  await p.fill('#amount', ''); await p.click('#typeSeg button[data-val="Withdrawal"]');
  await p.click('#settingsToggle'); await until(()=> p.isVisible('#ownerUsernameInput'));
  // Something that truly needs the server says so instead of hanging.
  await p.fill('#ownerUsernameInput', 'offlinetest'); await p.click('#ownerUsernameBtn');
  check('...an action that needs the server says it needs internet (no endless "Saving…")', await until(async()=> /needs an internet connection/.test(await p.textContent('#ownerUsernameStatus'))), await p.textContent('#ownerUsernameStatus'));
  await p.fill('#ownerUsernameInput', '');
  await p.click('#settingsBackBtn').catch(()=>{});
  // A CSV report downloads offline.
  await p.click('#summaryToggle');
  for(const id of ['perfReports']) if(!(await p.$eval('#'+id, e=>e.classList.contains('open')))) await p.click('#'+id+' .perf-section-toggle');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }).catch(()=>null), p.click('#csvBtn')]);
  check('...a CSV report downloads offline', !!dl);
  const [pdf] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }).catch(()=>null), p.click('#downloadPdfBtn')]);
  check('...a PDF report downloads offline', !!pdf && /\.pdf$/i.test(pdf.suggestedFilename()), pdf ? pdf.suggestedFilename() : 'no download');
  await c.setOffline(false);
  check('it uploads when the internet is back', await until(async()=> (await p.textContent('#syncBadge')) === 'Connected', 30000), await p.textContent('#syncBadge'));
  // and the owner's data really reached the server
  const n = await fetch(`http://127.0.0.1:8080/v1/projects/ledger-3c7f0/databases/(default)/documents/businesses/${emu.TEST_ACCOUNTS[0].uid}/transactions`, { headers:{ Authorization:'Bearer owner' } }).then(r=>r.json());
  check('...both entries are on the server', (n.documents || []).length === 2, String((n.documents || []).length));
  check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await b.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
