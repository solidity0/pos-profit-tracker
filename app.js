// Ledger - POS profit tracker: the app's code (loaded by index.html).
// Copyright (c) 2026 Triumph Enterprise. All rights reserved. See LICENSE.
(function(){
  const $ = (sel) => document.querySelector(sel);
  // One shared formatter: toLocaleString() with options builds a new formatter on every
  // call, which adds up fast when rendering thousands of log rows on a phone.
  const nairaNumberFormat = new Intl.NumberFormat('en-NG', {maximumFractionDigits: 2});
  const fmt = (n) => '₦' + nairaNumberFormat.format(Math.round(n * 100) / 100);
  const fmtPdf = (n) => 'NGN ' + nairaNumberFormat.format(Math.round(n * 100) / 100);
  const numVal = (sel) => { const v = ($(sel).value || '').replace(/,/g,''); return parseFloat(v) || 0; };

  // Storage layer: uses Claude's artifact storage API when available (in-preview),
  // and automatically falls back to localStorage when running standalone
  // (e.g. hosted on GitHub Pages), where window.storage doesn't exist.
  const LS_PREFIX = 'ledger_';
  const store = {
    async get(key){
      if(window.storage && typeof window.storage.get === 'function'){
        try{ return await window.storage.get(key, false); }
        catch(e){ /* fall through to localStorage */ }
      }
      try{
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw !== null ? { key, value: raw } : null;
      }catch(e){ return null; }
    },
    async set(key, value){
      if(window.storage && typeof window.storage.set === 'function'){
        try{ return await window.storage.set(key, value, false); }
        catch(e){ /* fall through to localStorage */ }
      }
      try{
        localStorage.setItem(LS_PREFIX + key, value);
        return { key, value };
      }catch(e){ return null; }
    }
  };

  function attachCommaFormatting(input){
    input.addEventListener('input', ()=>{
      const distFromEnd = input.value.length - input.selectionStart;
      let raw = input.value.replace(/,/g,'').replace(/[^0-9.]/g,'');
      const dot = raw.indexOf('.');
      if(dot !== -1){ raw = raw.slice(0, dot+1) + raw.slice(dot+1).replace(/\./g,''); }
      const [intPartRaw, decPart] = raw.split('.');
      const intPart = intPartRaw.replace(/^0+(?=\d)/, '');
      const formattedInt = intPart ? Number(intPart).toLocaleString('en-US') : '';
      input.value = decPart !== undefined ? formattedInt + '.' + decPart : formattedInt;
      const pos = Math.max(0, input.value.length - distFromEnd);
      input.setSelectionRange(pos, pos);
    });
  }

  let state = { provider: 'Moniepoint', type: 'Withdrawal', biller: 'Electricity', period: 'today', providerFilter: 'All', loggedByFilter: 'All', customStart: null, customEnd: null };
  let selectedCombosBillers = new Set();
  let transactions = [];
  let settings = {
    stampFlat: 50, stampThreshold: 10000, stampOnWithdrawal: false,
    billFee: 0, bettingFee: 0,
    autosaveEnabled: true, autosaveFlat: 0,
    rates: {
      Moniepoint: { pct: 0.5, flat: 100, threshold: 20000, transfer: 20, vatRate: 7.5 },
      Opay:       { pct: 0.5, flat: 100, threshold: 20000, transfer: 20, vatRate: 7.5 }
    },
    customerFees: { 100:50, 500:50, 1000:100, 2000:100, 5000:150, 10000:200, 15000:250, 20000:300 },
    customerFeeAboveRate: 100,
    customerFeesCombo: { r1:'100', r2:'200', r3:'300', r4:'500', r5:'700 – 1,000', r6:'1,500 – 3,000' },
    safetyTips: [
      'Never share your PIN, OTP, or login password with anyone — not even someone claiming to be from Moniepoint/OPay support.',
      'Always confirm an incoming transfer has actually landed in your account before handing out cash — a screenshot or SMS shown to you is not proof of payment.',
      'Watch out for reversal scams: a customer claims a transfer failed and asks for their cash back before you have confirmed your balance.',
      'Verify the receiving account name and number before sending — a wrongly sent transfer can take days to reverse, or may not reverse at all.',
      'Record every transaction, especially large withdrawals and transfers. No transaction is too small to log.',
      'If your network is unstable, wait for confirmation before dispensing cash rather than assuming it went through.',
      'For transfers, airtime/data, and bill payments: if a transaction is still pending, wait for it to fail or reverse before retrying — never repeat a transaction that has not yet resolved.'
    ]
  };
  // Every business starts from these, never from another business's settings left on the phone.
  const DEFAULT_SETTINGS = JSON.parse(JSON.stringify(settings));
  function settingsCacheKey(){ return 'settings:' + (bizId || 'none'); }
  const feeTiers = [100, 500, 1000, 2000, 5000, 10000, 15000, 20000];
  const comboRanges = [
    { id: 'r1', label: '1,000 – 3,000' },
    { id: 'r2', label: '4,000 – 15,000' },
    { id: 'r3', label: '16,000 – 90,000' },
    { id: 'r4', label: '100,000 – 500,000' },
    { id: 'r5', label: '500,000 – 1,000,000' },
    { id: 'r6', label: '1,000,000 and above' }
  ];

  $('#todayLabel').textContent = new Date().toLocaleDateString('en-NG', { weekday:'short', day:'numeric', month:'short', year:'numeric' });

  const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/></svg>';

  function applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    $('#themeToggle').innerHTML = theme === 'night' ? moonIcon : sunIcon;
    if(typeof applyProviderTheme === 'function' && state.provider) applyProviderTheme(state.provider);
  }

  async function loadTheme(){
    let theme = 'night';
    try{
      const t = await store.get('theme');
      if(t && (t.value === 'day' || t.value === 'night')) theme = t.value;
    }catch(e){}
    applyTheme(theme);
  }
  loadTheme();

  $('#themeToggle').addEventListener('click', async ()=>{
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'night' ? 'day' : 'night';
    applyTheme(next);
    try{ await store.set('theme', next); }catch(e){}
  });

  // App-controlled compact view: scales the whole layout via CSS `zoom` (which this
  // page fully controls) instead of relying on the browser's own zoom/pinch feature.
  // Some mobile browsers (notably Chrome on iOS) only visually magnify on pinch-zoom
  // without actually reflowing the page, so labels like "Amount Withdrawn" can't react
  // to it. This toggle reflows for real, the same way on every browser and device.
  let appScale = 1;
  function applyAppScale(scale){
    appScale = scale;
    document.documentElement.style.setProperty('--app-zoom', scale);
    const btn = $('#textSizeToggle');
    btn.setAttribute('aria-pressed', scale < 1 ? 'true' : 'false');
  }
  async function loadAppScale(){
    let scale = 1;
    try{
      const s = await store.get('appScale');
      if(s && s.value){ const n = parseFloat(s.value); if(!isNaN(n) && n > 0) scale = n; }
    }catch(e){}
    applyAppScale(scale);
  }
  loadAppScale();

  $('#textSizeToggle').addEventListener('click', async ()=>{
    const next = appScale < 1 ? 1 : 0.85;
    applyAppScale(next);
    requestAnimationFrame(sizeEntryBody);
    try{ await store.set('appScale', String(next)); }catch(e){}
  });

  function setStatus(msg, cls){
    const el = $('#status');
    el.textContent = msg;
    el.className = 'status' + (cls ? ' ' + cls : '');
    const duration = cls === 'error' ? 6000 : 2000;
    if(msg) setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; }, duration);
  }

  function setStatusLines(lines){
    // Renders multiple validation messages at once, each on its own line with its own color
    // (e.g. the green "enter fee" reminder alongside a red "funds exceeded" warning).
    const el = $('#status');
    const html = lines.map(l => `<div class="status-line ${l.cls || ''}">${l.msg}</div>`).join('');
    el.innerHTML = html;
    el.className = 'status';
    const hasError = lines.some(l => l.cls === 'error');
    const duration = hasError ? 6000 : 2000;
    if(html) setTimeout(()=>{ if(el.innerHTML === html) el.innerHTML = ''; }, duration);
  }

  function computeBaseFee(provider, type, amount){
    if(type === 'Bill') return (state.biller === 'Betting' ? settings.bettingFee : settings.billFee) || 0;
    const r = settings.rates[provider];
    if(!r || !amount || amount <= 0) return 0;
    if(type === 'Transfer') return r.transfer;
    if(amount <= r.threshold) return +(amount * (r.pct/100)).toFixed(2);
    return r.flat;
  }

  function computeComboBreakdown(provider, withdrawAmount, transferLegs, billLegs){
    // Withdraw+Split-Transfer: one withdrawal leg + N transfer legs, plus zero or more
    // bill-payment legs (paid out of the leftover — a customer can pay several billers
    // in the same visit, e.g. Electricity + GOTV). The withdrawal fee is ALWAYS computed
    // normally — same-bank/override never touches it, since a cash withdrawal always has
    // a real machine fee regardless of where transfers go. Each transfer leg has its own
    // sameBank flag: true = free same-bank transfer (fee+VAT drop to 0 for that leg only),
    // false = normal transfer fee+VAT. Stamp duty and autosave still apply per leg either
    // way (EMTL and autosave apply regardless of who waives the fee). Each bill-payment leg
    // follows the same rules as the standalone Bill type: just its own machine charge
    // (billFee/bettingFee) — no VAT, no stamp duty, no autosave for that portion — and each
    // biller paid is its own separate terminal transaction, so its fee is added per biller.
    const legs = (transferLegs || []).filter(l => l.amount > 0);
    const withdrawalBase = computeBaseFee(provider, 'Withdrawal', withdrawAmount);
    let transferBaseTotal = 0, vat = 0, stamp = 0;
    legs.forEach(leg=>{
      const tBase = leg.sameBank ? 0 : computeBaseFee(provider, 'Transfer', leg.amount);
      transferBaseTotal += tBase;
      if(!leg.sameBank) vat += tBase * ((settings.rates[provider].vatRate||0)/100);
      if(leg.amount >= settings.stampThreshold) stamp += settings.stampFlat;
    });
    const bills = (billLegs || []).filter(b => b.amount > 0);
    let billFeeAmt = 0;
    bills.forEach(b=>{
      billFeeAmt += (b.biller === 'Betting' ? settings.bettingFee : settings.billFee) || 0;
    });
    const base = +(withdrawalBase + transferBaseTotal + billFeeAmt).toFixed(2);
    vat = +vat.toFixed(2);
    stamp = +stamp.toFixed(2);
    const legsCount = (withdrawAmount > 0 ? 1 : 0) + legs.length;
    const autosaveLeg = (provider === 'Moniepoint' && settings.autosaveEnabled) ? settings.autosaveFlat : 0;
    const autosave = +(autosaveLeg * legsCount).toFixed(2);
    const total = +(base + vat + stamp + autosave).toFixed(2);
    return { base, vat, stamp, autosave, total, withdrawalBase, transferBaseTotal, billFeeAmt, billPayments: bills, transferAmounts: legs.map(l=>l.amount), transferSameBank: legs.map(l=>!!l.sameBank), legsCount };
  }

  function computeBreakdown(provider, type, amount, manualBase, transferAmt){
    // Withdraw+Transfer is charged as two separate legs (a withdrawal + a transfer),
    // each with its own fee, VAT, and autosave — not one combined flat fee, and the
    // two legs can be different amounts (e.g. withdraw ₦50,000, transfer ₦20,000).
    if(type === 'WithdrawTransfer' && (manualBase === null || manualBase === undefined)){
      const tAmt = (transferAmt !== null && transferAmt !== undefined && transferAmt !== '') ? transferAmt : amount;
      const withdrawalBase = computeBaseFee(provider, 'Withdrawal', amount);
      const transferBase = computeBaseFee(provider, 'Transfer', tAmt);
      const base = +(withdrawalBase + transferBase).toFixed(2);
      // VAT only applies to the transfer-type fee, not the withdrawal fee (confirmed: a plain
      // withdrawal shows no VAT line at all, while a plain transfer's fee gets 7.5% VAT).
      const vat = +(transferBase * ((settings.rates[provider].vatRate||0)/100)).toFixed(2);
      let stamp = 0;
      if(tAmt >= settings.stampThreshold) stamp = settings.stampFlat;
      const autosaveLeg = (provider === 'Moniepoint' && settings.autosaveEnabled && (amount > 0 || tAmt > 0)) ? settings.autosaveFlat : 0;
      const autosave = +(autosaveLeg * 2).toFixed(2);
      const total = +(base + vat + stamp + autosave).toFixed(2);
      return { base, vat, stamp, autosave, total, withdrawalBase, transferBase, transferAmt: tAmt };
    }
    const base = (manualBase !== null && manualBase !== undefined) ? manualBase : computeBaseFee(provider, type, amount);
    const isTransferLike = (type === 'Transfer' || type === 'WithdrawTransfer');
    const vat = isTransferLike ? +(base * ((settings.rates[provider].vatRate||0)/100)).toFixed(2) : 0;
    let stamp = 0;
    if(amount >= settings.stampThreshold){
      if(isTransferLike || (type === 'Withdrawal' && settings.stampOnWithdrawal)) stamp = settings.stampFlat;
    }
    const autosave = (provider === 'Moniepoint' && settings.autosaveEnabled && amount > 0 && type !== 'Bill') ? settings.autosaveFlat : 0;
    const total = +(base + vat + stamp + autosave).toFixed(2);
    return { base, vat, stamp, autosave, total };
  }

  function feeRowHtml(label, bd){
    const parts = [fmt(bd.base)];
    if(bd.vat > 0) parts.push('VAT ' + fmt(bd.vat));
    if(bd.stamp > 0) parts.push('stamp ' + fmt(bd.stamp));
    if(bd.autosave > 0) parts.push('autosave ' + fmt(bd.autosave));
    return `<div class="fee-row"><span class="fee-row-amt">${label}</span><span class="fee-row-detail">${parts.join(' + ')} = <strong>${fmt(bd.total)}</strong></span></div>`;
  }

  function renderMoniepointFeeTable(){
    const el = $('#mpFeeTable');
    if(!el) return;
    const r = settings.rates.Moniepoint;
    const tiers = [100, 500, 1000, 2000, 5000, 10000, 15000, 20000];
    let html = tiers.map(amt => feeRowHtml(fmt(amt), computeBreakdown('Moniepoint', 'Withdrawal', amt))).join('');
    html += feeRowHtml('Above ' + fmt(r.threshold), computeBreakdown('Moniepoint', 'Withdrawal', r.threshold + 1000));
    html += `<div class="fee-table-subhead">Transfer</div>`;
    const belowStampAmt = Math.max(Math.min(settings.stampThreshold - 1000, 9000), 100);
    html += feeRowHtml('Under ' + fmt(settings.stampThreshold), computeBreakdown('Moniepoint', 'Transfer', belowStampAmt));
    html += feeRowHtml(fmt(settings.stampThreshold) + '+', computeBreakdown('Moniepoint', 'Transfer', settings.stampThreshold));
    html += `<div class="fee-table-subhead">Withdraw+Transfer</div>`;
    html += feeRowHtml('Under ' + fmt(settings.stampThreshold), computeBreakdown('Moniepoint', 'WithdrawTransfer', belowStampAmt));
    html += feeRowHtml(fmt(settings.stampThreshold) + '+', computeBreakdown('Moniepoint', 'WithdrawTransfer', settings.stampThreshold));
    el.innerHTML = html;
  }

  function serviceFeeLabel(tier){ return fmt(tier); }

  function renderServiceFeeInputs(){
    const el = $('#serviceFeeInputs');
    if(!el) return;
    el.innerHTML = feeTiers.map(tier => `
      <div class="field">
        <label>${serviceFeeLabel(tier)} (₦)</label>
        <input type="text" inputmode="numeric" autocomplete="off" class="svcfee-input" data-tier="${tier}" />
      </div>
    `).join('');
    feeTiers.forEach(tier=>{
      const input = el.querySelector(`.svcfee-input[data-tier="${tier}"]`);
      attachCommaFormatting(input);
      input.value = settings.customerFees[tier] ? Number(settings.customerFees[tier]).toLocaleString('en-US') : '';
      input.addEventListener('change', async ()=>{
        const raw = (input.value || '').replace(/,/g, '');
        const n = parseFloat(raw);
        settings.customerFees[tier] = isNaN(n) ? 0 : n;
        await saveSettings();
        renderServiceFeeReference();
      });
    });

    const aboveEl = $('#serviceFeeAboveInput');
    if(aboveEl){
      aboveEl.value = settings.customerFeeAboveRate ? Number(settings.customerFeeAboveRate).toLocaleString('en-US') : '';
      if(aboveEl.dataset.wired) return;
      aboveEl.dataset.wired = '1';
      attachCommaFormatting(aboveEl);
      aboveEl.addEventListener('change', async ()=>{
        const raw = (aboveEl.value || '').replace(/,/g, '');
        const n = parseFloat(raw);
        settings.customerFeeAboveRate = isNaN(n) ? 0 : n;
        await saveSettings();
        renderServiceFeeReference();
      });
    }
  }

  function renderComboFeeInputs(){
    const el = $('#comboFeeInputs');
    if(!el) return;
    el.innerHTML = comboRanges.map(r => `
      <div class="field">
        <label>${r.label} (₦)</label>
        <input type="text" inputmode="text" autocomplete="off" class="combofee-input" data-range="${r.id}" placeholder="e.g. 300 or 700 – 1,000" />
      </div>
    `).join('');
    comboRanges.forEach(r=>{
      const input = el.querySelector(`.combofee-input[data-range="${r.id}"]`);
      input.value = settings.customerFeesCombo[r.id] != null ? String(settings.customerFeesCombo[r.id]) : '';
      input.addEventListener('change', async ()=>{
        settings.customerFeesCombo[r.id] = (input.value || '').trim();
        await saveSettings();
        renderServiceFeeReference();
      });
    });
  }

  function formatFeeDisplay(value){
    const str = String(value == null ? '' : value).trim();
    if(!str) return fmt(0);
    const parts = str.split(/[-–]/).map(p => p.trim()).filter(Boolean);
    if(parts.length === 2){
      const a = parseFloat(parts[0].replace(/,/g,''));
      const b = parseFloat(parts[1].replace(/,/g,''));
      if(!isNaN(a) && !isNaN(b)) return `${fmt(a)} – ${fmt(b)}`;
    }
    const n = parseFloat(str.replace(/,/g,''));
    return isNaN(n) ? str : fmt(n);
  }

  function renderServiceFeeReference(){
    const el = $('#serviceFeeReference');
    if(!el) return;
    let html = feeTiers.map(tier=>{
      const fee = settings.customerFees[tier] || 0;
      return `<div class="fee-row"><span class="fee-row-amt">${serviceFeeLabel(tier)}</span><span class="fee-row-detail"><strong>${fmt(fee)}</strong></span></div>`;
    }).join('');
    html += `<div class="fee-row"><span class="fee-row-amt">Above ${fmt(20000)}</span><span class="fee-row-detail"><strong>${fmt(settings.customerFeeAboveRate||0)} per ${fmt(10000)}</strong></span></div>`;
    html += `<div class="fee-table-subhead">Withdraw+Transfer</div>`;
    html += comboRanges.map(r=>{
      return `<div class="fee-row"><span class="fee-row-amt">${r.label}</span><span class="fee-row-detail"><strong>${formatFeeDisplay(settings.customerFeesCombo[r.id])}</strong></span></div>`;
    }).join('');
    el.innerHTML = html;
  }

  function renderSafetyTipsDisplay(){
    const el = $('#safetyTipsList');
    if(!el) return;
    el.innerHTML = (settings.safetyTips || []).filter(t => (t||'').trim()).map(tip => `<li>${escapeHtml(tip)}</li>`).join('');
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderSafetyTipsEditor(){
    const el = $('#safetyTipsEditor');
    if(!el) return;
    el.innerHTML = (settings.safetyTips || []).map((tip, i) => `
      <div class="tip-row" data-idx="${i}">
        <textarea class="tip-textarea">${escapeHtml(tip)}</textarea>
        <button type="button" class="tip-remove" data-idx="${i}">✕</button>
      </div>
    `).join('');
    el.querySelectorAll('.tip-textarea').forEach((ta, i)=>{
      ta.addEventListener('change', async ()=>{
        settings.safetyTips[i] = ta.value;
        await saveSettings();
        renderSafetyTipsDisplay();
      });
    });
    el.querySelectorAll('.tip-remove').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const idx = parseInt(btn.dataset.idx, 10);
        settings.safetyTips.splice(idx, 1);
        await saveSettings();
        renderSafetyTipsEditor();
        renderSafetyTipsDisplay();
      });
    });
  }

  let transferBoxCount = 0;

  function renumberTransferBoxes(){
    document.querySelectorAll('#transferAmountsGrid .field').forEach((field, i)=>{
      const label = field.querySelector('label');
      if(label) label.textContent = `Transfer ${i + 1} (₦)`;
    });
  }

  function getTransferLegs(){
    return Array.from(document.querySelectorAll('#transferAmountsGrid .field')).map(field => {
      const inp = field.querySelector('.transfer-amount-input');
      const check = field.querySelector('.samebank-check');
      const raw = (inp.value || '').replace(/,/g,'');
      const n = parseFloat(raw);
      return { amount: isNaN(n) ? 0 : n, sameBank: check ? check.checked : false };
    });
  }

  function addTransferBox(removable){
    transferBoxCount++;
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = `
      ${removable ? '<span class="remove-x" data-remove>✕</span>' : ''}
      <label>Transfer (₦)</label>
      <input type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 50,000" class="transfer-amount-input" />
      <label class="samebank-toggle"><input type="checkbox" class="samebank-check" />Same bank (free)</label>
    `;
    $('#transferAmountsGrid').appendChild(field);
    const input = field.querySelector('input.transfer-amount-input');
    attachCommaFormatting(input);
    input.addEventListener('input', refreshAuto);
    field.querySelector('.samebank-check').addEventListener('change', refreshAuto);
    if(removable){
      field.querySelector('[data-remove]').addEventListener('click', ()=>{
        field.remove();
        renumberTransferBoxes();
        refreshAuto();
      });
    }
    renumberTransferBoxes();
  }

  function hideCashField(){
    $('#cashField').style.display = 'none';
    $('#cashAmount').value = '';
    $('#addCashBtn').style.display = 'flex';
    $('#runningTotalWrap').style.gridColumn = '1 / -1';
  }

  function renderComboBillerAmounts(){
    const container = $('#comboBillerAmounts');
    const existingValues = {};
    container.querySelectorAll('input').forEach(inp => { existingValues[inp.dataset.biller] = inp.value; });
    container.innerHTML = '';
    selectedCombosBillers.forEach(biller=>{
      const wrap = document.createElement('div');
      wrap.className = 'field breathing-field';
      wrap.style.margin = '10px 0 0';
      wrap.innerHTML = `<label style="min-height:auto; display:block;">Enter the ${biller} amount paid (₦)</label><input type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 1,000" style="text-align:center;" class="combo-biller-amount" data-biller="${biller}" />`;
      container.appendChild(wrap);
      const inp = wrap.querySelector('input');
      if(existingValues[biller]) inp.value = existingValues[biller];
      attachCommaFormatting(inp);
      inp.addEventListener('input', refreshAuto);
    });
  }

  function resetTransferBoxes(){
    $('#transferAmountsGrid').innerHTML = '';
    transferBoxCount = 0;
    addTransferBox(false);
    addTransferBox(false);
    hideCashField();
    $('#remainingHandlingCustomerCheck').checked = false;
    $('#remainingHandlingBillCheck').checked = false;
    $('#remainingHandlingBalanceCheck').checked = false;
    $('#cashGivenAmount').value = '';
    $('#cashGivenAmountWrap').style.display = 'none';
    $('#billPaymentAmountWrap').style.display = 'none';
    $('#customerFeeFieldWrap').style.display = '';
    selectedCombosBillers.clear();
    $('#comboBillerSeg').querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    $('#comboBillerAmounts').innerHTML = '';
  }

  function updateLayoutForType(isCombo){
    const feeWrap = $('#customerFeeFieldWrap');
    const standaloneSlot = $('#customerFeeStandaloneSlot');
    const amountWrap = $('#amountFieldWrap');
    $('#transferSection').style.display = isCombo ? 'block' : 'none';
    if(isCombo){
      amountWrap.classList.add('withdrawn-field');
      $('#amountFeeRow').style.gridTemplateColumns = '1fr';
      if(feeWrap.parentElement !== standaloneSlot) standaloneSlot.appendChild(feeWrap);
    } else {
      amountWrap.classList.remove('withdrawn-field');
      $('#amountFeeRow').style.gridTemplateColumns = '';
      if(feeWrap.parentElement !== $('#amountFeeRow')) $('#amountFeeRow').appendChild(feeWrap);
      feeWrap.style.display = '';
    }
  }

  function computeCurrentRemaining(){
    const amount = numVal('#amount');
    const cash = numVal('#cashAmount');
    const legs = getTransferLegs();
    const sum = legs.reduce((a,l)=>a+l.amount, 0);
    return (amount + cash) - sum;
  }

  // Reads the leftover-handling checkboxes + their amount fields. Any combination can be
  // ticked at once, splitting the remaining across bill payment(s) / cash given / kept-as-
  // fee. The bill leg can itself be split across several billers (e.g. Electricity + GOTV),
  // each with its own amount box, and both of those require an amount to be typed in
  // explicitly — a ticked box with a blank amount contributes ₦0, never auto-fills. "Kept
  // as service fee/charge" works differently on purpose: it has no amount box of its own —
  // ticking it just claims whatever's still left after bill + cash given, since that's
  // definitionally what "kept" means once the other two are accounted for.
  function getRemainingLegAmounts(remaining){
    const billChecked = $('#remainingHandlingBillCheck').checked;
    const custChecked = $('#remainingHandlingCustomerCheck').checked;
    const keptChecked = $('#remainingHandlingBalanceCheck').checked;

    let billPayments = [];
    if(billChecked){
      const billerInputs = Array.from($('#comboBillerAmounts').querySelectorAll('.combo-biller-amount'));
      billPayments = billerInputs.map(inp=>{
        const raw = (inp.value || '').replace(/,/g,'');
        const n = parseFloat(raw);
        const amt = (raw === '' || isNaN(n)) ? 0 : Math.max(n, 0);
        return { biller: inp.dataset.biller, amount: amt };
      });
    }
    const billTotal = billPayments.reduce((a,b)=>a+b.amount, 0);

    function amtFor(checked, inputId){
      if(!checked) return 0;
      const raw = ($(inputId).value || '').replace(/,/g,'');
      if(raw === '') return 0;
      const n = parseFloat(raw);
      return isNaN(n) ? 0 : Math.max(n, 0);
    }
    const given = amtFor(custChecked, '#cashGivenAmount');
    const kept = keptChecked ? +Math.max(remaining - billTotal - given, 0).toFixed(2) : 0;
    return {
      billChecked, custChecked, keptChecked,
      bill: billTotal, billPayments,
      given,
      kept
    };
  }

  // Writes the same text/state to both "Remaining" boxes — the one above the checkboxes
  // and the duplicate lower down near the total, so the person doesn't have to scroll
  // back up while filling in bill/cash/kept amounts.
  function setRunningTotal(text, cls){
    [['#runningTotalBox','#runningTotalVal'], ['#runningTotalBox2','#runningTotalVal2']].forEach(([boxSel, valSel])=>{
      const box = $(boxSel), val = $(valSel);
      box.classList.remove('over','exact');
      if(cls) box.classList.add(cls);
      val.textContent = text;
    });
  }

  function updateRemainingHandlingUI(remaining){
    const { billChecked, custChecked, keptChecked, bill, given, kept } = getRemainingLegAmounts(remaining);

    // Once bill payment + cash given already cover the whole remaining on their own,
    // "kept as service fee" has nothing left to add — hide that option entirely (and
    // uncheck it if it was sitting there checked-but-empty), since it wouldn't do anything.
    const nonKeptAllocated = +(bill + given).toFixed(2);
    const keptNoLongerNeeded = nonKeptAllocated >= remaining && remaining > 0;
    if(keptNoLongerNeeded && keptChecked){
      $('#remainingHandlingBalanceCheck').checked = false;
    }
    $('#keptFeeCategoryBox').style.display = keptNoLongerNeeded ? 'none' : '';
    const keptStillChecked = $('#remainingHandlingBalanceCheck').checked;
    const keptAmount = keptStillChecked ? kept : 0;

    $('#billPaymentAmountWrap').style.display = billChecked ? 'block' : 'none';
    $('#cashGivenAmountWrap').style.display = custChecked ? 'block' : 'none';

    $('#remainingHandlingBillLabel').textContent = billChecked && bill > 0 ? `Paid ${fmt(bill)} bill` : 'Paid a bill';
    $('#remainingHandlingCustomerLabel').textContent = custChecked && given > 0 ? `Gave ${fmt(given)} cash to customer` : 'Gave cash to customer';
    $('#remainingHandlingBalanceLabel').textContent = keptStillChecked && keptAmount > 0 ? `Kept ${fmt(keptAmount)} as service fee/charge` : 'Kept as service fee/charge';

    // Hide the main Service Fee field while "Kept as service fee/charge" is checked, since
    // that box is standing in for it — it reappears the moment that's unchecked (or
    // auto-hidden above). When adding, the kept amount is used as the fee charged.
    $('#customerFeeFieldWrap').style.display = keptStillChecked ? 'none' : '';

    // Drive the same "Remaining" box shown above the checkboxes — it now reflects what's
    // still unallocated after whatever's been split into bill/cash/kept, instead of a
    // second, separate indicator. Ticking nothing yet leaves it showing the full amount;
    // it counts down to ₦0 as the three amounts add up to it.
    const allocated = bill + given + keptAmount;
    const unallocated = +(remaining - allocated).toFixed(2);
    if(unallocated < 0){
      setRunningTotal('-' + fmt(Math.abs(unallocated)) + ' over', 'over');
    } else if(unallocated === 0 && (billChecked || custChecked || keptChecked)){
      setRunningTotal('₦0 — fully allocated', 'exact');
    } else {
      setRunningTotal(fmt(unallocated));
    }
  }

  // On a computer the Log a Transaction card keeps the height of the Withdrawal form; longer
  // forms (Withdraw+Transfer) scroll inside it. Phones are left as they are.
  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  function sizeEntryBody(){
    const body = $('#entryBody');
    if(body) body.classList.toggle('is-combo', state.type === 'WithdrawTransfer');
    if(!body || !desktopQuery.matches || state.type !== 'Withdrawal' || $('#status').textContent) return;
    const h = body.scrollHeight;
    if(h > 200) document.documentElement.style.setProperty('--entry-body-h', h + 'px');
  }
  desktopQuery.addEventListener('change', ()=> requestAnimationFrame(sizeEntryBody));
  // Keep the Log a Transaction card's height available to the cards beside it.
  if('ResizeObserver' in window){
    new ResizeObserver(entries=>{
      const h = entries[0].target.offsetHeight; // layout height, unaffected by the Aa size
      if(h > 200) document.documentElement.style.setProperty('--entry-card-h', h + 'px');
    }).observe($('#entryCard'));
  }
  window.addEventListener('resize', ()=> requestAnimationFrame(sizeEntryBody));

  function refreshAuto(){
    requestAnimationFrame(sizeEntryBody);
    const isBill = state.type === 'Bill';
    const isCombo = state.type === 'WithdrawTransfer';
    const isWithdrawal = state.type === 'Withdrawal';
    $('#billerSeg').style.display = isBill ? 'flex' : 'none';
    $('#comboHint').style.display = isCombo ? 'block' : 'none';
    $('#amountLabel').textContent = isBill ? 'Bill amount paid (₦)' : (isCombo ? 'Amount Withdrawn (₦)' : (isWithdrawal ? 'AMT Withdrawn (₦)' : 'Amount Sent (₦)'));
    updateLayoutForType(isCombo);

    $('#overrideFeeRow').style.display = isBill ? 'none' : 'flex';
    if(isBill) $('#overrideFee').checked = false;
    $('#overrideFeeLabel').textContent = isCombo ? 'all transfers same bank (rare)' : (isWithdrawal ? 'override fee (free withdrawal)' : 'override fee (same bank transfer)');

    const override = $('#overrideFee').checked;
    const amount = numVal('#amount');

    let bd;
    if(isCombo){
      const legs = getTransferLegs();
      const cash = numVal('#cashAmount');
      const pool = amount + cash;
      const sum = legs.reduce((a,l)=>a+l.amount, 0);
      const remaining = pool - sum;

      const legAmounts = getRemainingLegAmounts(Math.max(remaining, 0));
      const billLegs = (remaining > 0 && legAmounts.billChecked) ? legAmounts.billPayments.filter(b=>b.amount > 0) : [];
      bd = computeComboBreakdown(state.provider, amount, legs, billLegs);

      if(pool === 0 && sum === 0){
        setRunningTotal('₦0');
      } else if(remaining < 0){
        setRunningTotal('-' + fmt(Math.abs(remaining)) + ' over', 'over');
      } else if(remaining === 0){
        setRunningTotal('₦0 — fully allocated', 'exact');
      } else {
        setRunningTotal(fmt(remaining));
      }
      const showRemainingToggle = remaining > 0;
      $('#remainingHandlingGroup').style.display = showRemainingToggle ? 'block' : 'none';
      $('#runningTotalWrap2').style.display = showRemainingToggle ? 'block' : 'none';
      if(showRemainingToggle){
        updateRemainingHandlingUI(remaining);
      } else {
        $('#customerFeeFieldWrap').style.display = '';
      }
    } else {
      const manualBase = override ? 0 : null;
      bd = computeBreakdown(state.provider, state.type, amount, manualBase);
    }

    $('#machineTotal').textContent = fmt(bd.total);
    let breakdownText;
    if(bd.transferAmounts !== undefined){
      const n = bd.transferAmounts.length;
      breakdownText = `withdrawal fee ${fmt(bd.withdrawalBase)} + ${n} transfer fee${n===1?'':'s'} ${fmt(bd.transferBaseTotal)}`;
      if(bd.billFeeAmt > 0) breakdownText += ` + bill fee ${fmt(bd.billFeeAmt)}`;
      breakdownText += ` · VAT ${fmt(bd.vat)} · stamp duty ${fmt(bd.stamp)}`;
    } else if(bd.withdrawalBase !== undefined){
      breakdownText = `withdrawal fee ${fmt(bd.withdrawalBase)} + transfer fee ${fmt(bd.transferBase)} · VAT ${fmt(bd.vat)} · stamp duty ${fmt(bd.stamp)}`;
    } else {
      breakdownText = `fee ${fmt(bd.base)} · VAT ${fmt(bd.vat)} · stamp duty ${fmt(bd.stamp)}`;
    }
    if(bd.autosave > 0) breakdownText += ` · autosave ${fmt(bd.autosave)}`;
    $('#machineBreakdown').textContent = breakdownText;
    renderMoniepointFeeTable();
  }

  // Transactions now live in Firebase. Whatever this phone saved locally before the switch
  // is kept untouched as `legacyTransactions`, so the owner can upload it once.
  let legacyTransactions = [];
  let importDone = false;

  function applyParsedSettings(parsed){
    const defaultRates = settings.rates; // capture fresh defaults before they get overwritten below
    const defaultCustomerFees = settings.customerFees;
    const defaultCombo = settings.customerFeesCombo;
    settings = Object.assign({}, settings, parsed);
    settings.rates = {
      Moniepoint: Object.assign({}, defaultRates.Moniepoint, (parsed.rates && parsed.rates.Moniepoint) || {}),
      Opay: Object.assign({}, defaultRates.Opay, (parsed.rates && parsed.rates.Opay) || {})
    };
    settings.customerFees = Object.assign({}, defaultCustomerFees, parsed.customerFees || {});
    settings.customerFeesCombo = Object.assign({}, defaultCombo, parsed.customerFeesCombo || {});
    if(parsed.vatEnabled === false){
      settings.rates.Moniepoint.vatRate = 0;
      settings.rates.Opay.vatRate = 0;
    }
    if(parsed.stampEnabled === false){
      settings.stampFlat = 0;
    }
    delete settings.vatEnabled;
    delete settings.stampEnabled;
  }

  function populateSettingsUI(){
    const setFmt = (sel, val) => { $(sel).value = (val || val === 0) ? Number(val).toLocaleString('en-US') : ''; };
    $('#mp_pct').value = settings.rates.Moniepoint.pct;
    setFmt('#mp_flat', settings.rates.Moniepoint.flat);
    setFmt('#mp_threshold', settings.rates.Moniepoint.threshold);
    setFmt('#mp_transfer', settings.rates.Moniepoint.transfer);
    $('#mp_vatRate').value = settings.rates.Moniepoint.vatRate;
    $('#op_pct').value = settings.rates.Opay.pct;
    setFmt('#op_flat', settings.rates.Opay.flat);
    setFmt('#op_threshold', settings.rates.Opay.threshold);
    setFmt('#op_transfer', settings.rates.Opay.transfer);
    $('#op_vatRate').value = settings.rates.Opay.vatRate;
    setFmt('#stampFlat', settings.stampFlat);
    setFmt('#stampThreshold', settings.stampThreshold);
    setFmt('#billFee', settings.billFee);
    setFmt('#bettingFee', settings.bettingFee);
    $('#autosaveEnabled').checked = !!settings.autosaveEnabled;
    setFmt('#autosaveFlat', settings.autosaveFlat);
    $('#stampOnWithdrawal').checked = !!settings.stampOnWithdrawal;
    renderServiceFeeInputs();
    renderComboFeeInputs();
    renderServiceFeeReference();
    renderSafetyTipsEditor();
    renderSafetyTipsDisplay();
  }

  async function loadData(){
    try{
      const t = await store.get('transactions');
      const parsed = t && t.value ? JSON.parse(t.value) : [];
      legacyTransactions = Array.isArray(parsed) ? parsed : [];
    }catch(e){ legacyTransactions = []; }
    try{
      const imp = await store.get('cloudImported');
      importDone = !!(imp && imp.value === '1');
    }catch(e){}
    populateSettingsUI();
    refreshAuto();
    render();
    renderImportUI();
  }

  async function saveSettings(){
    const json = JSON.stringify(settings);
    try{ await store.set(settingsCacheKey(), json); }catch(e){}
    // Only the owner's changes reach the shared settings; Firebase rejects anyone else's.
    // Not awaited: offline, the write waits in the queue and uploads on reconnect.
    if(fb && role === 'owner'){
      fb.setDoc(bdoc('settings', 'shop'), { json, updatedAt: fb.serverTimestamp() })
        .catch(err => setStatus('Settings not saved online: ' + err.message, 'error'));
    }
  }

  function applyProviderTheme(provider){
    const root = document.documentElement.style;
    const isDay = document.documentElement.getAttribute('data-theme') === 'day';
    if(provider === 'Opay'){
      root.setProperty('--theme', '#17C4A0');
      root.setProperty('--theme-soft', isDay ? '#0D8F73' : '#5FE3C4');
      root.setProperty('--theme-tint', isDay ? 'rgba(23,196,160,0.10)' : 'rgba(23,196,160,0.13)');
      root.setProperty('--theme-text', '#ffffff');
    } else {
      root.setProperty('--theme', '#3B7CFF');
      root.setProperty('--theme-soft', isDay ? '#1D4ED8' : '#83ABFF');
      root.setProperty('--theme-tint', isDay ? 'rgba(59,124,255,0.10)' : 'rgba(59,124,255,0.13)');
      root.setProperty('--theme-text', '#ffffff');
    }
    $('#entryCard').setAttribute('data-provider', provider);
    const avatar = $('#providerAvatar');
    if(provider === 'Opay'){
      avatar.className = 'provider-avatar ring';
      avatar.innerHTML = '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="21" cy="20" r="13" fill="none" stroke="#17C4A0" stroke-width="7"/><rect x="0" y="16.5" width="10" height="7" fill="#241463"/></svg>';
    } else {
      avatar.className = 'provider-avatar letter';
      avatar.textContent = 'M';
    }
  }

  function wireSegment(id, key){
    const seg = document.getElementById(id);
    seg.querySelectorAll('button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        seg.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const prevType = state[key];
        state[key] = btn.dataset.val;
        if(key === 'provider') applyProviderTheme(state.provider);
        if(key === 'type'){
          $('#overrideFee').checked = false;
          if(btn.dataset.val === 'WithdrawTransfer' && prevType !== 'WithdrawTransfer'){
            resetTransferBoxes();
          }
        }
        refreshAuto();
      });
    });
  }
  ['#amount','#customerFee','#mp_flat','#mp_threshold','#mp_transfer','#op_flat','#op_threshold','#op_transfer','#stampFlat','#stampThreshold','#billFee','#bettingFee','#autosaveFlat'].forEach(sel=>{
    attachCommaFormatting($(sel));
  });
  resetTransferBoxes();
  attachCommaFormatting($('#cashAmount'));
  $('#addTransferBtn').addEventListener('click', ()=>{
    addTransferBox(true);
    addTransferBox(true);
    refreshAuto();
  });
  $('#addCashBtn').addEventListener('click', ()=>{
    $('#cashField').style.display = 'block';
    $('#addCashBtn').style.display = 'none';
    $('#runningTotalWrap').style.gridColumn = 'auto';
    refreshAuto();
  });
  $('#cashRemoveBtn').addEventListener('click', ()=>{
    hideCashField();
    refreshAuto();
  });
  $('#cashAmount').addEventListener('input', refreshAuto);
  $('#remainingHandlingCustomerCheck').addEventListener('change', ()=>{
    $('#cashGivenAmount').value = '';
    refreshAuto();
  });
  $('#remainingHandlingBillCheck').addEventListener('change', ()=>{
    if(!$('#remainingHandlingBillCheck').checked){
      selectedCombosBillers.clear();
      $('#comboBillerSeg').querySelectorAll('button').forEach(b=>b.classList.remove('active'));
      $('#comboBillerAmounts').innerHTML = '';
    }
    refreshAuto();
  });
  $('#remainingHandlingBalanceCheck').addEventListener('change', refreshAuto);
  attachCommaFormatting($('#cashGivenAmount'));
  $('#cashGivenAmount').addEventListener('input', refreshAuto);

  wireSegment('providerSeg','provider');
  wireSegment('typeSeg','type');
  wireSegment('billerSeg','biller');
  $('#comboBillerSeg').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = btn.dataset.val;
      if(selectedCombosBillers.has(val)){
        selectedCombosBillers.delete(val);
        btn.classList.remove('active');
      } else {
        selectedCombosBillers.add(val);
        btn.classList.add('active');
      }
      renderComboBillerAmounts();
      refreshAuto();
    });
  });
  applyProviderTheme(state.provider);

  $('#amount').addEventListener('input', refreshAuto);
  $('#overrideFee').addEventListener('change', ()=>{
    if(state.type === 'WithdrawTransfer'){
      const checked = $('#overrideFee').checked;
      $('#transferAmountsGrid').querySelectorAll('.samebank-check').forEach(c => { c.checked = checked; });
    }
    refreshAuto();
  });

  function toDateInputValue(d){
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  $('#periodTabs').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $('#periodTabs').querySelectorAll('button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.period = btn.dataset.val;
      if(state.period === 'custom'){
        $('#customDateWrap').style.display = 'block';
        if(!state.customStart && !state.customEnd){
          const today = new Date();
          const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
          state.customStart = toDateInputValue(weekAgo);
          state.customEnd = toDateInputValue(today);
        }
        $('#customStartDate').value = state.customStart || '';
        $('#customEndDate').value = state.customEnd || '';
      } else {
        $('#customDateWrap').style.display = 'none';
      }
      render();
    });
  });
  // Custom dates take effect as soon as they're picked (iPhones only report the new date when
  // the picker closes, so both "input" and "change" are listened to); Apply does the same and
  // confirms what's being shown. A start date after the end date is swapped round.
  function applyCustomDates(confirm){
    let start = $('#customStartDate').value || null;
    let end = $('#customEndDate').value || null;
    const st = $('#customDateStatus');
    if(start && end && start > end){
      [start, end] = [end, start];
      $('#customStartDate').value = start; $('#customEndDate').value = end;
    }
    const changed = start !== state.customStart || end !== state.customEnd;
    state.customStart = start; state.customEnd = end;
    if(state.period !== 'custom') return;
    if(changed || confirm) render();
    if(confirm || changed){
      const n = getFiltered().length;
      st.className = 'status deepgreen';
      st.textContent = `Showing ${customRangeLabel()} · ${n} transaction${n === 1 ? '' : 's'}`;
    }
    if(confirm){
      const btn = $('#applyDateFilterBtn');
      btn.textContent = 'Applied ✓';
      clearTimeout(btn._t); btn._t = setTimeout(()=>{ btn.textContent = 'Apply Filter'; }, 1500);
    }
  }
  ['input', 'change'].forEach(ev=>{
    $('#customStartDate').addEventListener(ev, ()=> applyCustomDates(false));
    $('#customEndDate').addEventListener(ev, ()=> applyCustomDates(false));
  });
  $('#applyDateFilterBtn').addEventListener('click', ()=>{
    // Let an open date picker hand over its value first.
    if(document.activeElement && document.activeElement.type === 'date') document.activeElement.blur();
    setTimeout(()=> applyCustomDates(true), 0);
  });
  $('#providerFilter').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $('#providerFilter').querySelectorAll('button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.providerFilter = btn.dataset.val;
      render();
    });
  });

  $('#entryCard').addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    const tag = (e.target.tagName || '').toUpperCase();
    if(tag !== 'INPUT') return;
    e.preventDefault();
    e.target.blur();
    const submitIds = new Set(['amount', 'customerFee']);
    if(submitIds.has(e.target.id)) $('#addBtn').click();
  });

  $('#addBtn').addEventListener('click', async ()=>{
    const amount = numVal('#amount');
    let customerFee = numVal('#customerFee');
    const wasOverridden = $('#overrideFee').checked;
    const isCombo = state.type === 'WithdrawTransfer';
    const legs = isCombo ? getTransferLegs().filter(l => l.amount > 0) : null;
    const cashAmount = isCombo ? numVal('#cashAmount') : 0;
    const legsSumForBill = isCombo ? legs.reduce((a,l)=>a+l.amount, 0) : 0;
    const leftoverForBill = isCombo ? (amount + cashAmount) - legsSumForBill : 0;

    const legAmounts = isCombo ? getRemainingLegAmounts(Math.max(leftoverForBill, 0)) : null;
    const billLegs = (isCombo && leftoverForBill > 0 && legAmounts.billChecked) ? legAmounts.billPayments.filter(b=>b.amount > 0) : [];
    // "Kept as service fee/charge" stands in for the (hidden) Service Fee box: the amount kept
    // is what the customer was charged.
    if(isCombo && leftoverForBill > 0 && legAmounts.keptChecked) customerFee = legAmounts.kept;

    let bd;
    if(isCombo){
      bd = computeComboBreakdown(state.provider, amount, legs, billLegs);
    } else {
      const manualBase = wasOverridden ? 0 : null;
      bd = computeBreakdown(state.provider, state.type, amount, manualBase);
    }
    const { base, vat, stamp, autosave, total } = bd;

    const errors = [];
    const amountMissing = $('#amount').value.trim() === '';

    // Pre-scan the leg/leftover checks first so we know whether a "fix the amount" error
    // will already fire below — if so, skip the "enter the fee" reminder entirely rather
    // than stacking an unrelated nudge on top of a blocking error. Also skip it whenever
    // "Kept as service fee/charge" is checked — that box hides the main Service Fee field
    // and stands in for it, so an empty Service Fee field isn't actually missing anything.
    let skipFeeReminder = false;
    if(isCombo && legAmounts && legAmounts.keptChecked){
      skipFeeReminder = true;
    }
    if(!skipFeeReminder && !amountMissing && isCombo && legs && legs.length > 0){
      const legsSumPre = legs.reduce((a,l)=>a+l.amount, 0);
      const leftoverPre = (amount + cashAmount) - legsSumPre;
      const anyHandlingChecked = legAmounts.billChecked || legAmounts.custChecked || legAmounts.keptChecked;
      if(leftoverPre < 0){
        skipFeeReminder = true;
      } else if(leftoverPre > 0 && !anyHandlingChecked){
        skipFeeReminder = true;
      } else if(leftoverPre > 0 && anyHandlingChecked){
        const allocated = legAmounts.bill + legAmounts.given + legAmounts.kept;
        if(+(leftoverPre - allocated).toFixed(2) !== 0) skipFeeReminder = true;
      }
    }

    if(amountMissing){
      const label = isCombo ? 'Enter amount withdrawn.' : 'Enter amount withdrawn/sent.';
      errors.push({ msg: label, cls: 'error' });
    } else if($('#customerFee').value.trim() === '' && !skipFeeReminder){
      errors.push({ msg: 'Enter the fee you charged the customer.', cls: 'deepgreen' });
    }
    if(!amountMissing && isCombo && (!legs || legs.length === 0)){
      errors.push({ msg: 'Enter at least one transfer amount.', cls: 'error' });
    }
    if(!amountMissing && isCombo && legs && legs.length > 0){
      const legsSumCheck = legs.reduce((a,l)=>a+l.amount, 0);
      const leftoverCheck = (amount + cashAmount) - legsSumCheck;
      if(leftoverCheck < 0){
        const overAmt = fmt(Math.abs(leftoverCheck));
        errors.push({ msg: `Transfers exceed available funds for this transaction by ${overAmt}. This transaction results to a LOSS of ${overAmt} after closure for the day. Kindly rectify with customer, ASAP!`, cls: 'error' });
      } else if(leftoverCheck > 0){
        const anyHandlingChecked = legAmounts.billChecked || legAmounts.custChecked || legAmounts.keptChecked;
        const allocated = legAmounts.bill + legAmounts.given + legAmounts.kept;
        const unallocated = +(leftoverCheck - allocated).toFixed(2);
        if(!anyHandlingChecked){
          errors.push({ msg: `Select if ${fmt(leftoverCheck)} was given as cash to customer, paid as a bill payment, or kept as service fee/charge.`, cls: 'error' });
        } else if(unallocated < 0){
          errors.push({ msg: `The amounts entered exceed the ${fmt(leftoverCheck)} remaining by ${fmt(Math.abs(unallocated))}. Rectify the amounts before adding or carrying out transaction.`, cls: 'error' });
        } else if(unallocated > 0){
          errors.push({ msg: `${fmt(unallocated)} is still unallocated. kindly allocate it.`, cls: 'error' });
        }
      }
    }
    if(errors.length > 0){
      setStatusLines(errors);
      return;
    }

    const netProfit = customerFee - total;
    const allLegsSameBank = isCombo && legs.length > 0 && legs.every(l => l.sameBank);
    const legsSum = isCombo ? legs.reduce((a,l)=>a+l.amount, 0) : 0;
    const leftover = isCombo ? (amount + cashAmount) - legsSum : 0;
    const cashGivenAmount = (isCombo && leftover > 0 && legAmounts.custChecked) ? legAmounts.given : null;
    const billPayments = (isCombo && leftover > 0 && legAmounts.billChecked) ? legAmounts.billPayments.filter(b=>b.amount > 0) : [];
    const keptFeeAmount = (isCombo && leftover > 0 && legAmounts.keptChecked) ? legAmounts.kept : null;

    const tx = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
      date: new Date().toISOString(),
      provider: state.provider, type: state.type,
      biller: state.type === 'Bill' ? state.biller : null,
      amount, customerFee,
      transferAmounts: isCombo ? legs.map(l=>l.amount) : null,
      transferSameBank: isCombo ? legs.map(l=>!!l.sameBank) : null,
      cashAmount: (isCombo && cashAmount > 0) ? cashAmount : null,
      cashGivenAmount,
      billPayments,
      keptFeeAmount,
      billFeeAmt: bd.billFeeAmt || 0,
      baseFee: base, vatAmt: vat, stampAmt: stamp, autosaveAmt: autosave, providerFee: total,
      netProfit, manualFee: isCombo ? allLegsSameBank : wasOverridden
    };
    cloudAddTx(tx);

    $('#amount').value = '';
    resetTransferBoxes();
    $('#customerFee').value = '';
    $('#overrideFee').checked = false;
    refreshAuto();
    setStatus('Added ✓', 'deepgreen');
    render();
    openLogDropdown();
  });

  function wireRateField(id, provider, key){
    $(id).addEventListener('change', async ()=>{
      settings.rates[provider][key] = numVal(id);
      await saveSettings(); refreshAuto();
    });
  }
  wireRateField('#mp_pct','Moniepoint','pct');
  wireRateField('#mp_flat','Moniepoint','flat');
  wireRateField('#mp_threshold','Moniepoint','threshold');
  wireRateField('#mp_transfer','Moniepoint','transfer');
  wireRateField('#mp_vatRate','Moniepoint','vatRate');
  wireRateField('#op_pct','Opay','pct');
  wireRateField('#op_flat','Opay','flat');
  wireRateField('#op_threshold','Opay','threshold');
  wireRateField('#op_transfer','Opay','transfer');
  wireRateField('#op_vatRate','Opay','vatRate');

  $('#stampFlat').addEventListener('change', async ()=>{ settings.stampFlat = numVal('#stampFlat'); await saveSettings(); refreshAuto(); render(); });
  $('#stampThreshold').addEventListener('change', async ()=>{ settings.stampThreshold = numVal('#stampThreshold'); await saveSettings(); refreshAuto(); render(); });
  $('#billFee').addEventListener('change', async ()=>{ settings.billFee = numVal('#billFee'); await saveSettings(); refreshAuto(); render(); });
  $('#bettingFee').addEventListener('change', async ()=>{ settings.bettingFee = numVal('#bettingFee'); await saveSettings(); refreshAuto(); render(); });
  $('#autosaveEnabled').addEventListener('change', async ()=>{ settings.autosaveEnabled = $('#autosaveEnabled').checked; await saveSettings(); refreshAuto(); render(); });
  $('#autosaveFlat').addEventListener('change', async ()=>{ settings.autosaveFlat = numVal('#autosaveFlat'); await saveSettings(); refreshAuto(); render(); });
  $('#stampOnWithdrawal').addEventListener('change', async ()=>{ settings.stampOnWithdrawal = $('#stampOnWithdrawal').checked; await saveSettings(); refreshAuto(); render(); });

  const DELETE_LOCK_MINUTES = 230; // 3 hours 50 minutes — salesperson only; the Firebase rules enforce it too
  // Signing in as the owner replaces the old shared settings password, so "unlocked" now
  // just means "signed in as the owner".
  let settingsUnlocked = false;

  // On a phone, settings open full screen with a Back button; the phone's own back gesture
  // or button closes them too. On a PC they open as a dropdown with a full-screen button,
  // and Back or Esc from full screen returns to the dropdown.
  function showSettingsContent(){
    $('#settingsContent').style.display = 'block';
    checkImportUploaded(); checkLegacyLedger();
    $('#settingsToggle').classList.add('open');
    $('#settingsContent').scrollTop = 0;
    if(desktopQuery.matches) $('#settingsCard').classList.add('settings-open-inline');
    else openSettingsFull();
  }
  function openSettingsFull(){
    const card = $('#settingsCard');
    if(card.classList.contains('settings-full')) return;
    card.classList.add('settings-full');
    try{ history.pushState({ ledgerSettings: true }, ''); }catch(e){}
  }
  function closeSettingsFull(fromHistory){
    const card = $('#settingsCard');
    card.classList.remove('settings-full');
    if(fromHistory !== true && history.state && history.state.ledgerSettings){ try{ history.back(); }catch(e){} }
  }
  function hideSettingsPanels(fromHistory){
    $('#settingsContent').style.display = 'none';
    $('#settingsToggle').classList.remove('open');
    $('#settingsCard').classList.remove('settings-open-inline');
    if($('#settingsCard').classList.contains('settings-full')) closeSettingsFull(fromHistory);
  }
  // Leaving full screen: back to the dropdown when it was opened from one, else closed.
  function leaveSettingsFull(fromHistory){
    if($('#settingsCard').classList.contains('settings-open-inline')) closeSettingsFull(fromHistory);
    else hideSettingsPanels(fromHistory);
  }
  $('#settingsExpandBtn').addEventListener('click', openSettingsFull);
  window.addEventListener('popstate', ()=>{ if($('#settingsCard').classList.contains('settings-full')) leaveSettingsFull(true); });
  // Each settings section (a heading and everything under it) gets its own bordered box.
  (function groupSettingsSections(){
    const root = $('#settingsContent');
    let box = null;
    Array.from(root.children).forEach(el=>{
      const isOwnSection = el.tagName === 'DIV' && el.firstElementChild && el.firstElementChild.tagName === 'H3';
      if(el.querySelector && (el.id === 'settingsDoneBtn' || el.querySelector('#settingsDoneBtn'))){ box = null; return; }
      if(isOwnSection){ el.classList.add('settings-section'); box = null; return; }
      if(el.tagName === 'H3'){
        box = document.createElement('div');
        box.className = 'settings-section';
        root.insertBefore(box, el);
      }
      if(box) box.appendChild(el);
    });
  })();
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && $('#settingsCard').classList.contains('settings-full')){ e.preventDefault(); leaveSettingsFull(); }
  });

  function openLogDropdown(){
    $('#logContent').style.display = 'block';
    $('#logCaret').classList.add('open');
    if(logNeedsRender) renderLog();
  }
  // Filter / Summary / Reports inside Performance Overview open and close on their own; this
  // phone remembers which ones were left open.
  (function(){
    const KEY = LS_PREFIX + 'perfOpen';
    let open = {};
    try{ open = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }catch(e){}
    document.querySelectorAll('.perf-section').forEach(sec=>{
      const btn = sec.querySelector('.perf-section-toggle');
      const body = sec.querySelector('.perf-section-body');
      const set = (isOpen)=>{ body.hidden = !isOpen; sec.classList.toggle('open', isOpen); btn.setAttribute('aria-expanded', String(isOpen)); };
      set(!!open[sec.id]);
      btn.addEventListener('click', ()=>{
        const isOpen = body.hidden;
        set(isOpen);
        open[sec.id] = isOpen;
        try{ localStorage.setItem(KEY, JSON.stringify(open)); }catch(e){}
      });
    });
  })();

  $('#summaryToggle').addEventListener('click', ()=>{
    const content = $('#summaryContent');
    const caret = $('#summaryCaret');
    const isOpen = content.style.display === 'block';
    content.style.display = isOpen ? 'none' : 'block';
    caret.classList.toggle('open', !isOpen);
  });

  $('#logToggle').addEventListener('click', ()=>{
    const content = $('#logContent');
    const caret = $('#logCaret');
    const isOpen = content.style.display === 'block';
    content.style.display = isOpen ? 'none' : 'block';
    caret.classList.toggle('open', !isOpen);
    if(!isOpen && logNeedsRender) renderLog();
  });

  $('#safetyToggle').addEventListener('click', ()=>{
    const content = $('#safetyContent');
    const caret = $('#safetyCaret');
    const isOpen = content.style.display === 'block';
    content.style.display = isOpen ? 'none' : 'block';
    caret.classList.toggle('open', !isOpen);
  });


  // The calculator opens full screen (like Settings) with a Back button; the phone's own back
  // gesture or button, and Esc on a keyboard, close it too.
  const calcHome = document.createComment('calculator goes here');
  $('#calcCard').parentNode.insertBefore(calcHome, $('#calcCard'));
  function openCalculator(fromSignIn){
    const card = $('#calcCard');
    if(card.classList.contains('calc-full')) return;
    if(fromSignIn === true){
      // The app is hidden before signing in, so the calculator opens on its own, full screen.
      document.body.appendChild(card);
      card.dataset.detached = '1';
    }
    card.classList.add('calc-full');
    document.documentElement.classList.add('calc-open');
    // Full screen shows the history list open, scrolled to the latest calculations.
    if(calcHistory.length && $('#calcHistoryList').style.display === 'none') toggleCalcHistory();
    requestAnimationFrame(()=>{ $('#calcHistoryWrap').scrollTop = 0; $('#calcHistoryList').scrollTop = $('#calcHistoryList').scrollHeight; });
    $('#calcBody').style.display = 'block';
    $('#calcCaret').classList.add('open');
    $('#calcToggle').blur();
    try{ history.pushState({ ledgerCalc: true }, ''); }catch(e){}
  }
  function closeCalculator(fromHistory){
    const card = $('#calcCard');
    if(!card.classList.contains('calc-full')) return;
    card.classList.remove('calc-full');
    document.documentElement.classList.remove('calc-open');
    if(card.dataset.detached){ calcHome.parentNode.insertBefore(card, calcHome); delete card.dataset.detached; }
    // Opened from the dropdown (computer): back to the open dropdown. Otherwise closed.
    if(!card.classList.contains('calc-open-inline')){
      $('#calcBody').style.display = 'none';
      $('#calcCaret').classList.remove('open');
    }
    if(!fromHistory && history.state && history.state.ledgerCalc){ try{ history.back(); }catch(e){} }
  }
  // On a computer the calculator opens as a dropdown in its card, with a full-screen button
  // (top left of the open card); on a phone it opens straight in full screen.
  function toggleCalculatorDropdown(){
    const body = $('#calcBody');
    const isOpen = body.style.display === 'block';
    body.style.display = isOpen ? 'none' : 'block';
    $('#calcCaret').classList.toggle('open', !isOpen);
    $('#calcCard').classList.toggle('calc-open-inline', !isOpen);
    $('#calcToggle').blur();
  }
  $('#calcToggle').addEventListener('click', ()=>{
    if(desktopQuery.matches) toggleCalculatorDropdown();
    else openCalculator(false);
  });
  $('#calcExpandBtn').addEventListener('click', ()=> openCalculator(false));
  $('#authCalcBtn').addEventListener('click', ()=> openCalculator(true));
  $('#calcBackBtn').addEventListener('click', ()=> closeCalculator(false));
  window.addEventListener('popstate', ()=> closeCalculator(true));

  // Four-function calculator that shows the full expression as it's typed (e.g.
  // "10,000 ÷ 3"), plus a small live-updating result preview above it — no need to press
  // "=" to see the running answer, matching how the iOS calculator behaves. Still a plain
  // state machine (no eval()), so it's safe regardless of what gets typed. `display` stays
  // a clean, comma-free numeric string internally; commas are added only at render time.
  const CALC_OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };
  // Digits beyond ~15 can't be represented exactly by a JS number, so typing is capped
  // there; anything longer (only possible as a result) falls back to exponent notation.
  const CALC_MAX_DIGITS = 15;
  // Full-expression calculator: `tokens` holds every completed number and operator typed
  // so far (e.g. ['45','+','34','+']) and `display` holds the number currently being
  // typed. Earlier versions collapsed everything down to a running total the moment a
  // second operator was pressed, which visually erased the numbers already typed — this
  // is what made long calculations feel like "+ deletes figures." Now the whole
  // expression stays on screen the entire time; only the small preview line above it
  // shows the live running answer, computed left-to-right with no operator precedence
  // (matching an ordinary four-function calculator).
  let calcState = { tokens: [], display: '0', waitingForOperand: false, justEvaluated: false };
  let calcSaveTimer = null;
  function scheduleCalcStateSave(){
    clearTimeout(calcSaveTimer);
    calcSaveTimer = setTimeout(async ()=>{
      try{ await store.set('calcState', JSON.stringify(calcState)); }catch(e){}
    }, 250);
  }
  function calcFormatNumber(str){
    if(str === 'Error') return str;
    const neg = str.startsWith('-');
    const body = neg ? str.slice(1) : str;
    const [intPart, decPart] = body.split('.');
    if(intPart.length > CALC_MAX_DIGITS){
      const n = parseFloat(str);
      return isNaN(n) ? 'Error' : n.toExponential(4);
    }
    const formattedInt = intPart === '' ? '0' : Number(intPart).toLocaleString('en-US');
    const result = decPart !== undefined ? formattedInt + '.' + decPart : formattedInt;
    return (neg ? '-' : '') + result;
  }
  // Turns a computed number into the internal display string, rounded to 8 decimal
  // places to hide float noise (0.1 + 0.2, 1.1 %). Built from toFixed() directly rather
  // than String(Number) so tiny values stay "0.0000001" instead of "1e-7", which the
  // formatter and backspace can't handle.
  function calcNumberToString(n){
    if(Math.abs(n) >= 1e21) return String(n);
    let str = n.toFixed(8);
    if(str.indexOf('.') !== -1) str = str.replace(/0+$/, '').replace(/\.$/, '');
    return str === '-0' ? '0' : str;
  }
  function calcFormatToken(tok){
    return CALC_OP_SYMBOL[tok] ? CALC_OP_SYMBOL[tok] : calcFormatNumber(tok);
  }
  function calcCompute(a, b, op){
    switch(op){
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? null : a / b;
      default: return b;
    }
  }
  function calcEvaluateSequence(seq){
    // seq like ['45','+','34','+','90'] — plain left-to-right, no precedence, matching
    // how a basic calculator actually computes as you go.
    let acc = parseFloat(seq[0]);
    if(isNaN(acc)) return null;
    for(let i = 1; i < seq.length - 1; i += 2){
      const nextNum = parseFloat(seq[i + 1]);
      if(isNaN(nextNum)) return acc;
      const r = calcCompute(acc, nextNum, seq[i]);
      if(r === null) return null;
      acc = r;
    }
    return acc;
  }
  // Loads a past calculation back onto the board as a row of tappable number "chips" —
  // operators stay fixed, but tapping any number lets the keypad overwrite just that
  // figure. This is deliberately scoped to editing numbers only (not restructuring the
  // expression), which is all a reused calculation typically needs.
  function loadHistoryEntryForEdit(h){
    if(!h.tokens || h.tokens.length === 0) return;
    calcState = {
      tokens: [], display: '0', waitingForOperand: false, justEvaluated: false,
      editTokens: h.tokens.slice(), editIndex: null, editFresh: false
    };
    calcRenderDisplay();
  }
  function buildChipRow(tokens, selectedIndex){
    return tokens.map((tok, i)=>{
      if(CALC_OP_SYMBOL[tok]) return `<span class="calc-chip-op">${CALC_OP_SYMBOL[tok]}</span>`;
      const selected = selectedIndex === i ? ' selected' : '';
      return `<button type="button" class="calc-chip${selected}" data-idx="${i}">${calcFormatNumber(tok)}</button>`;
    }).join(' ');
  }
  function renderEditChips(){
    const disp = $('#calcDisplay');
    const preview = $('#calcPreview');
    const tokens = calcState.editTokens;
    disp.innerHTML = buildChipRow(tokens, calcState.editIndex);
    disp.querySelectorAll('.calc-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        calcState.editIndex = parseInt(chip.dataset.idx, 10);
        calcState.editFresh = true;
        calcRenderDisplay();
      });
    });
    const liveResult = calcEvaluateSequence(tokens);
    const previewText = (liveResult === null || !isFinite(liveResult)) ? '' : calcFormatNumber(calcNumberToString(liveResult));
    if(previewText === ''){ preview.innerHTML = '&nbsp;'; } else { preview.textContent = previewText; }
    sizeCalcDisplay();
    disp.scrollTop = disp.scrollHeight;
  }
  // Routes a keypad press while a history entry is loaded for editing. Only the
  // currently-selected number chip is mutated; operators commit the edit and either
  // show the result (=) or chain into a fresh expression (+ − × ÷), matching how a result
  // normally feeds into the next calculation.
  function handleEditModeKey(val){
    if(val === 'clear'){ calcClear(); return; }
    const tokens = calcState.editTokens;
    const i = calcState.editIndex;
    if(val === '='){ commitEditAndChain(); return; }
    if(val === '+' || val === '-' || val === '*' || val === '/'){
      // Keep building on the loaded expression rather than collapsing it down to the
      // total — exit chip mode into the normal token list (with any edits already made
      // preserved) and append the pressed operator, same as continuing any calculation.
      calcState = { tokens: tokens.slice(), display: '0', waitingForOperand: true, justEvaluated: false };
      calcState.tokens.push(val);
      calcRenderDisplay();
      return;
    }
    if(i === null) return;
    if(val === 'backspace'){
      let cur = tokens[i].length > 1 ? tokens[i].slice(0, -1) : '0';
      if(cur === '-') cur = '0';
      tokens[i] = cur;
      calcState.editFresh = false;
    } else if(val === '.'){
      if(calcState.editFresh){ tokens[i] = '0.'; calcState.editFresh = false; }
      else if(tokens[i].indexOf('.') === -1) tokens[i] += '.';
    } else if(val === '%'){
      const n = parseFloat(tokens[i]);
      if(!isNaN(n)) tokens[i] = calcNumberToString(n / 100);
      calcState.editFresh = false;
    } else {
      // digit
      if(calcState.editFresh){
        tokens[i] = val;
        calcState.editFresh = false;
      } else if(tokens[i].replace(/[-.]/g, '').length < CALC_MAX_DIGITS){
        tokens[i] = tokens[i] === '0' ? val : tokens[i] + val;
      }
    }
    calcRenderDisplay();
  }
  function commitEditAndChain(){
    const tokens = calcState.editTokens;
    const result = calcEvaluateSequence(tokens);
    if(result === null){
      calcState = { tokens: [], display: 'Error', waitingForOperand: true, justEvaluated: true };
      calcRenderDisplay();
      return;
    }
    if(tokens.length >= 3){
      calcHistory.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
        ts: Date.now(),
        tokens: tokens.slice(),
        expr: tokens.map(calcFormatToken).join(' '),
        result: calcFormatNumber(calcNumberToString(result))
      });
      if(calcHistory.length > 100) calcHistory = calcHistory.slice(calcHistory.length - 100);
      renderCalcHistory();
    }
    calcState = { tokens: [], display: calcNumberToString(result), waitingForOperand: true, justEvaluated: true };
    calcRenderDisplay();
  }
  // Full-screen display: the longer the sum, the smaller the figures, so a long sum fills
  // the width in a few lines instead of a tall stack of big numbers.
  function sizeCalcDisplay(){
    const disp = $('#calcDisplay');
    // Wrap the sum so it can sit at the bottom of the fixed-height display box.
    if(!(disp.childNodes.length === 1 && disp.firstChild.className === 'calc-expr')){
      const wrap = document.createElement('div');
      wrap.className = 'calc-expr';
      while(disp.firstChild) wrap.appendChild(disp.firstChild);
      disp.appendChild(wrap);
    }
    const len = disp.textContent.replace(/\s+/g, '').length;
    disp.dataset.size = len <= 10 ? 'xl' : len <= 18 ? 'l' : len <= 30 ? 'm' : len <= 48 ? 's' : 'xs';
  }
  function calcRenderDisplay(){
    scheduleCalcStateSave();
    const disp = $('#calcDisplay');
    const preview = $('#calcPreview');
    if(calcState.editTokens){
      renderEditChips();
      return;
    }
    if(calcState.display === 'Error'){
      disp.textContent = 'Error';
      preview.innerHTML = '&nbsp;';
      sizeCalcDisplay();
      return;
    }
    const tokenHtml = buildChipRow(calcState.tokens, calcState.liveEditIndex != null ? calcState.liveEditIndex : null);
    if(calcState.waitingForOperand){
      disp.innerHTML = tokenHtml || `<strong>${calcFormatNumber(calcState.display)}</strong>`;
      preview.innerHTML = '&nbsp;';
    } else {
      const currentPart = calcFormatNumber(calcState.display);
      disp.innerHTML = tokenHtml ? `${tokenHtml} <strong>${currentPart}</strong>` : `<strong>${currentPart}</strong>`;
      if(calcState.tokens.length > 0){
        const liveResult = calcEvaluateSequence(calcState.tokens.concat([calcState.display]));
        const previewText = (liveResult === null || !isFinite(liveResult)) ? '' : calcFormatNumber(calcNumberToString(liveResult));
        if(previewText === ''){ preview.innerHTML = '&nbsp;'; } else { preview.textContent = previewText; }
      } else {
        preview.innerHTML = '&nbsp;';
      }
    }
    disp.querySelectorAll('.calc-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        calcState.liveEditIndex = parseInt(chip.dataset.idx, 10);
        calcState.liveEditFresh = true;
        calcRenderDisplay();
      });
    });
    sizeCalcDisplay();
    disp.scrollTop = disp.scrollHeight;
  }
  function calcClear(){
    calcState = { tokens: [], display: '0', waitingForOperand: false, justEvaluated: false };
    calcRenderDisplay();
  }
  function calcBackspace(){
    calcState.afterPercent = false; // ⌫ after % edits the percent result
    if(calcState.liveEditIndex != null){
      const i = calcState.liveEditIndex;
      let cur = calcState.tokens[i].length > 1 ? calcState.tokens[i].slice(0, -1) : '0';
      if(cur === '-') cur = '0';
      calcState.tokens[i] = cur;
      calcState.liveEditFresh = false;
      calcRenderDisplay();
      return;
    }
    if(calcState.justEvaluated){
      // A result was just computed — let backspace edit it like any typed number instead
      // of silently doing nothing.
      calcState.justEvaluated = false;
      calcState.waitingForOperand = false;
      calcRenderDisplay();
      return;
    }
    if(calcState.waitingForOperand && calcState.tokens.length > 0){
      // An operator was pressed but no new digit typed yet — undo it and go back to
      // editing the previous number, rather than doing nothing.
      calcState.tokens.pop();
      const prevNum = calcState.tokens.pop();
      calcState.display = prevNum !== undefined ? prevNum : '0';
      calcState.waitingForOperand = false;
      calcRenderDisplay();
      return;
    }
    if(calcState.display.length > 1){
      calcState.display = calcState.display.slice(0, -1);
    } else if(calcState.tokens.length > 0){
      // Deleting the last digit of the current number leaves the pending operator in
      // place ("50 × 4" → "50 ×"); the next backspace removes the operator (handled by
      // the waitingForOperand branch above). Deleting both at once made "50 × 4, ⌫, 2"
      // come out as 502 instead of 50 × 2.
      calcState.display = '0';
      calcState.waitingForOperand = true;
    } else {
      calcState.display = '0';
    }
    if(calcState.display === '-' || calcState.display === '-0') calcState.display = '0';
    calcRenderDisplay();
  }
  function calcInputDigit(digit){
    if(calcState.liveEditIndex != null){
      const i = calcState.liveEditIndex;
      if(calcState.liveEditFresh){
        calcState.tokens[i] = digit;
        calcState.liveEditFresh = false;
      } else if(calcState.tokens[i].replace(/[-.]/g, '').length < CALC_MAX_DIGITS){
        calcState.tokens[i] = calcState.tokens[i] === '0' ? digit : calcState.tokens[i] + digit;
      }
      calcRenderDisplay();
      return;
    }
    if(calcState.justEvaluated){
      calcState.tokens = [];
      calcState.justEvaluated = false;
      calcState.display = digit;
      calcState.waitingForOperand = false;
    } else if(calcState.waitingForOperand || calcState.afterPercent){
      // A digit right after % starts a new number instead of being stuck onto the result.
      calcState.display = digit;
      calcState.waitingForOperand = false;
    } else if(calcState.display.replace(/[-.]/g, '').length < CALC_MAX_DIGITS){
      calcState.display = calcState.display === '0' ? digit : calcState.display + digit;
    }
    calcState.afterPercent = false;
    calcRenderDisplay();
  }
  function calcInputDecimal(){
    if(calcState.liveEditIndex != null){
      const i = calcState.liveEditIndex;
      if(calcState.liveEditFresh){
        calcState.tokens[i] = '0.';
        calcState.liveEditFresh = false;
      } else if(calcState.tokens[i].indexOf('.') === -1){
        calcState.tokens[i] += '.';
      }
      calcRenderDisplay();
      return;
    }
    if(calcState.justEvaluated){
      calcState.tokens = [];
      calcState.justEvaluated = false;
      calcState.display = '0.';
      calcState.waitingForOperand = false;
    } else if(calcState.waitingForOperand || calcState.afterPercent){
      calcState.display = '0.';
      calcState.waitingForOperand = false;
    } else if(calcState.display.indexOf('.') === -1){
      calcState.display += '.';
    }
    calcState.afterPercent = false;
    calcRenderDisplay();
  }
  function calcInputPercent(){
    if(calcState.liveEditIndex != null){
      const i = calcState.liveEditIndex;
      const n = parseFloat(calcState.tokens[i]);
      if(!isNaN(n)) calcState.tokens[i] = calcNumberToString(n / 100);
      calcState.liveEditFresh = false;
      calcRenderDisplay();
      return;
    }
    // iOS-style percent: after + or − it's a percentage of the running total
    // (50 + 10 % → 50 + 5 = 55, handy for adding a fee or charge); otherwise it's just
    // n ÷ 100 (50 × 10 % → 50 × 0.1 = 5). Pressing % right after an operator
    // ("50 + %") uses the previous number as the operand, and makes it visible.
    const n = parseFloat(calcState.display);
    if(isNaN(n)) return;
    const tokens = calcState.tokens;
    const pendingOp = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    let value = n / 100;
    if(pendingOp === '+' || pendingOp === '-'){
      const base = calcEvaluateSequence(tokens.slice(0, -1));
      if(base !== null) value = base * n / 100;
    }
    calcState.display = calcNumberToString(value);
    calcState.waitingForOperand = false;
    calcState.justEvaluated = false;
    calcState.afterPercent = true;
    calcRenderDisplay();
  }
  let calcHistory = [];
  async function saveCalcHistoryData(){
    try{ await store.set('calcHistory', JSON.stringify(calcHistory)); }catch(e){}
  }
  function renderCalcHistory(){
    saveCalcHistoryData();
    const wrap = $('#calcHistoryWrap');
    const list = $('#calcHistoryList');
    if(calcHistory.length === 0){
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    // Group entries under a date heading per day. Older entries saved before `ts`
    // existed still carry their timestamp at the start of `id` (Date.now() + '-...').
    // Each day is its own wrapper so its sticky heading only pins while that day's
    // entries are in view, instead of lingering over (and hiding) the next day's.
    const groups = [];
    calcHistory.forEach(h=>{
      const ts = h.ts || parseInt(h.id, 10);
      const day = isNaN(ts) ? '' : new Date(ts).toLocaleDateString('en-NG', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
      const item = `<div class="calc-history-item" data-id="${h.id}">${h.expr} <span class="calc-history-eq">= ${h.result}</span><button class="calc-history-item-clear" type="button" data-id="${h.id}">Remove</button></div>`;
      const last = groups[groups.length - 1];
      if(last && last.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
    });
    list.innerHTML = groups.map(g=>`<div class="calc-history-day"><div class="calc-history-date">${g.day}</div>${g.items.join('')}</div>`).join('');
    list.querySelectorAll('.calc-history-item-clear').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        calcHistory = calcHistory.filter(h => h.id !== btn.dataset.id);
        renderCalcHistory();
      });
    });
    list.querySelectorAll('.calc-history-item').forEach(itemEl=>{
      itemEl.addEventListener('click', ()=>{
        const h = calcHistory.find(x => x.id === itemEl.dataset.id);
        if(h) loadHistoryEntryForEdit(h);
      });
    });
    $('#calcHistoryCount').textContent = `· ${calcHistory.length}`;
    // While collapsed, still show the most recent calculation (long sums are trimmed
    // with "…" so the answer always stays visible).
    const latest = calcHistory[calcHistory.length - 1];
    $('#calcHistoryLatest').innerHTML = `<span class="calc-history-latest-expr">${latest.expr}</span><span class="calc-history-eq">= ${latest.result}</span>`;
    list.scrollTop = list.scrollHeight;
  }
  // History starts collapsed so the display and keypad get the room; tap to open it.
  function toggleCalcHistory(){
    const list = $('#calcHistoryList');
    const open = list.style.display === 'none';
    list.style.display = open ? 'block' : 'none';
    $('#calcHistoryLatest').style.display = open ? 'none' : '';
    $('#calcHistoryClear').style.display = open ? '' : 'none';
    $('#calcHistoryCaret').classList.toggle('open', open);
    if(open) list.scrollTop = list.scrollHeight;
  }
  $('#calcHistoryToggle').addEventListener('click', toggleCalcHistory);
  $('#calcHistoryLatest').addEventListener('click', toggleCalcHistory);
  $('#calcHistoryClear').addEventListener('click', ()=>{
    calcHistory = [];
    renderCalcHistory();
  });

  function calcPerformOperation(nextOperator){
    calcState.liveEditIndex = null;
    calcState.liveEditFresh = false;
    // Pressing an operator again before typing a new digit (e.g. changed your mind from
    // ÷ to ×) just swaps the pending operator — it does NOT append a duplicate.
    if(calcState.waitingForOperand && calcState.tokens.length > 0 && nextOperator !== '='){
      calcState.tokens[calcState.tokens.length - 1] = nextOperator;
      calcRenderDisplay();
      return;
    }
    calcState.afterPercent = false;
    // "5 + 3 + =": the dangling operator is dropped (= 8), rather than repeating the
    // last number (which gave 11).
    if(nextOperator === '=' && calcState.waitingForOperand && calcState.tokens.length > 0 && CALC_OP_SYMBOL[calcState.tokens[calcState.tokens.length - 1]]){
      calcState.tokens.pop();
    } else {
      calcState.tokens.push(calcState.display);
    }

    if(nextOperator === '='){
      const seq = calcState.tokens;
      const result = calcEvaluateSequence(seq);
      if(result === null){
        calcState.display = 'Error';
        calcState.tokens = [];
        calcState.waitingForOperand = true;
        calcState.justEvaluated = true;
        calcRenderDisplay();
        return;
      }
      if(seq.length >= 3){
        calcHistory.push({
          id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
          ts: Date.now(),
          tokens: seq.slice(),
          expr: seq.map(calcFormatToken).join(' '),
          result: calcFormatNumber(calcNumberToString(result))
        });
        if(calcHistory.length > 100) calcHistory = calcHistory.slice(calcHistory.length - 100);
        renderCalcHistory();
      }
      calcState.tokens = [];
      calcState.display = calcNumberToString(result);
      calcState.waitingForOperand = true;
      calcState.justEvaluated = true;
    } else {
      calcState.tokens.push(nextOperator);
      calcState.waitingForOperand = true;
      calcState.justEvaluated = false;
    }
    calcRenderDisplay();
  }
  function handleCalcInput(val){
    if(calcState.editTokens){ handleEditModeKey(val); return; }
    if(calcState.display === 'Error' && val !== 'clear'){ calcClear(); }
    if(val === 'clear') calcClear();
    else if(val === 'backspace') calcBackspace();
    else if(val === '.') calcInputDecimal();
    else if(val === '%') calcInputPercent();
    else if(val === '+' || val === '-' || val === '*' || val === '/' || val === '=') calcPerformOperation(val);
    else calcInputDigit(val);
  }
  $('#calcCard').querySelectorAll('.calc-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      handleCalcInput(btn.dataset.calc);
    });
  });
  const CALC_KEY_MAP = {
    '0':'0','1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
    '.':'.', ',':'.', '%':'%',
    '+':'+', '-':'-', '*':'*', 'x':'*', 'X':'*', '/':'/',
    'Enter':'=', '=':'=',
    'Backspace':'backspace',
    'c':'clear', 'C':'clear', 'Delete':'clear'
  };
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && $('#calcCard').classList.contains('calc-full')){ e.preventDefault(); closeCalculator(false); return; }
    const calcVal = CALC_KEY_MAP[e.key];
    if(calcVal === undefined) return;
    const body = $('#calcBody');
    if(!body || body.style.display === 'none') return;
    const target = e.target;
    const tag = target && target.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
    e.preventDefault();
    handleCalcInput(calcVal);
  });

  $('#addTipBtn').addEventListener('click', async ()=>{
    settings.safetyTips.push('');
    await saveSettings();
    renderSafetyTipsEditor();
    renderSafetyTipsDisplay();
    const rows = $('#safetyTipsEditor').querySelectorAll('.tip-textarea');
    if(rows.length) rows[rows.length - 1].focus();
  });

  $('#mpFeeTableToggle').addEventListener('click', ()=>{
    const table = $('#mpFeeTable');
    const caret = $('#mpFeeTableCaret');
    const isOpen = table.style.display === 'block';
    table.style.display = isOpen ? 'none' : 'block';
    caret.classList.toggle('open', !isOpen);
  });

  $('#settingsToggle').addEventListener('click', ()=>{
    if($('#settingsContent').style.display === 'block'){ hideSettingsPanels(); return; }
    if(settingsUnlocked) showSettingsContent();
  });

  function armTapTwice(btn, idleLabel, armedLabel, onConfirm){
    const now = Date.now();
    if(btn._lastTap && now - btn._lastTap < 350) return; // ignore mobile ghost double-fire
    btn._lastTap = now;

    if(btn.dataset.armed === '1'){
      btn.dataset.armed = '0';
      btn.textContent = idleLabel;
      btn.classList.remove('armed');
      clearTimeout(btn._armTimer);
      onConfirm();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = armedLabel;
    btn.classList.add('armed');
    clearTimeout(btn._armTimer);
    btn._armTimer = setTimeout(()=>{
      btn.dataset.armed = '0';
      btn.textContent = idleLabel;
      btn.classList.remove('armed');
    }, 3000);
  }

  $('#settingsDoneBtn').addEventListener('click', ()=>{
    hideSettingsPanels();
  });
  $('#settingsBackBtn').addEventListener('click', ()=> leaveSettingsFull());

  $('#clearLogBtn').addEventListener('click', ()=>{
    const visible = getTodayLogEntries();
    if(visible.length === 0){ setStatus('Nothing to clear'); return; }
    armTapTwice($('#clearLogBtn'), 'Clear', `Clear ${visible.length}?`, ()=>{
      cloudSoftDelete(visible.map(t=>t.id));
    });
  });

  function deleteTx(id){
    cloudSoftDelete([id]);
  }
  // Deleting takes two taps, for owners and staff alike: the first turns the link into
  // "tap again to delete" for 3 seconds, the second deletes. Remembered by entry (not by
  // button), so a log refresh between the two taps doesn't lose the first one.
  const DELETE_CONFIRM_MS = 3000;
  let armedDelete = { id: null, at: 0 };
  const isDeleteArmed = id => armedDelete.id === String(id) && Date.now() - armedDelete.at < DELETE_CONFIRM_MS;
  function tapDelete(btn){
    const id = btn.dataset.id, now = Date.now();
    if(isDeleteArmed(id)){
      if(now - armedDelete.at < 350) return; // ignore a phone's ghost double-tap
      armedDelete = { id: null, at: 0 };
      deleteTx(id);
      return;
    }
    armedDelete = { id: String(id), at: now };
    document.querySelectorAll('#logList .del.armed').forEach(b=>{ b.classList.remove('armed'); b.textContent = 'delete'; });
    btn.classList.add('armed'); btn.textContent = 'tap again to delete';
    setTimeout(()=>{
      if(isDeleteArmed(id)) return;
      const b = document.querySelector(`#logList .del[data-id="${CSS.escape(String(id))}"]`);
      if(b && b.classList.contains('armed')){ b.classList.remove('armed'); b.textContent = 'delete'; }
    }, DELETE_CONFIRM_MS + 50);
  }

  function ordinal(n){
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function providerDisplay(p){ return p === 'Opay' ? 'OPay' : p; }

  function typeLabel(t){
    if(t.type === 'Bill') return 'Bill · ' + t.biller;
    if(t.type === 'WithdrawTransfer'){
      if(t.manualFee) return `${providerDisplay(t.provider)} - ${providerDisplay(t.provider)} Transfer`;
      return 'Withdraw+Transfer';
    }
    if(t.type === 'Transfer' && t.manualFee) return `${providerDisplay(t.provider)} - ${providerDisplay(t.provider)} Transfer`;
    return t.type;
  }

  function sameBankSubLabel(t){
    if(t.type !== 'WithdrawTransfer' || !Array.isArray(t.transferSameBank)) return '';
    const count = t.transferSameBank.filter(Boolean).length;
    if(count === 0 || count === t.transferSameBank.length) return '';
    return `${count} ${providerDisplay(t.provider)} - ${providerDisplay(t.provider)} Transfer${count === 1 ? '' : 's'}`;
  }

  function comboAmountLine(t, useFmt, wrap){
    const rawFmt = useFmt || fmt;
    const f = wrap ? (n) => `<span class="fig">${rawFmt(n)}</span>` : rawFmt;
    // On screen, money in (withdrawn) is green and money out (sent, or paid for a bill) is red.
    const tint = (cls, text) => wrap ? `<span class="${cls}">${text}</span>` : text;
    if(t.type !== 'WithdrawTransfer'){
      const phrase = (t.type === 'Bill' ? 'paid' : 'amount') + ' ' + f(t.amount);
      return t.type === 'Withdrawal' ? tint('flow-in', phrase) : (t.type === 'Transfer' || t.type === 'Bill') ? tint('flow-out', phrase) : phrase;
    }
    if(Array.isArray(t.transferAmounts) && t.transferAmounts.length > 0){
      const sentTotal = t.transferAmounts.reduce((a,b)=>a+b, 0);
      const cash = t.cashAmount || 0;
      const pool = t.amount + cash;
      const leftover = pool - sentTotal;
      const cashPart = cash > 0 ? ` + ${f(cash)} cash brought in` : '';
      const leftoverPart = (() => {
        if(leftover <= 0) return '';
        const given = t.cashGivenAmount || 0;
        const billPayments = Array.isArray(t.billPayments) ? t.billPayments : [];
        const paidBillTotal = billPayments.reduce((a,b)=>a+(b.amount||0), 0);
        const keptExplicit = t.keptFeeAmount || 0;
        const kept = keptExplicit > 0 ? keptExplicit : +(leftover - given - paidBillTotal).toFixed(2);
        const phrases = [];
        if(given > 0) phrases.push(`gave ${f(given)} cash to customer`);
        billPayments.forEach(b=>{
          if(b.amount > 0) phrases.push(`paid ${f(b.amount)} ${b.biller || 'bill'} payment`);
        });
        if(kept > 0) phrases.push(`${f(kept)} kept as service fee/charge`);
        return phrases.length ? ' + ' + phrases.join(' + ') : '';
      })();
      const sameBankTag = (i) => (Array.isArray(t.transferSameBank) && t.transferSameBank[i]) ? ' same bank transfer' : '';
      if(t.transferAmounts.length === 1){
        return `${tint('flow-in', 'withdrew ' + f(t.amount))}${cashPart} + ${tint('flow-out', 'sent ' + f(t.transferAmounts[0]) + sameBankTag(0))}${leftoverPart}`;
      }
      const list = t.transferAmounts.map((a, i) => f(a) + sameBankTag(i)).join(' + ');
      return `${tint('flow-in', 'withdrew ' + f(t.amount))}${cashPart} + ${tint('flow-out', 'sent ' + list + ' (' + t.transferAmounts.length + ' transfers)')}${leftoverPart}`;
    }
    // backward compatibility with pre-multi-transfer records
    return `${tint('flow-in', 'withdrew ' + f(t.amount))} + ${tint('flow-out', 'sent ' + f(t.transferAmount != null ? t.transferAmount : t.amount))}`;
  }

  function hasLeftoverHandling(t){
    // Mirrors the leftover check inside comboAmountLine, used to decide whether the
    // ". +" connector (leftover phrase present) or the plain " ·" connector applies
    // before "charged" in both the on-screen log and the PDF export.
    if(t.type !== 'WithdrawTransfer' || !Array.isArray(t.transferAmounts) || t.transferAmounts.length === 0) return false;
    const sentTotal = t.transferAmounts.reduce((a,b)=>a+b, 0);
    const pool = t.amount + (t.cashAmount || 0);
    return (pool - sentTotal) > 0;
  }

  function dateSeparatorLabel(dateObj){
    const now = new Date();
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((startOf(now) - startOf(dateObj)) / 86400000);
    if(diffDays === 0) return 'Today';
    if(diffDays === 1) return 'Yesterday';
    const weekday = dateObj.toLocaleDateString('en-NG', { weekday: 'long' });
    const month = dateObj.toLocaleDateString('en-NG', { month: 'long' });
    return `${weekday}, ${month} ${ordinal(dateObj.getDate())}`;
  }

  const arrowUpSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
  const arrowDownSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
  const eyeOffSvg = '<svg class="lock-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.29 20.29 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.29 20.29 0 0 1-3.22 4.53"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function isInPeriod(dateStr, period){
    const d = new Date(dateStr); const now = new Date();
    if(period === 'all') return true;
    if(period === 'today') return d.toDateString() === now.toDateString();
    if(period === 'week'){
      const day = (now.getDay() + 6) % 7;
      const monday = new Date(now); monday.setHours(0,0,0,0); monday.setDate(now.getDate() - day);
      return d >= monday;
    }
    if(period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if(period === 'custom'){
      if(!state.customStart && !state.customEnd) return true;
      if(state.customStart){
        const start = new Date(state.customStart + 'T00:00:00');
        if(d < start) return false;
      }
      if(state.customEnd){
        const end = new Date(state.customEnd + 'T23:59:59');
        if(d > end) return false;
      }
      return true;
    }
    return true;
  }

  function customRangeLabel(){
    if(!state.customStart && !state.customEnd) return 'Custom (pick dates)';
    const fmtD = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' }) : '…';
    return `${fmtD(state.customStart)} – ${fmtD(state.customEnd)}`;
  }

  function matchesLoggedBy(t){
    // A salesperson's totals, volume and reports cover only their own entries (their
    // Transaction Log still shows everyone's; see getFilteredForLog).
    if(role === 'staff') return !!currentUser && t.loggedBy === currentUser.uid;
    return state.loggedByFilter === 'All' || t.loggedBy === state.loggedByFilter;
  }

  function getFiltered(){
    // Deleted entries never count towards totals or the PDF.
    return transactions.filter(t=>{
      const periodOk = isInPeriod(t.date, state.period);
      const provOk = state.providerFilter === 'All' || t.provider === state.providerFilter;
      return periodOk && provOk && matchesLoggedBy(t) && !t.deleted;
    });
  }

  // The owner sees a deleted entry (struck through, with Restore) for this long after it was
  // deleted; then it leaves the log. It stays in the database and in the full backup.
  const DELETED_VISIBLE_MS = 2 * 60 * 60 * 1000;
  function deletedStillShown(t){ return !!t.deletedAtMs && Date.now() - t.deletedAtMs < DELETED_VISIBLE_MS; }
  // Refresh the log when a deleted entry's two hours have run out since the log was last
  // drawn. Checked every minute and whenever the app comes back to the screen (a phone
  // pauses the app in the background, so a timer alone can miss the moment).
  var logRenderedAt = 0; // var: renderLog may run before this line is reached
  function dropExpiredDeleted(){
    if(role !== 'owner') return;
    const now = Date.now();
    const expiredSinceRender = t => t.deleted && t.deletedAtMs && now - t.deletedAtMs >= DELETED_VISIBLE_MS && logRenderedAt - t.deletedAtMs < DELETED_VISIBLE_MS;
    if(!transactions.some(expiredSinceRender)) return;
    if($('#logContent').style.display === 'block') renderLog(); else logNeedsRender = true;
  }
  setInterval(dropExpiredDeleted, 60000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) dropExpiredDeleted(); });
  window.addEventListener('focus', dropExpiredDeleted);
  function getFilteredForLog(){
    // Transaction Log now respects the same period/date filter as Performance Overview,
    // in addition to the provider filter, so the two sections stay in sync.
    // The owner still sees deleted entries (struck through, with who deleted them).
    return transactions.filter(t=>{
      const periodOk = isInPeriod(t.date, state.period);
      const provOk = state.providerFilter === 'All' || t.provider === state.providerFilter;
      // A salesperson's log shows everyone's entries; their reports stay their own.
      return periodOk && provOk && (role === 'staff' || matchesLoggedBy(t)) && (!t.deleted || (role === 'owner' && deletedStillShown(t)));
    });
  }

  function getTodayLogEntries(){
    // Clear is always scoped to today only, regardless of any period filter set elsewhere
    // in the app (e.g. Performance Overview) — it should never reach into previous days.
    // It also respects the same delete-lock window as individual entries, so it can't be
    // used to bulk-bypass that protection. Unlike individual delete, Clear has no password
    // override — locked entries stay locked no matter what.
    return transactions.filter(t=>{
      const todayOk = isInPeriod(t.date, 'today');
      const provOk = state.providerFilter === 'All' || t.provider === state.providerFilter;
      const loggedMs = t.createdAtMs || new Date(t.date).getTime();
      const unlocked = role === 'owner' || (t.loggedBy === currentUser.uid && (Date.now() - loggedMs) / 60000 <= DELETE_LOCK_MINUTES);
      return todayOk && provOk && matchesLoggedBy(t) && !t.deleted && unlocked;
    });
  }

  function renderVolumeAnalysis(){
    const inEl = $('#trendMoneyIn');
    const outEl = $('#trendMoneyOut');
    const emptyEl = $('#volumeEmptyState');
    const contentEl = $('#volumeContent');
    if(!inEl || !outEl || !emptyEl || !contentEl) return;

    if(transactions.length === 0){
      emptyEl.style.display = 'block';
      contentEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Follows the Filter above (dates, provider and who logged it), like Summary.
    const inRange = getFiltered();
    let moneyIn = 0, moneyOut = 0;
    inRange.forEach(t=>{
      const amt = t.amount || 0;
      if(t.type === 'Withdrawal') moneyIn += amt;
      else if(t.type === 'Transfer' || t.type === 'Bill') moneyOut += amt;
      else if(t.type === 'WithdrawTransfer'){
        moneyIn += amt + (t.cashAmount || 0);
        if(Array.isArray(t.transferAmounts)) moneyOut += t.transferAmounts.reduce((a,b)=>a+b, 0);
        else moneyOut += (t.transferAmount != null ? t.transferAmount : amt);
      }
    });
    inEl.textContent = fmt(moneyIn);
    outEl.textContent = fmt(moneyOut);
    fitTrendAmounts();
  }
  // Shrinks an amount that is too wide for its box (e.g. hundreds of millions) so it shows
  // in full and stays centred; normal amounts keep the regular size. Re-checked whenever
  // the boxes change size or become visible.
  function fitTrendAmounts(){
    document.querySelectorAll('.trend-amt').forEach(el=>{
      el.style.fontSize = '';
      if(!el.clientWidth) return; // hidden (Filter closed): checked again when shown
      let size = parseFloat(getComputedStyle(el).fontSize);
      while(el.scrollWidth > el.clientWidth && size > 10){ size -= 0.5; el.style.fontSize = size + 'px'; }
    });
  }
  if('ResizeObserver' in window){
    const trendGrid = document.querySelector('.trend-grid');
    if(trendGrid) new ResizeObserver(()=> fitTrendAmounts()).observe(trendGrid);
  }

  function render(){
    if(fb && role && needsOlderTransactions() && olderState === 'idle') loadOlderTransactions();
    const filtered = getFiltered();
    let sumCustomer=0, sumBase=0, sumVat=0, sumStamp=0, sumAutosave=0, sumNet=0;
    filtered.forEach(t=>{
      sumCustomer += t.customerFee;
      sumBase += t.baseFee;
      sumVat += (t.vatAmt||0);
      sumStamp += (t.stampAmt||0);
      sumAutosave += (t.autosaveAmt||0);
      sumNet += t.netProfit;
    });

    renderVolumeAnalysis();

    const LOCK_HTML = `${eyeOffSvg}<span class="lock-dots">••••</span>`;
    $('#sumCustomerFee').textContent = fmt(sumCustomer);
    $('#sumBaseFee').textContent = '−' + fmt(sumBase);
    // Fee, VAT and stamp duty totals are shown to everyone; only auto-save is owner-only.
    $('#sumVat').textContent = '−' + fmt(sumVat);
    $('#sumStamp').textContent = '−' + fmt(sumStamp);
    const netEl = $('#netProfit');
    netEl.textContent = fmt(sumNet);
    netEl.classList.toggle('neg', sumNet < 0);
    // Under the Transaction Log heading: entries in the log for the current filter (deleted ones not counted).
    const logN = getFilteredForLog().filter(t => !t.deleted).length;
    $('#logCount').textContent = logN + ' transaction' + (logN===1?'':'s');
    $('#txCount').textContent = filtered.length + ' transaction' + (filtered.length===1?'':'s') + (olderState === 'loading' && needsOlderTransactions() ? ' · loading older…' : '');
    const customSt = $('#customDateStatus');
    if(state.period !== 'custom') customSt.textContent = '';
    else if(customSt.textContent) customSt.textContent = `Showing ${customRangeLabel()} · ${filtered.length} transaction${filtered.length === 1 ? '' : 's'}${olderState === 'loading' && needsOlderTransactions() ? ' · loading older…' : ''}`;
    // Auto-save is the owner's own savings, so the salesperson doesn't see the row at all.
    $('#sumAutosaveRow').style.display = (sumAutosave > 0 && settingsUnlocked) ? 'flex' : 'none';
    $('#sumAutosave').innerHTML = settingsUnlocked ? '−' + fmt(sumAutosave) : LOCK_HTML;

    // The log is the expensive part (one DOM row per transaction), so only build it while
    // it's open; opening it later rebuilds it from the latest data.
    if($('#logContent').style.display === 'block') renderLog();
    else logNeedsRender = true;
  }

  // Rows shown in the Transaction Log before "Show more" — keeps All Time fast even with
  // thousands of transactions.
  const LOG_PAGE_SIZE = 100;
  let logLimit = LOG_PAGE_SIZE;
  let logNeedsRender = true;
  let lastLogFilterKey = null;
  const logDateFormat = new Intl.DateTimeFormat('en-NG', {day:'numeric', month:'short', year:'numeric'});
  const logTimeFormat = new Intl.DateTimeFormat('en-NG', {hour:'numeric', minute:'2-digit', hour12:true});

  // These two buttons get moved into the first date row on every render (and detached
  // when the list is emptied), so hold on to them rather than looking them up each time.
  const LOG_CLEAR_BTN = $('#clearLogBtn');
  const LOG_SHARE_BTN = $('#logSharePdfBtn');

  var logObserver = null;
  function renderLog(){
    logNeedsRender = false;
    if(logObserver){ logObserver.disconnect(); logObserver = null; }
    logRenderedAt = Date.now();
    const clearBtn = LOG_CLEAR_BTN;
    const shareBtn = LOG_SHARE_BTN;
    const logList = $('#logList');
    const allLogFiltered = getFilteredForLog();
    // Changing the period/provider filter starts the list over at the first page.
    const filterKey = `${state.period}|${state.providerFilter}|${state.loggedByFilter}|${state.customStart}|${state.customEnd}`;
    if(filterKey !== lastLogFilterKey){ lastLogFilterKey = filterKey; logLimit = LOG_PAGE_SIZE; }
    const logFiltered = allLogFiltered.slice(0, logLimit);
    logList.innerHTML = '';

    if(logFiltered.length === 0){
      $('#emptyState').style.display = 'block';
      clearBtn.style.display = 'none';
      shareBtn.style.display = 'none';
    } else {
      $('#emptyState').style.display = 'none';
      let lastDayKey = null;
      let dayGroup = null;
      let firstGroup = true;
      logFiltered.forEach(t=>{
        const d = new Date(t.date);
        const dayKey = d.toDateString();
        if(dayKey !== lastDayKey){
          lastDayKey = dayKey;
          const sep = document.createElement('div');
          sep.className = 'log-date-sep';
          sep.textContent = dateSeparatorLabel(d);

          if(firstGroup){
            firstGroup = false;
            const sepRow = document.createElement('div');
            sepRow.className = 'log-date-sep-row';
            sepRow.appendChild(sep);
            // Shares the same report as Performance Overview (current period and filters).
            shareBtn.style.display = 'block';
            sepRow.appendChild(shareBtn);
            clearBtn.style.display = 'block';
            sepRow.appendChild(clearBtn);
            logList.appendChild(sepRow);
          } else {
            logList.appendChild(sep);
          }

          dayGroup = document.createElement('div');
          dayGroup.className = 'log-day-group';
          logList.appendChild(dayGroup);
        }

        const item = document.createElement('div');
        item.className = 'log-item' + (t.deleted ? ' deleted' : '');
        const dateStr = logDateFormat.format(d) + ' · ' + logTimeFormat.format(d);
        const isCombo = t.type === 'WithdrawTransfer';
        const isCredit = t.type === 'Withdrawal';
        const iconClass = isCombo ? 'combo' : (isCredit ? 'in' : 'out');
        const iconSvg = isCombo ? (arrowDownSvg + arrowUpSvg) : (isCredit ? arrowDownSvg : arrowUpSvg);
        // Everyone on the team sees each entry's profit (or loss); the cost line stays owner-only.
        const profitBlock = `<div class="profit-label">${t.netProfit<0?'loss':'profit'}</div><div class="profit ${t.netProfit<0?'neg':''}">${fmt(t.netProfit)}</div>`;
        const isSameBankTitle = (t.type === 'WithdrawTransfer' || t.type === 'Transfer') && t.manualFee;
        const providerColorClass = t.provider === 'Opay' ? 'samebank-op' : 'samebank-mp';
        const typeClass = isSameBankTitle ? providerColorClass : (t.type === 'Withdrawal' ? 'flow-in' : (t.type === 'Transfer' || t.type === 'Bill') ? 'flow-out' : '');
        const loggedMs = t.createdAtMs || d.getTime();
        const minutesSinceLogged = (Date.now() - loggedMs) / 60000;
        const ownEntry = t.loggedBy === (currentUser && currentUser.uid);
        const isDeletable = !t.deleted && (role === 'owner' || (ownEntry && minutesSinceLogged <= DELETE_LOCK_MINUTES));
        const deleteControl = t.deleted
          ? (role === 'owner' ? `<button class="restore" data-id="${t.id}">restore</button>` : '')
          : (role === 'staff' && !ownEntry) ? ''
          : isDeletable
            ? (isDeleteArmed(t.id) ? `<button class="del armed" data-id="${t.id}">tap again to delete</button>` : `<button class="del" data-id="${t.id}">delete</button>`)
            : `<span class="del-locked" title="Entries can only be deleted within 3h 50m of logging">locked</span>`;
        const bylineParts = [];
        // Records uploaded from a phone's old local history don't say who logged them;
        // everything logged since the switch does.
        if(t.loggedBy && !t.imported) bylineParts.push('<span class="byline-name">by: ' + escapeHtml(nameFor(t.loggedBy, t.loggedByName)) + (isTrainee(t.loggedBy) ? ' (TRAINEE)' : '') + '</span>');
        // Logged offline and uploaded later: show when Firebase actually received it.
        if(!t.imported && t.offline && t.createdAtMs && !t.pending) bylineParts.push('logged offline · uploaded ' + logDateFormat.format(new Date(t.createdAtMs)) + ' ' + logTimeFormat.format(new Date(t.createdAtMs)));
        // Logged online but the phone's clock disagreed with Firebase's: the time shown is
        // Firebase's; flag the difference so it's visible.
        else if(t.clockOffMs && Math.abs(t.clockOffMs) > 10 * 60000) bylineParts.push(`⚠ phone clock was ${formatGap(t.clockOffMs)} ${t.clockOffMs > 0 ? 'behind' : 'ahead'}`);
        if(t.pending) bylineParts.push('⏳ not uploaded yet');
        const byline = bylineParts.length ? `<div class="byline">${bylineParts.join(' · ')}</div>` : '';
        const deletedNote = t.deleted
          ? `<div class="deleted-note">Deleted by ${escapeHtml(nameFor(t.deletedBy))}${t.deletedAtMs ? ' · ' + logDateFormat.format(new Date(t.deletedAtMs)) + ' ' + logTimeFormat.format(new Date(t.deletedAtMs)) : ''}</div>`
          : '';
        item.innerHTML = `
          <div class="log-icon ${iconClass}">${iconSvg}</div>
          <div class="log-left">
            <span class="badge ${t.provider.toLowerCase()}">${providerDisplay(t.provider)}</span>
            <div class="type ${typeClass}">${typeLabel(t)}</div>
            ${sameBankSubLabel(t) ? `<div class="samebank-sublabel ${providerColorClass}">${sameBankSubLabel(t)}</div>` : ''}
            <div class="date">${dateStr}</div>
            ${byline}
            ${deletedNote}
            <div class="amountline">${comboAmountLine(t, null, true)}. <span style="white-space:nowrap;"><span style="color: var(--loss);">cost -${fmt(t.providerFee)}.</span> <span style="color: var(--profit);">→ charged <span class="fig">${fmt(t.customerFee)}</span>.</span></span></div>
          </div>
          <div class="log-right">
            ${profitBlock}
            ${deleteControl}
          </div>
        `;
        dayGroup.appendChild(item);
      });
      // Older entries load by themselves as you scroll near the end of the log.
      const remaining = allLogFiltered.length - logFiltered.length;
      if(remaining > 0){
        const more = document.createElement('button');
        more.className = 'log-more log-sentinel';
        more.type = 'button';
        more.textContent = `Loading ${remaining} older…`;
        const loadMore = ()=>{
          if(logObserver) logObserver.disconnect();
          const box = $('#logContent'), keep = box.scrollTop;
          logLimit += LOG_PAGE_SIZE; renderLog();
          box.scrollTop = keep; // stay where you were while the next ones appear below
        };
        more.addEventListener('click', loadMore);
        logList.appendChild(more);
        if('IntersectionObserver' in window){
          logObserver = new IntersectionObserver(entries=>{ if(entries.some(e => e.isIntersecting)) loadMore(); },
            { root: $('#logContent'), rootMargin: '0px 0px 400px 0px' });
          logObserver.observe(more);
        }
      }
      logList.querySelectorAll('.del').forEach(btn=>{
        btn.addEventListener('click', ()=> tapDelete(btn));
      });
      logList.querySelectorAll('.restore').forEach(btn=>{
        btn.addEventListener('click', ()=> cloudRestore(btn.dataset.id));
      });
    }
  }

  function buildPdfDoc(){
    if(typeof window.jspdf === 'undefined'){
      return null;
    }

    const MP_RGB = [59,124,255];
    const OP_RGB = [23,196,160];
    function providerColor(p){ return p === 'Opay' ? OP_RGB : MP_RGB; }
    function drawSegments(doc, x, y, segments){
      let cx = x;
      segments.forEach(seg=>{
        doc.setTextColor(seg.color[0], seg.color[1], seg.color[2]);
        doc.text(seg.text, cx, y);
        cx += doc.getTextWidth(seg.text);
      });
      return cx;
    }
    function colorizeLabel(label, baseColor){
      const segments = [];
      const regex = /(Moniepoint|OPay)/g;
      let lastIndex = 0, match;
      while((match = regex.exec(label)) !== null){
        if(match.index > lastIndex) segments.push({ text: label.slice(lastIndex, match.index), color: baseColor });
        segments.push({ text: match[0], color: providerColor(match[0] === 'OPay' ? 'Opay' : 'Moniepoint') });
        lastIndex = match.index + match[0].length;
      }
      if(lastIndex < label.length) segments.push({ text: label.slice(lastIndex), color: baseColor });
      return segments;
    }

    const filtered = getFiltered().slice().sort((a,b)=> new Date(a.date) - new Date(b.date));
    let sumCustomer=0, sumBase=0, sumVat=0, sumStamp=0, sumAutosave=0, sumNet=0;
    filtered.forEach(t=>{
      sumCustomer += t.customerFee;
      sumBase += t.baseFee;
      sumVat += (t.vatAmt||0);
      sumStamp += (t.stampAmt||0);
      sumAutosave += (t.autosaveAmt||0);
      sumNet += t.netProfit;
    });

    const periodLabels = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time', custom: customRangeLabel() };
    const periodLabel = periodLabels[state.period] || 'Today';
    const providerLabel = state.providerFilter === 'All' ? 'Moniepoint + OPay' : providerDisplay(state.providerFilter);
    const now = new Date();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginX = 40;
    let y = 50;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text('Ledger — Daily Report', marginX, y);
    y += 22;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    // Whose entries this report covers: a salesperson's own, or the person the owner filtered to.
    const reportPerson = role === 'staff' ? currentUser.uid : (state.loggedByFilter !== 'All' ? state.loggedByFilter : null);
    const personLabel = reportPerson ? ` · by ${nameFor(reportPerson)}` : '';
    const headerLabel = `${periodLabel} · ${providerLabel}${personLabel} · generated ${now.toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'})} ${now.toLocaleTimeString('en-NG',{hour:'numeric',minute:'2-digit',hour12:true})}`;
    drawSegments(doc, marginX, y, colorizeLabel(headerLabel, [90,90,90]));
    y += 26;

    doc.setDrawColor(220); doc.line(marginX, y, pageW - marginX, y);
    y += 22;

    const summaryRows = [
      ['VAT', '-' + fmtPdf(sumVat)],
      ['Stamp duty', '-' + fmtPdf(sumStamp)],
      ['Moniepoint/OPay fee', '-' + fmtPdf(sumBase)]
    ];
    if(sumAutosave > 0) summaryRows.push(['Auto-save (Moniepoint)', '-' + fmtPdf(sumAutosave)]);
    summaryRows.push(['Customer fees collected', fmtPdf(sumCustomer)]);

    doc.setFontSize(11);
    summaryRows.forEach(([label, val])=>{
      doc.setFont('helvetica','normal');
      drawSegments(doc, marginX, y, colorizeLabel(label, [30,30,30]));
      doc.setFont('helvetica','bold'); doc.setTextColor(30);
      doc.text(val, pageW - marginX, y, { align: 'right' });
      y += 18;
    });

    y += 6;
    doc.setDrawColor(220); doc.line(marginX, y, pageW - marginX, y);
    y += 24;

    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text('NET PROFIT', marginX, y);
    doc.setFontSize(16);
    doc.text(fmtPdf(sumNet), pageW - marginX, y, { align: 'right' });
    y += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(120);
    doc.text(`${filtered.length} transaction${filtered.length===1?'':'s'}`, marginX, y);
    y += 30;

    // Daily Breakdown — only meaningful when the filtered range spans more than one day
    const dayGroups = new Map();
    filtered.forEach(t=>{
      const dayKey = new Date(t.date).toDateString();
      if(!dayGroups.has(dayKey)) dayGroups.set(dayKey, { net: 0, count: 0, date: new Date(t.date) });
      const g = dayGroups.get(dayKey);
      g.net += t.netProfit;
      g.count += 1;
    });
    if(dayGroups.size > 1){
      if(y > pageH - 80){ doc.addPage(); y = 50; }
      doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(30);
      doc.text('Daily Breakdown', marginX, y);
      y += 18;
      Array.from(dayGroups.values()).forEach(g=>{
        if(y > pageH - 30){ doc.addPage(); y = 50; }
        doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(60);
        const dayLabel = g.date.toLocaleDateString('en-NG', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
        doc.text(`${dayLabel}  ·  ${g.count} transaction${g.count===1?'':'s'}`, marginX, y);
        doc.setFont('helvetica','bold');
        doc.setTextColor(g.net < 0 ? 200 : 20, g.net < 0 ? 40 : 120, g.net < 0 ? 40 : 60);
        doc.text(fmtPdf(g.net), pageW - marginX, y, { align: 'right' });
        y += 16;
      });
      y += 16;
      doc.setDrawColor(220); doc.line(marginX, y - 8, pageW - marginX, y - 8);
    }

    doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(30);
    doc.text('Transaction Log', marginX, y);
    y += 20;

    const maxTextWidth = pageW - marginX * 2;
    filtered.forEach((t, idx)=>{
      const d = new Date(t.date);
      const timeStr = d.toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'}) + ' ' + d.toLocaleTimeString('en-NG',{hour:'numeric',minute:'2-digit',hour12:true});
      const providerText = providerDisplay(t.provider);
      const rowProviderColor = providerColor(t.provider);

      // Pre-compute wrapped text for lines 2 & 3 so overlong entries (many transfer legs,
      // long fee breakdowns) wrap onto extra lines instead of running off the page edge.
      // The "cost ... -> charged ..." segment is built and measured separately and only
      // appended to the last wrapped line if it actually fits — otherwise it starts its
      // own line — so it stays together as one unit instead of splitting mid-phrase
      // (jsPDF has no CSS-style `nowrap`, so this has to be done by hand).
      const amountPart = comboAmountLine(t, fmtPdf);
      const chargedConnector = hasLeftoverHandling(t) ? '.' : '';
      const descPart = `${timeStr} · ${amountPart}${chargedConnector}`;
      const costChargedPart = `cost -${fmtPdf(t.providerFee)}. -> charged ${fmtPdf(t.customerFee)}.`;
      doc.setFont('helvetica','normal'); doc.setFontSize(9);
      const descLines = doc.splitTextToSize(descPart, maxTextWidth);
      const lastDescLine = descLines[descLines.length - 1];
      const combinedLastLine = lastDescLine + ' ' + costChargedPart;
      let line2Lines;
      if(doc.getTextWidth(combinedLastLine) <= maxTextWidth){
        line2Lines = descLines.slice(0, -1).concat([combinedLastLine]);
      } else {
        line2Lines = descLines.concat(doc.splitTextToSize(costChargedPart, maxTextWidth));
      }

      let feeLine = t.manualFee ? `fee ${fmtPdf(t.baseFee)} (manual)` : `fee ${fmtPdf(t.baseFee)}`;
      feeLine += ` + VAT ${fmtPdf(t.vatAmt)} + stamp ${fmtPdf(t.stampAmt)}`;
      if(t.autosaveAmt) feeLine += ` + autosave ${fmtPdf(t.autosaveAmt)}`;
      doc.setFontSize(8.5);
      const line3Lines = doc.splitTextToSize(feeLine, maxTextWidth);

      const estRowHeight = 13 + 12 + (line2Lines.length * 11) + (line3Lines.length * 10) + 20;
      if(y > pageH - estRowHeight){
        doc.addPage();
        y = 50;
      }

      // Line 1: provider (brand color) on the left, net profit bold on the right
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
      doc.setTextColor(rowProviderColor[0], rowProviderColor[1], rowProviderColor[2]);
      doc.text(providerText, marginX, y);
      doc.setTextColor(t.netProfit < 0 ? 200 : 20, t.netProfit < 0 ? 40 : 120, t.netProfit < 0 ? 40 : 60);
      doc.text(fmtPdf(t.netProfit), pageW - marginX, y, { align: 'right' });
      y += 12;

      // Line 1.5: transaction type, directly under the provider name
      doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(30);
      doc.text(typeLabel(t) + (t.loggedBy && !t.imported ? '  ·  by ' + nameFor(t.loggedBy, t.loggedByName) : ''), marginX, y);
      y += 13;

      // Line 2: time, amount, and what was charged to the customer (wrapped)
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(110);
      line2Lines.forEach(line=>{
        doc.text(line, marginX, y);
        y += 11;
      });

      // Line 3: the fee breakdown (wrapped)
      doc.setFontSize(8.5); doc.setTextColor(140);
      line3Lines.forEach(line=>{
        doc.text(line, marginX, y);
        y += 10;
      });

      if(idx < filtered.length - 1){
        doc.setDrawColor(235);
        doc.line(marginX, y, pageW - marginX, y);
      }
      y += 10;
    });

    const fileName = `ledger-${periodLabel.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')}-${now.toISOString().slice(0,10)}.pdf`;
    return { doc, fileName, periodLabel, sumNet };
  }

  async function downloadPdf(){
    const pdfBtn = $('#downloadPdfBtn');
    const pdfStatus = $('#pdfStatus');
    if(typeof window.jspdf === 'undefined'){
      pdfStatus.textContent = 'PDF library failed to load — check your connection and retry.';
      return;
    }
    pdfBtn.disabled = true;
    const originalBtnLabel = pdfBtn.innerHTML;
    pdfBtn.textContent = 'Building…';
    try{
      const built = buildPdfDoc();
      if(!built){
        pdfStatus.textContent = 'PDF library failed to load — check your connection and retry.';
        return;
      }
      built.doc.save(built.fileName);
      pdfStatus.textContent = 'PDF downloaded.';
      setTimeout(()=>{ pdfStatus.textContent = ''; }, 4000);
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.innerHTML = originalBtnLabel;
    }
  }

  async function sharePdf(pdfBtn = $('#sharePdfBtn'), pdfStatus = $('#pdfStatus')){
    if(typeof window.jspdf === 'undefined'){
      pdfStatus.textContent = 'PDF library failed to load — check your connection and retry.';
      return;
    }
    pdfBtn.disabled = true;
    const originalBtnLabel = pdfBtn.innerHTML;
    pdfBtn.textContent = 'Building…';
    try{
      const built = buildPdfDoc();
      if(!built){
        pdfStatus.textContent = 'PDF library failed to load — check your connection and retry.';
        return;
      }
      const { doc, fileName, periodLabel, sumNet } = built;
      const blob = doc.output('blob');
      let shared = false;
      try{
        if(navigator.canShare && navigator.share){
          const file = new File([blob], fileName, { type: 'application/pdf' });
          if(navigator.canShare({ files: [file] })){
            await navigator.share({ files: [file], title: 'Ledger Daily Report', text: `${periodLabel} report — Net profit ${fmt(sumNet)}` });
            shared = true;
          }
        }
      }catch(e){ /* user cancelled or share unsupported — fall through to download */ }

      if(!shared){
        doc.save(fileName);
        pdfStatus.textContent = 'Sharing isn\'t available on this device — PDF downloaded instead.';
        setTimeout(()=>{ pdfStatus.textContent = ''; }, 4000);
      }
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.innerHTML = originalBtnLabel;
    }
  }

  // ---------- Spreadsheet export (owner) ----------
  // CSV with a UTF-8 marker so Excel shows ₦ and names correctly. Amounts are plain numbers
  // so they can be added up in the spreadsheet.
  const csvDate = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' });
  const csvTime = new Intl.DateTimeFormat('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false });
  function csvCell(v){
    if(v === null || v === undefined) return '';
    const str = String(v);
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }
  // Columns a salesperson's spreadsheet leaves out (auto-save and the total cost are owner-only;
  // their report never includes deleted entries).
  const STAFF_HIDDEN_CSV = ['Auto-save', 'Total cost', 'Deleted', 'Deleted by'];
  function transactionsToCsv(list, forStaff){
    const head = ['Date','Time','Provider','Type','Logged by','Amount','Transfers sent','Cash brought in','Service fee charged','Machine fee','VAT','Stamp duty','Auto-save','Total cost','Net profit','Deleted','Deleted by','Logged offline','Entry ID'];
    const rows = list.map(t=>{
      const d = new Date(t.date);
      const sent = Array.isArray(t.transferAmounts) ? t.transferAmounts.reduce((a,b)=>a+b, 0) : '';
      return [csvDate.format(d), csvTime.format(d), providerDisplay(t.provider), typeLabel(t),
        t.imported ? '' : nameFor(t.loggedBy, t.loggedByName),
        t.amount, sent, t.cashAmount || '', t.customerFee, t.baseFee, t.vatAmt || 0, t.stampAmt || 0, t.autosaveAmt || 0,
        t.providerFee, t.netProfit, t.deleted ? 'yes' : '', t.deleted ? nameFor(t.deletedBy) : '', t.offline ? 'yes' : '', t.id];
    });
    const keep = head.map(h => !forStaff || !STAFF_HIDDEN_CSV.includes(h));
    const line = cells => cells.filter((_, i) => keep[i]).map(csvCell).join(',');
    return '\ufeff' + [line(head)].concat(rows.map(line)).join('\r\n');
  }
  function downloadText(text, fileName, type){
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
  }
  function fileSlug(text){ return (text || 'ledger').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ledger'; }
  $('#csvBtn').addEventListener('click', ()=>{
    const list = getFiltered().slice().sort((a,b)=> a.date < b.date ? -1 : 1);
    const periodLabels = { today:'today', week:'this-week', month:'this-month', all:'all-time', custom:'custom' };
    const who = role === 'staff' ? '-' + fileSlug(teamNames[currentUser.uid] || 'my-entries') : '';
    downloadText(transactionsToCsv(list, role === 'staff'), `${fileSlug(bizName)}${who}-${periodLabels[state.period] || 'report'}-${dayKey(new Date())}.csv`, 'text/csv;charset=utf-8');
    $('#pdfStatus').textContent = `Spreadsheet downloaded (${list.length} transaction${list.length === 1 ? '' : 's'}).`;
    setTimeout(()=>{ $('#pdfStatus').textContent = ''; }, 4000);
  });
  $('#backupBtn').addEventListener('click', async ()=>{
    if(!fb || role !== 'owner') return;
    const st = $('#backupStatus'); const btn = $('#backupBtn');
    btn.disabled = true; st.className = 'status'; st.textContent = 'Gathering every transaction…';
    try{
      if(olderState !== 'loaded') await loadOlderTransactions();
      if(olderState !== 'loaded') throw new Error('older transactions could not be loaded');
      const list = transactions.slice().sort((a,b)=> a.date < b.date ? -1 : 1);
      downloadText(transactionsToCsv(list), `${fileSlug(bizName)}-full-backup-${dayKey(new Date())}.csv`, 'text/csv;charset=utf-8');
      st.className = 'status deepgreen'; st.textContent = `Backup downloaded ✓ ${list.length} transactions.`;
    }catch(err){
      st.className = 'status error'; st.textContent = 'Backup failed — check your internet connection and try again.';
    }finally{ btn.disabled = false; }
  });

  $('#downloadPdfBtn').addEventListener('click', downloadPdf);
  $('#sharePdfBtn').addEventListener('click', ()=> sharePdf());
  $('#logSharePdfBtn').addEventListener('click', ()=> sharePdf($('#logSharePdfBtn'), $('#logPdfStatus')));

  let lastKnownDate = new Date().toDateString();
  setInterval(()=>{
    const nowDate = new Date().toDateString();
    if(nowDate !== lastKnownDate){
      lastKnownDate = nowDate;
      $('#todayLabel').textContent = new Date().toLocaleDateString('en-NG', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
    }
    // Re-render periodically so the delete lock on log entries takes effect
    // even if the user hasn't interacted with the app since logging a transaction.
    render();
  }, 30000);

  async function loadCalcState(){
    try{
      const s = await store.get('calcState');
      if(s && s.value){
        const parsed = JSON.parse(s.value);
        if(parsed && Array.isArray(parsed.tokens) && typeof parsed.display === 'string' && parsed.display !== 'Error'){
          calcState = parsed;
        }
      }
    }catch(e){}
    try{
      const h = await store.get('calcHistory');
      if(h && h.value){
        const parsed = JSON.parse(h.value);
        if(Array.isArray(parsed)) calcHistory = parsed;
      }
    }catch(e){}
    calcRenderDisplay();
    renderCalcHistory();
  }

  // ---------- Firebase: sign-in, roles, live sync ----------
  // Every transaction is saved to Firestore, tagged with who logged it. The owner sees
  // and the salesperson both see the shop's entries live, but only the owner sees costs,
  // per-entry profit and Settings, and a salesperson can only delete their own. Writes
  // made offline wait on the phone and upload by themselves when the connection returns.
  // Who may read/write what is enforced by the Firestore security rules (firestore.rules),
  // not just by this page. These config values are public identifiers, not secrets.
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyA5ZVSiUTvfSamlj6UKdOgSglN8TdcodkI',
    authDomain: 'ledger-3c7f0.firebaseapp.com',
    projectId: 'ledger-3c7f0',
    storageBucket: 'ledger-3c7f0.firebasestorage.app',
    messagingSenderId: '185353398694',
    appId: '1:185353398694:web:aa6f147856d3a5dba5c767'
  };
  // Installable app that opens without internet (see sw.js).
  if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
    window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
  }

  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/13.1.0/';
  // Every business lives under businesses/{owner's UID}: its transactions, settings and
  // staff are subcollections there, and users/{uid} tells a salesperson's login which
  // business they belong to. The rules keep each business's data to its own members.
  // LEGACY_OWNER_UID is the original single-business owner, whose data still sits in the
  // old top-level collections; it's moved into their business the first time they sign in.
  const LEGACY_OWNER_UID = '0xxeZTLlaAeTzTgpezc58hwDxXp2';
  // The platform admin: can list every business and suspend or restore one. Must match
  // isAdmin() in firestore.rules.
  const PLATFORM_ADMIN_UID = '0xxeZTLlaAeTzTgpezc58hwDxXp2';
  // Bump when terms.html / privacy.html change materially; stored with each acceptance.
  const TERMS_VERSION = '2026-10-27';
  // Salespeople can have a username instead of an email. Firebase logins need an email, so a
  // username is stored as username@STAFF_LOGIN_DOMAIN (this project's own Firebase domain,
  // which receives no mail). Anything typed with an "@" is used as a normal email.
  const STAFF_LOGIN_DOMAIN = 'ledger-3c7f0.firebaseapp.com';
  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
  let ownerUsername = '';  // the business owner's own username (businesses/{id}.ownerUsername)
  // Returns why a username can't be used by this owner, or '' if it's free (or already theirs).
  async function ownerUsernameProblem(u){
    if(!USERNAME_RE.test(u)) return 'Usernames are 3–30 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    const snap = await fb.getDoc(fb.doc(fb.db, 'usernames', u));
    if(snap.exists() && !(currentUser && snap.data().businessId === currentUser.uid && snap.data().email === currentUser.email)) return `The username "${u}" is already taken. Choose a different one.`;
    return '';
  }
  // Gives the signed-in owner a username (or removes theirs when u is empty), releasing the old one.
  async function saveOwnerUsername(u){
    const batch = fb.writeBatch(fb.db);
    if(u) batch.set(fb.doc(fb.db, 'usernames', u), { email: currentUser.email, businessId: currentUser.uid });
    if(ownerUsername && ownerUsername !== u) batch.delete(fb.doc(fb.db, 'usernames', ownerUsername));
    batch.update(fb.doc(fb.db, 'businesses', currentUser.uid), { ownerUsername: u });
    await batch.commit();
    ownerUsername = u;
  }
  function isUsernameLogin(email){ return (email || '').toLowerCase().endsWith('@' + STAFF_LOGIN_DOMAIN); }
  function displayLogin(email){ return isUsernameLogin(email) ? email.split('@')[0] : (email || ''); }
  // usernames/{name} → { email, businessId }: lets a username sign in to whichever login it
  // belongs to (a real email, or username@STAFF_LOGIN_DOMAIN). It can be read by exact name
  // before signing in, but never listed; only the business that created it can change it.
  async function resolveLogin(input){
    const v = (input || '').trim();
    if(v.includes('@')) return v;
    const name = v.toLowerCase();
    try{
      const snap = await fb.getDoc(fb.doc(fb.db, 'usernames', name));
      if(snap.exists() && snap.data().email) return snap.data().email;
    }catch(e){}
    return `${name}@${STAFF_LOGIN_DOMAIN}`;
  }
  const PENDING_MSG = 'Thanks for signing up! Your business account is waiting for approval by the Ledger team. Your ledger will open here by itself as soon as it\'s approved — you can leave this page open.';
  const DECLINED_MSG = 'Your business account wasn\'t approved, so this ledger can\'t be opened. If you think this is a mistake, contact the Ledger team using the details in the Terms of Use.';
  const SUSPENDED_MSG = 'This business account has been suspended, so its ledger can\'t be opened. If you think this is a mistake, contact the Ledger team using the details in the Terms of Use.';
  // The owner keeps the last RECENT_DAYS live (enough for Today / This Week / This Month).
  // Older entries are fetched once per session, only when All Time or an older Custom range
  // is picked, which keeps daily reads well inside Firebase's free allowance.
  const RECENT_DAYS = 35;

  let fb = null;
  let bizId = null;   // the signed-in person's business (= its owner's UID)
  let bizName = '';
  let pendingSignup = null; // { bizName, ownerName } while a new owner's account is being created
  let currentUser = null;
  let role = null; // 'owner' | 'staff'
  let teamNames = {};
  let teamMembers = {}; // uid -> { name, email, active }
  let recentTx = [];
  let olderTx = [];
  let olderState = 'idle'; // 'idle' | 'loading' | 'loaded'
  let txUnsub = null, settingsUnsub = null, teamUnsub = null;
  let pendingUploads = 0;

  function dayKey(d){ return toDateInputValue(d); }
  function bcol(name){ return fb.collection(fb.db, 'businesses', bizId, name); }
  function bdoc(name, id){ return fb.doc(fb.db, 'businesses', bizId, name, id); }
  function staffUids(){
    return Object.keys(teamMembers).filter(uid => uid !== bizId)
      .sort((a,b) => nameFor(a).localeCompare(nameFor(b)));
  }
  function nameFor(uid, savedName){ return teamNames[uid] || savedName || (uid === bizId ? 'OWNER' : 'STAFF'); }
  function recentSinceISO(){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - RECENT_DAYS);
    return d.toISOString();
  }
  function needsOlderTransactions(){
    if(state.period === 'all') return true;
    if(state.period !== 'custom') return false;
    if(!state.customStart) return true;
    return new Date(state.customStart + 'T00:00:00').toISOString() < recentSinceISO();
  }

  function docToTx(d){
    const data = d.data({ serverTimestamps: 'estimate' });
    const tx = Object.assign({}, data, { id: d.id });
    tx.createdAtMs = data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : null;
    tx.deletedAtMs = data.deletedAt && data.deletedAt.toMillis ? data.deletedAt.toMillis() : null;
    tx.pending = d.metadata.hasPendingWrites;
    // When it happened: Firebase's own clock for anything logged online, so changing a
    // phone's clock can't move a sale to another day. Entries logged with no internet (and
    // older records brought in from a phone) keep the phone's time, and are marked as such.
    tx.phoneDate = data.date;
    if(!data.imported && !data.offline && tx.createdAtMs && !tx.pending){
      tx.date = new Date(tx.createdAtMs).toISOString();
      tx.clockOffMs = tx.createdAtMs - Date.parse(data.date || '');
    }
    return tx;
  }
  function formatGap(ms){
    const mins = Math.round(Math.abs(ms) / 60000);
    if(mins < 60) return `${mins} min`;
    if(mins >= 1440){ const d = Math.round(mins / 1440); return `${d} day${d === 1 ? '' : 's'}`; }
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  function mergeTransactions(){
    const byId = new Map();
    olderTx.forEach(t => byId.set(t.id, t));
    recentTx.forEach(t => byId.set(t.id, t));
    transactions = Array.from(byId.values()).sort((a,b)=> a.date < b.date ? 1 : (a.date > b.date ? -1 : 0));
  }

  // Connection status, always shown: green "Connected" when online, orange "Offline" when
  // not, and how many entries are still waiting to upload while there are any.
  function updateSyncBadge(){
    const el = $('#syncBadge');
    const online = navigator.onLine && pendingUploads === 0;
    if(pendingUploads > 0) el.textContent = `⏳ ${pendingUploads} to upload`;
    else el.textContent = navigator.onLine ? 'Connected' : 'Offline';
    el.classList.toggle('online', online);
  }
  window.addEventListener('online', updateSyncBadge);
  window.addEventListener('offline', updateSyncBadge);

  function startTxListener(){
    if(txUnsub){ txUnsub(); txUnsub = null; }
    const col = bcol('transactions');
    // Everyone in the business loads all of its entries: the Transaction Log shows them all,
    // while a salesperson's totals and reports are narrowed to their own on screen.
    const q = fb.query(col, fb.where('date', '>=', recentSinceISO()), fb.orderBy('date', 'desc'));
    txUnsub = fb.onSnapshot(q, { includeMetadataChanges: true }, (snap)=>{
      recentTx = snap.docs.map(docToTx);
      pendingUploads = recentTx.filter(t => t.pending).length;
      mergeTransactions();
      updateSyncBadge();
      render();
    }, (err)=>{ setStatus(syncErrorMessage(err), 'error'); });
  }

  function syncErrorMessage(err){
    return 'Sync problem: ' + ((err && err.message) || 'unknown error');
  }

  async function loadOlderTransactions(){
    olderState = 'loading';
    try{
      const q = fb.query(bcol('transactions'), fb.where('date', '<', recentSinceISO()), fb.orderBy('date', 'desc'));
      const snap = await fb.getDocs(q);
      olderTx = snap.docs.map(docToTx);
      olderState = 'loaded';
    }catch(err){
      olderState = 'idle';
      $('#pdfStatus').textContent = "Couldn't load older transactions — check your connection.";
    }
    mergeTransactions();
    render();
  }

  function startSettingsListener(){
    settingsUnsub = fb.onSnapshot(bdoc('settings', 'shop'), (snap)=>{
      if(snap.metadata.hasPendingWrites) return; // our own edit echoing back
      if(!snap.exists()){
        // First run: publish the owner's current rates so the salesperson's phone uses them.
        if(role === 'owner' && !snap.metadata.fromCache) saveSettings();
        return;
      }
      try{
        const json = snap.data().json;
        applyParsedSettings(JSON.parse(json));
        store.set(settingsCacheKey(), json);
      }catch(e){ return; }
      populateSettingsUI();
      refreshAuto();
      render();
    }, ()=>{});
  }

  function startTeamListener(){
    teamUnsub = fb.onSnapshot(bcol('staff'), (snap)=>{
      teamNames = {}; teamMembers = {};
      snap.forEach(d=>{
        const data = d.data() || {};
        const n = (data.name || '').trim();
        if(n) teamNames[d.id] = n;
        teamMembers[d.id] = { name: n, email: data.email || '', username: data.username || '', active: data.active !== false, trainee: data.trainee === true };
      });
      updateWhoLabel();
      renderTeamUI();
      renderLoggedByFilter();
      render();
    }, ()=>{});
  }

  function stopListeners(){
    [txUnsub, settingsUnsub, teamUnsub].forEach(u => { if(u) u(); });
    txUnsub = settingsUnsub = teamUnsub = null;
  }

  function cloudAddTx(tx){
    const payload = Object.assign({}, tx, {
      loggedBy: currentUser.uid,
      loggedByName: nameFor(currentUser.uid),
      day: dayKey(new Date(tx.date)),
      deleted: false,
      // No internet when logged: its time comes from the phone, so it's shown as "logged offline".
      offline: !navigator.onLine,
      createdAt: fb.serverTimestamp()
    });
    // Not awaited: offline, this resolves only once uploaded. The live listener shows the
    // entry straight away either way.
    fb.setDoc(bdoc('transactions', tx.id), payload)
      .catch(err => setStatus('Not saved: ' + err.message, 'error'));
  }

  // "Delete" never erases: it marks the entry deleted, so the owner can still see it.
  function cloudSoftDelete(ids){
    const batch = fb.writeBatch(fb.db);
    ids.forEach(id => batch.update(bdoc('transactions', id), {
      deleted: true, deletedAt: fb.serverTimestamp(), deletedBy: currentUser.uid
    }));
    batch.commit().catch(err => setStatus('Could not delete: ' + err.message, 'error'));
    markLocal(ids, { deleted: true, deletedBy: currentUser.uid, deletedAtMs: Date.now() });
  }
  function cloudRestore(id){
    fb.updateDoc(bdoc('transactions', id), { deleted: false, deletedAt: null, deletedBy: null })
      .catch(err => setStatus('Could not restore: ' + err.message, 'error'));
    markLocal([id], { deleted: false, deletedBy: null, deletedAtMs: null });
  }
  // Older entries were fetched once rather than listened to, so update them by hand.
  function markLocal(ids, changes){
    const set = new Set(ids);
    olderTx.forEach(t => { if(set.has(t.id)) Object.assign(t, changes); });
    mergeTransactions();
    render();
  }

  // Staff still in training: set by the owner with the Trainee box in Settings > Team.
  // It only labels them "STAFF (TRAINEE)"; they can do everything other staff can.
  const isTrainee = uid => !!(teamMembers[uid] && teamMembers[uid].trainee && uid !== bizId);
  function updateWhoLabel(){
    if(!currentUser || !role) { $('#whoLabel').textContent = ''; return; }
    const roleLabel = role === 'owner' ? 'OWNER' : (isTrainee(currentUser.uid) ? 'STAFF (TRAINEE)' : 'STAFF');
    const name = teamNames[currentUser.uid];
    // Reads as "Business · Name · Role" (the separators are hidden; the layout splits it in two rows).
    const sep = '<span class="who-sep"> · </span>';
    const chip = `<span class="role-chip ${role}">${roleLabel}</span>`;
    const person = `<span class="who-person">${name ? `<span class="who-name">${escapeHtml(name)}</span>${sep}` : ''}${chip}</span>`;
    $('#whoLabel').innerHTML = bizName ? `<span class="who-biz">${escapeHtml(bizName)}</span>${sep}${person}` : person;
    const bizInput = $('#bizNameInput');
    if(bizInput && document.activeElement !== bizInput) bizInput.value = bizName;
  }

  function renderTeamUI(){
    const el = $('#teamInputs');
    if(!el || role !== 'owner') return;
    if(el.querySelector('input:focus')) return; // don't wipe a name being typed
    const members = [bizId].concat(staffUids());
    el.innerHTML = members.map(uid=>{
      const m = teamMembers[uid] || { name: '', email: '', active: true };
      const isOwnerRow = uid === bizId;
      const loginBits = [];
      if(m.username || isUsernameLogin(m.email)) loginBits.push('username: ' + (m.username || displayLogin(m.email)));
      if(m.email && !isUsernameLogin(m.email)) loginBits.push(m.email);
      const meta = isOwnerRow ? '' : `<div class="team-meta">${escapeHtml(loginBits.join(' · ') || 'no email saved')}${m.active ? '' : ' · <span class="removed-tag">access removed</span>'}</div>
        <div class="team-actions">
          ${!isOwnerRow && m.active ? `<label class="team-trainee"><input type="checkbox" class="team-trainee-input" data-uid="${uid}"${m.trainee ? ' checked' : ''} /> Trainee</label>` : ''}
          ${m.email && !isUsernameLogin(m.email) ? `<button type="button" class="team-reset" data-uid="${uid}">Send password reset email</button>` : ''}
          ${m.active ? `<button type="button" class="team-remove danger" data-uid="${uid}">Remove access</button>` : `<button type="button" class="team-restore" data-uid="${uid}">Restore access</button><button type="button" class="team-delete danger" data-uid="${uid}">Delete permanently</button>`}
        </div>`;
      return `<div class="team-row${m.active ? '' : ' removed'}"><div class="field"><label>${isOwnerRow ? 'You (OWNER)' : (m.trainee ? 'STAFF (TRAINEE)' : 'STAFF')}</label><input type="text" class="team-name-input" data-uid="${uid}" autocomplete="off" placeholder="Name" /></div>${meta}</div>`;
    }).join('');
    el.querySelectorAll('.team-name-input').forEach(inp=>{
      inp.value = teamNames[inp.dataset.uid] || '';
      inp.addEventListener('change', ()=>{
        // merge, so renaming never touches someone's access or email
        fb.setDoc(bdoc('staff', inp.dataset.uid), { name: inp.value.trim() }, { merge: true })
          .catch(err => setStatus('Name not saved: ' + err.message, 'error'));
      });
    });
    el.querySelectorAll('.team-trainee-input').forEach(box=>{
      box.addEventListener('change', ()=>{
        box.blur(); // lets the Team list redraw with the new label
        fb.setDoc(bdoc('staff', box.dataset.uid), { trainee: box.checked }, { merge: true })
          .catch(err => setStatus('Trainee setting not saved: ' + err.message, 'error'));
      });
    });
    el.querySelectorAll('.team-remove').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        armTapTwice(btn, 'Remove access', 'Tap again to remove', ()=>{
          fb.updateDoc(bdoc('staff', btn.dataset.uid), { active: false, removedAt: fb.serverTimestamp() })
            .catch(err => setStatus('Could not remove: ' + err.message, 'error'));
        });
      });
    });
    el.querySelectorAll('.team-delete').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        armTapTwice(btn, 'Delete permanently', 'Tap again to delete', ()=>{
          // Removes them from this business and frees their login to be added elsewhere.
          const batch = fb.writeBatch(fb.db);
          batch.delete(bdoc('staff', btn.dataset.uid));
          batch.delete(fb.doc(fb.db, 'users', btn.dataset.uid));
          const uname = (teamMembers[btn.dataset.uid] || {}).username;
          if(uname) batch.delete(fb.doc(fb.db, 'usernames', uname));
          batch.commit().catch(err => setStatus('Could not delete: ' + err.message, 'error'));
        });
      });
    });
    el.querySelectorAll('.team-restore').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        fb.updateDoc(bdoc('staff', btn.dataset.uid), { active: true, removedAt: null })
          .catch(err => setStatus('Could not restore: ' + err.message, 'error'));
      });
    });
    el.querySelectorAll('.team-reset').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const m = teamMembers[btn.dataset.uid];
        if(!navigator.onLine){ btn.textContent = 'No internet — connect to send it.'; return; }
        try{
          await fb.sendPasswordResetEmail(fb.auth, m.email);
          btn.textContent = 'Reset email sent ✓';
        }catch(err){ btn.textContent = 'Could not send — ' + ((err && err.code) || 'error'); }
      });
    });
  }

  // A few owner actions need the server itself (creating a login, checking a username is
  // free, sending an email, the admin list). Offline they'd wait forever, so say so instead;
  // everything else (logging, deleting, restoring, rates, names) saves now and uploads later.
  const NEEDS_INTERNET = 'This needs an internet connection — connect and try again. Everything else works offline.';
  function offlineBlock(statusEl){
    if(navigator.onLine) return false;
    if(statusEl){ statusEl.className = 'status error'; statusEl.textContent = NEEDS_INTERNET; }
    return true;
  }

  function addStaffError(err){
    const code = (err && err.code) || '';
    if(code === 'auth/email-already-in-use') return 'That email already has a login. Enter the password they use, or tap "Restore access" on their row if they are only removed.';
    if(code === 'permission-denied') return 'That login (or username) already belongs to another business, so it can\'t be added here.';
    if(code === 'auth/weak-password') return 'The password must be at least 6 characters.';
    if(code === 'auth/invalid-email') return "That email address doesn't look right.";
    if(code === 'auth/network-request-failed') return 'No internet connection — connect and try again.';
    if(code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') return 'Firebase is blocking new logins: in Firebase → Authentication → Settings → User actions, turn on "Enable create (sign-up)".';
    return (err && err.message) || 'Could not add.';
  }

  async function grantStaffAccess(uid, name, email, username){
    // Written together: their place in this business's team, the users/{uid} pointer their
    // login uses to find this business, and (if given) their username. The rules refuse the
    // pointer if the login belongs to a different business, and the username if it's taken.
    const batch = fb.writeBatch(fb.db);
    const staffData = { name, email: email || '', active: true, addedAt: fb.serverTimestamp() };
    if(username) staffData.username = username;
    batch.set(bdoc('staff', uid), staffData, { merge: true });
    batch.set(fb.doc(fb.db, 'users', uid), { businessId: bizId, role: 'staff' });
    if(username) batch.set(fb.doc(fb.db, 'usernames', username), { email, businessId: bizId });
    // Changing someone's username releases their old one.
    const previous = (teamMembers[uid] || {}).username;
    if(username && previous && previous !== username) batch.delete(fb.doc(fb.db, 'usernames', previous));
    await batch.commit();
  }

  $('#addStaffBtn').addEventListener('click', async ()=>{
    if(!fb || role !== 'owner') return;
    const name = $('#newStaffName').value.trim();
    const realEmail = $('#newStaffEmail').value.trim();
    const username = $('#newStaffUsername').value.trim().toLowerCase();
    const password = $('#newStaffPassword').value;
    const st = $('#addStaffStatus');
    st.className = 'status error';
    if(offlineBlock(st)) return;
    // Email is required (password resets go there); the username is their quick login.
    if(!name || !realEmail || !username || !password){ st.textContent = 'Enter their name, email, username and a password.'; return; }
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(realEmail)){ st.textContent = "That email address doesn't look right."; return; }
    if(!USERNAME_RE.test(username)){
      st.textContent = 'Usernames are 3–30 characters: letters, numbers, dots, dashes or underscores, starting with a letter or number.'; return;
    }
    const email = realEmail;
    const shown = username;
    if(username){
      try{
        const taken = await fb.getDoc(fb.doc(fb.db, 'usernames', username));
        if(taken.exists() && (taken.data().businessId !== bizId || (taken.data().email || '').toLowerCase() !== email.toLowerCase())){
          const suffix = (bizName || 'shop').toLowerCase().replace(/[^a-z0-9]+/g,'').slice(0,10) || 'shop';
          st.textContent = `The username "${username}" is already taken. Choose a different one (for example ${username}.${suffix}).`; return;
        }
      }catch(e){}
    }
    const btn = $('#addStaffBtn');
    const resetBtn = $('#addStaffResetBtn');
    btn.disabled = true;
    resetBtn.style.display = 'none';
    st.className = 'status';
    st.textContent = 'Creating their login…';
    try{
      // A separate, in-memory Firebase instance creates the account, so the owner stays
      // signed in here (creating a user on the main instance would switch to that user).
      let uid, existing = false;
      try{
        uid = await fb.createLogin(email, password);
      }catch(err){
        if(!err || err.code !== 'auth/email-already-in-use') throw err;
        // The email already has a login (e.g. someone deleted permanently and now re-added).
        // Signing in with it on the spare instance proves who it is and gives us its UID.
        st.textContent = 'That login already exists — checking it…';
        try{ uid = await fb.loginUid(email, password); existing = true; }
        catch(signInErr){
          const code = signInErr && signInErr.code;
          if(code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/invalid-login-credentials'){
            resetBtn.dataset.email = email; resetBtn.style.display = '';
            const e2 = new Error(`That email already has a login, but not with this password. Enter the password they use now — or send them a reset email below, ask them to choose a new password, then add them again with it.`);
            e2.code = 'existing-login-wrong-password';
            throw e2;
          }
          throw signInErr;
        }
      }
      if(uid === bizId){ const e3 = new Error("That's your own login — it can't be added as staff."); e3.code = 'own-login'; throw e3; }
      await grantStaffAccess(uid, name, email, username);
      st.className = 'status deepgreen';
      st.textContent = existing
        ? `${name} added back ✓ They can sign in with ${shown} and their existing password.`
        : `${name} added ✓ They can sign in now with ${shown} and the password you set.`;
      $('#newStaffName').value = ''; $('#newStaffEmail').value = ''; $('#newStaffUsername').value = ''; $('#newStaffPassword').value = '';
    }catch(err){
      st.className = 'status error';
      st.textContent = (err && (err.code === 'existing-login-wrong-password' || err.code === 'own-login')) ? err.message : addStaffError(err);
    }finally{
      btn.disabled = false;
    }
  });

  $('#addStaffResetBtn').addEventListener('click', async ()=>{
    const btn = $('#addStaffResetBtn');
    if(!navigator.onLine){ btn.textContent = 'No internet — connect to send the reset email.'; return; }
    try{
      await fb.sendPasswordResetEmail(fb.auth, btn.dataset.email);
      btn.textContent = `Reset email sent to ${btn.dataset.email} ✓`;
    }catch(err){ btn.textContent = 'Could not send — check the email address.'; }
  });

  $('#addStaffByUidBtn').addEventListener('click', async ()=>{
    if(!fb || role !== 'owner') return;
    const uid = $('#newStaffUid').value.trim();
    const name = $('#newStaffName').value.trim();
    const email = $('#newStaffEmail').value.trim();
    const st = $('#addStaffStatus');
    st.className = 'status error';
    if(offlineBlock(st)) return;
    if(!uid || !name){ st.textContent = 'Enter their name above and paste their User UID.'; return; }
    if(uid === bizId || /[\/\s]/.test(uid)){ st.textContent = "That UID doesn't look right."; return; }
    try{
      await grantStaffAccess(uid, name, email);
      st.className = 'status deepgreen';
      st.textContent = `${name} added ✓`;
      $('#newStaffUid').value = ''; $('#newStaffName').value = ''; $('#newStaffEmail').value = '';
    }catch(err){ st.textContent = addStaffError(err); }
  });

  function renderLoggedByFilter(){
    const el = $('#loggedByFilter');
    // People whose access was removed drop out of the filter; their entries still count
    // under Everyone.
    const staff = staffUids().filter(uid => teamMembers[uid].active);
    if(state.loggedByFilter !== 'All' && state.loggedByFilter !== bizId && !staff.includes(state.loggedByFilter)){
      state.loggedByFilter = 'All';
    }
    if(role !== 'owner' || staff.length === 0){ el.style.display = 'none'; return; }
    const opts = [['All', 'Everyone']].concat([bizId].concat(staff).map(uid => [uid, nameFor(uid)]));
    el.style.display = 'grid';
    el.innerHTML = opts.map(([val, label]) => `<button data-val="${val}" class="${state.loggedByFilter === val ? 'active' : ''}">${escapeHtml(label)}</button>`).join('');
    el.querySelectorAll('button').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.loggedByFilter = btn.dataset.val;
        renderLoggedByFilter();
        render();
      });
    });
  }

  // Which of this device's old records aren't in the cloud yet (checked once per session when
  // Settings opens, so a device whose records were uploaded elsewhere doesn't keep asking).
  let importMissing = null; // Set of ids, or null before the check
  let importChecking = false;
  let importCheckedFor = null; // the business the check was for
  const pendingLegacy = () => legacyTransactions.filter(tx => tx && tx.id && tx.date && (importMissing === null || importMissing.has(String(tx.id))));
  // An entry counts as already uploaded if the cloud has the same id, or the same entry
  // (provider, type, amount, fee and time) uploaded from another device under another id.
  const txSignature = tx => [String(tx.provider || '').toLowerCase(), tx.type, Number(tx.amount) || 0, Number(tx.customerFee) || 0, String(tx.phoneDate || tx.date || '').slice(0, 16)].join('|');
  // Old records belong to the original single-business ledger, so only its owner is offered them
  // (a new owner signing in on the same device never is). Entries logged offline after the
  // switch don't need this: they upload by themselves when the internet is back.
  const importIgnoreKey = () => LS_PREFIX + 'importIgnored:' + bizId;
  function importIgnoredFor(ids){ try{ return localStorage.getItem(importIgnoreKey()) === ids.slice().sort().join(','); }catch(e){ return false; } }
  async function checkImportUploaded(){
    if(importCheckedFor !== bizId){ importCheckedFor = bizId; importMissing = null; }
    if(!fb || role !== 'owner' || !currentUser || currentUser.uid !== LEGACY_OWNER_UID) return;
    if(importChecking || importMissing !== null || legacyTransactions.length === 0) return;
    importChecking = true;
    try{
      const ids = legacyTransactions.filter(tx => tx && tx.id).map(tx => String(tx.id));
      const snaps = await Promise.all(ids.map(id => fb.getDoc(bdoc('transactions', id))));
      let missing = ids.filter((id, i) => !snaps[i].exists());
      if(missing.length){
        if(olderState !== 'loaded') await loadOlderTransactions();
        const inCloud = new Set(transactions.map(txSignature));
        const byId = new Map(legacyTransactions.map(tx => [String(tx.id), tx]));
        missing = missing.filter(id => !inCloud.has(txSignature(byId.get(id))));
      }
      importMissing = new Set(missing);
    }catch(e){ importMissing = null; }
    importChecking = false;
    renderImportUI();
  }
  function renderImportUI(){
    const sec = $('#importSection');
    const pending = pendingLegacy();
    const n = pending.length;
    if(role !== 'owner' || n === 0 || importMissing === null || importIgnoredFor(pending.map(tx => String(tx.id)))){ sec.style.display = 'none'; return; }
    sec.style.display = '';
    $('#importHint').textContent = importDone
      ? `This phone's ${n} older transactions have been uploaded. Uploading again is safe — it won't create duplicates.`
      : `This device still has ${n} transaction${n === 1 ? '' : 's'} saved from before the switch to online sync that ${n === 1 ? "isn't" : "aren't"} in the cloud yet. Upload them once so they're backed up and included in your totals. They'll be marked as logged by you.`;
    $('#importBtn').textContent = importDone ? `Upload again (${n})` : `Upload ${n} transaction${n === 1 ? '' : 's'}`;
  }

  // Ignore hides the box on this device until different old records turn up.
  $('#importIgnoreBtn').addEventListener('click', ()=>{
    try{ localStorage.setItem(importIgnoreKey(), pendingLegacy().map(tx => String(tx.id)).sort().join(',')); }catch(e){}
    renderImportUI();
  });
  $('#importBtn').addEventListener('click', async ()=>{
    if(!fb || role !== 'owner') return;
    const btn = $('#importBtn');
    const st = $('#importStatus');
    const list = pendingLegacy();
    const BATCH = 400; // Firestore allows up to 500 writes per batch
    let uploaded = 0;
    if(offlineBlock(st)) return;
    btn.disabled = true;
    st.className = 'status';
    try{
      for(let i = 0; i < list.length; i += BATCH){
        const batch = fb.writeBatch(fb.db);
        list.slice(i, i + BATCH).forEach(tx=>{
          const id = String(tx.id);
          // Same id as on the phone, so uploading twice overwrites instead of duplicating.
          batch.set(bdoc('transactions', id), Object.assign({}, tx, {
            id, loggedBy: currentUser.uid, loggedByName: nameFor(currentUser.uid),
            day: dayKey(new Date(tx.date)), deleted: false, createdAt: fb.serverTimestamp(), imported: true
          }));
        });
        st.textContent = `Uploading… ${Math.min(i + BATCH, list.length)} of ${list.length}`;
        await batch.commit();
        uploaded = Math.min(i + BATCH, list.length);
      }
      importDone = true;
      list.forEach(tx => importMissing && importMissing.delete(String(tx.id)));
      try{ await store.set('cloudImported', '1'); }catch(e){}
      st.textContent = `Uploaded ${list.length} transactions ✓`;
      st.className = 'status deepgreen';
      olderTx = []; olderState = 'idle';
      renderImportUI();
      render();
    }catch(err){
      st.textContent = `Upload stopped after ${uploaded} (${err.message}). Tap again to continue — nothing will be duplicated.`;
      st.className = 'status error';
    }finally{
      btn.disabled = false;
    }
  });

  function showGate(mode, message){
    $('#appWrap').style.display = 'none';
    $('#authGate').style.display = '';
    $('#authLoading').style.display = mode === 'loading' ? '' : 'none';
    $('#authForm').style.display = mode === 'form' ? '' : 'none';
    $('#signupForm').style.display = mode === 'signup' ? '' : 'none';
    $('#setupForm').style.display = mode === 'setup' ? '' : 'none';
    $('#verifyForm').style.display = mode === 'verify' ? '' : 'none';
    $('#authRole').closest('.auth-card').querySelector('#authSub').style.display = (mode === 'form') ? '' : 'none';
    $('#authBlocked').style.display = mode === 'blocked' ? '' : 'none';
    $('#authBlockedSignOut').style.display = mode === 'blocked' ? '' : 'none';
    if(mode === 'loading') $('#authLoading').textContent = message || 'Connecting…';
    if(mode === 'blocked') $('#authBlocked').textContent = message || '';
  }

  function onAuthChange(user){
    stopListeners();
    stopAccessListeners();
    currentUser = user;
    recentTx = []; olderTx = []; olderState = 'idle'; transactions = [];
    teamNames = {}; teamMembers = {}; pendingUploads = 0;
    hideSettingsPanels();
    if(!user){
      role = null; settingsUnlocked = false;
      delete document.body.dataset.role;
      showGate('form');
      if(loginMismatchMsg){
        // Keep their choice so they can just tap the other one.
        $('#authStatus').textContent = loginMismatchMsg;
        $('#authStatus').className = 'status error';
        loginMismatchMsg = '';
      }else{
        loginChoice = null; // signed out: the next person chooses afresh
        renderLoginChoice();
      }
      return;
    }
    role = null; settingsUnlocked = false; bizId = null; bizName = '';
    findBusiness(user);
  }

  const REMOVED_MSG = 'Your access to this ledger has been removed. Ask the owner if this is a mistake.';
  let accessUnsubs = [];
  function stopAccessListeners(){ accessUnsubs.forEach(u => u()); accessUnsubs = []; }

  // Works out who this login is: the owner of businesses/{uid}, a salesperson listed in
  // users/{uid}, or neither yet (a new owner finishing setup, or someone not added).
  function findBusiness(user){
    stopAccessListeners();
    showGate('loading', 'Checking access…');
    let decided = false;
    accessUnsubs.push(fb.onSnapshot(fb.doc(fb.db, 'businesses', user.uid), { includeMetadataChanges: true }, (snap)=>{
      if(snap.exists() && snap.data().suspended){
        // The phone's saved copy may be out of date (e.g. just restored): when online, wait
        // for Firebase's live answer before locking anyone out.
        if(snap.metadata.fromCache && navigator.onLine) return;
        decided = true; lockOut(SUSPENDED_MSG); return;
      }
      if(snap.exists() && snap.data().approved === false){
        // Waiting for the platform admin's approval, or declined. Keep listening (unlike
        // lockOut), so the ledger opens by itself the moment it's approved.
        if(snap.metadata.fromCache && navigator.onLine) return;
        decided = true; waitForApproval(snap.data().declined === true); return;
      }
      if(snap.exists()){
        decided = true;
        bizId = user.uid;
        bizName = (snap.data().name || '').trim();
        ownerUsername = snap.data().ownerUsername || '';
        if(document.activeElement !== $('#ownerUsernameInput')) $('#ownerUsernameInput').value = ownerUsername;
        if(role !== 'owner') enterApp('owner'); else updateWhoLabel();
        return;
      }
      if(decided) return;
      if(snap.metadata.fromCache && !navigator.onLine){ showGate('loading', 'No internet connection — connect once to finish signing in.'); return; }
      if(pendingSignup) return; // their business is being created right now
      decided = true;
      findStaffBusiness(user);
    }, ()=> { if(!decided){ decided = true; findStaffBusiness(user); } }));
  }

  function findStaffBusiness(user){
    const notAddedMsg = `This account (${displayLogin(user.email) || user.uid}) doesn't have access to a ledger. Ask your business owner to add it in Settings → Team.`;
    accessUnsubs.push(fb.onSnapshot(fb.doc(fb.db, 'users', user.uid), async (snap)=>{
      if(!snap.exists()){
        if(snap.metadata.fromCache && !navigator.onLine){ showGate('loading', 'No internet connection — connect once to finish signing in.'); return; }
        if(user.uid === LEGACY_OWNER_UID){ if(!rejectLoginMismatch('owner')) showSetup(true); return; }
        // Someone on the original ledger whose owner hasn't moved it across yet.
        try{
          const legacy = await fb.getDoc(fb.doc(fb.db, 'staff', user.uid));
          if(legacy.exists()){ lockOut('Your business is moving to the new version of the ledger. Ask the owner to sign in once to finish, then sign in again.'); return; }
        }catch(e){}
        if(loginIntent === 'staff'){ lockOut(notAddedMsg); return; }
        showSetup(false); // an owner whose sign-up didn't finish
        return;
      }
      const b = snap.data().businessId;
      watchStaffAccess(user, b);
    }, ()=> lockOut(notAddedMsg)));
  }

  function watchStaffAccess(user, b){
    const notAddedMsg = `This account (${displayLogin(user.email) || user.uid}) doesn't have access to this ledger. Ask the owner to add it in Settings → Team.`;
    accessUnsubs.push(fb.onSnapshot(fb.doc(fb.db, 'businesses', b, 'staff', user.uid), async (snap)=>{
      if(snap.exists() && snap.data().active !== false){
        if(role !== 'staff'){
          bizId = b;
          try{ const biz = await fb.getDoc(fb.doc(fb.db, 'businesses', b)); bizName = ((biz.data() || {}).name || '').trim(); }catch(e){}
          enterApp('staff');
        }
        return;
      }
      if(!snap.exists() && snap.metadata.fromCache && !navigator.onLine){ showGate('loading', 'No internet connection — connect once to finish signing in.'); return; }
      lockOut(role === 'staff' ? REMOVED_MSG : notAddedMsg);
    }, async ()=>{
      // Denied: either they were removed, or the whole business was suspended.
      let suspended = false;
      try{ const biz = await fb.getDoc(fb.doc(fb.db, 'businesses', b)); suspended = !!(biz.exists() && (biz.data().suspended || biz.data().approved === false)); }catch(e){}
      lockOut(suspended ? SUSPENDED_MSG : (role === 'staff' ? REMOVED_MSG : notAddedMsg));
    }));
    // Live: if the business is suspended mid-shift, lock them out.
    accessUnsubs.push(fb.onSnapshot(fb.doc(fb.db, 'businesses', b), { includeMetadataChanges: true }, (snap)=>{
      if(snap.exists() && snap.data().suspended && !(snap.metadata.fromCache && navigator.onLine)) lockOut(SUSPENDED_MSG);
    }, ()=>{}));
  }

  // New business owners must confirm their email (Firebase emails them a link) before their
  // business is created; the rules check this too. Their business details wait on this phone.
  function pendingKey(){ return 'pendingBiz:' + (currentUser ? currentUser.uid : ''); }
  function savePending(details){ try{ localStorage.setItem(LS_PREFIX + pendingKey(), JSON.stringify(details)); }catch(e){} }
  function readPending(){ try{ return JSON.parse(localStorage.getItem(LS_PREFIX + pendingKey()) || 'null'); }catch(e){ return null; } }
  function clearPending(){ try{ localStorage.removeItem(LS_PREFIX + pendingKey()); }catch(e){} }
  function showVerify(note){
    showGate('verify');
    $('#verifyMsg').innerHTML = `<strong>Confirm your email</strong><br>We sent a link to <strong>${escapeHtml(currentUser.email || '')}</strong>. Open it (check spam too), then come back and tap the button below.`;
    if(note){ $('#authStatus').className = 'status error'; $('#authStatus').textContent = note; }
  }

  function showSetup(isLegacy){
    if(!isLegacy && currentUser && !currentUser.emailVerified){ showVerify(); return; }
    showGate('setup');
    if(!isLegacy){
      const pending = readPending();
      if(pending){
        if(!$('#setupBizName').value) $('#setupBizName').value = pending.name || '';
        if(!$('#setupOwnerName').value) $('#setupOwnerName').value = pending.ownerName || '';
      }
    }
    $('#setupIntro').innerHTML = isLegacy
      ? '<strong>Name your business</strong><br>The ledger now supports separate businesses. Name yours, and everything you have now — transactions, settings and your team — moves into it. The old copy is kept as a backup.'
      : '<strong>Finish setting up your business</strong><br>Your account was created but your business wasn\'t. Name it to continue.';
    $('#setupForm').dataset.legacy = isLegacy ? '1' : '';
    $('#setupSubmit').textContent = isLegacy ? 'Create my business and move my ledger' : 'Create my business';
    $('#setupOwnerName').value = $('#setupOwnerName').value || '';
  }

  // Creates businesses/{uid} last, so the app opens only once everything is in place.
  async function createBusiness(name, ownerName, statusEl, isLegacy, username, phone){
    // termsAcceptedAt must be the server time of this write (the rules check it).
    const uid = currentUser.uid;
    bizId = uid;
    const legacy = isLegacy ? await moveLegacyLedger(statusEl, false) : null;
    // One batch: the business itself, its settings and team, and each salesperson's
    // users/{uid} pointer (the rules only accept those for a business that exists).
    const batch = fb.writeBatch(fb.db);
    if(legacy){
      if(statusEl) statusEl.textContent = 'Moving settings and team…';
      if(legacy.settings) batch.set(fb.doc(fb.db, 'businesses', uid, 'settings', 'shop'), legacy.settings);
      legacy.staff.forEach(d=>{
        batch.set(fb.doc(fb.db, 'businesses', uid, 'staff', d.id), d.data(), { merge: true });
        if(d.id !== uid) batch.set(fb.doc(fb.db, 'users', d.id), { businessId: uid, role: 'staff' });
      });
    }
    batch.set(fb.doc(fb.db, 'businesses', uid, 'staff', uid), { name: ownerName, email: currentUser.email || '' }, { merge: true });
    const bizDoc = {
      // The owner's name (required at sign-up) is kept here too, so the admin list always has it.
      name, ownerUid: uid, ownerName, ownerEmail: currentUser.email || '', createdAt: fb.serverTimestamp(),
      termsAcceptedAt: fb.serverTimestamp(), termsVersion: TERMS_VERSION,
      // New businesses wait for the platform admin's approval (the rules insist on it).
      approved: uid === PLATFORM_ADMIN_UID
    };
    if(phone) bizDoc.ownerPhone = phone;
    // The username picked at sign-up goes in the same batch: once the business exists and is
    // waiting for approval, the owner can't change it until it's approved.
    if(username){
      bizDoc.ownerUsername = username;
      batch.set(fb.doc(fb.db, 'usernames', username), { email: currentUser.email, businessId: uid });
    }
    batch.set(fb.doc(fb.db, 'businesses', uid), bizDoc);
    await batch.commit();
    if(username) ownerUsername = username;
  }

  // Copies the original single-business ledger (top-level collections) into the owner's
  // business. Same document ids, so nothing duplicates; with onlyMissing it leaves alone
  // anything already copied, so later changes (like a delete) aren't overwritten.
  async function moveLegacyLedger(statusEl, onlyMissing){
    const uid = currentUser.uid;
    const say = (t) => { if(statusEl){ statusEl.className = 'status'; statusEl.textContent = t; } };
    say('Reading your current ledger…');
    const [txSnap, staffSnap, settingsSnap] = await Promise.all([
      fb.getDocs(fb.collection(fb.db, 'transactions')),
      fb.getDocs(fb.collection(fb.db, 'staff')),
      fb.getDoc(fb.doc(fb.db, 'settings', 'shop'))
    ]);
    let existing = new Set();
    if(onlyMissing){
      const have = await fb.getDocs(fb.collection(fb.db, 'businesses', uid, 'transactions'));
      existing = new Set(have.docs.map(d => d.id));
    }
    const docs = txSnap.docs.filter(d => !existing.has(d.id));
    const BATCH = 400;
    for(let i = 0; i < docs.length; i += BATCH){
      const batch = fb.writeBatch(fb.db);
      docs.slice(i, i + BATCH).forEach(d => batch.set(fb.doc(fb.db, 'businesses', uid, 'transactions', d.id), d.data()));
      say(`Moving transactions… ${Math.min(i + BATCH, docs.length)} of ${docs.length}`);
      await batch.commit();
    }
    return { copied: docs.length, staff: staffSnap.docs, settings: settingsSnap.exists() ? settingsSnap.data() : null };
  }

  function waitForApproval(declined){
    stopListeners();
    role = null; settingsUnlocked = false;
    recentTx = []; olderTx = []; transactions = [];
    delete document.body.dataset.role;
    showGate('blocked', declined ? DECLINED_MSG : PENDING_MSG);
  }

  function lockOut(message){
    stopListeners();
    stopAccessListeners();
    role = null; settingsUnlocked = false;
    recentTx = []; olderTx = []; transactions = [];
    delete document.body.dataset.role;
    showGate('blocked', message);
  }

  async function loadBusinessSettings(){
    // Start clean, then use this business's last-known settings (if this phone has them)
    // so fees calculate straight away; the live copy from Firebase follows.
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try{
      const cached = await store.get(settingsCacheKey());
      if(cached && cached.value) applyParsedSettings(JSON.parse(cached.value));
    }catch(e){}
    populateSettingsUI();
    refreshAuto();
    render();
  }

  function enterApp(newRole){
    if(rejectLoginMismatch(newRole)) return;
    role = newRole;
    document.body.dataset.role = role;
    settingsUnlocked = role === 'owner';
    state.loggedByFilter = 'All';
    $('#authGate').style.display = 'none';
    $('#appWrap').style.display = '';
    updateWhoLabel();
    updateSyncBadge();
    renderTeamUI();
    renderLoggedByFilter();
    renderImportUI();
    renderLegacyUI();
    renderAdminUI();
    loadBusinessSettings().then(startSettingsListener);
    startTeamListener();
    startTxListener();
    render();
  }

  function authErrorMessage(err){
    const code = (err && err.code) || '';
    if(['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(code)) return 'Wrong email or password.';
    if(code === 'auth/network-request-failed') return 'No internet connection — connect and try again.';
    if(code === 'auth/too-many-requests') return 'Too many attempts — wait a few minutes and try again.';
    return (err && err.message) || 'Sign-in failed.';
  }

  // BUSINESS OWNER / STAFF choice on the sign-in screen. It doesn't grant anything —
  // the account decides what someone can do — but signing in with the wrong one chosen is
  // refused with a clear message, so nobody ends up confused about which login they used.
  // Nothing is pre-selected or remembered: the person picks one every time they sign in.
  let loginChoice = null;
  let loginIntent = null;      // set only for a sign-in typed on this screen
  let loginMismatchMsg = '';
  function renderLoginChoice(){
    $('#authRole').querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.val === loginChoice); b.setAttribute('aria-pressed', String(b.dataset.val === loginChoice)); });
    $('#authSub').textContent = loginChoice === 'owner' ? 'Sign in as BUSINESS OWNER'
      : loginChoice === 'staff' ? 'Sign in as STAFF'
      : 'Choose how you are signing in';
  }
  $('#authRole').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      loginChoice = btn.dataset.val;
      $('#authStatus').textContent = '';
      renderLoginChoice();
    });
  });
  renderLoginChoice();
  // Show / hide the password while typing it.
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.1 3.8M6.4 7.6A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.2 9.2 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function setPwVisible(show){
    $('#authPassword').type = show ? 'text' : 'password';
    $('#authPwToggle').innerHTML = show ? EYE_OFF : EYE;
    $('#authPwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('#authPwToggle').setAttribute('aria-pressed', String(show));
  }
  setPwVisible(false);
  $('#authPwToggle').addEventListener('click', ()=>{ setPwVisible($('#authPassword').type === 'password'); $('#authPassword').focus(); });
  $('#authForm').addEventListener('submit', ()=> setPwVisible(false), true);
  // Returns true when the account doesn't match the option picked; signs it back out.
  function rejectLoginMismatch(actualRole){
    const intent = loginIntent;
    loginIntent = null;
    if(!intent || intent === actualRole) return false;
    loginMismatchMsg = actualRole === 'owner'
      ? 'This is a BUSINESS OWNER login — choose "BUSINESS OWNER" and sign in again.'
      : 'This is a STAFF login — choose "STAFF" and sign in again.';
    fb.signOut(fb.auth);
    return true;
  }

  $('#authForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!fb) return;
    if(!loginChoice){
      $('#authStatus').className = 'status error';
      $('#authStatus').textContent = 'Choose BUSINESS OWNER or STAFF first.';
      return;
    }
    loginIntent = loginChoice;
    loginMismatchMsg = '';
    const btn = $('#authSubmit');
    const st = $('#authStatus');
    btn.disabled = true;
    st.className = 'status';
    st.textContent = 'Signing in…';
    try{
      await fb.signInWithEmailAndPassword(fb.auth, await resolveLogin($('#authEmail').value), $('#authPassword').value);
      $('#authPassword').value = '';
      st.textContent = '';
    }catch(err){
      st.textContent = authErrorMessage(err);
      st.className = 'status error';
    }finally{
      btn.disabled = false;
    }
  });

  $('#showSignup').addEventListener('click', ()=>{ $('#authStatus').textContent = ''; showGate('signup'); });
  $('#showSignin').addEventListener('click', ()=>{ $('#authStatus').textContent = ''; showGate('form'); });
  $('#setupSignOut').addEventListener('click', ()=>{ if(fb) fb.signOut(fb.auth); });

  function signupErrorMessage(err){
    const code = (err && err.code) || '';
    if(code === 'auth/email-already-in-use') return 'That email already has an account — go back and sign in instead.';
    if(code === 'auth/weak-password') return 'The password must be at least 6 characters.';
    if(code === 'auth/invalid-email') return "That email address doesn't look right.";
    if(code === 'auth/network-request-failed') return 'No internet connection — connect and try again.';
    if(code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') return 'New accounts are switched off in Firebase (Authentication → Settings → User actions → Enable create).';
    return (err && err.message) || 'Could not create the account.';
  }

  // Business owners only: creates their login, then their business. Salespeople are
  // added by their owner instead, so this never creates a salesperson.
  $('#signupForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!fb) return;
    const name = $('#signupBizName').value.trim();
    const ownerName = $('#signupOwnerName').value.trim();
    const email = $('#signupEmail').value.trim();
    const phone = $('#signupPhone').value.trim();
    const password = $('#signupPassword').value;
    const st = $('#authStatus');
    if(!name || !ownerName || !email || !phone || !password){ st.className = 'status error'; st.textContent = 'Enter the business name, your name, your email, your phone number and a password.'; return; }
    // A real number helps the Ledger team check new sign-ups before approving them.
    if(!/^\+?[0-9][0-9 ()-]{8,}$/.test(phone) || phone.replace(/\D/g, '').length < 10 || phone.replace(/\D/g, '').length > 15){ st.className = 'status error'; st.textContent = 'Enter a valid phone number, e.g. 0803 123 4567.'; return; }
    if(!$('#signupTerms').checked){ st.className = 'status error'; st.textContent = 'Tick the box to agree to the Terms of Use and Privacy Policy.'; return; }
    const username = $('#signupUsername').value.trim().toLowerCase();
    if(username){
      const problem = await ownerUsernameProblem(username).catch(()=> '');
      if(problem){ st.className = 'status error'; st.textContent = problem; return; }
    }
    const btn = $('#signupSubmit');
    btn.disabled = true;
    st.className = 'status';
    st.textContent = 'Creating your account…';
    pendingSignup = { name, ownerName };
    loginIntent = 'owner';
    try{
      const cred = await fb.createUserWithEmailAndPassword(fb.auth, email, password);
      currentUser = cred.user;
      savePending({ name, ownerName, username, phone });
      await fb.sendEmailVerification(cred.user);
      $('#signupPassword').value = '';
      st.textContent = '';
      showVerify();
    }catch(err){
      st.className = 'status error';
      st.textContent = signupErrorMessage(err);
      if(currentUser){ showSetup(false); } else { showGate('signup'); }
    }finally{
      pendingSignup = null;
      btn.disabled = false;
    }
  });

  $('#verifyDone').addEventListener('click', async ()=>{
    if(!fb || !currentUser) return;
    const st = $('#authStatus'); const btn = $('#verifyDone');
    btn.disabled = true; st.className = 'status'; st.textContent = 'Checking…';
    try{
      await fb.reloadUser(currentUser);
      if(!fb.auth.currentUser.emailVerified){ st.className = 'status error'; st.textContent = "Not confirmed yet — open the link in the email first (check spam), then tap again."; return; }
      currentUser = fb.auth.currentUser;
      await currentUser.getIdToken(true); // so the rules see the confirmed email
      const pending = readPending();
      if(pending && pending.name && pending.ownerName){
        st.textContent = 'Setting up your business…';
        pendingSignup = pending;
        // The username was free when they signed up; if someone took it since, it's left off
        // and they can pick another in Settings once approved.
        let username = '';
        if(pending.username){ try{ if(!(await ownerUsernameProblem(pending.username))) username = pending.username; }catch(e){} }
        await createBusiness(pending.name, pending.ownerName, st, false, username, pending.phone || '');
        clearPending();
        st.textContent = '';
        if(!role) findBusiness(currentUser);
      }else{
        st.textContent = '';
        showSetup(false);
      }
    }catch(err){
      st.className = 'status error'; st.textContent = 'Could not finish: ' + ((err && err.message) || 'error') + ' — try again.';
    }finally{ pendingSignup = null; btn.disabled = false; }
  });
  $('#verifyResend').addEventListener('click', async ()=>{
    if(!fb || !currentUser) return;
    const st = $('#authStatus');
    try{ await fb.sendEmailVerification(currentUser); st.className = 'status deepgreen'; st.textContent = 'Sent again ✓ Check your inbox and spam folder.'; }
    catch(err){ st.className = 'status error'; st.textContent = (err && err.code) === 'auth/too-many-requests' ? 'Please wait a few minutes before sending another.' : "Couldn't send the email — try again."; }
  });
  $('#verifySignOut').addEventListener('click', ()=>{ if(fb) fb.signOut(fb.auth); });

  $('#setupForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!fb || !currentUser) return;
    const name = $('#setupBizName').value.trim();
    const ownerName = $('#setupOwnerName').value.trim();
    const st = $('#authStatus');
    if(!name || !ownerName){ st.className = 'status error'; st.textContent = 'Enter your business name and your name.'; return; }
    if(!$('#setupTerms').checked){ st.className = 'status error'; st.textContent = 'Tick the box to agree to the Terms of Use and Privacy Policy.'; return; }
    const btn = $('#setupSubmit');
    btn.disabled = true;
    pendingSignup = { name, ownerName };
    try{
      await createBusiness(name, ownerName, st, $('#setupForm').dataset.legacy === '1');
      clearPending();
      st.textContent = '';
    }catch(err){
      st.className = 'status error';
      st.textContent = 'Could not finish: ' + err.message + ' — tap the button to try again.';
    }finally{
      pendingSignup = null;
      btn.disabled = false;
      if(!role) findBusiness(currentUser);
    }
  });

  function renderAdminUI(){
    $('#adminSection').style.display = (role === 'owner' && currentUser && currentUser.uid === PLATFORM_ADMIN_UID) ? '' : 'none';
  }
  const adminDateFormat = new Intl.DateTimeFormat('en-NG', { day:'numeric', month:'short', year:'numeric' });
  async function loadAdminList(){
    const st = $('#adminStatus');
    const list = $('#adminList');
    if(offlineBlock(st)) return;
    st.className = 'status'; st.textContent = 'Loading…';
    try{
      const snap = await fb.getDocs(fb.collection(fb.db, 'businesses'));
      const rows = await Promise.all(snap.docs.map(async d=>{
        const data = d.data() || {};
        let email = data.ownerEmail || '';
        // The name in their Team row (kept up to date if they rename themselves), else the
        // name given at sign-up.
        let ownerName = '';
        try{
          const o = await fb.getDoc(fb.doc(fb.db, 'businesses', d.id, 'staff', d.id));
          if(o.exists()){ ownerName = o.data().name || ''; email = email || o.data().email || ''; }
        }catch(e){}
        ownerName = ownerName || (data.ownerName || '').trim();
        const created = data.createdAt && data.createdAt.toDate ? adminDateFormat.format(data.createdAt.toDate()) : '—';
        return { id: d.id, name: data.name || '(no name)', ownerName, email, phone: data.ownerPhone || '', created, suspended: !!data.suspended, pending: data.approved === false && data.declined !== true, declined: data.approved === false && data.declined === true, createdMs: data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : 0 };
      }));
      // Waiting for approval first, then newest first.
      rows.sort((a,b)=> (b.pending - a.pending) || (b.createdMs - a.createdMs));
      const waiting = rows.filter(r => r.pending).length;
      list.innerHTML = rows.map(r => `<div class="admin-biz${r.suspended || r.declined ? ' suspended' : ''}${r.pending ? ' pending' : ''}">
        <div class="admin-name">${escapeHtml(r.name)} <span class="admin-type${r.id === PLATFORM_ADMIN_UID ? ' master' : ''}">${r.id === PLATFORM_ADMIN_UID ? 'MASTER ADMIN' : 'BUSINESS OWNER'}</span></div>
        <div class="admin-meta">${r.ownerName ? escapeHtml(r.ownerName) + ' · ' : ''}${escapeHtml(r.email || 'no email')}${r.phone ? ' · ' + escapeHtml(r.phone) : ''} · created ${r.created}</div>
        <div class="admin-meta">Status: <span class="admin-status">${r.pending ? 'Waiting for approval' : r.declined ? 'Declined' : (r.suspended ? 'Suspended' : 'Active')}</span></div>
        ${r.id === PLATFORM_ADMIN_UID ? '' : `<div class="team-actions">${
          // New sign-ups: Approve or Decline. A declined one can still be approved later.
          // Suspending is only for businesses already approved (misuse of the app).
          r.pending ? `<button type="button" class="admin-approve" data-id="${r.id}">Approve</button><button type="button" class="admin-decline danger" data-id="${r.id}">Decline</button>`
          : r.declined ? `<button type="button" class="admin-approve" data-id="${r.id}">Approve after all</button>`
          : r.suspended ? `<button type="button" class="admin-restore" data-id="${r.id}">Restore access</button>`
          : `<button type="button" class="admin-suspend danger" data-id="${r.id}">Suspend business</button>`}</div>`}
      </div>`).join('');
      st.textContent = `${rows.length} business${rows.length === 1 ? '' : 'es'}` + (waiting ? ` · ${waiting} waiting for approval` : '');
      list.querySelectorAll('.admin-approve').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          if(offlineBlock(st)) return;
          btn.disabled = true;
          try{ await fb.updateDoc(fb.doc(fb.db, 'businesses', btn.dataset.id), { approved: true, approvedAt: fb.serverTimestamp(), declined: false }); loadAdminList(); }
          catch(err){ btn.disabled = false; st.className = 'status error'; st.textContent = 'Could not approve: ' + err.message; }
        });
      });
      list.querySelectorAll('.admin-decline').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          armTapTwice(btn, 'Decline', 'Tap again to decline', async ()=>{
            if(offlineBlock(st)) return;
            try{ await fb.updateDoc(fb.doc(fb.db, 'businesses', btn.dataset.id), { declined: true, declinedAt: fb.serverTimestamp() }); loadAdminList(); }
            catch(err){ st.className = 'status error'; st.textContent = 'Could not decline: ' + err.message; }
          });
        });
      });
      list.querySelectorAll('.admin-suspend').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          armTapTwice(btn, 'Suspend business', 'Tap again to suspend', async ()=>{
            if(offlineBlock(st)) return;
            try{ await fb.updateDoc(fb.doc(fb.db, 'businesses', btn.dataset.id), { suspended: true, suspendedAt: fb.serverTimestamp() }); loadAdminList(); }
            catch(err){ st.className = 'status error'; st.textContent = 'Could not suspend: ' + err.message; }
          });
        });
      });
      list.querySelectorAll('.admin-restore').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          if(offlineBlock(st)) return;
          try{ await fb.updateDoc(fb.doc(fb.db, 'businesses', btn.dataset.id), { suspended: false, suspendedAt: null }); loadAdminList(); }
          catch(err){ st.className = 'status error'; st.textContent = 'Could not restore: ' + err.message; }
        });
      });
    }catch(err){
      st.className = 'status error';
      st.textContent = 'Could not load businesses: ' + err.message;
    }
  }
  $('#adminRefreshBtn').addEventListener('click', ()=>{ $('#adminRefreshBtn').textContent = 'Refresh list'; loadAdminList(); });

  // The "copy missing entries" box only shows when the old ledger really has entries this
  // business doesn't. Checked once per session when Settings opens; after a full check the
  // old ledger's size is remembered on this device, so later checks cost a single read.
  let legacyLedgerState = 'unknown'; // unknown | checking | missing | done
  const isLegacyOwnerNow = () => role === 'owner' && currentUser && currentUser.uid === LEGACY_OWNER_UID;
  function renderLegacyUI(){
    $('#legacySection').style.display = (isLegacyOwnerNow() && legacyLedgerState === 'missing') ? '' : 'none';
  }
  async function checkLegacyLedger(){
    if(!fb || !isLegacyOwnerNow() || legacyLedgerState === 'checking' || legacyLedgerState === 'done') return;
    legacyLedgerState = 'checking';
    const key = LS_PREFIX + 'legacyCheckedCount:' + currentUser.uid;
    try{
      const total = (await fb.getCountFromServer(fb.collection(fb.db, 'transactions'))).data().count;
      let saved = null; try{ saved = localStorage.getItem(key); }catch(e){}
      if(saved !== null && Number(saved) === total){ legacyLedgerState = 'done'; }
      else{
        const [legacySnap, haveSnap] = await Promise.all([
          fb.getDocs(fb.collection(fb.db, 'transactions')),
          fb.getDocs(fb.collection(fb.db, 'businesses', currentUser.uid, 'transactions'))
        ]);
        const have = new Set(haveSnap.docs.map(d => d.id));
        const missing = legacySnap.docs.filter(d => !have.has(d.id)).length;
        legacyLedgerState = missing ? 'missing' : 'done';
        if(!missing){ try{ localStorage.setItem(key, String(total)); }catch(e){} }
      }
    }catch(e){ legacyLedgerState = 'unknown'; }
    renderLegacyUI();
  }
  $('#legacyRecopyBtn').addEventListener('click', async ()=>{
    const st = $('#legacyStatus');
    const btn = $('#legacyRecopyBtn');
    if(offlineBlock(st)) return;
    btn.disabled = true;
    try{
      const n = (await moveLegacyLedger(st, true)).copied;
      st.className = 'status deepgreen';
      st.textContent = n ? `Copied ${n} missing entr${n === 1 ? 'y' : 'ies'} ✓` : 'Nothing missing — everything is already here ✓';
      legacyLedgerState = 'unknown'; setTimeout(checkLegacyLedger, 2500); // hides the box once all is copied
      olderTx = []; olderState = 'idle'; render();
    }catch(err){
      st.className = 'status error';
      st.textContent = 'Could not copy: ' + err.message;
    }finally{ btn.disabled = false; }
  });

  $('#bizNameInput').addEventListener('change', ()=>{
    const v = $('#bizNameInput').value.trim();
    if(!v || !fb || role !== 'owner') return;
    fb.updateDoc(fb.doc(fb.db, 'businesses', bizId), { name: v })
      .catch(err => setStatus('Business name not saved: ' + err.message, 'error'));
  });

  $('#ownerUsernameBtn').addEventListener('click', async ()=>{
    if(!fb || role !== 'owner' || !currentUser) return;
    const st = $('#ownerUsernameStatus'); const btn = $('#ownerUsernameBtn');
    const u = $('#ownerUsernameInput').value.trim().toLowerCase();
    $('#ownerUsernameInput').value = u;
    if(u === ownerUsername){ st.className = 'status'; st.textContent = u ? `"${u}" is already your username.` : ''; return; }
    if(offlineBlock(st)) return;
    btn.disabled = true; st.className = 'status'; st.textContent = 'Saving…';
    try{
      const problem = u ? await ownerUsernameProblem(u) : '';
      if(problem){ st.className = 'status error'; st.textContent = problem; return; }
      await saveOwnerUsername(u);
      st.className = 'status deepgreen';
      st.textContent = u ? `Saved ✓ You can now sign in with "${u}" or your email.` : 'Username removed. Sign in with your email.';
    }catch(err){
      st.className = 'status error';
      st.textContent = (err && err.code) === 'permission-denied' ? `The username "${u}" is already taken. Choose a different one.` : 'Not saved: ' + ((err && err.message) || 'error');
    }finally{ btn.disabled = false; }
  });

  $('#authForgot').addEventListener('click', async ()=>{
    if(!fb) return;
    const st = $('#authStatus');
    const email = $('#authEmail').value.trim();
    if(!email){ st.className = 'status error'; st.textContent = 'Type your email above first, then tap "Forgot password?".'; return; }
    if(!email.includes('@')){
      // A username with an email behind it can still get a reset link (sent to that email).
      const resolved = await resolveLogin(email);
      if(isUsernameLogin(resolved)){ st.className = 'status error'; st.textContent = "This username has no email to send a reset link to. Ask your business owner to add an email for you, or to add you again with a new password."; return; }
      try{ await fb.sendPasswordResetEmail(fb.auth, resolved); }catch(e){}
      st.className = 'status deepgreen';
      st.textContent = 'If that username has an email, a reset link is on its way to it. Check the inbox and spam folder.';
      return;
    }
    try{
      await fb.sendPasswordResetEmail(fb.auth, email);
      st.className = 'status deepgreen';
      st.textContent = `If ${email} has a login, a reset link is on its way. Check your inbox and spam folder.`;
    }catch(err){
      st.className = 'status error';
      st.textContent = (err && err.code) === 'auth/network-request-failed' ? 'No internet connection — connect and try again.' : "Couldn't send the reset email — check the address.";
    }
  });

  $('#signOutBtn').addEventListener('click', ()=>{
    if(pendingUploads > 0){
      setStatus(`${pendingUploads} transaction${pendingUploads === 1 ? '' : 's'} not uploaded yet — connect to the internet before signing out.`, 'error');
      return;
    }
    armTapTwice($('#signOutBtn'), 'Sign out', 'Confirm', ()=> fb.signOut(fb.auth));
  });
  $('#authBlockedSignOut').addEventListener('click', ()=>{ if(fb) fb.signOut(fb.auth); });

  async function initCloud(){
    showGate('loading');
    try{
      const [appMod, authMod, fsMod] = await Promise.all(
        ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(FIREBASE_SDK + f))
      );
      const app = appMod.initializeApp(FIREBASE_CONFIG);
      const auth = authMod.getAuth(app);
      let db;
      try{
        // Keeps a copy on the phone so the app works offline and queues writes.
        db = fsMod.initializeFirestore(app, {
          localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
          ignoreUndefinedProperties: true
        });
      }catch(e){
        db = fsMod.initializeFirestore(app, { ignoreUndefinedProperties: true });
      }
      // ?emulator=1 points the page at a local Firebase emulator, for testing only.
      const useEmulator = new URLSearchParams(location.search).get('emulator') === '1';
      if(useEmulator){
        authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        fsMod.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      }
      fb = {
        auth, db,
        onAuthStateChanged: authMod.onAuthStateChanged,
        signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
        signOut: authMod.signOut,
        createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword,
        sendEmailVerification: authMod.sendEmailVerification,
        reloadUser: authMod.reload,
        sendPasswordResetEmail: authMod.sendPasswordResetEmail,
        // Creates a login on a throwaway in-memory instance and returns its UID.
        createLogin: async (email, password)=>{
          const spare = appMod.getApps().find(a => a.name === 'create-login') || appMod.initializeApp(FIREBASE_CONFIG, 'create-login');
          let spareAuth;
          try{ spareAuth = authMod.initializeAuth(spare, { persistence: authMod.inMemoryPersistence }); }
          catch(e){ spareAuth = authMod.getAuth(spare); }
          if(useEmulator && !spareAuth.emulatorConfig) authMod.connectAuthEmulator(spareAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
          const cred = await authMod.createUserWithEmailAndPassword(spareAuth, email, password);
          const uid = cred.user.uid;
          await authMod.signOut(spareAuth);
          return uid;
        },
        // Signs in to an existing login on the same throwaway instance, just to learn its UID.
        loginUid: async (email, password)=>{
          const spare = appMod.getApps().find(a => a.name === 'create-login') || appMod.initializeApp(FIREBASE_CONFIG, 'create-login');
          let spareAuth;
          try{ spareAuth = authMod.initializeAuth(spare, { persistence: authMod.inMemoryPersistence }); }
          catch(e){ spareAuth = authMod.getAuth(spare); }
          if(useEmulator && !spareAuth.emulatorConfig) authMod.connectAuthEmulator(spareAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
          const cred = await authMod.signInWithEmailAndPassword(spareAuth, email, password);
          const uid = cred.user.uid;
          await authMod.signOut(spareAuth);
          return uid;
        },
        collection: fsMod.collection, doc: fsMod.doc, query: fsMod.query, where: fsMod.where,
        orderBy: fsMod.orderBy, onSnapshot: fsMod.onSnapshot, getDocs: fsMod.getDocs, getDoc: fsMod.getDoc, getCountFromServer: fsMod.getCountFromServer,
        setDoc: fsMod.setDoc, updateDoc: fsMod.updateDoc, deleteDoc: fsMod.deleteDoc, writeBatch: fsMod.writeBatch,
        serverTimestamp: fsMod.serverTimestamp
      };
      fb.onAuthStateChanged(auth, onAuthChange);
    }catch(err){
      showGate('loading', "Couldn't connect. Check your internet connection, then reload the page.");
    }
  }

  loadData();
  loadCalcState();
  initCloud();
})();
