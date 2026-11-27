// App tests: serve the repo, open index.html in headless Chromium, and check the parts that keep
// data and money right. Run with `npm test`.
//
// The CDN libraries (React, Recharts, SheetJS) load from the internet as in production. Where the
// CDNs are blocked, set ETP_LIBS_DIR to a folder holding the same files by name
// (react.production.min.js, react-dom.production.min.js, prop-types.min.js, Recharts.min.js,
// xlsx.full.min.js) and they are served from there.

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function routeLibs(ctx) {
  const dir = process.env.ETP_LIBS_DIR;
  if (!dir) return;
  await ctx.route(/^https:\/\/(cdnjs\.cloudflare\.com|unpkg\.com|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => {
    const name = r.request().url().split('/').pop().split('?')[0];
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return r.fulfill({ path: f, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 200, body: '', headers: { 'content-type': 'text/css', 'access-control-allow-origin': '*' } });
  });
}

// ---------- tiny runner ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let base, browser;
async function newPage({ seed } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  await routeLibs(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => { page.errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(base);
  await mounted(page);
  if (seed) { await page.evaluate(seedData, seed); await page.reload(); await mounted(page); }
  return page;
}
const mounted = page => page.waitForFunction(() => document.getElementById('root')?.firstChild, null, { timeout: 30000 }).then(() => page.waitForTimeout(800));
const stored = page => page.evaluate(async () => JSON.parse((await window.storage.get('etp-data-u_t')).value));

// Data used by several tests: two accounts, two cards, income and spending over three months.
async function seedData(extra) {
  const now = new Date(), D = (m, d) => new Date(now.getFullYear(), now.getMonth() + m, d, 12).getTime();
  const E = (id, amount, category, m, d, merchant, more = {}) => ({ id, type: 'expense', amount, category, date: D(m, Math.min(d, 28)), merchant, currency: '₹', accountId: 'acc_bank', ...more });
  const data = {
    accounts: [{ id: 'acc_default', name: 'Cash', type: 'cash', currency: '₹', emoji: '💵' }, { id: 'acc_bank', name: 'HDFC Savings', type: 'checking', currency: '₹', emoji: '🏦' }],
    cards: [{ id: 'cardA', name: 'HDFC Regalia', last4: '1234', limit: 200000 }, { id: 'cardB', name: 'SBI Cashback', last4: '9876', limit: 100000 }],
    expenses: [
      { ...E('i1', 80000, 'salary', 0, 1, 'Salary'), type: 'income' }, { ...E('i0', 78000, 'salary', -1, 1, 'Salary'), type: 'income' },
      E('a', 2400, 'food', 0, 1, 'Swiggy'), E('d', 5200, 'groceries', 0, 1, 'BigBasket'),
      E('s1', 650, 'food', -1, 3, 'Swiggy'), E('s2', 700, 'food', -1, 9, 'Swiggy'), E('s3', 620, 'food', -1, 15, 'Swiggy'), E('s4', 640, 'food', -1, 22, 'Swiggy'),
      E('m1', 9000, 'shopping', -1, 12, 'Croma'), E('e', 5000, 'groceries', -1, 1, 'BigBasket'),
      E('l', 4000, 'food', -2, 6, 'Cafe'), E('s5', 600, 'food', -2, 10, 'Swiggy'), E('k', 1000, 'shopping', -2, 5, 'Myntra'),
    ],
    recurring: [], currency: '₹', monthStartDay: 1, categoryBudgets: { groceries: { limit: 4000 } }, ...extra,
  };
  await window.storage.set('etp-users', JSON.stringify([{ id: 'u_t', name: 'Default', emoji: '👤', createdAt: 1 }]));
  localStorage.setItem('etp-active-user', 'u_t');
  await window.storage.set('etp-data-u_t', JSON.stringify(data));
}

// ---------- storage ----------
test('fresh install: app opens, data goes to IndexedDB, not localStorage', async () => {
  const p = await newPage();
  const r = await p.evaluate(async () => ({ idb: (await window.storage.list('')).keys, ls: Object.keys(localStorage) }));
  assert.ok(r.idb.includes('etp-users'), 'users in IndexedDB');
  assert.ok(r.idb.some(k => k.startsWith('etp-data-')), 'data in IndexedDB');
  assert.ok(!r.ls.some(k => k === 'etp-users' || k.startsWith('etp-data-')), 'no data keys left in localStorage');
  assert.deepEqual(p.errors, []);
});

test('old localStorage data is moved to IndexedDB intact and localStorage is freed', async () => {
  const p = await newPage();
  const data = { expenses: [{ id: 'x1', type: 'expense', amount: 199.499999, category: 'food', date: Date.now(), merchant: 'Cafe' }], accounts: [], currency: '₹' };
  await p.evaluate(async d => {
    indexedDB.deleteDatabase('etp-kv'); localStorage.clear();
    localStorage.setItem('expense-tracker-pro-v3', JSON.stringify(d));
    localStorage.setItem('etp-users', JSON.stringify([{ id: 'u_old', name: 'Default', emoji: '👤' }]));
    localStorage.setItem('etp-active-user', 'u_old');
    localStorage.setItem('etp-data-u_old', JSON.stringify(d));
  }, data);
  await p.reload(); await mounted(p);
  const r = await p.evaluate(async () => ({
    ls: Object.keys(localStorage), keys: (await window.storage.list('')).keys,
    amount: JSON.parse((await window.storage.get('etp-data-u_old')).value).expenses[0].amount,
  }));
  assert.ok(r.keys.includes('etp-data-u_old') && r.keys.includes('expense-tracker-pro-v3'));
  assert.ok(!r.ls.includes('etp-data-u_old') && !r.ls.includes('expense-tracker-pro-v3'), 'localStorage freed');
  assert.equal(r.ls.includes('etp-idb-v1'), true, 'migration marker set');
  assert.equal(r.amount, 199.5, 'amount rounded to paise on load');
  assert.deepEqual(p.errors, []);
});

// ---------- money ----------
test('money: rounding and totals without float drift', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => ({
    sum: [0.1, 0.2, 0.3].reduce((s, v) => _ad(s, v), 0),
    bad: [{ amount: 500 }, { amount: undefined }, { amount: 'x' }, { amount: 0.25 }].reduce((s, e) => _ad(s, e.amount), 0),
    r2: [_r2(1.234), _r2(-1.235), _r2(null)],
    norm: _normMoney({ expenses: [{ id: 1, amount: 10.006 }, { id: 2, amount: 3 }], bills: [{ amount: 1.111 }] }),
    same: (() => { const a = [{ amount: 1.5 }]; return _normMoney({ expenses: a }).expenses === a; })(),
  }));
  assert.equal(r.sum, 0.6);
  assert.equal(r.bad, 500.25, 'a missing or bad amount counts as 0');
  assert.deepEqual(r.r2, [1.23, -1.24, 0]);
  assert.deepEqual(r.norm.expenses.map(e => e.amount), [10.01, 3]);
  assert.equal(r.norm.bills[0].amount, 1.11);
  assert.equal(r.same, true, 'unchanged arrays keep their identity');
});

// ---------- recurring ----------
test('recurring: posts each due occurrence once, repeated runs add nothing', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => {
    _recCut = Infinity;
    const start = new Date(); start.setMonth(start.getMonth() - 2); start.setHours(12, 0, 0, 0);
    const rec = [{ id: 'rec_t', amount: 499, category: 'subscriptions', merchant: 'Netflix', frequency: 'monthly', nextDate: start.getTime() }];
    const a = pr(rec, []);
    const b = pr(a.updatedRecurring, a.newExpenses);
    const c = pr(rec, a.newExpenses); // same rule from scratch: ids already exist
    const dup = _dedupeRec([...a.newExpenses, { ...a.newExpenses[0] }, { id: 'other', amount: 1 }]);
    return { posted: a.newExpenses.length, again: b.newExpenses.length, fromScratch: c.newExpenses.length, dedupe: dup.length, unique: new Set(a.newExpenses.map(e => e.id)).size };
  });
  assert.ok(r.posted >= 2 && r.posted <= 3, 'two or three months due, got ' + r.posted);
  assert.equal(r.unique, r.posted);
  assert.equal(r.again, 0);
  assert.equal(r.fromScratch, 0);
  assert.equal(r.dedupe, r.posted + 1, 'duplicate rec_ entry removed, others kept');
});

