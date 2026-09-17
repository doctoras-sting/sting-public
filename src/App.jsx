import React, { useState, useRef, useEffect } from "react";
import { Star, Volume2, Languages } from "lucide-react";

async function callClaude(prompt, maxTokens = 300) {
  // 公開版では、ブラウザから直接Claude APIを呼ばず、APIキーを安全に保管する
  // 仲介役サーバー(/api/claude、Vercelのサーバーレス関数)を経由する。
  // リクエストの中身(model/max_tokens/messages)は元のまま変更していない。
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  // 以前はAPIがエラー応答(レート制限・一時的な過負荷など)を返した場合でも、それがJSONとして
  // パースできる形式である限りここでは何も検知していなかった。その場合data.contentが存在せず、
  // 単に空文字を返すだけで、呼び出し元(getRoleplayTurn等)ではJSON.parse("")が失敗した扱いにしか
  // ならず、実際にAPI側で何が起きたのかがconsole上にも一切残らなかった。開発中に原因を追えるよう、
  // ここで一度だけ明示的にログを残す(ユーザー向け表示は変更しない)。
  if (!res.ok || !data.content) {
    console.error("[callClaude] API error response", {
      status: res.status,
      ok: res.ok,
      body: data,
      promptPreview: prompt.slice(0, 200),
    });
  }
  return (data.content || []).map((b) => b.text || "").join("").trim();
}

// 中国語モードの表示用ピンイン取得(学習用画面でのみ使用。患者さん表示では使わない)
async function fetchPinyin(zhText) {
  if (!zhText || !zhText.trim()) return "";
  try {
    const out = await callClaude(
      `次の中国語の文章のピンインを、声調記号付きで1行だけ出力してください。中国語原文や説明・見出しは一切含めないでください。\n\n中国語: ${zhText}`
    );
    return out.replace(/^["「]|["」]$/g, "").trim();
  } catch (e) {
    return "";
  }
}

// まとめて登録時など、複数件のピンインを1回のAPI呼び出しでまとめて取得する(呼び出し回数削減)
async function fetchPinyinBatch(texts) {
  if (!texts.length) return texts.map(() => "");
  try {
    const list = texts.map((t, i) => `${i}: ${t}`).join("\n");
    const out = await callClaude(
      `次の中国語の文章それぞれについて、声調記号付きのピンインを「番号: ピンイン」の形式で1行ずつ出力してください。他の説明は不要です。\n\n${list}`
    );
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return texts.map((_, i) => {
      const line = lines.find((l) => l.startsWith(`${i}:`) || l.startsWith(`${i}.`));
      return line ? line.replace(/^\d+[:.]\s*/, "").trim() : "";
    });
  } catch (e) {
    return texts.map(() => "");
  }
}

// 職種・診療科コンテキストを1箇所に集約(将来、他診療科/他職種向けに差し替える際もここだけ変更すればよい構成)
// 仕事プロフィール(appProfile、下記)が未設定の場合にのみ使われる最終フォールバック。
const APP_CONTEXT = {
  domainLabel: "美容皮膚科医", // 例: 看護師、美容師、営業職 などに将来差し替え可能。今回は美容皮膚科の動作確認のため変更
};

// 仕事プロフィール(職業カテゴリ・職種/役割)をlocalStorageに保存するためのkeyとヘルパー。
// アプリ全体で「現在使っている仕事プロフィール」を1つだけ保持する(複数プロフィールの保存・切り替えは対象外)。
const APP_PROFILE_STORAGE_KEY = "sting_appProfile";
function loadAppProfile() {
  try {
    const raw = localStorage.getItem(APP_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (!parsed.occupationCategory && !parsed.occupation)) return null;
    return { occupationCategory: parsed.occupationCategory || "", occupation: parsed.occupation || "" };
  } catch (e) {
    return null;
  }
}

// 累計トレーニング時間(5分復習+ロールプレイで実際に取り組んでいた時間の合計、ミリ秒)をlocalStorageに保存するためのkeyとヘルパー。
const TRAINING_TIME_STORAGE_KEY = "sting_totalTrainingMs";
function loadTotalTrainingMs() {
  try {
    const raw = localStorage.getItem(TRAINING_TIME_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}
// 累計時間を「約◯時間◯分」のようなざっくりした表示に変換する(厳密な秒数までは出さない)
function formatTrainingTime(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `約${m}分`;
  if (m === 0) return `約${h}時間`;
  return `約${h}時間${m}分`;
}

// 「言えるようになった表現」(👑)のid一覧をlocalStorageに保存するためのkeyとヘルパー。
// idは言語ごとに一意のため、英語版・中国語版は別の表現として数えられる(仕様通り)。
const CROWNED_IDS_STORAGE_KEY = "sting_crownedExprIds";
function loadCrownedIds() {
  try {
    const raw = localStorage.getItem(CROWNED_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

// 翻訳系プロンプト(次の日本語を◯語に翻訳してください、系)で共通して使う視点の前提。
// 原文の意味を変えるものではなく、代名詞・所有格などの視点が曖昧な場合の解決基準として渡す。
// 複数の翻訳プロンプトに同じ文言を個別に書くと表現がずれていく(重複指示化する)ため、ここに集約する。
const POV_INSTRUCTION =
  "原則として、ユーザーが対話相手に向かって話しかける場面を想定してください。代名詞・所有格・視点(you/your等)は会話相手を基準にした自然な言い方にしてください。";

const UNCLASSIFIED_ID = "f_unclassified";
// 言語設定を1箇所に集約(将来言語を追加する場合はここに1件足すだけでよい構成)
const LANGUAGES = [
  { code: "en", tag: "EN", label: "English", nameJa: "英語", speech: "en-US", flag: "🇬🇧" },
  { code: "cn", tag: "CN", label: "Simplified Chinese", nameJa: "中国語", speech: "zh-CN", flag: "🇨🇳" },
];
const langOf = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
const otherLangOf = (code) => (code === "en" ? "cn" : "en");

// idSeedをlocalStorageに永続化するためのkey。以前はセッション(ページ再読み込み)のたびに
// idSeedが100から再スタートしていたため、expressions/foldersを永続化していないこのアプリでは、
// 別セッションで作られた別の表現が偶然同じidを再び受け取ってしまうことがあった。
// これ自体がバグの直接原因だったわけではないが、crownedIds(👑の対象idの集合)だけは
// localStorageで永続化されているため、上記の「idの再利用」が起きると、過去に👑が付いたidを
// 別の(達成していない)表現が引き継いでしまい、誤って👑が表示される事例が確認された。
// このため、idSeedもページ再読み込みをまたいで単調増加させ、二度と同じ数字を発行しないようにする。
const ID_SEED_STORAGE_KEY = "sting_idSeed";
// 初回導入時(sting_idSeedがまだ存在しない場合)に単純に100から始めると、その時点で既に
// crownedIdsに残っている過去のe_数字と衝突する可能性がある。そのため初回だけ、crownedIds内の
// 既存idの最大値を確認し、それより大きい値から開始する(新しい永続化の仕組みは増やさない、
// 最小限の初回フォールバックとしての処理)。
function initialIdSeed() {
  try {
    const raw = localStorage.getItem(ID_SEED_STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 100) return n;
    }
  } catch (e) {
    return 100;
  }
  let maxExisting = 99;
  try {
    const crownedRaw = localStorage.getItem(CROWNED_IDS_STORAGE_KEY);
    const arr = crownedRaw ? JSON.parse(crownedRaw) : [];
    if (Array.isArray(arr)) {
      arr.forEach((id) => {
        const m = typeof id === "string" && id.match(/_(\d+)$/);
        if (m) maxExisting = Math.max(maxExisting, Number(m[1]));
      });
    }
  } catch (e) {
    // 読み取れない場合は99のまま(=100から開始)にフォールバックする
  }
  return maxExisting + 1;
}
let idSeed = initialIdSeed();
const newId = (prefix) => {
  const id = `${prefix}_${idSeed++}`;
  try {
    localStorage.setItem(ID_SEED_STORAGE_KEY, String(idSeed));
  } catch (e) {
    // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
  }
  return id;
};

// 辞書(expressions/folders)・復習優先度(weakExpressionIds)・設定(settings)を
// localStorageに保存するためのkeyとヘルパー。既存のappProfile等と同じ形(load関数+useEffectでの自動保存)。
const EXPRESSIONS_STORAGE_KEY = "sting_expressions";
function loadExpressions(seed) {
  try {
    const raw = localStorage.getItem(EXPRESSIONS_STORAGE_KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : seed;
  } catch (e) {
    return seed;
  }
}
const FOLDERS_STORAGE_KEY = "sting_folders";
function loadFolders(seed) {
  try {
    const raw = localStorage.getItem(FOLDERS_STORAGE_KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : seed;
  } catch (e) {
    return seed;
  }
}
const WEAK_EXPRESSION_IDS_STORAGE_KEY = "sting_weakExpressionIds";
function loadWeakExpressionIds() {
  try {
    const raw = localStorage.getItem(WEAK_EXPRESSION_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}
const SETTINGS_STORAGE_KEY = "sting_settings";
function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...defaults, ...parsed } : defaults;
  } catch (e) {
    return defaults;
  }
}

// 翻訳履歴・進行中ロールプレイなど、保存から24時間だけ復元対象にしたいデータ用の共通ヘルパー。
// state自体の形は変えず、保存時に{savedAt, data}で包み、読み込み時に24時間を過ぎていれば
// 「無かったもの」としてfallbackを返す(既存の各stateのload関数と同じ役割分担)。
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function loadWithExpiry(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== "number") return fallback;
    if (Date.now() - parsed.savedAt > ONE_DAY_MS) return fallback;
    return parsed.data;
  } catch (e) {
    return fallback;
  }
}
function saveWithExpiry(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch (e) {
    // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
  }
}
function clearStoredKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    // localStorageが使えない環境では何もしない
  }
}
const TRANSLATION_HISTORY_STORAGE_KEY = "sting_translationHistory";
const ROLEPLAY_TARGET_STORAGE_KEY = "sting_roleplayTarget";
const ROLEPLAY_CASE_DATA_STORAGE_KEY = "sting_roleplayCaseData";
const ROLEPLAY_SESSION_STORAGE_KEY = "sting_roleplaySession";

// まとめて登録の貼り付けテキストを解析する。AIは使わず、すべてローカルの文字種判定・区切り判定で行う。
// 方針:「登録件数を増やすこと」より「間違った日本語×英語ペアを作らないこと」を優先する。
// 各行を先頭から順に、直前の行の解釈結果に引きずられないよう1行(または直後の1行との組)ごとに独立して判定する。
// 認識できない行があっても、その行を捨てて次に進むだけで、前後の正常なペアの対応関係はズレない。
function stripLeadingMarker(line) {
  return line.replace(/^[\s\u3000]*(?:[0-9０-９]+[.、)．・]|[・•\-‐−―*])[\s\u3000]*/, "");
}

function containsJapanese(str) {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(str);
}

// 「日本語のみの行」らしいか(英単語らしき3文字以上のアルファベット連続が無い)
function isJaOnlyLine(line) {
  return containsJapanese(line) && !/[A-Za-z]{3,}/.test(line);
}

// 「訳文のみの行」らしいか(アルファベットを含み、日本語の文字を含まない)
function isEnOnlyLine(line) {
  return /[A-Za-z]/.test(line) && !containsJapanese(line);
}

// まとめて登録の言語混在チェック(ローカルの文字種判定のみ・AI不要)。
// 文法・自然さ・翻訳の正確さは見ず、「対象言語の文字が実質的に含まれていない」という
// 明らかな取り違えだけを弾く(例:中国語欄が"nihao"のようにアルファベットのみ/英語欄が日本語のみ)。
// 中国語欄にアルファベット・数字が少量混ざる正常なケース(型番・数値など)は弾かない。
function looksLikeTargetLangScript(text, targetLang) {
  if (targetLang === "cn") {
    // 中国語として扱うには漢字を1文字以上含み、かつひらがな・カタカナを含まないこと。
    // 英字・数字・記号の混在(例:「KOH検査」)は許容し、英字の有無だけでは判定しない。
    return /[\u4E00-\u9FFF]/.test(text) && !/[\u3040-\u30FF]/.test(text);
  }
  return !containsJapanese(text); // 日本語のかな・漢字を含んでいれば英語として扱わない
}

function splitByScriptBoundary(line) {
  const idx = line.search(/[A-Za-z]/);
  if (idx <= 0) return null; // 英字が先頭にある、または英字が無い
  const ja = line.slice(0, idx).trim();
  const en = line.slice(idx).trim();
  if (!ja || !en) return null;
  // かな(ひらがな/カタカナ)を含む場合だけ採用する(漢字だけだと中国語との判別に自信が持てないため)
  if (!/[\u3040-\u30FF]/.test(ja)) return null;
  return { ja, en };
}

// 1行だけで「日本語+訳文」が完結しているかを判定する(区切り文字が無い場合も含む)
function tryLinePair(rawLine, targetLang) {
  const line = stripLeadingMarker(rawLine);
  // タブ・空白など、ユーザーが実際に入力した区切りがあれば、まずそれを優先する。
  // 文字種の変わり目だけで区切ろうとすると、訳文側に混じった漢字(例:中国語+英語)まで
  // 日本語側に飲み込んでしまうことがあるため、明示的な区切りがあるときはそちらを信頼する。
  if (line.includes("\t")) {
    const idx = line.indexOf("\t");
    const ja = line.slice(0, idx).trim();
    const en = line.slice(idx + 1).trim();
    if (ja && en && containsJapanese(ja)) return { ja, en };
  }
  const m = line.match(/^(\S+)[\s\u3000]+(\S.*)$/);
  if (m) {
    const ja = m[1].trim();
    const en = m[2].trim();
    if (ja && en && containsJapanese(ja)) return { ja, en };
  }
  // 区切り文字が無い場合(日本語と訳文が隙間なく続いている)だけ、文字種の変わり目で推測する
  if (targetLang === "en") {
    const byScript = splitByScriptBoundary(line);
    if (byScript) return byScript;
  }
  return null;
}

function parseBulkPaste(text, targetLang) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const pairs = [];
  const unrecognized = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const stripped = stripLeadingMarker(raw);

    // 1) この行だけで「日本語+訳文」が完結しているか(タブ/空白区切り/文字種の境目)
    const singleLinePair = tryLinePair(raw, targetLang);
    if (singleLinePair) {
      if (looksLikeTargetLangScript(singleLinePair.en, targetLang)) {
        pairs.push(singleLinePair);
        i += 1;
        continue;
      }
      unrecognized.push(raw);
      i += 1;
      continue;
    }

    // 2) この行が「日本語のみ」で、直後の1行が「訳文のみ」の場合だけ、確実な組として採用する
    //    (「次が英語だから前とペア」という推測はせず、両方の条件が揃った時だけペアにする)
    const nextRaw = lines[i + 1];
    if (nextRaw !== undefined && isJaOnlyLine(stripped)) {
      const nextStripped = stripLeadingMarker(nextRaw);
      // 訳文らしい行かどうかの判定: 英語はisEnOnlyLine(アルファベット必須)のまま維持し、
      // 中国語はアルファベットを含まないため、既存のlooksLikeTargetLangScriptのみで判定する
      const translationLineOk =
        targetLang === "cn"
          ? looksLikeTargetLangScript(nextStripped, targetLang)
          : isEnOnlyLine(nextStripped) && looksLikeTargetLangScript(nextStripped, targetLang);
      if (translationLineOk) {
        pairs.push({ ja: stripped, en: nextStripped });
        i += 2;
        continue;
      }
    }

    // 3) どちらにも当てはまらない行は、前後に影響を与えないよう単独で「認識できない行」として扱う
    unrecognized.push(raw);
    i += 1;
  }
  return { pairs, unrecognized };
}

// 同じ日本語原文を持つ表現は同じconceptIdで紐づける(EN/CNの同一性判定はconceptIdを使い、
// 日本語の文字列一致に依存しない)。新規に日本語を入力する場面(翻訳・AI検索・一括登録)だけ、
// 既存のconceptを探すためにja文字列を使う。
// AIが返したフォルダ名を、既存フォルダに寄せる(ローカル処理・API不要)。
// 完全一致を最優先し、無ければ「どちらかがどちらかを含む」部分一致のうち最も長く一致するものを採用する。
// 例:「乾燥肌ケア」→「乾燥肌」、「白癬治療」→「白癬」
// 「再診」「薬」「検査」のような、特定の疾患名ではなく一般的な処置・プロセスを表すフォルダ名かどうか。
// これらは文中にその言葉が無くても、意味的な分類(例:「2週間後にまた来てください」→「再診」)を許可する。
// 「共通」も、疾患名ではなく「特定テーマに依存しない」ことを示す言葉として同じ扱いにする。
// 予測入力の検索で、数字と漢数字(基本的な1〜10)を同一視するための変換表
const KANJI_TO_ARABIC = { "〇": "0", "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10" };
// 入力が数字の「読み」そのもの(例:「に」)と完全一致する場合だけ、対応する数字として扱う(曖昧なひらがな一致を避けるため)
const HIRAGANA_TO_NUM = { "いち": "1", "に": "2", "さん": "3", "よん": "4", "し": "4", "ご": "5", "ろく": "6", "なな": "7", "しち": "7", "はち": "8", "きゅう": "9", "く": "9", "じゅう": "10" };

const GENERIC_FOLDER_KEYWORDS = ["薬", "再診", "検査", "治療", "生活指導", "経過観察", "フォローアップ", "予約", "診察", "説明", "共通"];
function isGenericFolderName(name) {
  return GENERIC_FOLDER_KEYWORDS.some((kw) => name.includes(kw));
}

// 「アトピー＞再診」のような複合フォルダ名を「＞」「>」「<」で区分に分解する(構造の解析のみ。特定の名前は持たない)
function getFolderSegments(name) {
  return name.split(/[＞><]/).map((s) => s.trim()).filter(Boolean);
}

function matchExistingFolderName(name, existingPaths) {
  const target = name.trim();
  const exact = existingPaths.find((p) => p.trim() === target);
  if (exact) return exact;
  const candidates = existingPaths.filter((p) => target.includes(p.trim()) || p.trim().includes(target));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // 候補が複数ある場合、探している名前(target)自体が一般的な処置語なら、
  // より「テーマ区分を含まない(一般的な)」候補を優先する。
  // (例:「再診」で検索した場合、「アトピー＞再診」より「共通＞再診」を優先する)
  const scored = candidates.map((p) => ({
    p,
    specificCount: getFolderSegments(p).filter((seg) => !isGenericFolderName(seg)).length,
  }));
  if (isGenericFolderName(target)) {
    scored.sort((a, b) => a.specificCount - b.specificCount || b.p.length - a.p.length);
  } else {
    scored.sort((a, b) => b.p.length - a.p.length);
  }
  return scored[0].p;
}

// 同一性判定の前に軽く正規化する(空白の差・末尾の句点の有無などで別concept扱いになるのを防ぐ、重複判定の取りこぼし対策)
function normalizeJa(s) {
  return s.trim().replace(/\s+/g, "").replace(/[。.、,]+$/, "");
}

function resolveConceptId(expressions, ja) {
  const key = normalizeJa(ja);
  const sibling = expressions.find((e) => normalizeJa(e.ja) === key);
  return sibling ? sibling.conceptId : newId("c");
}

// 同じconceptId × 同じ言語の表現がすでに存在するかを調べる(重複保存防止)
function findDuplicateExpression(expressions, conceptId, lang) {
  return expressions.find((e) => e.conceptId === conceptId && e.lang === lang);
}

// folderIdsから、保存完了トーストに表示する短いフォルダ名を作る(表示専用。分類・保存ロジックには関与しない)。
// 「未分類」を決め打ちせず、実際のfolderIdsの中身をfoldersと突き合わせて返す。
function describeFolderIds(folderIds, folders) {
  if (!folderIds || folderIds.length === 0) return "未分類";
  if (folderIds.length === 1 && folderIds[0] === UNCLASSIFIED_ID) return "未分類";
  const names = folderIds.map((fid) => folders.find((f) => f.id === fid)?.path).filter(Boolean);
  return names.length > 0 ? names.join(" / ") : "未分類";
}

// 保存時の「似た表現」チェック用。まずローカルの文字bigram重なりで安価に候補を絞り込み、
// 候補が無ければAIを呼ばない(入力中の高速検索とは別物・保存ボタンを押した時だけ動く)。
function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function bigramJaccard(a, b) {
  const A = bigramSet(a);
  const B = bigramSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((x) => {
    if (B.has(x)) inter++;
  });
  return inter / (A.size + B.size - inter);
}

// 「似ている」ではなく「まったく同じ」表現が既にあるかを判定する(訳文そのものの完全一致で判定)。
// findSimilarExisting(日本語の意味的な近さをAIで判定)とは別物で、こちらはローカルの文字列比較のみ、APIは呼ばない。
function findExactExpression(expressions, lang, text) {
  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const target = norm(text);
  if (!target) return null;
  return expressions.find((e) => e.lang === lang && norm(e.en) === target) || null;
}

async function findSimilarExisting(expressions, jaText, lang) {
  const normalizedNew = normalizeJa(jaText);
  const pool = expressions.filter((e) => e.lang === lang && normalizeJa(e.ja) !== normalizedNew);
  if (pool.length === 0) return null;

  // 1) ローカルでざっくり候補を絞る(明らかに無関係なものを除外。ここはAPI不要)
  const shortlist = pool
    .map((e) => ({ e, sim: bigramJaccard(normalizedNew, normalizeJa(e.ja)) }))
    .filter((x) => x.sim >= 0.25)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3);
  if (shortlist.length === 0) return null;

  // 2) 絞り込んだ少数の候補だけをAIに渡し、意味・構造がかなり近いものだけを最終確認する
  try {
    const list = shortlist.map((s, i) => `${i}: ${s.e.ja}`).join("\n");
    const prompt =
      `次の「新しい文章」と「既存の候補」を比較し、意味・文章構造がかなり近いものだけを選んでください。\n` +
      `単なる文字の一部一致ではなく、実際に似た場面で使う表現かどうかで判断してください(例:「腕にたっぷり塗りましょう」と「足にたっぷり塗りましょう」は部位以外がほぼ同じなので近い)。\n` +
      `近いものが無ければ空配列にしてください。何でも近いと判定しすぎないでください。\n\n` +
      `新しい文章: ${jaText}\n\n既存の候補:\n${list}\n\n` +
      `次のJSON形式のみを出力してください(説明不要)。\n{"matches":[該当するインデックスの数字の配列]}`;
    const out = await callClaude(prompt);
    const cleaned = out.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.matches) && parsed.matches.length > 0) {
      const idx = parsed.matches[0];
      return shortlist[idx] ? shortlist[idx].e : null;
    }
    return null;
  } catch (e) {
    return null; // 判定に失敗した場合は確認なしでそのまま保存に進む(保存操作を妨げない)
  }
}

function getRecognition(lang) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = lang;
  r.interimResults = false;
  r.maxAlternatives = 1;
  return r;
}

export default function App() {
  const [screen, setScreen] = useState("translate"); // translate | mydict | bulk | chat | review | history | settings | roleplayHub | roleplaySelect | roleplayCase | roleplayChat | roleplayReview
  const [lastMainScreen, setLastMainScreen] = useState("translate");
  const [hasSeenPredictHint, setHasSeenPredictHint] = useState(false);
  const [lang, setLang] = useState("en");
  const [checkingSimilar, setCheckingSimilar] = useState(false);
  const [similarCheck, setSimilarCheck] = useState(null); // {match, onProceed, onUseExisting}

  // 設定値。現状アプリ全体に永続化の仕組みが無いため、他のstate(expressions等)と同じくセッション中のみ保持する。
  // 今後設定項目が増えることを見越して1オブジェクトにまとめてあるが、今回は類似表現ON/OFFのみ。
  const [settings, setSettings] = useState(() => loadSettings({ similarCheckEnabled: true }));
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [settings]);

  // 仕事プロフィール(職業カテゴリ・職種/役割)。アプリ全体で使う「現在の仕事プロフィール」を1つだけ保持し、
  // localStorageで永続化する(リロード後も保持)。複数プロフィールの保存・切り替えは対象外(最小構成)。
  // ロールプレイ固有の設定(roleplayProfile: sceneNote/customizationNote等)とは別のstateとして分離している。
  const [appProfile, setAppProfile] = useState(() => loadAppProfile());

  useEffect(() => {
    try {
      if (appProfile && (appProfile.occupationCategory || appProfile.occupation)) {
        localStorage.setItem(APP_PROFILE_STORAGE_KEY, JSON.stringify(appProfile));
      } else {
        localStorage.removeItem(APP_PROFILE_STORAGE_KEY);
      }
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [appProfile]);

  // 仕事プロフィール(保存済みappProfile)を優先し、未設定の場合のみAPP_CONTEXTを最終フォールバックとして使う。
  // 辞書分類(classifyAndSave/bulkClassify)のプロンプトで使用する。
  const currentOccupationLabel = (appProfile && (appProfile.occupation || appProfile.occupationCategory)) || APP_CONTEXT.domainLabel;

  // 累計トレーニング時間(5分復習+ロールプレイで実際に取り組んでいた時間の合計、ミリ秒)。localStorageで永続化する。
  const [totalTrainingMs, setTotalTrainingMs] = useState(() => loadTotalTrainingMs());
  useEffect(() => {
    try {
      localStorage.setItem(TRAINING_TIME_STORAGE_KEY, String(totalTrainingMs));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [totalTrainingMs]);
  const addTrainingTime = (ms) => {
    if (!ms || ms <= 0) return;
    setTotalTrainingMs((prev) => prev + ms);
  };

  // 「言えるようになった表現」(👑)のid集合。一度この条件を満たしたら、その後失敗しても外さない累積実績。localStorageで永続化する。
  const [crownedIds, setCrownedIds] = useState(() => loadCrownedIds());
  useEffect(() => {
    try {
      localStorage.setItem(CROWNED_IDS_STORAGE_KEY, JSON.stringify([...crownedIds]));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [crownedIds]);
  const markCrowned = (exprId) => {
    if (!exprId) return;
    setCrownedIds((prev) => (prev.has(exprId) ? prev : new Set(prev).add(exprId)));
  };

  const [folders, setFolders] = useState(() => loadFolders([
    { id: "f_common_return", path: "共通＞再診", createdLang: "en" },
    { id: "f_common_return_cn", path: "共通＞再診", createdLang: "cn" },
    { id: "f_atopy_return", path: "アトピー＞再診", createdLang: "en" },
    { id: "f_atopy_return_cn", path: "アトピー＞再診", createdLang: "cn" },
    { id: "f_chronic_return", path: "慢性疾患＞再診", createdLang: "en" },
    { id: "f_chronic_return_cn", path: "慢性疾患＞再診", createdLang: "cn" },
    { id: UNCLASSIFIED_ID, path: "未分類" },
  ]));
  useEffect(() => {
    try {
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [folders]);
  const [expressions, setExpressions] = useState(() => loadExpressions([
    { id: "e_seed1", conceptId: "c_seed_return", ja: "2週間後にもう一度来てください", en: "I'd like you to come back in two weeks.", lang: "en", folderIds: ["f_common_return", "f_atopy_return", "f_chronic_return"] },
    { id: "e_seed2", conceptId: "c_seed_return", ja: "2週間後にもう一度来てください", en: "请两周后再来。", pinyin: "Qǐng liǎng zhōu hòu zài lái.", lang: "cn", folderIds: ["f_common_return_cn", "f_atopy_return_cn", "f_chronic_return_cn"] },
    { id: "e_seed3", conceptId: "c_seed_apply", ja: "この薬を1日2回塗ってください", en: "Apply this medicine twice a day.", lang: "en", folderIds: ["f_atopy_return"] },
    { id: "e_seed4", conceptId: "c_seed_apply", ja: "この薬を1日2回塗ってください", en: "请每天涂两次这个药膏。", pinyin: "Qǐng měitiān tú liǎng cì zhège yàogāo.", lang: "cn", folderIds: ["f_atopy_return_cn"] },
    { id: "e_seed5", conceptId: "c_seed_worse", ja: "悪化したらまた来てください", en: "Please come back if it gets worse.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_seed6", conceptId: "c_seed_worse", ja: "悪化したらまた来てください", en: "如果恶化，请再来复诊。", pinyin: "Rúguǒ èhuà, qǐng zài lái fùzhěn.", lang: "cn", folderIds: ["f_common_return_cn"] },
    // ↓辞書インデックス(五十音ジャンプUI)の実機確認用テストデータ。既存フォルダ「共通＞再診」に追加し、
    // 日本語の頭文字があ・か・さ・た・な・は・ま・や・漢字始まりなど複数行にまたがるようにしてある。
    // 既存データは変更・削除していない(純粋な追加のみ)。確認後は削除して構わない。
    { id: "e_idx1", conceptId: "c_idx1", ja: "あとで来てください", en: "Please come back later.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx1_cn", conceptId: "c_idx1", ja: "あとで来てください", en: "请稍后再来。", pinyin: "Qǐng shāohòu zài lái.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx2", conceptId: "c_idx2", ja: "あまり無理しないでください", en: "Please don't overdo it.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx2_cn", conceptId: "c_idx2", ja: "あまり無理しないでください", en: "请不要太勉强。", pinyin: "Qǐng búyào tài miǎnqiǎng.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx3", conceptId: "c_idx3", ja: "かゆみはありますか", en: "Do you have any itching?", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx3_cn", conceptId: "c_idx3", ja: "かゆみはありますか", en: "有痒感吗？", pinyin: "Yǒu yǎng gǎn ma?", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx4", conceptId: "c_idx4", ja: "かぜをひかないように気をつけてください", en: "Please be careful not to catch a cold.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx4_cn", conceptId: "c_idx4", ja: "かぜをひかないように気をつけてください", en: "请注意不要感冒。", pinyin: "Qǐng zhùyì búyào gǎnmào.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx5", conceptId: "c_idx5", ja: "最近眠れていますか", en: "Have you been sleeping well lately?", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx5_cn", conceptId: "c_idx5", ja: "最近眠れていますか", en: "最近睡得好吗？", pinyin: "Zuìjìn shuì de hǎo ma?", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx6", conceptId: "c_idx6", ja: "さっきの検査の結果です", en: "Here are the results of that test.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx6_cn", conceptId: "c_idx6", ja: "さっきの検査の結果です", en: "这是刚才检查的结果。", pinyin: "Zhè shì gāngcái jiǎnchá de jiéguǒ.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx7", conceptId: "c_idx7", ja: "食べ物のアレルギーはありますか", en: "Do you have any food allergies?", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx7_cn", conceptId: "c_idx7", ja: "食べ物のアレルギーはありますか", en: "有食物过敏吗？", pinyin: "Yǒu shíwù guòmǐn ma?", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx8", conceptId: "c_idx8", ja: "体重は変わりましたか", en: "Has your weight changed?", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx8_cn", conceptId: "c_idx8", ja: "体重は変わりましたか", en: "体重有变化吗？", pinyin: "Tǐzhòng yǒu biànhuà ma?", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx9", conceptId: "c_idx9", ja: "何か気になることはありますか", en: "Is there anything else concerning you?", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx9_cn", conceptId: "c_idx9", ja: "何か気になることはありますか", en: "还有什么担心的事吗？", pinyin: "Hái yǒu shénme dānxīn de shì ma?", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx10", conceptId: "c_idx10", ja: "はじめまして", en: "Nice to meet you.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx10_cn", conceptId: "c_idx10", ja: "はじめまして", en: "初次见面。", pinyin: "Chūcì jiànmiàn.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx11", conceptId: "c_idx11", ja: "毎日忘れずに塗ってください", en: "Please remember to apply it every day.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx11_cn", conceptId: "c_idx11", ja: "毎日忘れずに塗ってください", en: "请每天记得涂抹。", pinyin: "Qǐng měitiān jìde túmǒ.", lang: "cn", folderIds: ["f_common_return_cn"] },
    { id: "e_idx12", conceptId: "c_idx12", ja: "休みの日も同じように過ごしてください", en: "Please spend your days off the same way.", lang: "en", folderIds: ["f_common_return"] },
    { id: "e_idx12_cn", conceptId: "c_idx12", ja: "休みの日も同じように過ごしてください", en: "休息日也请照常生活。", pinyin: "Xiūxi rì yě qǐng zhàocháng shēnghuó.", lang: "cn", folderIds: ["f_common_return_cn"] },
    // ↓一括整理機能の実機確認用テストデータ(分類AIは一切呼ばず、最初から未分類に直接投入)
    // conceptIdをあえて分けているので、EN/CNは兄弟表現を持たない単独データ。cn3だけen4と同じconceptIdにして
    // 「兄弟表現があるものを移動しても、兄弟側は動かない」確認に使えるようにしてある。
    { id: "e_test1", conceptId: "c_test1", ja: "保湿剤は1日2回塗ってください", en: "Please apply the moisturizer twice a day.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_test2", conceptId: "c_test2", ja: "かゆみが強い場合は冷やしてください", en: "If the itching is severe, please cool the area.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_test3", conceptId: "c_test3", ja: "1週間後に血液検査をします", en: "We will do a blood test in one week.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_test4", conceptId: "c_test4", ja: "日焼け止めを毎日使ってください", en: "Please use sunscreen every day.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_test5", conceptId: "c_test5", ja: "お風呂の温度はぬるめにしてください", en: "Please keep your bath water lukewarm.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_test1_cn", conceptId: "c_test1", ja: "保湿剤は1日2回塗ってください", en: "请每天涂两次保湿霜。", pinyin: "Qǐng měitiān tú liǎng cì bǎoshī shuāng.", lang: "cn", folderIds: [UNCLASSIFIED_ID] },
    // ↓ロールプレイ機能のテスト用に未分類へ投入(EN)
    { id: "e_rp_test1", conceptId: "c_rp_test1", ja: "調子はどうですか", en: "How are you feeling?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_rp_test2", conceptId: "c_rp_test2", ja: "今から見ますね", en: "I'm going to take a look now.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_rp_test3", conceptId: "c_rp_test3", ja: "検査しますね", en: "I'll run some tests.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    // ↓同じ3表現の中国語版(英語版とconceptIdを揃え、同じ概念の兄弟表現として扱う)
    { id: "e_rp_test1_cn", conceptId: "c_rp_test1", ja: "調子はどうですか", en: "你感觉怎么样？", pinyin: "Nǐ gǎnjué zěnmeyàng?", lang: "cn", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_rp_test2_cn", conceptId: "c_rp_test2", ja: "今から見ますね", en: "我现在给你看一下。", pinyin: "Wǒ xiànzài gěi nǐ kàn yíxià.", lang: "cn", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_rp_test3_cn", conceptId: "c_rp_test3", ja: "検査しますね", en: "我给你做个检查。", pinyin: "Wǒ gěi nǐ zuò gè jiǎnchá.", lang: "cn", folderIds: [UNCLASSIFIED_ID] },
    // ↓美容皮膚科ロールプレイ動作確認用(2026年8月)。【美容皮膚科・基本】
    { id: "e_cd1", conceptId: "c_cd1", ja: "今日はどのようなことで来られましたか？", en: "What brings you in today?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd2", conceptId: "c_cd2", ja: "一番気になっているところはどこですか？", en: "What concerns you the most?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd3", conceptId: "c_cd3", ja: "いつ頃から気になっていますか？", en: "When did you first notice it?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd4", conceptId: "c_cd4", ja: "今までにどんな治療を受けましたか？", en: "What treatments have you had before?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd5", conceptId: "c_cd5", ja: "この治療が適していると思います。", en: "I think this treatment would be suitable for you.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd6", conceptId: "c_cd6", ja: "まずはこの治療から始めてみましょう。", en: "Let's start with this treatment first.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd7", conceptId: "c_cd7", ja: "治療後は一時的に赤みが出ることがあります。", en: "You may have some temporary redness after the treatment.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd8", conceptId: "c_cd8", ja: "前回より赤みが少なくなっています。", en: "The redness is less than it was last time.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd9", conceptId: "c_cd9", ja: "まだ少し乾燥が残っています。", en: "There is still some dryness.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    // ↓【ステロイド確認用】potencyGuideが美容皮膚科でも自然に機能するか確認する目的
    { id: "e_cd10", conceptId: "c_cd10", ja: "この薬はステロイド外用薬です。", en: "This is a topical steroid.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd11", conceptId: "c_cd11", ja: "この薬は比較的弱いステロイドです。", en: "This is a relatively mild topical steroid.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd12", conceptId: "c_cd12", ja: "顔には強いステロイドを長期間使わないようにしてください。", en: "Please avoid using a strong topical steroid on your face for a long period.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd13", conceptId: "c_cd13", ja: "症状が改善したら、塗る回数を減らしましょう。", en: "Once your symptoms improve, let's reduce the frequency of application.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd14", conceptId: "c_cd14", ja: "この薬をどのくらい使いましたか？", en: "How long have you been using this medication?", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    // ↓【ロールプレイ挙動確認用】相手役の状態維持・目標達成判定の確認目的
    { id: "e_cd15", conceptId: "c_cd15", ja: "まだ少し赤みが残っています。", en: "There is still some redness.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
    { id: "e_cd16", conceptId: "c_cd16", ja: "前回より良くなっていますが、完全には治っていません。", en: "It has improved since the last visit, but it hasn't completely cleared up.", lang: "en", folderIds: [UNCLASSIFIED_ID] },
  ]));
  useEffect(() => {
    try {
      localStorage.setItem(EXPRESSIONS_STORAGE_KEY, JSON.stringify(expressions));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [expressions]);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [selectedExpr, setSelectedExpr] = useState(null);

  // ロールプレイ: 進行中セッションはApp直下で保持する(画面を離れても消えないようにするため)。
  // 「アプリを閉じても再開できる」という仕様上の要求のうち、今回は「同じセッション内での再開」までを実装している
  // (アプリ全体の永続化の仕組みが無いため、閉じたら消える点は既存の他機能と同じ制約)。
  const [roleplayTarget, setRoleplayTarget] = useState(() => loadWithExpiry(ROLEPLAY_TARGET_STORAGE_KEY, null)); // 選んだ目標表現(24時間だけ復元対象)
  useEffect(() => {
    if (roleplayTarget) saveWithExpiry(ROLEPLAY_TARGET_STORAGE_KEY, roleplayTarget);
    else clearStoredKey(ROLEPLAY_TARGET_STORAGE_KEY);
  }, [roleplayTarget]);
  const [roleplayProfile, setRoleplayProfile] = useState(null); // 職種・職業・使う場面の自由入力設定(1つだけ保持、複数管理はしない)。{occupationCategory, occupation, sceneNote, customizationNote}
  const [roleplaySiblings, setRoleplaySiblings] = useState([]); // 同じフォルダ内の他表現
  const [roleplayCaseData, setRoleplayCaseData] = useState(() => loadWithExpiry(ROLEPLAY_CASE_DATA_STORAGE_KEY, null)); // ケース生成結果(開始時1回だけ生成、以後使い回す。24時間だけ復元対象)
  useEffect(() => {
    if (roleplayCaseData) saveWithExpiry(ROLEPLAY_CASE_DATA_STORAGE_KEY, roleplayCaseData);
    else clearStoredKey(ROLEPLAY_CASE_DATA_STORAGE_KEY);
  }, [roleplayCaseData]);
  const [roleplaySession, setRoleplaySession] = useState(() => loadWithExpiry(ROLEPLAY_SESSION_STORAGE_KEY, null)); // 会話の進行状態 {transcript, turnCount, achievedEver, ...}(24時間だけ復元対象)
  useEffect(() => {
    if (roleplaySession) saveWithExpiry(ROLEPLAY_SESSION_STORAGE_KEY, roleplaySession);
    else clearStoredKey(ROLEPLAY_SESSION_STORAGE_KEY);
  }, [roleplaySession]);
  const [chatEditingActive, setChatEditingActive] = useState(false); // AI検索の編集画面が開いている間、右上の言語切替をロックするためだけの軽量フラグ
  const [weakExpressionIds, setWeakExpressionIds] = useState(() => loadWeakExpressionIds()); // 5分復習で優先したい表現id(ロールプレイでsuccess以外だったもの)
  useEffect(() => {
    try {
      localStorage.setItem(WEAK_EXPRESSION_IDS_STORAGE_KEY, JSON.stringify([...weakExpressionIds]));
    } catch (e) {
      // localStorageが使えない環境では永続化のみ諦め、アプリの動作自体は継続する
    }
  }, [weakExpressionIds]);

  const markRoleplayResult = (exprId, result) => {
    setWeakExpressionIds((prev) => {
      const next = new Set(prev);
      if (result === "success") next.delete(exprId);
      else next.add(exprId);
      return next;
    });
    // 👑「言えるようになった表現」の記録。既存のtargetResult判定・weakExpressionIdsの挙動には影響しない
    if (result === "success") markCrowned(exprId);
  };

  const startNewRoleplay = (target, siblings) => {
    setRoleplayTarget(target);
    setRoleplaySiblings(siblings);
    setRoleplayCaseData(null);
    setRoleplaySession(null);
    setScreen("roleplayCase");
  };

  const roleplayCaseReady = (caseData) => {
    setRoleplayCaseData(caseData);
    setRoleplaySession({
      transcript: [{ role: "patient", text: caseData.openingLine, textJa: caseData.openingLineJa, pinyin: caseData.openingLinePinyin }],
      turnCount: 0,
      achievedEver: false,
      showFindings: false,
      showLab: false,
      findingsRevealed: false,
      labRevealed: false,
      findingsCardVisible: false,
      labCardVisible: false,
      additionalTests: [], // 診察中に医師が要求した想定外の検査(KOH等)の動的な結果を保持する
      lastEndState: "normal",
      concluded: false,
      analysis: null, // 添削結果のキャッシュ(添削画面が同一セッション内で再マウントされても再生成しないため)
      hints: [], // 💡ヒント候補(最新のcounterpartRole発言に対するもの。ターンごとに上書きされる)
    });
    setScreen("roleplayChat");
  };

  const endRoleplaySession = (finalTranscript, endReason) => {
    setRoleplaySession((prev) => (prev ? { ...prev, transcript: finalTranscript, endReason } : prev));
    setScreen("roleplayReview");
  };

  const finishRoleplay = () => {
    // セッション完了。進行中セッションを消す(=復習画面の「続きから」カードも消える)
    setRoleplayTarget(null);
    setRoleplaySiblings([]);
    setRoleplayCaseData(null);
    setRoleplaySession(null);
    setScreen("roleplayHub");
  };

  const [toast, setToast] = useState(null);
  const showToast = (text, muted) => {
    setToast({ text, muted });
    setTimeout(() => setToast(null), 2500);
  };

  // 翻訳履歴: 保存操作をする余裕がなかった翻訳を後から拾えるようにするための一時的な記録。
  // 辞書(expressions)とは別物で、ここに入っただけでは辞書には保存されない。
  // 直近5件のみ保持(古いものは自動的に切り捨て、無期限に増え続けない)。
  // 現状このアプリ全体に永続化の仕組みが無いため、他の状態(expressions/folders等)と同様、
  // アプリを開いている間だけメモリ上に保持される(セッションが終わると消える)。
  const [translationHistory, setTranslationHistory] = useState(() => loadWithExpiry(TRANSLATION_HISTORY_STORAGE_KEY, []));
  useEffect(() => {
    saveWithExpiry(TRANSLATION_HISTORY_STORAGE_KEY, translationHistory);
  }, [translationHistory]);
  const pushTranslationHistory = (entry) => {
    setTranslationHistory((prev) => [{ id: newId("h"), ...entry }, ...prev].slice(0, 5));
  };

  const ROLEPLAY_SCREENS = ["roleplayHub", "roleplaySetup", "roleplaySelect", "roleplayCase", "roleplayChat", "roleplayReview"];
  const goto = (s) => {
    if (s !== "review" && !ROLEPLAY_SCREENS.includes(s)) setLastMainScreen(s);
    setScreen(s);
  };

  // 保存経路をまたいで共通化した「類似表現チェック」。①通常の翻訳 ②フォルダ内保存 ③AI検索(採用/編集)
  // のいずれからでもこれを経由させることで、確認UIとチェックロジックを1箇所にまとめる。
  // 類似表現が無ければ即座にonProceedを実行し、確認UIは一切出さない(体感速度を維持)。
  // 設定でOFFの場合はfindSimilarExisting自体を呼ばず(AI APIも呼ばれない)、即座にonProceedへ進む。
  const checkSimilarBeforeSave = async (ja, en, l, pinyin, onProceed, onUseExisting) => {
    if (!settings.similarCheckEnabled) {
      await onProceed();
      return;
    }
    setCheckingSimilar(true);
    const match = await findSimilarExisting(expressions, ja, l);
    setCheckingSimilar(false);
    if (match) {
      setSimilarCheck({ match, onProceed, onUseExisting });
    } else {
      await onProceed();
    }
  };

  const classifyAndSave = async (ja, translated, l, pinyinIn, yomiIn) => {
    // 同じ日本語原文の表現(別言語)が既にあれば、同じconceptIdを使う(EN/CNの同一性はconceptIdで判定)
    const conceptId = resolveConceptId(expressions, ja);
    const sibling = expressions.find((e) => e.conceptId === conceptId);

    // 同じconceptId × 同じ言語がすでにあれば、重複登録しない
    const dup = findDuplicateExpression(expressions, conceptId, l);
    if (dup) {
      showToast(`⚠️ 同じ${langOf(l).tag}表現がすでに登録されています`, true);
      return { duplicate: true };
    }

    let folderIds;
    let toastFolderLabel = null;
    let isUnclassified = false;

    if (sibling) {
      // フォルダは言語ごとに独立しているため、他言語の兄弟表現のfolderIdsをそのまま使わず、
      // そのフォルダ名を今回保存する言語(l)の中で解決し直す(同名フォルダが無ければ未分類にする)
      const siblingPaths = sibling.folderIds.map((fid) => folders.find((f) => f.id === fid)?.path).filter(Boolean);
      const matchedIds = siblingPaths
        .map((p) => folders.find((f) => f.path === p && f.createdLang === l))
        .filter(Boolean)
        .map((f) => f.id);
      folderIds = matchedIds.length > 0 ? matchedIds : [UNCLASSIFIED_ID];
      isUnclassified = folderIds.length === 1 && folderIds[0] === UNCLASSIFIED_ID;
      toastFolderLabel = isUnclassified
        ? null
        : folderIds.map((fid) => folders.find((f) => f.id === fid)?.path).filter(Boolean).join(" / ");
    } else {
      const existingPaths = folders.filter((f) => f.id !== UNCLASSIFIED_ID && f.createdLang === l).map((f) => f.path);
      let path = "未分類";
      try {
        const prompt =
          `あなたは${currentOccupationLabel}向け外国語学習アプリの分類アシスタントです。次の表現を、下の既存フォルダ一覧の中から最も適切な1つに分類してください。\n` +
          `新しいフォルダ名を作ってはいけません。既存フォルダのどれにも自信を持って当てはまらない場合、または少しでも迷う場合は、必ず「未分類」とだけ出力してください。\n` +
          `出力は、既存フォルダ一覧にある文字列と完全に一致するテキスト、または「未分類」のいずれか1行のみです。それ以外は一切出力しないでください。\n\n` +
          `既存フォルダ一覧:\n${existingPaths.join("\n")}\n\n日本語: ${ja}\n訳文: ${translated}`;
        const result = await callClaude(prompt);
        const cleaned = result.split("\n")[0].replace(/["「」`]/g, "").trim();
        path = existingPaths.includes(cleaned) ? cleaned : "未分類";
      } catch (e) {
        path = "未分類";
      }
      const folder = path === "未分類" ? folders.find((f) => f.id === UNCLASSIFIED_ID) : folders.find((f) => f.path === path && f.createdLang === l);
      folderIds = [folder.id];
      isUnclassified = folder.path === "未分類";
      toastFolderLabel = isUnclassified ? null : folder.path;
    }

    const pinyin = l === "cn" ? pinyinIn || (await fetchPinyin(translated)) : undefined;
    const expr = { id: newId("e"), conceptId, ja, en: translated, ...(pinyin ? { pinyin } : {}), ...(yomiIn ? { yomi: yomiIn } : {}), lang: l, folderIds };
    setExpressions((prev) => [expr, ...prev]);
    const folderLabel = isUnclassified ? "未分類" : toastFolderLabel;
    showToast(isUnclassified ? "📥 未分類に保存" : `✅ ${toastFolderLabel} に保存`, isUnclassified);
    return { folderLabel };
  };

  // AI検索の「採用」でユーザーが選んだフォルダへ直接保存する(AI自動分類はスキップ)
  const saveToFolder = (ja, translated, l, pinyin, folderId) => {
    const conceptId = resolveConceptId(expressions, ja);
    const dup = findDuplicateExpression(expressions, conceptId, l);
    const folder = folders.find((f) => f.id === folderId);
    if (dup) {
      // 同じconceptId×言語の表現が既にある場合は重複作成せず、選んだフォルダに既存の表現を追加する
      if (!dup.folderIds.includes(folderId)) {
        const newIds = folderId === UNCLASSIFIED_ID ? dup.folderIds : [...dup.folderIds.filter((id) => id !== UNCLASSIFIED_ID), folderId];
        setExpressions((prev) => prev.map((e) => (e.id === dup.id ? { ...e, folderIds: newIds } : e)));
      }
      showToast(`📌 既存の${langOf(l).tag}表現を ${folder?.path} に追加しました`, false);
      return;
    }
    const expr = { id: newId("e"), conceptId, ja, en: translated, ...(pinyin ? { pinyin } : {}), lang: l, folderIds: [folderId] };
    setExpressions((prev) => [expr, ...prev]);
    showToast(folderId === UNCLASSIFIED_ID ? "📥 未分類に保存" : `✅ ${folder?.path} に保存`, folderId === UNCLASSIFIED_ID);
  };

  const createFolderAndSave = (ja, translated, l, pinyin, folderName) => {
    const name = folderName.trim();
    if (!name) return;
    let folder = folders.find((f) => f.path === name && f.createdLang === l);
    if (!folder) {
      folder = { id: newId("f"), path: name, userCreated: true, createdLang: l };
      setFolders((prev) => [...prev, folder]);
    }
    const conceptId = resolveConceptId(expressions, ja);
    const dup = findDuplicateExpression(expressions, conceptId, l);
    if (dup) {
      if (!dup.folderIds.includes(folder.id)) {
        const newIds = [...dup.folderIds.filter((id) => id !== UNCLASSIFIED_ID), folder.id];
        setExpressions((prev) => prev.map((e) => (e.id === dup.id ? { ...e, folderIds: newIds } : e)));
      }
      showToast(`📌 既存の${langOf(l).tag}表現を ${folder.path} に追加しました`, false);
      return;
    }
    const expr = { id: newId("e"), conceptId, ja, en: translated, ...(pinyin ? { pinyin } : {}), lang: l, folderIds: [folder.id] };
    setExpressions((prev) => [expr, ...prev]);
    showToast(`✅ ${folder.path} に保存`, false);
  };

  const bulkAdd = (rows, l) => {
    // 同じ日本語原文は同じconceptIdにまとめ、同じconceptId×言語がすでにある行は重複登録しない
    const conceptMap = new Map();
    expressions.forEach((e) => {
      const key = normalizeJa(e.ja);
      if (!conceptMap.has(key)) conceptMap.set(key, e.conceptId);
    });
    const existingLangConcepts = new Set(expressions.filter((e) => e.lang === l).map((e) => e.conceptId));

    const created = [];
    let skipped = 0;
    rows.forEach((r) => {
      const key = normalizeJa(r.ja);
      let conceptId = conceptMap.get(key);
      if (!conceptId) {
        conceptId = newId("c");
        conceptMap.set(key, conceptId);
      }
      if (existingLangConcepts.has(conceptId)) {
        skipped += 1;
        return;
      }
      existingLangConcepts.add(conceptId);
      created.push({ id: newId("e"), conceptId, ja: r.ja, en: r.en, lang: l, folderIds: [UNCLASSIFIED_ID] });
    });
    setExpressions((prev) => [...created, ...prev]);
    return { created, skipped };
  };

  const bulkClassify = async (createdList) => {
    // 1. 同じconceptIdの表現(別言語)が既にあるものは、ローカル処理だけでフォルダ所属を引き継ぐ(API不要)
    const localAssignments = {};
    const localYomis = {}; // 兄弟表現がyomiを持っていれば、APIを使わずそのままローカルで引き継ぐ(無ければ無理に推測しない)
    const needsClassification = [];
    for (const item of createdList) {
      const sibling = expressions.find((e) => e.conceptId === item.conceptId && e.id !== item.id);
      if (sibling) {
        // フォルダは言語ごとに独立しているため、他言語の兄弟表現のfolderIdsをそのまま使わず、
        // そのフォルダ名が今回の言語(item.lang)側にすでに存在する場合だけ引き継ぐ。
        // 存在しなければ通常のAI分類(needsClassification)に任せる(新規フォルダの自動作成はしない)。
        const siblingPaths = sibling.folderIds.map((fid) => folders.find((f) => f.id === fid)?.path).filter(Boolean);
        const matchedIds = siblingPaths
          .map((p) => folders.find((f) => f.path === p && f.createdLang === item.lang))
          .filter(Boolean)
          .map((f) => f.id);
        if (matchedIds.length > 0) {
          localAssignments[item.id] = matchedIds;
          if (sibling.yomi) localYomis[item.id] = sibling.yomi;
          continue;
        }
      }
      needsClassification.push(item);
    }

    // 4-早期開始: 中国語表現のピンイン取得を、下記2〜3の分類処理と並行して開始する。
    //    ピンイン取得は分類結果に依存しないため、ここで呼び出しだけ先に始めておき、
    //    結果は元の位置(下記4)でawaitする(cnItems.length===0の場合、fetchPinyinBatch自身が
    //    API呼び出しをせず即座に空配列を返すため、呼び出し回数は変わらない)。
    const cnItems = createdList.filter((it) => it.lang === "cn");
    const pinyinPromise = fetchPinyinBatch(cnItems.map((it) => it.en));

    // 2. 残りは1回のAPI呼び出しでまとめて「大まかなテーマ」ごとにグループ分けする(1件ずつ呼ばない)。
    //    同じ呼び出しに相乗りして各表現の読み(yomi)もまとめて取得し、読み取得のためのAPI呼び出しは追加しない。
    const groupAssignments = {}; // id -> フォルダ名 or undefined(未分類)
    const yomiAssignments = {}; // id -> 読み(ひらがなのみ、バリデーション済み)
    if (needsClassification.length > 0) {
      const existingPaths = folders.filter((f) => f.id !== UNCLASSIFIED_ID).map((f) => f.path);
      const list = needsClassification.map((it, i) => `${i}: ${it.ja}`).join("\n");
      // 原因切り分け用: AIに渡す入力(既存フォルダ一覧・表現リスト)を記録する(挙動には影響しない)
      console.log("[DEBUG bulkClassify input]", { existingPaths, list });
      try {
        const prompt =
          `あなたは${currentOccupationLabel}向け外国語学習アプリの分類アシスタントです。次の日本語表現のリストを、大まかな仕事のテーマ・用件ごとにグループ分けしてください。\n` +
          `フォルダ名は短く大まかにし(例:「注文」「会計」「アレルギー対応」。医療なら「湿疹」「アトピー」「薬」「再診」など)、「〜について説明する表現」のような長く細かい名前にはしないでください。細かく分類しすぎないことを優先してください。\n` +
          `既存フォルダに近いテーマがあれば、できるだけその名前をそのまま再利用してください(表記が完全に同じでなくても構いません。後で近い名前に自動的に寄せます)。\n` +
          `重要: 明らかに別の話題・別の用件を表す表現は、絶対に同じグループにまとめないでください。ある文章が何についての内容か(文中に出てくる具体的な対象・用件)を基準に判断し、対象・用件が異なるものは別グループにしてください(医療の例:「白癬」「ニキビ」「湿疹」「アトピー」のように病名が異なるものは別グループにする)。\n` +
          `一方で、同じ対象・テーマについての複数の側面(例:確認・説明・対応など。医療なら「症状」「治療」「検査」「説明」)がある場合は、無理に細分化せず1つの大分類にまとめてください。\n` +
          `適切なグループが見当たらない項目は無理にグループ化せず未分類にしてください。\n\n` +
          `あわせて、それぞれの表現の読みをひらがなのみで(漢字・カタカナ・句読点・記号は含めない)返してください。\n\n` +
          `既存フォルダ一覧:\n${existingPaths.join("\n")}\n\n表現一覧:\n${list}\n\n` +
          `次のJSON形式のみを出力してください(説明不要)。\n{"groups":[{"folder":"フォルダ名","indexes":[0,2]}],"unclassified":[1],"yomis":{"0":"読み(ひらがなのみ)","1":"読み(ひらがなのみ)","2":"読み(ひらがなのみ)"}}`;
        const out = await callClaude(prompt, 1000);
        // 原因切り分け用: AIの生レスポンスをJSON.parseを試みる前に記録する(パース失敗時も必ず残るようにする、挙動には影響しない)
        console.log("[DEBUG bulkClassify raw response]", out);
        const cleaned = out.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        (parsed.groups || []).forEach((g) => {
          const name = (g.folder || "").trim();
          if (!name) return;
          (g.indexes || []).forEach((idx) => {
            const it = needsClassification[idx];
            if (it) groupAssignments[it.id] = name;
          });
        });
        // yomiはひらがな以外の文字が混ざっていた場合、インデックス分類を誤らせないよう使わない(既存の翻訳画面と同じバリデーション基準)
        const yomiRegex = /^[\u3041-\u3096ー]+$/;
        Object.entries(parsed.yomis || {}).forEach(([idxStr, y]) => {
          const it = needsClassification[Number(idxStr)];
          const yomiRaw = (y || "").trim();
          if (it && yomiRegex.test(yomiRaw)) yomiAssignments[it.id] = yomiRaw;
        });
        // 原因切り分け用: AIから正常に取得・パースできたgroups/yomisの生の内容を確認できるようにする(挙動には影響しない)
        console.log("[DEBUG bulkClassify result]", { groups: parsed.groups, yomis: parsed.yomis });
      } catch (e) {
        // 原因切り分け用: 失敗時は該当分すべて未分類のまま(下でフォールバック)というフォールバック挙動自体は変更せず、
        // 何が原因で失敗したか(API呼び出し自体の例外かJSON parseの構文エラーか)を確認できるようにする
        console.error("[bulkClassify] failed:", e);
      }

      // 原因切り分け用: safety check(2.5)によってgroupAssignmentsがどう変化するかを確認できるよう、
      // 実行前の状態をスナップショットしておく(safety checkの判定条件・挙動自体は変更しない)
      const groupAssignmentsBeforeSafetyCheck = { ...groupAssignments };

      // 2.5 ローカルの安全チェック(API不要)。
      // ここでの判定基準は、後段のフォルダ名解決(matchExistingFolderName)と統一する:
      // AIが返した名前(rawName)を名寄せした後の「最終的にどの既存フォルダへ入るか」を基準に判断する。
      // こうすることで、AIが短い名前(例:「アトピー」)を返し、それが複合フォルダ名(例:「アトピー＞再診」)に
      // 名寄せされるようなケースでも、安全チェック側が見落とさないようにする。
      needsClassification.forEach((item) => {
        const rawName = groupAssignments[item.id];
        if (!rawName) return;

        const finalFolder = matchExistingFolderName(rawName, existingPaths) || rawName;
      });

      // 原因切り分け用: safety check前後でgroupAssignmentsがどう変化したか(未分類に戻された項目)を確認できるようにする
      console.log("[DEBUG bulkClassify safety check diff]", {
        beforeSafetyCheck: groupAssignmentsBeforeSafetyCheck,
        afterSafetyCheck: { ...groupAssignments },
      });
    }

    // 3. フォルダ名→フォルダIDの解決と割り当て(ローカル処理。既存フォルダを優先的に再利用し、無ければ作成)
    setFolders((prevFolders) => {
      let nextFolders = prevFolders;
      const resolveFolderId = (name, itemLang) => {
        const existingPaths = nextFolders.filter((f) => f.id !== UNCLASSIFIED_ID && f.createdLang === itemLang).map((f) => f.path);
        const matched = matchExistingFolderName(name, existingPaths);
        if (matched) {
          return nextFolders.find((x) => x.path === matched && x.createdLang === itemLang).id;
        }
        const f = { id: newId("f"), path: name, createdLang: itemLang };
        nextFolders = [...nextFolders, f];
        return f.id;
      };
      const finalAssignments = {};
      const finalYomis = { ...localYomis, ...yomiAssignments }; // ローカル継承分・API取得分をまとめる(取得できなかった項目はyomiなしのまま)
      createdList.forEach((item) => {
        if (localAssignments[item.id]) finalAssignments[item.id] = localAssignments[item.id];
        else {
          const name = groupAssignments[item.id];
          finalAssignments[item.id] = name ? [resolveFolderId(name, item.lang)] : [UNCLASSIFIED_ID];
        }
      });
      setExpressions((prevExpr) =>
        prevExpr.map((e) =>
          finalAssignments[e.id]
            ? { ...e, folderIds: finalAssignments[e.id], ...(finalYomis[e.id] ? { yomi: finalYomis[e.id] } : {}) }
            : e
        )
      );
      return nextFolders;
    });

    // 4. 中国語表現のピンインを反映(取得は上ですでに並行開始済み)
    if (cnItems.length > 0) {
      const pinyins = await pinyinPromise;
      setExpressions((prevExpr) =>
        prevExpr.map((e) => {
          const idx = cnItems.findIndex((it) => it.id === e.id);
          return idx >= 0 && pinyins[idx] ? { ...e, pinyin: pinyins[idx] } : e;
        })
      );
    }

    showToast("✅ 一括登録が完了しました");
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-xl overflow-hidden relative h-[760px] flex flex-col border border-slate-200">
        <div className="bg-teal-700 text-white px-5 py-3 flex items-center justify-between shrink-0">
          <span className="font-semibold tracking-wide text-sm">仕事のことば帳</span>
          <div className="flex bg-teal-800 rounded-full p-1 gap-1">
            {LANGUAGES.map((l) => {
              // 言語切替は「復習ハブ(5分復習/ロールプレイを選ぶ画面)」までは可能。
              // 5分復習("review")、またはロールプレイの選択後(roleplaySelect以降)に入ったら、
              // セッション開始後の言語変更を防ぐため切替不可にする。
              const langLocked =
                screen === "review" ||
                screen === "history" ||
                (ROLEPLAY_SCREENS.includes(screen) && screen !== "roleplayHub") ||
                (screen === "chat" && chatEditingActive) ||
                (screen === "mydict" && !!selectedExpr);
              return (
                <button
                  key={l.code}
                  onClick={() => !langLocked && setLang(l.code)}
                  disabled={langLocked}
                  className={`min-h-[32px] px-3 rounded-full text-xs font-bold ${
                    lang === l.code ? "bg-white text-teal-700" : "text-teal-100"
                  } ${langLocked ? "opacity-50" : ""}`}
                >
                  {l.tag}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {screen === "translate" && (
            <TranslateScreen
              expressions={expressions}
              lang={lang}
              onSave={classifyAndSave}
              checkSimilarBeforeSave={checkSimilarBeforeSave}
              checkingSimilar={checkingSimilar}
              hasSeenPredictHint={hasSeenPredictHint}
              onSeenPredictHint={() => setHasSeenPredictHint(true)}
              onTranslated={pushTranslationHistory}
              onOpenHistory={() => goto("history")}
              folders={folders}
              showToast={showToast}
            />
          )}
          {screen === "mydict" && (
            <MyDictScreen
              folders={folders}
              expressions={expressions}
              setFolders={setFolders}
              setExpressions={setExpressions}
              showToast={showToast}
              onOpenBulk={() => goto("bulk")}
              onOpenChat={() => goto("chat")}
              onOpenSettings={() => goto("settings")}
              lang={lang}
              selectedFolder={selectedFolder}
              setSelectedFolder={setSelectedFolder}
              selectedExpr={selectedExpr}
              setSelectedExpr={setSelectedExpr}
              checkSimilarBeforeSave={checkSimilarBeforeSave}
              crownedIds={crownedIds}
            />
          )}
          {screen === "bulk" && (
            <BulkAddScreen
              lang={lang}
              onCancel={() => goto("mydict")}
              onSubmit={async (rows, l) => {
                const { created, skipped } = bulkAdd(rows, l);
                goto("mydict");
                const msg =
                  created.length === 0 && skipped > 0
                    ? `既に登録済みのためスキップしました(${skipped}件)`
                    : skipped > 0
                    ? `📥 ${created.length}件を未分類に登録しました(${skipped}件は既存の${langOf(l).tag}表現と重複のためスキップ)`
                    : `📥 ${created.length}件を未分類に登録しました`;
                showToast(msg, true);
                if (created.length > 0) await bulkClassify(created);
              }}
            />
          )}
          {screen === "chat" && (
            <ChatSearchScreen
              lang={lang}
              folders={folders}
              onSave={classifyAndSave}
              onSaveToFolder={saveToFolder}
              onCreateFolderAndSave={createFolderAndSave}
              checkSimilarBeforeSave={checkSimilarBeforeSave}
              showToast={showToast}
              onBack={() => goto("mydict")}
              onEditingChange={setChatEditingActive}
            />
          )}
          {screen === "review" && (
            <ReviewScreen
              expressions={expressions.filter((e) => e.lang === lang)}
              lang={lang}
              priorityIds={weakExpressionIds}
              onFinish={() => setScreen("roleplayHub")}
              onAddTrainingTime={addTrainingTime}
              onCrownAchieved={markCrowned}
            />
          )}
          {screen === "roleplayHub" && (
            <RoleplayHubScreen
              onOpenSpacedReview={() => setScreen("review")}
              onOpenNewRoleplay={() => goto((roleplayProfile || appProfile) ? "roleplaySelect" : "roleplaySetup")}
              onOpenRoleplaySetup={() => goto("roleplaySetup")}
              roleplayProfile={roleplayProfile || appProfile}
              inProgressSession={roleplaySession && roleplayCaseData && roleplayTarget && roleplayTarget.lang === lang ? { targetExpr: roleplayTarget } : null}
              onResumeRoleplay={() => setScreen(roleplaySession && roleplaySession.analysis ? "roleplayReview" : "roleplayChat")}
            />
          )}
          {screen === "roleplaySetup" && (
            <RoleplaySetupScreen
              initialProfile={roleplayProfile || appProfile}
              onBack={() => setScreen("roleplayHub")}
              onSave={(profile) => {
                setRoleplayProfile(profile);
                setScreen("roleplaySelect");
              }}
            />
          )}
          {screen === "roleplaySelect" && (
            <RoleplaySelectScreen
              folders={folders}
              expressions={expressions}
              lang={lang}
              onBack={() => setScreen("roleplayHub")}
              onStart={startNewRoleplay}
              crownedIds={crownedIds}
            />
          )}
          {screen === "roleplayCase" && roleplayTarget && (
            <RoleplayCaseScreen
              targetExpr={roleplayTarget}
              siblingExpressions={roleplaySiblings}
              lang={lang}
              roleplayProfile={roleplayProfile || appProfile}
              onBack={() => setScreen("roleplaySelect")}
              onCaseReady={roleplayCaseReady}
            />
          )}
          {screen === "roleplayChat" && roleplayTarget && roleplayCaseData && roleplaySession && (
            <RoleplayChatScreen
              targetExpr={roleplayTarget}
              caseData={roleplayCaseData}
              lang={roleplayTarget.lang}
              session={roleplaySession}
              setSession={setRoleplaySession}
              onAbandon={() => setScreen("roleplayHub")}
              onEnd={endRoleplaySession}
              onAddTrainingTime={addTrainingTime}
            />
          )}
          {screen === "roleplayReview" && roleplayTarget && roleplaySession && (
            <RoleplayReviewScreen
              targetExpr={roleplayTarget}
              caseData={roleplayCaseData}
              transcript={roleplaySession.transcript}
              lang={roleplayTarget.lang}
              expressions={expressions}
              onSave={classifyAndSave}
              checkSimilarBeforeSave={checkSimilarBeforeSave}
              onMarkResult={markRoleplayResult}
              showToast={showToast}
              onFinish={finishRoleplay}
              cachedAnalysis={roleplaySession.analysis}
              onAnalysisReady={(res) => setRoleplaySession((prev) => (prev ? { ...prev, analysis: res } : prev))}
            />
          )}
          {screen === "history" && (
            <TranslationHistoryScreen
              history={translationHistory}
              expressions={expressions}
              onSave={classifyAndSave}
              checkSimilarBeforeSave={checkSimilarBeforeSave}
              checkingSimilar={checkingSimilar}
              onBack={() => goto("translate")}
              folders={folders}
              showToast={showToast}
            />
          )}
          {screen === "settings" && (
            <SettingsScreen
              settings={settings}
              setSettings={setSettings}
              appProfile={appProfile}
              setAppProfile={setAppProfile}
              totalTrainingMs={totalTrainingMs}
              crownedCount={crownedIds.size}
              onBack={() => goto("mydict")}
            />
          )}
        </div>

        {toast && (
          <div className={`absolute left-4 right-4 bottom-20 rounded-xl px-4 py-3 text-sm shadow-lg text-center z-20 ${toast.muted ? "bg-slate-600 text-white" : "bg-emerald-600 text-white"}`}>
            {toast.text}
          </div>
        )}

        <div className="grid grid-cols-3 border-t border-slate-200 bg-white shrink-0">
          <TabButton active={screen === "translate"} label="翻訳" onClick={() => goto("translate")} />
          <TabButton
            active={screen === "mydict"}
            label="辞書"
            onClick={() => {
              setSelectedFolder(null);
              setSelectedExpr(null);
              goto("mydict");
            }}
          />
          <TabButton
            active={screen === "review" || ROLEPLAY_SCREENS.includes(screen)}
            label="復習"
            onClick={() => goto("roleplayHub")}
          />
        </div>

        {/* 保存経路共通の「似た表現があります」確認シート */}
        {similarCheck && (
          <div className="fixed inset-0 z-[60] bg-black/40 flex items-end">
            <div className="w-full max-w-sm mx-auto bg-white rounded-t-2xl p-5 space-y-3">
              <p className="font-semibold text-slate-800 text-sm">似た表現がすでに保存されています</p>
              <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                <p className="text-sm text-slate-800">{similarCheck.match.en}</p>
                {similarCheck.match.lang === "cn" && similarCheck.match.pinyin && <p className="text-xs text-teal-600">{similarCheck.match.pinyin}</p>}
                <p className="text-xs text-slate-500">{similarCheck.match.ja}</p>
              </div>
              <button
                onClick={async () => {
                  const { match, onUseExisting } = similarCheck;
                  setSimilarCheck(null);
                  if (onUseExisting) await onUseExisting(match);
                }}
                className="w-full min-h-[48px] border-2 border-teal-700 text-teal-700 rounded-xl text-sm font-semibold bg-white"
              >
                既存の表現を使う
              </button>
              <button
                onClick={async () => {
                  const { onProceed } = similarCheck;
                  setSimilarCheck(null);
                  await onProceed();
                }}
                className="w-full min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-semibold"
              >
                この表現も保存する
              </button>
              <button onClick={() => setSimilarCheck(null)} className="w-full min-h-[40px] text-xs text-slate-400">閉じる</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, label, onClick }) {
  return (
    <button onClick={onClick} className={`py-4 min-h-[52px] text-sm font-medium ${active ? "text-teal-700 border-t-2 border-teal-700" : "text-slate-400"}`}>
      {label}
    </button>
  );
}

// 患者さんへの提示画面。翻訳画面・翻訳履歴画面の両方から同じ見た目・挙動で呼び出すための共有コンポーネント
// (表示ロジックを画面ごとに重複させない)。
function PatientDisplay({ text, onSpeak, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col text-center">
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-3xl font-bold text-slate-900 leading-snug">{text}</p>
      </div>
      <div className="p-4 pb-6 space-y-2 border-t border-slate-100">
        <button onClick={onSpeak} className="w-full min-h-[48px] border border-slate-300 rounded-xl text-sm text-slate-600 bg-white">🔊 音声を再生</button>
        <button onClick={onClose} className="w-full min-h-[60px] bg-teal-700 text-white rounded-xl text-lg font-bold">
          閉じる
        </button>
      </div>
    </div>
  );
}

function TranslateScreen({ expressions, lang, onSave, checkSimilarBeforeSave, checkingSimilar, hasSeenPredictHint, onSeenPredictHint, onTranslated, onOpenHistory, folders, showToast }) {
  const [ja, setJa] = useState("");
  const [translatedJa, setTranslatedJa] = useState(""); // 直近の翻訳が成功した時点のja(これと現在のjaが一致する間だけ保存可能にする)
  const [result, setResult] = useState("");
  const [pinyin, setPinyin] = useState("");
  const [yomi, setYomi] = useState(""); // 保存時のインデックス分類用。既存の翻訳APIレスポンスに相乗りして取得する(専用のAPI呼び出しは増やさない)
  const [caution, setCaution] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [patientMode, setPatientMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const recogRef = useRef(null);

  // 自分専用の予測入力: 保存済み表現(このアプリの「学習・蓄積」の核)から、入力中の文字に対応する候補を出す。
  // 一般的なAI予測変換ではなく、優先順位を「入力そのものの前方一致 → 数字/漢数字を同一視した前方一致 →
  // ひらがな数字読みを同一視した前方一致 → 部分一致」の順にし、最大4件までに絞る(候補を増やしすぎない)。
  const trimmedJa = ja.trim();
  const canonNumerals = (s) => s.replace(/[〇一二三四五六七八九十]/g, (ch) => KANJI_TO_ARABIC[ch]);
  const canonQuery = canonNumerals(trimmedJa);
  const hiraganaDigit = HIRAGANA_TO_NUM[trimmedJa]; // 入力が数字の読みそのものと完全一致する場合だけ変換する
  let suggestions = [];
  if (trimmedJa.length >= 1) {
    const pool = expressions.filter((e) => e.lang === lang && e.ja !== trimmedJa);
    const used = new Set();
    const pick = (list) => {
      for (const e of list) {
        if (suggestions.length >= 4) break;
        if (used.has(e.id)) continue;
        used.add(e.id);
        suggestions.push(e);
      }
    };
    pick(pool.filter((e) => e.ja.startsWith(trimmedJa))); // 1. 入力そのものの前方一致
    if (suggestions.length < 4) pick(pool.filter((e) => canonNumerals(e.ja).startsWith(canonQuery))); // 2. 数字↔漢数字
    if (hiraganaDigit && suggestions.length < 4) {
      pick(pool.filter((e) => canonNumerals(e.ja).startsWith(hiraganaDigit))); // 3. ひらがな数字読み
    }
    if (suggestions.length < 4) pick(pool.filter((e) => canonNumerals(e.ja).includes(canonQuery))); // 4. 部分一致
  }

  // 予測入力の存在に気づいてもらうため、この画面を最初に開いたときだけヒントを表示する(入力欄のすぐ下、控えめに)
  useEffect(() => {
    if (!hasSeenPredictHint) {
      setHintVisible(true);
      onSeenPredictHint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translate = async () => {
    if (!ja.trim()) return;
    // 翻訳ボタンを押した時点で、まず今表示されている翻訳結果をクリアする(結果の有無に関わらず)
    setResult("");
    setPinyin("");
    setYomi("");
    setSaved(false);
    setCaution(false);
    // 日本語をまったく含まない入力(例: "hello"や"nihao"のようなローマ字だけの入力)は、
    // 日本語→外国語の翻訳画面としての用途から外れるため、APIを呼ばず案内だけ表示する。
    // 「KOHについて」のような日本語+英数字/専門用語は containsJapanese が true になるため通過する。
    if (!containsJapanese(ja.trim())) {
      setError("日本語の文章を入力してください");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const out = await callClaude(
        `次の日本語を自然な${langOf(lang).label}に翻訳してください。\n` +
          `${POV_INSTRUCTION}\n` +
          `原文に無い具体的な文脈(仕事・学校・特定の相手など)を勝手に補わないでください。原文が持つ意味の範囲を超えないようにしてください。\n` +
          `特に文脈が明示されていない場合は、原文の意味をそのまま保った、汎用的で自然な表現にしてください。\n` +
          `数量・回数・日付・期間などの具体的な数字表現は、原文と正確に一致させてください(例:「来週」と「再来週」、「1日2回」と「1日3回」のような、隣接する数字・期間を取り違えないよう特に注意してください)。\n` +
          `訳文には、注意書き・断り書き・補足説明などを一切含めず、翻訳結果の文章だけを入れてください。\n` +
          `次のJSON形式のみを出力してください(説明やコードブロック記号は不要です)。\n` +
          `{"translation":"訳文のみ(前置き・注意書きなし)","yomi":"日本語原文(「${ja}」)の読みをひらがなのみで(漢字・カタカナ・句読点・記号は含めない)","caution":true または false(相手を傷つける可能性のある攻撃的・侮辱的な内容が原文に含まれる場合はtrue、それ以外はfalse)}\n\n` +
          `日本語: ${ja}`
      );
      const cleaned = out.replace(/```json|```/g, "").trim();
      let translated = "";
      let cautionFlag = false;
      let yomiResult = "";
      try {
        const parsed = JSON.parse(cleaned);
        translated = (parsed.translation || "").replace(/^["「]|["」]$/g, "").trim();
        cautionFlag = !!parsed.caution;
        // yomiはひらがな以外の文字が混ざっていた場合、インデックス分類を誤らせないよう使わない(空文字のままフォールバックさせる)
        const yomiRaw = (parsed.yomi || "").trim();
        yomiResult = /^[\u3041-\u3096ー]+$/.test(yomiRaw) ? yomiRaw : "";
      } catch (parseErr) {
        // JSONで返ってこなかった場合は、そのままの文字列を訳文として使う(注意フラグは立てない)
        translated = cleaned.replace(/^["「]|["」]$/g, "").trim();
      }
      setResult(translated);
      setCaution(cautionFlag);
      setYomi(yomiResult);
      let pinyinResult = "";
      if (lang === "cn") {
        pinyinResult = await fetchPinyin(translated);
        setPinyin(pinyinResult);
      }
      // 翻訳が成功したら、保存する/しないに関わらず必ず履歴に残す(履歴自体は辞書への保存ではない)
      if (translated) {
        setTranslatedJa(ja);
        onTranslated?.({ ja, en: translated, lang, pinyin: pinyinResult });
      }
    } catch (e) {
      setError("翻訳に失敗しました。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      translate();
    }
  };

  const pickSuggestion = (s) => {
    setJa(s.ja);
    setTranslatedJa(s.ja);
    setResult(s.en);
    setPinyin(s.pinyin || "");
    setYomi(s.yomi || "");
    setSaved(false);
    setError("");
    setCaution(false);
  };

  // 今回の翻訳結果だけを閉じて次の翻訳に進む(保存済み表現や履歴自体は消さない)
  const closeResult = () => {
    setResult("");
    setPinyin("");
    setYomi("");
    setSaved(false);
    setError("");
    setJa("");
    setTranslatedJa("");
    setCaution(false);
  };

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(lang).speech;
    window.speechSynthesis.speak(u);
  };

  // 保存ボタンを押した瞬間だけ、共通の類似表現チェックを経由する(入力中の高速検索とは別枠)
  const trySave = async () => {
    await checkSimilarBeforeSave(
      ja,
      result,
      lang,
      pinyin,
      async () => {
        setSaved(true);
        await onSave(ja, result, lang, pinyin, yomi);
      },
      async (match) => {
        setJa(match.ja);
        setResult(match.en);
        setPinyin(match.pinyin || "");
        setSaved(true);
        showToast?.(`📌 既存の表現（${describeFolderIds(match.folderIds, folders)}）を使用します`, true);
      }
    );
  };

  const toggleMic = () => {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const r = getRecognition("ja-JP");
    if (!r) {
      setError("この環境では音声入力に対応していません。テキスト入力をご利用ください。");
      return;
    }
    r.onresult = (ev) => setJa((prev) => (prev ? prev + ev.results[0][0].transcript : ev.results[0][0].transcript));
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("音声入力を開始できませんでした(プレビュー環境の制限の可能性)。テキスト入力をご利用ください。");
    };
    try {
      recogRef.current = r;
      setListening(true);
      r.start();
    } catch (e) {
      setListening(false);
      setError("音声入力を開始できませんでした(プレビュー環境の制限の可能性)。テキスト入力をご利用ください。");
    }
  };

  return (
    <div className="p-4 space-y-4 pb-6">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-slate-500 block">日本語(確定/Enterで翻訳)</label>
          <button onClick={onOpenHistory} className="text-xs text-teal-700 min-h-[32px] px-2">🕘 履歴</button>
        </div>
        <textarea value={ja} onChange={(e) => setJa(e.target.value)} onKeyDown={onKeyDown} rows={4} placeholder="ここに入力、または🎤で話しかけてください" className="w-full border border-slate-300 rounded-xl p-3 text-base leading-relaxed focus:outline-none focus:ring-2 focus:ring-teal-500" />

        {hintVisible && (
          <p className="text-[10px] text-teal-600 mt-1">💡 保存した表現は、最初の文字を入力すると候補に表示されます</p>
        )}

        {suggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s.id} onClick={() => pickSuggestion(s)} className="text-left bg-slate-50 border border-slate-200 rounded-full px-3 py-1.5 text-xs text-slate-600">
                {s.ja}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      </div>

      <div className="flex gap-2">
        <button onClick={toggleMic} className={`flex-1 min-h-[52px] rounded-xl text-sm font-medium border-2 ${listening ? "bg-red-50 border-red-300 text-red-600" : "bg-white border-slate-300 text-slate-700"}`}>
          {listening ? "🎤 聞き取り中…" : "🎤 音声で話す"}
        </button>
        <button onClick={translate} disabled={loading} className="flex-1 min-h-[52px] bg-teal-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
          {loading ? "翻訳中…" : "翻訳する"}
        </button>
      </div>

      {result && caution && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ⚠️ この表現には相手を傷つける可能性のある言葉が含まれています
        </p>
      )}

      {result && (
        <div className="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-slate-500">翻訳結果({langOf(lang).tag})</p>
              <button
                onClick={closeResult}
                aria-label="結果を閉じて次へ"
                className="text-slate-400 text-sm leading-none min-w-[28px] min-h-[28px] -mt-1 -mr-1 rounded-full active:bg-slate-200"
              >
                ✕
              </button>
            </div>
            <p className="text-base text-slate-800">{result}</p>
            {lang === "cn" && pinyin && <p className="text-sm text-teal-700">{pinyin}</p>}
          </div>

          {/* 診療中に一番押すボタン: 他より大きく・単色で目立たせる */}
          <button onClick={() => setPatientMode(true)} className="w-full min-h-[60px] bg-teal-700 text-white rounded-xl text-base font-bold shadow-sm">
            😊 見せる
          </button>

          <div className="flex gap-2">
            <button onClick={() => speak(result)} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-sm bg-white text-slate-600">🔊 再生</button>
            <button onClick={trySave} disabled={checkingSimilar || !containsJapanese(ja.trim()) || ja !== translatedJa} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-sm bg-white text-slate-600 disabled:opacity-50">
              {checkingSimilar ? "確認中…" : saved ? "✅ 保存済み" : "⭐ 保存"}
            </button>
          </div>
        </div>
      )}

      {patientMode && <PatientDisplay text={result} onSpeak={() => speak(result)} onClose={() => setPatientMode(false)} />}
    </div>
  );
}

function MyDictScreen({ folders, expressions, setFolders, setExpressions, showToast, onOpenBulk, onOpenChat, onOpenSettings, lang, selectedFolder, setSelectedFolder, selectedExpr, setSelectedExpr, checkSimilarBeforeSave, crownedIds }) {
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderAddOpen, setFolderAddOpen] = useState(false);
  const [addJa, setAddJa] = useState("");
  const [addEn, setAddEn] = useState("");
  const [addPinyin, setAddPinyin] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState(null);
  const [practiceTarget, setPracticeTarget] = useState(null); // 発音練習ボトムシートの対象(表現オブジェクト。編集画面には遷移しない)
  const itemRefs = useRef({}); // 簡易インデックスのジャンプ用(表現id→DOM要素)。並び替え自体はAPI不要のローカル処理
  const countIn = (folderId) => expressions.filter((e) => e.folderIds.includes(folderId) && e.lang === lang).length;

  // 日本語(e.ja)を基準に並べ替える。優先順位は 1.かな/漢字(あいうえお順) 2.数字始まり(数字順) 3.その他(最後)。
  // 読み(e.yomi、ひらがな)が保存されている場合はそれを優先して使うことで、漢字始まりの項目も正しい五十音位置に分類できる。
  // yomiが無い既存データは従来通りe.jaで判定するため、正確な五十音順ではなく辞書的な並び(Intl.Collatorの近似)になる。
  const dictCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const KATAKANA_START = 0x30a1, KATAKANA_END = 0x30f6;
  const toHiraganaChar = (ch) => {
    const code = ch.charCodeAt(0);
    return code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCharCode(code - 0x60) : ch;
  };
  const GOJUON_ROWS = ["あいうえおがぎぐげご", "かきくけこ", "さしすせそざじずぜぞ", "たちつてとだぢづでど", "なにぬねの", "はひふへほばびぶべぼぱぴぷぺぽ", "まみむめも", "やゆよ", "らりるれろ", "わをん"];
  const gojuonHeadOf = (ch) => {
    const hira = toHiraganaChar(ch);
    const row = GOJUON_ROWS.find((r) => r.includes(hira));
    return row ? row[0] : null;
  };
  const sortKeyOf = (e) => (e.yomi || e.ja || "").trim();
  // かな/漢字始まり=0、数字始まり=1、それ以外(アルファベット・記号など)=2、の順で優先度をつける
  const bucketOf = (text) => {
    const ch = text.charAt(0);
    if (!ch) return 2;
    if (/[0-9０-９]/.test(ch)) return 1;
    if (gojuonHeadOf(ch) || /[\u4E00-\u9FFF]/.test(ch)) return 0;
    return 2;
  };
  const sortExpressions = (arr) =>
    [...arr].sort((a, b) => {
      const ka = sortKeyOf(a), kb = sortKeyOf(b);
      const ba = bucketOf(ka), bb = bucketOf(kb);
      return ba !== bb ? ba - bb : dictCollator.compare(ka, kb);
    });
  // ソート済みリストの中で「そのインデックス見出しで最初に現れる項目」だけを見出しにする。
  // かな始まり(yomiのある漢字始まりも読みのかなとしてここに該当)は行頭のかな(あ/か/さ…)、数字始まりは実際の数字、
  // yomiが無い漢字始まりは読みが分からないためその漢字自体ではなく「他」にまとめる(近似)。
  const indexLabelOf = (text) => {
    const ch = text.charAt(0);
    if (!ch) return "?";
    if (/[0-9０-９]/.test(ch)) return ch.replace(/[０-９]/, (d) => "０１２３４５６７８９".indexOf(d).toString()); // 数字は"#"にまとめず、実際の数字をそのままラベルにする
    const gojuon = gojuonHeadOf(ch);
    if (gojuon) return gojuon;
    if (/[\u4E00-\u9FFF]/.test(ch)) return "他"; // 読みが分からない漢字始まりは、1文字ごとに出さずまとめて「他」に集約する
    return "他";
  };
  const buildIndexGroups = (sortedArr) => {
    const groups = [];
    const seen = new Set();
    sortedArr.forEach((e) => {
      const label = indexLabelOf(sortKeyOf(e));
      if (!seen.has(label)) {
        seen.add(label);
        groups.push({ label, id: e.id });
      }
    });
    return groups;
  };
  const jumpTo = (id) => {
    itemRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Googleフォトのような「スクロール中だけフローティング表示」用のローカルUI状態(グローバルstateではない)。
  // 表示のON/OFFと自動非表示タイマー、ドラッグ中の現在位置表示のみで、分類・並び替えロジックには一切関与しない。
  const [showIndexRail, setShowIndexRail] = useState(false);
  const [railScrollRatio, setRailScrollRatio] = useState(0); // リストのスクロール位置(0〜1)。インデックスの表示位置をこれに連動させる
  const indexHideTimer = useRef(null);
  const onListScroll = (ev) => {
    setShowIndexRail(true);
    const el = ev.currentTarget;
    const maxScroll = el.scrollHeight - el.clientHeight;
    setRailScrollRatio(maxScroll > 0 ? Math.min(1, Math.max(0, el.scrollTop / maxScroll)) : 0);
    if (indexHideTimer.current) clearTimeout(indexHideTimer.current);
    indexHideTimer.current = setTimeout(() => setShowIndexRail(false), 2200);
  };
  // インデックスを指でなぞった(ドラッグした)場合も、指の位置に一番近い見出しへジャンプする。
  // activeLabelは「今どの見出しをなぞっているか」をドラッグ中だけ大きく表示するための現在地表示用。
  const indexRailRef = useRef(null);
  const [activeLabel, setActiveLabel] = useState(null);
  const jumpByPointerY = (clientY, groups) => {
    const rail = indexRailRef.current;
    if (!rail || groups.length === 0) return;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const idx = Math.min(groups.length - 1, Math.floor(ratio * groups.length));
    setActiveLabel(groups[idx].label);
    jumpTo(groups[idx].id);
  };

  const requestDeleteFolder = (folder) => {
    setDeleteFolderTarget({ id: folder.id, path: folder.path, count: countIn(folder.id) });
  };

  // 文の選択・一括操作用。選択状態は「今表示しているフォルダ・言語」に紐づく一時的なUI状態なので、
  // フォルダや言語を切り替えたら必ずリセットする(別の一覧に古い選択が残らないようにする)。
  // 通常フォルダ・未分類の両方で共通の仕組みとして使う(以前は未分類だけの機能だった)。
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [bulkMovePickerOpen, setBulkMovePickerOpen] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  useEffect(() => {
    setBulkSelectMode(false);
    setBulkSelected(new Set());
    setBulkMovePickerOpen(false);
    setBulkDeleteConfirmOpen(false);
  }, [selectedFolder, lang]);

  const toggleBulkSelected = (id) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 未分類(現在の言語のみ)に入っている選択済み表現だけを、選んだフォルダへ移動する。
  // 対象は expression の id で絞り込むため、conceptId経由で別言語の兄弟表現に影響することはない。
  // deleteFolderの mode="move" と同じ考え方(未分類IDを外し、空にならないよう移動先フォルダIDを入れる)を踏襲。
  const bulkMoveToFolder = (targetFolderId) => {
    const ids = bulkSelected;
    if (ids.size === 0 || !targetFolderId) return;
    setExpressions((prev) =>
      prev.map((e) => {
        if (e.lang !== lang || !ids.has(e.id)) return e;
        // UNCLASSIFIED_IDと移動先だけでなく、今表示している「移動元」フォルダ自体も外す必要がある。
        // これが抜けていたため、移動元に残ったまま移動先にも追加される(=削除されず二重所属になる)バグがあった。
        const kept = e.folderIds.filter((fid) => fid !== UNCLASSIFIED_ID && fid !== targetFolderId && fid !== selectedFolder);
        return { ...e, folderIds: [...kept, targetFolderId] };
      })
    );
    const folder = folders.find((f) => f.id === targetFolderId);
    showToast(`✅ ${ids.size}件を ${folder?.path || ""} に移動しました`, false);
    setBulkSelected(new Set());
    setBulkMovePickerOpen(false);
  };

  const bulkMoveToNewFolder = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    let folder = folders.find((f) => f.path === trimmed && f.createdLang === lang);
    if (!folder) {
      folder = { id: newId("f"), path: trimmed, userCreated: true, createdLang: lang };
      setFolders((prev) => [...prev, folder]);
    }
    bulkMoveToFolder(folder.id);
  };

  // 選択した表現を「このフォルダ」からだけ外す。deleteFolderのmode="delete"(フォルダ全体を対象にする版)と
  // 同じ考え方を、選択したidの集合に適用したもの。他のフォルダにも所属していればそちらに残り、
  // このフォルダが唯一の所属先だった場合は表現自体が完全に削除される。
  // 対象は表示中の言語かつ選択されたidだけ(conceptId経由で他言語版を巻き込むことはしない)。
  const bulkRemoveFromFolder = () => {
    const ids = bulkSelected;
    if (ids.size === 0 || !selectedFolder) return;
    setExpressions((prev) => {
      const kept = prev.filter((e) => !(e.lang === lang && ids.has(e.id) && e.folderIds.includes(selectedFolder) && e.folderIds.length === 1));
      return kept.map((e) =>
        e.lang === lang && ids.has(e.id) && e.folderIds.includes(selectedFolder)
          ? { ...e, folderIds: e.folderIds.filter((id) => id !== selectedFolder) }
          : e
      );
    });
    showToast(`🗑 ${ids.size}件をこのフォルダから削除しました`, true);
    setBulkSelected(new Set());
    setBulkSelectMode(false);
    setBulkDeleteConfirmOpen(false);
  };

  // 選択した表現を、所属フォルダに関わらず完全に削除する。deleteExpression(1件版)と同じ考え方を複数件に適用したもの。
  // 対象は表示中の言語かつ選択されたidだけ(他言語版には影響しない)。
  const bulkDeleteCompletely = () => {
    const ids = bulkSelected;
    if (ids.size === 0) return;
    setExpressions((prev) => prev.filter((e) => !(e.lang === lang && ids.has(e.id))));
    showToast(`🗑 ${ids.size}件を完全に削除しました`, true);
    setBulkSelected(new Set());
    setBulkSelectMode(false);
    setBulkDeleteConfirmOpen(false);
  };

  // フォルダを削除する。今の表示言語(lang)の表現だけを対象にし、他言語の表現・フォルダ所属には触れない
  // (英語版を消しても中国語版は残す)。
  // mode="move": 対象言語の表現は残して未分類へ移動。mode="delete": このフォルダにしか所属していない
  // 対象言語の表現は完全に削除し、他のフォルダにも所属している表現はこのフォルダからだけ外す
  // (多対多で共有されている表現を、フォルダ削除だけで意図せず消さないため)。
  // フォルダ自体は、他言語の表現がまだ参照していれば残し、どの言語からも参照されなくなった時だけ削除する。
  // 未分類は「削除されたフォルダから表現を退避させるシステム上の受け皿」として、常に存在・常に表示する
  const deleteFolder = (folderId, mode) => {
    if (folderId === UNCLASSIFIED_ID) return; // 未分類自体は誤操作でも削除しない
    setExpressions((prevExpressions) => {
      let nextExpressions;
      if (mode === "delete") {
        const kept = prevExpressions.filter((e) => !(e.lang === lang && e.folderIds.includes(folderId) && e.folderIds.length === 1));
        nextExpressions = kept.map((e) =>
          e.lang === lang && e.folderIds.includes(folderId) ? { ...e, folderIds: e.folderIds.filter((id) => id !== folderId) } : e
        );
      } else {
        nextExpressions = prevExpressions.map((e) => {
          if (e.lang !== lang || !e.folderIds.includes(folderId)) return e;
          const ids = e.folderIds.filter((id) => id !== folderId);
          return { ...e, folderIds: ids.length ? ids : [UNCLASSIFIED_ID] };
        });
      }
      const stillReferenced = nextExpressions.some((e) => e.folderIds.includes(folderId));
      setFolders((prevFolders) => (stillReferenced ? prevFolders : prevFolders.filter((f) => f.id !== folderId)));
      return nextExpressions;
    });
    setSelectedFolder(null);
    setDeleteFolderTarget(null);
    showToast(
      mode === "delete" ? `🗑 ${langOf(lang).tag}版のフォルダを削除しました` : `🗑 ${langOf(lang).tag}版を未分類へ移動しました`,
      true
    );
  };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (!folders.some((f) => f.path === name && f.createdLang === lang)) {
      setFolders((prev) => [...prev, { id: newId("f"), path: name, userCreated: true, createdLang: lang }]);
    } else {
      // 同じ言語に既存の同名フォルダがあれば、それを「ユーザーが明示的に作った」フォルダ扱いに格上げする(0件でも表示されるように)
      setFolders((prev) => prev.map((f) => (f.path === name && f.createdLang === lang ? { ...f, userCreated: true } : f)));
    }
    setNewFolderName("");
    setNewFolderOpen(false);
  };

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(lang).speech;
    window.speechSynthesis.speak(u);
  };

  const translateForAdd = async () => {
    if (!addJa.trim() || !containsJapanese(addJa.trim())) return;
    setAddLoading(true);
    try {
      const out = await callClaude(
        `次の日本語を自然な${langOf(lang).label}に翻訳してください。${POV_INSTRUCTION}原文に無い具体的な文脈(仕事・学校・特定の相手など)を勝手に補わず、原文の意味の範囲を超えないようにしてください。訳文のみを1行で出力してください。\n\n日本語: ${addJa.trim()}`
      );
      const t = out.replace(/^["「]|["」]$/g, "").trim();
      setAddEn(t);
      setAddPinyin(lang === "cn" ? await fetchPinyin(t) : "");
    } finally {
      setAddLoading(false);
    }
  };

  const saveToThisFolder = async (folderId, folderPath) => {
    if (!addJa.trim() || !addEn.trim() || !containsJapanese(addJa.trim())) return;
    const ja = addJa.trim();
    const en = addEn.trim();
    const conceptId = resolveConceptId(expressions, ja);
    const dup = findDuplicateExpression(expressions, conceptId, lang);
    const resetFields = () => {
      setAddJa("");
      setAddEn("");
      setAddPinyin("");
      setFolderAddOpen(false);
    };
    setAddSaving(true);
    if (dup) {
      // 同じconceptId×言語の完全一致は、これまで通り即座にフォルダへ追加するだけ(類似チェックの対象外)
      if (!dup.folderIds.includes(folderId)) {
        const newIds = folderId === UNCLASSIFIED_ID ? dup.folderIds : [...dup.folderIds.filter((id) => id !== UNCLASSIFIED_ID), folderId];
        setExpressions((prev) => prev.map((e) => (e.id === dup.id ? { ...e, folderIds: newIds } : e)));
      }
      showToast(`📌 既存の${langOf(lang).tag}表現を ${folderPath} に追加しました`, false);
      resetFields();
    } else {
      // 完全一致でなければ、共通の類似表現チェックを経由してから新規作成する
      await checkSimilarBeforeSave(
        ja,
        en,
        lang,
        addPinyin,
        async () => {
          setExpressions((prev) => [
            { id: newId("e"), conceptId, ja, en, ...(addPinyin ? { pinyin: addPinyin } : {}), lang, folderIds: [folderId] },
            ...prev,
          ]);
          showToast(`✅ ${folderPath} に保存`, false);
          resetFields();
        },
        async (match) => {
          if (!match.folderIds.includes(folderId)) {
            const newIds = folderId === UNCLASSIFIED_ID ? match.folderIds : [...match.folderIds.filter((id) => id !== UNCLASSIFIED_ID), folderId];
            setExpressions((prev) => prev.map((e) => (e.conceptId === match.conceptId ? { ...e, folderIds: newIds } : e)));
          }
          showToast(`📌 既存の${langOf(lang).tag}表現を ${folderPath} に追加しました`, false);
          resetFields();
        }
      );
    }
    setAddSaving(false);
  };

  // フォルダ削除の確認モーダル。「フォルダを開いた画面」「フォルダ一覧画面」のどちらから削除を押しても
  // その場で表示されるよう、両方の描画箇所で共通のこの変数を使う(画面を戻らないと出ない、という不具合を防ぐ)
  const deleteFolderModal = deleteFolderTarget && (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end">
      <div className="w-full max-w-sm mx-auto bg-white rounded-t-2xl p-5 space-y-3">
        <p className="font-semibold text-slate-800">「{deleteFolderTarget.path}」({langOf(lang).tag}版)を削除しますか?</p>
        {deleteFolderTarget.count > 0 ? (
          <>
            <p className="text-sm text-slate-600">
              このフォルダには{langOf(lang).tag}の表現が{deleteFolderTarget.count}件あります(他言語版には影響しません)。
            </p>
            <button onClick={() => deleteFolder(deleteFolderTarget.id, "move")} className="w-full min-h-[48px] border-2 border-teal-700 text-teal-700 rounded-xl text-sm font-semibold bg-white">
              表現は残して未分類へ移動する
            </button>
            <button onClick={() => deleteFolder(deleteFolderTarget.id, "delete")} className="w-full min-h-[48px] bg-red-600 text-white rounded-xl text-sm font-semibold">
              表現も削除する
            </button>
          </>
        ) : (
          <button onClick={() => deleteFolder(deleteFolderTarget.id, "move")} className="w-full min-h-[48px] bg-red-600 text-white rounded-xl text-sm font-semibold">
            削除する
          </button>
        )}
        <button onClick={() => setDeleteFolderTarget(null)} className="w-full min-h-[40px] text-xs text-slate-400">キャンセル</button>
      </div>
    </div>
  );

  if (selectedExpr) {
    const expr = expressions.find((e) => e.id === selectedExpr);
    if (!expr) {
      setSelectedExpr(null);
      return null;
    }
    return (
      <ExpressionDetail
        key={expr.id}
        expr={expr}
        expressions={expressions}
        folders={folders}
        setFolders={setFolders}
        setExpressions={setExpressions}
        setSelectedExpr={setSelectedExpr}
        currentFolderId={selectedFolder}
        onBack={() => setSelectedExpr(null)}
        onRemovedFromFolder={() => setSelectedExpr(null)}
        onDeleted={() => {
          setSelectedExpr(null);
          setSelectedFolder(null);
        }}
        showToast={showToast}
      />
    );
  }

  if (selectedFolder) {
    const folder = folders.find((f) => f.id === selectedFolder);
    const rawList = expressions.filter((e) => e.folderIds.includes(selectedFolder) && e.lang === lang);
    const list = sortExpressions(rawList);
    const indexGroups = list.length >= 12 ? buildIndexGroups(list) : []; // 件数が少ない場合はインデックス自体を出さない

    return (
      <div className="p-4">
        <div className="flex items-start justify-between mb-1">
          <button onClick={() => setSelectedFolder(null)} className="text-teal-700 text-sm min-h-[44px]">← フォルダ一覧に戻る</button>
        </div>
        <p className="font-semibold text-slate-800 mb-1">📁 {folder?.path}</p>
        <p className="text-[11px] text-slate-400 mb-3">{langOf(lang).tag}の表現のみ表示中</p>

        {/* フォルダ内追加は今回一旦UIから隠す(機能・関連state・コードは削除せず維持。再検討時にコメントを外せば復活可能)
        <button
          onClick={() => setFolderAddOpen((v) => !v)}
          className="w-full min-h-[48px] mb-3 border-2 border-teal-700 text-teal-700 rounded-xl text-sm font-semibold bg-white"
        >
          {folderAddOpen ? "− 閉じる" : "＋ このフォルダに追加"}
        </button>
        */}

        {folderAddOpen && (
          <div className="border border-teal-200 bg-teal-50 rounded-xl p-3 mb-3 space-y-2">
            <label className="text-[11px] text-slate-500">日本語</label>
            <textarea value={addJa} onChange={(e) => setAddJa(e.target.value)} rows={3} className="w-full border border-slate-300 rounded-lg p-3 text-base leading-relaxed" />
            {addJa.trim() && !containsJapanese(addJa.trim()) && <p className="text-xs text-red-600">日本語を入力してください</p>}
            <button onClick={translateForAdd} disabled={!addJa.trim() || !containsJapanese(addJa.trim()) || addLoading} className="w-full min-h-[44px] border border-teal-600 text-teal-700 rounded-lg text-sm font-semibold bg-white disabled:opacity-50">
              {addLoading ? "翻訳中…" : `${langOf(lang).tag}に翻訳する`}
            </button>
            {addEn && (
              <>
                <label className="text-[11px] text-slate-500">訳文({langOf(lang).tag}・編集可)</label>
                <textarea value={addEn} onChange={(e) => setAddEn(e.target.value)} rows={3} className="w-full border border-slate-300 rounded-lg p-3 text-base leading-relaxed" />
                {lang === "cn" && addPinyin && <p className="text-sm text-teal-600">{addPinyin}</p>}
                <button
                  onClick={() => saveToThisFolder(selectedFolder, folder?.path)}
                  disabled={addSaving || !containsJapanese(addJa.trim())}
                  className="w-full min-h-[48px] bg-teal-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  {addSaving ? "保存中…" : `📁 ${folder?.path} に保存`}
                </button>
              </>
            )}
          </div>
        )}

        {/* 文の選択・移動・削除まわりの操作エリア。通常フォルダ・未分類で共通の仕組み。
            状態は3段階: ①非選択モード ②選択モード・0件選択 ③選択モード・1件以上選択 */}
        {!bulkSelectMode && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setBulkSelectMode(true)}
              className="flex-1 min-h-[48px] border-2 border-teal-700 text-teal-700 rounded-xl text-sm font-semibold bg-white"
            >
              ☑ 文を選択
            </button>
            {selectedFolder !== UNCLASSIFIED_ID && (
              <button
                onClick={() => requestDeleteFolder(folder)}
                className="flex-1 min-h-[48px] border-2 border-red-300 text-red-600 rounded-xl text-sm font-semibold bg-white"
              >
                🗑 フォルダを削除
              </button>
            )}
          </div>
        )}

        {bulkSelectMode && bulkSelected.size === 0 && (
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setBulkSelected(list.length > 0 ? new Set(list.map((e) => e.id)) : new Set())}
              className="text-xs text-teal-700 min-h-[36px] px-1"
            >
              ☐ すべて選択
            </button>
            <button
              onClick={() => setBulkSelectMode(false)}
              className="min-h-[36px] px-3 text-xs text-slate-500 border border-slate-300 rounded-lg"
            >
              選択をやめる
            </button>
          </div>
        )}

        {bulkSelectMode && bulkSelected.size > 0 && (
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setBulkSelected(bulkSelected.size === list.length ? new Set() : new Set(list.map((e) => e.id)))}
              className="text-xs text-teal-700 min-h-[36px] px-1"
            >
              {bulkSelected.size === list.length ? "☑ すべて選択解除" : "☐ すべて選択"}
            </button>
          </div>
        )}
        {bulkSelectMode && bulkSelected.size > 0 && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setBulkMovePickerOpen(true)}
              className="flex-1 min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-semibold"
            >
              📁 別フォルダへ移動({bulkSelected.size})
            </button>
            <button
              onClick={() => setBulkDeleteConfirmOpen(true)}
              className="flex-1 min-h-[48px] bg-red-600 text-white rounded-xl text-sm font-semibold"
            >
              🗑 削除({bulkSelected.size})
            </button>
          </div>
        )}

        {bulkDeleteConfirmOpen && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 space-y-2">
            <p className="text-xs text-red-700">{bulkSelected.size}件の削除方法を選んでください。</p>
            <button onClick={bulkRemoveFromFolder} className="w-full min-h-[48px] border border-slate-300 rounded-lg text-sm bg-white text-left px-3">
              <span className="font-medium">このフォルダから削除</span>
              <span className="block text-[11px] text-slate-500">他のフォルダになければ完全に消えます。</span>
            </button>
            <button onClick={bulkDeleteCompletely} className="w-full min-h-[48px] border border-red-300 text-red-600 rounded-lg text-sm bg-white text-left px-3">
              <span className="font-medium">すべてのフォルダから削除</span>
              <span className="block text-[11px] text-red-400">この表現自体が完全に削除されます</span>
            </button>
            <button onClick={() => setBulkDeleteConfirmOpen(false)} className="w-full min-h-[36px] text-xs text-slate-400">キャンセル</button>
          </div>
        )}

        <div className="relative">
          <div
            className="space-y-2 min-w-0 pr-1"
            style={{ maxHeight: "420px", overflowY: "auto" }}
            onScroll={onListScroll}
            onTouchMove={onListScroll}
          >
            {list.length === 0 && <p className="text-sm text-slate-400">このフォルダに{langOf(lang).tag}の表現はまだありません</p>}
            {list.map((e) => {
            const otherCode = otherLangOf(e.lang);
            const hasOther = expressions.some((x) => x.lang === otherCode && x.conceptId === e.conceptId);
            return (
              <div key={e.id} ref={(node) => { itemRefs.current[e.id] = node; }} className="border border-slate-200 rounded-xl p-3 bg-white">
                <div className="flex items-start gap-2">
                  {bulkSelectMode && (
                    <button
                      onClick={() => toggleBulkSelected(e.id)}
                      aria-label="選択"
                      className="min-w-[52px] min-h-[52px] flex items-center justify-center text-3xl shrink-0 -m-1 text-teal-700"
                    >
                      {bulkSelected.has(e.id) ? "☑" : "☐"}
                    </button>
                  )}
                  <button onClick={() => setSelectedExpr(e.id)} className="flex-1 text-left">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-sm text-slate-800">{crownedIds && crownedIds.has(e.id) && "👑 "}{e.en}</p>
                        {lang === "cn" && e.pinyin && <p className="text-xs text-teal-600">{e.pinyin}</p>}
                        <p className="text-xs text-slate-500">{e.ja}</p>
                      </div>
                      <span className={`text-[10px] shrink-0 px-2 py-1 rounded-full ${hasOther ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
                        {hasOther ? `✓ ${langOf(otherCode).tag}` : `${langOf(otherCode).flag} 未作成`}
                      </span>
                    </div>
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      speak(e.en);
                    }}
                    className="flex-1 min-h-[48px] bg-teal-50 border border-teal-200 text-teal-700 rounded-lg text-sm font-semibold"
                  >
                    🔊 音声を聞く
                  </button>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setPracticeTarget(e);
                    }}
                    className="flex-1 min-h-[48px] bg-teal-50 border border-teal-200 text-teal-700 rounded-lg text-sm font-semibold"
                  >
                    🎤 発音練習
                  </button>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setSelectedExpr(e.id);
                    }}
                    aria-label="編集"
                    className="min-w-[40px] min-h-[40px] rounded-lg border border-slate-200 text-slate-400 text-sm shrink-0"
                  >
                    ✏️
                  </button>
                </div>
              </div>
            );
          })}
          </div>
          {indexGroups.length > 0 && (
            <div className="absolute inset-y-0 right-0 w-14 pointer-events-none">
              <div
                ref={indexRailRef}
                style={{ top: `${10 + railScrollRatio * 80}%`, transform: "translateY(-50%)", maxHeight: "80vh", overflow: "hidden" }}
                className={`absolute right-1 flex flex-col items-center justify-center gap-0.5 bg-white/95 border border-slate-200 rounded-full shadow-lg py-2 px-1.5 transition-opacity duration-300 ${
                  showIndexRail ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                }`}
                onTouchStart={(ev) => {
                  setShowIndexRail(true);
                  if (indexHideTimer.current) clearTimeout(indexHideTimer.current);
                  jumpByPointerY(ev.touches[0].clientY, indexGroups);
                }}
                onTouchMove={(ev) => jumpByPointerY(ev.touches[0].clientY, indexGroups)}
                onTouchEnd={() => {
                  setActiveLabel(null);
                  indexHideTimer.current = setTimeout(() => setShowIndexRail(false), 2200);
                }}
              >
                {indexGroups.map((g) => (
                  <button
                    key={g.label}
                    onClick={() => jumpTo(g.id)}
                    className="min-w-[32px] min-h-[32px] flex items-center justify-center text-base font-bold text-teal-700 rounded-full"
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              {/* ドラッグ中、今どの見出しをなぞっているかを指の近くに大きく表示する(現在地の可視化)。
                  帯本体と同じ位置(railScrollRatio基準)に追従させる */}
              {activeLabel && (
                <div
                  style={{ top: `${10 + railScrollRatio * 80}%`, transform: "translateY(-50%)" }}
                  className="absolute right-16 bg-teal-700 text-white text-xl font-bold w-12 h-12 rounded-full flex items-center justify-center shadow-lg pointer-events-none"
                >
                  {activeLabel}
                </div>
              )}
            </div>
          )}
        </div>
        {deleteFolderModal}

        {/* 未分類の一括移動: フォルダ選択は既存のFolderPickerを再利用(未分類自体は選択肢から除く) */}
        {bulkMovePickerOpen && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end">
            <div className="w-full max-w-sm mx-auto bg-white rounded-t-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-800">📁 {bulkSelected.size}件の移動先</p>
                <button onClick={() => setBulkMovePickerOpen(false)} className="text-slate-400 text-sm min-h-[36px] px-2">閉じる</button>
              </div>
              <FolderPicker
                folders={folders.filter((f) => f.id !== UNCLASSIFIED_ID && f.createdLang === lang)}
                onPick={bulkMoveToFolder}
                onCreate={bulkMoveToNewFolder}
                onCancel={() => setBulkMovePickerOpen(false)}
              />
            </div>
          </div>
        )}

        {/* 発音練習ボトムシート: 編集画面には遷移せず、その場で完結させる */}
        {practiceTarget && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end">
            <div className="w-full max-w-sm mx-auto bg-white rounded-t-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-800">🎤 発音練習</p>
                <button onClick={() => setPracticeTarget(null)} className="text-slate-400 text-sm min-h-[36px] px-2">閉じる</button>
              </div>
              <p className="text-xs text-slate-400">{practiceTarget.ja}</p>
              <PronunciationPractice text={practiceTarget.en} lang={practiceTarget.lang} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-2">
        <button onClick={onOpenBulk} className="flex-1 min-h-[52px] bg-teal-700 text-white rounded-xl text-sm font-semibold">＋ まとめて登録</button>
        <button onClick={() => setNewFolderOpen(true)} className="flex-1 min-h-[52px] border-2 border-teal-700 text-teal-700 rounded-xl text-sm font-semibold bg-white">＋ 新しいフォルダ</button>
      </div>
      {/* AI検索は今回一旦UIから隠す(機能・遷移先の画面・関連コードは削除せず維持。再検討時にコメントを外せば復活可能)
      <button onClick={onOpenChat} className="w-full min-h-[52px] mb-4 border-2 border-slate-300 text-slate-700 rounded-xl text-sm font-semibold bg-white">
        🔍 AIに聞いて辞書を作る
      </button>
      */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-500">フォルダ一覧({langOf(lang).tag}の件数)</p>
        <button onClick={onOpenSettings} className="text-xs text-slate-500 min-h-[32px] px-2">⚙️ 設定</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {folders.filter((f) => f.id === UNCLASSIFIED_ID || f.createdLang === lang).map((f) => (
          <button key={f.id} onClick={() => setSelectedFolder(f.id)} className={`text-left border rounded-xl p-3 min-h-[64px] ${f.id === UNCLASSIFIED_ID ? "border-slate-300 bg-slate-50" : "border-teal-200 bg-teal-50"}`}>
            <p className="text-sm font-medium text-slate-800">📁 {f.path}</p>
            <p className="text-xs text-slate-500">{countIn(f.id)}件</p>
          </button>
        ))}
      </div>

      {deleteFolderModal}

      {newFolderOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-end">
          <div className="w-full max-w-sm mx-auto bg-white rounded-t-2xl p-5 space-y-3">
            <p className="font-semibold text-slate-800">新しいフォルダ</p>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="例: 慢性疾患＞初診"
              className="w-full border border-slate-300 rounded-lg px-3 py-3 text-sm"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={() => { setNewFolderOpen(false); setNewFolderName(""); }} className="flex-1 min-h-[48px] border border-slate-300 rounded-xl text-sm">キャンセル</button>
              <button onClick={createFolder} disabled={!newFolderName.trim()} className="flex-1 min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">作成する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 翻訳しただけで保存操作をする余裕が無かった表現を、あとから拾って辞書に保存するための画面。
// 直近5件の一覧表示のみ(検索・分類機能は持たない)。保存は既存のcheckSimilarBeforeSave/onSave(classifyAndSave)を
// そのまま呼び出す(新しい保存ロジックは作らない)。保存済み判定も、既存の重複判定と同じ考え方(normalizeJa)で
// expressionsを直接参照するだけで、履歴側に独自の「保存済みフラグ」は持たない。
function TranslationHistoryScreen({ history, expressions, onSave, checkSimilarBeforeSave, checkingSimilar, onBack, folders, showToast }) {
  const [savingId, setSavingId] = useState(null);
  const [patientItem, setPatientItem] = useState(null);

  const speak = (text, itemLang) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(itemLang).speech;
    window.speechSynthesis.speak(u);
  };

  const isSaved = (item) => expressions.some((e) => e.lang === item.lang && normalizeJa(e.ja) === normalizeJa(item.ja));

  const trySave = async (item) => {
    setSavingId(item.id);
    await checkSimilarBeforeSave(
      item.ja,
      item.en,
      item.lang,
      item.pinyin,
      async () => {
        await onSave(item.ja, item.en, item.lang, item.pinyin);
      },
      async (match) => {
        showToast?.(`📌 既存の表現（${describeFolderIds(match.folderIds, folders)}）を使用します`, true);
      } // 履歴上ではすでに「保存済み」表示になる(isSavedで判定)ので状態の追加更新は不要
    );
    setSavingId(null);
  };

  return (
    <div className="p-4 space-y-3 pb-6">
      <button onClick={onBack} className="text-teal-700 text-sm min-h-[44px]">← 翻訳に戻る</button>
      <p className="text-xs text-slate-500">直近{history.length}件の翻訳履歴です(保存しないと消えます)</p>

      {history.length === 0 && <p className="text-sm text-slate-400 text-center py-10">まだ翻訳履歴がありません</p>}

      <div className="space-y-2">
        {history.map((item) => {
          const saved = isSaved(item);
          const busy = checkingSimilar && savingId === item.id;
          return (
            <div key={item.id} className="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
              <div>
                <p className="text-sm text-slate-800">{item.ja}</p>
                <p className="text-sm text-teal-700 mt-1">
                  <span className="text-[10px] text-teal-500 font-semibold mr-1">{langOf(item.lang).tag}</span>
                  {item.en}
                </p>
                {item.lang === "cn" && item.pinyin && <p className="text-xs text-teal-500">{item.pinyin}</p>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => speak(item.en, item.lang)} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-xs bg-white text-slate-600">🔊</button>
                <button
                  onClick={() => trySave(item)}
                  disabled={saved || busy}
                  className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-xs bg-white text-slate-600 disabled:opacity-50"
                >
                  {saved ? "✅ 保存済み" : busy ? "確認中…" : "⭐ 保存"}
                </button>
                <button onClick={() => setPatientItem(item)} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-xs bg-white text-slate-600">👀</button>
              </div>
            </div>
          );
        })}
      </div>

      {patientItem && (
        <PatientDisplay
          text={patientItem.en}
          onSpeak={() => speak(patientItem.en, patientItem.lang)}
          onClose={() => setPatientItem(null)}
        />
      )}
    </div>
  );
}

// 設定画面。今回は「学習」(類似表現ON/OFF)と「プロフィール」(職業の確認のみ)の2カテゴリのみ。
// カテゴリ構造にしておくことで、今後設定項目が増えても該当カテゴリに足すだけで拡張できる。
// 設定値はApp直下のsettings stateをそのまま受け取って更新するだけで、独自の保存ロジックは持たない。
function SettingsScreen({ settings, setSettings, appProfile, setAppProfile, totalTrainingMs, crownedCount, onBack }) {
  const toggleSimilarCheck = () => {
    setSettings((prev) => ({ ...prev, similarCheckEnabled: !prev.similarCheckEnabled }));
  };

  const [editingProfile, setEditingProfile] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState(appProfile?.occupationCategory || "");
  const [occupationDraft, setOccupationDraft] = useState(appProfile?.occupation || "");

  const startEditingProfile = () => {
    setCategoryDraft(appProfile?.occupationCategory || "");
    setOccupationDraft(appProfile?.occupation || "");
    setEditingProfile(true);
  };

  const saveProfile = () => {
    const occupationCategory = categoryDraft.trim();
    const occupation = occupationDraft.trim();
    setAppProfile(occupationCategory || occupation ? { occupationCategory, occupation } : null);
    setEditingProfile(false);
  };

  return (
    <div className="p-4 space-y-5 pb-6">
      <button onClick={onBack} className="text-teal-700 text-sm min-h-[44px]">← 辞書に戻る</button>

      <div>
        <p className="text-xs font-semibold text-slate-400 mb-2">■ 学習</p>
        <div className="border border-slate-200 rounded-xl p-3 bg-white flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-800">類似表現チェック</p>
            <p className="text-xs text-slate-500 mt-0.5">保存時に似た表現がある場合、確認します。</p>
          </div>
          <button
            onClick={toggleSimilarCheck}
            role="switch"
            aria-checked={settings.similarCheckEnabled}
            aria-label="類似表現チェックの切り替え"
            className={`shrink-0 relative w-12 h-7 rounded-full transition-colors duration-200 ${settings.similarCheckEnabled ? "bg-teal-700" : "bg-slate-300"}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform duration-200 ${settings.similarCheckEnabled ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-400 mb-2">■ トレーニング実績</p>
        <div className="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-800">👑 言えるようになった表現</p>
            <p className="text-sm font-semibold text-slate-800">{crownedCount}</p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-800">累計トレーニング時間</p>
            <p className="text-sm font-semibold text-slate-800">{formatTrainingTime(totalTrainingMs)}</p>
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-400 mb-2">■ プロフィール</p>
        <div className="border border-slate-200 rounded-xl p-3 bg-white space-y-3">
          {!editingProfile ? (
            <>
              <div>
                <p className="text-xs text-slate-500">職業カテゴリ</p>
                <p className="text-sm text-slate-800 mt-0.5">{appProfile?.occupationCategory || "(未設定)"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">職種・役割</p>
                <p className="text-sm text-slate-800 mt-0.5">{appProfile?.occupation || "(未設定)"}</p>
              </div>
              <button onClick={startEditingProfile} className="text-xs text-teal-700 min-h-[32px]">変更する</button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-xs text-slate-500">職業カテゴリ(例：医療、飲食、美容、IT など)</label>
                <input
                  value={categoryDraft}
                  onChange={(e) => setCategoryDraft(e.target.value)}
                  placeholder="例：医療"
                  className="w-full border border-slate-300 rounded-xl p-3 text-base"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500">職種・役割(例：医師、店員、美容師、エンジニア など)</label>
                <input
                  value={occupationDraft}
                  onChange={(e) => setOccupationDraft(e.target.value)}
                  placeholder="例：医師"
                  className="w-full border border-slate-300 rounded-xl p-3 text-base"
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  onClick={saveProfile}
                  disabled={!categoryDraft.trim() && !occupationDraft.trim()}
                  className="flex-1 min-h-[40px] bg-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50"
                >
                  保存
                </button>
                <button onClick={() => setEditingProfile(false)} className="flex-1 min-h-[40px] border border-slate-300 rounded-xl text-sm text-slate-600">キャンセル</button>
              </div>
            </>
          )}
          <p className="text-[10px] text-slate-400">辞書分類やロールプレイの初期設定に使われます。ここで変更するといつでも切り替えられます。</p>
        </div>
      </div>
    </div>
  );
}

function BulkAddScreen({ onCancel, onSubmit, lang }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const { pairs, unrecognized } = parseBulkPaste(text, lang);
  const submit = async () => {
    if (pairs.length === 0) return;
    setBusy(true);
    await onSubmit(pairs, lang);
    setBusy(false);
  };

  return (
    <div className="p-4 space-y-4">
      <button onClick={onCancel} className="text-teal-700 text-sm min-h-[44px]">← マイ辞書に戻る</button>
      <p className="font-semibold text-slate-800">まとめて登録</p>
      <p className="text-xs text-slate-500">
        Quizletやメモ帳からコピペできます。
        「日本語 訳文」をスペースで区切って1行にするか、「日本語」→改行→「訳文」を交互に並べてください。
      </p>
      <p className="text-[11px] text-slate-400">一度に30件程度までを目安に、まとめて分類できます。</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder={"2週間後にもう一度来てください Please come back in two weeks.\nこの薬を1日2回塗ってください Apply this medicine twice a day."} className="w-full border border-slate-300 rounded-xl p-3 text-sm font-mono" />
      <p className="text-xs text-slate-500">{pairs.length}件を検出</p>
      {unrecognized.length > 0 && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-2.5">
          <p className="text-xs text-amber-700 font-medium">⚠️ {unrecognized.length}行を認識できませんでした(登録されません)</p>
          <p className="text-[11px] text-amber-600 mt-1 whitespace-pre-wrap">{unrecognized.slice(0, 5).join("\n")}{unrecognized.length > 5 ? "\n…" : ""}</p>
        </div>
      )}
      <button onClick={submit} disabled={pairs.length === 0 || busy} className="w-full min-h-[52px] bg-emerald-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
        {busy ? "登録・分類中…" : `${pairs.length}件を登録する`}
      </button>
    </div>
  );
}

function ChatSearchScreen({ lang, folders, onSave, onSaveToFolder, onCreateFolderAndSave, checkSimilarBeforeSave, showToast, onBack, onEditingChange }) {
  const [messages, setMessages] = useState([]); // {id, role, text, followups, adopted, editing, choosingFolder, en, pinyin, lang}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // 編集パネルが開いている間だけ、右上の言語切替をロックしてもらうため、状態を親に伝える
  // (messagesはこのコンポーネント内のローカルstateなので、真偽値だけを軽量に橋渡しする)
  useEffect(() => {
    onEditingChange && onEditingChange(messages.some((m) => m.editing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
  useEffect(() => {
    return () => {
      onEditingChange && onEditingChange(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translateFor = async (text) => {
    try {
      const out = await callClaude(`次の日本語の説明文を自然な${langOf(lang).label}に翻訳してください。${POV_INSTRUCTION}「Here is the translation」のような前置きや見出しは付けず、訳文そのものだけを出力してください。\n\n日本語: ${text}`);
      return out.replace(/^["「]|["」]$/g, "").replace(/^(here('s| is) the translation:?|translation:?)\s*/i, "").trim();
    } catch (e) {
      return "";
    }
  };

  const ask = async (queryText, historyMsg) => {
    setBusy(true);
    setMessages((prev) => [...prev, { id: newId("m"), role: "user", text: queryText }]);
    try {
      const context = historyMsg ? `直前のやり取り:\n質問: ${historyMsg.q}\n説明: ${historyMsg.a}\n\n` : "";
      const prompt =
        `あなたは${APP_CONTEXT.domainLabel}向け外国語学習アプリの中で、ユーザーが自分の辞書(定型文集)を作るのを手伝うアシスタントです。これは診察中の医学判断のための検索ではなく、後で表現として保存するための下書き作成が目的です。\n` +
        `次のキーワード・質問について、患者さんにそのまま説明する際に使える、必要最小限の日本語の一文(長くても2文まで)を書いてください。前置きや背景説明は省き、断定的な医学的指示や個別の診断・処方の判断は避けてください。\n` +
        `入力が曖昧・情報不足・専門用語として認識できないなど、適切な説明を作るのが難しい場合は、無理に説明を作らず、descriptionを空文字("")にし、followupsも空配列にしてください。\n` +
        context +
        `キーワード/質問: ${queryText}\n\n` +
        `次のJSON形式のみを出力してください(説明文やコードブロック記号は不要です)。\n` +
        `{"description":"必要最小限の日本語の一文(長くても2文)。作れない場合は空文字","followups":["関連する質問1(疑問形の短い日本語)","関連する質問2","関連する質問3"]}`;
      const out = await callClaude(prompt);
      const cleaned = out.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const description = (parsed.description || "").trim();

      if (!description) {
        setMessages((prev) => [
          ...prev,
          { id: newId("m"), role: "assistant", unavailable: true, text: "この内容について適切な説明を作れませんでした。もう少し具体的に入力してください。", followups: [], adopted: false, editing: false, en: "", pinyin: "", translating: false },
        ]);
        return;
      }

      const translated = await translateFor(description);
      const pinyin = lang === "cn" ? await fetchPinyin(translated) : "";

      setMessages((prev) => [
        ...prev,
        {
          id: newId("m"),
          role: "assistant",
          text: description,
          en: translated,
          pinyin,
          lang, // この回答を生成した時点の言語を固定して記録(後で言語を切り替えても保存時に混ざらないようにする)
          followups: Array.isArray(parsed.followups) ? parsed.followups.slice(0, 3) : [],
          adopted: false,
          editing: false,
          choosingFolder: false,
          translating: false,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: newId("m"), role: "assistant", text: "説明の生成に失敗しました。もう一度お試しください。", followups: [], adopted: false, editing: false, en: "", pinyin: "", translating: false },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const lastQA = () => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastAssistant || !lastUser) return null;
    return { q: lastUser.text, a: lastAssistant.text };
  };

  const submit = () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    ask(q, lastQA());
  };

  const openFolderPicker = (msg) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, choosingFolder: true } : m)));
  };

  const closeFolderPicker = (msg) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, choosingFolder: false } : m)));
  };

  const pickFolder = async (msg, folderId) => {
    await checkSimilarBeforeSave(
      msg.text,
      msg.en,
      msg.lang,
      msg.pinyin,
      async () => onSaveToFolder(msg.text, msg.en, msg.lang, msg.pinyin, folderId),
      async (match) => showToast?.(`📌 既存の表現（${describeFolderIds(match.folderIds, folders)}）を使用します`, true)
    );
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, choosingFolder: false, adopted: true } : m)));
  };

  const pickNewFolder = async (msg, name) => {
    if (!name.trim()) return;
    await checkSimilarBeforeSave(
      msg.text,
      msg.en,
      msg.lang,
      msg.pinyin,
      async () => onCreateFolderAndSave(msg.text, msg.en, msg.lang, msg.pinyin, name),
      async (match) => showToast?.(`📌 既存の表現（${describeFolderIds(match.folderIds, folders)}）を使用します`, true)
    );
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, choosingFolder: false, adopted: true } : m)));
  };

  const openEdit = (msg) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, editing: true } : m)));
  };

  const saveEdited = async (msg, jaEdited, enEdited, pinyinEdited) => {
    await checkSimilarBeforeSave(
      jaEdited,
      enEdited,
      msg.lang,
      pinyinEdited,
      async () => onSave(jaEdited, enEdited, msg.lang, pinyinEdited),
      async (match) => showToast?.(`📌 既存の表現（${describeFolderIds(match.folderIds, folders)}）を使用します`, true)
    );
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, editing: false, adopted: true } : m)));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 pb-2 space-y-3 flex-1 overflow-y-auto">
        <button onClick={onBack} className="text-teal-700 text-sm min-h-[44px]">← マイ辞書に戻る</button>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p className="text-xs text-amber-800">
            ⚠️ AIの回答は一般的な説明の下書きです。内容を確認し、必要なら編集してから辞書に保存してください({langOf(lang).tag}で保存されます)
          </p>
        </div>
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center py-6">
            例:「タクロリムス外用 説明」のように調べたいキーワードを入力してください
          </p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="bg-teal-700 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm max-w-[85%]">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="bg-slate-50 border border-slate-200 rounded-2xl rounded-bl-sm px-3 py-3 text-sm max-w-[92%] space-y-2">
                <p className="text-slate-800 whitespace-pre-wrap">{m.text}</p>

                {!m.unavailable && m.en && !m.editing && (
                  <div>
                    <p className="text-teal-700 whitespace-pre-wrap">
                      <span className="text-[10px] text-teal-500 font-semibold mr-1">{langOf(m.lang).tag}</span>
                      {m.en}
                    </p>
                    {m.lang === "cn" && m.pinyin && <p className="text-xs text-teal-500">{m.pinyin}</p>}
                  </div>
                )}

                {m.unavailable ? null : m.editing ? (
                  <EditAdoptPanel
                    msg={m}
                    lang={m.lang}
                    onCancel={() => setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, editing: false } : x)))}
                    onSave={(ja, en, pinyin) => saveEdited(m, ja, en, pinyin)}
                  />
                ) : m.adopted ? (
                  <p className="text-xs text-emerald-700 font-medium">✅ 辞書に保存済み</p>
                ) : m.choosingFolder ? (
                  <FolderPicker folders={folders} onPick={(fid) => pickFolder(m, fid)} onCreate={(name) => pickNewFolder(m, name)} onCancel={() => closeFolderPicker(m)} />
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => openFolderPicker(m)} className="flex-1 min-h-[44px] bg-emerald-600 text-white rounded-lg text-xs font-semibold">
                      ⭐ 採用して辞書に保存
                    </button>
                    <button onClick={() => openEdit(m)} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-xs bg-white">
                      ✏️ 編集する
                    </button>
                  </div>
                )}

                {m.followups && m.followups.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {m.followups.map((f, i) => (
                      <button key={i} onClick={() => ask(f, lastQA())} disabled={busy} className="text-xs border border-teal-200 text-teal-700 bg-teal-50 rounded-full px-3 py-1.5 disabled:opacity-50">
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {busy && <p className="text-xs text-slate-400 text-center">考え中…</p>}
      </div>

      <div className="p-3 border-t border-slate-200 flex gap-2 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="例: タクロリムス外用 説明"
          className="flex-1 border border-slate-300 rounded-xl px-3 py-3 text-sm"
        />
        <button onClick={submit} disabled={busy || !input.trim()} className="min-h-[48px] px-4 bg-teal-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
          送信
        </button>
      </div>
    </div>
  );
}

function FolderPicker({ folders, onPick, onCreate, onCancel }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="space-y-2 border-t border-slate-200 pt-2">
      <p className="text-[11px] text-slate-500">保存先を選んでください</p>
      {folders.length === 0 && <p className="text-xs text-slate-400">移動先のフォルダがありません</p>}
      <div className="flex flex-wrap gap-2">
        {folders.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            className={`text-sm min-h-[40px] rounded-full px-4 border ${
              f.id === UNCLASSIFIED_ID ? "border-slate-300 text-slate-600 bg-slate-50" : "border-teal-300 text-teal-700 bg-teal-50"
            }`}
          >
            📁 {f.path}
          </button>
        ))}
      </div>
      {creating ? (
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新しいフォルダ名" className="flex-1 border border-slate-300 rounded-lg px-2 py-2 text-sm" />
          <button onClick={() => onCreate(name)} disabled={!name.trim()} className="bg-teal-700 text-white rounded-lg px-3 min-h-[40px] text-xs font-semibold disabled:opacity-50">作成</button>
        </div>
      ) : (
        <button onClick={() => setCreating(true)} className="text-teal-700 text-xs">+ 新しいフォルダを作って保存</button>
      )}
      <button onClick={onCancel} className="w-full min-h-[36px] text-xs text-slate-400">キャンセル</button>
    </div>
  );
}

function EditAdoptPanel({ msg, lang, onCancel, onSave }) {
  const [ja, setJa] = useState(msg.text);
  const [en, setEn] = useState(msg.en || "");
  const [pinyin, setPinyin] = useState(msg.pinyin || "");
  const [translating, setTranslating] = useState(false);

  const refreshTranslation = async () => {
    if (!ja.trim() || !containsJapanese(ja.trim())) return;
    setTranslating(true);
    try {
      const out = await callClaude(`次の日本語の説明文を自然な${langOf(lang).label}に翻訳してください。${POV_INSTRUCTION}前置きや見出しは付けず、訳文そのものだけを出力してください。\n\n日本語: ${ja}`);
      const t = out.replace(/^["「]|["」]$/g, "").replace(/^(here('s| is) the translation:?|translation:?)\s*/i, "").trim();
      if (t) {
        setEn(t);
        setPinyin(lang === "cn" ? await fetchPinyin(t) : "");
      }
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-200 pt-2">
      <label className="text-[11px] text-slate-500">日本語</label>
      <textarea value={ja} onChange={(e) => setJa(e.target.value)} rows={4} className="w-full border border-slate-300 rounded-lg p-3 text-base leading-relaxed" />
      {ja.trim() && !containsJapanese(ja.trim()) && <p className="text-xs text-red-600">日本語を入力してください</p>}
      <button onClick={refreshTranslation} disabled={translating || !ja.trim() || !containsJapanese(ja.trim())} className="w-full min-h-[40px] border border-teal-600 text-teal-700 rounded-lg text-xs font-semibold bg-white disabled:opacity-50">
        {translating ? "更新中…" : "訳文を更新(日本語から再翻訳)"}
      </button>
      <label className="text-[11px] text-slate-500">訳文</label>
      <textarea value={en} onChange={(e) => setEn(e.target.value)} rows={4} className="w-full border border-slate-300 rounded-lg p-3 text-base leading-relaxed" />
      {en.trim() && !looksLikeTargetLangScript(en.trim(), lang) && <p className="text-xs text-red-600">{langOf(lang).nameJa}を入力してください</p>}
      {lang === "cn" && (
        <>
          <label className="text-[11px] text-slate-500">ピンイン</label>
          <input value={pinyin} onChange={(e) => setPinyin(e.target.value)} className="w-full border border-slate-300 rounded-lg p-2 text-sm" />
        </>
      )}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-sm">キャンセル</button>
        <button
          onClick={() => onSave(ja, en, pinyin)}
          disabled={!ja.trim() || !en.trim() || !containsJapanese(ja.trim()) || !looksLikeTargetLangScript(en.trim(), lang)}
          className="flex-1 min-h-[44px] bg-teal-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          辞書に保存
        </button>
      </div>
    </div>
  );
}

// 辞書の文章1件に対する軽い「発音練習」。精密な発音採点ではなく、音声認識結果に基づくおおまかな目安。
// 既存の音声認識(getRecognition)・AI呼び出し(callClaude)をそのまま再利用する。
function PronunciationPractice({ text, lang }) {
  const [segments, setSegments] = useState(null); // null = まだ発話していない(全体を灰色で表示)
  const [listening, setListening] = useState(false);
  const [judging, setJudging] = useState(false);
  const [error, setError] = useState("");
  const recogRef = useRef(null);

  const placeholderSegments = () => {
    const parts = lang === "cn" ? text.replace(/[、。,.!?！？\s]/g, "").split("") : text.split(/\s+/).filter(Boolean);
    return parts.map((t) => ({ text: t, level: "gray" }));
  };

  const judge = async (transcript) => {
    setJudging(true);
    setError("");
    try {
      const prompt =
        `あなたは語学練習アプリの発音練習アシスタントです。ユーザーが次のお手本文章を音読しました。これは精密な発音採点ではなく、音声認識結果からの大まかな目安を示すものです。断定的な評価はしないでください。\n` +
        `お手本の文章: ${text}\n` +
        `音声認識された内容: ${transcript}\n\n` +
        `お手本の文章を、自然な単語または意味のまとまり単位で分割し、それぞれが音声認識結果とどの程度対応していそうかを判定してください。認識エンジンの誤認識もあるため、厳しく判定しすぎないでください。\n` +
        `次のJSON形式のみを出力してください(説明不要)。\n` +
        `{"segments":[{"text":"お手本文章の断片(すべて連結すると元の文章と完全に一致すること)","level":"green"か"black"か"red"}]}\n` +
        `level: green=十分伝わっていそう、black=まあまあ伝わっていそう、red=認識されにくかった可能性が高い。`;
      const out = await callClaude(prompt);
      const cleaned = out.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
        setSegments(parsed.segments);
      } else {
        throw new Error("empty");
      }
    } catch (e) {
      setError("判定に失敗しました。もう一度お試しください。");
    } finally {
      setJudging(false);
    }
  };

  const toggleMic = () => {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const r = getRecognition(langOf(lang).speech);
    if (!r) {
      setError("この環境では音声入力に対応していません。");
      return;
    }
    r.onresult = (ev) => judge(ev.results[0][0].transcript);
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("音声を認識できませんでした。もう一度お試しください。");
    };
    try {
      recogRef.current = r;
      setListening(true);
      r.start();
    } catch (e) {
      setListening(false);
      setError("音声入力を開始できませんでした。もう一度お試しください。");
    }
  };

  const colorClass = (level) => {
    if (level === "green") return "text-emerald-600 font-semibold";
    if (level === "black") return "text-slate-800";
    if (level === "red") return "text-red-500 font-semibold";
    return "text-slate-300";
  };

  const display = segments || placeholderSegments();

  return (
    <div className="space-y-3">
      <p className="text-xl leading-relaxed text-center py-2">
        {display.map((seg, i) => (
          <span key={i} className={colorClass(seg.level)}>
            {seg.text}
            {lang !== "cn" ? " " : ""}
          </span>
        ))}
      </p>
      <p className="text-[11px] text-slate-400 text-center">⚠️ 音声認識による簡易的な目安です。断定的な発音評価ではありません</p>
      {error && <p className="text-xs text-red-600 text-center">{error}</p>}
      <button
        onClick={toggleMic}
        disabled={judging}
        className={`w-full min-h-[56px] rounded-xl text-base font-semibold border-2 ${
          listening ? "bg-red-50 border-red-300 text-red-600" : "bg-teal-700 border-teal-700 text-white"
        } disabled:opacity-50`}
      >
        {judging ? "判定中…" : listening ? "🎤 聞き取り中…" : segments ? "🎤 もう一度話す" : "🎤 話す"}
      </button>
    </div>
  );
}

function ExpressionDetail({ expr, expressions, folders, setFolders, setExpressions, setSelectedExpr, currentFolderId, onBack, onRemovedFromFolder, onDeleted, showToast }) {
  const [ja, setJa] = useState(expr.ja);
  const [en, setEn] = useState(expr.en);
  const [adding, setAdding] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [deleteStep, setDeleteStep] = useState(null); // null | "choose" | "confirmFull"
  const [savingEdit, setSavingEdit] = useState(false);

  const [creatingOther, setCreatingOther] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [otherPinyin, setOtherPinyin] = useState("");
  const [otherLoading, setOtherLoading] = useState(false);
  const otherSavingLockRef = useRef(false);
  const [otherSaving, setOtherSaving] = useState(false);

  const myFolders = folders.filter((f) => expr.folderIds.includes(f.id));
  const otherCode = otherLangOf(expr.lang);
  const otherSibling = expressions.find((e) => e.lang === otherCode && e.conceptId === expr.conceptId);

  const speakExpr = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(expr.lang).speech;
    window.speechSynthesis.speak(u);
  };

  const startCreateOther = async () => {
    setCreatingOther(true);
    setOtherLoading(true);
    setOtherDraft("");
    setOtherPinyin("");
    try {
      const out = await callClaude(`次の日本語を自然な${langOf(otherCode).label}に翻訳してください。${POV_INSTRUCTION}前置きや見出しは付けず、訳文だけを1行で出力してください。\n\n日本語: ${expr.ja}`);
      const translated = out.replace(/^["「]|["」]$/g, "").trim();
      setOtherDraft(translated);
      if (otherCode === "cn") setOtherPinyin(await fetchPinyin(translated));
    } finally {
      setOtherLoading(false);
    }
  };

  const cancelCreateOther = () => {
    setCreatingOther(false);
    setOtherDraft("");
    setOtherPinyin("");
  };

  const saveOther = async () => {
    if (otherSavingLockRef.current || !otherDraft.trim()) return;
    // 念のための二重確認: すでに同じconceptId×言語の表現があれば作らない
    if (findDuplicateExpression(expressions, expr.conceptId, otherCode)) {
      cancelCreateOther();
      return;
    }
    otherSavingLockRef.current = true;
    setOtherSaving(true);
    // 中国語の場合、保存直前のotherDraftから改めてピンインを取得する(古いotherPinyinは使わない)。
    // これにより、翻訳後に中国語文を手動編集していても、保存される文章とピンインが必ず対応する。
    const pinyin = otherCode === "cn" ? await fetchPinyin(otherDraft.trim()) : undefined;
    const newExpr = {
      id: newId("e"),
      conceptId: expr.conceptId,
      ja: expr.ja,
      en: otherDraft.trim(),
      ...(pinyin ? { pinyin } : {}),
      lang: otherCode,
      folderIds: [...expr.folderIds],
    };
    setExpressions((prev) => [newExpr, ...prev]);
    showToast(`✅ ${langOf(otherCode).tag}版を作成しました`, true);
    setOtherSaving(false);
    otherSavingLockRef.current = false;
    cancelCreateOther();
  };

  const saveEdit = async () => {
    if (!containsJapanese(ja.trim()) || !en.trim() || !looksLikeTargetLangScript(en.trim(), expr.lang)) return;
    setSavingEdit(true);
    const pinyin = expr.lang === "cn" ? await fetchPinyin(en) : undefined;
    setExpressions((prev) => prev.map((e) => (e.id === expr.id ? { ...e, ja, en, ...(pinyin ? { pinyin } : {}) } : e)));
    setSavingEdit(false);
    showToast("編集を保存しました(全フォルダに反映)", true);
  };

  // フォルダは言語ごとに独立しているため、このfolderIdを外すのはexpr自身(その言語)だけにする
  const removeFolder = (folderId) => {
    let ids = expr.folderIds.filter((id) => id !== folderId);
    if (ids.length === 0) ids = [UNCLASSIFIED_ID];
    setExpressions((prev) => prev.map((e) => (e.id === expr.id ? { ...e, folderIds: [...ids] } : e)));
  };

  // 通常フォルダに追加した場合、まだ「未分類」にしか入っていなければ未分類から自動的に外す
  const attachFolder = (fid) => {
    if (expr.folderIds.includes(fid)) return;
    let ids = [...expr.folderIds, fid];
    if (fid !== UNCLASSIFIED_ID) ids = ids.filter((id) => id !== UNCLASSIFIED_ID);
    // フォルダは言語ごとに独立しているため、このfidを付与するのはexpr自身(その言語)だけにする
    // (以前はconceptId一致で他言語版にも同じfolderIdを付けていたが、フォルダIDが言語別になったため対象外にする)
    setExpressions((prev) => prev.map((e) => (e.id === expr.id ? { ...e, folderIds: [...ids] } : e)));
  };

  const addFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    let folder = folders.find((f) => f.path === name && f.createdLang === expr.lang);
    if (!folder) {
      folder = { id: newId("f"), path: name, userCreated: true, createdLang: expr.lang };
      setFolders((prev) => [...prev, folder]);
    }
    attachFolder(folder.id);
    setNewFolderName("");
    setAdding(false);
  };

  const deleteExpression = () => {
    setExpressions((prev) => prev.filter((e) => e.id !== expr.id));
    onDeleted();
  };

  const removeFromCurrentFolder = () => {
    if (!currentFolderId) return;
    removeFolder(currentFolderId);
    setDeleteStep(null);
    showToast("このフォルダから外しました", true);
    if (onRemovedFromFolder) onRemovedFromFolder();
    else onBack();
  };

  // 「別言語版を作る」は専用のミニ画面として分離する(元の言語の編集欄は一切表示しない)
  if (creatingOther) {
    return (
      <div className="p-4 space-y-4">
        <button onClick={cancelCreateOther} className="text-teal-700 text-sm min-h-[44px]">← 戻る</button>
        <p className="font-semibold text-slate-800">{langOf(otherCode).flag} {langOf(otherCode).nameJa}版を作る</p>

        <div>
          <label className="text-xs text-slate-500">日本語(共通の原文・編集不可)</label>
          <p className="w-full border border-slate-200 bg-slate-50 rounded-xl p-3 text-base leading-relaxed text-slate-700 mt-1">{expr.ja}</p>
        </div>

        <div>
          <label className="text-xs text-slate-500">{langOf(otherCode).nameJa}({langOf(otherCode).tag}・編集可)</label>
          {otherLoading ? (
            <p className="text-sm text-slate-400 p-3">翻訳中…</p>
          ) : (
            <textarea value={otherDraft} onChange={(e) => setOtherDraft(e.target.value)} rows={4} className="w-full border border-slate-300 rounded-xl p-3 text-base leading-relaxed mt-1" />
          )}
          {otherDraft.trim() && !looksLikeTargetLangScript(otherDraft.trim(), otherCode) && (
            <p className="text-xs text-red-600 mt-1">{langOf(otherCode).nameJa}を入力してください</p>
          )}
          {otherCode === "cn" && otherPinyin && !otherLoading && <p className="text-sm text-teal-600 mt-1">{otherPinyin}</p>}
        </div>

        <div className="flex gap-2">
          <button onClick={cancelCreateOther} className="flex-1 min-h-[48px] border border-slate-300 rounded-xl text-sm bg-white">キャンセル</button>
          <button
            onClick={saveOther}
            disabled={otherLoading || otherSaving || !otherDraft.trim() || !looksLikeTargetLangScript(otherDraft.trim(), otherCode)}
            className="flex-1 min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {otherSaving ? "保存中…" : `${langOf(otherCode).tag}版として保存`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <button onClick={onBack} className="text-teal-700 text-sm min-h-[44px]">← 戻る</button>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">日本語</label>
        <p className="w-full border border-slate-200 bg-slate-50 rounded-xl p-3 text-base leading-relaxed text-slate-700 whitespace-pre-wrap">{ja}</p>
        <label className="text-xs text-slate-500">訳文</label>
        <textarea value={en} onChange={(e) => setEn(e.target.value)} rows={4} className="w-full border border-slate-300 rounded-xl p-3 text-base leading-relaxed" />
        <button
          onClick={() => speakExpr(en)}
          disabled={!en.trim()}
          className="w-full min-h-[44px] border border-slate-300 rounded-lg text-sm bg-white text-slate-600 disabled:opacity-50"
        >
          🔊 音声を聞く
        </button>
        {en.trim() && !looksLikeTargetLangScript(en.trim(), expr.lang) && (
          <p className="text-xs text-red-600">{langOf(expr.lang).nameJa}を入力してください</p>
        )}
        {expr.lang === "cn" && expr.pinyin && <p className="text-sm text-teal-600">ピンイン: {expr.pinyin}</p>}
        <button
          onClick={saveEdit}
          disabled={savingEdit || !containsJapanese(ja.trim()) || !en.trim() || !looksLikeTargetLangScript(en.trim(), expr.lang)}
          className="w-full min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50"
        >
          {savingEdit ? "保存中…" : "編集を保存"}
        </button>
      </div>

      <div className="border border-slate-200 rounded-xl p-3">
        {otherSibling ? (
          <button onClick={() => setSelectedExpr(otherSibling.id)} className="w-full text-left flex items-center justify-between">
            <span className="text-sm text-slate-700">{langOf(otherCode).flag} {langOf(otherCode).nameJa}版</span>
            <span className="text-xs text-emerald-700 font-semibold">✓ {langOf(otherCode).tag}版あり →</span>
          </button>
        ) : (
          <button onClick={startCreateOther} className="w-full min-h-[48px] border-2 border-teal-700 text-teal-700 rounded-lg text-sm font-semibold">
            {langOf(otherCode).flag} {langOf(otherCode).nameJa}版を作る
          </button>
        )}
      </div>

      <div>
        <p className="text-xs text-slate-500 mb-1">所属フォルダ(複数可・EN/CN共通)</p>
        <div className="flex flex-wrap gap-2">
          {myFolders.map((f) => (
            <span key={f.id} className="bg-teal-50 border border-teal-200 text-teal-800 text-xs rounded-full px-3 py-1.5 flex items-center gap-1">
              {f.path}
              {f.id !== UNCLASSIFIED_ID && <button onClick={() => removeFolder(f.id)} className="text-teal-500 min-w-[20px]">×</button>}
            </span>
          ))}
        </div>
        {adding ? (
          <div className="mt-2 space-y-2">
            {folders.filter((f) => f.id !== UNCLASSIFIED_ID && f.createdLang === expr.lang && !expr.folderIds.includes(f.id)).length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-slate-400">既存のフォルダから選ぶ</p>
                <div className="flex flex-wrap gap-1.5">
                  {folders.filter((f) => f.id !== UNCLASSIFIED_ID && f.createdLang === expr.lang && !expr.folderIds.includes(f.id)).map((f) => (
                    <button key={f.id} onClick={() => { attachFolder(f.id); setAdding(false); }} className="text-xs border border-teal-200 text-teal-700 bg-teal-50 rounded-full px-3 py-1.5">
                      {f.path}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[11px] text-slate-400">または新しいフォルダ名で追加</p>
            <div className="flex gap-2">
              <input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="例: 共通＞再診" className="flex-1 border border-slate-300 rounded-lg px-2 py-2 text-sm" />
              <button onClick={addFolder} className="bg-teal-700 text-white rounded-lg px-3 min-h-[44px] text-sm">追加</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="text-teal-700 text-xs mt-2 min-h-[44px]">+ フォルダを追加</button>
        )}
      </div>
      <div className="pt-4 border-t border-slate-200">
        {deleteStep === "choose" && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
            <p className="text-xs text-slate-600">どちらの操作を行いますか?</p>
            {currentFolderId && (
              <button onClick={removeFromCurrentFolder} className="w-full min-h-[44px] border border-slate-300 rounded-lg text-sm bg-white text-left px-3">
                <span className="font-medium">このフォルダから外す</span>
                <span className="block text-[11px] text-slate-500">表現は削除されません。他のフォルダには残ります</span>
              </button>
            )}
            <button onClick={() => setDeleteStep("confirmFull")} className="w-full min-h-[44px] border border-red-300 text-red-600 rounded-lg text-sm bg-white text-left px-3">
              <span className="font-medium">この表現を完全に削除</span>
              <span className="block text-[11px] text-red-400">すべてのフォルダから消え、表現自体が削除されます</span>
            </button>
            <button onClick={() => setDeleteStep(null)} className="w-full min-h-[36px] text-xs text-slate-400">キャンセル</button>
          </div>
        )}
        {deleteStep === "confirmFull" && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-2">
            <p className="text-xs text-red-700">
              {myFolders.length > 1 ? `この表現は${myFolders.length}個のフォルダから参照されています。完全に削除するとすべてから消えます。` : "この表現を完全に削除します。"}
              {langOf(otherCode).tag}版がある場合、そちらは削除されず別の表現として残ります。
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteStep("choose")} className="flex-1 min-h-[44px] border border-slate-300 rounded-lg text-xs">戻る</button>
              <button onClick={deleteExpression} className="flex-1 min-h-[44px] bg-red-600 text-white rounded-lg text-xs">完全に削除する</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// まとめ画面でのみ使う比較用の正規化(表示文字列自体は変更しない)。
// 末尾の句読点・記号(「.」「!」「?」「。」「!」「?」「、」「,」等)の違いと、
// 前後の空白・大文字小文字の違いを無視して同一表現かどうかを判定する。
const normalizeForCompare = (s) =>
  (s || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?。\uff01\uff1f、,，]+$/u, "")
    .trim();

function ReviewScreen({ expressions, lang, priorityIds, onFinish, onAddTrainingTime, onCrownAchieved }) {
  // この復習セッション開始時の言語で固定する。ヘッダーで言語を切り替えても、出題内容・ラベル・音声は影響を受けない
  const [lockedLang] = useState(lang);
  // ロールプレイでsuccess以外だった表現(priorityIds)があれば、出題の先頭に優先的に混ぜる。
  // 残り枠はこれまで通りランダム抽選。
  const [deck] = useState(() => {
    const weak = priorityIds ? expressions.filter((e) => priorityIds.has(e.id)) : [];
    const rest = expressions.filter((e) => !priorityIds || !priorityIds.has(e.id));
    const shuffledRest = [...rest].sort(() => Math.random() - 0.5);
    return [...weak, ...shuffledRest].slice(0, 6);
  });
  const [index, setIndex] = useState(0);
  const [judged, setJudged] = useState(null); // {score(1-3), feedbackText}
  const [judging, setJudging] = useState(false);
  const [answer, setAnswer] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [hints, setHints] = useState(null); // null=未取得、[]=取得済みだがヒント不要と判定、[...]=ヒントあり(取得は1回のAPI呼び出しでまとめて行う)
  const [hintLevel, setHintLevel] = useState(0); // 0=未表示、1〜3=表示済みの段階数
  const [hintLoading, setHintLoading] = useState(false);
  const [hintFailed, setHintFailed] = useState(false); // 取得自体が失敗した場合(hints=[]の「ヒント不要」とは区別する)
  const [results, setResults] = useState([]); // 今日の復習一覧用: {ja, savedAnswer, naturalExample, score}
  const [showSummary, setShowSummary] = useState(false);
  const recogRef = useRef(null);
  // トレーニング時間計測用: 現在の問題が表示された時刻(「表示された時刻」→「回答するボタンを押した時刻」の区間を計測する)
  const questionShownAtRef = useRef(Date.now());

  if (expressions.length === 0) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-slate-600 text-sm">まだ{langOf(lockedLang).tag}の保存済み表現がありません。翻訳・保存してから復習を試してください。</p>
        <button onClick={onFinish} className="min-h-[48px] px-5 bg-teal-700 text-white rounded-xl text-sm">戻る</button>
      </div>
    );
  }

  if (showSummary) {
    return (
      <div className="p-4 space-y-3">
        <p className="font-semibold text-slate-800">今日の復習</p>
        <div className="space-y-2">
          {results.map((r, i) => {
            // 保存文とAIの自然な例文が、末尾の句読点・大文字小文字・前後の空白の違いを除いて
            // 実質的に同じ場合だけ1つにまとめる(表示自体は元の文字列のまま)
            const isSame = normalizeForCompare(r.savedAnswer) === normalizeForCompare(r.naturalExample);
            return (
              <div key={i} className="border border-slate-200 rounded-xl p-3 bg-white space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-0.5">
                    {isSame ? (
                      <p className="text-sm text-slate-800">{r.savedAnswer}</p>
                    ) : (
                      <>
                        <p className="text-[11px] text-slate-400">保存していた表現</p>
                        <p className="text-sm text-slate-800">{r.savedAnswer}</p>
                        <p className="text-[11px] text-slate-400 mt-1">他の自然な{langOf(lockedLang).nameJa}</p>
                        <p className="text-sm text-slate-800">{r.naturalExample}</p>
                      </>
                    )}
                  </div>
                  <div className="flex shrink-0 pt-0.5">
                    {[1, 2, 3].map((n) => (
                      <span key={n} style={{ fontSize: "16px" }} className={n <= r.score ? "opacity-100" : "opacity-25"}>💎</span>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-slate-500">{r.ja}</p>
              </div>
            );
          })}
        </div>
        <button onClick={onFinish} className="w-full min-h-[52px] bg-teal-700 text-white rounded-xl text-sm font-semibold">元の画面に戻る</button>
      </div>
    );
  }

  const current = deck[index];

  const judge = async (spokenText) => {
    // トレーニング時間: 「問題が表示された時刻」から「回答するボタンを押した時刻(=judge呼び出し時点)」までを計測して加算する。
    // 画面を開いたまま放置しても、このボタンを押さない限り加算されない。
    if (onAddTrainingTime) onAddTrainingTime(Date.now() - questionShownAtRef.current);
    setJudging(true);
    setError("");
    try {
      const prompt =
        `あなたは仕事で使う外国語学習アプリの、前向きなフィードバック役です。目的はネイティブ級の英語を採点することではなく、仕事で使える表現に近づけることです。\n` +
        `最初に必ず確認すること: ユーザーの回答が${langOf(lockedLang).nameJa}で書かれているかを判定してください(inTargetLanguage)。英語・中国語・ローマ字表記(ピンインのみ等)が混ざっている、または指定言語以外で書かれている場合はfalseにしてください。\n` +
        `inTargetLanguageがfalseの場合、意味が通じるかどうかに関わらずscoreは必ず1にし、feedbackTextには文法の指摘ではなく「この問題は${langOf(lockedLang).nameJa}で答えてください。」という趣旨のみを書いてください(言語名は必ず「${langOf(lockedLang).nameJa}」という日本語表記を使うこと)。\n` +
        `重要: 「登録されている訳文」はユーザーが過去に自分で登録したものであり、必ずしも正確・自然とは限りません。採点も正解例の作成も、登録されている訳文をそのまま鵜呑みにせず、日本語の意味・文脈を基準にして判断してください。\n` +
        `inTargetLanguageがtrueの場合のみ、以下の基準で通常通り採点してください。\n` +
        `日本語の意味に対してユーザーの回答が自然で正しく伝わっているかを基準に判断してください(「登録されている訳文との一致率」では判断しないでください)。言い方が登録されている訳文と違っても、日本語の意味に対して自然に伝わるなら高く評価してください。数字の表記・句読点・大文字小文字などの表面的な違いは減点しないでください。\n` +
        `naturalExampleには、登録されている訳文に引きずられず、日本語の意味・文脈に対して実際に自然な${langOf(lockedLang).label}表現を作ってください(登録されている訳文が自然であれば同じ内容で構いませんが、不自然・不正確だと判断した場合は、日本語の意味に沿った自然な表現に置き換えてください)。\n\n` +
        `日本語: ${current.ja}\n` +
        `登録されている訳文(参考。必ずしも正確とは限らない): ${current.en}\n` +
        `ユーザーの回答: ${spokenText}\n\n` +
        `次のJSON形式のみを出力してください(説明文やコードブロック記号は不要です)。\n` +
        `{"inTargetLanguage":true または false,"score":1か2か3の数字,"feedbackText":"1〜2文の短いフィードバック。3の場合は良かった点を一言、1〜2の場合は断定しすぎず、意味は伝わる前提でどう直すとより自然かを一言","naturalExample":"日本語の意味に対して自然な${langOf(lockedLang).label}表現(登録訳文に引きずられないこと)"${lockedLang === "cn" ? `,"naturalExamplePinyin":"naturalExampleのピンイン"` : ""}}\n` +
        `score基準(inTargetLanguageがtrueの場合のみ): 3=日本語の意味に対して自然で正しく伝わり、そのまま仕事で使えるレベル。2=意味は概ね伝わるが改善余地がある。1=日本語の意味が十分に伝わらない、または重要な部分の修正が必要(ただし「間違い」と断定しすぎない)。`;
      const out = await callClaude(prompt);
      const cleaned = out.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const inTargetLanguage = parsed.inTargetLanguage !== false;
      // 言語が違う場合は、AIの判定内容によらずクライアント側でもscore=1・案内文に固定する(二重の安全弁)
      const score = !inTargetLanguage ? 1 : [1, 2, 3].includes(parsed.score) ? parsed.score : 2;
      const feedbackText = !inTargetLanguage
        ? `この問題は${langOf(lockedLang).nameJa}で答えてください。`
        : parsed.feedbackText || "";
      // 登録済みの訳文をそのまま「正解」として出さず、日本語の意味を基準にAIが作った自然な例を優先表示する
      // (取得できなかった場合のみ、既存の登録訳文にフォールバックする)
      const naturalExample = (parsed.naturalExample || "").trim() || current.en;
      const naturalExamplePinyin = lockedLang === "cn" ? (parsed.naturalExamplePinyin || "").trim() : "";
      setJudged({ score, feedbackText, naturalExample, naturalExamplePinyin });
      setResults((prev) => [...prev, { ja: current.ja, savedAnswer: current.en, naturalExample, score }]);
      // 👑「言えるようになった表現」の記録。既存のscore判定基準は変更しない(score===3の場合のみ記録)
      if (score === 3 && onCrownAchieved) onCrownAchieved(current.id);
    } catch (e) {
      setJudged({ score: 2, feedbackText: "判定に失敗したため参考表示です。もう一度試すか正解例を確認してください。", naturalExample: current.en, naturalExamplePinyin: current.pinyin || "" });
      setResults((prev) => [...prev, { ja: current.ja, savedAnswer: current.en, naturalExample: current.en, score: 2 }]);
    } finally {
      setJudging(false);
    }
  };

  // 3段階のヒントをまとめて1回のAPI呼び出しで生成し、ローカル側で1段階ずつ表示していく
  // (APIを段階ごとに呼び直すのではなく、生成済みのものを順番に見せる方式でコストを抑える)
  const fetchHints = async () => {
    if (hints !== null) {
      // 取得済み(空配列=ヒント不要、の場合も含む)。段階を進めるだけ
      setHintLevel((n) => Math.min(3, n + 1));
      return;
    }
    setHintLoading(true);
    setHintFailed(false);
    try {
      const prompt =
        `あなたは、仕事で外国語を使うプロ向けの語学学習アプリのヒント役です。ユーザーは日本語の意味は理解しており、教育的な誘導は不要です。\n` +
        `目的は「知らないことを教える」のではなく、「知っているが今思い出せない単語・表現を短く思い出させる」ことです。\n` +
        `次の日本語の文章を${langOf(lockedLang).label}で言うための、最大3段階の短いヒントを作ってください。\n\n` +
        `重要: 役に立つヒントを、答えを漏らさずに作れる場合だけヒントを出してください。次のような場合は、無理にヒントを作らず、空配列(hints: [])を返してください。\n` +
        `・「Hi.」「Hello.」「Thanks.」のようにもともと短くシンプルな表現で、そもそもヒントが不要な場合\n` +
        `・ヒントを書くこと自体で、正解の言い回しがほぼそのまま特定できてしまう場合(例:「調子はどう？」は定型的な言い方("How are you doing?"等)しかなく、ヒントを作ると答えを言っているのとほぼ同じになってしまう)\n\n` +
        `ヒントを出す場合の厳守事項:\n` +
        `・各ヒントは短く具体的にしてください。長い説明・誘導質問・抽象的な文法解説は禁止です。\n` +
        `・完成した正解の文章はそのまま出力しないでください。\n` +
        `・1段階目: 重要な単語・表現を1つだけ「日本語 = ${langOf(lockedLang).tag}表現」の形で提示してください(質問形式にはしない)。\n` +
        `・2段階目: もう1つ必要な単語・表現を1つだけ、同じ形で提示してください。\n` +
        `・3段階目: 「~」を使った短い文型・骨組みだけを提示してください(完成文そのものにはしない)。\n` +
        `・問題が簡単で3段階も不要な場合は、2段階以下でも構いません。無理に3つ作らないでください。\n\n` +
        `文体の参考例(そのまま使わず、実際の問題に合わせて作ってください):\n` +
        `日本語「この薬を1日2回塗ってください」→ ["塗る = apply", "1日2回 = twice a day", "Apply ~ twice a day."]\n` +
        `日本語「2週間後にもう一度来てください」→ ["2週間後 = in two weeks", "もう一度 = again", "come ~ again"]\n\n` +
        `日本語: ${current.ja}\n\n` +
        `次のJSON形式のみを出力してください(説明不要)。\n` +
        `{"hints":["1段階目","2段階目","3段階目(不要なら省略可)"]} (ヒントが不要と判断した場合は {"hints":[]} を返してください)`;
      const out = await callClaude(prompt);
      const cleaned = out.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed.hints) ? parsed.hints.slice(0, 3) : [];
      setHints(list);
      setHintLevel(list.length > 0 ? 1 : 0);
    } catch (e) {
      setHintFailed(true);
    } finally {
      setHintLoading(false);
    }
  };

  const toggleMic = () => {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const r = getRecognition(langOf(lockedLang).speech);
    if (!r) {
      setError("音声入力に対応していません。下のテキスト入力をご利用ください。");
      return;
    }
    r.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      setAnswer(text);
      judge(text);
    };
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("音声入力を開始できませんでした。テキスト入力をご利用ください。");
    };
    try {
      recogRef.current = r;
      setListening(true);
      r.start();
    } catch (e) {
      setListening(false);
      setError("音声入力を開始できませんでした。テキスト入力をご利用ください。");
    }
  };

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(lockedLang).speech;
    window.speechSynthesis.speak(u);
  };

  const next = () => {
    setHints(null);
    setHintLevel(0);
    setHintFailed(false);
    if (index + 1 >= deck.length) {
      setShowSummary(true);
      return;
    }
    setIndex((i) => i + 1);
    setJudged(null);
    setAnswer("");
    setError("");
    questionShownAtRef.current = Date.now(); // 次の問題の表示開始時刻を記録(トレーニング時間の計測用)
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onFinish} className="text-xs text-slate-400 min-h-[36px] px-1">中断して元の画面に戻る</button>
        <p className="text-xs text-slate-400">{index + 1} / {deck.length} 問</p>
      </div>
      <div className="border border-slate-200 rounded-2xl p-5 bg-slate-50 text-center">
        <p className="text-[11px] text-slate-400 mb-1">この日本語を{langOf(lockedLang).tag}で言ってください</p>
        <p className="text-lg font-semibold text-slate-900">{current.ja}</p>
      </div>

      {!judged ? (
        <div className="space-y-2">
          <button onClick={toggleMic} className={`w-full min-h-[56px] rounded-xl text-sm font-semibold border-2 ${listening ? "bg-red-50 border-red-300 text-red-600" : "bg-teal-700 border-teal-700 text-white"}`}>
            {listening ? "🎤 聞き取り中…" : "🎤 話す"}
          </button>
          <div className="flex gap-2">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="またはここにテキスト入力" className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            <button onClick={() => answer.trim() && judge(answer)} disabled={!answer.trim() || judging} className="min-h-[44px] px-4 bg-slate-700 text-white rounded-lg text-sm disabled:opacity-50">
              {judging ? "判定中…" : "判定"}
            </button>
          </div>
          {error && <p className="text-red-600 text-xs">{error}</p>}

          {hintFailed ? (
            <div className="space-y-1">
              <p className="text-xs text-red-600">ヒントの取得に失敗しました。</p>
              <button onClick={fetchHints} disabled={hintLoading} className="w-full min-h-[40px] text-xs text-teal-700 border border-teal-200 rounded-lg bg-teal-50 disabled:opacity-50">
                {hintLoading ? "ヒントを考えています…" : "もう一度試す"}
              </button>
            </div>
          ) : hints === null ? (
            <button onClick={fetchHints} disabled={hintLoading} className="w-full min-h-[40px] text-xs text-teal-700 border border-teal-200 rounded-lg bg-teal-50 disabled:opacity-50">
              {hintLoading ? "ヒントを考えています…" : "💡 ヒントを見る"}
            </button>
          ) : hints.length === 0 ? (
            <p className="text-xs text-slate-500 border border-slate-200 rounded-lg p-3 bg-slate-50">この問題はヒントを出すと答えがほぼ分かってしまうため、ヒントはありません。</p>
          ) : (
            <div className="border border-teal-100 bg-teal-50 rounded-lg p-3 space-y-1.5">
              {hints.slice(0, hintLevel).map((h, i) => (
                <p key={i} className="text-xs text-slate-700">
                  <span className="text-teal-600 font-semibold">ヒント{i + 1}: </span>
                  {h}
                </p>
              ))}
              {hintLevel < 3 && hintLevel < hints.length && (
                <button onClick={fetchHints} disabled={hintLoading} className="w-full min-h-[36px] text-xs text-teal-700 border border-teal-300 rounded-lg bg-white mt-1 disabled:opacity-50">
                  次のヒント({hintLevel}/3)
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* 獲得数表示:一目でわかる大きな表示 */}
          <div className="text-center rounded-2xl py-4 bg-amber-50">
            <div className="flex items-center justify-center gap-1">
              {[1, 2, 3].map((n) => (
                <span key={n} style={{ fontSize: "36px" }} className={n <= judged.score ? "opacity-100" : "opacity-25"}>💎</span>
              ))}
            </div>
            {judged.feedbackText && <p className="text-sm text-slate-700 mt-2 px-4">{judged.feedbackText}</p>}
          </div>

          {/* 正解例・より自然な表現 + 🔊お手本再生(主要アクションとして大きめ) */}
          <div className="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
            <p className="text-xs text-slate-500">{judged.score === 3 ? "他の自然な表現の例" : "正解例"}</p>
            <p className="text-sm text-slate-800">{judged.naturalExample}</p>
            {lockedLang === "cn" && judged.naturalExamplePinyin && <p className="text-sm text-teal-600">{judged.naturalExamplePinyin}</p>}
            <button onClick={() => speak(judged.naturalExample)} className="w-full min-h-[56px] bg-teal-700 text-white rounded-xl text-base font-semibold">
              🔊 正解例を聞く
            </button>
          </div>

          <button onClick={next} className="w-full min-h-[52px] bg-slate-800 text-white rounded-xl text-sm font-semibold">
            {index + 1 >= deck.length ? "完了!今日の復習を見る" : "次の問題へ"}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ロールプレイ機能
// 仕様: roleplay-spec-v4.md + その後の追加決定事項(往復数の3段階終了・ユーザー優先原則・
// 所見/検査結果ボタンの動的無効化)に準拠。
//
// 実装メモ(仕様書のまま反映しきれなかった部分・今回選んだデフォルト):
// ・「アプリを閉じても再開できる」が仕様上の要求だが、アプリ全体に永続化の仕組みが無いため、
//   今回は「同じセッション内(タブ・画面を移動しても)は再開できる」形で実装した。
//   実機化の際、window.storage等の永続化層に載せ替えることで閉じても再開できるようにする想定。
// ・12往復は仕様通りの技術的安全弁だったが、意図的に目標表現を言わず引き延ばした場合の
//   API呼び出し回数・添削生成量を抑えるため、AI側の目安を10往復・クライアント側の安全弁を
//   11往復に短縮した(2026年時点の最新値。当初の12/13→14→13という変遷を経て現在に至る)。
// ・目標表現がすでに達成済みかどうか(achievedEver)をAI側にも伝え、達成済みなら早めに、
//   未達成なら8〜10往復を目安に、終了へ向かう強さを調整する(既存のachievedEverをそのまま利用)。
// ・5分復習への優先表示は、目標表現が"success"以外だった場合にweakExpressionIdsへ追加し、
//   次回"success"になったら解除する、という一番シンプルな形にした(解除タイミングは仕様上保留だったための実装判断)。
// ・添削カードの保存は既存のcheckSimilarBeforeSave/classifyAndSaveをそのまま再利用している。
// ============================================================
//
// 【今後の検討事項メモ(2026年8月時点の実機確認より。今回はロールプレイ本体を大きく変更せず、
//   原因確認・方針整理のみ行った。次回ロールプレイに着手する際にまずこれを読むこと)】
//
// A. 5分復習(ReviewScreen)側 — 判定ロジック自体は今回「維持」の方針。以下は現状のまま。
//   ・保存文と完全一致しなくても、日本語の意味に対して自然・適切であれば正解として扱う現在の
//     judge()の判定方針(医療・皮膚科などの文脈に依存させない)は、今回変更しないことを確認した。
//   ・上記を変更する必要が生じた場合も、judge()のプロンプト自体は大きく作り直さず、
//     採点基準の文言だけを調整する方向を優先すること。
//
// B. 5分復習 — ヒントが答えを漏らす問題(今後修正)
//   ・短い保存文(例:「調子はどう？」→ How are you doing?)の場合、既存のヒント生成が
//     正解の言い回しそのものに近い内容を出してしまうことがある。
//   ・対応方針(未着手): ヒント生成プロンプトに「意味・方向性は示すが、正解となる言い回し
//     そのものは含めない(例:「相手の最近の状態や気分を尋ねる表現」程度に留める)」という
//     制約を明示的に追加する。既存のヒント取得(1回のAPI呼び出しでまとめて取得する仕組み)は
//     そのまま使い、プロンプト文言の調整で対応できる見込み。
//
// C. 5分復習 — まとめ画面で「保存文と実際の回答の違い」を示す(今後検討)
//   ・現在の判定(意味が合っていれば正解)は変えない前提で、「正解になったが保存文とは
//     表現が違った」ことをまとめ画面でユーザーが確認できるようにしたい、という要望がある。
//   ・想定される役割分担: 5分復習=自然に使えれば正解/まとめ画面=保存文との違いに気づける/
//     高速検索=登録表現そのものを確認、という3画面の役割分担。
//   ・実装未着手。judge()が返すnaturalExample(登録訳文に引きずられない自然な例文)と、
//     ユーザーの実際の回答・登録されている訳文(current.en)の3つをまとめ画面でどう見せるかの
//     UI設計が必要になる見込み(新しい判定ロジックの追加は不要なはず)。
//
// D. ロールプレイ — 英語ロールプレイで日本語入力が通ってしまう問題(原因を確認、未修正)
//   ・実機確認: 日本語→通ってしまう / 中国語→拒否 / ピンインのみ("nihao")→拒否 /
//     でたらめな文字列("ghyt")→拒否 / でたらめな仮名列("なやまたあ")→拒否。
//     つまり「文法的に自然な日本語」だけが誤って通っている。
//   ・getRoleplayTurn内のlang別プロンプトを確認したところ、"cn"側は「日本語(漢字が共通して
//     いても…)・英語・韓国語など」と対象外言語の具体例を明示し、さらに「你怎么了？」のような
//     具体例まで示す形で複数箇所から補強されているのに対し、"en"側は「英語での発言のみを
//     『話せている』とみなしてください」という1文のみで、日本語を名指しで対象外とする具体例が
//     一切無い。両方に共通する後続の一般化ルール(「対象外の判定は例示した言語に限定されず…」)
//     はあるが、これは"en"側では唯一の頼みの綱になっており、"cn"側のような多重の補強が無い。
//   ・この非対称性(en側の指示が相対的に弱い)が原因である可能性が高いと考えられるが、
//     LLMの都度の判断であり、静的なコードの読み合わせだけで断定はできていない。
//   ・クライアント側の安全弁(inTargetLanguage=falseならtargetAchievedを強制falseにする)は
//     en/cn共通で正しく実装されていることは確認済み。問題があるとすればAI自身の
//     inTargetLanguage判定そのもの(プロンプト起因)であり、クライアント側のロジックではない。
//   ・対応方針(未着手・要検討): "en"側にも"cn"側と同程度の具体例(例:自然な日本語の一文を
//     名指しで「対象外として扱う」例)を追加できないか検討する。ただし言語判定ブロックの
//     肥大化を避けたいという以前からの方針(プロンプトの簡略化)とのバランスを取る必要がある。
//
// E. ロールプレイ — 「目標とは違うが英文としては正しい」場合の解説(今後修正)
//   ・例: 目標「かゆみはありますか？」に対しユーザーが「Do you have redness?」と発言。
//     目標とは意味が異なる(かゆみでなく赤みを聞いている)ため未達成、という判定自体は正しい。
//   ・ただし現在のanalyzeRoleplaySessionの解説は「rednessは目標表現と異なります」という
//     指摘に寄りがちで、「Do you have redness?自体は自然で正しい英語である」という点が
//     伝わりにくい。ユーザーが「自分の英語自体が間違っていた」と誤解する可能性がある。
//   ・対応方針(未着手): 「①目標を達成できたか」「②ユーザーの発言自体が言語として自然か」
//     「③目標とユーザー発言の意味がどう違うか」を分けて解説する方向。analyzeRoleplaySessionの
//     turnResults生成プロンプトに、この3点を区別して述べるよう指示を追加する形が
//     想定されるが、プロンプトの複雑化につながるため、次回改めて設計してから着手すること。
//
// 上記A〜Eのいずれも、今回はプロンプト・判定ロジックの変更を行っていない(現状維持)。
// ============================================================

async function generateRoleplayCase(targetExpr, siblingExpressions, lang, roleplayProfile) {
  const siblingsText = siblingExpressions.length
    ? siblingExpressions.map((e) => `- ${e.ja}`).join("\n")
    : "(他にはありません)";
  // 例文を言語ごとに用意する(英語の例文をそのまま中国語ロールプレイの基準にしないため)
  const greetingExample = lang === "cn" ? "「你好。」「您好。」など" : "\"Hi.\" \"Good morning.\" など";
  const defaultOpeningLine = lang === "cn" ? "你好。" : "Hi.";
  const pinyinField = lang === "cn" ? `"openingLinePinyin":"患者の最初の一言のピンイン"` : "";
  // 日本の外用ステロイドの強さ分類(日本皮膚科学会アトピー性皮膚炎診療ガイドライン等に基づく5段階)に沿った表現を使う。
  // 英国式4段階(mild/moderate/potent/very potent)や米国式7段階とは体系が異なり、日本の実臨床とズレるため使わない。
  // この表記が必要なのはロールプレイ開始前の日本語ケースカード(患者背景・所見)のみで、会話本文には使わない。
  const potencyGuide = "weak(ウィーク) / medium(ミディアム) / strong(ストロング) / very strong(ベリーストロング) / strongest(ストロンゲスト)の5段階(日本の外用ステロイドの強さ分類)";
  // ロールプレイ設定(職種・職業・使う場面)は自由入力。固定の選択肢・カテゴリ分けは行わず、
  // ここでの解釈・妥当性判断・役割名の決定はすべてこの1回のAPI呼び出しの中でAIに一任する。
  const profileText =
    roleplayProfile && (roleplayProfile.occupationCategory || roleplayProfile.occupation || roleplayProfile.sceneNote || roleplayProfile.customizationNote)
      ? `職種：${roleplayProfile.occupationCategory || "(未入力)"}\n` +
        `職業・具体的な役割：${roleplayProfile.occupation || "(未入力)"}\n` +
        `ユーザーが入力した「使う場面・希望」：${roleplayProfile.sceneNote || "(特に指定なし)"}` +
        (roleplayProfile.customizationNote
          ? `\nユーザーが入力した「こだわり条件」(目標表現そのものではなく、今回のシナリオに追加で反映してほしい条件)：${roleplayProfile.customizationNote}`
          : "")
      : `職種：${APP_CONTEXT.domainLabel}\nユーザーが入力した「使う場面・希望」：(特に指定なし)`;
  const prompt =
    `あなたは外国語ロールプレイ練習アプリのケース設計者です。ユーザーは以下の設定でロールプレイの練習をしたいと考えています。\n\n` +
    `${profileText}\n\n` +
    `ユーザーは次の日本語の一文を、${langOf(lang).label}での会話の中で自然に言えるようになりたいと思っています。\n\n` +
    `目標表現(日本語): ${targetExpr.ja}\n目標表現(${langOf(lang).tag}): ${targetExpr.en}\n\n` +
    `同じフォルダ内の他の表現(会話の材料として使ってよいが、必ず使わせる必要はない):\n${siblingsText}\n\n` +
    `まず、指定された職種・役割・場面をそのまま維持したうえで、その職種・役割・場面において、この人物が相手と接する本来の業務上の目的・会話の中心が何かを判断し、それに沿った自然な業務シナリオを思い描いてください(これは職種ごとの固定ルールではなく、入力内容から素直に判断する一般原則です)。以下の内容を順に決めてください。\n` +
    `次に、上記の設定(職種・職業)から、この会話における「ユーザー自身の役割の呼び方」(selfRole、例:医師、設計士、施術者)と「会話相手の役割の呼び方」(counterpartRole、例:患者、施主、顧客)を、設定に自然に合う言葉で決めてください。特定の職種の呼び方を機械的に当てはめるのではなく、入力内容から素直に自然な呼称を判断してください。ユーザーが入力した「使う場面・希望」の中で、実際に会話する相手が具体的に指定されている場合(例:「外国人クライアントと話したい」「外国人患者と退院説明をする」)は、それを最優先してcounterpartRoleを決めてください。その場面に他の人物(上司・同僚・家族など)が存在する設定であっても、その人物を会話相手として演じ分ける必要はなく、必要であれば6のhistoryContext等の背景情報として扱ってください。ただし、目標表現の内容自体が、患者・顧客等ではなく、その他の相手(例:医師、上司、同僚、他部署の担当者など)に向けて話しかける一文である場合は、その相手をcounterpartRoleとして設定してください(例:看護師が医師に報告・相談する一言であれば、counterpartRoleは医師にする)。この場合、上記の「演じ分けなくてよい」という扱いは適用しません。目標表現中に「患者」「顧客」などの対象者・第三者を指す言葉が含まれていても、それは必ずしも話しかけている相手を意味しません。counterpartRoleは、目標表現に登場する単語の有無だけで判断せず、文全体の構造と発話の向きを確認し、実際に誰に向かって話しかけている一文なのかを判断してください(例:「この患者さん、今夜は絶食でお願いします」の「患者さん」は話題になっている第三者であり、話しかけている相手は看護師・スタッフ等です)。\n\n` +
    `情報の設計にあたっては、次の考え方に沿ってください。情報は、(a)場面が始まる前からすでに分かっている情報(事前資料・予約情報・年齢性別・カルテや申し送りなどの共有済み情報など。patientBriefに反映する)と、(b)質問する・観察する・測定する・資料や現物を確認するなど、何らかの確認行為をして初めて分かる情報(質問して分かるものはhistoryContext、観察・測定・資料確認などで分かるものはfindings・labResults、会話の中で新たに生じた確認事項はnewTestRequestedで動的に生成)に分けて設計してください。(a)を(b)の扱いにしたり、その逆にしたりしないでください。汎用化とは、あらゆる職種・場面に同じ一律の構造を当てはめることではなく、指定された職種・役割・場面に実際に自然な構造を選ぶことです。指定された職種・役割・場面に、すでに確立された自然な情報構造がある場合(例:医師×皮膚科外来における、初回/継続・主訴・前回の診断や治療内容といった構造)は、その構造を薄めたり抽象的な言い方に一般化したりせず、そのまま具体的に使ってください。ただし、ここで示しているのは情報の構成・内容の型(どのような種類の情報をどうまとめるか)であり、例として挙げた具体的な場面そのものに固定することを意味しません。今回の場面は、場面の指定があればその指定を優先し、指定が無ければ7で判断する「今回の場面」に従ってください。例に挙げた場面と、7で決めた「今回の場面」が異なる場合は、7で決めた「今回の場面」を優先し、その場面に合わせて同じ情報構造(初回/継続・主訴に相当する内容・経過など)を適用してください。一方で、そのような医療外来特有の型(初診・再診、主訴、診断、処方など)を持たない職種・場面に対しては、その型を無理に適用せず、指定された職種・役割・場面に自然な種類・内容を使ってください(例:メイクなら顔の特徴/実際に見て分かる細部、建築なら事前資料/現場確認、看護なら申し送り事項/観察内容、旅行なら予約情報/現地確認、接客・販売・飲食なら商品名・価格・注文内容)。いずれの情報も「入院中の患者への対応」のような抽象的な説明にとどめず、ユーザーがその職種・役割・場面で自然に行う質問・確認・観察・測定などに対して、相手AIが具体的な情報を返せる程度の材料を用意してください(「どうぞ」「わかりました」とだけ返して具体的な情報が出ない構成は避けてください)。また、目標表現そのものだけでなく、その場面でユーザーが目標表現の前後に自然に行う仕事上の行動(例:会計金額を伝える、検査結果を伝える、予約内容を確認するなど)に必要な具体的な事実も、その場面で当然存在しているといえる範囲で、必要に応じてpatientBriefに補ってください(毎回必ず用意する必要はなく、その場面で自然に必要になる場合に限ります)。この材料は、会話相手が口頭で答えられる情報だけに頼るのではなく、指定された職種・役割がその場面で実際にアクセスできる情報源(例:カルテ・記録・申し送り・既存の検査結果・観察や測定の結果など)も踏まえて用意してください。指定された職種にとって、本来その情報にアクセスできないはずの相手からしか情報を得られず、それでしか会話を成立させられない場合(例:新しく入院してきた患者の入院理由・診断を、記録等を参照する想定を作らずに患者本人へすべて語らせることでしか用意できない場合)は、無理に成立させないでください。これは所見や検査結果を必ず生成しなければならないという意味ではなく、指定された職種・役割において実際に存在する情報源と行動から、自然に会話を続けられるかどうかを判断するための基準です。\n\n` +
    `以下を順に決めてください。\n` +
    `1. まず、指定された職種・役割・場面にとって、この場面が相手との最初のやり取りか、すでに何度かやり取りしている継続的な場面か(visitType)を、その業務・関係性として自然な方に決めてください。目標表現の性質は、この判断が目標表現と矛盾していないかを確認する材料として使ってください(例:経過・状況を尋ねる表現は継続的な場面が自然、用件をゼロから確認する表現は最初のやり取りが自然、など。目標表現ごとに機械的に固定せず、その都度自然な方を選ぶこと)。目標表現が「結果は〜でした」のような結果説明型の一文である場合は、その確認・検査等がすでに済んでいて結果を聞きに来た継続的な場面にすること(その行為自体をこのロールプレイ内で改めて行う必要はない)。目標表現が「また来てください」のような、相手が一度離れてまた戻ってくることを前提とした一文である場合、最初のやり取りのまとめとして伝える場合・継続的な場面での経過確認として伝える場合のどちらもあり得るので、必ず継続的な場面に固定する必要はなく、その都度自然な方を選ぶこと。ただし、相手が一度離れてまた戻ってくる、という構造そのものが指定された職種・場面に存在しない場合(例:入院中の患者に日常的に対応する病棟看護師など)は、この例を無理に当てはめないでください\n` +
    `2. 会話相手側に前提として自然に存在する事情(体調・状況・経緯・背景など)を組み立ててください。判断の基準は、その前提が指定された職種・役割・場面において自然に成立しているといえるかどうかです。目標表現の内容と矛盾しない、むしろ必然的にその話題になるような前提であれば、自然な前提である可能性が高いといえます(例:「血糖コントロールはできていますか？」のような表現なら、糖尿病で治療中という設定にする、といった具合です)。一方で、目標表現を成立させる理由付けとしてしか思いつかない前提は、後付けの可能性が高いと考えてください。この前提は、目標表現を言える状況を作ることだけを目的にせず、指定された職種・役割・場面において、この人物が今まさにこの相手と話していることが自然に成立しており、その場面から自然に数ターン程度会話が続けられるだけの、具体的な事情・話題・関心・気がかりなどがある状態を目指してください(困りごとや目的を必ず設定するという意味ではなく、その職種・場面に自然な会話の種があるかどうかという一般原則です。特定の職種ごとにどんな話題にするかを固定するものでもありません)。この会話の種は、相手から質問されれば答えられる情報だけでなく、相手が自然に拾って反応できる話題として存在することが重要です。目標表現は、この会話の流れの中で自然に登場する一部として位置づけ、目標表現を成立させるためだけに前提事情を後付けで作らないでください。あわせて、目標表現が、指定された役割の人物自身の判断・決定・提案として自然に言える内容か、それとも他者(上位の担当者・別の専門職・すでにある記録や予定など)がすでに決めた内容を伝達・確認する発言として自然に言える内容かも考えてください。前者であれば、その結論をあらかじめケース情報に答えとして書き込む必要はありません(発言者が今その場で決めればよい内容です)。後者であれば、その決定済みの事実が自然に存在しているかを確認し、存在しているならその内容を一貫して保持してください(伝達型だからといって新しい事実を無理に作る、という意味ではありません)。自然に成立する前提がある場合は、その内容を今後の会話でも一貫して使えるよう具体的に決めてください(これは自由に内容を創作してよいという意味ではなく、すでに自然に成立している前提を、以降のケース情報の中で一貫して扱うための手段です)。自然な前提や会話の種を用意できない場合、または目標表現がどちらの形(本人の判断・提案/他者の決定の伝達)にも自然に当てはまらない場合は、無理に具体化しないでください。これは特定の疾患・医療に限った話ではなく、指定された職種・場面においても同じ考え方を一般原則として適用すること。情報量を増やすこと自体が目的ではなく、指定された場面で自然に存在する範囲にとどめてください。\n` +
    `3. 会話相手の年齢・性別を決める(2で必要と判断した前提があれば、以降の内容に反映すること)。未成年(18歳未満)の場合、4のpatientBriefでは年齢相応の自然な言い方(男児/女児など)を使い、成人の場合は男性/女性という言い方を使うこと\n` +
    `4. これまでに決めた内容(年齢・性別・visitType・7で決めた場面・開始地点・2で決めた前提事情など)をもとに、この場面が始まる前からすでに分かっている情報を、指定された職種・役割・場面に自然な情報構造でpatientBriefにまとめてください。patientBriefは1つのフィールドですが、1文に圧縮する必要はありません。必要に応じて複数の文・適度な改行を使い、読みやすく整理してください。情報量が少ない場合でも、複数の情報を1文に詰め込んで読みにくくならないよう、内容に応じて自然に文を分けるなど、読みやすさに配慮してください。情報の見出し・項目名(使う場合)も、指定された職種・役割・場面に自然なものをあなた自身で判断してください(「主訴」等を必ず使う、といった固定ルールはありません)。ここで新しい事実を新たに作り出さず、すでに決めた内容・そのシナリオに実際に存在する情報だけを含めてください。医師×皮膚科外来のような場面では、主訴・経過・前回の診断や処方など、その場面で自然な情報をまとめてください。これは情報構造の例であり、例に挙げた場面(皮膚科外来)を今回の場面として固定することを意味しません。7で決めた「今回の場面」がこの例と異なる場合(例:入院中・病棟対応など)は、その場面に合わせて同じ情報構造(経過・前回の対応内容など)を適用してください。他の職種・場面では、その職種・役割・場面に自然な情報のまとまり方をあなた自身で判断してください(職種ごとの固定の型・見出し一覧を機械的に当てはめる必要はありません)。場面が始まる前からすでに分かっているバイタル・測定値などがあれば、これも含めてください(該当しない場合の方が多いので無理に作らないこと)。継続的な場面でない場合は、前回の情報には触れないでください。今回の目標表現によってこれから会話の中で決まるはずの情報(次回の予定、今回の確認結果など)は含めないこと。薬剤が話題になる場合は、商品名(ブランド名)ではなく「種類＋強さ」で表現し、強さは${potencyGuide}の言い方をそのまま使うこと(例:「ステロイド外用薬(strong)」)。長い記録のように書かず、必要最小限の分量にしてください\n` +
    `patientBriefには含めない、指定された職種・役割・場面から自然に成立する背景も、内部的な想定(underlyingCondition)として保持しておいてください。これは、会話の中でユーザーが具体的に何かを尋ねたり確認したりした場合に、その場で矛盾のない自然な詳細を答えられるようにするための土台であり、patientBriefにすべてを書き出す必要はありません。ただしこれは、指定された職種・場面において自然に成立している前提を一貫して保持するためのものであり、目標表現を成立させるためだけに、後から都合のよい事実を作り出すことはしないでください。ただし、これは目標表現の内容そのものが指し示す具体的な事実(例:会計金額、注文内容の詳細)まで避けるという意味ではありません。目標表現を言う理由・前提事情を不自然に後付けすることと、目標表現の内容自体を成立させるために当然存在するはずの具体的な事実を補うことは別であり、後者は必要に応じて具体的に設定してください。指定された職種・役割・場面ですでに存在するはずの記録・資料・管理情報の中身を、ここに網羅的に作り込む必要もありません。2で考えた発言の性質もここに反映してください。目標表現が、指定された役割の人物自身の判断・決定・提案として自然に言える内容である場合は、その結論を先回りして答えとして書き込む必要はありません(発言者がその場で決めればよい内容だからです)。一方、目標表現が、他者の決定や既存の記録・予定などを伝達・確認する発言として自然に言える内容であり、かつその事実が指定された職種・役割・場面において自然に存在しているといえる場合は、その内容を必要な範囲で一貫して保持してください。ただし、これは目標表現を成立させるための後付けの事実を作ってよいという意味ではありません。7で決めた「今回の場面」(場面の指定がある場合はその指定を優先し、指定が無い場合は目標表現から最も自然に成立すると判断した業務場面)は、patientBrief・historyContext・underlyingCondition・openingLineなど、このシナリオを構成するすべての要素に共通する前提として扱ってください。会話相手の経歴・背景として設定した事前の情報(例:通院中である、など)は、その人物の背景として尊重しつつも、それだけを理由に7で決めた「今回の場面」を別の場面に読み替えたり、そちらへ場面ごと固定し直したりしないでください。特にopeningLineで動作・情景(ト書き)を加える場合も、7で決めた「今回の場面」と矛盾する情景を独自に追加しないでください(例:医療なら入院中と外来受診のように、接客・訪問系なら店内対応と訪問対応のように、別々の場面を指してしまわないよう注意してください)。\n` +
    `5. 今回の場面の状況・経過には、良い方向のバリエーションだけでなく、様々なバリエーションも積極的に持たせること(例:医療ならほぼ変わらない/悪化している/薬の効果が不十分/別の困りごとがある、看護・面談系なら状況が変わっていない/新しい懸念が出てきた、施術系なら前回と印象が変わった/新たな要望がある、など)。同じ目標表現を何度選んでも毎回同じような「順調」な状況にならないよう、ケースごとに自然に変化させること。ただし所見・状況説明自体に対応の答えを直接書き込みすぎず、ユーザー(操作者)側が所見を見て自分で対応方針(治療方針・提案内容など)を考える余地を残すこと\n` +
    `重要: この5で決める状況・経過は、目標表現がその流れの中で自然に必要とされるように設計してください。目標表現を言う「理由」がその場面に存在しない設定にしないでください(例:目標表現が検査の実施を伝える一文なのに、すでに診断・対応方針が確定していて検査の必要性が薄い経過にする、といったことは避ける。この場合は、確認のために検査が必要になる経過にする、または検査が自然な最初のやり取りにするなど、目標表現を言う必然性がある設定にすること)。\n` +
    `6. 2で組み立てた前提事情や、この職種・役割・場面で自然に想定される状況・懸念事項(医療なら治療歴・服薬・既往歴・アレルギー・生活歴など)をもとに、ユーザーが質問した場合に会話相手が答えられる背景情報を用意してください(historyContext)。目標表現を自然に導くために直接関係する項目があれば、優先的に含めてください。これはユーザーに事前表示する情報ではなく、会話の中でユーザーが尋ねたときに会話相手が一貫して答えられるようにするための土台です。この目標表現に直接関係する1〜2項目だけを選び、1〜2文程度の簡潔な文で書いてください(長い記録のように網羅的に書かないこと)。会話相手本人の経験だけでなく、家族や他の担当者から聞いた話など、会話相手が伝え聞いている情報もここに含めてよい。\n` +
    `7. まず、今回のselfRoleが、指定された職種・役割・場面の中でどのような状況に置かれ、何をしようとしているかを中心に考えてください。selfRole自身がその業務を主体的に進めている場合は、これまで通り、その仕事の一連の流れ(例:医療なら問診→診察→検査→結果説明→治療説明→処置→処置後説明→再診、施術系なら受付→カウンセリング→施術→仕上げ、など)を思い描いてください。一方、selfRoleがその職種の人であっても、この場面ではcounterpartRole側から説明・サービス・情報提供などを受ける立場に置かれている場合は、その職種全体の典型的な業務フローをそのままシナリオの土台にせず、selfRoleがこの場面で自然に置かれる状況を中心に流れを考えてください。そのうえで、目標表現がそのどのあたりで自然に出てくる表現かを確認し、開始地点を決めてください。毎回最初の場面(来院直後・受付直後など)から始める必要はありません。「受付直後」「新規入院直後」「移送直後」「初回接触」などを開始地点として選ぶこと自体は問題ありません。目標表現が流れの終盤にある表現(例:「2週間後に来てください」「このクリームをつけて帰られますか」)である場合でも、それだけを理由に前工程を一律に完了済み扱いにしたり、指定された職種・役割・場面の自然な流れを崩したりしないでください。指定された職種・役割・場面の中で、その表現が自然に出てくる具体的な場面(例:皮膚科外来の医師が、診察の中でその表現を使う場面)を作ってください。前工程(問診・診察・施術など)を改めて詳しく再現する必要はありませんが、指定された職種・役割・場面としての具体性は保ってください。目標表現が流れの序盤〜中盤にある表現であれば、そこに至るまでに自然に必要な最小限のやり取りだけを想定してください。目標表現を自然に言うために必要な情報は6のhistoryContextや8・9の所見・検査結果として確保し、それより前の工程を会話でなぞり直す必要はありません。これは特定の職種に限った話ではなく、目標表現がその仕事の流れのどこに位置するかで判断する一般原則です。ユーザーが「使う場面・希望」を入力している場合は、それを中心にしつつ、この一連の流れ全体の範囲内で自然に構成してください(希望された場面だけにガチガチに固定する必要はなく、多少の余白を持たせて構いません)。指定された場面が明示されている場合、目標表現の言い回し(例:結果報告・経過確認でよく使われる言い方)から場面自体を別の設定(例:通院・外来受診・定期受診・再診など)に読み替えないでください。継続的な場面・結果の説明・経過の確認などは、指定された場面の中で自然に成立する形(例:病棟が指定されているなら入院中の回診・病室での診察など)で構成し、指定と異なる前提を新たに作り出さないでください。場面の希望に処置に関する内容が含まれる場合も、「処置」を特別な区分として扱う必要はなく、処置の具体的な手技・動作を細かく再現する必要もありません。処置が行われている/行われた前提で、その最中に自然に交わされる声かけ・説明・確認などの会話を中心に構成してください。場面の希望が無い場合も、目標表現の言い回しの表面的な連想だけで場面を決めるのではなく、指定された職種・役割が実際に業務を行いうる具体的な設定の中から、目標表現が最も自然に成立するものを選んでください\n` +
    `8. その場面でユーザーが対象を観察・確認したときに見せる、最低限の所見の内容を日本語で作る(不要なケースなら空文字にする)。薬剤に触れる場合は4の表現ルールに従うこと。所見(findings)には、視覚・触覚・聴覚・嗅覚・味覚・食感など、対象を直接観察・確認することで分かる、仕事上意味のある客観的な状態情報(例:見た目・色・形・大きさ・長さ、質感・硬さ・柔らかさ・乾燥・温度、聞こえる音、匂い、味・濃さ、食感など。写真・カタログ・資料・商品・書類など、その場面でユーザーが直接確認する外部資料がある場合も、現在の状態などと同じく1つの確認対象として扱い、そこから読み取れる仕事上意味のある具体的な内容を、現在の状態などと同程度の具体性で記録してください(「現在の状態」を主、外部資料の内容を付随的な扱いにはしないでください。ただし、場面開始前からすでに4のpatientBriefに含まれている既知情報は、それが予約情報などが書かれた資料・画面・書類として確認可能な形であっても、それだけを理由にfindingsへ重複して入れないでください。findingsにするのは、会話の中で新たに資料や現物を確認することで初めて分かる情報に限ってください))だけを書いてください。対象にその職種で自然な具体的な数値・状態(例:髪型・髪色・長さ、温度、味の濃さ、硬さ、寸法など)が存在する場合は、それを具体的に書いてください。一方で、医療のように「特に問題ありません」「明らかな異常はありません」のような総合的な所見が自然な場面では、これまで通りそうした所見も使ってよく、具体的な数値・状態と総合的な所見の両方を書いても構いません。ユーザー自身が実際に観察・確認して分かる情報に限定し、家族や他の担当者から伝え聞いた情報(それは6のhistoryContextで扱う)は含めないでください。機器・検査・測定によって得られる数値・結果はfindingsには書かず、場面開始前からすでに分かっているものは4のpatientBriefに、その場面で測定・検査して分かるものは9のlabResultsに書いてください。同じ情報をfindingsと他のフィールドに重複して書かないでください\n` +
    `9. その場面でユーザーが検査・測定結果を確認したときに見せる、最低限の結果の内容を日本語で作る(不要なケースなら空文字にする)。labResultsには、機器・検査・測定によって得られる具体的な結果だけを書いてください(例:医療なら血液検査・尿検査・画像検査、美容なら毛髪・肌の測定結果、飲食なら温度・重量の測定結果、整備なら空気圧・電圧・診断機の結果、製造なら寸法・重量・温度・圧力の測定結果など。場面開始前からすでに分かっている測定値は4のpatientBriefを参照)。8のfindingsに書く内容とも重複させないでください。8・9のどちらも、必要以上に細かい数値・所見を増やさず、ロールプレイに必要な程度の大まかな情報にとどめてください\n` +
    `10. 会話相手(counterpartRole)側の最初の一言(${langOf(lang).label})とその日本語訳を作る(医師×患者のような場面ではこれは患者の発言になりますが、会話相手が患者以外の場合は、その会話相手自身の発言にしてください)。動作・仕草(ト書き)を入れる場合は、必ず *腕を見せる* のようにアスタリスクで囲み、動作の説明自体もopeningLineの一部として${langOf(lang).label}で書いてください(動作部分だけ日本語のままにしないこと)。日本語訳側でも同じように *少しぎこちなく手を振る* のようにアスタリスクで囲んで訳してください(動作の訳を省略しないこと)\n\n` +
    `重要(生成順序と整合性): 「患者の第一声から所見を推測する」のではなく、「5・8で決めた診察状況・所見の内容を先に確定し、その内容に合わせて10の患者の第一声を作る」という順番にしてください。\n` +
    `患者の第一声が、"Hi." "Hello." "Good morning."のような、症状・経過について何も述べていない単なる挨拶の場合は、所見との整合性チェックの対象外です(挨拶だけなら所見の内容を気にせず自然に作ってよい)。目標表現が「調子はどうですか」「痛みはどうですか」「かゆみはありますか」「良くなりましたか」「副作用はありませんでしたか」など、患者の体調・症状について医師が尋ねる質問・確認型の表現である場合も、この挨拶と同じ扱いにしてください(この場合、患者の第一声で症状の方向性を先に述べさせないでください)。\n` +
    `一方、目標表現が上記のような質問・確認型ではなく、かつ患者の第一声が体調・症状について何か述べる内容を含む場合は、5・8で決めた診察状況の方向性(改善/悪化など)と同じ方向にしてください(例:所見が「悪化している」内容なら、患者の発言も「良くなった」ではなく「あまり良くなっていない/むしろ悪化した」等、同じ方向にする)。完全に同じ表現である必要はなく、患者が所見ほど正確に自覚できていない程度の軽いズレは自然な範囲として構いませんが、今回のような正反対の食い違い(所見は悪化、患者は「かなり良くなった」)は避けてください。\n\n` +
    `患者の最初の一言について厳守すること:\n` +
    `・ユーザーは、初診か再診か・年齢性別主訴・(再診なら)前回の経過を、すでにケースカードで読んで知っています。患者の第一声でこれらを重ねて説明しないでください(例:再診であることを改めて長く説明する、は不可)。\n` +
    `・7で決めた開始地点が来院・受付直後の場面である場合は、簡潔な挨拶程度に留めてください(例: ${greetingExample})。開始地点がすでに診察・施術などが進んだ場面(終盤)である場合は、その場面に合った自然な一言にしてください(例:施術が一通り終わった様子を伝える一言など)。\n` +
    `・目標表現が患者に何かを尋ねる質問・確認型の表現である場合(例:「調子はどうですか」「痛みはどうですか」「かゆみはありますか」「良くなりましたか」「副作用はありませんでしたか」など)、患者の第一声では、その質問によって初めて引き出されるはずの回答内容(体調が良い/悪い、痛み・かゆみの有無、副作用の有無など)を先に言わないでください。挨拶・再診に来たこと・時間が経過したこと・診察の準備ができている様子・身体的な動作など、質問される前でも自然に分かる情報だけに留めてください。\n` +
    `・目標表現の内容そのものは患者側から先に言わないでください。開始地点が来院直後の場面で、目標表現がユーザーの最初の発言になるはずの場合は、患者の一言は挨拶のみにし、目標表現が扱う話題(体調・症状・来院理由など)には一切触れないでください。開始地点が終盤の場面である場合も、その場面の状況を伝えるにとどめ、目標表現の内容(検査の提案・次回受診日・仕上げの声かけなど)自体は患者側からは言わないでください。\n\n` +
    `重要な方針:\n` +
    `・これは医学的な正誤を判定するクイズではなく、外国語での診療コミュニケーションの練習です。所見・検査結果は「クイズの正解」ではなく、会話の材料として設計してください。\n` +
    `・情報は詰め込みすぎず、最低限にしてください。\n` +
    `・所見(findings)には、患者の主観症状(かゆみの強さ・つらさなど、患者本人が感じている感覚)を含めないでください。所見は医師が診察して確認できる客観的な情報だけにしてください(例:発疹の分布・新出の皮疹・亀裂の有無など)。かゆみなどの自覚症状は、患者自身の発言(openingLine)や今後の会話の中で患者が語るものとして扱い、所見の文言としては書かないでください。\n` +
    `・患者の自覚症状(かゆみが良くなった等)と、医師が確認する客観的所見(発疹が広がっている等)が異なる方向を示すこと自体は自然な診察でよくあることです。矛盾として扱わず、両立する情報として設計してください。\n\n` +
    (lang === "cn" ? `・患者の最初の一言のピンインも作ってください(動作部分のピンインは不要です)。\n\n` : "") +
    `次のJSON形式のみを出力してください(説明・コードブロック記号は不要です)。\n` +
    `{"selfRole":"ユーザー自身の役割の呼び方(日本語、例:医師)","counterpartRole":"会話相手の役割の呼び方(日本語、例:患者)","visitType":"first"または"return","age":年齢の数字,"gender":"male"または"female","patientBrief":"この場面が始まる前からすでに分かっている情報をまとめた文章(日本語。年齢・性別・経緯などを含め、指定された職種・役割・場面に自然な一つの文章としてまとめる。新しい事実は作らず、すでに決めた内容だけを整理する)","findings":"客観的な所見のみ(日本語、主観情報は含めない、不要なら空文字)","labResults":"検査結果の内容(日本語、不要なら空文字)","historyContext":"質問された場合に会話相手が答える背景情報(日本語。目標表現に直接関係する1〜2項目だけを選び、1〜2文程度の簡潔な文で書く。網羅的な記録のように書かないこと。ユーザーには表示せず、会話相手役が一貫して答えるための土台としてのみ使う。不要なら空文字)","underlyingCondition":"内部的に想定する状況・背景の候補(日本語。ユーザーには表示しないが、会話中に新しい確認事項を求められた場合に結果を矛盾なく作るための土台として使う)","openingLine":"会話相手の最初の一言(${langOf(lang).label})","openingLineJa":"その日本語訳"${pinyinField ? "," + pinyinField : ""}}`;
  // 以前はcallClaudeの呼び出し自体(ネットワーク断・APIの一時的なエラー応答など)をtryの外に置いていたため、
  // callClaude自体が例外を投げた場合だけ、下のcatchで捕捉されずgenerateRoleplayCaseの外(呼び出し元の
  // RoleplayCaseScreen)まで素通りしてしまっていた(getRoleplayTurnで既に修正済みなのと同じ構造の問題)。
  // callClaude呼び出しをtryの内側に含め、JSON parse失敗時と同じフォールバックに揃える。
  try {
    const out = await callClaude(prompt, 700);
    const cleaned = out.replace(/```json|```/g, "").replace(/,\s*}/g, "}").trim();
    const parsed = JSON.parse(cleaned);
    const selfRole = parsed.selfRole || "医師";
    const counterpartRole = parsed.counterpartRole || "患者";
    const visitType = parsed.visitType === "return" ? "return" : "first";
    // patientBriefはAI(generateRoleplayCase)が直接生成する(すでに決定した年齢・性別・経緯等を、
    // 職種・役割・場面に自然な一つの文章としてまとめたもの)。JS側での組み立ては行わない
    const patientBrief = parsed.patientBrief || "";
    return {
      selfRole,
      counterpartRole,
      occupationLabel: (roleplayProfile && (roleplayProfile.occupation || roleplayProfile.occupationCategory)) || APP_CONTEXT.domainLabel,
      visitType,
      patientBrief,
      findings: parsed.findings || "",
      labResults: parsed.labResults || "",
      underlyingCondition: parsed.underlyingCondition || "", // ユーザーには非表示。診察中の追加検査の一貫性の土台にする
      historyContext: parsed.historyContext || "", // ユーザーには非表示。問診で尋ねられた際に患者が一貫して答えるための土台
      openingLine: parsed.openingLine || defaultOpeningLine,
      openingLineJa: parsed.openingLineJa || "",
      openingLinePinyin: lang === "cn" ? parsed.openingLinePinyin || "" : "",
    };
  } catch (e) {
    // 実機で「ロールプレイ作成失敗」が再発した場合、ここに実際の例外が出ているかどうかで、
    // 「callClaude自体の失敗(API呼び出し例外)」「JSON.parseの失敗(構文エラー)」
    // 「その他の生成処理中の失敗」のどれかを切り分けられるようにする(ユーザー向け表示は変更しない)。
    console.error("[generateRoleplayCase] failed:", e);
    return {
      selfRole: (roleplayProfile && (roleplayProfile.occupation || roleplayProfile.occupationCategory)) || APP_CONTEXT.domainLabel,
      counterpartRole: "お客様",
      occupationLabel: (roleplayProfile && (roleplayProfile.occupation || roleplayProfile.occupationCategory)) || APP_CONTEXT.domainLabel,
      visitType: "first",
      patientBrief: "",
      findings: "",
      labResults: "",
      underlyingCondition: "",
      historyContext: "",
      openingLine: defaultOpeningLine,
      openingLineJa: "",
      openingLinePinyin: "",
    };
  }
}

// generateRoleplayCaseは「シナリオを作る」ことに専念し、そのシナリオが成立しているかどうかの
// 自己判定は行わない(生成した本人が自分の生成物を甘く合格判定してしまう構造を避けるため)。
// この関数は、すでに完成したシナリオを受け取り、それを疑う第三者の審査員として、
// 新しい情報を作ったり成立させるための修正案を考えたりせず、成立しているかどうかだけを判定する。
async function checkScenarioValidity(scenario, targetExpr, roleplayProfile, lang) {
  const profileText =
    roleplayProfile && (roleplayProfile.occupationCategory || roleplayProfile.occupation || roleplayProfile.sceneNote)
      ? `職種：${roleplayProfile.occupationCategory || "(未入力)"}\n` +
        `職業・具体的な役割：${roleplayProfile.occupation || "(未入力)"}\n` +
        `ユーザーが入力した「使う場面・希望」：${roleplayProfile.sceneNote || "(特に指定なし)"}`
      : `職種：${APP_CONTEXT.domainLabel}\nユーザーが入力した「使う場面・希望」：(特に指定なし)`;
  const prompt =
    `あなたはロールプレイシナリオの妥当性を審査する第三者の審査員です。あなた自身がシナリオを作ったり、成立させるための修正案・言い換えを考えたりする役割ではありません。すでに完成した以下のシナリオが、指定された設定・目標表現の組み合わせとして本当に自然に成立しているかどうかだけを判定してください。\n\n` +
    `会話の言語: ${langOf(lang).label}(openingLineはこの言語で書かれている前提です。以下の他の項目が日本語で書かれているのは、日本語話者のユーザー向けの補足情報のためであり、会話そのものの言語とは関係ありません。openingLineが日本語ではないことを理由に不整合と判定しないでください)\n\n` +
    `指定された設定:\n${profileText}\n\n` +
    `目標表現(日本語): ${targetExpr.ja}\n\n` +
    `すでに生成されたシナリオ:\n` +
    `selfRole(ユーザー自身の役割): ${scenario.selfRole}\n` +
    `counterpartRole(会話相手の役割): ${scenario.counterpartRole}\n` +
    `visitType(最初のやり取りか継続的な場面か): ${scenario.visitType}\n` +
    `patientBrief(場面開始前から分かっている情報): ${scenario.patientBrief || "(なし)"}\n` +
    `historyContext(質問されたら答える背景情報。ユーザー非表示): ${scenario.historyContext || "(なし)"}\n` +
    `underlyingCondition(内部的な想定。ユーザー非表示): ${scenario.underlyingCondition || "(なし)"}\n` +
    `findings(所見): ${scenario.findings || "(なし)"}\n` +
    `labResults(検査結果): ${scenario.labResults || "(なし)"}\n` +
    `openingLine(会話相手の最初の一言): ${scenario.openingLine || "(なし)"}\n\n` +
    `次の基準で、このシナリオが自然に成立しているかを判定してください(新しい情報を作ったり、成立させるための修正・言い換えを提案したりしないでください。すでにある内容だけを見て、成立しているかどうかだけを判断してください)。\n` +
    `①指定された職種・役割・場面がそのまま維持されているか(selfRole・counterpartRoleが指定と一致し、場面が実質的に別のものへすり替えられていないか。例:病棟看護師の設定が外来受診の問診に置き換えられていないか)。\n` +
    `②目標表現が、指定された役割の人物自身の判断・決定・提案として自然に言える内容か、それとも他者(上位の担当者・別の専門職・すでにある記録や予定など)の決定や既存の事実を伝達・確認する発言として自然に言える内容かを確認してください。目標表現が、その役割の人物が主体的に判断・説明・確認・報告する責任の範囲を超えている場合(例:その職種の権限・専門外の判断を、まるで本人が決めてよいことであるかのように断定してしまっている場合)は成立していません。ただし、その役割自身の職務として自然に判断・説明・確認・報告できる内容であれば成立します(職種名だけで一律に不可とするものではありません)。他者の決定・既存事実を伝達・確認する発言として成立させる場合は、その裏付けとなる事実がpatientBrief・historyContext・underlyingConditionのいずれかに自然に存在しているかも確認してください。\n` +
    `③patientBrief・historyContextの内容が「まだ確認していない」「これから確認する」「詳細不明」といった記述だけで占められており、具体的な経緯・症状などの中身自体が書かれていない場合は、前提事情が実際には成立していないサインです。\n` +
    `④目標表現の言葉が拡大解釈・読み替えされていないか、後付けの理由付けで前提事情が成立させられていないかを確認してください。\n` +
    `⑤目標表現が単に会話のどこかに登場できるというだけでなく、このシナリオの流れの中で実際に自然に位置づいているかを確認してください。\n` +
    `⑥目標表現の言い回し自体が、ある状況・状態の変化や場面の転換点(例:一度その場を離れてまた戻ってくる、初めて顔を合わせる、一区切りがついて次の段階に移るなど)を前提として初めて自然に成立する場合、その前提となる状況がシナリオ内(patientBrief・historyContext・underlyingConditionなど)に実際に示されているかを確認してください。前提となる状況がシナリオ内のどこにも示されないまま、目標表現を成立させるために後付けで解釈している場合は、不整合として無効としてください。これは目標表現がそのような転換点を明確に前提とする場合にのみ適用する基準であり、専門職としての判断・説明が多少踏み込んで聞こえる程度で、明確な矛盾とまでは言えない表現まで、この基準を理由に無効にしないでください。\n` +
    `珍しい職業やマイナーな専門用語自体は無効の理由にしないでください。指定された職種・場面で通常は起こらない非典型的な場面を無理に成立させている場合は無効としてください。\n\n` +
    `次のJSON形式のみを出力してください(説明・コードブロック記号は不要です)。\n` +
    `{"validScenario":true または false,"invalidReason":"falseの場合の理由(日本語、簡潔に。trueの場合は空文字)"}`;
  try {
    const out = await callClaude(prompt, 200);
    const cleaned = out.replace(/```json|```/g, "").replace(/,\s*}/g, "}").trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.validScenario !== "boolean") {
      throw new Error("validScenarioが真偽値ではありません");
    }
    return {
      validScenario: parsed.validScenario,
      invalidReason: parsed.validScenario ? "" : parsed.invalidReason || "この設定では自然なロールプレイを作成できませんでした。",
    };
  } catch (e) {
    // 判定APIが失敗した場合、判定できていないのに成立扱い(fail-open)にはしない。
    // 判定不能はそのまま無効扱い(fail-closed)とする。
    console.error("[checkScenarioValidity] failed:", e);
    return {
      validScenario: false,
      invalidReason: "場面の確認中にエラーが発生しました。もう一度お試しください。",
    };
  }
}

async function getRoleplayConversationTurn(targetExpr, caseData, transcript, turnCount, lang, additionalTests = [], achievedEver = false) {
  const selfRole = caseData.selfRole || "医師";
  const counterpartRole = caseData.counterpartRole || "患者";
  const transcriptText = transcript.map((t) => `${t.role === "patient" ? counterpartRole : selfRole}: ${t.text}`).join("\n");
  // すでに実施・結果判明した動的検査(KOH等)があれば、患者がその状態を正しく認識できるよう明示する。
  // これが無いと、既に結果が出た検査を「まだ受けていない」ものとして扱ってしまうことがある。
  const completedTestsText = additionalTests.length
    ? additionalTests.map((t) => `・${t.label}: 実施済み。結果は「${t.result}」`).join("\n")
    : "(まだなし)";
  // 会話終了の合図の例文は言語ごとに用意する(英語の例文をそのまま中国語の判定基準にしないため)。
  // 例は判定の「手がかり」であって、これらの単語が出たら機械的に終了扱いにするという意味ではない。
  const closingExample =
    lang === "cn"
      ? "「谢谢」「好的，那就这样」「我这就去处理」など"
      : "\"Thank you.\" \"Sounds good, thanks.\" \"I'll take care of that now.\" など";
  const pinyinField = lang === "cn" ? `,"patientReplyPinyin":"患者の返答のピンイン(動作部分は除く)"` : "";
  // 対象言語の「文字種として成立しているか」は、辞書編集画面と同じ既存関数
  // looksLikeTargetLangScript()でローカルに決定的に判定する(AIに文字種の判別をやり直させない)。
  // 中国語は漢字/かな判定、英語は日本語文字を含まないかの判定で、いずれも既存関数の挙動をそのまま使う。
  const lastUserText = transcript[transcript.length - 1]?.text || "";
  const scriptOk = looksLikeTargetLangScript(lastUserText.trim(), lang);
  // JSON出力直前のinTargetLanguage判定基準も言語ごとに用意する(中国語向けの基準文言を英語ロールプレイに
  // そのまま使い回すと、英語ロールプレイで日本語を名指しした基準が無くなってしまうため)。
  const inTargetLanguageHint =
    lang === "cn"
      ? `ユーザーの直前の発言について、ローカルの文字種チェック(漢字を含み、ひらがな・カタカナを含まないか)の結果は「対象言語(${langOf(lang).label})の文字種として${scriptOk ? "成立しています" : "成立していません"}」です。この文字種の判定はローカルで確定済みのため、inTargetLanguageはこの結果をそのまま採用してください。漢字・ひらがな・カタカナ・ピンインの判別をあなた自身でやり直す必要はありません。目標表現と意味が近いかどうかは、この判定に一切影響しません(意味が近くても、文字種チェックの結果が「成立していません」ならfalseのままにしてください)`
      : "ユーザーの直前の発言が英語として成立しているか。日本語(漢字・ひらがな・カタカナを含む発言)はfalse、中国語はfalse、英語以外の言語はfalse。nihaoやhyhyhのような、英語の綴りとしても意味を成さない文字列もfalse。目標表現と意味が近いかどうかではなく、実際の発話がそのまま英語として成立しているかどうかだけで判定すること(意味が目標表現に近いという理由だけでtrueにしない)";
  const prompt =
`あなたは外国語ロールプレイ練習アプリの${counterpartRole}役です。会話の相手(ユーザー)は${selfRole}です。会話は${langOf(lang).label}で行います。\n\n` +
    `ケース概要: ${caseData.patientBrief}\n` +
    `内部的な想定病態(ユーザーには見せていない情報。新しい検査を求められた場合の結果作成にのみ使う): ${caseData.underlyingCondition || "(特に設定なし)"}\n` +
    `所見の内容(ユーザーが「所見を見る」操作をした場合にのみ画面に表示される情報。あなた自身の発言でこの内容を先に言ったり読み上げたりしないでください。矛盾しないようにするための参考情報としてのみ使う): ${caseData.findings || "(特に設定なし)"}\n` +
    `検査結果の内容(ユーザーが「検査結果を見る」操作をした場合にのみ画面に表示される情報。あなた自身の発言でこの内容を先に言ったり読み上げたりしないでください。矛盾しないようにするための参考情報としてのみ使う): ${caseData.labResults || "(特に設定なし)"}\n` +
    `問診で尋ねられた場合に答える背景情報(ユーザーには見せていない情報。医師が経過・期間・治療歴・服薬・既往歴・アレルギーなどを尋ねた場合、この内容と矛盾しないように、また分かる範囲で具体的に答えること。書かれていない項目を聞かれた場合は、ケース全体と矛盾しない自然な内容を答えてよい): ${caseData.historyContext || "(特に設定なし)"}\n` +
    `診察中にすでに実施済みの追加検査とその結果(この会話の中で既に行われたものです。まだ受けていない扱いにしないでください):\n${completedTestsText}\n\n` +
    `目標表現(ユーザーがこの会話の中で言えるようになりたい日本語): ${targetExpr.ja}(参考として辞書に登録されている${langOf(lang).tag}訳: ${targetExpr.en}。ただしこの訳文はユーザー自身が登録したもので必ずしも正確・自然とは限らないため、targetAchievedの判定は登録訳文との一致ではなく、日本語の意味・意図が伝わっているかを基準にしてください)\n\n` +
    `これまでの会話(現在${turnCount}往復目):\n${transcriptText}\n\n` +
    `方針:\n` +
    `・counterpartRoleとして、ユーザーの直前の発言に自然に反応してください。ユーザーの発言に反応せず勝手に話を進めないでください。\n` +
    `・シナリオに内部情報(所見・検査結果・背景情報など)が存在することと、counterpartRoleが会話のその時点ですでにそれを知っていることは同じではありません。特に、counterpartRole自身がユーザーに何かを尋ねたり確認を求めたりした直後に、ユーザーがまだ答えていない場合、またはユーザーが「確認します」「調べます」「後で伝えます」のようにまだ情報を取得していないことを示す発言をした場合は、シナリオの内部情報を使ってその答えを先取りして自分で述べないでください。この場合は、自然に待つ・確認を促す・その時点で会話上すでに得られている情報だけを使って別の話題を続けるなど、counterpartRoleとして自然に反応してください。これは、会話の一貫性を保つため、既に会話上明らかになっている内容と矛盾しないため、counterpartRole自身が本来知っている立場・背景を維持するために内部情報を使うこと自体を禁止するものではありません。\n` +
    `・リアルさより、練習として成立することを優先してください(過度な脱線はしない)。\n` +
    `・ケース上の設定(所見・検査結果など)は「正解」として強制しないでください。医師が確認・判断するもの(所見の内容、検査結果の陽性/陰性、それらに基づく医学的判断など)について、ユーザーが所見・検査結果を確認せずに自分の判断で発言した場合も、その発言を会話上の事実として扱い、実際のケース設定の値で訂正しないでください(訂正しないでください)。これは、患者自身の主訴・体感(かゆみ・痛みなど患者本人の感覚)については患者側の認識を優先して維持する別のルールとは区別してください(そちらは変更しません)。\n` +
    `・上記の「すでに実施済みの追加検査」に書かれている検査については、患者は既に受けたものとして扱ってください(例:「これから受けるんですね」「まだ検査していません」のような発言は不可)。\n` +
    `・検査に関する患者の発言は、現在の検査の進行状況(検査前／検査実施／結果待ち／結果判明／結果説明)と矛盾しないようにしてください。特に、結果がすでに判明・説明されている検査について、「検査前に知っておくべきことはありますか？」のような検査前を前提にした発言をしないでください。会話ログとケース情報(所見・検査結果・追加検査の状態)から、今どの段階にいるかを毎回確認してから発言を作ってください。\n` +
    `・重要(ロールプレイの目的): このロールプレイの目的は診療全体をシミュレーションすることではなく、目標表現をこの仕事の場面で自然に言えるようにする練習です。目標表現を自然に言うために必要な最小限の前後の会話だけを作り、それ以外の長い診療過程や実際の時間経過(例:検査結果が出るまでの数日〜1週間など)を会話の中で再現しないでください。例えば目標表現が「検査結果は1週間後です」のように結果が出るまでの期間を伝える一文である場合、実際に1週間分の時間を進めたり、後日の再診を同じロールプレイで再現したりする必要はありません。医師が検査を提案→検査実施→患者が結果の判明時期を尋ねる→医師が目標表現を言う→患者が短く自然に反応する→終了に向かう、という短い流れで完結させてください。\n` +
    `・患者はユーザーがすでに知っている情報(来院理由・再診の経緯など)を、繰り返し説明しないでください。\n` +
    `・医師の直前の発言に、患者が尋ねようとしている質問への答えがすでに含まれていないか必ず確認してください(例:医師が使用回数を既に伝えたのに、患者が「何回塗ればいいですか？」と聞き返すのは不可)。含まれている場合は同じ内容を聞き返さず、了承の短い返答にとどめてください。\n` +
    `・患者は、ユーザーがこれまでの会話で既に伝えた情報(期間・回数・量など)を、もう一度尋ね返さないでください。会話ログをよく読み、既に答えが出ている質問を繰り返さないよう注意してください。\n` +
    `・counterpartRoleは、ユーザー(selfRole)が指摘・言及した内容のうち、counterpartRole自身の状況・立場・持ち物・担当・感覚など、counterpartRole本人が直接知っている・感じていることについては、自分自身の認識として直接反応してください(例:患者ロールプレイで医師が症状の部位・程度を指摘した場合、患者は自分の感覚として直接反応する。「そこにあるとは気づきませんでした」「そこも少し痒いです」など)。counterpartRole本人しか分からないはずの内容を、逆にユーザーへ尋ね返すのは当事者として不自然なので避けてください(例:医師が「右頬です」と伝えたのに、患者が「そこも痒いですか？」と自分の症状を聞き返すのは不可)。\n` +
    `・患者AIは、会話のターン数を稼ぐための質問を作らないでください。「次に何を聞けば会話が続くか」ではなく「この状況で実際の患者なら何と返すか」を基準にしてください。質問ではなく「なるほど」「気づきませんでした」「わかりました」のような短い反応だけで十分な場合は、それで構いません。医師が説明・指示をした直後に、"Why?""How often?""Is it serious?"のような質問を自動的に付け足さないでください(答えがすでに医師の発言に含まれている場合は特に不要です)。医師の発言が明確で理解できる場合、聞き返し・確認質問はしないでください(聞き返しは、医師の発言が本当に崩れていて理解できない場合だけに限定してください)。\n` +
    `・薬剤に触れる場合は商品名(ブランド名)は使わないでください(例:「用了这个药膏」「applied the cream」のように、種類だけの言い方で構いません)。ステロイドの強さの分類名(strong/very strongなど)を無理に会話で言わせる必要はありません。強さの情報はケースカード側で医師にすでに伝わっている前提で構いません。\n` +
    `・患者の動作(ト書き)は、ユーザーの直前の発言から自然に導ける範囲に限定してください。ユーザーが言っていない情報や行動を勝手に付け足さないでください(例:ユーザーが何も言っていないのに「頬に軽く触れる」のような動作を追加するのは不可)。\n` +
    `・患者の動作(ト書き)は基本的に入れないでください。「頷く」「立ち上がる」のような、無くても会話が成立する通常の相槌・動作は表示しないでください。動作を入れてよいのは、ユーザーの発言が失礼・不自然・意味が伝わりにくい、または患者が戸惑うような内容だった場合に、その反応(戸惑い・聞き返し・困った様子など)を伝える必要があるときだけです。「動作があるとリアルだから」という理由だけで動作を追加しないでください。\n` +
    `・重要: このロールプレイの言語は${langOf(lang).label}です。ユーザーの直前の発言が${langOf(lang).label}になっているか確認してください。` +
    (lang === "cn"
      ? `中国語ロールプレイなので、漢字を使った中国語での発言のみを「話せている」とみなしてください。この発言の文字種(対象言語として成立しているか)は、既に上記のローカルチェックで確定済みです。inTargetLanguageはその結果をそのまま使い、あなた自身で漢字・ひらがな・カタカナ・ピンインの判別をやり直さないでください。`
      : `英語ロールプレイなので、英語での発言のみを「話せている」とみなしてください。日本語(漢字・ひらがな・カタカナを使った文は、たとえ短くても、また漢字が共通していても英語ではありません)・中国語・韓国語など英語以外の言語は対象外です。`) +
    `対象外の判定は例示した言語に限定されず、指定言語(${langOf(lang).label})以外のあらゆる言語・ローマ字表記に適用してください(あなたは日本語の内容を実際には理解できますが、これはロールプレイ上の役作りのルールであり、指定言語以外には意味を読み取って反応しないでください)。対象外の場合、患者はその${langOf(lang).label}で自然に「聞き取れない/分かりません」と返し、targetAchievedは意味が通じるかに関わらず必ずfalseにしてください。\n` +
    `・patientReplyは1〜2文程度の短い返答に留めてください。会話を何往復分もまとめて一度に進めたり、お礼・会計・次回予約の相談・締めくくりの挨拶などを1回の返答に全部詰め込んだりしないでください。1ターンにつき1つの反応だけにしてください。ただし、ユーザーの発言に複数の内容・要件が含まれている場合、そのうち1つだけに触れて他を完全に無視したような返答にはしないでください。返答の短さ・「1つの反応」という原則は維持したまま、短い相槌や一言の言及を添えて、複数の内容を受け止めていることが伝わるようにしてください。\n` +
    `・ロールプレイ中のあなたはあくまでcounterpartRole(会話相手)として自然に会話し、ユーザー(selfRole)の言い回し・文法上の誤りをこの場で添削・訂正・指摘しないでください。言語面の評価・添削はこのロールプレイの後で別途行われるため、ここでは一切行う必要がありません。ユーザー(selfRole)の発言が多少文法的に崩れていても、意味が推測できる場合は、その文法上の乱れには一切触れず、推測した内容をそのまま前提にして自然に反応・回答してください。本当に意味が読み取れず、何を言っているのか分からないために会話を続けられない場合に限り、聞き返してください。その場合も、「文法が違う」「言い方が変だ」のような言語面の指摘はせず、相手役として自然に「すみません、もう一度お願いできますか」のような聞き返し方にとどめてください。\n` +
    `・患者の動作・仕草(ト書き)を入れる場合は、必ず *腕を見せる* のようにアスタリスクで囲み、発言本文とは別の要素として区別できるようにしてください。動作の説明文自体を長いセリフのように書かないでください。\n` +
    `・patientReplyJa(日本語訳)でも、動作部分は必ず同じように *少しぎこちなく手を振る* のようにアスタリスクで囲んで訳してください。動作も省略せず必ず訳してください(動作の訳が抜けるのは不可)。\n` +
    `・目標表現の内容そのもの(ユーザーがこれから言おうとしている一文と同じ趣旨の質問・発言)を、患者側から先に言わないでください。ただし、それにつながる症状・不安・疑問など、自然な話題そのものを患者が話すことは問題ありません(例:目標表現が症状の経過を尋ねる質問なら、患者が症状について話すこと自体は自然ですが、患者自身が「いつからですか？」のようにその質問を医師に投げかけるのは避けてください)。\n` +
    `・会話の中に複数の自然な話題がある場合、ユーザーの発言には自然に反応することを優先しつつ、目標表現に関連する話題へ自然につながる機会があれば、その流れを患者側の応答で不必要に断ち切らないでください。ただし、目標表現を無理に引き出そうとしたり、会話をその話題だけに誘導したりする必要はありません。\n` +
    `・目標表現を言った瞬間に会話を終わらせないでください。やり取りが自然に完了する(counterpartRoleが挨拶やねぎらいの言葉で締めくくる、次の行動を伝えるなど)ところまで続けてください。\n` +
    (achievedEver
      ? `・目標表現はこの会話の中ですでに言えています。目標表現を達成したからといって、その場で即座に会話を終了させないでください。目標表現を成立させるために必要な自然なやり取りがまだ続いている場合(相手の反応・確認など)は、これまで通り自然に続けてください。話題転換が無い場合は、通常は4〜6往復程度、長くてもあと1〜2往復ほどでやり取りを自然に終了へ向かわせてください(endState="ending")。一方、目標表現達成後に、目標表現の文脈から明確に離れて次の工程・別の作業内容・別の話題へ移った場合は、その新しい話題について必要な自然なやり取りを1〜2往復程度行ったら(話題が変わった瞬間に終了させるのではありません)、自然に終了へ向かわせてください(endState="ending")。「ありがとうございました」のような明確な終了表現が無い仕事の場面でも、この「話題が目標表現の文脈から離れたこと」を終了判断の目安にして構いません。また、「はじめまして」のような会話の入口にあたる目標表現の場合は、それを言った直後に終了へ向かわせず、その後に必要な自然な導入のやり取りを続けてください。この4〜6往復・1〜2往復という目安は、あくまで会話のペースの目安であり、終了を引き延ばすための条件ではありません。下記の"ended"の判定基準(相手から確認したいことが残っておらず、ユーザーも短い同意・感謝などで応じており、それ以上続く話題・質問が残っていない状態)にすでに当てはまる場合は、往復数の目安に達していなくても、その基準を優先して"ended"にしてください。「ありがとう」「どういたしまして」に相当するような締めのやり取りが済んでいるのに、往復数を埋めるためだけに同じような締めの言葉を不必要に繰り返さないでください。目標表現達成後、現在の話題・工程(達成後に移った新しい話題・工程も含む)について必要なやり取りが一段落し、双方にこれ以上続けるべき話題・確認事項が残っておらず、次の別の話題・工程へ移る境界に達した状態を、以下では"終盤"と呼びます(話題が変わった瞬間を終盤と呼ぶのではなく、その話題に必要なやり取りを終えた状態を指します。職種・場面は問いません)。\n`
      : `・目標表現はまだ言えていません。8〜10往復程度を目安に終了へ向かわせてください。10往復付近まで来た場合、目標表現を無理に引き出そうとして会話を延々と続けないでください。終わりに向かっていない場合は患者側の時間の都合(その言語で自然な、時間が無いことを伝える一言)で自然に終了へ向かわせてください(endState="ending")。例外として、医師が目標表現を言おうとしている流れの途中で、あと1往復で自然に言えそうな場合に限り、ごく短い余裕を持たせて構いません。それ以上の引き延ばしは許容しないでください。\n`) +
    `・counterpartRoleの締めくくりの発言は、直前のユーザーの発言をそのまま繰り返したり同じ言葉をオウム返ししたりしないでください(例:ユーザーが"Thanks."と言ったのにcounterpartRoleも"Thanks!"とだけ返すのは不自然)。counterpartRoleの立場として自然な返答(感謝を伝える、次の行動を伝える、挨拶するなど)にしてください。特定の言い回しに固定する必要はなく、会話の流れに合わせて自然に変えてください。\n` +
    `・会話が"終盤"に入っていると判断できる場合は、endStateを"ended"にしてください。${closingExample}のような、その言語で自然な締めくくりの一言はその典型例ですが、それに限定しません。判定は特定の単語の有無だけで機械的に行わず、直前のユーザーの発言も含めた会話全体の流れから「このやり取りはもう終わっている」と自然に読み取れるかで判断してください。例えば、counterpartRole側からユーザーに確認したいことが残っておらず、ユーザーも短い同意・感謝などで応じており、counterpartRole自身が次の行動を明示していて、それ以上続く話題・質問が残っていない場合は、患者向けの別れの挨拶のような特定の言い回しが無くても、自然な終了として"ended"を選んでください。まだユーザーの返答や反応を待つべき場合は"ended"にしないでください。\n` +
    `・10往復に達している場合は、次の発言でやり取りを終了させてください(endState="forced_end")。\n` +
    (lang === "cn" ? `・patientReplyPinyinには、patientReplyの発言部分(アスタリスクの動作部分を除く)に対応するピンインを入れてください。\n\n` : "") +
    (achievedEver
      ? `・会話が"終盤"に入っている場合、hintsは基本的に空配列[]にしてください。会話を終了へ向かわせている段階で、ユーザーに新しい発言を促すためのヒントは出さないでください(目標表現を言った直後に必要な自然な締めのやり取り自体は、hintsとは関係なくこれまで通り行ってください)。特に、達成済みの目標表現そのもの、またはそれを言い換えただけの同じ内容の候補を、hintsとして再度促さないでください。すでに完了した現在の話題・工程を繰り返し促すhints、または新しい話題を作り出して会話を引き延ばすようなhintsも出さないでください。相手がすでに「特にない」「満足している」のように答えている内容を、改めて確認させるようなヒントも出さないでください。目標達成後にhintsを出す場合は、それとは別の、次に必要な自然な仕事上の行動がある場合に限ってください(この場合も、${selfRole}自身が次に言う・行う内容に限り、${counterpartRole}側が尋ねる・伝える内容を候補にしないでください)。\n`
      : ``) +
    `・ヒント(hints)について: 通常通り会話が進んでいる場面では、hintsは空配列[]にしてください。今回のcounterpartRoleの発言を受けて、ユーザーが次に何を言えばよいか迷いそうな場面(例:新しい情報を提示された直後、会話の展開が変わった直後など)に限り、その場面でユーザーが次に取り得る自然な仕事上の発言・行動の候補を1〜3件、hintsに入れてください。候補は「情報を確認する」「相手に質問する」「状況を確認する」「説明する」「提案する」「確認・同意を取る」「必要な対応を伝える」など、その場面に応じて自然なものを考えてください。重要: hintsの候補は、必ず${selfRole}自身が次に言う・行う内容に限定してください。${counterpartRole}が次に尋ねる・伝える・行う内容(場面全体として次に起こりそうなことであっても、${counterpartRole}側の発言・行動であるもの)を、ユーザー向けのhintsとして候補にしないでください。「この場面で次に起こりそうなこと」ではなく、「${selfRole}であるユーザーが次に何を言う・行うか」という視点で候補を考えてください。候補は正解・模範解答・${langOf(lang).label}の完成文ではなく、ユーザーが何を話すかを考えるための日本語の短い足場(例:「Aさんについて少しお話ししたい」「最近のAさんの状態を伝える」)としてください。${langOf(lang).label}に翻訳して発話するのはユーザー自身の役割です。ほとんどのターンでは空配列[]になることを想定しており、毎回出す必要はありません。\n\n` +
        `次のJSON形式のみを出力してください(説明・コードブロック記号は不要です)。\n` +
    `{"inTargetLanguage":true または false(${inTargetLanguageHint}。これはpatientReplyの内容より前に、ユーザーの発言そのものが${langOf(lang).label}として成立しているかだけを見て決めてください。ユーザーの発言の意味が理解できるかどうかや、これから書くpatientReplyの内容とは関係ありません),"targetAchieved":true または false(日本語の目標表現の意味・意図を、指定言語で自然に言えていればtrue。辞書に登録されている訳文と完全一致している必要はなく、登録訳文自体が不自然・不正確である可能性も考慮して、あくまで日本語の意味を基準に判断すること。inTargetLanguageがfalseの場合は必ずfalseにする),"patientReply":"患者の返答(${langOf(lang).label}。inTargetLanguageがfalseの場合は、その${langOf(lang).label}で自然に「聞き取れない/分かりません」という趣旨の短い返答にすること)","patientReplyJa":"その日本語訳"${pinyinField},"endState":"normal"または"ending"または"ended"または"forced_end","hints":["次に取り得る自然な発言・行動の候補(日本語の短い一言。${langOf(lang).label}の完成文にはしない)"](通常は空配列[]。迷いそうな場面のみ1〜3件)}`;
  try {
    const out = await callClaude(prompt, 500);
    const cleaned = out.replace(/```json|```/g, "").replace(/,\s*}/g, "}").trim();
    const parsed = JSON.parse(cleaned);
    const aiSelfReportedInTargetLanguage = parsed.inTargetLanguage !== false; // 未指定ならtrue扱い(後方互換)
    // 中国語: 既存のローカル文字種チェック(scriptOk)を正本として採用し、AIの自己申告より優先する。
    // 英語: 新しい判定基準は作らず、既存のlooksLikeTargetLangScript(text,"en")が日本語を検出した
    // (scriptOk===false)場合だけ、AIの自己申告(true)をfalseにveto する。scriptOkがtrueの場合は
    // 引き続きAIの自己申告をそのまま使う。
    const inTargetLanguage =
      lang === "cn" ? scriptOk : scriptOk === false ? false : aiSelfReportedInTargetLanguage;
    return {
      patientReply: parsed.patientReply || "...",
      patientReplyJa: parsed.patientReplyJa || "",
      patientReplyPinyin: lang === "cn" ? parsed.patientReplyPinyin || "" : "",
      inTargetLanguage,
      // AIの自己申告に加え、クライアント側でもinTargetLanguage=falseならtargetAchievedを強制的にfalseにする
      // (指定言語以外の発話をうっかり「達成」扱いしないための二重の安全策)
      targetAchieved: inTargetLanguage && !!parsed.targetAchieved,
      endState: ["normal", "ending", "ended", "forced_end"].includes(parsed.endState) ? parsed.endState : "normal",
      // ヒントは正解を教えるものではなく参考の足場のため、最大3件・空文字を除いた文字列だけを採用する
      hints: Array.isArray(parsed.hints) ? parsed.hints.filter((h) => typeof h === "string" && h.trim()).slice(0, 3) : [],
    };
  } catch (e) {
    console.error("[getRoleplayConversationTurn] failed:", e);
    return {
      patientReply: "(応答の取得に失敗しました。もう一度お試しください)",
      patientReplyJa: "",
      patientReplyPinyin: "",
      inTargetLanguage: true,
      targetAchieved: false,
      endState: "normal",
      hints: [],
    };
  }
}

async function getRoleplayConfirmationTurn(targetExpr, caseData, transcript, turnCount, lang, additionalTests = [], patientReply = "") {
  const selfRole = caseData.selfRole || "医師";
  const counterpartRole = caseData.counterpartRole || "患者";
  const transcriptText = transcript.map((t) => `${t.role === "patient" ? counterpartRole : selfRole}: ${t.text}`).join("\n");
  const completedTestsText = additionalTests.length
    ? additionalTests.map((t) => `・${t.label}: 実施済み。結果は「${t.result}」`).join("\n")
    : "(まだなし)";
  const prompt =
    `あなたは外国語ロールプレイ練習アプリの${counterpartRole}役として行われた会話について、確認・状態判定だけを行うアシスタントです。会話は${langOf(lang).label}で行われています。\n\n` +
    `ケース概要: ${caseData.patientBrief}\n` +
    `内部的な想定病態(ユーザーには見せていない情報。新しい検査を求められた場合の結果作成にのみ使う): ${caseData.underlyingCondition || "(特に設定なし)"}\n` +
    `所見の内容(ユーザーが「所見を見る」操作をした場合にのみ画面に表示される情報。矛盾しないようにするための参考情報としてのみ使う): ${caseData.findings || "(特に設定なし)"}\n` +
    `検査結果の内容(ユーザーが「検査結果を見る」操作をした場合にのみ画面に表示される情報。矛盾しないようにするための参考情報としてのみ使う): ${caseData.labResults || "(特に設定なし)"}\n` +
    `診察中にすでに実施済みの追加検査とその結果(この会話の中で既に行われたものです。まだ受けていない扱いにしないでください):\n${completedTestsText}\n\n` +
    `目標表現(ユーザーがこの会話の中で言えるようになりたい日本語): ${targetExpr.ja}\n\n` +
    `これまでの会話(現在${turnCount}往復目。最後の行が、ユーザーの直前の発言に対する${counterpartRole}の今回の返答です):\n${transcriptText}\n${counterpartRole}: ${patientReply}\n\n` +
    `方針:\n` +
    `・selfRole・counterpartRoleのどちらか一方が、所見・検査結果・その他の確認事項を求めた場合は、次の優先順位で判断してください。確認・判断を行おうとしている側を「確認する側」、その内容を保持・提供する側を「確認される側」と呼びますが、どちらがselfRoleでどちらがcounterpartRoleかは固定されていません。今回のselfRole・counterpartRoleの関係と、直前までの会話の流れから、実際にどちらが確認する側でどちらが確認される側なのかを、その都度自然に判断してください(例:selfRoleが自分から何かを確認しようとしている場合はselfRoleが確認する側に、counterpartRoleが確認・提示を行っている場合はcounterpartRoleが確認する側になります)。①まず、確認する側が確認しようとしている対象を特定してください。対象は今回の発言だけで判断する必要はなく、今回の発言に明示されていない場合は、直前の会話の話題・流れから自然に1つの対象が読み取れるかを確認し、読み取れる場合はその対象を採用してください(例:一方が直前に何かを尋ね、確認する側が「確認します」とだけ答えた場合、その直前の話題が対象になります)。対象は、直前の会話で実際に具体的に話題になっていた事柄に限ってください。氏名・生年月日のような、場面や話題に関わらずどんな時でも存在してしまう一般的な基本情報を、対象が定まらない場合の代わりとして選ばないでください。今回の発言にも直前の会話にも、対象を特定できる手がかりが無い場合は、対象を勝手に作り出さず、通常の応答(確認行為ではない扱い)にとどめてください。対象が定まった場合は、次に、その確認について、selfRoleが具体的な内容(氏名・予約番号・希望条件など)を持っていて、その内容を答える・確認してもらう必要があるかを確認してください。selfRoleが物・資料を提示するだけで、その中身についてselfRole自身が具体的な内容を会話上答える必要が無い場合(例:身分証・パスポートなどを提示するだけで、記載内容を自分から答える必要はない場合)は、newTestRequestedをtrueにせず、通常の応答(確認行為ではない扱い)にとどめてください。selfRoleがその内容を持っていて、それを答える・確認してもらう必要がある場合(例:氏名・予約番号・希望条件などをselfRole自身が答える場合)は、次の判定に進んでください(これは「selfRoleが確認する側か確認される側か」とは別の判定であり、selfRoleが確認される側であっても、selfRoleが具体的な内容を答える必要があるなら対象に含めてください)。対象が定まったら、上記の所見の内容・検査結果の内容、または「診察中にすでに実施済みの追加検査」の中に、その対象と一致するものがすでにあるかを確認してください。一致の判断は「所見系か検査系か身体診察系か」のような大まかな分類だけで行わず、対象そのもの(例:腹部の診察、体温、血液検査など)が具体的に一致する場合に限ってください。一致するものがある場合は、それをそのまま使ってください(所見ならshowFindingsButton、検査結果ならshowLabButtonの対象とし、newTestRequestedは使わずfalseのままにしてください。同じ内容を別の名前の確認事項として新しく作らないでください)。②ケースに該当する具体的な対象の情報が無く、かつその場で確認・測定・診察・検査することがこの仕事の場面として物理的に自然に行える場合は、主訴との医学的・専門的な関連性の強さだけで足切りせず(関連が弱くても、その場で実施できる行為であれば)、最初のケース設計では想定していなかった新しい確認事項(検査に限らず、視診・触診・聴診・反射確認などの身体診察、測定、指定された職種・役割がその場面ですでに存在する情報源(記録・資料・管理情報など)を確認する行為、また視覚・触覚・聴覚・嗅覚・味覚・食感などで対象を直接確認して得られる情報(例:見た目・色・形・大きさ、触れた質感・硬さ・乾燥、聞こえた音、匂い、味、食感など)なども含む。例:血液検査・KOH検査・画像検査・ダーモスコピーなどの検査、血圧測定・体温測定、腹部の触診、胸部の聴診、咽頭の視診、膝蓋腱反射などの身体診察、指定された職種に自然な記録・資料の確認(医療ならカルテ・診療記録・申し送り、薬剤師なら処方内容・薬歴、受付なら予約・登録情報など、その仕事で自然に存在する情報源)、その他その場で確認・測定できる事項)として、それを実施したことにし、内部的な想定病態と矛盾しない結果を作ってください(newTestRequested=true、newTestLabelにその名称(日本語、短く、対象が分かるように。例:「腹部触診」「胸部聴診」「咽頭視診」「膝蓋腱反射」「血圧測定」)、newTestResultには、その結果をselfRole＝ユーザーがこの場面で自然に把握できる内容として、日本語で簡潔に書く(確認する側がcounterpartRoleであっても、newTestResultをcounterpartRole側の業務記録として書かず、selfRoleがこの場面で持っている・提示した・受け取った・確認できる情報として書く。情報量を減らす必要はなく、視点・言い回しだけをselfRole側に合わせる))。既存の所見・検査結果とも矛盾しないようにしてください。すでに同じ確認事項が行われている場合は新しく作らず、newTestRequestedはfalseのままにしてください。確認する側が新しい確認事項を要求していない通常のターンでは、newTestRequestedはfalseにしてください。③確認する側が確認しようとしている対象が、ケースにある所見・検査結果・追加検査のいずれとも異なる具体的な対象である場合、既存の情報を別の対象の結果として流用しないでください(例:腹部の触診を求められた場合に、ケースにあるのが体温の情報だけであれば、それを腹部の所見として見せてはいけません。血液検査を求められた場合に、ケースにあるのが血圧の情報だけであれば、それを血液検査結果として見せてはいけません)。この場合は②の要領で、求められた対象に合った結果を新たに作成してください。記録・資料の確認によって新たに得られる内容は、すでにケース概要(patientBrief)に書かれている情報をそのまま繰り返さないでください。ケース概要に無い、質問の内容に応じた新しい詳細を、内部的な想定(underlyingCondition)と矛盾しない範囲で生成してください。④求められた確認事項について、ケースに該当情報が無く、かつその場では確認・測定・結果提示ができないことがこの仕事の場面として自然な場合は、②と同じ仕組み(newTestRequested=true、newTestLabelにその名称)を使ってください。ただしこの場合のnewTestResultには、実際の数値・結果ではなく「まだ結果がありません(次回確認予定)」のような、結果が今は提供できないことを短く伝える文言を入れてください。この場合のpatientReplyは、「Of course.」「Sure.」のような、ごく短い相槌のみにしてください。結果が無いこと・待ち時間・いつ出るか・次回になること・結果を待っている状況などについて、counterpartRole側から自発的に説明・言及したり、逆にselfRoleに聞き返したりしないでください(これらの情報は基本的にnewTestResult側の表示だけで伝え、会話としては広げないでください)。ただし、selfRoleがそのターンで時期・理由などを明確に質問している場合は、この制限の対象外とし、通常通り自然に短く回答してください(この制限はcounterpartRole側から自発的に話題を広げないという意味であり、selfRoleからの質問への回答自体を禁止するものではありません)。これにより、結果が無いこの種のやり取りで不要な会話のターンを消費しないようにしてください。これは会話を引き延ばすための理由付けとして安易に使わないでください。実際にその仕事の現場で、要求された内容の結果がすぐには出せないことが自然な場合(例:外部委託の検査に日数がかかる、担当者が別におり今は確認できない、など)にだけ使い、単にケースに情報が用意されていないという理由だけで機械的にこの扱いにしないでください。すでに同じ確認事項についてこの扱いが行われている場合は、②と同様newTestRequestedはfalseのままにして重複させないでください。\n\n` +
    `次のJSON形式のみを出力してください(説明・コードブロック記号は不要です)。\n` +
    `{"showFindingsButton":true または false(ユーザーが所見を確認しようとする発言、または実際に特定の対象を観察・確認しようとする発言をした場合はtrue。対象は見る・触れる・聴く・匂いを確認する・味わう・測る・調べる・点検するなど、その職種で対象を直接確認する行為全般を含みます。判定は「確認」のような特定の単語の有無だけで機械的に行わず、発言の意味として対象を直接確認しようとしているかどうかで判断してください。「見てもいいですか？」のような、自分が確認する許可を求める発言だけでなく、「見せて」「触らせて」「聞かせて」「味見させて」のように、相手に対象を提示・体験させてもらうことを求め、その目的がユーザー自身による対象の確認・観察につながる発言も対象に含めてください(ただし、確認・観察を目的としているとは判断できない、単なる受け渡しの要求までtrueにする必要はありません)。対象が会話開始時点(openingLine)や直前のcounterpartRoleの発言ですでに提示・共有されている場合でも、ユーザーがその対象を自分で見たい・触りたい・聞きたい・味わいたい・測りたい・調べたい・点検したいなど、直接確認する意図を示した発言であればtrueにしてください。提示行為がすでに完了しているかどうかは、ユーザー自身による確認意図の判定を妨げません。「見てもいいですか？」のような曖昧な発言でも、直前の会話から対象が明確な場合はtrueにしてよい。ただし、その対象がケースの所見の内容と一致する場合に限る(対象がユーザー発言の中で明示的に名指しされていなくても、直前までの会話やopeningLineなどの文脈から対象が具体的に特定でき、かつその対象がケースの所見の内容に含まれており、かつユーザー発言がその対象を自分で直接確認する意図を示している場合は、この3点が揃っているとみなし、一致すると判断してください。文脈があるというだけで安易に一致とみなさないでください)),"showLabButton":true または false(ユーザーが検査結果を確認しようとする発言、または実際に体温・血圧などの測定や検査を行おうとする発言をした場合はtrue。ただし、その対象がケースの検査結果の内容と一致する場合に限る),"userConfirmedFindings":true または false(ユーザーが所見の内容について具体的に言及した場合、または所見を確認せずに所見に基づく医学的判断を発言した場合はtrue。実際の所見の値と矛盾していても構いません),"userConfirmedLab":true または false(ユーザーが検査結果の内容について具体的に言及した場合、または検査結果を確認せずに検査結果に基づく医学的判断を発言した場合はtrue。実際の検査結果の値と矛盾していても構いません),"newTestRequested":true または false,"newTestLabel":"確認事項の名称(日本語、検査に限らず身体診察・測定なども含む。newTestRequestedがfalseなら空文字)","newTestResult":"その結果(日本語、newTestRequestedがfalseなら空文字)"}`;
  try {
    const out = await callClaude(prompt, 400);
    const cleaned = out.replace(/```json|```/g, "").replace(/,\s*}/g, "}").trim();
    const parsed = JSON.parse(cleaned);
    // 原因調査用: API②に渡した入力(findings・transcript・今回のユーザー発言・patientReply)、
    // API②の生JSON、パース後の各判定値を記録する(判定ロジック・挙動には一切影響しない)
    console.log("[DEBUG getRoleplayConfirmationTurn IO]", {
      inputFindings: caseData.findings,
      inputTranscript: transcript,
      inputLastUserMessage: transcript[transcript.length - 1]?.text,
      inputPatientReply: patientReply,
      rawOutput: out,
      parsed,
      parsedShowFindingsButton: parsed.showFindingsButton,
      parsedShowLabButton: parsed.showLabButton,
      parsedUserConfirmedFindings: parsed.userConfirmedFindings,
      parsedUserConfirmedLab: parsed.userConfirmedLab,
      parsedNewTestRequested: parsed.newTestRequested,
    });
    return {
      showFindingsButton: !!parsed.showFindingsButton,
      showLabButton: !!parsed.showLabButton,
      userConfirmedFindings: !!parsed.userConfirmedFindings,
      userConfirmedLab: !!parsed.userConfirmedLab,
      newTestRequested: !!parsed.newTestRequested,
      newTestLabel: parsed.newTestLabel || "",
      newTestResult: parsed.newTestResult || "",
    };
  } catch (e) {
    console.error("[getRoleplayConfirmationTurn] failed:", e);
    return {
      showFindingsButton: false,
      showLabButton: false,
      userConfirmedFindings: false,
      userConfirmedLab: false,
      newTestRequested: false,
      newTestLabel: "",
      newTestResult: "",
    };
  }
}

async function getRoleplayTurn(targetExpr, caseData, transcript, turnCount, lang, additionalTests = [], achievedEver = false) {
  // 責務分離: ①会話生成(自然な返答・endState・targetAchieved・hints) と
  // ②確認・状態判定(showFindingsButton等)を別々のAI呼び出しに分ける。
  // 呼び出し元(sendUserLine)には、これまでと全く同じ形のオブジェクトを返すことで、
  // 呼び出し元・state更新ロジックには一切変更が要らないようにする。
  const conv = await getRoleplayConversationTurn(targetExpr, caseData, transcript, turnCount, lang, additionalTests, achievedEver);
  // ユーザーの発言が対象言語として成立していない場合、確認・状態判定はどのみち全てfalseになるため
  // (既存の安全策と同じ考え方)、この場合だけAPI②の呼び出し自体を省略する(不要なAPI呼び出しを増やさない)。
  const confirmation = conv.inTargetLanguage
    ? await getRoleplayConfirmationTurn(targetExpr, caseData, transcript, turnCount, lang, additionalTests, conv.patientReply)
    : {
        showFindingsButton: false,
        showLabButton: false,
        userConfirmedFindings: false,
        userConfirmedLab: false,
        newTestRequested: false,
        newTestLabel: "",
        newTestResult: "",
      };
  // 原因調査用: オーケストレータ(getRoleplayTurn)が最終的に返す確認系の値を記録する
  // (conv.inTargetLanguageによる無効化の前後を比較できるようにするだけで、判定ロジックは変更しない)
  console.log("[DEBUG getRoleplayTurn final confirmation values]", {
    inTargetLanguage: conv.inTargetLanguage,
    rawConfirmationShowFindingsButton: confirmation.showFindingsButton,
    finalShowFindingsButton: conv.inTargetLanguage && confirmation.showFindingsButton,
    rawConfirmationShowLabButton: confirmation.showLabButton,
    finalShowLabButton: conv.inTargetLanguage && confirmation.showLabButton,
  });
  return {
    patientReply: conv.patientReply,
    patientReplyJa: conv.patientReplyJa,
    patientReplyPinyin: conv.patientReplyPinyin,
    inTargetLanguage: conv.inTargetLanguage,
    targetAchieved: conv.targetAchieved,
    endState: conv.endState,
    // targetAchievedと同じ安全弁: 対象言語として成立していない発言(inTargetLanguage=false)は、
    // AIが意味を理解して「所見/検査を求めている」「所見/検査結果に言及した」と判定していても、
    // その判定ごと無効化する(言語チェックとは無関係に意味ベースで反応してしまうのを防ぐため)。
    showFindingsButton: conv.inTargetLanguage && confirmation.showFindingsButton,
    showLabButton: conv.inTargetLanguage && confirmation.showLabButton,
    userConfirmedFindings: conv.inTargetLanguage && confirmation.userConfirmedFindings,
    userConfirmedLab: conv.inTargetLanguage && confirmation.userConfirmedLab,
    newTestRequested: conv.inTargetLanguage && confirmation.newTestRequested,
    newTestLabel: confirmation.newTestLabel,
    newTestResult: confirmation.newTestResult,
    hints: conv.hints,
  };
}

async function analyzeRoleplaySession(targetExpr, caseData, transcript, lang) {
  const selfRole = caseData.selfRole || "医師";
  const counterpartRole = caseData.counterpartRole || "患者";
  const userTurns = transcript.filter((t) => t.role === "user");
  // 指定言語で書けていなかったユーザー発言には目印を付けて渡す(添削側でも見逃さないようにするため)。
  // ユーザー発言だけに専用の連番「(役割)発言(N)」を振り、相手役発言と混ざった全体通し番号(0,1,2...)には
  // 依存しない。この連番をAIの出力(userTurnNumber)と突き合わせることで、
  // 「どの修正文がどの発言に対応するか」を配列の並び順だけに頼らず、明示的に対応付ける。
  let userTurnCounter = 0;
  const transcriptText = transcript
    .map((t) => {
      if (t.role === "patient") return `${counterpartRole}: ${t.text}`;
      userTurnCounter += 1;
      const langTag = t.inTargetLanguage === false ? `(${langOf(lang).nameJa}になっていない発言)` : "";
      return `${selfRole}発言(${userTurnCounter})${langTag}: ${t.text}`;
    })
    .join("\n");
  // 「医療英語として自然か」のような分野固定の判断基準にしない。職種・場面・相手・会話の目的という
  // 構造化されたコンテキストとして渡し、将来別の職種のケースでもこの仕組みをそのまま使えるようにする。
  const occupationDescription = caseData.occupationLabel || APP_CONTEXT.domainLabel;
  const sceneContext =
    `職種：${occupationDescription}(${selfRole})\n` +
    `場面：${caseData.visitType === "return" ? "再診" : "初診"}の${selfRole}と${counterpartRole}の会話\n` +
    `相手：${counterpartRole}\n` +
    `会話の目的：${occupationDescription}としてのコミュニケーション`;
  // 重要度の低い相槌の例文は言語ごとに用意する(英語の例文をそのまま中国語の判定基準にしないため)。
  // これも固定リストでの機械的判定ではなく、あくまで判断の目安として示す。
  const fillerExample = lang === "cn" ? "「好的」「谢谢」「嗯」「知道了」など" : "\"Yes.\" \"Okay.\" \"Thank you.\" など";
  const pinyinInstruction = lang === "cn" ? `correctedListの各要素に"pinyin"(その文のピンイン)も付けてください。` : "";
  const prompt =
    `あなたは外国語ロールプレイ練習アプリの添削役です。今回の場面設定は次の通りです。\n${sceneContext}\n\n` +
    `以下はユーザーが${langOf(lang).label}で行ったロールプレイの会話ログです。目標表現(日本語): ${targetExpr.ja}(参考として辞書に登録されている${langOf(lang).tag}訳: ${targetExpr.en}。ただしこの訳文はユーザー自身が登録したもので必ずしも正確・自然とは限りません)\n\n` +
    `会話ログ(番号付き):\n${transcriptText}\n\n` +
    `最重要の方針:\n` +
    `■対象範囲\n` +
    `・このログに実際に書かれている発言だけを対象にしてください。ログに存在しない発言を想像で作ったり、会話の続きを付け足したりしないでください。\n` +
    `・targetNoteやnoteの中で、会話ログの番号(「0.」「5番の発言」など)を使って発言を指さないでください。番号は解析用の内部情報であり、ユーザーには見えません。発言を指す場合は、実際の発言内容を引用符で示してください(例:「『你怎么了？』は〜」)。\n` +
    `■判定の順序・基準\n` +
    `・自然さの判断は「医療英語では」のような特定分野・特定言語に決め打ちした基準に頼らず、上記の場面設定(職種・場面・相手・会話の目的)に照らして、${langOf(lang).label}としてこの会話の中で自然かどうかを判断してください。解説文でも「医療英語では」のような固定的な言い方は避け、「この場面では」のように場面ベースで説明してください。\n` +
    `・「正解は1つ」という判定はしないでください。意味が通じるかどうかを最優先の基準とし、その上でその場面により自然な言い方があるかを別軸として扱ってください。短く口語的な表現でも、意味が通じていれば失敗扱いにしないでください(例:中国語の「小心」のような短い一言でも、意味が通じていれば"failure"にはしない)。\n` +
    `・判定・添削は、登録されている${langOf(lang).tag}訳(${targetExpr.en})をそのまま正解として鵜呑みにせず、日本語の意味・文脈を基準にして自然かどうかを判断してください。ユーザーの発言が登録訳文と違っていても、日本語「${targetExpr.ja}」の意味に対して自然に伝わっていれば問題ありません。\n` +
    `・目標表現(日本語「${targetExpr.ja}」の意味)を、必要な具体性を保ってユーザーが会話の中で伝えられていた場合、たとえ登録されている訳文や他にもっと自然な言い方があっても、それだけを理由にseverityを"fix"にはしないでください("polish"にしてください)。このルールはseverity(fix/polish)にのみ適用され、targetResult(success/needs_improvement/failure)の判定を制限するものではありません。\n` +
    `・最重要: 各ユーザー発言は、必ず次の4段階の順番で判定してください。①その発言が${langOf(lang).nameJa}(指定言語)として書かれているか(これは会話ログの「(${langOf(lang).nameJa}になっていない発言)」の印で既に分かります)。②その発言自体が意味を成立させているか(語彙・文法として何かを言おうとしていることが読み取れるか)。③その発言が今回の目標表現(日本語「${targetExpr.ja}」)の意味を伝えられているか。④その発言自体に修正が必要か。これら4つを絶対に混同しないでください。\n` +
    `   ②について: 発言が短い・単語だけ・断片的であること自体は、意味が成立していないことを意味しません。直前の医師・患者のやり取りの文脈から何を言おうとしているか読み取れる場合は、②は成立しているとみなしてください。発言の長さだけを理由に④(修正が必要)と判定しないでください。\n` +
    `   一方、②で発言そのものの意味が本当に読み取れない場合(会話の流れと無関係な、でたらめな文字の羅列など)は、目標表現や会話の文脈を使って「本当は何と言いたかったか」を推測し、その推測結果を修正文としてcorrectedListに入れることを禁止します。このような発言はcorrectedListを空配列[]にしてください。目標表現に関する語句を含む文をcorrectedListに入れてよいのは、original自体に実際にその意味を読み取れる語・文法的な手がかりがある場合に限ります。\n` +
    `   ③について: ②が成立していても、③(目標達成)は別の判定です。②が成立していて③が未達の場合、それだけを理由に④(修正が必要)と判定しないでください。目標を達成できていないという情報は、targetNote(作業1.の判定)側でのみ扱ってください。②が成立している発言に④(修正)を付けてよいのは、その発言自体に語彙・文法・自然さ・丁寧さの問題があると判断した場合だけです。③の結果(目標と違う、目標に届いていない等)がどのような理由であっても、それだけを理由に④を付けることを禁止します。\n` +
    `   ④(修正が必要と判断した場合)について: correctedListの修正文は、必ずユーザーが実際に発言した内容(original)を出発点にしてください。目標表現の登録訳文(${targetExpr.en})の言い回しをそのまま使ったり、大きく寄せたりしないでください。修正文は、original自体の語彙・構造をできる限り保ったまま、問題のある箇所だけを必要最小限直したものにしてください。登録訳文は③(目標達成)の判定にのみ使い、修正文の材料にはしないでください。\n` +
    `・重要: このロールプレイの言語は${langOf(lang).nameJa}です。会話ログで「(${langOf(lang).nameJa}になっていない発言)」と印が付いているユーザー発言は、指定言語以外(英語混入・ピンインのみの表記など)で書かれています。これらは意味が推測できてもseverityを必ず"fix"にしてください("polish"や対象外にはしない、allGood=trueにもしない)。noteには文法の指摘ではなく「${langOf(lang).nameJa}で発言する必要があります。」という趣旨を明記してください${lang === "cn" ? `(ピンインのみの表記だった場合は「ピンインのみの表記は中国語の文字表記ではありません。」も付け加えてください)` : ""}。ユーザーに見せる言語名は必ず「${langOf(lang).nameJa}」という日本語表記を使い、英語の言語名(${langOf(lang).label}等)は使わないでください。また、この発言だけを根拠にtargetResultを"success"にしないでください。\n` +
    `■出力形式・文体\n` +
    `・targetNoteとnotesのtextは、評価レポートのような硬い言い方を避け、話しかけるような自然で短い日本語にしてください。「機能しており」「認められないため」「〜として扱われる」「〜として成立していることが確認できる」のような報告書的・機械的な言い回しは使わないでください。判定結果(success/needs_improvement/failure、severity、allGood)自体は変えず、あくまで説明の言い方だけを自然にしてください。例えば、目標を達成できた場合は「『红色还是留着』で『赤みがまだ残っています』という意味がちゃんと伝わっています。」のように、達成できなかった場合は「『红肿』は中国語ですが、今回の『赤みは少し良くなっています』という意味までは伝わっていません。」のように、それぞれ1文程度の短さで書いてください(これらは文体の参考例であり、そのまま使わず実際の内容に合わせて書いてください)。\n` +
    `・重要: 会話ログの「医師発言(N)」のNは、そのユーザー発言が何番目の発言かを示す番号です。turnResultsの各結果オブジェクトには、対応する医師発言のNの値を必ず"userTurnNumber"として含めてください。ある発言についての指摘を、別の発言(1つ前や1つ後など)の結果に混ぜたり、ズレた番号で出力したりしないでください。修正内容(sentences)は、必ずそのuserTurnNumberが指す発言そのものに対する指摘にしてください。\n\n` +
    `作業:\n` +
    `1. 目標表現について、その日本語が伝えるべき内容を、必要な情報まで含めて自然に伝えられていれば"success"、内容の一部が伝わりにくい・必要な情報が欠けていれば"needs_improvement"、内容が伝わらない・意図が異なる・そもそも言えていなければ"failure"と判定してください(完全な文字列一致は不要です。より自然な言い方が他にあるという理由だけでは"success"を下げないでください)。この判定の理由を1文で書いてください(targetNote)。\n` +
    `2. 会話ログの中の「医師発言(N)」は、全部で${userTurns.length}件あります。この${userTurns.length}件それぞれについて、1つずつ結果オブジェクトを作ってください(合計${userTurns.length}個)。各結果オブジェクトには、対応する発言のuserTurnNumber(1〜${userTurns.length}の整数)を必ず含めてください。\n` +
    `   各ユーザー発言について確認してください。完全に自然な文(②が成立し、かつ語彙・文法・自然さ・丁寧さに問題が無い文)、および${fillerExample}のような重要度の低い短い発話は対象外にしてください。この判断は上記の②の基準だけで行い、③(目標表現を達成できているか)の結果とは関係ありません。\n` +
    `   重要: 1つの医師発言(1つのuserTurnNumber)の中に複数の文が含まれている場合、それぞれの文を個別に確認・評価対象としてください。発言の前半にある文だけを見て後半の文の確認を省略しないでください。これは「First」「Second」のような特定の番号付け・形式がある場合に限った話ではなく、複数の文が接続詞・読点・改行などで自然に続けて話されている場合も同様です。sentences配列には、確認した結果fix・polishのどちらかに該当した文をそれぞれ別の要素として含めてください(該当しない完全に自然な文は、通常通り対象に含めなくて構いません)。\n` +
    `   指摘対象は、スペルミスのような単純な誤りだけでなく、二重否定・分かりにくい構文など「意味は推測できるが読み手/聞き手に負担をかける言い方」、および言い回しの丁寧さ・相手に対して失礼やぶっきらぼうに聞こえないかというニュアンスも含めてください(例:患者に対して命令口調・ぞんざいな言い方になっていないか)。\n` +
    `   severity="fix"を付けてよいのは、その発言自体の語彙・文法・表現上の問題によって、発言の意味そのものが理解できない・誤解を招く・失礼に聞こえる場合だけです。目標表現と違う内容を言っている、目標を達成できていない、場面の目的を果たしていない、ということだけを理由にseverity="fix"を付けないでください(目標を達成できているかどうかはtargetResult側で扱う判定であり、severityとは別です)。発言自体が語彙・文法・意味の上で成立しており、ただ目標と違う内容を言っているだけの場合は、severity="fix"を付けず、correctedListも作らないでください。originalが伝えている内容を変えずに、同じ内容をより自然な表現に直せる文にだけ severity="polish" を付けてください。originalの内容を目標表現の内容へ変えることはpolishではありません。\n` +
    `   1つの元の発言(original)を自然に直す際、文法的には1文であっても、独立して使い回せる意味のまとまり(節・フレーズ)が複数含まれる場合は、correctedListにそれぞれ別の要素として分けてください(例:「〜なので、〜することが大切です」のように接続詞でつながった2つの独立した内容は、2つの要素に分ける)。分ける必要が無い場合のみ1要素にしてください。correctedListの各要素は{"text":"独立して使える1文または1フレーズ","textJa":"その日本語訳"}の形にしてください。ただし、上記の「意味を解釈できない発言」に該当する場合、または発言自体は語彙・文法・意味の上で自然に成立しているが目標表現とは異なる内容を言っているだけの場合は、correctedListを空配列[]にしてください(後者の場合、発言自体を目標表現に置き換えた文を作らないでください)。${pinyinInstruction}\n` +
    `   noteは、この発言について学習上最も重要な指摘を優先して選んでください。原則として1つの発言につきnote要素は1件とし、該当しうるカテゴリ(表現・文法／丁寧さ／分かりやすさ など)を思いつく限りすべて列挙することは禁止します。優先順位は、①意味の誤解・伝達の失敗につながる問題(語彙・文法の誤りで意味が変わる、二重否定などで理解を妨げる)、②丁寧さ・失礼さなど対人コミュニケーション上の問題、③分かりやすさ・自然さ・スタイルの改善、の順で判断し、最も重要な1件だけをnotesに入れてください。ただし、原因も直し方も明確に独立した重大な問題が複数あり、1件だけに絞ると学習上重要な情報を取りこぼす場合に限り、2件目以降を追加してください。各要素は{"category":"指摘の種類を表す短いラベル(例:表現・文法／丁寧さ／分かりやすさ／語彙 など)","text":"要点のみを述べた1文"}の形にしてください。textは原則1文に収め、長い理由の説明や複数の言い換え候補を詰め込まないでください(言い換え候補はcorrectedListの役割であり、noteはあくまで「なぜ直したか」を短く理解するための補足です)。\n` +
    `   完全に自然だった文は対象に含めないでください。\n` +
    `   sentencesに severity="fix" の項目が1つも無ければallGoodをtrueにしてください(severity="polish"のみ、または対象なしの場合はallGood=trueで構いません)。fixが1つでもあればallGoodをfalseにしてください。\n\n` +
    `次のJSON形式のみを出力してください(説明・コードブロック記号は不要です)。\n` +
    `{"targetResult":"success"または"needs_improvement"または"failure","targetNote":"判定理由(1文)","turnResults":[{"userTurnNumber":何番目の医師発言に対応するか(1〜${userTurns.length}の整数),"allGood":true または false,"sentences":[{"original":"元の発言","correctedList":[{"text":"修正後の1文","textJa":"その日本語訳"${lang === "cn" ? `,"pinyin":"その文のピンイン"` : ""}}](意味を解釈できない発言の場合は空配列[]),"notes":[{"category":"指摘の種類","text":"具体的な指摘"}],"severity":"fix"または"polish"}]}]}`;
  // 長い会話(往復数が多い)ほど、ユーザー発言ごとの添削結果を含むJSON出力も長くなる。
  // 固定の上限だと長いロールプレイで出力が途中で切れ、JSON.parseが失敗する原因になっていたため、
  // 発言数に応じて上限を伸ばす(短い会話では従来通り、長い会話では余裕を持たせる)。
  const analysisMaxTokens = Math.min(6000, 1800 + userTurns.length * 300);
  const out = await callClaude(prompt, analysisMaxTokens);
  const cleaned = out.replace(/```json|```/g, "").replace(/,\s*}/g, "}").replace(/,\s*]/g, "]").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const rawResults = Array.isArray(parsed.turnResults) ? parsed.turnResults : [];

    // 同一セッション内で、修正文(text)がほぼ同じ添削が複数回出た場合、
    // 2件目以降は「重複」として保存ボタンを出さない(誤って同じ表現を2回保存するのを防ぐ)。
    // ※これは今回の会話1回分の中での重複検知であり、辞書に既にある表現との重複チェックは
    // 従来通りcheckSimilarBeforeSaveが別途担う。
    const seenCorrected = new Set();
    const normalize = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

    const normalizeResult = (r) => {
      const sentences = (Array.isArray(r.sentences) ? r.sentences : []).map((s) => {
        const severity = s.severity === "fix" ? "fix" : "polish";
        const rawList = Array.isArray(s.correctedList) && s.correctedList.length ? s.correctedList : [{ text: s.corrected || "", textJa: s.correctedJa || "", pinyin: s.pinyin || "" }];
        const correctedList = rawList
          .filter((c) => c && c.text)
          .map((c) => {
            const key = normalize(c.text);
            const isDuplicate = key && seenCorrected.has(key);
            if (key) seenCorrected.add(key);
            return { text: c.text, textJa: c.textJa || "", pinyin: lang === "cn" ? c.pinyin || "" : "", isDuplicate };
          });
        const notes = Array.isArray(s.notes)
          ? s.notes.filter((n) => n && n.text).map((n) => ({ category: n.category || "", text: n.text }))
          : s.note
          ? [{ category: "", text: s.note }] // 旧形式(単一文字列のnote)が返ってきた場合のフォールバック
          : [];
        return { original: s.original || "", notes, severity, correctedList };
      });
      const hasFix = sentences.some((s) => s.severity === "fix");
      return { allGood: !hasFix, sentences };
    };

    // userTurnNumber(1始まり)をキーに結果を並べ直す。配列の並び順そのものは信用しない
    // (AIが内部的な対応関係を1つズラして出力しても、番号さえ合っていれば正しい発言に紐づく)。
    const byNumber = new Map();
    rawResults.forEach((r) => {
      const n = Number(r.userTurnNumber);
      if (Number.isInteger(n) && n >= 1 && n <= userTurns.length && !byNumber.has(n)) {
        byNumber.set(n, r);
      }
    });
    // userTurnNumberが無い/不正な場合の保険として、位置順のフォールバックも用意しておく
    const turnResults = [];
    for (let i = 1; i <= userTurns.length; i++) {
      const r = byNumber.get(i) || rawResults[i - 1] || { allGood: true, sentences: [] };
      turnResults.push(normalizeResult(r));
    }

    return {
      failed: false,
      targetResult: ["success", "needs_improvement", "failure"].includes(parsed.targetResult) ? parsed.targetResult : "needs_improvement",
      targetNote: parsed.targetNote || "",
      turnResults,
    };
  } catch (e) {
    // 添削結果を取得できなかった場合。ここでturnResultsを{allGood:true}相当で埋めると
    // 「AIが正常と判定した」のと見分けがつかなくなるため、failedフラグで明確に区別する。
    // turnResultsは空配列にして、呼び出し側(UI)がfailedを見て専用のエラー表示に出し分ける。
    console.error("[analyzeRoleplaySession] failed:", e);
    return {
      failed: true,
      targetResult: null,
      targetNote: "",
      turnResults: [],
    };
  }
}

// 患者発話を「動作(ト書き)」と「セリフ」に分けて表示するためのパーサー。
// AI側には *動作* のようにアスタリスクで囲むよう指示しており、ここでそれを分解する。
// 一致するアスタリスク記法が無い場合は、改行だけで行を分ける(全文をセリフ扱い)。
function parsePatientSegments(raw) {
  if (!raw) return [];
  const segments = [];
  const regex = /\*([^*]+)\*/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, m.index).trim();
    if (before) {
      before
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => segments.push({ type: "speech", text: s }));
    }
    segments.push({ type: "action", text: m[1].trim() });
    lastIndex = regex.lastIndex;
  }
  const rest = raw.slice(lastIndex).trim();
  if (rest) {
    rest
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => segments.push({ type: "speech", text: s }));
  }
  return segments.length ? segments : [{ type: "speech", text: raw }];
}

// 音声読み上げ用に、動作のト書き部分(アスタリスク内)を取り除いたセリフだけのテキストを作る
function stripActionsForSpeech(raw) {
  return (raw || "").replace(/\*[^*]+\*/g, " ").replace(/\s+/g, " ").trim();
}

// 単語(英語はスペース区切り、中国語は文字単位)のLCSベースの簡易diff。
// 5分復習など既存機能に単語ハイライトの前例が無かったため、アプリの基調色(teal)を
// 「変更・追加された部分」の強調色として採用した(今回の実装判断)。
function diffWordsForHighlight(original, corrected, lang) {
  // 英語側は、単語に句読点が直接くっついた状態(例:"day."）を1トークンにすると、
  // ピリオドの有無だけで単語全体が「変更あり」判定になってしまう(例: "day" と "day." は別文字列)。
  // 単語・句読点・空白を別トークンに分けることで、実際に変わった記号だけをハイライト対象にする。
  const tokenize = (s) => (lang === "cn" ? s.split("") : (s.match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']|\s+/g) || []));
  const a = tokenize(original || "");
  const b = tokenize(corrected || "");
  // 添削結果のoriginalはAIがJSONの中で書き起こした文字列であり、ユーザーの元発言そのものを
  // 1文字も違わずコピーしている保証はない(大文字/小文字の揺れ、引用符の全角半角揺れなど)。
  // 表示上のcaseはcorrected側のトークンをそのまま使うが、「同じ単語かどうか」の判定自体は
  // 大文字小文字・引用符の見た目差を無視して比較し、実質的に同じ単語が別トークン扱いされて
  // 色付けされてしまう(例: HbA1c のcaseがAI側の書き起こしでわずかに揺れる、など)ことを防ぐ。
  const normalize = (t) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const an = a.map(normalize);
  const bn = b.map(normalize);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = an[i - 1] === bn[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const bIsCommon = new Array(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (an[i - 1] === bn[j - 1]) {
      bIsCommon[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return b.map((tok, idx) => ({ text: tok, changed: !bIsCommon[idx] }));
}

function RoleplayHubScreen({ onOpenSpacedReview, onOpenNewRoleplay, onOpenRoleplaySetup, roleplayProfile, inProgressSession, onResumeRoleplay }) {
  return (
    <div className="p-4 space-y-3">
      <p className="font-semibold text-slate-800 text-sm">復習</p>
      {inProgressSession && (
        <button onClick={onResumeRoleplay} className="w-full text-left border border-teal-300 bg-teal-50 rounded-xl p-3 space-y-0.5">
          <p className="text-xs text-teal-700 font-semibold">🔄 続きのロールプレイがあります</p>
          <p className="text-sm text-slate-800">{inProgressSession.targetExpr.ja}</p>
          <p className="text-[11px] text-slate-400">タップして続きから再開</p>
        </button>
      )}
      <button onClick={onOpenSpacedReview} className="w-full min-h-[64px] border border-slate-200 rounded-xl p-4 bg-white text-left">
        <p className="text-sm font-semibold text-slate-800">5分復習</p>
        <p className="text-[11px] text-slate-400 mt-0.5">保存した表現を、単独で思い出す練習</p>
      </button>
      <button onClick={onOpenNewRoleplay} className="w-full min-h-[64px] border border-slate-200 rounded-xl p-4 bg-white text-left">
        <p className="text-sm font-semibold text-slate-800">ロールプレイ</p>
        <p className="text-[11px] text-slate-400 mt-0.5">選んだ表現を、実際の会話の中で使う練習</p>
        {roleplayProfile && (roleplayProfile.occupation || roleplayProfile.occupationCategory) && (
          <p className="text-[11px] text-teal-700 mt-1">
            現在の設定：{roleplayProfile.occupation || roleplayProfile.occupationCategory}
          </p>
        )}
      </button>
      {roleplayProfile && (
        <button onClick={onOpenRoleplaySetup} className="text-xs text-teal-700">＋ 新しい設定でロールプレイ</button>
      )}
    </div>
  );
}

function RoleplaySetupScreen({ initialProfile, onBack, onSave }) {
  const [occupationCategory, setOccupationCategory] = useState(initialProfile?.occupationCategory || "");
  const [occupation, setOccupation] = useState(initialProfile?.occupation || "");
  const [sceneNote, setSceneNote] = useState(initialProfile?.sceneNote || "");
  const [customizationNote, setCustomizationNote] = useState(initialProfile?.customizationNote || "");

  const canSave = occupationCategory.trim() || occupation.trim();

  return (
    <div className="p-4 space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400">← 戻る</button>
      <div>
        <p className="font-semibold text-slate-800 text-sm">ロールプレイの設定</p>
        <p className="text-xs text-slate-500 mt-1">誰が・どんな仕事で・どんな場面で使うのかを自由に入力してください。選択肢からは選びません。細かく書かなくても大丈夫です。</p>
      </div>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">職種(例：医療、建築、美容 など)</label>
        <input
          value={occupationCategory}
          onChange={(e) => setOccupationCategory(e.target.value)}
          placeholder="例：医療"
          className="w-full border border-slate-300 rounded-xl p-3 text-base"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">職業・具体的な役割(例：皮膚科医、美容皮膚科医、設計士 など)</label>
        <input
          value={occupation}
          onChange={(e) => setOccupation(e.target.value)}
          placeholder="例：美容皮膚科医"
          className="w-full border border-slate-300 rounded-xl p-3 text-base"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">使う場面・希望(任意。複数書いても構いません)</label>
        <p className="text-[11px] text-slate-400">複数人が登場する場面では、実際に誰と会話するのかを明記してください(例：外国人クライアントと話したい、外国人患者と退院説明をする)</p>
        <p className="text-[11px] text-slate-400">特殊な場面や具体的な状況で練習したい場合は、こちらに詳しく入力してください</p>
        <textarea
          value={sceneNote}
          onChange={(e) => setSceneNote(e.target.value)}
          rows={3}
          placeholder="例：外来診療、処置中の声かけ、再診での経過説明"
          className="w-full border border-slate-300 rounded-xl p-3 text-base leading-relaxed"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">こだわり条件(任意)</label>
        <p className="text-[11px] text-slate-400">練習したい一文(目標表現)自体は変わりませんが、その一文を練習する今回のシナリオに入れてほしい条件があれば入力してください</p>
        <textarea
          value={customizationNote}
          onChange={(e) => setCustomizationNote(e.target.value)}
          rows={3}
          placeholder="例：パーソナルカラーがブルベ夏の顧客、初めて来店したお客様、急いでいるお客様への対応"
          className="w-full border border-slate-300 rounded-xl p-3 text-base leading-relaxed"
        />
      </div>
      <button
        onClick={() =>
          onSave({
            occupationCategory: occupationCategory.trim(),
            occupation: occupation.trim(),
            sceneNote: sceneNote.trim(),
            customizationNote: customizationNote.trim(),
          })
        }
        disabled={!canSave}
        className="w-full min-h-[48px] bg-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50"
      >
        この設定でロールプレイへ進む
      </button>
    </div>
  );
}

function RoleplaySelectScreen({ folders, expressions, lang, onBack, onStart, crownedIds }) {
  const [pickedFolder, setPickedFolder] = useState(null);
  // 以下、辞書側(MyDictScreen)のインデックスレールと同じUI状態。hooksのため早期returnより前で宣言する
  const itemRefs = useRef({});
  const [showIndexRail, setShowIndexRail] = useState(false);
  const [railScrollRatio, setRailScrollRatio] = useState(0);
  const indexHideTimer = useRef(null);
  const indexRailRef = useRef(null);
  const [activeLabel, setActiveLabel] = useState(null);

  const foldersWithCount = folders
    .map((f) => ({ ...f, count: expressions.filter((e) => e.lang === lang && e.folderIds.includes(f.id)).length }))
    .filter((f) => f.count > 0);

  if (!pickedFolder) {
    return (
      <div className="p-4 space-y-3">
        <button onClick={onBack} className="text-xs text-slate-400">← 戻る</button>
        <p className="font-semibold text-slate-800 text-sm">練習したい表現を選ぶ</p>
        {foldersWithCount.length === 0 ? (
          <p className="text-sm text-slate-500">まだ{langOf(lang).tag}の保存済み表現がありません。翻訳・保存してから試してください。</p>
        ) : (
          <div className="space-y-2">
            {foldersWithCount.map((f) => (
              <button key={f.id} onClick={() => setPickedFolder(f.id)} className="w-full text-left border border-slate-200 rounded-xl p-3 bg-white flex items-center justify-between">
                <span className="text-sm text-slate-800">{f.path}</span>
                <span className="text-xs text-slate-400">{f.count}件</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const jumpTo = (id) => {
    itemRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const onListScroll = (ev) => {
    setShowIndexRail(true);
    const el = ev.currentTarget;
    const maxScroll = el.scrollHeight - el.clientHeight;
    setRailScrollRatio(maxScroll > 0 ? Math.min(1, Math.max(0, el.scrollTop / maxScroll)) : 0);
    if (indexHideTimer.current) clearTimeout(indexHideTimer.current);
    indexHideTimer.current = setTimeout(() => setShowIndexRail(false), 2200);
  };
  const jumpByPointerY = (clientY, groups) => {
    const rail = indexRailRef.current;
    if (!rail || groups.length === 0) return;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const idx = Math.min(groups.length - 1, Math.floor(ratio * groups.length));
    setActiveLabel(groups[idx].label);
    jumpTo(groups[idx].id);
  };

  // 表示専用の五十音順ソート(このコンポーネント内で完結。既存の辞書側の並び順・stateには一切影響しない)
  const roleplayJaCollator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const roleplayGojuonRows = ["あいうえおがぎぐげご", "かきくけこ", "さしすせそざじずぜぞ", "たちつてとだぢづでど", "なにぬねの", "はひふへほばびぶべぼぱぴぷぺぽ", "まみむめも", "やゆよ", "らりるれろ", "わをん"];
  const roleplayToHiraganaChar = (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
  };
  const roleplaySortKeyOf = (e) => (e.yomi || e.ja || "").trim();
  const roleplayBucketOf = (text) => {
    const ch = text.charAt(0);
    if (!ch) return 2;
    if (/[0-9０-９]/.test(ch)) return 1;
    const hira = roleplayToHiraganaChar(ch);
    if (roleplayGojuonRows.some((r) => r.includes(hira)) || /[\u4E00-\u9FFF]/.test(ch)) return 0;
    return 2;
  };
  const sortByYomi = (arr) =>
    [...arr].sort((a, b) => {
      const ka = roleplaySortKeyOf(a), kb = roleplaySortKeyOf(b);
      const ba = roleplayBucketOf(ka), bb = roleplayBucketOf(kb);
      return ba !== bb ? ba - bb : roleplayJaCollator.compare(ka, kb);
    });

  const list = sortByYomi(expressions.filter((e) => e.lang === lang && e.folderIds.includes(pickedFolder)));

  // 以下、辞書側(MyDictScreen)のインデックスレールと同じ実装をこの画面専用に複製したもの。
  // 見た目・付け方(件数12以上でのみ表示、あ/か/さ…のフローティングレール、ドラッグでジャンプ)を
  // 辞書側とそろえるためのUI表示専用ロジックで、選択ロジック・stateには影響しない。
  const roleplayGojuonHeadOf = (ch) => {
    const hira = roleplayToHiraganaChar(ch);
    const row = roleplayGojuonRows.find((r) => r.includes(hira));
    return row ? row[0] : null;
  };
  const roleplayIndexLabelOf = (text) => {
    const ch = text.charAt(0);
    if (!ch) return "?";
    if (/[0-9０-９]/.test(ch)) return ch.replace(/[０-９]/, (d) => "０１２３４５６７８９".indexOf(d).toString());
    const gojuon = roleplayGojuonHeadOf(ch);
    if (gojuon) return gojuon;
    if (/[\u4E00-\u9FFF]/.test(ch)) return "他";
    return "他";
  };
  const buildRoleplayIndexGroups = (sortedArr) => {
    const groups = [];
    const seen = new Set();
    sortedArr.forEach((e) => {
      const label = roleplayIndexLabelOf(roleplaySortKeyOf(e));
      if (!seen.has(label)) {
        seen.add(label);
        groups.push({ label, id: e.id });
      }
    });
    return groups;
  };
  const indexGroups = list.length >= 12 ? buildRoleplayIndexGroups(list) : [];

  return (
    <div className="p-4 space-y-3">
      <button onClick={() => setPickedFolder(null)} className="text-xs text-slate-400">← フォルダ選択に戻る</button>
      <p className="font-semibold text-slate-800 text-sm">今回使えるようになりたい一文を選ぶ</p>
      <div className="relative">
        <div
          className="space-y-2 min-w-0 pr-1"
          style={{ maxHeight: "420px", overflowY: "auto" }}
          onScroll={onListScroll}
          onTouchMove={onListScroll}
        >
          {list.map((e) => (
            <div key={e.id} ref={(node) => { itemRefs.current[e.id] = node; }}>
              <button
                onClick={() => onStart(e, list.filter((x) => x.id !== e.id))}
                className="w-full text-left border border-slate-200 rounded-xl p-3 bg-white"
              >
                <p className="text-sm text-slate-800">{crownedIds && crownedIds.has(e.id) && "👑 "}{e.ja}</p>
                <p className="text-xs text-slate-400">{e.en}</p>
              </button>
            </div>
          ))}
        </div>
        {indexGroups.length > 0 && (
          <div className="absolute inset-y-0 right-0 w-14 pointer-events-none">
            <div
              ref={indexRailRef}
              style={{ top: `${10 + railScrollRatio * 80}%`, transform: "translateY(-50%)", maxHeight: "80vh", overflow: "hidden" }}
              className={`absolute right-1 flex flex-col items-center justify-center gap-0.5 bg-white/95 border border-slate-200 rounded-full shadow-lg py-2 px-1.5 transition-opacity duration-300 ${
                showIndexRail ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
              }`}
              onTouchStart={(ev) => {
                setShowIndexRail(true);
                if (indexHideTimer.current) clearTimeout(indexHideTimer.current);
                jumpByPointerY(ev.touches[0].clientY, indexGroups);
              }}
              onTouchMove={(ev) => jumpByPointerY(ev.touches[0].clientY, indexGroups)}
              onTouchEnd={() => {
                setActiveLabel(null);
                indexHideTimer.current = setTimeout(() => setShowIndexRail(false), 2200);
              }}
            >
              {indexGroups.map((g) => (
                <button
                  key={g.label}
                  onClick={() => jumpTo(g.id)}
                  className="min-w-[32px] min-h-[32px] flex items-center justify-center text-base font-bold text-teal-700 rounded-full"
                >
                  {g.label}
                </button>
              ))}
            </div>
            {activeLabel && (
              <div
                style={{ top: `${10 + railScrollRatio * 80}%`, transform: "translateY(-50%)" }}
                className="absolute right-16 bg-teal-700 text-white text-2xl font-bold rounded-full w-14 h-14 flex items-center justify-center shadow-lg"
              >
                {activeLabel}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RoleplayCaseScreen({ targetExpr, siblingExpressions, lang, roleplayProfile, onBack, onCaseReady }) {
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    generateRoleplayCase(targetExpr, siblingExpressions, lang, roleplayProfile)
      .then((scenario) => {
        console.log("[DEBUG generateRoleplayCase raw]", JSON.stringify(scenario, null, 2));
        return checkScenarioValidity(scenario, targetExpr, roleplayProfile, lang).then((check) => {
          console.log("[DEBUG checkScenarioValidity result]", {
            targetExprJa: targetExpr.ja,
            validScenario: check.validScenario,
            invalidReason: check.invalidReason,
          });
          if (check.validScenario === false) {
            return { validScenario: false, invalidReason: check.invalidReason };
          }
          return { ...scenario, validScenario: true };
        });
      })
      .then((data) => {
        if (cancelled) return;
        setCaseData(data);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetExpr.id]);

  if (loading) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-sm text-slate-500">場面を準備しています…</p>
      </div>
    );
  }
  if (error || !caseData) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-sm text-red-600">場面の準備に失敗しました。</p>
        <button onClick={onBack} className="min-h-[44px] px-4 bg-slate-700 text-white rounded-xl text-sm">戻る</button>
      </div>
    );
  }
  if (caseData.validScenario === false) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-sm text-red-600">この場面では、ロールプレイを作成できませんでした。</p>
        <p className="text-sm text-slate-500">別の職種・場面・目標表現でお試しください。</p>
        <button onClick={onBack} className="min-h-[44px] px-4 bg-slate-700 text-white rounded-xl text-sm">戻る</button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400">← 表現選択に戻る</button>
      <div className="border border-slate-200 rounded-2xl p-4 bg-slate-50 space-y-2">
        <p className="text-[11px] text-slate-400">今回の目標表現</p>
        <p className="text-sm font-semibold text-slate-900">{targetExpr.ja}</p>
        <div className="border-t border-slate-200 pt-2 mt-2 space-y-2">
          <p className="text-[11px] text-slate-400 mb-1">事前に分かっていること</p>
          {caseData.patientBrief
            .split(/\n{2,}/)
            .filter((block) => block.trim())
            .map((block, i) => (
              <p key={i} className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                {block.trim()}
              </p>
            ))}
        </div>
      </div>
      <button onClick={() => onCaseReady(caseData)} className="w-full min-h-[56px] bg-teal-700 text-white rounded-xl text-base font-semibold">
        会話を始める
      </button>
    </div>
  );
}

function RoleplayChatScreen({ targetExpr, caseData, lang, session, setSession, onAbandon, onEnd, onAddTrainingTime }) {
  const [answer, setAnswer] = useState("");
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [shownTranslations, setShownTranslations] = useState(new Set()); // どの患者発言(index)の日本語訳を表示中か
  const [hintsOpenIndices, setHintsOpenIndices] = useState(new Set()); // 💡ヒントを開いている発言(index)。ローカル表示状態のみ(API呼び出し無し)
  const [showCaseCard, setShowCaseCard] = useState(false); // 会話中に最初のシナリオを再確認するための表示切替(ローカルのみ・API呼び出し無し)
  const recogRef = useRef(null);
  const bottomRef = useRef(null);
  // トレーニング時間計測用: 直近のcounterpartRole発言が表示された時刻(「表示された時刻」→「送信ボタンを押した時刻」の
  // 区間を計測する)。中断・終了した場合、この時点から未送信のままの区間は加算されない(onAddTrainingTimeを呼ばないため)。
  const counterpartShownAtRef = useRef(Date.now());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.transcript, thinking]);

  const sendUserLine = async (text) => {
    if (!text.trim() || thinking) return;
    // トレーニング時間: 「相手役の発言が表示された時刻」から「送信ボタンを押した時刻(=この呼び出し時点)」までを
    // 計測して加算する。画面を開いたまま放置しても、送信しない限り加算されない。
    if (onAddTrainingTime) onAddTrainingTime(Date.now() - counterpartShownAtRef.current);
    const nextTranscript = [...session.transcript, { role: "user", text: text.trim() }];
    // ユーザーが次の発言に進んだタイミングで、確認済みの所見・検査結果カードは画面から畳む
    // (確認済みという情報自体(findingsRevealed/labRevealed)は保持し、ボタンが再度出ることはない)
    setSession((prev) => ({
      ...prev,
      transcript: nextTranscript,
      findingsCardVisible: false,
      labCardVisible: false,
      additionalTests: prev.additionalTests.map((t) => ({ ...t, cardVisible: false })),
    }));
    setAnswer("");
    setThinking(true);
    setError("");
    const nextTurnCount = session.turnCount + 1;
    try {
      const result = await getRoleplayTurn(targetExpr, caseData, nextTranscript, nextTurnCount, lang, session.additionalTests, session.achievedEver);
      // 直前に追加したユーザー発言に、指定言語で話せていたかのフラグを付ける(添削時の判定に使う)
      const taggedTranscript = nextTranscript.map((t, idx) =>
        idx === nextTranscript.length - 1 && t.role === "user" ? { ...t, inTargetLanguage: result.inTargetLanguage } : t
      );
      const withReply = [...taggedTranscript, { role: "patient", text: result.patientReply, textJa: result.patientReplyJa, pinyin: result.patientReplyPinyin }];

      // クライアント側の追加安全弁(仕様上の12往復に加え、AI判定が万一機能しなかった場合の保険として14往復で強制終了)
      // AI側は10往復到達で終了させる指示だが、多少の揺れを見込んで11往復をクライアント側の最終安全弁とする
      // (意図的に目標表現を言わず引き延ばした場合の会話API呼び出し回数・添削生成量を抑えるため、12→10に短縮)
      const finalState = nextTurnCount >= 11 ? "forced_end" : result.endState;

      setSession((prev) => {
        // 医師が最初のケース設計に無かった検査を要求した場合、その結果をその場で追加する
        // (同じ検査名がすでにあれば重複追加しない)
        let additionalTests = prev.additionalTests;
        if (result.newTestRequested && result.newTestLabel) {
          const norm = (s) => (s || "").trim().toLowerCase();
          const already = additionalTests.some((t) => norm(t.label) === norm(result.newTestLabel));
          if (!already) {
            additionalTests = [
              ...additionalTests,
              { id: `test_${prev.turnCount}_${additionalTests.length}`, label: result.newTestLabel, result: result.newTestResult, revealed: false, cardVisible: false },
            ];
          }
        }
        // 原因調査用: findingsRevealed/showFindingsButton/userConfirmedFindings/showFindingsの推移を記録する
        // (ログのみ。下のreturnで使う値と同じ式を別途計算しているだけで、挙動には一切影響しない)
        console.log("[DEBUG sendUserLine findings flow]", {
          turnCount: nextTurnCount,
          lastUserMessage: text,
          showFindingsButton: result.showFindingsButton,
          userConfirmedFindings: result.userConfirmedFindings,
          prevFindingsRevealed: prev.findingsRevealed,
          hasFindings: !!caseData.findings,
          computedShowFindings: result.showFindingsButton && !prev.findingsRevealed && !!caseData.findings,
          nextFindingsRevealed: prev.findingsRevealed || result.userConfirmedFindings,
        });
        return {
          ...prev,
          transcript: withReply,
          turnCount: nextTurnCount,
          achievedEver: prev.achievedEver || result.targetAchieved,
          showFindings: result.showFindingsButton && !prev.findingsRevealed && !!caseData.findings,
          showLab: result.showLabButton && !prev.labRevealed && !!caseData.labResults,
          findingsRevealed: prev.findingsRevealed || result.userConfirmedFindings,
          labRevealed: prev.labRevealed || result.userConfirmedLab,
          additionalTests,
          lastEndState: finalState,
          // 💡ヒントは常に最新のcounterpartRole発言に対するものとして毎ターン上書きする(古いターンのヒントは残さない)
          hints: result.hints || [],
          // 終了状態になっても、この時点ではまだ添削画面へは遷移しない。
          // ここで即座にonEndしてしまうと、患者の最後の発言が画面に表示される前に
          // 添削画面へ切り替わってしまうことがあるため、いったんチャット画面上で
          // 最後の発言を必ず見せてから、ユーザー自身の操作で添削画面に進んでもらう。
          concluded: finalState === "forced_end" || finalState === "ended",
        };
      });
      // 新しいcounterpartRole発言(result.patientReply)が表示されたタイミングとして、次の区間の計測開始時刻を更新する
      counterpartShownAtRef.current = Date.now();
    } catch (e) {
      // getRoleplayTurn自体は現在すべての処理をtry/catchで包んでおり、正常時はここまで例外を
      // 投げない設計にしている。それでもここに到達した場合は、getRoleplayTurnの戻り値を使った
      // 後続処理(setSessionの更新関数の中身など)側で例外が起きている可能性が高いため、
      // 実際の例外内容をここに残し、次回の実機テストで原因を特定できるようにする。
      console.error("[sendUserLine] failed:", e);
      setError("応答の取得に失敗しました。もう一度お試しください。");
    } finally {
      setThinking(false);
    }
  };

  const toggleMic = () => {
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    const r = getRecognition(langOf(lang).speech);
    if (!r) {
      setError("音声入力に対応していません。下のテキスト入力をご利用ください。");
      return;
    }
    r.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      sendUserLine(text);
    };
    r.onend = () => setListening(false);
    r.onerror = () => {
      setListening(false);
      setError("音声入力を開始できませんでした。テキスト入力をご利用ください。");
    };
    try {
      recogRef.current = r;
      setListening(true);
      r.start();
    } catch (e) {
      setListening(false);
      setError("音声入力を開始できませんでした。テキスト入力をご利用ください。");
    }
  };

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(lang).speech;
    window.speechSynthesis.speak(u);
  };

  return (
    <div className="relative flex flex-col h-full">
      <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
        <button onClick={onAbandon} className="text-xs text-slate-400">← 中断する</button>
        <button onClick={() => setShowCaseCard(true)} className="text-xs text-teal-700">シナリオを見る</button>
        <p className="text-[11px] text-slate-400 truncate max-w-[35%]">目標: {targetExpr.ja}</p>
      </div>
      {showCaseCard && (
        <div className="absolute inset-0 z-10 bg-white flex flex-col">
          <div className="p-4 space-y-4 flex-1 overflow-y-auto min-h-0">
            <button onClick={() => setShowCaseCard(false)} className="text-xs text-slate-400">← 会話に戻る</button>
            <div className="border border-slate-200 rounded-2xl p-4 bg-slate-50 space-y-2">
              <p className="text-[11px] text-slate-400">今回の目標表現</p>
              <p className="text-sm font-semibold text-slate-900">{targetExpr.ja}</p>
              <div className="border-t border-slate-200 pt-2 mt-2 space-y-2">
                <p className="text-[11px] text-slate-400 mb-1">事前に分かっていること</p>
                {caseData.patientBrief
                  .split(/\n{2,}/)
                  .filter((block) => block.trim())
                  .map((block, i) => (
                    <p key={i} className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                      {block.trim()}
                    </p>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 space-y-2 py-2">
        {session.transcript.map((t, i) => (
          <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${t.role === "user" ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-800"}`}>
              {t.role === "patient"
                ? parsePatientSegments(t.text).map((seg, si) =>
                    seg.type === "action" ? (
                      <p key={si} className="text-[13px] italic text-slate-400 my-0.5">{seg.text}</p>
                    ) : (
                      <p key={si} className="my-0.5">{seg.text}</p>
                    )
                  )
                : t.text}
              {t.role === "patient" && lang === "cn" && t.pinyin && (
                <p className="text-[11px] text-teal-600 mt-0.5">{t.pinyin}</p>
              )}
              {t.role === "patient" && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <button
                    onClick={() => speak(stripActionsForSpeech(t.text))}
                    aria-label="音声を聞く"
                    className="w-8 h-8 rounded-full flex items-center justify-center bg-white border border-slate-200 text-slate-500"
                  >
                    <Volume2 size={16} />
                  </button>
                  {t.textJa && (
                    <button
                      onClick={() =>
                        setShownTranslations((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        })
                      }
                      aria-label="日本語訳を表示/非表示"
                      className={`relative w-8 h-8 rounded-full flex items-center justify-center border ${
                        shownTranslations.has(i) ? "bg-teal-700 border-teal-700 text-white" : "bg-white border-slate-200 text-slate-500"
                      }`}
                    >
                      <Languages size={16} />
                      {!shownTranslations.has(i) && (
                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <span className="w-[140%] h-[1.5px] bg-slate-400 rotate-45" />
                        </span>
                      )}
                    </button>
                  )}
                </div>
              )}
              {t.role === "patient" && t.textJa && shownTranslations.has(i) && (
                <div className="mt-1.5 border-t border-slate-200 pt-1">
                  {parsePatientSegments(t.textJa).map((seg, si) =>
                    seg.type === "action" ? (
                      <p key={si} className="text-[11px] italic text-slate-400">({seg.text})</p>
                    ) : (
                      <p key={si} className="text-[11px] text-slate-500">{seg.text}</p>
                    )
                  )}
                </div>
              )}
              {/* 💡ヒント: 最新のcounterpartRole発言に、AIが候補を返している場合のみボタンを表示する。参考情報の提示のみで、
                  タップしても入力欄への自動入力・自動送信は行わない(STINGの目的上、必ずユーザー自身に発話してもらう)。 */}
              {t.role === "patient" && i === session.transcript.length - 1 && session.hints && session.hints.length > 0 && (
                <div className="mt-1.5">
                  <button
                    onClick={() =>
                      setHintsOpenIndices((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                    className="text-[11px] text-teal-700"
                  >
                    💡 ヒント
                  </button>
                  {hintsOpenIndices.has(i) && (
                    <div className="mt-1 space-y-1">
                      {session.hints.map((h, hi) => (
                        <p key={hi} className="text-[11px] text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1">
                          {h}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {thinking && <p className="text-xs text-slate-400 text-center animate-pulse">💭 返答を考えています…</p>}
        {session.lastEndState === "ending" && !thinking && (
          <p className="text-[11px] text-amber-600 text-center">そろそろ会話が終わりに近づいています</p>
        )}
        {session.showFindings && (
          <button
            onClick={() => setSession((prev) => ({ ...prev, findingsRevealed: true, findingsCardVisible: true, showFindings: false }))}
            className="w-full text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg py-2"
          >
            状態を確認する
          </button>
        )}
        {session.findingsCardVisible && caseData.findings && (
          <div className="border border-slate-200 rounded-lg p-3 bg-white text-sm text-slate-700 whitespace-pre-line">{caseData.findings}</div>
        )}
        {session.showLab && (
          <button
            onClick={() => setSession((prev) => ({ ...prev, labRevealed: true, labCardVisible: true, showLab: false }))}
            className="w-full text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg py-2"
          >
            測定結果を見る
          </button>
        )}
        {session.labCardVisible && caseData.labResults && (
          <div className="border border-slate-200 rounded-lg p-3 bg-white text-sm text-slate-700 whitespace-pre-line">{caseData.labResults}</div>
        )}
        {session.additionalTests.map((t) => (
          <div key={t.id}>
            {!t.revealed && (
              <button
                onClick={() =>
                  setSession((prev) => ({
                    ...prev,
                    additionalTests: prev.additionalTests.map((x) => (x.id === t.id ? { ...x, revealed: true, cardVisible: true } : x)),
                  }))
                }
                className="w-full text-xs text-teal-700 border border-teal-200 bg-teal-50 rounded-lg py-2"
              >
                {t.label}を確認する
              </button>
            )}
            {t.cardVisible && t.result && (
              <div className="border border-slate-200 rounded-lg p-3 bg-white text-sm text-slate-700 whitespace-pre-line">{t.result}</div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="p-3 space-y-2 border-t border-slate-200 shrink-0">
        {error && <p className="text-red-600 text-xs">{error}</p>}
        {session.concluded ? (
          <>
            <p className="text-center text-xs text-slate-500">会話が終了しました</p>
            <button
              onClick={() => onEnd(session.transcript, session.lastEndState)}
              className="w-full min-h-[52px] bg-teal-700 text-white rounded-xl text-sm font-semibold"
            >
              添削を見る
            </button>
          </>
        ) : (
          <>
            <div className="flex gap-2 items-end">
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="またはここにテキスト入力"
                rows={3}
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none"
              />
              <button onClick={() => sendUserLine(answer)} disabled={!answer.trim() || thinking} className="min-h-[44px] px-4 bg-slate-700 text-white rounded-lg text-sm disabled:opacity-50 self-end">
                送信
              </button>
            </div>
            <button
              onClick={toggleMic}
              disabled={thinking}
              className={`w-full min-h-[52px] rounded-xl text-sm font-semibold border-2 ${
                listening ? "bg-red-50 border-red-300 text-red-600" : "bg-teal-700 border-teal-700 text-white"
              } disabled:opacity-50`}
            >
              {listening ? "🎤 聞き取り中…" : "🎤 話す"}
            </button>
            <button
              onClick={() => onEnd(session.transcript, "natural")}
              className="w-full text-center text-[11px] text-slate-400 min-h-[32px] mt-4"
            >
              会話を終える
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RoleplayReviewScreen({ targetExpr, caseData, transcript, lang, expressions, onSave, checkSimilarBeforeSave, onMarkResult, showToast, onFinish, cachedAnalysis, onAnalysisReady }) {
  const [loading, setLoading] = useState(!cachedAnalysis);
  const [analysis, setAnalysis] = useState(cachedAnalysis || null);
  const [retryCount, setRetryCount] = useState(0);
  const [savedLabels, setSavedLabels] = useState({}); // { [key]: "保存先ラベル(未分類/フォルダ名/既存表現)" } その場で保存先が分かるようにするため
  const [savingKeys, setSavingKeys] = useState(new Set()); // 保存処理が進行中のキー(連打による二重保存・トースト取りこぼしを防ぐ)
  const [shownTranslations, setShownTranslations] = useState(new Set()); // 患者発言の訳(index基準)
  const [shownCorrectionTranslations, setShownCorrectionTranslations] = useState(new Set()); // 添削文の訳(key基準)
  const reported = useRef(false);

  useEffect(() => {
    // すでに添削結果がキャッシュ済み(=同一セッション内でこの画面を再訪した)なら、
    // 再度APIを呼ばずキャッシュをそのまま使う(速度・コスト対策)。
    if (cachedAnalysis) {
      if (!cachedAnalysis.failed && !reported.current) {
        reported.current = true;
        onMarkResult(targetExpr.id, cachedAnalysis.targetResult);
      }
      return;
    }
    let cancelled = false;
    setLoading(true);
    analyzeRoleplaySession(targetExpr, caseData, transcript, lang)
      .then((res) => {
        if (cancelled) return;
        setAnalysis(res);
        setLoading(false);
        onAnalysisReady && onAnalysisReady(res);
        // 添削結果が取得できなかった場合(failed=true)は、実際には判定していないので
        // 5分復習の優先度付けに誤ったtargetResultを記録しない
        if (!res.failed && !reported.current) {
          reported.current = true;
          onMarkResult(targetExpr.id, res.targetResult);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // 添削結果を取得できなかった場合。turnResultsを{allGood:true}相当で埋めると
          // 「AIが正常と判定した」のと見分けがつかなくなるため、failedフラグで明確に区別する。
          // 失敗結果はキャッシュしない(次回訪問時に再試行できるようにするため)。
          setAnalysis({ failed: true, targetResult: null, targetNote: "", turnResults: [] });
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount]);

  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langOf(lang).speech;
    window.speechSynthesis.speak(u);
  };

  const saveCorrection = async (key, c) => {
    if (savingKeys.has(key) || savedLabels[key]) return; // 連打防止(処理中/保存済みなら何もしない)
    setSavingKeys((prev) => new Set(prev).add(key));
    try {
      await checkSimilarBeforeSave(
        c.textJa || c.text,
        c.text,
        lang,
        null,
        async () => {
          // 中国語の場合、添削で既にAIがピンインを生成済みならそれを渡して再取得(fetchPinyin)を省く
          const result = await onSave(c.textJa || c.text, c.text, lang, lang === "cn" ? c.pinyin || null : null); // classifyAndSave内で保存先トーストも出る
          // その場(ボタンの真横)で保存先が分かるように、トーストとは別にインラインでも表示する
          setSavedLabels((prev) => ({ ...prev, [key]: result?.folderLabel || "未分類" }));
        },
        async () => {
          // 「既存の表現を使う」を選んだ場合は新規保存されないため、classifyAndSave側のトーストが出ない。
          // 保存経路によって表示が出たり出なかったりしないよう、ここでも必ずフィードバックを出す。
          showToast("📌 すでに辞書にある表現として扱いました(新規保存はしていません)", true);
          setSavedLabels((prev) => ({ ...prev, [key]: "既存の表現" }));
        }
      );
    } finally {
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-slate-500">会話を振り返っています…</p>
      </div>
    );
  }

  if (analysis.failed) {
    return (
      <div className="p-6 text-center space-y-4">
        <p className="text-sm text-slate-600">添削結果を取得できませんでした。会話が長かった場合など、通信状況によって失敗することがあります。</p>
        <button onClick={() => setRetryCount((n) => n + 1)} className="min-h-[44px] px-6 bg-teal-700 text-white rounded-lg text-sm font-semibold">
          もう一度試す
        </button>
        <button onClick={onFinish} className="w-full text-xs text-slate-400 min-h-[32px]">
          添削なしで終了する
        </button>
      </div>
    );
  }

  const resultLabel = {
    success: "✓ 言えました",
    needs_improvement: "△ 今回は今ひとつでした → 5分復習で優先",
    failure: "△ 今回は出てきませんでした → 5分復習で優先",
  }[analysis.targetResult];

  // ユーザー発言には順番にturnResultsを1件ずつ対応させる(analyzeRoleplaySession側で
  // ユーザー発言数と同じ件数になるよう保証済み)
  let userTurnPointer = -1;

  return (
    <div className="p-4 space-y-4">
      <div className={`rounded-2xl p-4 text-center ${analysis.targetResult === "success" ? "bg-emerald-50" : "bg-amber-50"}`}>
        <p className="text-[11px] text-slate-400 mb-1">今回の目標表現</p>
        <p className="text-sm text-slate-800 mb-2">{targetExpr.ja}</p>
        <p className={`text-sm font-semibold ${analysis.targetResult === "success" ? "text-emerald-700" : "text-amber-700"}`}>{resultLabel}</p>
        {analysis.targetNote && <p className="text-xs text-slate-500 mt-1">{analysis.targetNote}</p>}
      </div>

      <div className="space-y-3">
        {transcript.map((t, i) => {
          if (t.role === "patient") {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-slate-100 text-slate-800">
                  {parsePatientSegments(t.text).map((seg, si) =>
                    seg.type === "action" ? (
                      <p key={si} className="text-[13px] italic text-slate-400 my-0.5">{seg.text}</p>
                    ) : (
                      <p key={si} className="my-0.5">{seg.text}</p>
                    )
                  )}
                  {lang === "cn" && t.pinyin && <p className="text-[11px] text-teal-600 mt-0.5">{t.pinyin}</p>}
                  {t.textJa && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <button
                        onClick={() => speak(stripActionsForSpeech(t.text))}
                        aria-label="音声を聞く"
                        className="w-8 h-8 rounded-full flex items-center justify-center bg-white border border-slate-200 text-slate-500"
                      >
                        <Volume2 size={16} />
                      </button>
                      <button
                        onClick={() =>
                          setShownTranslations((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                        aria-label="日本語訳を表示/非表示"
                        className={`relative w-8 h-8 rounded-full flex items-center justify-center border ${
                          shownTranslations.has(i) ? "bg-teal-700 border-teal-700 text-white" : "bg-white border-slate-200 text-slate-500"
                        }`}
                      >
                        <Languages size={16} />
                        {!shownTranslations.has(i) && (
                          <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <span className="w-[140%] h-[1.5px] bg-slate-400 rotate-45" />
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                  {t.textJa && shownTranslations.has(i) && (
                    <div className="mt-1.5 border-t border-slate-200 pt-1">
                      {parsePatientSegments(t.textJa).map((seg, si) =>
                        seg.type === "action" ? (
                          <p key={si} className="text-[11px] italic text-slate-400">({seg.text})</p>
                        ) : (
                          <p key={si} className="text-[11px] text-slate-500">{seg.text}</p>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // ユーザー発言: 対応するturnResultを順番に1件消費する
          userTurnPointer += 1;
          const result = analysis.turnResults[userTurnPointer] || { allGood: true, sentences: [] };

          return (
            <div key={i} className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-teal-700 text-white">{t.text}</div>
              {result.sentences.length === 0 ? (
                <span className="text-[11px] text-emerald-600 pr-1">🟢 通じます</span>
              ) : (
                <div className="w-[85%] space-y-2 pr-1">
                  {result.sentences.map((c, si) => {
                    const isPolish = c.severity === "polish";
                    // isPolishでも実際の自然な表現(correctedList)が空/未定義/空文字のみの場合があるため、
                    // 見出し・専用の枠は「実際に表示できる内容がある場合」だけに限定する
                    const naturalList = (c.correctedList || []).filter(
                      (cl) => cl && typeof cl.text === "string" && cl.text.trim() !== ""
                    );
                    const showNatural = isPolish && naturalList.length > 0;
                    return (
                      <div key={si} className="space-y-1.5 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-2">
                        {isPolish && <p className="text-[11px] text-emerald-600 font-medium">🟢 通じます</p>}
                        {showNatural && <p className="text-[10px] text-slate-400">💡 より自然な表現</p>}
                        <div className={`space-y-1 ${showNatural ? "bg-teal-50 rounded-lg px-2 py-1.5" : ""}`}>
                          {(isPolish ? naturalList : c.correctedList).map((cl, ci) => {
                            const key = `${i}-${si}-${ci}`;
                            // 修正が複数文・複数フレーズに分かれる場合でも、必ず元の発言全体と比較して
                            // diffを取る(以前は2文目以降をnull=無修飾表示にしていたが、これだと
                            // 実際に変更があるのに一切ハイライトされない、という不具合になっていた)
                            const diffTokens = diffWordsForHighlight(c.original, cl.text, lang);
                            const isSaving = savingKeys.has(key);
                            const savedLabel = savedLabels[key];
                            const exactMatch = !savedLabel && !cl.isDuplicate ? findExactExpression(expressions, lang, cl.text) : null;
                            const translationShown = shownCorrectionTranslations.has(key);
                            return (
                              <div key={ci} className="space-y-1">
                                <p className="text-sm text-slate-900">
                                  {diffTokens
                                    ? diffTokens.map((tok, ti) =>
                                        tok.changed ? (
                                          <span key={ti} className={isPolish ? "text-teal-600" : "text-teal-700 font-semibold"}>
                                            {tok.text}
                                          </span>
                                        ) : (
                                          <span key={ti}>{tok.text}</span>
                                        )
                                      )
                                    : cl.text}
                                </p>
                                {lang === "cn" && cl.pinyin && <p className="text-[11px] text-teal-600">{cl.pinyin}</p>}
                                {translationShown && cl.textJa && <p className="text-[11px] text-slate-500">{cl.textJa}</p>}
                                <div className="flex items-center gap-2">
                                  <button onClick={() => speak(cl.text)} aria-label="音声を聞く" className="w-7 h-7 rounded-full flex items-center justify-center bg-white border border-slate-200 text-slate-500">
                                    <Volume2 size={14} />
                                  </button>
                                  {cl.textJa && (
                                    <button
                                      onClick={() =>
                                        setShownCorrectionTranslations((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(key)) next.delete(key);
                                          else next.add(key);
                                          return next;
                                        })
                                      }
                                      aria-label="日本語訳を表示/非表示"
                                      className={`relative w-7 h-7 rounded-full flex items-center justify-center border ${
                                        translationShown ? "bg-teal-700 border-teal-700 text-white" : "bg-white border-slate-200 text-slate-500"
                                      }`}
                                    >
                                      <Languages size={14} />
                                      {!translationShown && (
                                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                          <span className="w-[140%] h-[1.5px] bg-slate-400 rotate-45" />
                                        </span>
                                      )}
                                    </button>
                                  )}
                                  {cl.isDuplicate ? (
                                    <span className="text-[11px] text-slate-400">(前の添削と同じ内容)</span>
                                  ) : exactMatch ? (
                                    <span className="text-[11px] text-slate-400">✓ 辞書にあります</span>
                                  ) : savedLabel ? (
                                    <span className="text-[11px] text-emerald-700 font-medium">✓ {savedLabel} に保存しました</span>
                                  ) : (
                                    <button
                                      onClick={() => saveCorrection(key, cl)}
                                      disabled={isSaving}
                                      className="text-[11px] text-white bg-teal-700 rounded-lg px-2.5 py-1 disabled:opacity-50"
                                    >
                                      {isSaving ? "保存中…" : "＋辞書に入れる"}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {c.notes && c.notes.length > 0 && (
                          <div className="space-y-2 border-t border-slate-200 bg-white pt-1.5">
                            {c.notes.map((n, ni) => (
                              <p key={ni} className="text-xs text-slate-500">
                                {n.category && <span className="text-slate-600 font-medium">📝 {n.category}　</span>}
                                {n.text}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={onFinish} className="w-full min-h-[52px] bg-slate-800 text-white rounded-xl text-sm font-semibold">
        終了して復習画面に戻る
      </button>
    </div>
  );
}
