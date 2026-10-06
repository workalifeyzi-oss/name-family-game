// سرور بازی «اسم فامیل». بدون نیاز به نصب پکیج. اجرا: node server.js
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = +(process.env.PORT || 8080);
const LETTERS = [...'ابپتجچحخدرزسشعفقکگلمنوهی'];
const DEFAULT_CATS = ['اسم', 'فامیل', 'شهر', 'کشور', 'حیوان', 'غذا', 'رنگ', 'اشیا'];
const REVIEW_MS = 45000, COUNT_MS = 4000, GRACE_MS = 1500, STOP_MS = 10000;

const rooms = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');
const newCode = () => { let c; do c = String(Math.floor(1000 + Math.random() * 9000)); while (rooms.has(c)); return c; };

/* ---------- قواعد بازی ---------- */
function norm(s) {
  return String(s || '').replace(/[ً-ٰٟـ]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا').replace(/‌/g, ' ').replace(/\s+/g, ' ').trim();
}
// در دسته «اشیا» چیزهای پلاستیکی یا مصنوعی پذیرفته نمی‌شود
const OBJ_CATS = ['اشیا', 'اشیاء', 'شی', 'شیء', 'وسیله', 'وسایل'];
const BANNED = /پلاستیک|مصنوعی|نایلون|نایلکس|سینتتیک|پلیاتیلن|پلیاستر|پلیپروپیلن|اکریلیک|پلکسی|ترموپلاست/;
const isBanned = (cat, text) => OBJ_CATS.includes(norm(cat).replace(/ /g, '')) && BANNED.test(norm(text).replace(/ /g, ''));

/* دایره لغات فارسی (اختیاری): فایل words.txt کنار server.js، هر خط یک کلمه */
const DICT = new Set();
try {
  for (const line of fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8').split(/\r?\n/)) {
    const w = norm(line.split('/')[0]).replace(/ /g, ''); if (w) DICT.add(w);
  }
  console.log(`دایره لغات بارگذاری شد: ${DICT.size} کلمه`);
} catch { console.log('words.txt پیدا نشد؛ فقط تشخیص کلمه‌های ناقص و بی‌معنی ظاهری فعال است.'); }
const SUF1 = ['ها', 'های', 'هایی', 'ان', 'ات', 'ین', 'ی', 'ای', 'تر', 'ترین', 'ه'];
const SUF2 = ['م', 'ت', 'ش', 'مان', 'تان', 'شان', 'ام', 'ات', 'یم', 'ید', 'ند'];
function known(t, depth = 0) {
  if (DICT.has(t)) return true;
  if (depth > 1) return false;
  for (const s of [...SUF2, ...SUF1]) if (t.length > s.length + 1 && t.endsWith(s) && known(t.slice(0, -s.length), depth + 1)) return true;
  return false;
}
// 'blank' | 'bad:letter' | 'bad:banned' | 'bad:junk' | 'unknown' (در دایره لغات نیست) | 'ok'
function status(text, letter, cat) {
  const n = norm(text);
  if (!n) return 'blank';
  if (n[0] !== letter) return 'bad:letter';
  if (isBanned(cat, text)) return 'bad:banned';
  if (!/^[؀-ۿ ]+$/.test(n) || /[0-9۰-۹٠-٩]/.test(n)) return 'bad:junk';
  const toks = n.split(' ');
  for (const t of toks) {
    if (t.length < 2 && !(toks.length > 1 && t === 'و')) return 'bad:junk';
    if (/(.)\1\1/.test(t)) return 'bad:junk';
  }
  if (DICT.size && !DICT.has(toks.join('')) && !toks.every(t => known(t))) return 'unknown';
  return 'ok';
}
const isValid = (text, letter, cat) => status(text, letter, cat) === 'ok';
// «پر شده» یعنی با حرف درست شروع شده و ممنوع نیست؛ بی‌معنی بودن فقط روی امتیاز اثر دارد
const isFilled = (text, letter, cat) => { const n = norm(text); return n.length >= 2 && n[0] === letter && !isBanned(cat, text); };

/* امتیازدهی. حذف امتیاز فقط برای خود همان جواب است و به هیچ حریفی منتقل نمی‌شود.
   حذف فقط با انصراف خود بازیکن یا رضایت همه‌ی بقیه انجام می‌شود. */
function compute(room) {
  const ids = [...room.players.keys()], n = ids.length, out = {};
  ids.forEach(id => { out[id] = { total: 0, cats: {} }; });
  for (const cat of room.settings.cats) {
    const entries = ids.map(id => {
      const text = String(room.players.get(id).answers[cat] || '').trim();
      const st = status(text, room.letter, cat), k = cat + '|' + id;
      const vc = room.votes[k] ? room.votes[k].size : 0, all = n > 1 && vc >= n - 1, withdrawn = !!room.withdrawn[k];
      let present = st === 'ok', restored = false, rejected = false;
      if (st === 'unknown' && all) { present = true; restored = true; }
      if (present && (withdrawn || (st === 'ok' && all))) rejected = true;
      return { id, text, st, present, restored, rejected, withdrawn, vc, need: n - 1, pts: 0 };
    });
    // جواب ردشده همچنان در شمارش یکتا/تکراری می‌ماند تا امتیازش به حریف نرسد
    const live = entries.filter(e => e.present), groups = {};
    live.forEach(e => { const g = norm(e.text).replace(/ /g, ''); groups[g] = (groups[g] || 0) + 1; });
    live.forEach(e => {
      const base = live.length === 1 ? (n > 1 ? 15 : 10) : groups[norm(e.text).replace(/ /g, '')] === 1 ? 10 : 5;
      e.pts = e.rejected ? 0 : base;
    });
    entries.forEach(e => {
      out[e.id].cats[cat] = { text: e.text, status: e.st, present: e.present, restored: e.restored, rejected: e.rejected, withdrawn: e.withdrawn, vc: e.vc, need: e.need, pts: e.pts };
      out[e.id].total += e.pts;
    });
  }
  return out;
}

/* ---------- جریان بازی ---------- */
const clear = r => { clearTimeout(r.timer); r.timer = null; };
function after(r, ms, fn) { clear(r); r.timer = setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, Math.max(0, ms)); }