// ---------- parsers ----------
test('UPI receipt: amount, merchant and reference', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => [
    '#TRACKERPRO-UPI\nPaid to\nSwiggy\n₹450\nCompleted\n26 Nov 2026, 1:15 pm\nUPI transaction ID\n123456789012\nHDFC Bank XX1234',
    'Payment Successful\nZomato Ltd\nRs. 1,249.50\nUPI Ref No: 432198765432\nFrom: State Bank of India - 5678',
    'Paid to\nAmazon\n3299\nSend money\nPhonePe',
    'Paid to\nAmazon\n3,299\nSend money\nPhonePe',
    'Kiwi\n7450\nSend Money\nTo Swiggy\nswiggy@icici',
    'Kiwi\n2450\nSend Money\nTo Swiggy\nAmount 2450',
    'Paid to\nSwiggy\n450₹\nCompleted',
  ].map(t => { const x = parseUPIReceipt(t); return { amount: x.amount, alt: x.alt, merchant: x.merchant, ref: x.ref }; }));
  assert.deepEqual(r[0], { amount: 450, alt: null, merchant: 'Swiggy', ref: '123456789012' });
  assert.equal(r[1].amount, 1249.5);
  assert.equal(r[1].ref, '432198765432');
  // No ₹ in the text and no comma: the ₹ was read as the leading 3 (₹299), the long reading kept as alt.
  assert.deepEqual([r[2].amount, r[2].alt], [299, 3299]);
  assert.equal(r[2].merchant, 'Amazon');
  assert.deepEqual([r[3].amount, r[3].alt], [3299, null], 'a comma means the number is real');
  assert.deepEqual([r[4].amount, r[4].alt], [450, 7450], '₹ read as 7');
  assert.deepEqual([r[5].amount, r[5].alt], [2450, 450], 'the same number elsewhere on the receipt wins');
  assert.deepEqual([r[6].amount, r[6].alt], [450, null], '₹ after the number');
});

