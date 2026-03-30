document.addEventListener('DOMContentLoaded', () => {

// ── i18n HELPER ─────────────────────────────────────────────
// _manualMessages is populated by initLocale() when the browser's preferred
// language differs from chrome.i18n's UI language (common on Edge / Windows).
let _manualMessages = null;

function resolveManualMessage(key, subs){
  const entry = _manualMessages[key];
  if(!entry) return null;
  let message = entry.message;
  if(subs && entry.placeholders){
    for(const [name, def] of Object.entries(entry.placeholders)){
      const match = def.content.match(/\$(\d+)/);
      if(!match) continue;
      const idx = parseInt(match[1]) - 1;
      if(subs[idx] !== undefined){
        message = message.replace(new RegExp('\\$' + name + '\\$', 'gi'), subs[idx]);
      }
    }
  }
  return message;
}

function msg(key, subs){
  if(_manualMessages && _manualMessages[key]){
    return resolveManualMessage(key, subs);
  }
  if(typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage){
    const m = chrome.i18n.getMessage(key, subs);
    if(m) return m;
  }
  return key;
}

// Detect preferred language and load the matching locale if chrome.i18n
// doesn't already serve it (e.g. browser UI is English but user prefers Japanese).
async function initLocale(){
  const navLang = (navigator.language || '').slice(0, 2).toLowerCase();
  if(!navLang) return;

  if(typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage){
    const uiLang = chrome.i18n.getUILanguage().slice(0, 2).toLowerCase();
    if(uiLang === navLang) return;
  }

  try {
    const resp = await fetch(`_locales/${navLang}/messages.json`);
    if(resp.ok) _manualMessages = await resp.json();
  } catch(e){ /* locale not available — keep default */ }
}

// ── LOCALIZE STATIC UI ──────────────────────────────────────
function localizeUI(){
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const localized = msg(el.dataset.i18n);
    if(localized && localized !== el.dataset.i18n) el.textContent = localized;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const localized = msg(el.dataset.i18nAria);
    if(localized && localized !== el.dataset.i18nAria) el.setAttribute('aria-label', localized);
  });
  const txt = document.getElementById('txt');
  const ph = msg('uiPlaceholder');
  if(ph && ph !== 'uiPlaceholder') txt.placeholder = ph;
}

// ── TOAST ───────────────────────────────────────────────────
function toast(message){
  const t = document.getElementById('toast');
  t.textContent = message; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2200);
}

