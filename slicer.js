document.addEventListener('DOMContentLoaded', () => {

// ── TOAST ───────────────────────────────────────────────────
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 2200);
}

// ── SAFE CLIPBOARD (works in Chrome extension side panel) ───
function safeCopy(str, toastMsg, callback){
  function onSuccess(){
    if(toastMsg) toast(toastMsg);
    if(callback) callback();
  }
  function onFail(){
    toast('コピー失敗 — テキストを手動で選択してください');
  }

  // Method 1: Clipboard API (needs focus + user activation)
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(str).then(onSuccess).catch(() => {
      execCopyFallback(str, onSuccess, onFail);
    });
  } else {
    execCopyFallback(str, onSuccess, onFail);
  }
}

function execCopyFallback(str, onSuccess, onFail){
  const ta = document.createElement('textarea');
  ta.value = str;
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:99999';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, str.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch(e){ /* ignore */ }
  document.body.removeChild(ta);
  if(ok) onSuccess(); else onFail();
}


const ENC = new TextEncoder();
const COLORS = [
  [74,243,176],[74,184,243],[243,162,74],[212,74,243],
  [243,74,114],[243,233,74],[74,243,117],[100,142,255],
  [255,128,74],[74,220,255]
];
const rgba = (i,a) => `rgba(${COLORS[i%COLORS.length].join(',')},${a})`;
const rgb  = (i)   => `rgb(${COLORS[i%COLORS.length].join(',')})`;

function fmtB(n){
  if(!n) return '0 B';
  if(n < 1024) return n + ' B';
  if(n < 1048576) return (n/1024).toFixed(n>=10240?1:2) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}

// ── STATE ──────────────────────────────────────────────────
// cuts: sorted array of pixel positions in document space.
// Segments are the gaps: [0 → cuts[0]], [cuts[0] → cuts[1]], ..., [cuts[n-1] → totalH]
// activeBottomPx: the bottom of the "active blind" being dragged (not yet locked)
// The active blind always starts from cuts[cuts.length-1] (or 0 if no cuts)

let text = '';
let cuts = [];            // locked cut positions in px (sorted ascending)
let activeBottomPx = 0;   // where the current draggable blind ends
let dragging = null;      // {type:'cut'|'active', idx?:number, startY, startVal, startScroll}
let autoRaf = null;
let cutChars = [];        // char indices corresponding to each cut (canonical state)
let activeBottomChar = 0; // char index for active bottom (canonical state)

const txtEl      = document.getElementById('txt');
const scroller   = document.getElementById('scroller');
const scrollInner= document.getElementById('scrollInner');
const overlay    = document.getElementById('overlay');

const DEFAULT_BYTES = 3.8 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024; // hard cap — user cannot drag beyond 4 KB

// ── HEIGHT SYNC ────────────────────────────────────────────
function syncHeights(){
  txtEl.style.height = 'auto';
  const h = txtEl.scrollHeight;
  txtEl.style.height = h + 'px';
  scrollInner.style.height = h + 'px';
  overlay.style.height = h + 'px';
}

// ── MIRROR DIV for accurate px → char mapping ──────────────
let mirror = null;

function ensureMirror(){
  if(mirror) return;
  mirror = document.createElement('div');
  const cs = window.getComputedStyle(txtEl);
  const s = mirror.style;
  s.position    = 'absolute';
  s.top         = '0';
  s.left        = '0';
  s.opacity     = '0';
  s.pointerEvents = 'none';
  s.zIndex      = '-1';
  s.whiteSpace  = 'pre-wrap';
  s.wordBreak   = 'break-word';
  s.overflowWrap= 'break-word';
  s.fontFamily  = cs.fontFamily;
  s.fontSize    = cs.fontSize;
  s.lineHeight  = cs.lineHeight;
  s.padding     = cs.padding;
  s.width       = txtEl.offsetWidth + 'px';
  s.boxSizing   = 'border-box';
  scrollInner.insertBefore(mirror, overlay);
}

function syncMirror(){
  ensureMirror();
  mirror.textContent = text;
  mirror.style.width = txtEl.offsetWidth + 'px';
}

