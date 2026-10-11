(() => {
'use strict';

/* ================= 定数 ================= */
const SITE_URL = location.origin + location.pathname.replace(/index\.html$/, '');
const HASHTAG = 'デザイナーの発想';
const COLORS = [
  { name: '朱',   v: '#E2462F' },
  { name: '藍',   v: '#23446B' },
  { name: '山吹', v: '#F2B01E' },
  { name: '若竹', v: '#4E9A6A' },
  { name: '空',   v: '#6FB7D9' },
  { name: '桃',   v: '#EE9CA7' },
  { name: '菫',   v: '#7A5C9E' },
  { name: '栗',   v: '#8B5A3C' },
  { name: '墨',   v: '#2A2520' },
  { name: '生成', v: '#F6F1E7' },
];
const DEFAULT_BG = '#F6F1E7';
const NEW_COLORS = ['#E2462F', '#23446B', '#F2B01E', '#4E9A6A', '#2A2520'];
const STORE_KEY = 'dhassou_works_v1';

/* ================= 日付とお題 ================= */
function jstToday() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD（日本時間）
}
function dayNumber(dateStr) {
  const ms = Date.parse(dateStr + 'T00:00:00Z') - Date.parse(EPOCH + 'T00:00:00Z');
  return Math.max(1, Math.floor(ms / 864e5) + 1);
}
// 決まった並びでシャッフル（全員が同じ日に同じお題）
function seeded(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}
function dailyOdai(no) {
  if (no === 1) return ODAI[0];
  const n = ODAI.length - 1;
  const i = no - 2;
  const cycle = Math.floor(i / n);
  const rand = seeded(20261011 + cycle * 7919);
  const order = Array.from({ length: n }, (_, k) => k + 1);
  for (let k = n - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
  return ODAI[order[i % n]];
}
function fmtDate(s) { return s.replace(/-/g, '.'); }

/* ================= 保存 ================= */
function loadWorks() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function saveWork(work) {
  try {
    const list = loadWorks().filter(w => !(work.no && w.no === work.no));
    list.unshift(work);
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 60)));
  } catch { /* 保存できなくてもゲームは続ける */ }
}

/* ================= 画面切り替え ================= */
const $ = s => document.querySelector(s);
function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function othersUrl(no, word) {
  const q = no ? `#${HASHTAG} No.${no}` : `#${HASHTAG} ${word}`;
  return 'https://x.com/search?f=live&q=' + encodeURIComponent(q);
}