// ── SAFE CLIPBOARD (works in Chrome extension side panel) ───
function safeCopy(str, toastMsg, callback){
  function onSuccess(){
    if(toastMsg) toast(toastMsg);
    if(callback) callback();
  }
  function onFail(){
    toast(msg('copyFailed'));
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
  try { ok = document.execCommand('copy'); } catch(e){ console.warn('execCommand copy failed:', e); }
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

const fmtB = SlicerCore.fmtB;

function el(tag, attrs) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') n.className = v;
    else if (k === 'cssText') n.style.cssText = v;
    else if (k === 'id') n.id = v;
    else n.setAttribute(k, v);
  }
  for (let i = 2; i < arguments.length; i++) {
    const c = arguments[i];
    if (typeof c === 'string') n.append(c);
    else if (c) n.appendChild(c);
  }
  return n;
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
let cutChars = [];        // char indices corresponding to each cut (canonical / source-of-truth)
let activeBottomChar = 0; // char index for active bottom (canonical / source-of-truth)
let _resizing = false;    // true while ResizeObserver handler runs (prevents char state corruption)
let _autoClearTimer = null;

const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

const txtEl      = document.getElementById('txt');
const scroller   = document.getElementById('scroller');
const scrollInner= document.getElementById('scrollInner');
const overlay    = document.getElementById('overlay');

const DEFAULT_BYTES = 3.2 * 1024;
const MAX_CHUNK_BYTES = 3.5 * 1024; // hard cap — user cannot drag beyond 3.5 KB

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

const MIRROR_STYLE_PROPS = [
  'fontFamily','fontSize','fontWeight','fontStyle','fontVariant','fontStretch',
  'lineHeight','letterSpacing','wordSpacing','textTransform','textIndent',
  'textRendering','textDecoration','textAlign',
  'whiteSpace','wordBreak','overflowWrap','wordWrap','hyphens','tabSize',
  'direction','writingMode','unicodeBidi',
  'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
  'borderWidth','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
  'borderStyle','boxSizing',
];

function ensureMirror(){
  if(mirror) return;
  mirror = document.createElement('div');
  const cs = window.getComputedStyle(txtEl);
  const s = mirror.style;
  MIRROR_STYLE_PROPS.forEach(p => { if(cs[p]) s[p] = cs[p]; });
  s.position      = 'absolute';
  s.top           = '0';
  s.left          = '0';
  s.opacity       = '0';
  s.pointerEvents = 'none';
  s.zIndex        = '-1';
  s.height        = 'auto';
  s.overflow      = 'visible';
  s.width         = txtEl.offsetWidth + 'px';
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

function getLine(charIdx){
  return SlicerCore.getLine(charIdx, text);
}

function isOnBlankLine(charIdx){
  return SlicerCore.isOnBlankLine(charIdx, text);
}

function syncCharState(){
  cutChars = cuts.map(px => pxToChar(px));
  activeBottomChar = pxToChar(activeBottomPx);
}

// ── RENDER ─────────────────────────────────────────────────
function render(){
  overlay.replaceChildren();
  if(!text) return;

  if(!_resizing){
    cutChars = cuts.map(px => pxToChar(px));
    activeBottomChar = pxToChar(activeBottomPx);
  }

  const totalH = txtEl.scrollHeight;
  // all boundaries: 0, ...cuts, activeBottomPx (if > last cut), totalH
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;

  // ── Draw locked segments (between cuts)
  const borders = [0, ...cuts];
  borders.forEach((startPx, i) => {
    const endPx = i < cuts.length ? cuts[i] : activeBottomPx;
    if(endPx <= startPx) return;
    const startCh = i > 0 ? cutChars[i-1] : 0;
    const endCh   = i < cutChars.length ? cutChars[i] : activeBottomChar;
    const bytes = ENC.encode(text.slice(startCh, endCh)).length;
    const chars = endCh - startCh;

    const band = el('div', {className:'seg-band', cssText:`top:${startPx}px;height:${endPx-startPx}px`},
      el('div', {className:'seg-fill', cssText:`background:${rgba(i,.38)}`}),
      el('div', {className:'seg-badge'},
        el('div', {className:'seg-swatch', cssText:`background:${rgb(i)}`}),
        el('span', {className:'seg-kb'}, fmtB(bytes)),
        el('span', {className:'seg-meta'}, msg('uiSegmentMeta', [String(i+1), chars.toLocaleString()]))
      ),
      el('div', {className:'seg-size-corner'}, fmtB(bytes),
        el('span', {className:'seg-size-corner-sub'}, msg('uiCharsCount', [chars.toLocaleString()]))
      )
    );
    overlay.appendChild(band);
  });

  // ── Draw active blind (from lastCut to activeBottomPx)
  const activeTop = lastCut;
  const activeBot = activeBottomPx;
  if(activeBot > activeTop){
    const ci = cuts.length;
    const lastCutCh = cutChars.length ? cutChars[cutChars.length-1] : 0;
    const bytes = ENC.encode(text.slice(lastCutCh, activeBottomChar)).length;
    const chars = activeBottomChar - lastCutCh;
    const atLimit = bytes >= MAX_CHUNK_BYTES;
    const nearLimit = bytes >= MAX_CHUNK_BYTES * 0.9;
    const badgeColor = atLimit ? '#c0392b' : nearLimit ? '#c05a00' : '#0F5599';
    const limitLabel = atLimit ? msg('uiLimitMax') : nearLimit ? msg('uiLimitNear') : '';
    const activeBand = el('div', {className:'seg-band', cssText:`top:${activeTop}px;height:${activeBot-activeTop}px`},
      el('div', {className:'seg-fill', cssText:`background:${rgba(ci,.42)}`}),
      el('div', {className:'seg-badge', cssText:`border-color:rgba(${atLimit?'192,57,43':'15,85,153'},.3)`},
        el('div', {className:'seg-swatch', cssText:`background:${rgb(ci)}`}),
        el('span', {className:'seg-kb', cssText:`color:${badgeColor}`}, fmtB(bytes) + limitLabel),
        el('span', {className:'seg-meta'}, msg('uiSegmentMeta', [String(ci+1), chars.toLocaleString()]))
      ),
      el('div', {className:'seg-size-corner', cssText:`color:${badgeColor}`}, fmtB(bytes),
        el('span', {className:'seg-size-corner-sub'}, msg('uiCharsCount', [chars.toLocaleString()]))
      )
    );
    overlay.appendChild(activeBand);
  }

  // ── Draw locked cut handles (all draggable, any can be resized)
  cuts.forEach((cutPx, idx) => {
    const prevCh = idx > 0 ? cutChars[idx-1] : 0;
    const prevBytes = ENC.encode(text.slice(prevCh, cutChars[idx])).length;
    const delBtn = el('button', {className:'cut-del', 'aria-label':msg('ariaDeleteCut', [String(idx+1)])}, '\u2715');
    const h = el('div', {
      className:'cut-handle',
      cssText:`top:${cutPx}px`,
      role:'slider',
      'aria-label':msg('ariaCutHandle', [String(idx+1)]),
      'aria-roledescription':msg('ariaCutPosHandle'),
      'aria-valuenow':String(Math.round(cutPx)),
      'aria-valuemin':'0',
      'aria-valuemax':String(Math.round(totalH)),
      tabindex:'0'
    },
      el('div', {className:'cut-line'}),
      el('div', {className:'cut-pill'}),
      el('span', {className:'cut-tooltip'}, msg('uiFromChunkStart', [fmtB(prevBytes)])),
      delBtn
    );

    delBtn.addEventListener('click', e => {
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

    // keyboard repositioning for cut handles
    h.addEventListener('keydown', e => {
      const STEP = 20;
      const BIG_STEP = 100;
      let delta = 0;
      if(e.key === 'ArrowDown') delta = STEP;
      else if(e.key === 'ArrowUp') delta = -STEP;
      else if(e.key === 'PageDown') delta = BIG_STEP;
      else if(e.key === 'PageUp') delta = -BIG_STEP;
      else if(e.key === 'Delete' || e.key === 'Backspace'){ delBtn.click(); return; }
      else return;
      e.preventDefault();
      const prevCut = idx > 0 ? cuts[idx-1] : 0;
      const nextCut = idx < cuts.length-1 ? cuts[idx+1] : activeBottomPx;
      const maxFromPrev = pxForBytes(prevCut, MAX_CHUNK_BYTES);
      const proposed = Math.max(prevCut + 20, Math.min(Math.min(nextCut - 20, maxFromPrev), cuts[idx] + delta));
      const charAtCut = pxToChar(proposed);
      if(isOnBlankLine(charAtCut)){
        cuts[idx] = proposed;
        render(); updateStats();
      }
    });

    overlay.appendChild(h);
  });

  // ── Draw active bottom handle (drag to extend active blind)
  if(activeBottomPx < totalH){
    const ah = el('div', {
      className:'active-handle',
      cssText:`top:${activeBottomPx}px`,
      role:'slider',
      'aria-label':msg('ariaActiveHandle'),
      'aria-roledescription':msg('ariaChunkSizeHandle'),
      'aria-valuenow':String(Math.round(activeBottomPx)),
      'aria-valuemin':'0',
      'aria-valuemax':String(Math.round(totalH)),
      tabindex:'0'
    },
      el('div', {className:'active-line'}),
      el('div', {className:'active-pill'})
    );

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

    // keyboard repositioning for active handle
    ah.addEventListener('keydown', e => {
      const STEP = 20;
      const BIG_STEP = 100;
      let delta = 0;
      if(e.key === 'ArrowDown') delta = STEP;
      else if(e.key === 'ArrowUp') delta = -STEP;
      else if(e.key === 'PageDown') delta = BIG_STEP;
      else if(e.key === 'PageUp') delta = -BIG_STEP;
      else return;
      e.preventDefault();
      const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
      const maxBottom = pxForBytes(lastCut, MAX_CHUNK_BYTES);
      activeBottomPx = Math.max(lastCut + 20, Math.min(Math.min(totalH, maxBottom), activeBottomPx + delta));
      render(); updateStats();
    });

    overlay.appendChild(ah);
  }

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
  if(!dragging) return;
  cancelAnimationFrame(autoRaf);
  const wasType = dragging.type;
  const wasIdx  = dragging.idx;
  const wasVal  = dragging.startVal;

  if(wasType === 'cut'){
    const charAtCut = pxToChar(cuts[wasIdx]);
    if(!isOnBlankLine(charAtCut)){
      cuts[wasIdx] = wasVal;
      render(); updateStats();
      toast(msg('cutOnBlankLine'));
    }
  } else if(wasType === 'active'){
    if(!isOnBlankLine(activeBottomChar)){
      activeBottomPx = wasVal;
      render(); updateStats();
    }
  }

  dragging = null;
  document.body.style.cursor = '';
});

// ── LOCK CHUNK (called by Add Cut button) ──────────────────
function lockChunk(){
  if(!text) return;
  if(ENC.encode(text).length <= MAX_CHUNK_BYTES){
    toast(msg('contentUnder4kb'));
    return;
  }
  const lastCut = cuts.length ? cuts[cuts.length-1] : 0;
  if(activeBottomPx <= lastCut + 10){ toast(msg('dragHandleDown')); return; }
  if(!isOnBlankLine(activeBottomChar)){ toast(msg('placeOnBlankLine')); return; }

  cuts.push(activeBottomPx);

  const totalH = txtEl.scrollHeight;
  if(activeBottomPx >= totalH - 10){
    activeBottomPx = totalH;
    render(); updateStats();
    toast(msg('allSliced'));
  } else {
    const newBottom = Math.min(pxForBytes(activeBottomPx, DEFAULT_BYTES), pxForBytes(activeBottomPx, MAX_CHUNK_BYTES));
    activeBottomPx = newBottom;
    render(); updateStats();
    // scroll so new band is visible
    const bandMid = cuts[cuts.length-1] + (activeBottomPx - cuts[cuts.length-1]) / 2;
    const scrollerH = scroller.getBoundingClientRect().height;
    scroller.scrollTop = Math.max(0, bandMid - scrollerH / 2);
    toast(msg('chunkAdded', [String(cuts.length + 1)]));
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

let resizeRaf = null;
new ResizeObserver(() => {
  if(!text || dragging) return;
  if(resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
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
    _resizing = true;
    render();
    _resizing = false;
  });
}).observe(txtEl);

txtEl.addEventListener('paste', () => setTimeout(() => {
  text = txtEl.value;
  syncHeights();
  syncMirror();
  if(text && !cuts.length && activeBottomPx === 0){
    activeBottomPx = pxForBytes(0, DEFAULT_BYTES);
  }
  if(text && !text.includes(msg('triggerLine'))){
    toast(msg('formatNotDetected'));
  }
  if(text) txtEl.readOnly = true;
  render(); updateStats(); updateToolbar();
}, 30));

// ── RESET ──────────────────────────────────────────────────
function hardReset(){
  cuts = [];
  cutChars = [];
  activeBottomPx = 0;
  activeBottomChar = 0;
  overlay.replaceChildren();
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
    toast(msg('resetDone'));
  }));
}




// ── REFRESH (clear everything for new content) ─────────────
document.getElementById('btnRefresh').addEventListener('click', () => {
  hardReset();
  text = '';
  txtEl.value = '';
  txtEl.readOnly = false;
  if(mirror){ mirror.textContent = ''; }
  syncHeights();
  scroller.scrollTop = 0;
  tray.classList.remove('open');
  if(typeof chrome !== 'undefined' && chrome.storage){
    chrome.storage.local.remove('slicerSession');
  }
  updateStats(); updateToolbar();
  toast(msg('clearedPasteNew'));
});

// ── UNDO (remove last cut) ─────────────────────────────────
document.getElementById('btnUndo').addEventListener('click', () => {
  if(!cuts.length) return;
  const restored = cuts.pop();
  const restoredChar = cutChars.pop();
  activeBottomPx = restored;
  activeBottomChar = restoredChar !== undefined ? restoredChar : pxToChar(restored);
  _resizing = true;
  render();
  _resizing = false;
  // scroll handle into view
  const scrollerH = scroller.getBoundingClientRect().height;
  scroller.scrollTop = Math.max(0, restored - scrollerH * 0.6);
  updateStats(); updateToolbar();
  toast(msg('lastCutRemoved'));
});

// ── STATS + TOOLBAR ────────────────────────────────────────
function updateStats(){
  const totalBytes = ENC.encode(text).length;
  document.getElementById('hs-size').textContent = fmtB(totalBytes);
  document.getElementById('hs-segs').textContent = getSegments().length;
  const totalH = txtEl.scrollHeight || 1;
  const pctLeft = Math.round((1 - activeBottomPx / totalH) * 100);
  document.getElementById('hs-remain').textContent =
    activeBottomPx >= totalH - 10 ? msg('uiStatDone') : msg('uiStatPercentLeft', [String(pctLeft)]);
}

function updateToolbar(){
  document.getElementById('btnUndo').disabled    = !cuts.length;
  document.getElementById('btnAddCut').disabled  = false;
  document.getElementById('btnCopy').disabled    = !cuts.length;

}

// ── VIEW CHUNKS TRAY ───────────────────────────────────────
// ── TRANSFORM: replace greeting line + add chunk headers ───

function transformContent(rawContent, chunkIndex, totalChunks){
  return SlicerCore.transformContent(rawContent, chunkIndex, totalChunks, {
    trigger: msg('triggerLine'),
    replacementBase: msg('replacementBase'),
    formatReportIntro: (count) => msg('reportIntro', [String(count)]),
    formatReportHeader: (n) => msg('reportHeader', [String(n)])
  });
}

function getTransformedSegments(){
  const segs = getSegments();
  const total = segs.length;
  return segs.map((seg, i) => ({
    ...seg,
    transformed: transformContent(seg.content, i, total)
  }));
}

function getSegments(){
  return SlicerCore.getSegments(text, cutChars, activeBottomChar, ENC);
}

const tray = document.getElementById('tray');
const btnCopy = document.getElementById('btnCopy');

btnCopy.addEventListener('click', () => {
  renderTray();
  tray.classList.toggle('open');
  if(tray.classList.contains('open')){
    const firstFocusable = tray.querySelector('button, [tabindex]:not([tabindex="-1"])');
    if(firstFocusable) firstFocusable.focus();
  }
});

document.getElementById('trayClose').onclick = () => {
  tray.classList.remove('open');
  btnCopy.focus();
};

// Focus trap + Escape to close
tray.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    tray.classList.remove('open');
    btnCopy.focus();
    return;
  }
  if(e.key !== 'Tab') return;
  const focusables = tray.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
  if(!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if(e.shiftKey && document.activeElement === first){
    e.preventDefault();
    last.focus();
  } else if(!e.shiftKey && document.activeElement === last){
    e.preventDefault();
    first.focus();
  }
});