// Convert char index → document-space Y (top of that char's line)
function charToDocY(charIdx){
  if(!mirror || !text.length) return 0;
  const node = mirror.firstChild;
  if(!node) return 0;
  const safe = Math.max(0, Math.min(charIdx, text.length - 1));
  const range = document.createRange();
  range.setStart(node, safe);
  range.setEnd(node, Math.min(text.length, safe + 1));
  const charRect  = range.getBoundingClientRect();
  const mirrorTop = mirror.getBoundingClientRect().top;
  return charRect.top - mirrorTop; // offset within mirror = document Y (mirror is at top:0)
}

// Convert document-space Y → nearest char index (binary search)
function pxToChar(docY){
  if(!mirror || !text.length) return 0;
  if(docY <= 0) return 0;
  const totalH = mirror.scrollHeight;
  // If within 40px of bottom, return full length
  if(docY >= totalH - 40) return text.length;

  let lo = 0, hi = text.length;
  while(lo < hi - 1){
    const mid = (lo + hi) >> 1;
    if(charToDocY(mid) <= docY) lo = mid;
    else hi = mid;
  }
  return lo;
}

function pxForBytes(startPx, targetBytes){
  const startChar = pxToChar(startPx);
  let acc = 0, i = startChar;
  const step = 50;
  while(i < text.length && acc < targetBytes){
    const end = Math.min(text.length, i + step);
    acc += ENC.encode(text.slice(i, end)).length;
    i = end;
  }
  if(i >= text.length) return mirror ? mirror.scrollHeight : txtEl.scrollHeight;
  return charToDocY(i);
}

function bytesInRange(startPx, endPx){
  const totalH = txtEl.scrollHeight;
  const cs = pxToChar(startPx);
  // If endPx is at/near bottom, grab everything to end
  const ce = (endPx >= totalH - 40) ? text.length : pxToChar(endPx);
  return {
    bytes  : ENC.encode(text.slice(cs, ce)).length,
    chars  : ce - cs,
    content: text.slice(cs, ce)
  };
}

function syncCharState(){
  cutChars = cuts.map(px => pxToChar(px));
  activeBottomChar = pxToChar(activeBottomPx);
}