function startRound(r) {
  r.round++;
  const free = LETTERS.filter(l => !r.used.includes(l));
  r.letter = (free.length ? free : LETTERS)[Math.floor(Math.random() * (free.length ? free.length : LETTERS.length))];
  r.used.push(r.letter); r.votes = {}; r.withdrawn = {}; r.stopper = ''; r.last = null;
  r.players.forEach(p => { p.answers = {}; p.ready = false; });
  r.phase = 'countdown'; r.endsAt = Date.now() + COUNT_MS;
  after(r, COUNT_MS, () => beginPlay(r));
  push(r);
}
function beginPlay(r) {
  r.phase = 'play'; r.endsAt = Date.now() + r.settings.time * 1000;
  after(r, r.endsAt - Date.now() + GRACE_MS, () => endPlay(r));
  push(r);
}
function endPlay(r) {
  r.phase = 'review'; r.endsAt = Date.now() + REVIEW_MS;
  r.players.forEach(p => { p.ready = false; });
  after(r, REVIEW_MS, () => toScores(r));
  push(r);
}
function toScores(r) {
  if (r.phase !== 'review') return;
  clear(r);
  r.last = compute(r);
  r.players.forEach((p, id) => { p.score += r.last[id].total; p.gain = r.last[id].total; });
  r.phase = r.round >= r.settings.rounds ? 'final' : 'scores';
  push(r);
}

