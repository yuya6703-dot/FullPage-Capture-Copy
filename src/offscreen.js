'use strict';

/* ============================================================================
 * FullPage Capture & Copy — Offscreen Document
 * ---------------------------------------------------------------------------
 * Service Worker は DOM も Canvas も持たないため、画像の結合だけをここで行う。
 *
 * 1回のキャプチャ = 1セッション。
 *   STITCH_BEGIN      … 寸法を受け取りセッション開始
 *   STITCH_ADD_FRAME  … 1コマずつ受け取り、その場で Canvas に描画して破棄
 *   STITCH_FINISH     … PNG 化し、チャンク数を返す
 *   STITCH_READ_CHUNK … PNG を数MBずつ base64 で返す
 *
 * 全コマをまとめて受け取らず1コマずつ処理するのは、メッセージサイズと
 * メモリの両方を抑えるため（全コマの ImageBitmap を同時に持つと数百MBになる）。
 * ========================================================================= */

/** Chrome の 2D Canvas の1辺の上限 */
const MAX_CANVAS_DIMENSION = 16384;

/**
 * Canvas の総面積の上限（ピクセル数）。
 * Chrome 自体は 2^28 まで許すが、それは RGBA で 1GB のメモリになり、
 * PNG 化と転送も現実的でない。64M px（≒256MB）で打ち切って縮小する。
 */
const MAX_CANVAS_AREA = 64 * 1024 * 1024;

/**
 * 転送チャンクのバイト数。3 の倍数にしておくと各チャンクの base64 が
 * パディング無しで独立し、受信側が1チャンクずつデコードできる。
 */
const CHUNK_BYTES = 6 * 1024 * 1024;

/** 現在のセッション */
let session = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 自分宛て以外（Content Script 宛など）には応答しない
  if (!msg || msg.target !== 'offscreen') return;

  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
  return true; // 非同期応答
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'STITCH_BEGIN':
      return beginSession(msg.metrics);
    case 'STITCH_ADD_FRAME':
      return addFrame(msg.dataUrl, msg.y);
    case 'STITCH_FINISH':
      return finishSession(msg.coveredHeight);
    case 'STITCH_READ_CHUNK':
      return readChunk(msg.index);
    default:
      return { error: '未知のアクション: ' + msg.action };
  }
}

/* ==========================================================================
 * セッション
 * ======================================================================== */

function beginSession(metrics) {
  if (!metrics || !(metrics.captureWidth > 0) || !(metrics.totalHeight > 0)) {
    throw new Error('ページの寸法が不正です');
  }
  session = {
    metrics,
    canvas: null,
    ctx: null,
    k: 1,             // CSSピクセル → 出力ピクセル の変換係数（= scale × shrink）
    scale: 1,         // 撮影画像 ÷ CSSピクセル（= DPR × ブラウザズーム）
    shrink: 1,        // Canvas 上限を超えた場合の縮小率
    frameCount: 0,
    blob: null,
  };
  return { ok: true };
}

/**
 * 1コマを Canvas に描画する (Task 3.2)。
 *
 * @param {string} dataUrl 撮影画像
 * @param {number} y       このコマの実測スクロール位置（CSSピクセル）
 */
async function addFrame(dataUrl, y) {
  const s = requireSession();
  if (!Number.isFinite(y) || y < 0) throw new Error('コマの Y 座標が不正です');

  const bitmap = await createImageBitmap(await fetch(dataUrl).then((r) => r.blob()));
  try {
    if (!s.canvas) createCanvas(s, bitmap.width);

    const m = s.metrics;
    // 撮影画像からスクロールバー部分を除いた領域だけを切り出す
    const sw = Math.min(bitmap.width, Math.round(m.viewportWidth * s.scale));
    const sh = Math.min(bitmap.height, Math.round(m.viewportHeight * s.scale));

    // 上端と下端を「同じ丸め関数」から導くのが要点。
    //   dy = round(y × k), 下端 = round((y + ビューポート高) × k)
    // とすれば、次のコマの dy = round((y + ビューポート高) × k) と必ず一致し、
    // 1px の隙間（結合画像に走る白い横線）も重なりも原理的に発生しない。
    const dy = Math.round(y * s.k);
    const dBottom = Math.round((y + m.viewportHeight) * s.k);
    const dw = Math.max(1, Math.round(m.viewportWidth * s.k));
    const dh = Math.max(1, dBottom - dy);

    s.ctx.drawImage(bitmap, 0, 0, sw, sh, 0, dy, dw, dh);
    s.frameCount++;
  } finally {
    bitmap.close(); // GC 待ちにせず即座に解放する
  }
  return { ok: true };
}