// ── RENDER ─────────────────────────────────────────────────
function render(){
  overlay.innerHTML = '';
  if(!text) return;

  const totalH = txtEl.scrollHeight;
  // all boundaries: 0, ...cuts, activeBottomPx (if > last cut), totalH
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;

  // ── Draw locked segments (between cuts)
  const borders = [0, ...cuts];
  borders.forEach((startPx, i) => {
    const endPx = i < cuts.length ? cuts[i] : activeBottomPx;
    if(endPx <= startPx) return;
    const {bytes, chars} = bytesInRange(startPx, endPx);
    const hPct = ((endPx - startPx) / totalH) * 100;

    // band
    const band = document.createElement('div');
    band.className = 'seg-band';
    band.style.cssText = `top:${startPx}px;height:${endPx-startPx}px;`;
    band.innerHTML = `
      <div class="seg-fill" style="background:${rgba(i,.38)}"></div>
      <div class="seg-badge">
        <div class="seg-swatch" style="background:${rgb(i)}"></div>
        <span class="seg-kb">${fmtB(bytes)}</span>
        <span class="seg-meta">#${i+1} · ${chars.toLocaleString()} chars</span>
      </div>
      <div class="seg-size-corner">${fmtB(bytes)}<span class="seg-size-corner-sub">${chars.toLocaleString()} chars</span></div>`;
    overlay.appendChild(band);
  });

  // ── Draw active blind (from lastCut to activeBottomPx)
  const activeTop = lastCut;
  const activeBot = activeBottomPx;
  if(activeBot > activeTop){
    const ci = cuts.length; // color index for active
    const {bytes, chars} = bytesInRange(activeTop, activeBot);
    const atLimit = bytes >= MAX_CHUNK_BYTES;
    const nearLimit = bytes >= MAX_CHUNK_BYTES * 0.9;
    const badgeColor = atLimit ? '#c0392b' : nearLimit ? '#c05a00' : '#0F5599';
    const limitLabel = atLimit ? ' · MAX' : nearLimit ? ' · near max' : '';
    const activeBand = document.createElement('div');
    activeBand.className = 'seg-band';
    activeBand.style.cssText = `top:${activeTop}px;height:${activeBot-activeTop}px;`;
    activeBand.innerHTML = `
      <div class="seg-fill" style="background:${rgba(ci,.42)}"></div>
      <div class="seg-badge" style="border-color:rgba(${atLimit?'192,57,43':'15,85,153'},.3)">
        <div class="seg-swatch" style="background:${rgb(ci)}"></div>
        <span class="seg-kb" style="color:${badgeColor}">${fmtB(bytes)}${limitLabel}</span>
        <span class="seg-meta">#${ci+1} · ${chars.toLocaleString()} chars</span>
      </div>
      <div class="seg-size-corner" style="color:${badgeColor}">${fmtB(bytes)}<span class="seg-size-corner-sub">${chars.toLocaleString()} chars</span></div>`;
    overlay.appendChild(activeBand);
  }

  // ── Draw locked cut handles (all draggable, any can be resized)
  cuts.forEach((cutPx, idx) => {
    const h = document.createElement('div');
    h.className = 'cut-handle';
    h.style.top = cutPx + 'px';
    const prevPx = idx > 0 ? cuts[idx-1] : 0;
    const nextPx = idx < cuts.length-1 ? cuts[idx+1] : activeBottomPx;
    const {bytes: prevBytes} = bytesInRange(prevPx, cutPx);
    h.innerHTML = `
      <div class="cut-line"></div>
      <div class="cut-pill"></div>
      <span class="cut-tooltip">${fmtB(prevBytes)} from start of chunk</span>
      <button class="cut-del">✕</button>`;

    // delete cut
    h.querySelector('.cut-del').addEventListener('click', e => {
      e.stopPropagation();
      cuts.splice(idx, 1);
      render(); updateStats();
    });

    // drag cut handle
    h.addEventListener('mousedown', e => {
      if(e.target.classList.contains('cut-del')) return;
      e.preventDefault(); e.stopPropagation();
      dragging = {
        type: 'cut', idx,
        startY: e.clientY,
        startVal: cutPx,
        startScroll: scroller.scrollTop
      };
      document.body.style.cursor = 'ns-resize';
    });

    overlay.appendChild(h);
  });

  // ── Draw active bottom handle (drag to extend active blind)
  if(activeBottomPx < totalH){
    const ah = document.createElement('div');
    ah.className = 'active-handle';
    ah.style.top = activeBottomPx + 'px';
    ah.innerHTML = `
      <div class="active-line"></div>
      <div class="active-pill"></div>`;

    ah.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      dragging = {
        type: 'active',
        startY: e.clientY,
        startVal: activeBottomPx,
        startScroll: scroller.scrollTop
      };
      document.body.style.cursor = 'ns-resize';
    });

    overlay.appendChild(ah);
  }

  syncCharState();
  updateStats();
  saveSession();
}

// ── DRAG ───────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  if(!dragging) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const ZONE = 80;
  const distBottom = scrollerRect.bottom - e.clientY;
  const distTop    = e.clientY - scrollerRect.top;

  cancelAnimationFrame(autoRaf);

  const doMove = () => {
    const scrollDelta = scroller.scrollTop - dragging.startScroll;
    const clientDelta = e.clientY - dragging.startY;
    const docDelta = clientDelta + scrollDelta;
    const totalH = txtEl.scrollHeight;

    if(dragging.type === 'active'){
      const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
      const rawBottom = Math.max(lastCut + 20, Math.min(totalH, dragging.startVal + docDelta));
      // enforce 4 KB cap — find px where 4KB is reached from lastCut
      const maxBottom = pxForBytes(lastCut, MAX_CHUNK_BYTES);
      activeBottomPx = Math.min(rawBottom, maxBottom);
    } else {
      // moving a locked cut — constrain between its neighbours + 4KB cap on both adjacent chunks
      const idx = dragging.idx;
      const prevCut = idx > 0 ? cuts[idx-1] : 0;
      const nextCut = idx < cuts.length-1 ? cuts[idx+1] : activeBottomPx;
      const minPx = prevCut + 20;
      const maxPx = nextCut - 20;
      // cap: this cut cannot be more than 4KB from the previous cut
      const maxFromPrev = pxForBytes(prevCut, MAX_CHUNK_BYTES);
      // cap: this cut cannot be less than (nextCut - 4KB) to keep next chunk ≤ 4KB
      const minFromNext = pxForBytes(nextCut, -MAX_CHUNK_BYTES); // will use helper below
      const capMax = Math.min(maxPx, maxFromPrev);
      cuts[idx] = Math.max(minPx, Math.min(capMax, dragging.startVal + docDelta));
    }
    render();
  };

  doMove();

  // auto-scroll when near edges
  if(distBottom < ZONE && distBottom > 0){
    const speed = Math.round((1 - distBottom/ZONE) * 18);
    const loop = () => {
      scroller.scrollTop += speed;
      doMove();
      if(dragging) autoRaf = requestAnimationFrame(loop);
    };
    autoRaf = requestAnimationFrame(loop);
  } else if(distTop < ZONE && distTop > 0){
    const speed = Math.round((1 - distTop/ZONE) * 18);
    const loop = () => {
      scroller.scrollTop -= speed;
      doMove();
      if(dragging) autoRaf = requestAnimationFrame(loop);
    };
    autoRaf = requestAnimationFrame(loop);
  }
});

