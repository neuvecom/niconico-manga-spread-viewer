# canvasビューアのDOMを読み解いて「見開き表示」Chrome拡張を作った話

> 個人的な閲覧体験を良くするために、自分が普段読んでいる漫画ビューア（縦スクロール表示）を、手元で**見開き2ページレイアウト**に並べ替えて読めるようにしたときの技術メモです。
> コンテンツの保存・再配布や保護の回避を目的としたものではなく、**自分が閲覧中のページを見やすく表示するだけ**の話として書いています。記事中の画面例はすべて自作の図に置き換えています。

## きっかけ

縦スクロールのビューアを、紙の本のように**2ページ見開き**で読みたくなりました。やることはシンプルで、

1. サイトが各ページを描画している `<canvas>` をそのままスナップショットする
2. 取得した画像を2枚ずつ並べてフルスクリーンで表示する

…はずだったのですが、実際には**「見開きの片側が出ない」「ページが飛ぶ」「4Kだと小さい」**など、表に出てこない罠が次々に出てきました。この記事はその**デバッグの過程**が主役です。Chrome拡張＋canvasビューアを触る人には、どれも汎用的に役立つはずです。

技術スタックは Chrome 拡張（Manifest V3）のコンテンツスクリプト＋少しのCSSだけです。

---

## 罠1：コンテンツスクリプトの値がコンソールから見えない（isolated world）

取得結果をデバッグしようと、コンテンツスクリプト側で

```js
window.__myState = state;
```

としてコンソールから `window.__myState` を見ようとしたら…**`undefined`**。

原因は、コンテンツスクリプトが**ページとは別のJavaScript世界（isolated world）**で動くこと。`window` オブジェクトが分離されているので、コンテンツスクリプトで `window` に生やした値は、DevToolsコンソール（既定ではページ側のworld）からは見えません。

**DOMは共有される**ので、デバッグ情報をやり取りしたいときは `window` ではなく**DOM属性に書き出す**のが手軽です。

```js
// コンテンツスクリプト側（isolated world）
document.documentElement.setAttribute('data-debug', JSON.stringify(info));
```

```js
// コンソール（page world）からはDOM経由で読める
JSON.parse(document.documentElement.dataset.debug);
```

> 教訓：**isolated world と page world は `window` が別物。橋渡しは共有されているDOMで。**

---

## 罠2：ページが遅延読み込みされる ＆ 描画が「途中」で撮れてしまう

### 全ページがDOMに無い

取得を実行しても後半のページが欠ける。調べると、ビューアは**スクロールするまで `.note`（ページ要素）をDOMに追加しない**遅延読み込みでした。起動直後に存在するページだけを対象にしていたので、当然取りこぼします。

対策は単純で、**取得前に最下部まで段階的にスクロールして全ページをDOMに出現させてから**取得対象を確定します。「ページ数が増えなくなったら完了」で判定しました。

```js
async function loadAllPages() {
  let last = -1, stable = 0;
  for (let i = 0; i < 600; i++) {
    window.scrollBy(0, window.innerHeight * 0.9);
    await sleep(160);
    const n = document.querySelectorAll('.note').length;
    if (n === last) stable++; else { stable = 0; last = n; }
    if (atBottom() && stable >= 4) break; // 数回連続で変化なし＝出揃った
  }
}
```

### 描画の途中で撮ってしまう

それでも一部のページが**半分白い**。canvasは段階的に描画されるため、「少しでも内容があれば描画済み」と判定して即スナップショットすると、**描き終わる前の状態**を撮ってしまうのでした。

そこで「内容があるか」ではなく**「見た目が変化しなくなったか」**で判定します。canvas全体を小さく縮小した“指紋”を一定間隔で取り、**連続2回一致したら描画完了**とみなしてから撮ります。

```js
function signature(canvas) {
  const t = document.createElement('canvas');
  t.width = t.height = 48;
  const c = t.getContext('2d');
  c.drawImage(canvas, 0, 0, 48, 48);
  return c.getImageData(0, 0, 48, 48).data.join(',');
}

// 安定するまで待つ
let prev = signature(canvas);
const start = performance.now();
while (performance.now() - start < 2500) {
  await sleep(150);
  const cur = signature(canvas);
  if (cur === prev) break; // 変化が止まった
  prev = cur;
}
```

> 教訓：**遅延読み込み＆遅延描画のcanvasは「存在する」だけでなく「変化が止まった」まで待つ。**

---

## 罠3：これが本丸。「見開きページ」だけDOM構造が違った

一番ハマったのがこれです。症状は **「見開きのページだけ、右半分が取れず幅が半分になる」**。