document.getElementById('trayCopyAll').onclick = () => {
  const segs = getTransformedSegments();
  if(!segs.length){ toast(msg('noChunks')); return; }
  safeCopy(segs.map(s => s.transformed).join('\n\n'), msg('allChunksCopied'));
};

function renderTray(){
  const segs = getTransformedSegments();
  const titleKey = segs.length === 1 ? 'uiChunkTitleSingular' : 'uiChunkTitle';
  document.getElementById('trayTitle').textContent = msg(titleKey, [String(segs.length)]);
  const scroll = document.getElementById('trayScroll');
  if(!segs.length){
    scroll.replaceChildren(el('div', {className:'tray-empty'}, msg('noChunksYet')));
    return;
  }
  scroll.replaceChildren();
  segs.forEach((seg, i) => {
    const c = rgb(seg.colorIdx);
    const body = el('div', {className:'chunk-body', 'data-expand':'1'});
    body.textContent = seg.transformed;

    const chunkCard = el('div', {className:'chunk-card', id:`chunk-card-${i}`, role:'listitem'},
      el('div', {className:'chunk-copied-badge'},
        el('span', {className:'chunk-copied-label'},
          msg('uiCopiedLabel'),
          el('button', {className:'chunk-copied-close', 'data-close':String(i)}, msg('uiCloseLabel'))
        )
      ),
      el('div', {className:'chunk-stripe', cssText:`background:${c}`}),
      el('div', {className:'chunk-info'},
        el('div', {className:'chunk-n'}, msg('uiChunkLabel', [String(i+1).padStart(2,'0')])),
        el('div', {className:'chunk-kb'}, fmtB(seg.bytes)),
        el('div', {className:'chunk-ch'}, msg('uiCharsCount', [seg.chars.toLocaleString()]))
      ),
      body,
      el('button', {className:'chunk-cp', 'data-cpone':String(i)}, msg('uiCopyBtn'))
    );

    const approvalCard = el('div', {className:'approval-card', id:`approval-card-${i}`},
      el('div', {className:'approval-copied-badge'},
        el('span', {className:'approval-copied-label'},
          msg('uiCopiedLabel'),
          el('button', {className:'approval-copied-close', 'data-approval-close':String(i)}, msg('uiCloseLabel'))
        )
      ),
      el('button', {className:'approval-btn', type:'button', 'data-approval':String(i)}, msg('uiApprovalBtn'))
    );

    scroll.appendChild(
      el('div', {className:'chunk-row'}, chunkCard, approvalCard)
    );
  });
}

