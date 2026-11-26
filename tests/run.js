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
  ].map(t => { const x = parseUPIReceipt(t); return { amount: x.amount, merchant: x.merchant, ref: x.ref }; }));
  assert.deepEqual(r[0], { amount: 450, merchant: 'Swiggy', ref: '123456789012' });
  assert.equal(r[1].amount, 1249.5);
  assert.equal(r[1].ref, '432198765432');
  assert.equal(r[2].amount, 3299);
  assert.equal(r[2].merchant, 'Amazon');
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
  assert.match(me, /Croma/, 'one-entry or merchant driver for shopping');
  assert.match(me, /Over budget|budget/, 'budget column shown');
  const cmp = await p.locator('#stsec-mcmp').innerText();
  assert.match(cmp, /THIS VS LAST MONTH/);
  await p.locator('#stsec-mcmp button:has-text("Full months")').click();
  assert.match(await p.locator('#stsec-mcmp').innerText(), /compared with/);
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
