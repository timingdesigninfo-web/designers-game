// デザイナーの目：ランク戦のランキングAPI（Vercel Functions + Upstash Redis）
//
// GET  /api/eye?action=top              上位100件と参加人数
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
// 今日のランキング（日本時間の0時で切り替え）。8日たったら自動で消える
const jstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const dayKey = d => 'eye:day:' + d;
const userKey = h => 'eye:user:' + h;
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
const rankScore = (avg, t) => avg + (1e10 - Math.floor(t / 1000)) / 1e11;

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
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
  const today = scope === 'today';
  const day = jstDay();
  const key = today ? dayKey(day) : RANK;
  const [list, total] = await db([['ZREVRANGE', key, 0, 99, 'WITHSCORES'], ['ZCARD', key]]);
  const ids = [], scores = [];
  for (let i = 0; i < list.length; i += 2) { ids.push(list[i]); scores.push(Math.floor(Number(list[i + 1]))); }
  if (!ids.length) return { scope: today ? 'today' : 'all', day, total: 0, list: [] };
  const metas = await db(ids.map(id => ['HMGET', userKey(id), 'name', 'kind']));
  return {
    scope: today ? 'today' : 'all',
    day,
    total,
    list: ids.map((id, i) => {
      const [name, kind] = metas[i];
      return { rank: i + 1, id, name: name || id.slice(2), kind: kind || (id.startsWith('x:') ? 'x' : 'name'), avg: scores[i] };
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

  // 同じランク戦は1回だけ登録できる
  const [fresh] = await db([['SET', 'eye:gid:' + gid, '1', 'NX', 'EX', 4 * 3600]]);
  if (fresh !== 'OK') return [409, { error: 'このランク戦はもう登録済みです。' }];

  const day = jstDay();
  const dk = dayKey(day);
  const [dayPrev] = await db([['ZSCORE', dk, lower]]);
  const dayBestBefore = dayPrev == null ? -1 : Math.floor(Number(dayPrev));

  let u = await owner(lower);
  let newToken = null;
  if (u) {
    if (!safeEq(sha(String(body.token || '')), u.tok)) return [409, { error: `「${shown(me)}」はほかの人（または別の端末）が使っています。` }];
  } else {
    newToken = crypto.randomBytes(18).toString('hex');
    u = { tok: sha(newToken), best: '-1' };
  }

  const now = Date.now();
  const isBest = avg > Number(u.best);
  const cmds = [['HSET', userKey(lower), 'name', me.name, 'kind', me.kind, 'tok', u.tok, 'last', String(avg), 'lt', String(now), 'plays', String(Number(u.plays || 0) + 1)]];
  if (isBest) {
    cmds.push(['HSET', userKey(lower), 'best', String(avg), 'rows', JSON.stringify(rows), 'bt', String(now)]);
    cmds.push(['ZADD', RANK, rankScore(avg, now), lower]);
  }
  const isDayBest = avg > dayBestBefore;
  if (isDayBest) cmds.push(['ZADD', dk, rankScore(avg, now), lower], ['EXPIRE', dk, 8 * 86400]);
  cmds.push(['ZREVRANK', RANK, lower], ['ZCARD', RANK], ['ZCOUNT', RANK, String(avg + 1), '+inf']);
  cmds.push(['ZREVRANK', dk, lower], ['ZCARD', dk], ['ZCOUNT', dk, String(avg + 1), '+inf']);
  const r = await db(cmds);
  const [rank, total, above, dRank, dTotal, dAbove] = r.slice(-6);
  return [200, {
    name: me.name,
    kind: me.kind,
    avg,
    best: isBest ? avg : Number(u.best),
    isBest,
    rank: rank + 1,              // 自己ベストでの総合順位
    thisRank: above + 1,         // 今回の点数なら何位相当か
    total,
    day,
    dayBest: isDayBest ? avg : dayBestBefore,
    isDayBest,
    dayRank: dRank + 1,          // 今日の自己ベストでの順位
    dayThisRank: dAbove + 1,     // 今回の点数なら今日何位相当か
    dayTotal: dTotal,
    token: newToken,
  }];
}

async function remove(body) {
  const me = identity(body);
  if (!me) return [400, { error: badIdentity(body) }];
  const lower = me.id;
  const u = await owner(lower);
  if (!u) return [200, { removed: false }];
  if (!safeEq(sha(String(body.token || '')), u.tok)) return [403, { error: '登録した端末からだけ外せます。' }];
  await db([['ZREM', RANK, lower], ['ZREM', dayKey(jstDay()), lower], ['ZREM', dayKey(jstDay(Date.now() - 86400e3)), lower], ['DEL', userKey(lower)]]);
  return [200, { removed: true }];
}

module.exports = async (req, res) => {
  if (!DB_URL || !DB_TOKEN) return send(res, 503, { error: 'ランキングの準備中です（データベース未接続）。' });
  try {
    if (req.method === 'GET') return send(res, 200, await top((req.query && req.query.scope) || new URL(req.url, 'http://x').searchParams.get('scope')));
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (await rateLimited(req)) return send(res, 429, { error: '少し時間をおいてからもう一度どうぞ。' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const fn = { start, submit, delete: remove }[body.action];
    if (!fn) return send(res, 400, { error: 'action' });
    const [code, out] = await fn(body);
    return send(res, code, out);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'サーバーでエラーが起きました。少し待ってからもう一度どうぞ。' });
  }
};
