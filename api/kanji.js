// かんじクエスト：AIまるつけAPI（Vercel Functions）
//
// POST /api/kanji  {items:[{ans:"飛", q:"鳥が空を［と］ぶ", image:"data:image/png;base64,..."}]}
//   → {results:[{n:1, ok:true, why:"..."}]}
// GET  /api/kanji  動作確認（APIキーが設定されているか）
//
// 環境変数：ANTHROPIC_API_KEY（必須）
//           KANJI_MODEL（任意。省略時 claude-sonnet-5-5）
//           KANJI_AI_PER_DAY（任意。サイト全体で1日に使える回数。省略時 20）
// データベース（Upstash Redis）がつながっていれば、1日の回数制限に使う。

const DAILY = Number(process.env.KANJI_AI_PER_DAY || 20);
function envEnding(suffix) {
  const k = Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');
const jstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

const RULES = `判定のしかた:
- 指で書いているので、線のふるえ・字の大きさ・バランス・きれいさは気にしない。
- とめ・はね・はらいは、はっきり分からなくても ○ にしてよい。
- × にするのは: ちがう字を書いた / 画（線）や点が足りない・多い / へん・つくりなど部分がちがう / 書いていない文字がある / 読めないほどくずれている。
- 迷ったときは、その字だと読み取れれば ○。

JSONの配列だけで答えてください。画像1つにつき1つ、順番どおり:
[{"n":1,"ok":true,"why":"子どもに向けた ひらがな多めの ひとこと（25文字いない）"}]
×のときの why には、どこがちがうか（例:「てんが 1つ たりないよ」）を書いてください。`;

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// サイト全体の1日の回数を数える。データベースがなければ制限なし（Anthropic側の上限金額で止まる）
async function overDailyLimit() {
  if (!DB_URL || !DB_TOKEN) return false;
  try {
    const key = 'kanji:ai:' + jstDay();
    const r = await fetch(DB_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, 172800]]),
    });
    if (!r.ok) return false;
    const [count] = await r.json();
    return Number(count.result) > DAILY;
  } catch { return false; }
}

module.exports = async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return send(res, 200, { ok: true, key_set: !!key, daily_limit: DAILY, counter: !!(DB_URL && DB_TOKEN) });
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  // ほかのサイトからは使わせない
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'origin' }); }
    catch { return send(res, 403, { error: 'origin' }); }
  }
  if (!key) return send(res, 503, { error: 'AIまるつけの準備中です（APIキー未設定）。' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 10) : [];
  if (!items.length) return send(res, 200, { results: [] });

  const content = [];
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const ans = String(it.ans || '').slice(0, 4);
    const q = String(it.q || '').slice(0, 80);
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(it.image || ''));
    if (!ans || !m || m[1].length > 400000) return send(res, 400, { error: 'bad_item', index: i });
    lines.push(`画像${i + 1}: 正しい答え「${ans}」（${[...ans].length}文字。問題文「${q}」）`);
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: m[1] } });
  }
  content.push({
    type: 'text',
    text: `あなたは小学校の先生です。小学4年生が スマホやタブレットに指で書いた漢字テストを まるつけしてください。
画像は ${items.length}まい あり、順番は下のリストと同じです。マスが2つ以上ある画像は、左から順に1文字ずつ書いてあります。

${lines.join('\n')}

${RULES}`,
  });

  if (await overDailyLimit()) return send(res, 429, { error: 'きょうのAIまるつけは おしまい' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.KANJI_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) {
      console.error('anthropic', r.status, (await r.text()).slice(0, 300));
      return send(res, 502, { error: 'anthropic_error', status: r.status });
    }
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    const results = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(results)) throw new Error('not array');
    return send(res, 200, {
      results: results.map(x => ({ n: Number(x && x.n) || 0, ok: !!x && x.ok === true, why: String((x && x.why) || '').slice(0, 60) })),
    });
  } catch (e) {
    console.error(e);
    return send(res, 502, { error: 'parse_failed' });
  }
};
