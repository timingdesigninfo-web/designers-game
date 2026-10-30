// XD戦記：セーブデータのサーバー保存（Vercel Functions + Upstash Redis）
//
// POST /api/xd {action:"save", code, data}  引き継ぎコードに紐づけて保存（上書き）
// POST /api/xd {action:"load", code}        引き継ぎコードから読み出す
//
// 引き継ぎコード = ブラウザが作る推測できない文字列（XD + 12文字 ≒ 60bit）。ログインなし・個人情報なし。
// 環境変数は api/eye.js と同じ（KV_REST_API_URL / KV_REST_API_TOKEN など）

const crypto = require('crypto');

function envEnding(suffix) {
  const k = Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');

const CODE_RE = /^XD[A-HJ-NP-Z2-9]{12}$/;
const MAX_BYTES = 200 * 1024;
const TTL = 400 * 86400; // 最後の保存から約13か月で自動削除

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

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = '';
  for await (const c of req) { s += c; if (s.length > MAX_BYTES * 2) break; }
  try { return JSON.parse(s); } catch { return {}; }
}

async function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = 'xd:rl:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
  const [n] = await db([['INCR', key], ['EXPIRE', key, 120]]);
  return n > 60;
}

module.exports = async (req, res) => {
  try {
    if (!DB_URL || !DB_TOKEN) return send(res, 503, { error: 'サーバー保存は まだ 準備中です' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (await rateLimited(req)) return send(res, 429, { error: 'しばらく 待ってから もう一度 ためしてください' });
    const body = await readBody(req);
    const code = String(body.code || '');
    if (!CODE_RE.test(code)) return send(res, 400, { error: '引き継ぎコードの形がちがいます' });
    const key = 'xd:save:' + code;
    if (body.action === 'save') {
      const data = typeof body.data === 'string' ? body.data : '';
      if (!data || Buffer.byteLength(data) > MAX_BYTES) return send(res, 400, { error: '記録が 大きすぎるか、空です' });
      let ok = false;
      try { const o = JSON.parse(data); ok = !!(o && o.g && typeof o.g.ch === 'number'); } catch { /* ok=false */ }
      if (!ok) return send(res, 400, { error: '記録の形がちがいます' });
      await db([['SET', key, data, 'EX', TTL]]);
      return send(res, 200, { ok: true });
    }
    if (body.action === 'load') {
      const [data] = await db([['GET', key]]);
      if (data) await db([['EXPIRE', key, TTL]]);
      return send(res, 200, { ok: true, data: data || null });
    }
    return send(res, 400, { error: 'unknown action' });
  } catch (e) {
    return send(res, 500, { error: 'サーバーのエラー' });
  }
};