/* ---------- نمای هر بازیکن ---------- */
function view(r, pid) {
  const showAll = r.phase === 'review' || r.phase === 'scores' || r.phase === 'final';
  const res = r.phase === 'review' ? compute(r) : r.last;
  const me = r.players.get(pid);
  const players = [...r.players.entries()].map(([id, p]) => ({
    id, name: p.name, score: p.score, gain: p.gain || 0, connected: p.connected, ready: p.ready,
    filled: r.settings.cats.filter(c => isFilled(p.answers[c], r.letter, c)).length
  }));
  const v = { now: Date.now(), code: r.code, me: pid, host: r.host, phase: r.phase, round: r.round, letter: r.letter, endsAt: r.endsAt, settings: r.settings, stopper: r.stopper, players, myAnswers: me ? me.answers : {} };
  if (me && r.phase === 'play') {
    v.chk = {};
    for (const c of r.settings.cats) { const t = String(me.answers[c] || '').trim(); v.chk[c] = { s: status(t, r.letter, c), t }; }
  }
  if (showAll && res) {
    v.res = res;
    v.myVotes = {};
    for (const k in r.votes) if (r.votes[k].has(pid)) v.myVotes[k] = 1;
  }
  return v;
}
function push(r) {
  for (const c of r.clients) { try { c.res.write('data: ' + JSON.stringify(view(r, c.pid)) + '\n\n'); } catch {} }
}

/* ---------- اکشن‌ها ---------- */
function cleanName(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16); }
function cleanSettings(s, old) {
  const time = Math.min(180, Math.max(30, +s.time || old.time));
  const rounds = Math.min(15, Math.max(1, +s.rounds || old.rounds));
  let cats = Array.isArray(s.cats) ? [...new Set(s.cats.map(c => String(c).replace(/\s+/g, ' ').trim().slice(0, 16)).filter(Boolean))].slice(0, 12) : old.cats;
  if (cats.length < 3) cats = old.cats;
  return { time, rounds, cats };
}
function act(r, pid, a) {
  const p = r.players.get(pid); if (!p) throw new Error('بازیکن پیدا نشد');
  const host = r.host === pid;
  switch (a.type) {
    case 'settings':
      if (!host || r.phase !== 'lobby') throw new Error('فقط سازنده اتاق');
      r.settings = cleanSettings(a, r.settings); break;
    case 'start':
      if (!host || r.phase !== 'lobby') throw new Error('فقط سازنده اتاق');
      if (r.players.size < 2) throw new Error('حداقل دو بازیکن لازم است');
      r.round = 0; r.used = []; r.players.forEach(x => { x.score = 0; x.gain = 0; });
      startRound(r); return;
    case 'answers':
      if (r.phase !== 'play' || Date.now() > r.endsAt + GRACE_MS) return;
      for (const c of r.settings.cats) p.answers[c] = String((a.answers || {})[c] || '').slice(0, 30);
      break;
    case 'stop': {
      if (r.phase !== 'play') return;
      if (!r.settings.cats.every(c => isFilled(p.answers[c], r.letter, c))) throw new Error('اول همه را درست پر کن');
      const end = Math.min(r.endsAt, Date.now() + STOP_MS);
      r.endsAt = end; r.stopper = p.name;
      after(r, end - Date.now() + GRACE_MS, () => endPlay(r)); break;
    }
    case 'vote': {
      if (r.phase !== 'review') return;
      const cat = String(a.cat), tgt = String(a.target);
      if (!r.settings.cats.includes(cat) || tgt === pid || !r.players.has(tgt)) return;
      const k = cat + '|' + tgt; (r.votes[k] = r.votes[k] || new Set());
      a.on ? r.votes[k].add(pid) : r.votes[k].delete(pid); break;
    }
    case 'withdraw': { // انصراف خود بازیکن از امتیاز یک جواب
      if (r.phase !== 'review') return;
      const cat = String(a.cat); if (!r.settings.cats.includes(cat)) return;
      r.withdrawn[cat + '|' + pid] = !!a.on; break;
    }
    case 'ready':
      if (r.phase !== 'review') return;
      p.ready = true;
      if ([...r.players.values()].filter(x => x.connected).every(x => x.ready)) return toScores(r);
      break;
    case 'next':
      if (!host || r.phase !== 'scores') return;
      startRound(r); return;
    case 'restart':
      if (!host || r.phase !== 'final') return;
      clear(r); r.phase = 'lobby'; r.round = 0; r.used = []; r.letter = ''; r.players.forEach(x => { x.score = 0; x.gain = 0; x.answers = {}; }); break;
    default: throw new Error('نامعتبر');
  }
  push(r);
}