test('voice amount and AI dates', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => ({
    v: ['rupees 1,200', '₹1,00,000 rent', '350 for lunch', '2.5k on shoes', 'paid 80 rs'].map(parseVoiceAmount),
    d: ['2026-10-05', '05/10/2026'].map(s => { const d = parseAIDate(s); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }),
  }));
  assert.deepEqual(r.v, [1200, 100000, 350, 2500, 80]);
  assert.deepEqual(r.d, ['2026-10-5', '2026-10-5']);
});

// ---------- reconciliation and review ----------
test('statement gap reasons', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => {
    const D = d => new Date(2026, 9, d, 12).getTime();
    const E = (id, amount, d, merchant, cardId) => ({ id, type: 'expense', amount, date: D(d), merchant, cardId, accountId: null });
    const expenses = [E('w', 1200, 10, 'Croma', 'cardB'), E('late', 799, 2, 'Netflix', 'cardA'), E('fx', 4100, 15, 'Amazon US', 'cardA'), E('d1', 450, 20, 'Swiggy', 'cardA'), E('d2', 450, 20, 'Swiggy', 'cardA'), E('end', 999, 30, 'Uber', 'cardA')];
    const ctx = { expenses, cardId: 'cardA', cards: [{ id: 'cardA', name: 'HDFC Regalia' }, { id: 'cardB', name: 'SBI Cashback' }], accounts: [], free: expenses.filter(e => e.cardId === 'cardA'), openTx: [{ date: D(14), amount: 4232.5, merchant: 'AMAZON US' }], stmtEnd: D(31), cu: '₹' };
    const tx = m => gapWhy('tx', m, ctx).tag, ex = id => gapWhy('ex', expenses.find(e => e.id === id), ctx).tag;
    return [tx({ merchant: 'GST on fees', amount: 18, date: D(5) }), tx({ merchant: 'CROMA RETAIL', amount: 1200, date: D(11) }), tx({ merchant: 'NETFLIX', amount: 799, date: D(8) }), tx({ merchant: 'AMAZON US', amount: 4232.5, date: D(14) }), tx({ merchant: 'Random', amount: 5555, date: D(3) }), ex('d1'), ex('end'), ex('fx')];
  });
  assert.deepEqual(r, ['BANK FEE', 'WRONG CARD?', 'DATE DIFFERS', 'AMOUNT DIFFERS', 'NOT LOGGED', 'DUPLICATE?', 'NEXT STATEMENT', 'AMOUNT DIFFERS']);
});

test('review marks: new AI entries need a look, edits and photo checks clear it', async () => {
  const p = await newPage();
  const r = await p.evaluate(() => {
    const a = { id: '1', source: 'upi', amount: 50, rv: 0 };
    return {
      fresh: _rvMark([], [{ id: '3', source: 'bill-scan', amount: 5 }, { id: '4', source: 'manual', amount: 1 }]).map(e => e.rv ?? null),
      amountEdit: _rvMark([a], [{ ...a, amount: 500 }])[0].rv,
      noteEdit: _rvMark([a], [{ ...a, note: 'x' }])[0].rv,
      photo: _rvMark([a], [{ ...a, stmtVerified: true }])[0].rv,
    };
  });
  assert.deepEqual(r, { fresh: [0, null], amountEdit: 1, noteEdit: 0, photo: 1 });
});

