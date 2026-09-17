# STING 公開用プロジェクト(sting-deploy)

これは、STING(`App.jsx`)を知り合いに使ってもらうための、Web公開用の構成一式です。
STING本体のロジック・画面・データ構造は一切変更していません。

## このフォルダの中身

```
sting-deploy/
├── index.html          公開ページの土台
├── package.json         必要な部品(React・Vite・Tailwindなど)の一覧
├── vite.config.js       ビルド(公開用ファイルへの変換)の設定
├── tailwind.config.js   デザイン(色・角丸など)を反映するための設定
├── postcss.config.js    ↑を動かすための補助設定
├── .gitignore           Gitに含めないファイルの指定(秘密情報を守るため)
├── .env.example         環境変数のテンプレート(実際の値はここには書かない)
├── src/
│   ├── main.jsx          アプリの起動役
│   ├── App.jsx           STING本体(元のApp.jsxをそのままコピー、fetch先だけ変更済み)
│   └── index.css         Tailwindのスタイルを読み込む設定
└── api/
    └── claude.js         「仲介役」サーバー。ここにAPIキーを安全に保管する
```

## なぜこの構成が必要か

STINGは内部でClaude(AI)を呼び出して、翻訳・分類・ロールプレイなどを行っています。
これまでは、Claudeのプレビュー環境だけが持つ特別な仕組みのおかげで、
APIキーを書かなくてもAIが呼べていました。

しかし、これを独立したURLとして公開すると、その特別な仕組みは使えません。
かといって、APIキーをブラウザ側のコードに直接書いてしまうと、
**サイトを見た人全員がそのキーを盗み見て、勝手に使えてしまいます。**

そこで、`api/claude.js` という「仲介役」を1つ用意しました。

```
知り合いのブラウザ → STINGの画面(あなたが公開したページ)
                     ↓ (AIを使いたいとき)
                   仲介役サーバー(api/claude.js、APIキーはここにだけ保管)
                     ↓
                 Anthropic(Claude)のAPI
```

APIキーは、この仲介役サーバー側の「環境変数」としてのみ保存され、
ブラウザに送られるコード・知り合いが見る画面には、一切含まれません。

## App.jsxへの変更点(これだけです)

`callClaude`関数の中の、リクエストの送り先だけを変更しました。

```diff
- const res = await fetch("https://api.anthropic.com/v1/messages", {
+ const res = await fetch("/api/claude", {
```

送るデータの中身(`model`・`max_tokens`・`messages`)、STINGの機能・ロジックは
一切変更していません。

## 今後の作業の流れ(このREADMEに沿って、1つずつ進めます)

まだ完了していないステップです。実際に進める際は、1つずつ確認しながら進めます。

1. **Anthropic(Claude)のAPIキーを取得する**
   `console.anthropic.com` にアクセスし、APIキーを発行します。
   (このキーは他人に見せない、あなた専用の"鍵"です)

2. **GitHubアカウントを用意する(無ければ作成)**
   Vercelでの公開・今後の更新を簡単にするために使います。

3. **このフォルダをGitHubに置く(リポジトリを作る)**

4. **Vercelアカウントを作る(GitHubでログインするのが簡単)**

5. **VercelでこのGitHubリポジトリを「Import」する**
   Vercelが自動的にこの構成(Vite + api/フォルダ)を認識します。

6. **Vercelの「Environment Variables」に、APIキーを設定する**
   キー名:`ANTHROPIC_API_KEY`
   値:1で取得したAPIキー
   (`.env.example`と同じ名前にしてあります)

7. **Deployボタンを押す**
   数分で、`https://(プロジェクト名).vercel.app` のようなURLが発行されます。
   これを知り合いに送れば、そのままSTINGを使ってもらえます。

## 今後、修正・更新するときの流れ

一度公開すれば、そのあとは簡単です。

1. コードを修正する(このApp.jsxを編集する)
2. 修正したファイルをGitHubに反映する(pushする)
3. **Vercelが自動的に同じURLへ最新版を反映します**(URLは変わりません)

Cursorで開発する場合も、この「GitHubに反映すれば自動で公開される」という
仕組みはそのまま使えます。

## Cursorへの引き継ぎメモ

- 公開方法:Vercel(GitHub連携によるデプロイ)
- APIキーの保管場所:Vercelの環境変数(`ANTHROPIC_API_KEY`)。コードには含まれない
- 仲介役サーバー:`api/claude.js`(Vercelのサーバーレス関数)。
  STING側の`callClaude`から`/api/claude`を叩く構成
- 変更したのはApp.jsx内の1箇所(fetch先URL)のみ。それ以外のロジック・状態管理・
  ロールプレイ等の仕組みは元のまま
- 音声認識(OpenAI/Google)は未実装。今後Cursorで検討する場合、同じ`api/`フォルダに
  新しいサーバーレス関数(例:`api/transcribe.js`)を追加する形が、この構成と一貫性があります
