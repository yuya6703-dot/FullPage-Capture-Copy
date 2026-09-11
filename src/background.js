'use strict';

/* ============================================================================
 * FullPage Capture & Copy — Service Worker (Manifest V3)
 * ---------------------------------------------------------------------------
 * 全体の司令塔。以下の順序で処理を進める。
 *
 *   1. アイコンクリックを検知 (chrome.action.onClicked)
 *   2. Content Script を注入し、ページの寸法を計測
 *   3. Offscreen ドキュメントで結合セッションを開始
 *   4. 「スクロール → 描画待ち → captureVisibleTab → Offscreen へ1コマ転送」を
 *      最下部までループ（2コマ目以降は fixed / sticky 要素を非表示）
 *   5. ページの状態（スクロール位置・固定要素）を復元
 *   6. Offscreen が PNG 化した画像を数MBずつ分割して Content Script へ転送
 *   7. Content Script がクリップボードへ書き込み、トーストを表示
 *
 * Service Worker は Canvas / Clipboard / DOM を一切持たない。そのため
 * 「重い画像処理は Offscreen」「クリップボードとUIは Content Script」と
 * 役割を分担させている。
 *
 * 画像データは必ず「1コマ」または「数MBのチャンク」単位でやり取りする。
 * 結合後の PNG を1つのメッセージで送ると、縦に長いページでは拡張機能
 * メッセージのサイズ上限を超えて失敗するため。
 * ========================================================================= */

const CONTENT_SCRIPT_FILE = 'src/content.js';
const OFFSCREEN_DOCUMENT = 'src/offscreen.html';

/**
 * メッセージ仕様のバージョン。Content Script / Offscreen と一致しなければ作り直す。
 * ファイルを更新しても拡張機能をリロードするまで古いコードがタブに残るため、
 * 「未知のアクション」で失敗する代わりに自動で入れ替える。
 */
const PROTOCOL_VERSION = 2;

/* --- 撮影チューニング用パラメータ ---------------------------------------- */

/** スクロール後、遅延描画（アニメーション・遅延読込）が落ち着くのを待つ時間 */
const SETTLE_MS = 150;

/**
 * captureVisibleTab は「約2回/秒」のクォータを持つ（拡張機能全体で共有）。
 * これを下回るとエラーになるため、最低間隔を空けてから撮影する。
 * （待機中にページのレンダリングも進むので、実質的なロスは小さい）
 */
const MIN_CAPTURE_INTERVAL_MS = 520;

/** クォータ超過時のリトライ回数 */
const CAPTURE_RETRY_MAX = 5;

/** 暴走防止：無限スクロールページなどで撮り続けないための安全弁 */
const MAX_FRAMES = 80;

/* --- メッセージ定義（Content Script / Offscreen と共有する語彙） ---------- */

const MSG = {
  // Content Script
  PING: 'PING',
  GET_PAGE_METRICS: 'GET_PAGE_METRICS',
  BEGIN_CAPTURE: 'BEGIN_CAPTURE',
  END_CAPTURE: 'END_CAPTURE',
  TOGGLE_FIXED_ELEMENTS: 'TOGGLE_FIXED_ELEMENTS',
  SCROLL_TO: 'SCROLL_TO',
  RECEIVE_IMAGE_CHUNK: 'RECEIVE_IMAGE_CHUNK',
  COPY_TO_CLIPBOARD: 'COPY_TO_CLIPBOARD',
  SHOW_TOAST: 'SHOW_TOAST',
  // Offscreen
  STITCH_BEGIN: 'STITCH_BEGIN',
  STITCH_ADD_FRAME: 'STITCH_ADD_FRAME',
  STITCH_FINISH: 'STITCH_FINISH',
  STITCH_READ_CHUNK: 'STITCH_READ_CHUNK',
};

/**
 * 実行中のキャプチャのタブID。
 * captureVisibleTab のクォータも Offscreen ドキュメントも拡張機能全体で
 * 1つしか無いため、タブをまたいでも同時には1件しか処理しない。
 */