function cpOne(i){
  const segs = getTransformedSegments();
  if(!segs[i]) return;
  safeCopy(segs[i].transformed, msg('chunkCopied'), () => {
    const card = document.getElementById('chunk-card-' + i);
    if(card) card.classList.add('copied');
  });
}

function cpApproval(i){
  const approvalText = msg('approvalRequestTemplate', [String(i + 1)]);
  safeCopy(approvalText, msg('approvalRequestCopied'), () => {
    const ac = document.getElementById('approval-card-' + i);
    if(ac) ac.classList.add('copied');
  });
}

function closeApprovalCopied(i){
  const ac = document.getElementById('approval-card-' + i);
  if(ac) ac.classList.remove('copied');
}

function closeCopied(i){
  const card = document.getElementById('chunk-card-' + i);
  if(card) card.classList.remove('copied');
}

// ── SESSION SAVE/RESTORE via chrome.storage ─────────────────

function saveSession(){
  if(typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.set({
    slicerSession: {
      text: text,
      cutChars: cutChars,
      activeBottomChar: activeBottomChar,
      savedAt: Date.now()
    }
  }, () => {
    if(chrome.runtime.lastError){
      console.warn('saveSession failed:', chrome.runtime.lastError.message);
    }
  });
  scheduleAutoClear();
}

function scheduleAutoClear(){
  if(_autoClearTimer) clearTimeout(_autoClearTimer);
  _autoClearTimer = setTimeout(() => {
    if(typeof chrome !== 'undefined' && chrome.storage){
      chrome.storage.local.remove('slicerSession');
    }
    hardReset();
    text = '';
    txtEl.value = '';
    if(mirror) mirror.textContent = '';
    syncHeights();
    updateStats(); updateToolbar();
    toast(msg('sessionExpired'));
  }, SESSION_MAX_AGE_MS);
}

function validateSessionData(s){
  if(!s || typeof s !== 'object' || typeof s.text !== 'string' || !s.text) return null;
  const clean = { text: s.text };

  if(Array.isArray(s.cutChars)){
    clean.cutChars = s.cutChars.filter(v =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= s.text.length
    );
  } else {
    clean.cutChars = [];
  }

  if(typeof s.activeBottomChar === 'number' && Number.isFinite(s.activeBottomChar)
     && s.activeBottomChar >= 0 && s.activeBottomChar <= s.text.length){
    clean.activeBottomChar = s.activeBottomChar;
  } else {
    clean.activeBottomChar = 0;
  }

  clean.savedAt = typeof s.savedAt === 'number' ? s.savedAt : 0;
  return clean;
}

function restoreSession(){
  if(typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.get('slicerSession', result => {
    try {
      const raw = result.slicerSession;
      const s = validateSessionData(raw);
      if(!s) return;

      // Auto-clear: discard sessions older than 2 hours
      if(s.savedAt && Date.now() - s.savedAt > SESSION_MAX_AGE_MS){
        chrome.storage.local.remove('slicerSession');
        toast(msg('sessionExpired'));
        return;
      }

      txtEl.value = s.text;
      text = s.text;
      txtEl.dispatchEvent(new Event('input'));

      setTimeout(() => {
        try {
          syncHeights();
          syncMirror();
          const totalH = txtEl.scrollHeight;

          if(s.cutChars.length){
            cutChars = s.cutChars;
            activeBottomChar = s.activeBottomChar;
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
            cuts = [];
            activeBottomPx = 0;
          }

          if(!activeBottomPx && text){
            activeBottomPx = pxForBytes(0, DEFAULT_BYTES);
          }

          if(text) txtEl.readOnly = true;
          render(); updateStats(); updateToolbar();
          toast(msg('sessionRestored'));
          scheduleAutoClear();
        } catch(innerErr){
          console.error('restoreSession (inner):', innerErr);
          hardReset();
        }
      }, 100);
    } catch(err){
      console.error('restoreSession:', err);
    }
  });
}

// Detect preferred locale, localize UI, then restore session
initLocale().then(() => localizeUI());
window.addEventListener('load', restoreSession);


// ── EVENT DELEGATION for dynamic chunk cards ──────────────
document.addEventListener('click', e => {
  // copy one chunk
  const cpBtn = e.target.closest('[data-cpone]');
  if(cpBtn){ cpOne(parseInt(cpBtn.dataset.cpone)); return; }

  // close copied badge
  const closeBtn = e.target.closest('[data-close]');
  if(closeBtn){ closeCopied(parseInt(closeBtn.dataset.close)); return; }

  // close approval copied badge
  const approvalCloseBtn = e.target.closest('[data-approval-close]');
  if(approvalCloseBtn){ closeApprovalCopied(parseInt(approvalCloseBtn.dataset.approvalClose)); return; }

  // approval request copy
  const approvalBtn = e.target.closest('[data-approval]');
  if(approvalBtn){ cpApproval(parseInt(approvalBtn.dataset.approval)); return; }

  // expand chunk body
  const expandEl = e.target.closest('[data-expand]');
  if(expandEl){ expandEl.classList.toggle('exp'); return; }
});


}); // end DOMContentLoaded
