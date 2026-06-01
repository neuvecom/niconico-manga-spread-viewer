// ニコニコ漫画 見開きビューア — content script
// 縦スクロールの canvas ページを取得し、見開きレイアウトで再表示する。
// 仕組み: サイトが描画した clean な canvas を toDataURL でスナップショットし、
//         独自のオーバーレイで2ページずつ並べて表示する（DRMの解除や保存は行わない）。
(() => {
  'use strict';
  if (window.__nmvLoaded) return;
  window.__nmvLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const WIDE_RATIO = 1.15; // 横/縦がこれを超えるページは「見開き1枚絵」とみなし単独全幅表示

  const state = {
    pages: [],      // 取得済みページ画像 (dataURL)
    dims: [],       // 各ページの寸法 {w,h}（縦横比で見開き1枚絵を判定）
    spreads: [],    // 見開き割り。各要素は [a,b] / [a] で、要素値は ページ番号 or null(空白)
    index: 0,       // 現在の見開きインデックス
    rtl: true,      // 右綴じ(右→左)。日本の漫画は基本これ
    blanks: new Set([1]), // 空白挿入位置。i ∈ blanks = 「ページ i の直前に空白」。既定の{1}=表紙単独
    spread: true,   // true=見開き / false=単ページ
  };

  // デバッグ用: 取得結果をコンソールから確認できるよう state を公開
  window.__nmv = state;

  // ---------------------------------------------------------------------------
  // ページ取得（キャプチャ）
  // ---------------------------------------------------------------------------

  // canvas に実際に描画済みか（生成直後は全ピクセル alpha=0）
  function canvasHasContent(c) {
    if (!c || !c.width || !c.height) return false;
    const t = document.createElement('canvas');
    t.width = Math.min(c.width, 32);
    t.height = Math.min(c.height, 32);
    const tx = t.getContext('2d');
    try {
      tx.drawImage(c, 0, 0, t.width, t.height);
      const d = tx.getImageData(0, 0, t.width, t.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
      return false;
    } catch (e) {
      return true; // 汚染されていた場合は「描画済み」とみなす
    }
  }

  // setTimeout ベースでポーリング（rAF はタブが非表示だと停止するため使わない）
  function waitForNoteCanvas(note, timeout = 6000, interval = 80) {
    return new Promise((resolve) => {
      const start = performance.now();
      (function poll() {
        const c = note.querySelector('canvas');
        if (c && canvasHasContent(c)) return resolve(c);
        if (performance.now() - start > timeout) return resolve(c && c.width ? c : null);
        setTimeout(poll, interval);
      })();
    });
  }

  async function captureNote(note, timeout) {
    note.scrollIntoView({ block: 'center' });
    await sleep(70); // 遅延レンダラに描画機会を与える
    const canvas = await waitForNoteCanvas(note, timeout);
    if (!canvas) return null;
    try {
      return { url: canvas.toDataURL('image/jpeg', 0.92), w: canvas.width, h: canvas.height };
    } catch (e) {
      return null;
    }
  }

  // niconico はページ(.note)を遅延読み込みするため、まず最下部まで段階的に
  // スクロールして全 .note を DOM に出現させる。件数が増えなくなったら完了。
  async function loadAllNotes(onCount) {
    const scroller = $('#page_contents');
    const viewport = () => (scroller ? scroller.clientHeight : window.innerHeight);
    const maxScroll = () => (scroller ? scroller.scrollHeight : document.documentElement.scrollHeight);
    const setScroll = (y) => { if (scroller) scroller.scrollTop = y; else window.scrollTo(0, y); };

    let pos = 0;
    let lastCount = -1;
    let stable = 0;
    for (let i = 0; i < 600; i++) {
      pos += viewport() * 0.9;
      setScroll(pos);
      await sleep(160);
      const count = $$('#page_contents .note').length;
      if (onCount) onCount(count);
      if (count === lastCount) stable++;
      else { stable = 0; lastCount = count; }
      // 最下部に到達し、かつ件数が数回連続で変わらなければ全ページ読み込み完了
      const atBottom = pos >= maxScroll() - viewport() - 4;
      if (atBottom && stable >= 4) break;
    }
    return $$('#page_contents .note');
  }

  async function captureAllPages(onLoad, onProgress) {
    const scroller = $('#page_contents');
    const prevScroll = scroller ? scroller.scrollTop : window.scrollY;

    // まず全ページを DOM に読み込ませてから取得対象を確定する
    const notes = await loadAllNotes(onLoad);
    const total = notes.length;
    const pages = new Array(total).fill(null);
    const dims = new Array(total).fill(null);

    const store = (i, cap) => {
      if (cap) { pages[i] = cap.url; dims[i] = { w: cap.w, h: cap.h }; }
    };

    // 1巡目
    for (let i = 0; i < total; i++) {
      store(i, await captureNote(notes[i], 6000));
      onProgress(i + 1, total);
    }

    // 2巡目: 取りこぼし（描画ラグ等）をリトライ。canvasは描画済みのはずなので長めに待つ
    for (let pass = 0; pass < 2; pass++) {
      const missing = pages.map((p, i) => (p ? null : i)).filter((i) => i !== null);
      if (missing.length === 0) break;
      for (const i of missing) {
        store(i, await captureNote(notes[i], 9000));
      }
    }

    if (scroller) scroller.scrollTop = prevScroll;
    else window.scrollTo(0, prevScroll);
    return { pages, dims };
  }

  // ---------------------------------------------------------------------------
  // 見開き割り
  // ---------------------------------------------------------------------------

  // 空白(null)を差し込んだページ並び（読み順）を作る
  function buildSeq() {
    const n = state.pages.length;
    const seq = [];
    for (let i = 0; i < n; i++) {
      if (state.blanks.has(i)) seq.push(null); // ページ i の直前に空白
      seq.push(i);
    }
    return seq;
  }

  // 横長ページ = サイトが見開きを1枚絵として配信しているもの。単独・全幅で表示する。
  function isWide(i) {
    const d = state.dims[i];
    return !!(d && d.h > 0 && d.w / d.h > WIDE_RATIO);
  }

  function rebuildSpreads(keepPage) {
    const n = state.pages.length;
    const spreads = [];
    if (!state.spread) {
      for (let i = 0; i < n; i++) spreads.push([i]); // 単ページ時は空白を無視
    } else {
      const seq = buildSeq();
      let cur = [];
      for (const p of seq) {
        if (p != null && isWide(p)) {
          if (cur.length) { spreads.push(cur); cur = []; } // 作りかけのペアを確定
          spreads.push([p]); // 見開き1枚絵は単独
          continue;
        }
        cur.push(p);
        if (cur.length === 2) { spreads.push(cur); cur = []; }
      }
      if (cur.length) spreads.push(cur);
    }
    state.spreads = spreads;
    if (keepPage != null) {
      const idx = spreads.findIndex((s) => s.includes(keepPage));
      state.index = idx >= 0 ? idx : Math.min(state.index, spreads.length - 1);
    }
  }

  // ---------------------------------------------------------------------------
  // ビューアUI
  // ---------------------------------------------------------------------------

  let overlay = null;

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'nmv-overlay';
    overlay.innerHTML = `
      <div class="nmv-stage" id="nmv-stage"></div>
      <div class="nmv-zone nmv-zone-left"  id="nmv-zone-left"></div>
      <div class="nmv-zone nmv-zone-right" id="nmv-zone-right"></div>
      <button class="nmv-topclose" id="nmv-topclose" title="閉じて通常ページへ戻る (Esc)">✕ 閉じる</button>
      <div class="nmv-bar">
        <button class="nmv-btn" id="nmv-prev" title="前へ">◀ 前</button>
        <span class="nmv-indicator" id="nmv-indicator">-</span>
        <button class="nmv-btn" id="nmv-next" title="次へ">次 ▶</button>
        <span class="nmv-sep"></span>
        <button class="nmv-btn" id="nmv-spread" title="見開き / 単ページ (S)">単ページ</button>
        <button class="nmv-btn" id="nmv-rtl" title="綴じ方向 (R)">右綴じ</button>
        <button class="nmv-btn" id="nmv-shift" title="この見開きから組み合わせを1つずらす (D)。もう一度で戻す">⇔ ずらす</button>
        <button class="nmv-btn" id="nmv-shift-reset" title="ずらしをすべて解除">ずらし解除</button>
        <span class="nmv-sep"></span>
        <span class="nmv-hint">←→/Space: 送り　D: ずらす　Esc: 閉じる</span>
        <button class="nmv-btn nmv-close" id="nmv-close" title="閉じる (Esc)">✕</button>
      </div>
    `;
    document.body.appendChild(overlay);

    $('#nmv-prev', overlay).addEventListener('click', () => go(-1));
    $('#nmv-next', overlay).addEventListener('click', () => go(1));
    $('#nmv-close', overlay).addEventListener('click', close);
    $('#nmv-topclose', overlay).addEventListener('click', close);
    $('#nmv-spread', overlay).addEventListener('click', toggleSpread);
    $('#nmv-rtl', overlay).addEventListener('click', toggleRtl);
    $('#nmv-shift', overlay).addEventListener('click', toggleShiftHere);
    $('#nmv-shift-reset', overlay).addEventListener('click', resetShifts);

    // クリックゾーン: 右綴じなら左クリック=次、右クリック=前
    $('#nmv-zone-left', overlay).addEventListener('click', () => go(state.rtl ? 1 : -1));
    $('#nmv-zone-right', overlay).addEventListener('click', () => go(state.rtl ? -1 : 1));

    document.addEventListener('keydown', onKey, true);
    syncButtons();
  }

  function isOpen() {
    return overlay && overlay.classList.contains('nmv-open');
  }

  function open() {
    if (!overlay) buildOverlay();
    overlay.classList.add('nmv-open');
    document.documentElement.style.overflow = 'hidden';
    render();
  }

  function close() {
    if (overlay) overlay.classList.remove('nmv-open');
    document.documentElement.style.overflow = '';
  }

  function go(delta) {
    state.index = Math.max(0, Math.min(state.spreads.length - 1, state.index + delta));
    render();
  }

  // 現在の見開きで最初に表示されている「実ページ」（空白nullは飛ばす）
  function currentFirstPage() {
    const s = state.spreads[state.index] || [];
    const real = s.find((x) => x != null);
    return real == null ? 0 : real;
  }

  function toggleSpread() {
    const keep = currentFirstPage();
    state.spread = !state.spread;
    rebuildSpreads(keep);
    syncButtons();
    render();
  }

  function toggleRtl() {
    state.rtl = !state.rtl;
    syncButtons();
    render();
  }

  // 現在の見開きの先頭ページの直前に空白を入れる/外す（= そのページ以降を1つずらす）
  function toggleShiftHere() {
    if (!state.spread) { toggleSpread(); } // 単ページ中は見開きに戻してから
    let p = currentFirstPage();
    if (p < 1) p = 1; // 先頭ページの前(=表紙の綴じ)を対象にする
    if (state.blanks.has(p)) state.blanks.delete(p);
    else state.blanks.add(p);
    rebuildSpreads(p);
    syncButtons();
    render();
  }

  function resetShifts() {
    const keep = currentFirstPage();
    state.blanks.clear();
    rebuildSpreads(keep);
    syncButtons();
    render();
  }

  function syncButtons() {
    if (!overlay) return;
    const spreadBtn = $('#nmv-spread', overlay);
    const rtlBtn = $('#nmv-rtl', overlay);
    spreadBtn.textContent = state.spread ? '見開き' : '単ページ';
    rtlBtn.textContent = state.rtl ? '右綴じ' : '左綴じ';
    spreadBtn.classList.toggle('nmv-on', state.spread);
    rtlBtn.classList.toggle('nmv-on', state.rtl);
    const shiftBtn = $('#nmv-shift', overlay);
    const resetBtn = $('#nmv-shift-reset', overlay);
    shiftBtn.style.display = state.spread ? '' : 'none';
    resetBtn.style.display = state.spread && state.blanks.size > 0 ? '' : 'none';
  }

  function onKey(e) {
    if (!isOpen()) return;
    switch (e.key) {
      case 'Escape': close(); break;
      case 'ArrowLeft': state.rtl ? go(1) : go(-1); e.preventDefault(); break;
      case 'ArrowRight': state.rtl ? go(-1) : go(1); e.preventDefault(); break;
      case ' ':
      case 'PageDown': go(1); e.preventDefault(); break;
      case 'PageUp': go(-1); e.preventDefault(); break;
      case 'Home': state.index = 0; render(); break;
      case 'End': state.index = state.spreads.length - 1; render(); break;
      case 's': case 'S': toggleSpread(); break;
      case 'r': case 'R': toggleRtl(); break;
      case 'd': case 'D': toggleShiftHere(); break;
      default: return;
    }
  }

  function render() {
    if (!overlay) return;
    const stage = $('#nmv-stage', overlay);
    stage.innerHTML = '';
    const pair = state.spreads[state.index] || [];
    let order = pair.slice();
    if (state.rtl) order = order.reverse(); // 右綴じ: 大きいページ番号を左に
    stage.classList.toggle('nmv-single', pair.filter((x) => x != null).length === 1);
    for (const pi of order) {
      if (pi == null) {
        const blank = document.createElement('div');
        blank.className = 'nmv-page nmv-blank';
        stage.appendChild(blank);
      } else if (!state.pages[pi]) {
        // 取得に失敗したページはプレースホルダを表示（壊れた画像アイコンを避ける）
        const ph = document.createElement('div');
        ph.className = 'nmv-page nmv-missing';
        ph.textContent = `ページ ${pi + 1} を取得できませんでした`;
        stage.appendChild(ph);
      } else {
        const img = document.createElement('img');
        img.className = 'nmv-page';
        img.src = state.pages[pi];
        img.alt = `page ${pi + 1}`;
        stage.appendChild(img);
      }
    }
    updateIndicator();
  }

  function updateIndicator() {
    const el = $('#nmv-indicator', overlay);
    const pair = state.spreads[state.index] || [];
    const total = state.pages.length;
    const nums = pair.filter((x) => x != null).map((x) => x + 1);
    el.textContent = (nums.length ? nums.join('-') : '-') + ` / ${total}`;
  }

  // ---------------------------------------------------------------------------
  // 進捗オーバーレイ & 起動ボタン
  // ---------------------------------------------------------------------------

  function showProgress() {
    let p = $('#nmv-progress');
    if (!p) {
      p = document.createElement('div');
      p.id = 'nmv-progress';
      p.className = 'nmv-progress';
      p.innerHTML = `
        <div class="nmv-progress-box">
          <div class="nmv-progress-title" id="nmv-progress-title">ページを取得中…</div>
          <div class="nmv-progress-track"><div class="nmv-progress-fill" id="nmv-progress-fill"></div></div>
          <div class="nmv-progress-text" id="nmv-progress-text">0 / 0</div>
        </div>`;
      document.body.appendChild(p);
    }
    p.style.display = 'flex';
    return p;
  }

  function setProgressTitle(t) {
    const el = $('#nmv-progress-title');
    if (el) el.textContent = t;
  }

  // 全ページ読み込み中（総数が未確定なので件数だけ表示）
  function updateLoading(count) {
    setProgressTitle('全ページを読み込み中…');
    const fill = $('#nmv-progress-fill');
    const text = $('#nmv-progress-text');
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = `${count} ページ`;
  }

  function updateProgress(done, total) {
    setProgressTitle('ページを取得中…');
    const fill = $('#nmv-progress-fill');
    const text = $('#nmv-progress-text');
    if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
    if (text) text.textContent = `${done} / ${total}`;
  }

  function hideProgress() {
    const p = $('#nmv-progress');
    if (p) p.style.display = 'none';
  }

  let capturing = false;

  async function launch() {
    if (capturing) return; // 取得中の二重起動を防ぐ
    if (state.pages.length > 0) {
      open();
      return;
    }
    if (!$('#page_contents .note')) {
      alert('漫画ページが見つかりません。ログイン済みの作品ページで実行してください。');
      return;
    }
    capturing = true;
    showProgress();
    try {
      const { pages, dims } = await captureAllPages(updateLoading, updateProgress);
      state.pages = pages;
      state.dims = dims;
      rebuildSpreads(0);
      // デバッグ: 各ページの取得結果(dataURL長と寸法)を DOM 属性に書き出す。
      // isolated world のため window 経由では見えないので、DOM 共有を使う。
      try {
        const dbg = pages.map((p, i) => ({
          i: i + 1,
          len: p ? p.length : 0,
          w: dims[i] ? dims[i].w : 0,
          h: dims[i] ? dims[i].h : 0,
        }));
        document.documentElement.setAttribute('data-nmv-debug', JSON.stringify(dbg));
        console.log('[見開きビューア] 取得結果', dbg);
      } catch (e) {}
    } catch (e) {
      console.error('[見開きビューア] 取得エラー', e);
      alert('ページ取得中にエラーが発生しました。コンソールを確認してください。');
      hideProgress();
      return;
    } finally {
      capturing = false;
    }
    hideProgress();
    const ok = state.pages.filter(Boolean).length;
    if (ok === 0) {
      alert('ページ画像を取得できませんでした。タブを前面にした状態でもう一度お試しください。');
      return;
    }
    if (ok < state.pages.length) {
      const missing = state.pages
        .map((p, i) => (p ? null : i + 1))
        .filter((n) => n !== null)
        .join(', ');
      alert(`${state.pages.length}ページ中 ${ok}ページを取得しました。\n取得できなかったページ: ${missing}\n（タブを前面にしたまま再実行すると取得できることがあります）`);
    }
    open();
  }

  function addLaunchButton() {
    if ($('#nmv-launch')) return;
    const btn = document.createElement('button');
    btn.id = 'nmv-launch';
    btn.className = 'nmv-launch';
    btn.textContent = '📖 見開き表示';
    btn.title = 'このページを見開きレイアウトで表示';
    btn.addEventListener('click', launch);
    document.body.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // 初期化（#page_contents が現れるまで待つ）
  // ---------------------------------------------------------------------------

  function init() {
    if ($('#page_contents')) {
      addLaunchButton();
      return;
    }
    const obs = new MutationObserver(() => {
      if ($('#page_contents')) {
        addLaunchButton();
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // フォールバック
    setTimeout(() => {
      if ($('#page_contents')) addLaunchButton();
    }, 3000);
  }

  init();
})();