let activeCaptureTabId = null;

/* ==========================================================================
 * エントリポイント
 * ======================================================================== */

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;

  if (activeCaptureTabId !== null) {
    // 撮影中のタブにトーストを出すと、そのトースト自体が次のコマに写り込む。
    // 同じタブの連打は黙って無視し、別タブからの要求にだけ案内を出す。
    if (tab.id !== activeCaptureTabId) {
      notify(tab.id, 'キャプチャを処理中です。完了までお待ちください', 'info');
    }
    return;
  }

  activeCaptureTabId = tab.id;
  captureAndCopy(tab)
    .catch((err) => {
      console.error('[FullPage Capture & Copy]', err);
      return reportFailure(tab.id, err);
    })
    .finally(() => {
      activeCaptureTabId = null;
      setBadge(tab.id, '');
    });
});

/**
 * 撮影〜クリップボードコピーまでの一連の流れ。
 */
async function captureAndCopy(tab) {
  assertCapturableUrl(tab.url);
  await ensureContentScript(tab.id, tab.url);
  setBadge(tab.id, '···', '#2563eb');

  await ensureOffscreenDocument();
  try {
    let capture;
    await sendToTab(tab.id, { action: MSG.BEGIN_CAPTURE });
    try {
      const metrics = await sendToTab(tab.id, { action: MSG.GET_PAGE_METRICS });
      assertValidMetrics(metrics);
      await beginStitchSession(metrics);
      capture = await captureFrames(tab.id, metrics);
    } finally {
      // 撮影が途中で失敗しても、ページは必ず元の状態へ戻す (Task 2.4)
      await sendToTab(tab.id, { action: MSG.END_CAPTURE }).catch(() => {});
    }

    setBadge(tab.id, '···', '#7c3aed');
    const image = await sendToOffscreen({
      action: MSG.STITCH_FINISH,
      coveredHeight: capture.coveredHeight,
    });

    const copyResult = await transferImageToTab(tab.id, image.chunkCount);

    // deferred = フォーカスが無く「クリック待ち」に切り替わったケース。
    // その場合の案内トーストは Content Script 側が既に出しているので何もしない。
    if (!copyResult || !copyResult.deferred) {
      notify(tab.id, buildSuccessMessage(image, capture), 'success');
    }
  } finally {
    // 巨大な Canvas / PNG を抱えたままにしない
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

function buildSuccessMessage(image, capture) {
  const notes = [];
  if (image.downscaled) notes.push('上限のため縮小: ' + image.width + '×' + image.height);
  if (capture.truncated) notes.push('末尾まで撮影できませんでした');
  return notes.length ? 'コピーしました（' + notes.join(' / ') + '）' : 'コピーしました';
}

/* ==========================================================================
 * Phase 2: スクロール & 連続キャプチャ (Task 2.3)
 * ======================================================================== */

/**
 * 最上部から最下部まで、ビューポート単位でスクロールしながら撮影し、
 * 1コマ撮るごとに Offscreen へ転送する。
 *
 * y は「実際にスクロールできた位置」。ページ末尾では要求値より小さくなるため、
 * 結合時のズレを防ぐには要求値ではなく実測値を持ち回るのが重要。
 *
 * @returns {Promise<{frameCount: number, coveredHeight: number, truncated: boolean}>}
 */
async function captureFrames(tabId, metrics) {
  const totalHeight = metrics.totalHeight;
  const viewportHeight = metrics.viewportHeight;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);

  let frameCount = 0;
  let lastY = -1;
  let target = 0;

  while (frameCount < MAX_FRAMES) {
    const scrolled = await sendToTab(tabId, { action: MSG.SCROLL_TO, y: target });
    const y = scrolled.y;

    // overflow:hidden などでページがスクロールできない場合、要求値に関わらず
    // 実測値が進まない。同じ画面を撮り続けないよう「前回より進んだか」で判定する。
    if (frameCount > 0 && y <= lastY) break;

    // 撮影の直前に「そのスクロール位置で実際に貼り付いている要素」を隠し直す (Task 2.2)。
    //   - コマごとに再評価する → 途中から貼り付く sticky も取りこぼさず、
    //     貼り付きが解除された要素は表示に戻る
    //   - first（1コマ目）の扱いは Content Script 側が決める。window モードでは
    //     何も隠さず固定ヘッダーを先頭に1回だけ残し、要素モードでは本文を覆う
    //     オーバーレイだけを隠す
    await sendToTab(tabId, { action: MSG.TOGGLE_FIXED_ELEMENTS, hide: true, first: frameCount === 0 });
    await delay(SETTLE_MS);

    // captureVisibleTab は「ウィンドウのアクティブタブ」を撮る。
    // 撮影中にタブを切り替えられると別ページが混ざるため、毎コマ確認する。
    const windowId = await assertTabStillActive(tabId);
    const dataUrl = await captureViewport(windowId);
    await sendToOffscreen({ action: MSG.STITCH_ADD_FRAME, dataUrl, y });

    frameCount++;
    lastY = y;

    if (y >= maxScroll - 1) break; // 最下部まで到達
    target = Math.min(maxScroll, y + viewportHeight);
  }

  return {
    frameCount,
    // 実際に撮影できた範囲の高さ。途中で打ち切った場合は totalHeight より小さくなる
    coveredHeight: Math.min(totalHeight, lastY + viewportHeight),
    truncated: lastY < maxScroll - 1,
  };
}

async function assertTabStillActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('撮影中にタブが切り替えられたため中断しました');
  return tab.windowId;
}

