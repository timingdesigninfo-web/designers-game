// デザイナーの目：ランク戦のランキングAPI（Vercel Functions + Upstash Redis）
//
// GET  /api/eye?scope=week|all          上位100件と参加人数（週は月曜0時に切り替え）
// POST /api/eye  {action:"start", ...}   ランク戦を始める（問題の種と署名を発行）
// POST /api/eye  {action:"submit", ...}  結果を登録（自己ベストなら更新）して順位を返す
// POST /api/eye  {action:"delete", ...}  自分の記録をランキングから外す
//
// 環境変数：KV_REST_API_URL / KV_REST_API_TOKEN（または UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）
//           RANK_SECRET（任意。未設定ならデータベースの鍵から作る）

const crypto = require('crypto');

// Vercelの連携は接頭辞を付けることがある（STORAGE_KV_REST_API_URL など）ので、末尾で探す
function envEnding(suffix) {
  const k = Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');
const SECRET = process.env.RANK_SECRET || crypto.createHash('sha256').update('eye-rank:' + (DB_TOKEN || '')).digest('hex');

const RANK = 'eye:rank';
// 今週のランキング（日本時間の月曜0時で切り替え）。15日たったら自動で消える
// ※ 以前は「今日」のランキングだった。APIの項目名（day, dayRank など）は互換のためそのまま使い、中身を週にしている
const jstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const jstWeek = (t = Date.now()) => { // その週の月曜（日本時間）の日付
  const d = new Date(t + 9 * 3600e3), back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400e3).toISOString().slice(0, 10);
};
const weekKey = w => 'eye:week:' + w;
const dayKey = d => 'eye:day:' + d; // 旧「今日」ランキング（週への引き継ぎにだけ使う）
const WEEK_TTL = 15 * 86400;
// 週ランキングがまだ無ければ、その週のこれまでの日別ランキングから作る（切り替え直後の1回だけ）
async function ensureWeek(w) {
  const wk = weekKey(w);
  const [fresh] = await db([['SET', 'eye:weekinit:' + w, '1', 'NX', 'EX', WEEK_TTL]]);
  if (fresh !== 'OK') return wk;
  const mon = Date.parse(w + 'T00:00:00Z'), days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(mon + i * 86400e3).toISOString().slice(0, 10); if (d <= jstDay()) days.push(dayKey(d)); }
  await db([['ZUNIONSTORE', wk, days.length + 1, wk, ...days, 'AGGREGATE', 'MAX'], ['EXPIRE', wk, WEEK_TTL]]);
  return wk;
}
const userKey = h => 'eye:user:' + h;
// ランキングに出す名前の一覧（1回の HMGET でまとめて読む。前は1人ずつ読んでいて回数が多かった）
const NAMES = 'eye:names';
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const MIN_PLAY_MS = Number(process.env.EYE_MIN_PLAY_MS || 45 * 1000); // 18ラウンドをこれより速く終えるのは不可能
const MAX_PLAY_MS = 3 * 3600 * 1000;
const MODES = 6;