document.addEventListener('mouseup', () => {
  if(dragging){ dragging = null; document.body.style.cursor = ''; cancelAnimationFrame(autoRaf); }
});

// ── LOCK CHUNK (called by Add Cut button) ──────────────────
function lockChunk(){
  if(!text) return;
  if(ENC.encode(text).length <= MAX_CHUNK_BYTES){
    toast('content is under 4 KB — no need to split');
    return;
  }
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
  if(activeBottomPx <= lastCut + 10){ toast('drag the handle down first'); return; }

  cuts.push(activeBottomPx);

  const totalH = txtEl.scrollHeight;
  if(activeBottomPx >= totalH - 10){
    activeBottomPx = totalH;
    render(); updateStats();
    toast('all content sliced ✓');
  } else {
    const newBottom = Math.min(pxForBytes(activeBottomPx, DEFAULT_BYTES), pxForBytes(activeBottomPx, MAX_CHUNK_BYTES));
    activeBottomPx = newBottom;
    render(); updateStats();
    // scroll so new band is visible
    const bandMid = cuts[cuts.length-1] + (activeBottomPx - cuts[cuts.length-1]) / 2;
    const scrollerH = scroller.getBoundingClientRect().height;
    scroller.scrollTop = Math.max(0, bandMid - scrollerH / 2);
    toast(`chunk ${cuts.length} added ✓`);
  }
  updateToolbar();
}

document.getElementById('btnAddCut').addEventListener('click', lockChunk);

// disable right-click context menu (no longer needed)
scroller.addEventListener('contextmenu', e => e.preventDefault());

// ── INPUT ──────────────────────────────────────────────────
txtEl.addEventListener('input', () => {
  text = txtEl.value;
  syncHeights();
  syncMirror();
  if(!text){ hardReset(); }
  render(); updateStats(); updateToolbar();
});

new ResizeObserver(() => {
  if(!text || dragging) return;
  syncHeights();
  syncMirror();
  const totalH = txtEl.scrollHeight;
  cuts = cutChars.map(ch => {
    if(ch >= text.length) return totalH;
    return ch > 0 ? charToDocY(ch) : 0;
  });
  if(activeBottomChar >= text.length){
    activeBottomPx = totalH;
  } else if(activeBottomChar > 0){
    activeBottomPx = charToDocY(activeBottomChar);
  } else {
    activeBottomPx = 0;
  }
  render();
}).observe(txtEl);

txtEl.addEventListener('paste', () => setTimeout(() => {
  text = txtEl.value;
  syncHeights();
  syncMirror();
  if(text && !cuts.length && activeBottomPx === 0){
    activeBottomPx = pxForBytes(0, DEFAULT_BYTES);
  }
  render(); updateStats(); updateToolbar();
}, 30));

// ── RESET ──────────────────────────────────────────────────
function hardReset(){
  cuts = [];
  cutChars = [];
  activeBottomPx = 0;
  activeBottomChar = 0;
  overlay.innerHTML = '';
}

function fullReset(){
  // Step 1: clear state
  hardReset();
  // Step 2: scroll to top
  scroller.scrollTop = 0;
  // Step 3: wait for scroll+reflow, then set default blind
  requestAnimationFrame(() => requestAnimationFrame(() => {
    syncHeights();
    syncMirror();
    activeBottomPx = pxForBytes(0, DEFAULT_BYTES);
    render(); updateStats(); updateToolbar();
    toast('reset');
  }));
}