/** 直近の撮影時刻（クォータ制御用） */
let lastCaptureAt = 0;

/**
 * クォータ超過を吸収しつつ表示領域を撮影する。
 */
async function captureViewport(windowId) {
  const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await delay(wait);

  for (let attempt = 0; attempt < CAPTURE_RETRY_MAX; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      return dataUrl;
    } catch (err) {
      // クォータ以外のエラー（権限不足・最小化中など）は即座に失敗させる
      if (!/quota|MAX_CAPTURE/i.test(errorMessage(err))) throw err;
      await delay(250 * (attempt + 1));
    }
  }
  throw new Error('画面の撮影に繰り返し失敗しました（captureVisibleTab のクォータ超過）');
}

/* ==========================================================================
 * Phase 3: Offscreen ドキュメントでの結合と、結果の転送
 * ======================================================================== */

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
  });
  if (contexts.length > 0) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: ['BLOBS'],
        justification: '複数のスクリーンショットを Canvas で1枚のPNGに結合するため',
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

/**
 * 結合セッションを開始する。Offscreen が古い版なら作り直して再試行する。
 */
async function beginStitchSession(metrics) {
  let res = await sendToOffscreen({ action: MSG.STITCH_BEGIN, metrics });
  if (res.protocol === PROTOCOL_VERSION) return;
  await chrome.offscreen.closeDocument().catch(() => {});
  await ensureOffscreenDocument();
  res = await sendToOffscreen({ action: MSG.STITCH_BEGIN, metrics });
  if (res.protocol !== PROTOCOL_VERSION) {
    throw new Error('Offscreen の版が一致しません。chrome://extensions で拡張機能をリロードしてください');
  }
}

/**
 * Offscreen が保持する PNG を数MBずつ取り出し、Content Script へ中継する。
 * 最後に COPY_TO_CLIPBOARD で「全チャンク揃った」ことを伝えて書き込ませる。
 */
async function transferImageToTab(tabId, chunkCount) {
  for (let index = 0; index < chunkCount; index++) {
    const chunk = await sendToOffscreen({ action: MSG.STITCH_READ_CHUNK, index });
    await sendToTab(tabId, {
      action: MSG.RECEIVE_IMAGE_CHUNK,
      index,
      count: chunkCount,
      base64: chunk.base64,
    });
  }
  return sendToTab(tabId, { action: MSG.COPY_TO_CLIPBOARD });
}