/**
 * 1コマ目の実寸から出力スケールを決め、Canvas を確保する。
 */
function createCanvas(s, bitmapWidth) {
  const m = s.metrics;

  // 実測スケール = 撮影画像の幅 ÷ CSSピクセル幅。
  // devicePixelRatio をそのまま信じるより堅い（ブラウザズームも吸収できる）。
  s.scale = bitmapWidth / m.captureWidth;

  const fullWidth = m.viewportWidth * s.scale;
  const fullHeight = m.totalHeight * s.scale;

  // Canvas 上限に対するフォールバック（非機能要件の「堅牢性」）
  s.shrink = Math.min(
    1,
    MAX_CANVAS_DIMENSION / fullWidth,
    MAX_CANVAS_DIMENSION / fullHeight,
    Math.sqrt(MAX_CANVAS_AREA / (fullWidth * fullHeight))
  );
  s.k = s.scale * s.shrink;

  const width = Math.max(1, Math.round(m.viewportWidth * s.k));
  const height = Math.max(1, Math.round(m.totalHeight * s.k));

  s.canvas = new OffscreenCanvas(width, height);
  s.ctx = s.canvas.getContext('2d', { alpha: false });
  // 透明の隙間が残らないよう下地を白で塗る
  s.ctx.fillStyle = '#ffffff';
  s.ctx.fillRect(0, 0, width, height);
  s.ctx.imageSmoothingQuality = 'high';
}

/**
 * PNG 化して転送準備を整える (Task 3.3 前半)。
 *
 * @param {number} coveredHeight 実際に撮影できた高さ（CSSピクセル）。
 *   途中で打ち切られた場合は totalHeight より小さく、その分を切り落とす。
 */
async function finishSession(coveredHeight) {
  const s = requireSession();
  if (!s.canvas || s.frameCount === 0) throw new Error('結合対象の画像がありません');

  let canvas = s.canvas;
  const coveredPx = Math.round(coveredHeight * s.k);
  if (Number.isFinite(coveredPx) && coveredPx > 0 && coveredPx < canvas.height) {
    // 撮影できなかった末尾の白い余白を切り落とす
    const cropped = new OffscreenCanvas(canvas.width, coveredPx);
    cropped.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
    canvas = cropped;
  }

  s.blob = await canvas.convertToBlob({ type: 'image/png' });
  // Canvas は用済み。転送中のメモリを抑えるため先に手放す
  s.canvas = null;
  s.ctx = null;

  return {
    width: canvas.width,
    height: canvas.height,
    downscaled: s.shrink < 1,
    byteLength: s.blob.size,
    chunkCount: Math.ceil(s.blob.size / CHUNK_BYTES),
  };
}

/**
 * PNG の index 番目のチャンクを base64 で返す。
 */
async function readChunk(index) {
  const s = requireSession();
  if (!s.blob) throw new Error('PNG がまだ生成されていません');

  const start = index * CHUNK_BYTES;
  if (!Number.isInteger(index) || index < 0 || start >= s.blob.size) {
    throw new Error('チャンク番号が不正です: ' + index);
  }
  const part = s.blob.slice(start, Math.min(s.blob.size, start + CHUNK_BYTES));
  return { base64: await blobToBase64(part) };
}

function requireSession() {
  if (!session) throw new Error('結合セッションが開始されていません');
  return session;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('base64 への変換に失敗しました'));
    reader.readAsDataURL(blob);
  });
}
