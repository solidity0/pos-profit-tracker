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
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.goto(PAGE);
  const manifest = await (await fetch('http://127.0.0.1:8000/manifest.webmanifest')).json();
  check('the app has an install manifest with icons', manifest.display === 'standalone' && manifest.icons.some(i => i.sizes === '512x512'));
  await p.waitForSelector('#authForm', { state:'visible' });
  await p.click('#authRole button[data-val="owner"]'); await p.fill('#authEmail', 'owner@test.com'); await p.fill('#authPassword', 'secret123'); await p.click('#authSubmit');
  check('owner signs in online', await until(async()=> /^Offline Shop · /.test(await p.textContent('#whoLabel')), 20000), await p.textContent('#whoLabel').catch(()=>''));
  check('service worker takes control', await until(()=> p.evaluate(()=> navigator.serviceWorker.ready.then(()=> !!navigator.serviceWorker.controller)), 15000) || (await p.reload(), await until(()=> p.evaluate(()=> !!navigator.serviceWorker.controller))));
  await until(()=> p.evaluate(async ()=> (await (await caches.open('ledger-v1')).keys()).length >= 8));
  await wait(1500);

  await p.fill('#amount', '4321'); await p.fill('#customerFee', '100'); await p.click('#addBtn');
  check('an entry logged online is saved', await until(async()=> /4,321/.test(await p.textContent('#logList')) && (await p.textContent('#syncBadge')) === ''), await p.textContent('#syncBadge'));
  await c.setOffline(true);
  await p.reload();
  check('with no internet the app still opens, signed in', await until(async()=> await p.isVisible('#appWrap') && /^Offline Shop · /.test(await p.textContent('#whoLabel')), 20000), await p.textContent('#whoLabel').catch(()=>''));
  if(!(await p.isVisible('#logContent'))) await p.click('#logToggle');
  check('...and shows the saved entries', await until(async()=> /4,321/.test(await p.textContent('#logList'))), (await p.textContent('#logList')).replace(/\s+/g,' ').slice(0,200));
  await p.fill('#amount', '2500'); await p.fill('#customerFee', '100'); await p.click('#addBtn');
  check('...and can log a new entry offline', await until(async()=> /2,500/.test(await p.textContent('#logList'))));
  await c.setOffline(false);
  check('it uploads when the internet is back', await until(async()=> (await p.textContent('#syncBadge')) === '', 30000), await p.textContent('#syncBadge'));
  check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await b.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
