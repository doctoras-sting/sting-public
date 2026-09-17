// api/claude.js
//
// STING本体(App.jsx)の callClaude() から呼ばれる、公開用の「仲介役」です。
// ブラウザは直接 api.anthropic.com を呼ばず、必ずこの /api/claude を経由します。
// APIキー(ANTHROPIC_API_KEY)は、Vercelの環境変数としてサーバー側にだけ保管され、
// ブラウザに送られるコードには一切含まれません。
//
// STING側のリクエストの中身(model / max_tokens / messages)は一切変更せず、
// そのままClaude APIへ転送し、返ってきた結果もそのまま返すだけの、単純な中継役です。

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTのみ対応しています" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Vercelの環境変数設定を忘れている場合、原因がすぐ分かるようにする
    res.status(500).json({ error: "サーバー側にANTHROPIC_API_KEYが設定されていません" });
    return;
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      // ブラウザ(App.jsxのcallClaude)から送られてきたbody(model/max_tokens/messages)を
      // そのままClaude APIへ転送する。中身の変更・解釈は一切行わない。
      body: JSON.stringify(req.body),
    });

    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: "Claude APIへの中継中にエラーが発生しました", detail: String(e) });
  }
}