// ── REFRESH (clear everything for new content) ─────────────
document.getElementById('btnRefresh').addEventListener('click', () => {
  hardReset();
  text = '';
  txtEl.value = '';
  if(mirror){ mirror.textContent = ''; }
  syncHeights();
  scroller.scrollTop = 0;
  tray.classList.remove('open');
  if(typeof chrome !== 'undefined' && chrome.storage){
    chrome.storage.local.remove('slicerSession');
  }
  updateStats(); updateToolbar();
  toast('cleared — paste new content');
});

// ── UNDO (remove last cut) ─────────────────────────────────
document.getElementById('btnUndo').addEventListener('click', () => {
  if(!cuts.length) return;
  const restored = cuts.pop();
  activeBottomPx = restored;
  // scroll handle into view
  const scrollerH = scroller.getBoundingClientRect().height;
  scroller.scrollTop = Math.max(0, restored - scrollerH * 0.6);
  render(); updateStats(); updateToolbar();
  toast('last cut removed');
});

// ── STATS + TOOLBAR ────────────────────────────────────────
function updateStats(){
  const totalBytes = ENC.encode(text).length;
  document.getElementById('hs-size').textContent = fmtB(totalBytes);
  document.getElementById('hs-segs').textContent = cuts.length;
  const totalH = txtEl.scrollHeight || 1;
  const pctLeft = Math.round((1 - activeBottomPx / totalH) * 100);
  document.getElementById('hs-remain').textContent =
    activeBottomPx >= totalH - 10 ? 'done' : pctLeft + '% left';
}

function updateToolbar(){
  const has = text.length > 0;
  const totalBytes = has ? ENC.encode(text).length : 0;
  const needsSplit = totalBytes > MAX_CHUNK_BYTES;
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
  const hasActive = activeBottomPx > lastCut + 10;
  document.getElementById('btnUndo').disabled    = !cuts.length;
  document.getElementById('btnAddCut').disabled  = !(has && hasActive && needsSplit);
  document.getElementById('btnCopy').disabled    = !cuts.length;

}

// ── VIEW CHUNKS TRAY ───────────────────────────────────────
// Build segments from cuts for display
// ── TRANSFORM: replace greeting line + add chunk headers ───
const TRIGGER = 'お問い合わせいただいた内容について、以下の通りご報告いたします。';
const REPLACEMENT_BASE = 'お問い合わせいただいた内容について以下の通りご報告いたします。';

function transformContent(rawContent, chunkIndex, totalChunks){
  let content = rawContent;
  const n = chunkIndex + 1; // 1-based

  if(n === 1 && content.includes(TRIGGER)){
    // Replace trigger line in first chunk + add intro + header
    const intro = `${REPLACEMENT_BASE}\n「ケースコメント」の入力文字数制限により、回答は${totalChunks}つに分けてご報告させて頂きます。\n【ご報告1】\n`;
    content = content.replace(TRIGGER, intro);
  } else {
    // Every other chunk starts with the report header
    content = `【ご報告${n}】\n` + content;
  }
  return content;
}

// Build transformed segments for copy/export
function getTransformedSegments(){
  const segs = getSegments();
  const total = segs.length;
  return segs.map((seg, i) => ({
    ...seg,
    transformed: transformContent(seg.content, i, total)
  }));
}

function getSegments(){
  const borders = [0, ...cuts];
  const totalH = txtEl.scrollHeight;
  // include active blind if it has content
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
  if(activeBottomPx > lastCut + 10) borders.push(activeBottomPx);
  return borders.slice(0,-1).map((startPx, i) => {
    const endPx = borders[i+1];
    const {bytes, chars, content} = bytesInRange(startPx, endPx);
    return {bytes, chars, content, colorIdx: i};
  }).filter(s => s.chars > 0);
}

const tray = document.getElementById('tray');
document.getElementById('btnCopy').addEventListener('click', () => {
  renderTray(); tray.classList.toggle('open');
});
document.getElementById('trayClose').onclick = () => tray.classList.remove('open');
document.getElementById('trayCopyAll').onclick = () => {
  const segs = getTransformedSegments();
  if(!segs.length){ toast('no chunks'); return; }
  safeCopy(segs.map(s => s.transformed).join('\n\n'), 'all chunks copied!');
};