/* ---------- وب‌سرور ---------- */
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let s = ''; req.on('data', d => { s += d; if (s.length > 20000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { no(new Error('bad json')); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    if (req.method === 'GET' && p === '/events') {
      const r = rooms.get(u.searchParams.get('room')), pid = u.searchParams.get('pid');
      if (!r || !r.players.has(pid)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { pid, res }; r.clients.add(c);
      const pl = r.players.get(pid); pl.connected = true; r.empty = 0;
      if (!r.players.has(r.host) || !r.players.get(r.host).connected) r.host = pid;
      push(r);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
      req.on('close', () => {
        clearInterval(ka); r.clients.delete(c);
        if (![...r.clients].some(x => x.pid === pid)) {
          pl.connected = false;
          if (r.host === pid) { const nx = [...r.players.entries()].find(([, x]) => x.connected); if (nx) r.host = nx[0]; }
          if (r.phase === 'review' && [...r.players.values()].filter(x => x.connected).every(x => x.ready)) toScores(r); else push(r);
        }
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/create') {
      const b = await body(req), name = cleanName(b.name); if (!name) return json(res, 400, { error: 'اسمت را بنویس' });
      const code = newCode(), pid = rid(8);
      const r = { code, host: pid, players: new Map(), clients: new Set(), phase: 'lobby', round: 0, letter: '', used: [], endsAt: 0, votes: {}, withdrawn: {}, stopper: '', last: null, timer: null, empty: 0, settings: { time: 55, rounds: 5, cats: [...DEFAULT_CATS] } };
      r.players.set(pid, { name, score: 0, gain: 0, connected: false, answers: {}, ready: false });
      rooms.set(code, r); return json(res, 200, { code, pid });
    }
    if (req.method === 'POST' && p === '/api/join') {
      const b = await body(req), r = rooms.get(String(b.code || '').trim()), name = cleanName(b.name);
      if (!name) return json(res, 400, { error: 'اسمت را بنویس' });
      if (!r) return json(res, 404, { error: 'اتاقی با این کد نیست' });
      if (r.phase !== 'lobby') return json(res, 400, { error: 'بازی شروع شده است' });
      if (r.players.size >= 12) return json(res, 400, { error: 'اتاق پر است' });
      if ([...r.players.values()].some(x => x.name === name)) return json(res, 400, { error: 'این اسم قبلاً انتخاب شده' });
      const pid = rid(8); r.players.set(pid, { name, score: 0, gain: 0, connected: false, answers: {}, ready: false }); push(r);
      return json(res, 200, { code: r.code, pid });
    }
    if (req.method === 'POST' && p === '/api/act') {
      const b = await body(req), r = rooms.get(String(b.room));
      if (!r) return json(res, 404, { error: 'اتاق پیدا نشد' });
      try { act(r, String(b.pid), b); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\nاسم فامیل آماده است. این آدرس را در گوشی‌ها (همان وای‌فای) باز کنید:');
  ips.forEach(ip => console.log(`  http://${ip}:${PORT}`));
  console.log(`  http://localhost:${PORT}\n`);
});

setInterval(() => { for (const [c, r] of rooms) { if (r.clients.size === 0) { r.empty = (r.empty || 0) + 1; if (r.empty > 30) { clear(r); rooms.delete(c); } } } }, 60000);