test('pasted statement CSV: matching, reasons, Log all and the Review card', async () => {
  const p = await newPage({ seed: {} });
  await p.evaluate(async () => {
    const g = JSON.parse((await window.storage.get('etp-data-u_t')).value), D = d => new Date(2026, 9, d, 12).getTime();
    g.expenses.push({ id: 'w', type: 'expense', amount: 1200, date: D(10), merchant: 'Croma', cardId: 'cardB', category: 'shopping' }, { id: 'ok', type: 'expense', amount: 250, date: D(18), merchant: 'Starbucks', cardId: 'cardA', category: 'food' });
    await window.storage.set('etp-data-u_t', JSON.stringify(g));
  });
  await p.reload(); await mounted(p);
  await p.locator('button').first().click();
  await p.locator('text=Statement Analyzer').first().click();
  await p.locator('button:has-text("Paste CSV")').click();
  await p.locator('textarea').first().fill('Date,Description,Amount\n2026-10-05,GST on fees,18\n2026-10-11,CROMA RETAIL,1200\n2026-10-18,STARBUCKS,250\n2026-10-25,Random Store,5555');
  await p.locator('button:has-text("Parse CSV text")').click();
  await p.locator('button:has-text("HDFC Regalia")').first().click();
  await p.waitForTimeout(800);
  const text = await p.locator('#root').innerText();
  for (const tag of ['BANK FEE', 'WRONG CARD?', 'NOT LOGGED']) assert.ok(text.includes(tag), 'shows ' + tag);
  await p.locator('button:has-text("Log all")').click();
  await p.waitForTimeout(800);
  const logged = (await stored(p)).expenses.filter(e => e.source === 'statement');
  assert.equal(logged.length, 3, 'three unmatched lines logged');
  assert.ok(logged.every(e => e.rv === 0), 'statement entries need a look');
  await p.goto(base); await mounted(p);
  assert.match(await p.locator('text=/entries need a look/').innerText(), /^3 entries need a look/);
  assert.deepEqual(p.errors, []);
});

// ---------- screens ----------
test('Stats: month-end report and this-vs-last-month render with drivers', async () => {
  const p = await newPage({ seed: {} });
  await p.goto(base + '?view=stats'); await mounted(p);
  const me = await p.locator('#stsec-monthend').innerText();
  assert.match(me, /MONTH-END REPORT/);
  assert.doesNotMatch(me, /WHAT MOVED/, 'starts minimised: summary only');
  await p.locator('#stsec-monthend button:has-text("Show what moved")').click();
  const meFull = await p.locator('#stsec-monthend').innerText();
  assert.match(meFull, /WHAT MOVED/);
  assert.match(meFull, /Croma/, 'one-entry or merchant driver for shopping');
  assert.match(meFull, /Over budget|budget/, 'budget column shown');
  const cmp = await p.locator('#stsec-mcmp').innerText();
  assert.match(cmp, /THIS VS LAST MONTH/);
  await p.locator('#stsec-mcmp button:has-text("Full months")').click();
  assert.match(await p.locator('#stsec-mcmp').innerText(), /compared with/);
  assert.deepEqual(p.errors, []);
});

test('UPI receipt: a dot on + instead of a pop-up, the option sits in the + menu', async () => {
  const p = await newPage({ seed: {} });
  assert.equal(await p.locator('button:has-text("Add from UPI receipt")').count(), 0, 'no floating button on open');
  assert.equal(await p.locator('.nb-dot').count(), 1, 'dot on +');
  await p.locator('.nb-fab').click();
  await p.waitForTimeout(300);
  assert.equal(await p.locator('.nb-pop:has-text("UPI")').count(), 1, 'UPI option in the + menu');
  assert.equal(await p.locator('.nb-dot').count(), 0, 'dot cleared once seen');
  await p.locator('.nb-pop:has-text("add")').first().click();
  await p.waitForTimeout(400);
  assert.equal(await p.locator('button:has-text("From UPI receipt")').count(), 1, 'small chip on the Add screen');
  assert.deepEqual(p.errors, []);
});

test('Goal Investing: manual target and log, % done / left, saved', async () => {
  const p = await newPage({ seed: {} });
  await p.locator('button[aria-label="calc"]').click();
  await p.waitForTimeout(400);
  await p.locator('button:has-text("Goal Investing")').click();
  await p.waitForTimeout(400);
  await p.locator('button:has-text("New goal")').first().click();
  await p.locator('input[placeholder="e.g. House down payment"]').fill('House');
  const nums = p.locator('input[inputmode="decimal"]');
  await nums.nth(0).fill('100000');
  await nums.nth(1).fill('25000');
  await p.locator('button:has-text("Create goal")').click();
  await p.waitForTimeout(400);
  let txt = await p.locator('#root').innerText();
  assert.match(txt, /25%/); assert.match(txt, /75% left/); assert.match(txt, /₹75,000\b/);
  await p.locator('button:has-text("Add money")').first().click();
  await p.locator('input[inputmode="decimal"]').first().fill('15000');
  await p.locator('button:has-text("Save")').last().click();
  await p.waitForTimeout(400);
  await p.locator('button:has-text("Withdraw")').click();
  await p.locator('input[inputmode="decimal"]').first().fill('5000');
  await p.locator('button:has-text("Save")').last().click();
  await p.waitForTimeout(600);
  txt = await p.locator('#root').innerText();
  assert.match(txt, /35%/, '25k + 15k − 5k of 1L'); assert.match(txt, /65% left/); assert.match(txt, /₹65,000\b/);
  const g = (await stored(p)).goalInvest;
  assert.equal(g.length, 1);
  assert.equal(g[0].target, 100000);
  assert.deepEqual(g[0].entries.map(e => [e.kind, e.amount]).sort(), [['in', 15000], ['in', 25000], ['out', 5000]]);
  assert.deepEqual(p.errors, []);
});