最初は「待てば広がるのでは」「縦横比を見れば判別できるのでは」と色々試したのですが、全部空振り。**取得データを直接見たら全ページ正常に撮れている**ことが分かり、原因は取得ではなく**構造の見落とし**でした。

DevToolsでDOMを比べたら一目瞭然でした（以下は構造を簡略化した自作の図解です）。

**通常ページ：**

```html
<li class="page">
  <div class="note" style="width: 650px; height: 924px;">
    <canvas width="650" height="924"></canvas>  <!-- 本体canvasは1枚 -->
    <canvas class="balloon canvas" ...></canvas> <!-- コメント描画用 -->
  </div>
</li>
```

**見開きページ：**

```html
<li class="page spread">                          <!-- class に spread -->
  <div class="note" style="width: 1300px; ...">   <!-- noteが2倍幅！ -->
    <canvas width="650" height="924"></canvas>     <!-- 左半分 -->
    <canvas width="650" height="924"></canvas>     <!-- 右半分 -->
    <canvas class="balloon canvas" ...></canvas>
    <canvas class="balloon canvas" ...></canvas>
  </div>
</li>
```

つまり見開きは「**1枚の広い画像**」ではなく、**幅1300pxの要素の中に650pxのcanvasが左右2枚**入っていたのです。こちらは

```js
note.querySelector('canvas') // ← 最初の1枚（＝左半分）しか取れていなかった
```

としていたので、右半分が丸ごと無視されていました。「幅が650になる」も「右半分が出ない」も、全部これ1つが原因。

修正は、**本体canvasを全部集めて横に連結**するだけ（コメント用の `.balloon canvas` は除外）。

```js
// 本体canvasだけ集める（コメント用canvasは除外）
const canvases = [...note.querySelectorAll('canvas:not(.balloon)')];

if (canvases.length === 1) {
  // 通常ページ
  return canvases[0].toDataURL('image/jpeg', 0.92);
}

// 見開き：左→右の順に連結して1枚にする
const totalW = canvases.reduce((s, c) => s + c.width, 0);
const out = document.createElement('canvas');
out.width = totalW;
out.height = Math.max(...canvases.map(c => c.height));
const ctx = out.getContext('2d');
let x = 0;
for (const c of [...canvases].sort((a, b) => a.offsetLeft - b.offsetLeft)) {
  ctx.drawImage(c, x, 0);
  x += c.width;
}
return out.toDataURL('image/jpeg', 0.92);
```

連結後の画像は横長になるので、ビューア側は**横長＝見開き1枚**として全幅表示するだけ。通常ページは従来どおり2枚並べ。これで意図どおりになりました。

> 教訓：**「取得が壊れている」ように見えても、まず“取得済みデータそのもの”を確認する。原因が取得ではなく構造の読み違いだったというのはよくある。** そして DOM は素直に正解を持っていることが多い。

---

## 仕上げ：4Kで小さい問題（`max-*` では拡大されない）

最後の細かいやつ。元画像が等倍（例：650×924）だと、4Kモニタのフルスクリーンで小さく見えます。

```css
/* これだと「上限」を決めるだけ。原寸より大きくはならない */
.page {
  max-width: 50%;
  max-height: 100%;
}
```

`max-*` は縮小はしても**拡大はしない**ので、ウィンドウに合わせて引き伸ばすには明示的にサイズを与えます。

```css
.page {
  height: 100%;       /* 高さいっぱいに拡大（原寸超えOK） */
  width: auto;
  max-width: 50%;     /* 横にはみ出す場合だけ抑える */
  object-fit: contain;
}
```

高さ基準で拡大し、横が溢れる場合だけ `max-width` で抑える、という組み合わせ。漫画の線画なら標準のスムージング拡大でも十分実用に耐えます。

> 教訓：**「ウィンドウに合わせて拡大」したいなら `max-*` ではなく `height`/`width` を明示する。`max-*` は上限なので拡大はしてくれない。**

---

## まとめ

派手な機能は何も無くて、ハマりどころは全部「**観測と前提の確認**」に集約されました。

- isolated world ⇄ page world は `window` が別物。橋渡しはDOMで
- 遅延読み込み・遅延描画は「出揃う」「変化が止まる」まで待つ
- 「取得が壊れた」と思ったら、まず取得済みデータと**DOM構造そのもの**を見る
- `max-*` は拡大しない

特に罠3は、思い込み（「広い画像が取れていないはず」）でしばらく迷走しました。**実データとDOMを愚直に確認する**のが結局一番の近道でした。同じようにcanvasベースのビューアを触る人の役に立てば嬉しいです。

---

*※ 本ツールは個人が自分の閲覧体験を改善するためのもので、コンテンツの保存・再配布や保護の回避を目的とするものではありません。各サービスの利用規約の範囲でご利用ください。*
