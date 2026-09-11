'use strict';

/* ============================================================================
 * FullPage Capture & Copy — Content Script
 * ---------------------------------------------------------------------------
 * ページ本体の中で動く唯一のコンポーネント。以下を担当する。
 *
 *   - ページ寸法の計測              (Task 2.1)
 *   - fixed / sticky 要素の一時退避 (Task 2.2)
 *   - スクロール実行とスクロール位置の復元 (Task 2.3 / 2.4)
 *   - 分割転送された PNG の受信とクリップボードへの書き込み (Task 3.3)
 *   - 完了トーストの表示             (Task 4.1)
 *
 * クリップボード書き込みをここで行う理由:
 *   navigator.clipboard.write() は「ドキュメントがフォーカスされていること」を
 *   要求する。不可視の Offscreen ドキュメントは決してフォーカスを持てないため、
 *   フォーカスを持ちうるページ本体で実行する必要がある。
 * ========================================================================= */

(() => {
  // --- 二重注入対策 -------------------------------------------------------
  // 拡張機能をリロードすると「ページ側のフラグは残っているが、リスナーが
  // 属するコンテキストは無効」という状態が起こる。フラグで早期 return すると
  // 復旧不能になるため、古いリスナーを破棄してから登録し直す方式にする。
  try {
    if (window.__FPCC__ && typeof window.__FPCC__.dispose === 'function') {
      window.__FPCC__.dispose();
    }
  } catch (_) {
    /* 無効化済みコンテキストの後始末は失敗しても構わない */
  }

  /**
   * メッセージ仕様のバージョン。Service Worker と一致しない場合は再注入される。
   * （ファイルを更新しても拡張機能をリロードするまで古いコードが残るため）
   */
  const PROTOCOL_VERSION = 2;

  const STYLE_ID = '__fpcc_capture_style__';
  const TOAST_ATTR = 'data-fpcc-toast';
  const HIDDEN_ATTR = 'data-fpcc-hidden';

  /** 内側のスクロール領域を撮影対象とみなすための、ビューポートに対する最小面積比 */
  const MIN_SCROLLER_AREA_RATIO = 0.25;

  /**
   * 撮影中の状態。beginCapture で決定し endCapture で破棄する。
   *   el            … スクロールさせる要素（null なら window）
   *   region        … 撮影画像から切り出す範囲（CSSピクセル、ビューポート基準）
   *   contentOffset … 領域の上端が、スクロール内容の何px目に当たるか（通常 0）
   *   stickTop/Bottom … sticky 要素が貼り付く上下の辺（要素モードでは要素の client 領域）
   */
  let capture = null;
  /**
   * 隠す候補の要素リスト（撮影開始後に一度だけ走査してキャッシュする）。
   * 各要素は {el, kind, hidden, prevValue, prevPriority} の形で復元情報を持つ。
   */
  let fixedCandidates = null;
  /** クリック待ちフォールバックの後始末関数 */
  let pendingCopyCleanup = null;
  /** 分割転送中の PNG（{count, parts: Uint8Array[]}） */
  let imageChunks = null;

  /* ========================================================================
   * Task 2.1: ページ寸法の計測
   * ====================================================================== */

  /**
   * scrollingElement は標準モードなら <html>、後方互換モードなら <body>。
   * window.scrollY の上限（scrollHeight - clientHeight）と必ず整合する要素なので、
   * html/body の各値の max を取るより正確で、末尾に白い余白が出ない。
   */
  function getScroller() {
    return document.scrollingElement || document.documentElement;
  }

  /** ビューポートの高さ（スクロールバーを除く）。後方互換モードでも正しい要素から取る */
  function getViewportHeight() {
    return getScroller().clientHeight;
  }

  /**
   * ページ本体の代わりにスクロールしている内側の要素を探す。
   *
   * ChatGPT などの SPA はページ本体が一切スクロールせず、内側の div が
   * 会話をスクロールしている。その場合 window.scrollTo は効かないため、
   * 「overflow-y が auto/scroll で、実際にスクロール可能で、画面の一定以上を
   * 占める要素」のうち、スクロール可能な量が最も大きいものを撮影対象にする。
   *
   * @returns {Element|null} null なら window をスクロールする
   */
  function findScrollTarget() {
    const root = getScroller();
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const minArea = vw * vh * MIN_SCROLLER_AREA_RATIO;

    let best = null;
    // ページ本体がスクロールできるなら、それを基準値にして「より大きく動く要素」だけを採用する
    let bestRange = Math.max(0, root.scrollHeight - root.clientHeight);

    for (const el of document.querySelectorAll('body *')) {
      // 安い判定を先に：スクロール可能量が基準以下ならスタイルは見ない
      const range = el.scrollHeight - el.clientHeight;
      if (range <= 1 || range <= bestRange) continue;

      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;

      const r = el.getBoundingClientRect();
      const visibleWidth = Math.min(r.right, vw) - Math.max(r.left, 0);
      const visibleHeight = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visibleWidth <= 0 || visibleHeight <= 0) continue;
      if (visibleWidth * visibleHeight < minArea) continue; // 小さなウィジェットは対象外

      best = el;
      bestRange = range;
    }
    return best;
  }

  /**
   * 結合に必要な寸法を一括で返す。
   *
   * viewportWidth/Height は撮影画像から切り出す領域（スクロールバーを除く）、
   * captureWidth/Height はスクロールバーを含む「撮影される画像の領域」。
   * この2つを分けておくことで、Offscreen 側でスクロールバーを切り落とせる。
   * （切り落とさないと、横スクロールバーの帯が結合画像の途中に何本も現れる）
   *
   * 要素モードでは領域が「その要素の画面内に見えている部分」になり、
   * regionLeft/Top が 0 以外になる。
   */
  function getPageMetrics() {
    if (!capture) throw new Error('撮影が開始されていません');
    const region = capture.region;
    const scrollHeight = capture.el ? capture.el.scrollHeight : getScroller().scrollHeight;
    return {
      mode: capture.el ? 'element' : 'window',
      totalHeight: scrollHeight - capture.contentOffset,
      viewportWidth: region.width,
      viewportHeight: region.height,
      regionLeft: region.left,
      regionTop: region.top,
      captureWidth: window.innerWidth,
      captureHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  /* ========================================================================
   * 撮影モードの開始 / 終了 (Task 2.4)
   * ====================================================================== */

  function beginCapture() {
    // 前回の実行が途中で終わっていた場合の残骸を片付ける
    disarmClickToCopy();
    imageChunks = null;
    if (capture) endCapture();

    const root = getScroller();
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const el = findScrollTarget();

    if (el) {
      // 境界線とスクロールバーを除いた client 領域のうち、画面内に見えている部分を撮る
      const r = el.getBoundingClientRect();
      const clientTop = r.top + el.clientTop;
      const clientLeft = r.left + el.clientLeft;
      const left = Math.max(clientLeft, 0);
      const top = Math.max(clientTop, 0);
      const right = Math.min(clientLeft + el.clientWidth, vw);
      const bottom = Math.min(clientTop + el.clientHeight, vh);

      capture = {
        el,
        region: { left, top, width: right - left, height: bottom - top },
        contentOffset: top - clientTop,
        stickTop: clientTop,
        stickBottom: clientTop + el.clientHeight,
        savedScroll: { x: window.scrollX, y: window.scrollY, elTop: el.scrollTop, elLeft: el.scrollLeft },
        prevScrollBehavior: {
          value: el.style.getPropertyValue('scroll-behavior'),
          priority: el.style.getPropertyPriority('scroll-behavior'),
        },
      };
      // 内側の要素の smooth スクロールも撮影中だけ無効化する
      el.style.setProperty('scroll-behavior', 'auto', 'important');
    } else {
      capture = {
        el: null,
        region: { left: 0, top: 0, width: vw, height: vh },
        contentOffset: 0,
        stickTop: 0,
        stickBottom: vh,
        savedScroll: { x: window.scrollX, y: window.scrollY },
        prevScrollBehavior: null,
      };
    }

    // scroll-behavior: smooth のページはスクロールが即座に完了せず、
    // 撮影がズレる。撮影中だけ auto に上書きする。
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = 'html, body { scroll-behavior: auto !important; }';
      document.documentElement.appendChild(style);
    }
    return { ok: true, mode: el ? 'element' : 'window' };
  }

  function endCapture() {
    toggleFixedElements(false);
    if (capture) {
      const saved = capture.savedScroll;
      if (capture.el) {
        capture.el.scrollTop = saved.elTop;
        capture.el.scrollLeft = saved.elLeft;
        const prev = capture.prevScrollBehavior;
        if (prev && prev.value) {
          capture.el.style.setProperty('scroll-behavior', prev.value, prev.priority);
        } else {
          capture.el.style.removeProperty('scroll-behavior');
        }
      }
      window.scrollTo(saved.x, saved.y);
      capture = null;
    }
    // スクロールを戻し終えてから scroll-behavior の上書きを解除する
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    return { ok: true };
  }

  /* ========================================================================
   * Task 2.3: スクロール実行
   * ====================================================================== */

  /**
   * 指定位置へスクロールし、"実際に到達した位置" を返す。
   * 末尾では要求値より小さくクランプされるため、この実測値を
   * そのまま結合時の Y 座標として使うことでズレを防げる。
   */
  async function scrollToY(y) {
    const el = capture && capture.el;
    if (el) {
      el.scrollTop = y;
    } else {
      // 横位置は触らない（横スクロール中のページでも撮影範囲が変わらないように）
      window.scrollTo(window.scrollX, y);
    }
    // レイアウト確定と描画を1フレームずつ待つ
    await nextFrame();
    await nextFrame();
    return { y: el ? el.scrollTop : window.scrollY };
  }

  /* ========================================================================
   * Task 2.2: fixed / sticky 要素の一時退避
   * ====================================================================== */

  /**
   * この要素を「今のスクロール位置で」隠すべきか判定する。
   *
   * 判定の基準は一貫して「この要素は複数のコマに重複して写り込むか」。
   * 見た目の再現よりも重複の排除を優先する（1枚の通し画像として読めることを重視）。
   *
   * @param {object} info 判定に必要な情報（算出スタイルと矩形を事前に取り出したもの）
   * @returns {boolean} true なら visibility: hidden を適用する
   */
  function shouldHideDuringCapture(info) {
    const rect = info.rect;
    // 撮影領域（window モードでは 0〜ビューポート高、要素モードではその要素の見えている範囲）
    const regionTop = info.regionTop !== undefined ? info.regionTop : 0;
    const regionBottom = info.regionBottom !== undefined ? info.regionBottom : info.viewportHeight;

    // 1) 元々見えていない要素は触らない。
    //    隠す意味がない上に、復元時に元のスタイルを壊すリスクだけが残る。
    if (info.visibility === 'hidden' || info.visibility === 'collapse') return false;
    if (parseFloat(info.opacity) === 0) return false;

    // 2) サイズを持たない要素（IntersectionObserver 用の sentinel、計測用ダミー等）。
    //    画面には写らないので対象外。
    if (rect.width < 2 || rect.height < 2) return false;

    // 3) このコマの撮影領域の外にある要素。そもそも写らないので触る必要がない。
    if (rect.bottom <= regionTop || rect.top >= regionBottom) return false;

    // 4) overlay = スクロール領域の DOM の外にあって領域に重なる要素（要素モードのみ）。
    //    入力欄や「最下部へ」ボタンなど。スクロールしても動かず、下の本文を毎コマ隠すので
    //    1コマ目から隠す。
    if (info.kind === 'overlay') return true;

    // 5) fixed は定義上つねにビューポートへ貼り付く＝全コマに重複して写る。
    //    全画面を覆うモーダルや Cookie バナーの暗幕もここで隠れるが、これは意図通り。
    //    隠さないと「暗幕越しのページ」が延々と続く画像になり、可読性が大きく落ちる。
    if (info.position === 'fixed') return true;

    // 6) sticky は「今このスクロール位置で実際に貼り付いているか」で決める。
    //    貼り付いていない sticky は通常フロー上にあり、そのコマにしか写らない。
    //    → ページ中腹の sticky なテーブルヘッダーは、
    //      「本来の位置に1回だけ写り、貼り付いている間は消える」という理想的な結果になる。
    //    1コマ目（スクロール位置 0）で貼り付いているものは本来の位置にあるので残す。
    if (info.position === 'sticky') return !info.first && isVerticallyStuck(info);

    return false;
  }

  /**
   * sticky 要素が「縦方向に」貼り付いているかを、貼り付く辺（stickTop/Bottom）と
   * inset との距離で判定する。
   * 結合は縦方向にしか行わないため、左右の sticky（固定列など）は重複しない＝対象外。
   */
  function isVerticallyStuck(info) {
    const rect = info.rect;
    const vh = info.viewportHeight;
    const stickTop = info.stickTop !== undefined ? info.stickTop : 0;
    const stickBottom = info.stickBottom !== undefined ? info.stickBottom : vh;

    const top = resolveInset(info.top, vh);
    if (top !== null && rect.top <= stickTop + top + 1) return true;

    const bottom = resolveInset(info.bottom, vh);
    if (bottom !== null && rect.bottom >= stickBottom - bottom - 1) return true;

    return false;
  }

  /** `top: 12px` / `top: 10%` / `top: auto` を px 数値（または null）に正規化する */
  function resolveInset(value, base) {
    if (!value || value === 'auto') return null;
    const n = parseFloat(value);
    if (Number.isNaN(n)) return null;
    return value.endsWith('%') ? (base * n) / 100 : n;
  }

  /**
   * 隠す候補をページ全体から一度だけ収集する。
   *
   *   - fixed / sticky な要素（両モード共通）
   *   - 要素モードではさらに、スクロール要素の DOM の外にあって撮影領域に重なる要素
   *     （= スクロールしても動かないオーバーレイ）。親が既に候補なら子は見ない
   *
   * getComputedStyle は要素数に比例して重い（数千要素で数百ms）ため、
   * 全走査はここ一回きり。以降のコマではこのリストだけを再評価する。
   */
  function collectFixedCandidates() {
    const list = [];
    const scrollEl = capture ? capture.el : null;
    const region = capture ? capture.region : null;

    for (const el of document.querySelectorAll('body *')) {
      if (!el.style) continue; // inline style を持たない要素は隠しようがない
      if (el.hasAttribute(TOAST_ATTR)) continue; // 自前のトーストは対象外

      if (scrollEl && !scrollEl.contains(el) && !el.contains(scrollEl)) {
        // スクロール要素の子孫でも祖先でもない → 領域に重なっていればオーバーレイ
        if (list.some((c) => c.kind === 'overlay' && c.el.contains(el))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const overlaps =
          r.right > region.left && r.left < region.left + region.width &&
          r.bottom > region.top && r.top < region.top + region.height;
        if (overlaps) list.push({ el, kind: 'overlay', hidden: false, prevValue: '', prevPriority: '' });
        continue;
      }

      const position = window.getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      list.push({ el, kind: position, hidden: false, prevValue: '', prevPriority: '' });
    }
    return list;
  }

  /**
   * 固定要素の非表示 / 復元を切り替える (Task 2.2)。
   *
   * hide=true は「今のスクロール位置に合わせてマスクを貼り直す」という意味で、
   * コマごとに呼ばれる。貼り付きが解除された要素はここで表示に戻る。
   *
   * first=true（1コマ目）の扱い:
   *   - window モード … 何も隠さない。固定ヘッダーは結合画像の先頭に1回だけ残す
   *   - 要素モード     … オーバーレイと fixed は隠す（本文を覆っているため）。sticky は残す
   *
   * display:none ではなく visibility:hidden を使うのが要点。
   * sticky 要素は通常フローの領域を占めるため display:none にすると
   * ページ全体の高さが変わり、計測済みの totalHeight とズレてしまう。
   * （visibility は矩形を保つので、隠したまま位置を測り直せるという利点もある）
   */
  function toggleFixedElements(hide, first) {
    if (!hide) return restoreFixedElements();
    if (!capture) throw new Error('撮影が開始されていません');
    if (first && !capture.el) return { ok: true, count: 0 };

    if (!fixedCandidates) fixedCandidates = collectFixedCandidates();

    // getPageMetrics と同じ要素から取る（後方互換モードで documentElement は当てにならない）
    const viewportHeight = getViewportHeight();
    const region = capture.region;
    let hiddenCount = 0;

    for (const record of fixedCandidates) {
      const el = record.el;
      if (!el.isConnected) continue; // 撮影中に DOM から外れた要素

      const style = window.getComputedStyle(el);
      const shouldHide = shouldHideDuringCapture({
        kind: record.kind,
        first: !!first,
        position: style.position,
        // 自分で隠した分は判定から除外する（さもないと二度と復帰できない）
        visibility: record.hidden ? 'visible' : style.visibility,
        opacity: style.opacity,
        top: style.top,
        bottom: style.bottom,
        rect: el.getBoundingClientRect(),
        viewportHeight,
        regionTop: region.top,
        regionBottom: region.top + region.height,
        stickTop: capture.stickTop,
        stickBottom: capture.stickBottom,
      });

      if (shouldHide && !record.hidden) {
        record.prevValue = el.style.getPropertyValue('visibility');
        record.prevPriority = el.style.getPropertyPriority('visibility');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.setAttribute(HIDDEN_ATTR, '');
        record.hidden = true;
      } else if (!shouldHide && record.hidden) {
        unhide(record);
      }

      if (record.hidden) hiddenCount++;
    }

    return { ok: true, count: hiddenCount };
  }

  function restoreFixedElements() {
    if (!fixedCandidates) return { ok: true, count: 0 };
    for (const record of fixedCandidates) {
      if (record.hidden) unhide(record);
    }
    fixedCandidates = null; // 次回の撮影では走査からやり直す
    return { ok: true, count: 0 };
  }

  function unhide(record) {
    const el = record.el;
    if (record.prevValue) {
      el.style.setProperty('visibility', record.prevValue, record.prevPriority);
    } else {
      el.style.removeProperty('visibility');
    }
    el.removeAttribute(HIDDEN_ATTR);
    record.hidden = false;
  }

  /* ========================================================================
   * Task 3.3: クリップボードへの書き込み
   * ====================================================================== */

  /**
   * 分割転送された PNG の1チャンクを受け取る。
   *
   * 各チャンクは 3 の倍数バイトで区切られているため base64 が独立しており、
   * 受け取った時点で個別にデコードできる。巨大な文字列を連結せずに済む。
   */
  function receiveImageChunk(index, count, base64) {
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error('チャンクの番号が不正です (' + index + '/' + count + ')');
    }
    if (!imageChunks || imageChunks.count !== count) {
      imageChunks = { count, parts: new Array(count) };
    }
    imageChunks.parts[index] = base64ToBytes(base64);
    return { ok: true };
  }

  /**
   * 受け取ったチャンクを1つの PNG にまとめ、クリップボードへ書き込む。
   *
   * ツールバーのアイコンをクリックした直後はページがフォーカスを失っている
   * ことがあり、その場合 navigator.clipboard.write() は NotAllowedError を
   * 投げる。復帰を少し待ち、それでも駄目ならユーザーのクリックを待つ
   * フォールバックへ切り替える（＝ deferred として返す）。
   */
  async function copyToClipboard() {
    if (!imageChunks) throw new Error('画像データを受信していません');
    const chunks = imageChunks;
    imageChunks = null; // 成否に関わらず受信バッファは使い切る

    const missing = [];
    for (let i = 0; i < chunks.count; i++) {
      if (!chunks.parts[i]) missing.push(i);
    }
    if (missing.length) throw new Error('画像データが欠けています (chunk ' + missing.join(',') + ')');

    // http:// など安全でないコンテキストでは navigator.clipboard 自体が存在しない。
    // その場合はクリック待ちに移っても永久に成功しないので、明確なエラーで終える。
    assertClipboardAvailable();

    const blob = new Blob(chunks.parts, { type: 'image/png' });
    try {
      await writeImageToClipboard(blob);
      return { ok: true, deferred: false };
    } catch (err) {
      if (isFocusError(err)) {
        // フォーカスが戻れば成功する種類の失敗 → クリック待ちへ
        armClickToCopy(blob);
        return { ok: true, deferred: true, reason: errorMessage(err) };
      }
      // それ以外（巨大画像の展開失敗など）は待っても直らない → ファイル保存に切り替える
      const name = saveAsDownload(blob, err);
      return { ok: true, deferred: true, fallback: 'download', file: name, reason: errorMessage(err) };
    }
  }

  function assertClipboardAvailable() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
      throw new Error('このページではクリップボード API が使えません（HTTPS でないページでは画像をコピーできません）');
    }
  }

  async function writeImageToClipboard(blob) {
    if (!document.hasFocus()) {
      window.focus();
      await waitForFocus(600);
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  /** Chrome は「Document is not focused.」という NotAllowedError で失敗する */
  function isFocusError(err) {
    return !!err && err.name === 'NotAllowedError' && /focus/i.test(errorMessage(err));
  }

  /**
   * クリップボードに書けなかったときの最終手段。PNG をダウンロードとして保存する。
   * 撮影結果を失わないことを最優先にしている（撮り直しには数十秒かかる）。
   *
   * @returns {string} 保存したファイル名
   */
  function saveAsDownload(blob, cause) {
    // ローカル時刻で fullpage-YYYYMMDD-HHMMSS.png
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const name = 'fullpage-' + stamp + '.png';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    // すぐ revoke するとダウンロードが始まる前に無効になることがある
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    showToast(
      'クリップボードへ書き込めなかったため、ファイルに保存しました\n' + name +
      (cause ? '\n（理由: ' + errorMessage(cause) + '）' : ''),
      'info',
      { duration: 10000 }
    );
    return name;
  }

  /**
   * フォーカス不足でコピーできなかったときの救済措置。
   * ページがフォーカスを取り戻す（クリック or ウィンドウ復帰）まで待って書き込む。
   * それでも駄目なら、または時間切れならファイル保存に切り替える。
   */
  function armClickToCopy(blob) {
    disarmClickToCopy();

    const toast = showToast('ページをクリックするとコピーします', 'info', { persist: true });
    let settled = false;

    const retry = async () => {
      if (settled) return; // pointerdown と focus が連続して発火しても1回だけ
      settled = true;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        disarmClickToCopy();
        showToast('コピーしました', 'success');
      } catch (err) {
        disarmClickToCopy();
        saveAsDownload(blob, err);
      }
    };

    window.addEventListener('pointerdown', retry, { once: true, capture: true });
    window.addEventListener('focus', retry, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      disarmClickToCopy();
      saveAsDownload(blob, new Error('クリックを 15 秒待ちましたが、フォーカスが戻りませんでした'));
    }, 15000);

    pendingCopyCleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', retry, { capture: true });
      window.removeEventListener('focus', retry);
      if (toast && toast.isConnected) toast.remove();
      pendingCopyCleanup = null;
    };
  }

  function disarmClickToCopy() {
    if (pendingCopyCleanup) pendingCopyCleanup();
  }

  /**
   * base64 → Uint8Array。
   * fetch(dataUrl) でも変換できるが、ページの CSP に左右されない
   * atob ベースの手動デコードの方が Content Script では堅い。
   */
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /* ========================================================================
   * Task 4.1: 完了トースト
   * ====================================================================== */

  const TOAST_COLORS = {
    success: { bg: 'rgba(15, 23, 42, 0.94)', accent: '#38bdf8' },
    info: { bg: 'rgba(15, 23, 42, 0.94)', accent: '#fbbf24' },
    error: { bg: 'rgba(69, 10, 10, 0.94)', accent: '#f87171' },
  };

  /** 表示時間（ms）。エラーは読んで対処できる長さにする */
  const TOAST_DURATION = { success: 1800, info: 4000, error: 8000 };

  /**
   * 画面右上にトーストを表示する。
   *
   * ページ側の CSS の影響を完全に断つため Shadow DOM を使う。
   * ホスト要素の位置指定だけは inline style + !important で固める。
   */
  function showToast(message, variant, options) {
    const opts = options || {};
    // 既存のトーストは重ねずに置き換える
    const previous = document.querySelectorAll('[' + TOAST_ATTR + ']');
    for (const node of previous) node.remove();

    const host = document.createElement('div');
    host.setAttribute(TOAST_ATTR, '');
    const hostStyle = {
      position: 'fixed',
      top: '16px',
      right: '16px',
      width: 'auto',
      height: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      'z-index': '2147483647',
      'pointer-events': 'none',
    };
    for (const key of Object.keys(hostStyle)) {
      host.style.setProperty(key, hostStyle[key], 'important');
    }

    const palette = TOAST_COLORS[variant] || TOAST_COLORS.success;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '.toast {',
      '  display: flex; align-items: center; gap: 8px;',
      '  max-width: 380px; padding: 10px 14px;',
      '  border-radius: 10px;',
      '  background: ' + palette.bg + ';',
      '  color: #f8fafc;',
      '  font: 500 13px/1.5 -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN",',
      '        "Yu Gothic UI", Meiryo, sans-serif;',
      '  letter-spacing: .01em;',
      '  box-shadow: 0 8px 24px rgba(0,0,0,.28);',
      '  white-space: pre-wrap;',
      '}',
      '.dot {',
      '  flex: none; width: 8px; height: 8px; border-radius: 50%;',
      '  background: ' + palette.accent + ';',
      '}',
    ].join('\n');

    const box = document.createElement('div');
    box.className = 'toast';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = message;
    box.append(dot, label);
    root.append(style, box);
    document.documentElement.appendChild(host);

    // ページの CSS アニメーションと衝突しない Web Animations API を使う
    const duration = opts.duration || TOAST_DURATION[variant] || TOAST_DURATION.success;
    if (opts.persist) {
      box.animate(
        [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 160, easing: 'ease-out', fill: 'forwards' }
      );
    } else {
      const anim = box.animate(
        [
          { opacity: 0, transform: 'translateY(-8px) scale(.98)' },
          // 表示時間が長くても、出入りのアニメーションは同じ長さ（約180ms / 360ms）に保つ
          { opacity: 1, transform: 'none', offset: Math.min(0.1, 180 / duration) },
          { opacity: 1, transform: 'none', offset: 1 - Math.min(0.2, 360 / duration) },
          { opacity: 0, transform: 'translateY(-8px)' },
        ],
        { duration, easing: 'ease-out', fill: 'forwards' }
      );
      anim.finished.then(() => host.remove()).catch(() => host.remove());
    }
    return host;
  }

  /* ========================================================================
   * メッセージハンドラ
   * ====================================================================== */

  async function handleMessage(msg) {
    switch (msg.action) {
      case 'PING':
        return { ok: true, protocol: PROTOCOL_VERSION };
      case 'GET_PAGE_METRICS':
        return getPageMetrics();
      case 'BEGIN_CAPTURE':
        return beginCapture();
      case 'END_CAPTURE':
        return endCapture();
      case 'SCROLL_TO':
        return scrollToY(msg.y);
      case 'TOGGLE_FIXED_ELEMENTS':
        return toggleFixedElements(msg.hide, msg.first);
      case 'RECEIVE_IMAGE_CHUNK':
        return receiveImageChunk(msg.index, msg.count, msg.base64);
      case 'COPY_TO_CLIPBOARD':
        return copyToClipboard();
      case 'SHOW_TOAST':
        showToast(msg.message, msg.variant);
        return { ok: true };
      default:
        return { error: '未知のアクション: ' + msg.action };
    }
  }

  const onMessage = (msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== 'string') return;
    if (msg.target === 'offscreen') return; // Offscreen 宛は無視
    handleMessage(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: errorMessage(err) }));
    return true; // 非同期応答を行う
  };

  chrome.runtime.onMessage.addListener(onMessage);

  window.__FPCC__ = {
    dispose() {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch (_) { /* 無効コンテキスト */ }
      try {
        disarmClickToCopy();
        imageChunks = null;
        endCapture(); // 途中で止まっていた場合のページ復元
      } catch (_) { /* ページ側は既に元通りの可能性がある */ }
    },
  };

  /* --- 小さなヘルパー ---------------------------------------------------- */

  /**
   * 次の描画フレームを待つ。
   * タブが非表示だと requestAnimationFrame は永久に発火しないため、
   * タイムアウトを併用して Service Worker 側を待たせ続けないようにする。
   */
  function nextFrame() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function errorMessage(err) {
    return String((err && err.message) || err);
  }

  function waitForFocus(timeoutMs) {
    if (document.hasFocus()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value) => {
        window.removeEventListener('focus', onFocus);
        clearTimeout(timer);
        resolve(value);
      };
      const onFocus = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      window.addEventListener('focus', onFocus, { once: true });
    });
  }
})();