async function db(cmds) {
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('db ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// 同点なら先に出した人が上：小数部に「早さ」を入れる
const rankScore = (avg, t) => avg + (1e10 - Math.floor(t / 1000)) / 1e11; // 旧方式（時間なし）
// 点数が同じなら合計時間が短いほど上：小数部に時間（0.1秒単位）を入れる
const timeScore = (avg, tenths) => avg + (10000 - tenths) / 1e5;
function decodeTime(raw) { // スコアから合計時間（秒）を取り出す。旧方式の記録は null
  const avg = Math.floor(raw), t = 10000 - (raw - avg) * 1e5;
  return Math.abs(t - Math.round(t)) < 0.01 && t >= 0 && t <= 5000 ? Math.round(t) / 10 : null;
}

function send(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

async function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = 'eye:rl:' + sha(ip).slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
  const [n] = await db([['INCR', key], ['EXPIRE', key, 120]]);
  return n > 30;
}

// 参加者の名前：自由な名前（基本）か、Xのアカウント名
function identity(body) {
  if (body.kind === 'x') {
    const h = String(body.name || '').trim().replace(/^@/, '');
    if (!HANDLE_RE.test(h)) return null;
    return { id: 'x:' + h.toLowerCase(), name: h, kind: 'x' };
  }
  const n = String(body.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...n].length;
  if (len < 1 || len > 16 || /[\u0000-\u001f\u007f<>]/.test(n) || n.startsWith('@')) return null;
  return { id: 'n:' + n.toLowerCase(), name: n, kind: 'name' };
}
const BAD_NAME = 'なまえは1〜16文字で入れてください（記号の < > と先頭の @ は使えません）。';
const BAD_X = 'Xのアカウント名は英数字と _ の15文字以内で入れてください。';
const badIdentity = body => (body.kind === 'x' ? BAD_X : BAD_NAME);
const shown = u => (u.kind === 'x' ? '@' : '') + u.name;

async function owner(id) {
  const [u] = await db([['HGETALL', userKey(id)]]);
  if (!u || !u.length) return null;
  const o = {};
  for (let i = 0; i < u.length; i += 2) o[u[i]] = u[i + 1];
  return o;
}

async function top(scope) {
  const today = scope === 'week' || scope === 'today'; // 'today' は古いページからの呼び出し
  const day = jstWeek();
  const key = today ? await ensureWeek(day) : RANK;
  const [list, total] = await db([['ZREVRANGE', key, 0, 99, 'WITHSCORES'], ['ZCARD', key]]);
  const ids = [], raws = [];
  for (let i = 0; i < list.length; i += 2) { ids.push(list[i]); raws.push(Number(list[i + 1])); }
  if (!ids.length) return { scope: today ? 'week' : 'all', day, total: 0, list: [] };
  const packed = (await db([['HMGET', NAMES, ...ids]]))[0] || [];
  const metas = packed.map(v => { try { const o = JSON.parse(v); return [o.n, o.k]; } catch { return null; } });
  // 一覧にまだない人だけ 1人ずつ読んで、一覧に足しておく（次からは読まない）
  const miss = ids.map((id, i) => metas[i] ? -1 : i).filter(i => i >= 0);
  if (miss.length) {
    const got = await db(miss.map(i => ['HMGET', userKey(ids[i]), 'name', 'kind']));
    const fill = [];
    miss.forEach((i, j) => { metas[i] = got[j]; if (got[j][0]) fill.push(ids[i], JSON.stringify({ n: got[j][0], k: got[j][1] })); });
    if (fill.length) await db([['HSET', NAMES, ...fill]]);
  }
  return {
    scope: today ? 'week' : 'all',
    day,
    total,
    list: ids.map((id, i) => {
      const [name, kind] = metas[i];
      const rank = raws.indexOf(raws[i]) + 1; // 点数も時間も同じなら同じ順位
      return { rank, id, name: name || id.slice(2), kind: kind || (id.startsWith('x:') ? 'x' : 'name'), avg: Math.floor(raws[i]), time: decodeTime(raws[i]) };
    }),
  };
}

async function start(body) {
  const me = identity(body);
  if (!me) return [400, { error: badIdentity(body) }];
  const u = await owner(me.id);
  if (u && !safeEq(sha(String(body.token || '')), u.tok)) {
    return [409, { error: `「${shown(me)}」はほかの人（または別の端末）が使っています。別の名前にするか、登録した端末で遊んでください。` }];
  }
  const gid = crypto.randomBytes(9).toString('hex');
  const seed = crypto.randomInt(1, 1e9);
  const t0 = Date.now();
  return [200, { gid, seed, t0, sig: sign([gid, seed, t0, me.id].join('|')), id: me.id, name: me.name, kind: me.kind }];
}

async function submit(body) {
  const me = identity(body);
  if (!me) return [400, { error: badIdentity(body) }];
  const lower = me.id;
  const { gid, seed, t0, sig } = body;
  if (!safeEq(sign([gid, seed, t0, lower].join('|')), String(sig || ''))) return [400, { error: 'ランク戦の情報が正しくありません。' }];
  const age = Date.now() - Number(t0);
  if (!(age >= MIN_PLAY_MS && age <= MAX_PLAY_MS)) return [400, { error: 'ランク戦の時間が範囲外です。もう一度挑戦してください。' }];

  const avg = Number(body.avg);
  const rows = Array.isArray(body.rows) ? body.rows.map(Number) : [];
  if (!Number.isInteger(avg) || avg < 0 || avg > 100) return [400, { error: '点数が正しくありません。' }];
  if (rows.length !== MODES || rows.some(v => !Number.isInteger(v) || v < 0 || v > 100)) return [400, { error: '種目別の点数が正しくありません。' }];
  if (Math.abs(rows.reduce((a, b) => a + b, 0) / MODES - avg) > 1.5) return [400, { error: '点数の合計が合いません。' }];
  const time = Number(body.time);
  if (!(time > 0 && time <= 400 && time <= age / 1000 + 5)) return [400, { error: '時間が正しくありません。' }];
  const tenths = Math.round(time * 10);
  const score = timeScore(avg, tenths);

  // 同じランク戦は1回だけ登録できる
  const [fresh] = await db([['SET', 'eye:gid:' + gid, '1', 'NX', 'EX', 4 * 3600]]);
  if (fresh !== 'OK') return [409, { error: 'このランク戦はもう登録済みです。' }];

  const day = jstWeek();
  const dk = await ensureWeek(day);
  const [dayPrev, allPrev] = await db([['ZSCORE', dk, lower], ['ZSCORE', RANK, lower]]);
  const dayPrevScore = dayPrev == null ? -1 : Number(dayPrev);
  const allPrevScore = allPrev == null ? -1 : Number(allPrev);

  let u = await owner(lower);
  let newToken = null;
  if (u) {
    if (!safeEq(sha(String(body.token || '')), u.tok)) return [409, { error: `「${shown(me)}」はほかの人（または別の端末）が使っています。` }];
  } else {
    newToken = crypto.randomBytes(18).toString('hex');
    u = { tok: sha(newToken), best: '-1' };
  }

  const now = Date.now();
  const isBest = score > allPrevScore;
  const cmds = [['HSET', NAMES, lower, JSON.stringify({ n: me.name, k: me.kind })], ['HSET', userKey(lower), 'name', me.name, 'kind', me.kind, 'tok', u.tok, 'last', String(avg), 'lt', String(now), 'plays', String(Number(u.plays || 0) + 1)]];
  if (isBest) {
    cmds.push(['HSET', userKey(lower), 'best', String(avg), 'rows', JSON.stringify(rows), 'bt', String(now), 'btime', String(tenths / 10)]);
    cmds.push(['ZADD', RANK, score, lower]);
  }
  const isDayBest = score > dayPrevScore;
  if (isDayBest) cmds.push(['ZADD', dk, score, lower], ['EXPIRE', dk, WEEK_TTL]);
  // 順位は「自分より上（点数が高い、または同点で速い）の人数＋1」。点数も時間も同じなら同じ順位
  const bestAll = isBest ? score : allPrevScore;
  const bestDay = isDayBest ? score : dayPrevScore;
  cmds.push(['ZCOUNT', RANK, '(' + bestAll, '+inf'], ['ZCARD', RANK], ['ZCOUNT', RANK, '(' + score, '+inf']);
  cmds.push(['ZCOUNT', dk, '(' + bestDay, '+inf'], ['ZCARD', dk], ['ZCOUNT', dk, '(' + score, '+inf']);
  const r = await db(cmds);
  const [rank, total, above, dRank, dTotal, dAbove] = r.slice(-6);
  return [200, {
    name: me.name,
    kind: me.kind,
    avg,
    best: Math.floor(bestAll),
    isBest,
    rank: rank + 1,              // 自己ベストでの総合順位
    thisRank: above + 1,         // 今回の点数なら何位相当か
    total,
    day,
    dayBest: Math.floor(bestDay),
    isDayBest,
    dayRank: dRank + 1,          // 今週の自己ベストでの順位
    dayThisRank: dAbove + 1,     // 今回の点数なら今週何位相当か
    dayTotal: dTotal,
    token: newToken,
  }];
}

// ---- 結果カード（Xのリンクカード用の画像） ----
const SITE = 'https://designers-game.vercel.app';
const CARD_TTL = 90 * 86400; // 90日で自動削除
const cardKey = id => 'eye:card:' + id;
const CARD_ID_RE = /^[a-z0-9]{10}$/;

async function card(body) {
  const img = String(body.img || '').replace(/^data:image\/jpeg;base64,/, '');
  if (!img.startsWith('/9j/') || img.length > 600000) return [400, { error: '画像を作れませんでした。' }];
  const text = String(body.text || '').slice(0, 200);
  const id = crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().padEnd(10, '0').slice(0, 10);
  await db([['HSET', cardKey(id), 'img', img, 'text', text], ['EXPIRE', cardKey(id), CARD_TTL]]);
  return [200, { id, url: `${SITE}/eye/r/${id}` }];
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// /eye/card/<id>.jpg → 画像
async function cardImage(res, id) {
  if (!CARD_ID_RE.test(id)) { res.statusCode = 404; return res.end('not found'); }
  const [img] = await db([['HGET', cardKey(id), 'img']]);
  if (!img) { res.statusCode = 302; res.setHeader('Location', SITE + '/eye/og.png'); return res.end(); }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.end(Buffer.from(img, 'base64'));
}

// /eye/r/<id> → Xが読むためのカード情報を返し、人はゲームのトップへ移動
async function cardPage(res, id) {
  const ok = CARD_ID_RE.test(id);
  const [text] = ok ? await db([['HGET', cardKey(id), 'text']]) : [null];
  const image = text != null ? `${SITE}/eye/card/${id}.jpg` : `${SITE}/eye/og.png`;
  const desc = text || '定規なしで中心・太さ・色・分割・角度・カーニングを当てる18ラウンド。';
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>デザイナーの目</title>
<meta property="og:title" content="デザイナーの目">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/eye/r/${ok ? id : ''}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0;url=/eye/">
</head><body><script>location.replace('/eye/')</script><a href="/eye/">デザイナーの目で遊ぶ</a></body></html>`);
}

async function remove(body) {
  const me = identity(body);
  if (!me) return [400, { error: badIdentity(body) }];
  const lower = me.id;
  const u = await owner(lower);
  if (!u) return [200, { removed: false }];
  if (!safeEq(sha(String(body.token || '')), u.tok)) return [403, { error: '登録した端末からだけ外せます。' }];
  await db([['HDEL', NAMES, lower], ['ZREM', RANK, lower], ['ZREM', weekKey(jstWeek()), lower], ['ZREM', weekKey(jstWeek(Date.now() - 7 * 86400e3)), lower], ['ZREM', dayKey(jstDay()), lower], ['DEL', userKey(lower)]]);
  return [200, { removed: true }];
}

module.exports = async (req, res) => {
  if (!DB_URL || !DB_TOKEN) return send(res, 503, { error: 'ランキングの準備中です（データベース未接続）。' });
  try {
    const u = new URL(req.url, 'http://x'), q = u.searchParams, rq = req.query || {};
    // 書き換え後でも元のパスでも受けられるように
    const cardId = rq.card || q.get('card') || (u.pathname.match(/\/eye\/card\/([a-z0-9]+)\.jpg$/) || [])[1];
    const pageId = rq.r || q.get('r') || (u.pathname.match(/\/eye\/r\/([a-z0-9]+)\/?$/) || [])[1];
    if (req.method === 'GET' && cardId) return cardImage(res, cardId);
    if (req.method === 'GET' && pageId) return cardPage(res, pageId);
    // ランキングは Vercel の CDN に1分おく（見る人が多くても データベースを読むのは1分に1回ほど）
    if (req.method === 'GET') return send(res, 200, await top(q.get('scope')), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (await rateLimited(req)) return send(res, 429, { error: '少し時間をおいてからもう一度どうぞ。' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const fn = { start, submit, delete: remove, card }[body.action];
    if (!fn) return send(res, 400, { error: 'action' });
    const [code, out] = await fn(body);
    return send(res, code, out);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'サーバーでエラーが起きました。少し待ってからもう一度どうぞ。' });
  }
};