function renderTray(){
  const segs = getTransformedSegments();
  document.getElementById('trayTitle').textContent = `${segs.length} chunk${segs.length===1?'':'s'}`;
  const scroll = document.getElementById('trayScroll');
  if(!segs.length){
    scroll.innerHTML = `<div style="padding:2rem;text-align:center;font-family:'Courier New',Courier,monospace;font-size:.65rem;color:var(--faint)">no chunks yet</div>`;
    return;
  }
  scroll.innerHTML = segs.map((seg, i) => {
    const c = rgb(seg.colorIdx);
    const preview = seg.transformed.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="chunk-card" id="chunk-card-${i}">
      <div class="chunk-copied-badge"><span class="chunk-copied-label">✓ copied <button class="chunk-copied-close" data-close="${i}">✕ close</button></span></div>
      <div class="chunk-stripe" style="background:${c}"></div>
      <div class="chunk-info">
        <div class="chunk-n">chunk ${String(i+1).padStart(2,'0')}</div>
        <div class="chunk-kb">${fmtB(seg.bytes)}</div>
        <div class="chunk-ch">${seg.chars.toLocaleString()} chars</div>
      </div>
      <div class="chunk-body" data-expand="1">${preview}</div>
      <button class="chunk-cp" data-cpone="${i}">copy</button>
    </div>`;
  }).join('');
}

function cpOne(i){
  const segs = getTransformedSegments();
  if(!segs[i]) return;
  safeCopy(segs[i].transformed, 'chunk copied', () => {
    const card = document.getElementById('chunk-card-' + i);
    if(card) card.classList.add('copied');
  });
}

function closeCopied(i){
  const card = document.getElementById('chunk-card-' + i);
  if(card) card.classList.remove('copied');
}

// ── SESSION SAVE/RESTORE via chrome.storage ─────────────────
// Saves text + cut positions so state survives panel close/reopen

function saveSession(){
  if(typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.set({
    slicerSession: {
      text: text,
      cutChars: cutChars,
      activeBottomChar: activeBottomChar
    }
  });
}

function restoreSession(){
  if(typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.get('slicerSession', result => {
    const s = result.slicerSession;
    if(!s || !s.text) return;
    txtEl.value = s.text;
    text = s.text;
    txtEl.dispatchEvent(new Event('input'));
    setTimeout(() => {
      syncHeights();
      syncMirror();
      const totalH = txtEl.scrollHeight;
      if(s.cutChars && s.cutChars.length){
        cutChars = s.cutChars;
        activeBottomChar = s.activeBottomChar || 0;
        cuts = cutChars.map(ch => {
          if(ch >= text.length) return totalH;
          return ch > 0 ? charToDocY(ch) : 0;
        });
        if(activeBottomChar >= text.length){
          activeBottomPx = totalH;
        } else if(activeBottomChar > 0){
          activeBottomPx = charToDocY(activeBottomChar);
        } else {
          activeBottomPx = 0;
        }
      } else {
        cuts = s.cuts || [];
        activeBottomPx = s.activeBottomPx || 0;
      }
      if(!activeBottomPx && text){
        activeBottomPx = pxForBytes(0, DEFAULT_BYTES);
      }
      render(); updateStats(); updateToolbar();
      toast('前回のセッションを復元しました');
    }, 100);
  });
}

// Restore on load
window.addEventListener('load', restoreSession);


// ── EVENT DELEGATION for dynamic chunk cards ──────────────
document.addEventListener('click', e => {
  // copy one chunk
  const cpBtn = e.target.closest('[data-cpone]');
  if(cpBtn){ cpOne(parseInt(cpBtn.dataset.cpone)); return; }

  // close copied badge
  const closeBtn = e.target.closest('[data-close]');
  if(closeBtn){ closeCopied(parseInt(closeBtn.dataset.close)); return; }

  // expand chunk body
  const expandEl = e.target.closest('[data-expand]');
  if(expandEl){ expandEl.classList.toggle('exp'); return; }
});


}); // end DOMContentLoaded