// ---------- bank statement ----------
// Five transactions laid out the way each bank prints them; opening balance 50,000.
const BS_TX = [
  [1, 'UPI/DR/412345678901/SWIGGY/YESB/swiggy@yesbank/Payment from Phone', 450, 0, 49550],
  [2, 'NEFT CR-HDFC0000123-ACME TECHNOLOGIES PVT LTD-SALARY NOV 2026', 0, 80000, 129550],
  [5, 'ACH D- BAJAJ FINANCE LTD-P400ABC123456', 12345, 0, 117205],
  [7, 'NACH-DR-ZERODHA BROKING LTD-SIP MANDATE 77821', 5000, 0, 112205],
  [10, 'INT.PD:01-08-2026 TO 31-10-2026', 0, 312.5, 112517.5],
];
const inr = n => n ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const BS_BANK_LAYOUTS = {
  SBI: { title: 'State Bank of India', head: ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'], date: d => `${d} Nov 2026`, row: (t, D) => [D, D, t[1], '', inr(t[2]), inr(t[3]), inr(t[4])], newestFirst: true },
  HDFC: { title: 'HDFC BANK Ltd.', head: ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'], date: d => `${String(d).padStart(2, '0')}/11/26`, row: (t, D) => [D, t[1], '0000412345', D, inr(t[2]), inr(t[3]), inr(t[4])] },
  ICICI: { title: 'ICICI Bank Limited', head: ['S No.', 'Value<br>Date', 'Transaction<br>Date', 'Cheque<br>Number', 'Transaction<br>Remarks', 'Withdrawal Amount<br>(INR )', 'Deposit Amount<br>(INR )', 'Balance<br>(INR )'], date: d => `${String(d).padStart(2, '0')}/11/2026`, row: (t, D, i) => [String(i + 1), D, D, '', t[1], inr(t[2]), inr(t[3]), inr(t[4])] },
  Axis: { title: 'Axis Bank Ltd', head: ['Tran Date', 'Chq No', 'Particulars', 'Debit', 'Credit', 'Balance', 'Init. Br'], date: d => `${String(d).padStart(2, '0')}-11-2026`, row: (t, D) => [D, '', t[1], inr(t[2]), inr(t[3]), inr(t[4]), '1234'] },
  'IDFC FIRST': { title: 'IDFC FIRST Bank', head: ['Transaction Date', 'Value Date', 'Particulars', 'Cheque No.', 'Debit', 'Credit', 'Balance'], date: d => `${String(d).padStart(2, '0')}-${MON[10]}-2026`, row: (t, D) => [D, D, t[1], '', inr(t[2]), inr(t[3]), inr(t[4])] },
};
function bankHtml(L) {
  const list = L.newestFirst ? [...BS_TX].reverse() : BS_TX;
  const td = c => `<td>${c}</td>`;
  return `<html><body style="font-family:Arial;font-size:9px;margin:20px"><h3>${L.title}</h3><p>Account Statement for 01/11/2026 to 30/11/2026</p><p>Opening Balance : 50,000.00</p>
  <table style="border-collapse:collapse;width:100%"><colgroup>${L.head.map(h => `<col style="width:${/Narr|Desc|Partic|Remarks/.test(h) ? '30%' : 'auto'}">`).join('')}</colgroup>
  <tr>${L.head.map(h => `<th style="text-align:left;padding:3px">${h}</th>`).join('')}</tr>
  ${list.map((t, i) => `<tr style="vertical-align:top">${L.row(t, L.date(t[0]), i).map(c => `<td style="padding:3px">${c}</td>`).join('')}</tr>`).join('')}
  </table><p>Closing Balance : 1,12,517.50</p><p>Page 1 of 1 · This is a computer generated statement</p></body></html>`;
}

test('bank statement PDF: SBI, HDFC, ICICI, Axis and IDFC FIRST layouts', async () => {
  const p = await newPage();
  const maker = await p.context().newPage();
  for (const [bank, L] of Object.entries(BS_BANK_LAYOUTS)) {
    await maker.setContent(bankHtml(L));
    const pdf = (await maker.pdf({ format: 'A4' })).toString('base64');
    const r = await p.evaluate(async b64 => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const r = await bsParsePdf(u.buffer);
      if (r.err) return { err: r.err };
      const tx = [...r.tx].sort((a, b) => a.date - b.date);
      return { bank: r.bank, closing: r.closing, tx: tx.map(x => [new Date(x.date).getDate(), x.amount, x.dir, bsPayee(x.nar), bsKind(x, { accounts: [], cards: [] }), x.bal]), nar0: tx[0].nar };
    }, pdf);
    assert.equal(r.err, undefined, bank + ': ' + r.err);
    assert.equal(r.bank, bank, bank + ' detected');
    assert.equal(r.closing, 112517.5, bank + ' closing balance');
    assert.deepEqual(r.tx, [
      [1, 450, 'dr', 'Swiggy', 'spend', 49550],
      [2, 80000, 'cr', 'Acme Technologies PVT LTD', 'salary', 129550],
      [5, 12345, 'dr', 'Bajaj Finance LTD', 'emi', 117205],
      [7, 5000, 'dr', 'Zerodha Broking LTD', 'invest', 112205],
      [10, 312.5, 'cr', 'Interest', 'interest', 112517.5],
    ], bank + ' rows');
    assert.match(r.nar0, /Payment from Phone/, bank + ': wrapped narration kept whole');
  }
  assert.deepEqual(p.errors, []);
});

test('bank statement: import CSV, confirm matches, add lines, link investment, undo', async () => {
  const p = await newPage({ seed: {} });
  const now = new Date(), D = d => { const x = new Date(now.getFullYear(), now.getMonth(), d); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; };
  const csv = ['HDFC BANK Ltd. Statement', 'Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    `${D(1)},UPI-SWIGGY-SWIGGY@ICICI-ICIC0001-412345678901-PAYMENT,"2,400.00",,"47,600.00"`,
    `${D(1)},NEFT CR-HDFC0000123-ACME CORP-SALARY,,"80,000.00","1,27,600.00"`,
    `${D(2)},UPI-CHAI POINT-CHAIPOINT@YBL-YESB0001-412345678902-PAYMENT,999.00,,"1,26,601.00"`,
    `${D(3)},NACH-DR-ZERODHA BROKING LTD-SIP 77821,"5,000.00",,"1,21,601.00"`,
    `${D(4)},INT.PD:01-08-2026 TO 31-10-2026,,312.50,"1,21,913.50"`].join('\n');
  await p.locator('button[aria-label="calc"]').click(); await p.waitForTimeout(400);
  await p.locator('button:has-text("Bank Statement")').click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Import statement")').first().click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("HDFC Savings")').click();
  await p.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: 'hdfc.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p.locator('text=5 transactions found').waitFor();
  await p.locator('button:has-text("Review 5 lines")').click(); await p.waitForTimeout(400);
  // Suggestions are only suggestions: nothing is saved until confirmed.
  assert.equal((await stored(p)).bankStmts[0].rows.filter(r => r.st === 'open').length, 5);
  await p.locator('button:has-text("Confirm all 2 suggested matches")').click(); await p.waitForTimeout(300);
  const row = name => p.locator('[data-bsrow="open"]').filter({ hasText: name });
  await row('Chai Point').locator('button:has-text("Add expense")').click();
  await p.locator('button:has-text("Add expense")').last().click(); await p.waitForTimeout(300);
  await row('Zerodha').locator('button:has-text("Add to investment")').click();
  await p.locator('button:has-text("Create holding")').click(); await p.waitForTimeout(300);
  await row('Interest').locator('button:has-text("Add income")').click();
  await p.locator('button:has-text("Add income")').last().click(); await p.waitForTimeout(500);
  assert.match(await p.locator('#root').innerText(), /Nothing left to review/);
  let d = await stored(p);
  const rows = d.bankStmts[0].rows, by = k => rows.find(r => r.payee.includes(k));
  assert.deepEqual(rows.map(r => r.st), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(by('Swiggy').how, 'match'); assert.equal(by('Swiggy').eid, 'a');
  assert.equal(by('Acme').how, 'match'); assert.equal(by('Acme').eid, 'i1');
  const chai = d.expenses.find(e => e.id === by('Chai').eid);
  assert.deepEqual([chai.type, chai.amount, chai.accountId, chai.merchant], ['expense', 999, 'acc_bank', 'Chai Point']);
  const inv = d.investments.find(i => i.id === by('Zerodha').ext.invId);
  assert.deepEqual([inv.invested, inv.type], [5000, 'mf'], 'a SIP is a mutual fund');
  assert.equal(d.expenses.find(e => e.id === by('Zerodha').eid).type, 'transfer-out', 'investment leaves the account as a transfer, not spending');
  assert.equal(d.expenses.find(e => e.id === by('Interest').eid).category, 'interest');
  // Undo puts everything back.
  await p.locator('button:has-text("Done")').first().click(); await p.waitForTimeout(200);
  await p.locator('[data-bsrow="done"]').filter({ hasText: 'Zerodha' }).locator('button:has-text("Undo")').click(); await p.waitForTimeout(400);
  d = await stored(p);
  assert.equal(d.investments.length, 0, 'holding removed');
  assert.ok(!d.expenses.some(e => e.invId), 'transfer removed');
  assert.equal(d.bankStmts[0].rows.find(r => r.payee.includes('Zerodha')).st, 'open');
  assert.deepEqual(p.errors, []);
});

test('Zerodha Portfolio: funds log, equity tradebook, holdings, closed trade with charges, notes', async () => {
  const p = await newPage({ seed: {} });
  await p.locator('button[aria-label="Wealth Tracker"]').click(); await p.waitForTimeout(400);
  await p.locator('button:has-text("Zerodha Portfolio")').click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Funds")').first().click();
  await p.locator('button:has-text("Add funds / withdrawal")').click();
  await p.locator('input[inputmode="decimal"]').first().fill('100000');
  await p.locator('button:has-text("Save")').last().click(); await p.waitForTimeout(300);
  const tb = ['symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time',
    'TCS,INE467B01029,2026-01-05,NSE,EQ,EQ,buy,false,10,3500,1,11,2026-01-05T10:00:00',
    'TCS,INE467B01029,2026-02-10,NSE,EQ,EQ,buy,false,10,3300,2,12,2026-02-10T10:00:00',
    'TCS,INE467B01029,2026-03-02,NSE,EQ,EQ,sell,false,20,3800,3,13,2026-03-02T10:00:00',
    'INFY,INE009A01021,2026-05-04,NSE,EQ,EQ,buy,false,20,1500,4,14,2026-05-04T10:00:00',
    'NIFTY2560524750PE,,2026-06-02,NSE,FO,,sell,false,75,326.8,5,15,2026-06-02T09:21:55'].join('\n');
  await p.locator('button:has-text("Holdings")').first().click();
  await p.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({ name: 'tradebook-EQ.csv', mimeType: 'text/csv', buffer: Buffer.from(tb) });
  await p.locator('text=/4 trades added.*1 F&O rows left out/').waitFor();
  // Import again: nothing doubles up.
  await p.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({ name: 'tradebook-EQ.csv', mimeType: 'text/csv', buffer: Buffer.from(tb) });
  await p.locator('text=/0 trades added, 4 already here/').waitFor();
  let txt = await p.locator('#root').innerText();
  assert.match(txt, /INFY/); assert.doesNotMatch(txt, /TCS/, 'TCS fully sold, so not a holding');
  await p.locator('button:has-text("INFY")').click();
  await p.locator('button:has-text("Positional")').last().click();
  const inputs = p.locator('input[inputmode="decimal"]');
  await inputs.nth(0).fill('1650'); await inputs.nth(1).fill('1400'); await inputs.nth(2).fill('1800');
  assert.match(await p.locator('text=/R:R 1:/').innerText(), /R:R 1:3\.0/);
  await p.locator('button:has-text("Save")').last().click(); await p.waitForTimeout(300);
  txt = await p.locator('#root').innerText();
  assert.match(txt, /\+₹3,000 \(10\.0%\)/, 'unrealised on INFY at 1650');
  await p.locator('button:has-text("Closed")').click(); await p.waitForTimeout(200);
  await p.locator('button:has-text("TCS")').click(); await p.waitForTimeout(200);
  const sheet = await p.locator('body').innerText();
assert.match(sheet, /Profit before charges\s*\+₹8,000/); assert.match(sheet, /STT/); assert.match(sheet, /DP charges/);
  await p.locator('button:has-text("Breakout")').click(); await p.locator('button:has-text("Sold too early")').click();
  await p.locator('button:has-text("Save")').last().click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Overview")').click(); await p.waitForTimeout(200);
  assert.match(await p.locator('#root').innerText(), /CAPITAL\s*₹100,000/);
  const zj = (await stored(p)).zjournal;
  assert.equal(zj.fills.length, 4); assert.equal(zj.funds[0].amount, 100000);
  assert.deepEqual(zj.meta.INFY, { type: 'swing', target: 1800, sl: 1400, plan: '' });
  const tcs = Object.entries(zj.notes)[0][1];
  assert.deepEqual([tcs.tags, tcs.mistakes], [['Breakout'], ['Sold too early']]);
  assert.deepEqual(p.errors, []);
});

test('Home header: pie chart opens Wealth Tracker (loans, reinvest, Zerodha); search on other screens', async () => {
  const p = await newPage({ seed: {} });
  assert.equal(await p.locator('button[aria-label="Search"]').count(), 0, 'no search on Home');
  await p.locator('button[aria-label="Wealth Tracker"]').click(); await p.waitForTimeout(400);
  const txt = await p.locator('#root').innerText();
  for (const k of ['Wealth Tracker', 'Zerodha Portfolio', 'Loan Tracker', 'Reinvestments']) assert.match(txt, new RegExp(k));
  assert.equal(await p.locator('button[aria-label="Search"]').count(), 1, 'search back off Home');
  await p.locator('button[aria-label="calc"]').click(); await p.waitForTimeout(300);
  const calc = await p.locator('#root').innerText();
  assert.doesNotMatch(calc, /Zerodha Portfolio|Loan Tracker/, 'moved out of Calculators');
  assert.match(calc, /Bank Statement/);
  assert.deepEqual(p.errors, []);
});

test('Bank Statement ↔ Zerodha funds: link instead of duplicate, pull the rest, totals, undo', async () => {
  const now = new Date(), D = d => new Date(now.getFullYear(), now.getMonth(), d, 12).getTime();
  const p = await newPage({ seed: { zjournal: { fills: [], funds: [{ id: 'mine', kind: 'in', amount: 20000, date: D(3), note: 'typed by me' }], mf: [], meta: {}, prices: {}, notes: {} } } });
  const Ds = d => { const x = new Date(D(d)); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; };
  const csv = ['Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    `${Ds(2)},NEFT-ZERODHA BROKING LTD-PAYIN,"20,000.00",,"30,000.00"`,
    `${Ds(4)},IMPS-ZERODHA BROKING-FUNDS,"5,000.00",,"25,000.00"`,
    `${Ds(6)},NEFT CR-ZERODHA BROKING LTD-PAYOUT,,"3,000.00","28,000.00"`].join('\n');
  await p.locator('button[aria-label="calc"]').click(); await p.waitForTimeout(400);
  await p.locator('button:has-text("Bank Statement")').click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Import statement")').first().click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("HDFC Savings")').click();
  await p.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: 'hdfc.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p.locator('button:has-text("Review 3 lines")').click(); await p.waitForTimeout(400);
  const row = t => p.locator('[data-bsrow="open"]').filter({ hasText: t });
  assert.match(await row('20,000').innerText(), /Already in your Zerodha funds log/);
  await row('20,000').locator('button:has-text("Link")').click(); await p.waitForTimeout(300);
  let zj = (await stored(p)).zjournal;
  assert.equal(zj.funds.length, 1, 'linked, not duplicated'); assert.ok(zj.funds[0].src);
  // The rest from the Zerodha side.
  await p.locator('button[aria-label="back"]').first().click(); await p.waitForTimeout(200);
  await p.locator('button[aria-label="back"]').first().click(); await p.waitForTimeout(200);
  await p.goto(base); await mounted(p);
  await p.locator('button[aria-label="Wealth Tracker"]').click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Zerodha Portfolio")').click(); await p.waitForTimeout(300);
  await p.locator('button:has-text("Funds")').first().click(); await p.waitForTimeout(200);
  assert.match(await p.locator('#root').innerText(), /2 NOT IN THE LOG/);
  await p.locator('button:has-text("Add all")').click(); await p.waitForTimeout(400);
  const txt = await p.locator('#root').innerText();
  assert.match(txt, /matches your bank statements/);
  zj = (await stored(p)).zjournal;
  assert.deepEqual(zj.funds.map(f => [f.kind, f.amount]).sort(), [['in', 20000], ['in', 5000], ['out', 3000]]);
  // Deleting a funds entry that came from the bank reopens the bank line.
  await p.locator('button:has-text("Withdrawn to bank")').click();
  await p.locator('button:has-text("Delete")').click(); await p.waitForTimeout(300);
  const d = await stored(p);
  assert.equal(d.zjournal.funds.length, 2);
  assert.equal(d.bankStmts[0].rows.find(r => r.dir === 'cr').st, 'open');
  assert.deepEqual(p.errors, []);
});

test('fonts: optional Settings fonts load only when needed', async () => {
  const p = await newPage();
  const links = () => p.evaluate(() => [...document.querySelectorAll('link[href*="fonts.googleapis.com/css2"]')].map(l => l.href).join(' '));
  assert.doesNotMatch(await links(), /Roboto|Lato|Playfair|DM\+Serif/, 'not loaded on a normal open');
  await p.locator('button').first().click();
  await p.locator('text=/^Settings$/').first().click();
  await p.waitForTimeout(500);
  assert.match(await links(), /Roboto.*Lato|Lato.*Roboto/, 'loaded when Settings opens');
  assert.deepEqual(p.errors, []);
});

test('offline: after one online visit the app opens without network', async () => {
  const p = await newPage();
  await p.reload(); await mounted(p);
  await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
  await p.waitForTimeout(1500); // let the install-time cache finish
  await p.context().setOffline(true);
  await p.reload(); await mounted(p);
  assert.deepEqual(p.errors, []);
});

// ---------- main ----------
(async () => {
  const srv = await serve();
  base = `http://localhost:${srv.address().port}/`;
  browser = await chromium.launch();
  const only = process.argv[2];
  let failed = 0;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const t0 = Date.now();
    try { await t.fn(); console.log(`✓ ${t.name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`✗ ${t.name}\n  ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n  ')}`); }
    for (const c of browser.contexts()) await c.close();
  }
  await browser.close(); srv.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