/* ================= 形の描画（SVG / Canvas 共通） ================= */
const TRI = [[0, -50], [50, 50], [-50, 50]];
function shapeSVG(s, attrs = '') {
  const t = `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) rotate(${s.r.toFixed(1)}) scale(${(s.f * s.w / 100).toFixed(4)} ${(s.h / 100).toFixed(4)})`;
  const common = `transform="${t}" fill="${s.c}" ${attrs}`;
  if (s.t === 'circle') return `<circle r="50" ${common}/>`;
  if (s.t === 'square') return `<rect x="-50" y="-50" width="100" height="100" ${common}/>`;
  return `<polygon points="${TRI.map(p => p.join(',')).join(' ')}" ${common}/>`;
}
function workSVG(work, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="c"><rect width="1000" height="1000"/></clipPath></defs><rect width="1000" height="1000" fill="${work.bg}"/><g clip-path="url(#c)">${work.shapes.map(s => shapeSVG(s)).join('')}</g></svg>`;
}
function drawShape(ctx, s) {
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.r * Math.PI / 180);
  ctx.scale(s.f * s.w / 100, s.h / 100);
  ctx.fillStyle = s.c;
  ctx.beginPath();
  if (s.t === 'circle') ctx.arc(0, 0, 50, 0, Math.PI * 2);
  else if (s.t === 'square') ctx.rect(-50, -50, 100, 100);
  else { ctx.moveTo(...TRI[0]); ctx.lineTo(...TRI[1]); ctx.lineTo(...TRI[2]); ctx.closePath(); }
  ctx.fill();
  ctx.restore();
}

/* ================= エディタの状態 ================= */
let session = null;   // { no, word, rule, date, practice }
let state = null;     // { shapes: [], bg }
let selId = null;
let colorTarget = 'piece';
let undoStack = [];
let nextId = 1;

const board = $('#board');
const piecesG = $('#pieces');
const uiG = $('#ui');
const bgRect = $('#bg');

function rule() { return RULES[session.rule]; }
function sel() { return state.shapes.find(s => s.id === selId) || null; }
function snapshot() { return JSON.stringify({ shapes: state.shapes, bg: state.bg }); }
function pushUndo(prev) {
  undoStack.push(prev);
  if (undoStack.length > 80) undoStack.shift();
  updateUndo();
}
function updateUndo() { $('#edUndo').disabled = undoStack.length === 0; }

function openEditor(odai, opts) {
  session = { word: odai.word, rule: odai.rule, no: opts.no || null, date: opts.date || null, practice: !!opts.practice };
  const saved = opts.work;
  state = saved ? { shapes: saved.shapes.map(s => ({ ...s })), bg: saved.bg } : { shapes: [], bg: DEFAULT_BG };
  nextId = state.shapes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  selId = null;
  undoStack = [];
  colorTarget = 'piece';
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.target === 'piece'));
  $('#edWord').textContent = session.word;
  $('#edRule').textContent = (session.practice ? '練習｜' : `No.${session.no}｜`) + rule().label;
  document.querySelectorAll('[data-add]').forEach(b => { b.hidden = !rule().shapes.includes(b.dataset.add); });
  updateUndo();
  render();
  show('editor');
}

/* ---------- 描画 ---------- */
function render() {
  bgRect.setAttribute('fill', state.bg);
  piecesG.innerHTML = state.shapes.map(s => shapeSVG(s, `data-id="${s.id}" filter="url(#paper)"`)).join('');
  renderSelection();
  renderTools();
  $('#hint').hidden = state.shapes.length > 0;
}

function localToBoard(s, lx, ly) {
  const a = s.r * Math.PI / 180;
  const x = lx * s.f, y = ly; // 反転は見た目だけなので枠は対称
  return [s.x + x * Math.cos(a) - y * Math.sin(a), s.y + x * Math.sin(a) + y * Math.cos(a)];
}
function renderSelection() {
  const s = sel();
  if (!s) { uiG.innerHTML = ''; return; }
  const hw = s.w / 2, hh = s.h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => localToBoard(s, x, y));
  const top = localToBoard(s, 0, -hh);
  const rot = localToBoard(s, 0, -hh - 80);
  const sc = corners[2];
  uiG.innerHTML = `
    <polygon points="${corners.map(p => p.join(',')).join(' ')}" fill="none" stroke="#2A2520" stroke-width="3" stroke-dasharray="12 9" pointer-events="none"/>
    <line x1="${top[0]}" y1="${top[1]}" x2="${rot[0]}" y2="${rot[1]}" stroke="#2A2520" stroke-width="3" pointer-events="none"/>
    <g data-handle="rotate" transform="translate(${rot[0]} ${rot[1]})" style="cursor:grab">
      <circle r="64" fill="transparent"/>
      <circle r="34" fill="#FBF8F2" stroke="#2A2520" stroke-width="4"/>
      <g transform="scale(1.3)">
        <path d="M-11 -4 A12 12 0 1 1 -4 11" fill="none" stroke="#2A2520" stroke-width="3.5" stroke-linecap="round"/>
        <path d="M-17 -10 L-11 -3 L-4 -9" fill="none" stroke="#2A2520" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </g>
    <g data-handle="scale" transform="translate(${sc[0]} ${sc[1]})" style="cursor:nwse-resize">
      <circle r="64" fill="transparent"/>
      <circle r="28" fill="#2A2520" stroke="#FBF8F2" stroke-width="5"/>
    </g>`;
}

function renderTools() {
  const r = rule();
  const n = state.shapes.length;
  const full = n >= r.max;
  document.querySelectorAll('[data-add]').forEach(b => { b.disabled = full; });
  const counter = $('#counter');
  counter.textContent = `${n}/${r.max}`;
  counter.classList.toggle('full', full);

  const s = sel();
  document.querySelectorAll('[data-act]').forEach(b => {
    b.disabled = !s || (b.dataset.act === 'dup' && full);
  });

  // パレット
  const pal = $('#palette');
  const current = colorTarget === 'bg' ? state.bg : (s ? s.c : null);
  const others = s ? new Set(state.shapes.filter(x => x.id !== s.id).map(x => x.c)) : null;
  pal.innerHTML = COLORS.map(c => {
    let disabled = false;
    if (colorTarget === 'piece' && s && r.colors && !others.has(c.v) && others.size >= r.colors) disabled = true;
    return `<button class="swatch${current === c.v ? ' on' : ''}" style="background:${c.v}" data-color="${c.v}" aria-label="${c.name}"${disabled ? ' disabled' : ''}></button>`;
  }).join('');
}
function usedColors() { return new Set(state.shapes.map(s => s.c)); }

/* ---------- 操作 ---------- */
function addShape(type) {
  const r = rule();
  if (state.shapes.length >= r.max) { toast(`このお題は${r.max}つまで`); return; }
  const prev = snapshot();
  let c;
  const used = [...usedColors()];
  if (r.colors && used.length >= r.colors) c = used[0];
  else c = NEW_COLORS.find(v => !used.includes(v) && v !== state.bg) || NEW_COLORS[0];
  const k = state.shapes.length;
  const s = { id: nextId++, t: type, x: 500 + (k % 3 - 1) * 60, y: 500 + (k % 2) * 50 - 25, w: 300, h: 300, r: 0, f: 1, c };
  state.shapes.push(s);
  selId = s.id;
  colorTarget = 'piece';
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.target === 'piece'));
  pushUndo(prev);
  render();
}

function applyColor(v) {
  const prev = snapshot();
  if (colorTarget === 'bg') state.bg = v;
  else {
    const s = sel();
    if (!s) return;
    const r = rule();
    if (r.colors) {
      const others = new Set(state.shapes.filter(x => x.id !== s.id).map(x => x.c));
      if (!others.has(v) && others.size >= r.colors) { toast(`このお題は${r.colors}色まで`); return; }
    }
    s.c = v;
  }
  if (prev !== snapshot()) pushUndo(prev);
  render();
}

function doAction(act) {
  const s = sel();
  if (!s) return;
  const prev = snapshot();
  const i = state.shapes.indexOf(s);
  if (act === 'front' && i < state.shapes.length - 1) { state.shapes.splice(i, 1); state.shapes.push(s); }
  else if (act === 'back' && i > 0) { state.shapes.splice(i, 1); state.shapes.unshift(s); }
  else if (act === 'flip') s.f = -s.f;
  else if (act === 'dup') {
    if (state.shapes.length >= rule().max) { toast(`このお題は${rule().max}つまで`); return; }
    const d = { ...s, id: nextId++, x: s.x + 40, y: s.y + 40 };
    state.shapes.push(d);
    selId = d.id;
  } else if (act === 'del') { state.shapes.splice(i, 1); selId = null; }
  if (prev !== snapshot()) pushUndo(prev);
  render();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  const o = JSON.parse(prev);
  state.shapes = o.shapes;
  state.bg = o.bg;
  if (!sel()) selId = null;
  updateUndo();
  render();
}

/* ---------- ポインター操作 ---------- */
const pointers = new Map();
let drag = null;

function toBoard(e) {
  const pt = board.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(board.getScreenCTM().inverse());
  return [p.x, p.y];
}
function snapAngle(a) {
  a = ((a % 360) + 540) % 360 - 180;
  const near = Math.round(a / 45) * 45;
  return Math.abs(a - near) < 4 ? near : a;
}

board.addEventListener('pointerdown', e => {
  const p = toBoard(e);
  pointers.set(e.pointerId, p);
  try { board.setPointerCapture(e.pointerId); } catch {}

  const s = sel();
  if (pointers.size === 2 && s) {
    const [a, b] = [...pointers.values()];
    drag = {
      mode: 'pinch', prev: drag ? drag.prev : snapshot(),
      d0: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1,
      a0: Math.atan2(b[1] - a[1], b[0] - a[0]),
      w0: s.w, h0: s.h, r0: s.r,
      m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], x0: s.x, y0: s.y,
    };
    return;
  }
  if (pointers.size > 1) return;

  const handle = e.target.closest('[data-handle]');
  if (handle && s) {
    drag = { mode: handle.dataset.handle, prev: snapshot() };
    return;
  }
  const piece = e.target.closest('[data-id]');
  if (piece) {
    selId = Number(piece.dataset.id);
    const t = sel();
    drag = { mode: 'move', prev: snapshot(), dx: p[0] - t.x, dy: p[1] - t.y };
    if (colorTarget === 'bg') {
      colorTarget = 'piece';
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.target === 'piece'));
    }
    render();
    return;
  }
  selId = null;
  drag = null;
  render();
});

board.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const p = toBoard(e);
  pointers.set(e.pointerId, p);
  const s = sel();
  if (!drag || !s) return;
  e.preventDefault();

  if (drag.mode === 'move') {
    s.x = Math.round(p[0] - drag.dx);
    s.y = Math.round(p[1] - drag.dy);
  } else if (drag.mode === 'scale') {
    const a = -s.r * Math.PI / 180;
    const vx = p[0] - s.x, vy = p[1] - s.y;
    const lx = vx * Math.cos(a) - vy * Math.sin(a);
    const ly = vx * Math.sin(a) + vy * Math.cos(a);
    s.w = Math.round(Math.min(2000, Math.max(24, Math.abs(lx) * 2)));
    s.h = Math.round(Math.min(2000, Math.max(24, Math.abs(ly) * 2)));
    // 縦横がほぼ同じなら正円・正方形にスナップ
    if (Math.abs(s.w - s.h) < Math.max(s.w, s.h) * 0.04) { const m = Math.round((s.w + s.h) / 2); s.w = m; s.h = m; }
  } else if (drag.mode === 'rotate') {
    const ang = Math.atan2(p[1] - s.y, p[0] - s.x) * 180 / Math.PI + 90;
    s.r = snapAngle(ang);
  } else if (drag.mode === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const k = d / drag.d0;
    s.w = Math.round(Math.min(2000, Math.max(24, drag.w0 * k)));
    s.h = Math.round(Math.min(2000, Math.max(24, drag.h0 * k)));
    s.r = snapAngle(drag.r0 + (ang - drag.a0) * 180 / Math.PI);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    s.x = Math.round(drag.x0 + m[0] - drag.m0[0]);
    s.y = Math.round(drag.y0 + m[1] - drag.m0[1]);
  }
  drag.moved = true;
  render();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (drag && drag.moved && drag.prev !== snapshot()) pushUndo(drag.prev);
    drag = null;
  } else if (drag && drag.mode === 'pinch') {
    // 指が1本に戻ったら、その指で移動を続けられるようにする
    const s = sel();
    const [p] = [...pointers.values()];
    if (s) drag = { mode: 'move', prev: drag.prev, dx: p[0] - s.x, dy: p[1] - s.y, moved: drag.moved };
  }
}
board.addEventListener('pointerup', endPointer);
board.addEventListener('pointercancel', endPointer);

/* ---------- キーボード（PC） ---------- */
document.addEventListener('keydown', e => {
  if (!$('#editor').classList.contains('active')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  const s = sel();
  if (!s) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doAction('del'); return; }
  const step = e.shiftKey ? 20 : 4;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    const prev = snapshot();
    s.x += moves[e.key][0]; s.y += moves[e.key][1];
    pushUndo(prev);
    render();
  }
});

/* ================= シェア画像 ================= */
const CARD = 1200;
let cardBlob = null;
let currentWork = null;

async function makeCard(work) {
  try { await Promise.all([document.fonts.load('700 80px "Zen Old Mincho"'), document.fonts.load('700 30px "Zen Kaku Gothic New"')]); } catch {}
  const cv = document.createElement('canvas');
  cv.width = CARD; cv.height = CARD;
  const ctx = cv.getContext('2d');
  const serif = '"Zen Old Mincho", "Hiragino Mincho ProN", serif';
  const sans = '"Zen Kaku Gothic New", "Hiragino Sans", sans-serif';

  // クラフト紙の台紙
  ctx.fillStyle = '#EDE4D3';
  ctx.fillRect(0, 0, CARD, CARD);
  const rnd = seeded(work.shapes.length * 97 + 13);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = rnd() < .5 ? 'rgba(120,90,50,.07)' : 'rgba(255,255,255,.3)';
    ctx.fillRect(rnd() * CARD, rnd() * CARD, 2, 2);
  }

  // 見出し
  ctx.fillStyle = '#6B6157';
  ctx.font = `700 26px ${sans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(work.no ? `今日のお題 No.${work.no}` : '練習', 80, 92);
  ctx.textAlign = 'right';
  ctx.fillText(work.date ? fmtDate(work.date) : '', CARD - 80, 92);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#2A2520';
  let size = 92;
  ctx.font = `700 ${size}px ${serif}`;
  while (ctx.measureText(`「${work.word}」`).width > CARD - 200 && size > 40) { size -= 4; ctx.font = `700 ${size}px ${serif}`; }
  ctx.fillText(`「${work.word}」`, CARD / 2, 196);

  // 作品
  const A = 800, ax = (CARD - A) / 2, ay = 240;
  ctx.save();
  ctx.shadowColor = 'rgba(60,40,10,.35)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
  ctx.fillStyle = work.bg;
  ctx.fillRect(ax, ay, A, A);
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(ax, ay, A, A); ctx.clip();
  ctx.translate(ax, ay);
  ctx.scale(A / 1000, A / 1000);
  for (const s of work.shapes) {
    ctx.save();
    ctx.shadowColor = 'rgba(58,42,18,.22)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 6;
    drawShape(ctx, s);
    ctx.restore();
  }
  ctx.restore();

  // フッター
  ctx.fillStyle = '#2A2520';
  ctx.font = `700 28px ${sans}`;
  ctx.textAlign = 'left';
  ctx.fillText(RULES[work.rule].label, ax, 1120);
  ctx.textAlign = 'right';
  ctx.fillText(`#${HASHTAG}`, ax + A, 1120);

  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

function shareText(work) {
  const head = work.no ? `今日のお題 No.${work.no}「${work.word}」` : `練習「${work.word}」`;
  return `${head}を${RULES[work.rule].label}で表現しました\n#${HASHTAG}\n${SITE_URL}`;
}

async function finish() {
  selId = null;
  render();
  if (state.shapes.length === 0) { toast('まずは形をひとつ置いてみよう'); return; }
  currentWork = {
    no: session.practice ? null : session.no,
    date: session.practice ? null : session.date,
    word: session.word, rule: session.rule,
    shapes: state.shapes.map(s => ({ ...s })), bg: state.bg,
    at: Date.now(),
  };
  saveWork(currentWork);
  await showResult(currentWork);
}

async function showResult(work) {
  currentWork = work;
  show('result');
  $('#cardImg').removeAttribute('src');
  $('#shareNote').textContent = '画像をつくっています…';
  $('#shareX').disabled = true;
  $('#resOthers').href = othersUrl(work.no, work.word);
  cardBlob = await makeCard(work);
  $('#cardImg').src = URL.createObjectURL(cardBlob);
  $('#shareX').disabled = false;
  $('#shareNote').textContent = canShareFile() ? '' : '画像をコピーしてXを開きます。投稿欄に貼り付けてください。';
}

function cardFile() {
  const name = currentWork.no ? `dhassou-no${currentWork.no}.png` : 'dhassou-practice.png';
  return new File([cardBlob], name, { type: 'image/png' });
}
function canShareFile() {
  try { return !!(navigator.canShare && cardBlob && navigator.canShare({ files: [cardFile()] }) && matchMedia('(pointer:coarse)').matches); }
  catch { return false; }
}

async function shareToX() {
  if (!cardBlob) return;
  const text = shareText(currentWork);
  if (canShareFile()) {
    try {
      await navigator.share({ files: [cardFile()], text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const intent = 'https://x.com/intent/post?text=' + encodeURIComponent(text);
  const win = window.open('', '_blank');
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob })]);
    copied = true;
  } catch {}
  if (win) win.location.href = intent; else location.href = intent;
  toast(copied ? '画像をコピーしました。投稿欄に貼り付けてね' : '画像を保存してから投稿に添付してね');
}

function saveImage() {
  if (!cardBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(cardBlob);
  a.download = cardFile().name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ================= ホーム ================= */
let today = null;

function renderHome() {
  const date = jstToday();
  const no = dayNumber(date);
  const od = dailyOdai(no);
  today = { ...od, no, date };
  $('#todayNo').textContent = `No.${no}`;
  $('#todayDate').textContent = fmtDate(date);
  $('#todayWord').textContent = od.word;
  $('#todayRule').textContent = RULES[od.rule].label;
  $('#seeOthers').href = othersUrl(no, od.word);

  const works = loadWorks();
  const mine = works.find(w => w.no === no);
  $('#todayDone').hidden = !mine;
  $('#startToday').textContent = mine ? 'つくり直す' : 'つくる';

  const hist = $('#history');
  $('#historyBlock').hidden = works.length === 0;
  hist.innerHTML = works.map((w, i) =>
    `<button data-i="${i}">${workSVG(w)}<span>${w.no ? 'No.' + w.no : '練習'}「${escapeHTML(w.word)}」</span></button>`
  ).join('');
}
function escapeHTML(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function randomPractice() {
  const od = ODAI[Math.floor(Math.random() * ODAI.length)];
  openEditor(od, { practice: true });
}

/* ================= イベント ================= */
$('#startToday').addEventListener('click', () => {
  const mine = loadWorks().find(w => w.no === today.no);
  openEditor(today, { no: today.no, date: today.date, work: mine });
});
$('#startPractice').addEventListener('click', randomPractice);
$('#history').addEventListener('click', e => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  const w = loadWorks()[Number(b.dataset.i)];
  if (w) showResult(w);
});

$('#edBack').addEventListener('click', () => { renderHome(); show('home'); });
$('#edUndo').addEventListener('click', undo);
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addShape(b.dataset.add)));
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => doAction(b.dataset.act)));
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
  colorTarget = b.dataset.target;
  document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
  renderTools();
}));
$('#palette').addEventListener('click', e => {
  const sw = e.target.closest('[data-color]');
  if (!sw || sw.disabled) return;
  if (colorTarget === 'piece' && !sel()) { toast('色を変えたい形をタップしてね'); return; }
  applyColor(sw.dataset.color);
});
$('#finish').addEventListener('click', finish);

$('#resBack').addEventListener('click', () => {
  const w = currentWork;
  const od = { word: w.word, rule: w.rule };
  openEditor(od, w.no ? { no: w.no, date: w.date, work: w } : { practice: true, work: w });
});
$('#shareX').addEventListener('click', shareToX);
$('#saveImg').addEventListener('click', saveImage);
$('#resHome').addEventListener('click', () => { renderHome(); show('home'); });
$('#resPractice').addEventListener('click', randomPractice);

renderHome();
})();