/* ==========================================================================
 * 共通ユーティリティ
 * ======================================================================== */

/**
 * Content Script が生きているか確認し、居なければ注入する。
 * 拡張機能をリロードした直後は「ページ側のフラグは残っているがリスナーは死んでいる」
 * 状態になり得るため、フラグではなく PING の応答で判定する。
 */
async function ensureContentScript(tabId, url) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: MSG.PING });
    if (pong && pong.ok && pong.protocol === PROTOCOL_VERSION) return;
    // 応答はあるが古い版 → 再注入（新しいスクリプトが古いリスナーを破棄する）
  } catch (_) {
    // 未注入 or コンテキスト無効 → 下で注入する
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  } catch (err) {
    // file:// はユーザーが明示的に許可しない限り注入できない。原因が分かる文言にする
    if (/^file:/i.test(url || '')) {
      throw new Error(
        'file:// のページを撮るには、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可する」を有効にしてください'
      );
    }
    throw err;
  }
  const pong = await chrome.tabs.sendMessage(tabId, { action: MSG.PING });
  if (!pong || pong.protocol !== PROTOCOL_VERSION) {
    throw new Error('Content Script の版が一致しません。chrome://extensions で拡張機能をリロードしてください');
  }
}

async function sendToTab(tabId, message) {
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (res && res.error) throw new Error(res.error);
  return res;
}

async function sendToOffscreen(message) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  if (!res) throw new Error('Offscreen ドキュメントから応答がありません');
  if (res.error) throw new Error(res.error);
  return res;
}

/** Content Script が居れば通知し、居なければ黙って諦める */
function notify(tabId, message, variant) {
  return chrome.tabs
    .sendMessage(tabId, { action: MSG.SHOW_TOAST, message, variant })
    .catch(() => {});
}

/**
 * chrome:// や Chrome ウェブストアなど、拡張機能が触れないページを弾く。
 */
function assertCapturableUrl(url) {
  if (!url) throw new Error('タブのURLを取得できませんでした');
  if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
    if (/^https:\/\/chromewebstore\.google\.com/i.test(url) ||
        /^https:\/\/chrome\.google\.com\/webstore/i.test(url)) {
      throw new Error('Chrome ウェブストア上では拡張機能を実行できません');
    }
    return;
  }
  throw new Error('このページ（chrome:// などの内部ページ）ではキャプチャできません');
}

/**
 * Content Script が返した寸法が壊れていないか確認する。
 * 0 や NaN のまま進むと Offscreen 側で Canvas 生成が例外になり、原因が分かりにくい。
 */
function assertValidMetrics(metrics) {
  const keys = ['totalHeight', 'viewportWidth', 'viewportHeight', 'captureWidth', 'captureHeight'];
  for (const key of keys) {
    const value = metrics && metrics[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('ページの寸法を取得できませんでした (' + key + '=' + value + ')');
    }
  }
}

/**
 * 失敗の通知。トーストを出せる状況ならトーストで、
 * それも無理ならアイコンのバッジとツールチップで知らせる。
 */
async function reportFailure(tabId, err) {
  const message = errorMessage(err);
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: MSG.SHOW_TOAST,
      message: '失敗: ' + message,
      variant: 'error',
    });
  } catch (_) {
    setBadge(tabId, '!', '#dc2626');
    setTitle(tabId, '失敗: ' + message);
    setTimeout(() => {
      setBadge(tabId, '');
      setTitle(tabId, chrome.runtime.getManifest().action.default_title);
    }, 6000);
  }
}

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  } catch (_) {
    // タブが閉じられている場合などは無視
  }
}

function setTitle(tabId, title) {
  try {
    chrome.action.setTitle({ tabId, title }).catch(() => {});
  } catch (_) {
    // 同上
  }
}

function errorMessage(err) {
  return String((err && err.message) || err);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
