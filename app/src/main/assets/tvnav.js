/*
 * frameXTV - remote-control (D-pad) navigation for framextv.xyz.
 *
 * Injected by MainActivity at document start into every framextv page / iframe. The site itself has
 * no keyboard navigation, so this script adds spatial navigation on top of it:
 *
 *   page          D-pad moves a focus ring between clickable things, OK clicks, Back is handled natively
 *                 (history) after __fxtvBack() has had a chance to close whatever is open.
 *   player        while the video fills the screen: Left/Right seek, OK play/pause,
 *                 Up/Down open the controls (then D-pad moves between buttons).
 *   text fields   OK starts typing (on-screen keyboard), Up/Down leaves the field again.
 *
 * Written in plain ES5 because TV WebViews are often old. Only *trusted* key events are handled, so the
 * synthetic keys this script sends to the site's own shortcuts (Space, f, arrows) never loop back.
 */
(function () {
  'use strict';
  if (window.__fxtv) return;
  window.__fxtv = true;

  var CFG = window.__FXTV_CFG || {};
  var IS_TOP = window.top === window;
  var ATTR = 'data-fxtv-focus';
  var DEBUG = !!CFG.debug;

  var SEL = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary', 'video', 'iframe',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[role="switch"]', '[role="checkbox"]', '[role="radio"]', '[role="slider"]',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]',
    '.cursor-pointer', '[onclick]'
  ].join(',');

  var TEXT_INPUT_TYPES = { text: 1, search: 1, email: 1, password: 1, url: 1, tel: 1, number: 1, '': 1 };

  var cur = null;           // element the D-pad is "on"
  var ringEl = null;        // element carrying the visible focus ring (cur, or a visible ancestor of it)
  var lastCenter = null;    // where cur was, used to recover when React replaces the node
  var lastInLayer = false;  // ...and whether it was inside a modal layer at the time
  var controlsMode = false; // player controls are being navigated
  var keepAlive = null;
  var enteredFrame = null;  // an iframe the user "went into" (keys then go to that frame)
  var lastNavAt = 0;
  var editEl = null;        // the text field the user opened with OK / a tap (a field the page focused by itself is not "being edited")
  var lastModal = { el: null, at: 0 };

  function log() {
    if (!DEBUG) return;
    try { console.log('[fxtv' + (IS_TOP ? '' : '/frame') + '] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (e) {}
  }

  function post(obj) {
    try { if (window.FxTV && window.FxTV.postMessage) window.FxTV.postMessage(JSON.stringify(obj)); } catch (e) {}
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ------------------------------------------------------------------ styling

  var CSS =
    '[' + ATTR + ']{outline:3px solid #34d399!important;outline-offset:-3px!important;' +
    'box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 22px 4px rgba(52,211,153,.5)!important;}' +
    '::-webkit-scrollbar{display:none!important}' +
    '*{-webkit-tap-highlight-color:transparent!important}' +
    // The site's fades/slides also animate the focus ring and make a TV GPU repaint on every key press.
    // Zero duration (not "none") so scripts that wait on a transition's computed duration don't hang.
    '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important}' +
    // The sticky header blurs whatever scrolls under it (it is 95% opaque anyway); on a TV GPU that costs every scroll frame.
    '*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}';

  function addStyle() {
    try {
      var st = document.createElement('style');
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }
  if (document.documentElement) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle);

  // "Page size": rewrite the viewport meta so the site lays out for a smaller/larger screen.
  function fixViewport() {
    var z = CFG.zoom;
    if (!IS_TOP || !z || Math.abs(z - 1) < 0.01) return true;
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) return false;
    var w = Math.round((window.screen.width || window.innerWidth) / z);
    var c = 'width=' + w + ',initial-scale=' + z + ',minimum-scale=' + z + ',maximum-scale=' + z + ',user-scalable=no';
    if (m.getAttribute('content') !== c) m.setAttribute('content', c);
    return true;
  }
  if (IS_TOP && CFG.zoom && Math.abs(CFG.zoom - 1) >= 0.01) {
    try {
      var mo = new MutationObserver(function () { fixViewport(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
      document.addEventListener('DOMContentLoaded', fixViewport);
      fixViewport();
    } catch (e) {}
  }

  // ------------------------------------------------------------------ candidates

  function isTextLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = el.tagName;
    if (t === 'TEXTAREA') return true;
    if (t === 'INPUT') return !!TEXT_INPUT_TYPES[(el.getAttribute('type') || '').toLowerCase()];
    return el.isContentEditable === true;
  }

  function visibleRect(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') return null;
    // Custom-styled inputs are often transparent on purpose; anything else at opacity 0 is a hidden menu.
    if (parseFloat(cs.opacity) < 0.05 && el.tagName !== 'INPUT') return null;
    return r;
  }

  function hitOk(el, x, y) {
    var h = document.elementFromPoint(x, y);
    if (!h) return false;
    return h === el || el.contains(h) || h.contains(el);
  }

  // Is this (on-screen) element actually the thing under its own centre, or is something else on top of it?
  function covered(el, r) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var ix1 = Math.max(r.left, 0), ix2 = Math.min(r.right, vw);
    var iy1 = Math.max(r.top, 0), iy2 = Math.min(r.bottom, vh);
    if (ix2 <= ix1 || iy1 >= iy2) return false;   // not on screen: nothing can be asked of it yet
    var x = clamp((ix1 + ix2) / 2, 1, vw - 1), y = clamp((iy1 + iy2) / 2, 1, vh - 1);
    var h = document.elementFromPoint(x, y);
    if (!h) return true;
    if (h === el || el.contains(h) || h.contains(el)) return false;
    // Scrolled in under the sticky header: not covered, just near the edge. Focusing it scrolls it clear, and treating
    // it as covered would make Up from a card skip the whole row of filters above it.
    if ((r.top < vh * 0.14 || r.bottom > vh * 0.88) && isPinned(h) && !isPinned(el)) return false;
    return true;
  }

  // A full-screen layer (modal / pseudo-fullscreen player) on top: only things inside it can be reached.
  function topLayer() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var hit = document.elementFromPoint(vw / 2, vh / 2);
    var dialog = null;
    for (var n = hit; n && n !== document.documentElement; n = n.parentElement) {
      var role = n.getAttribute && n.getAttribute('role');
      if (role === 'dialog' || role === 'alertdialog' || n.getAttribute('aria-modal') === 'true') { dialog = n; break; }
      var cs = window.getComputedStyle(n);
      if (cs.position === 'fixed') {
        var r = n.getBoundingClientRect();
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9 && n !== document.body) return n;
      }
    }
    return dialog;
  }

  // Wrappers that merely contain lots of other targets are layout, not targets; otherwise the outermost target
  // wins (a card beats the little button inside it). Walks each element's ancestors instead of comparing every pair.
  function dropNested(out) {
    var n = out.length, pos = new Map(), contained = [], i, p, j;
    for (i = 0; i < n; i++) { pos.set(out[i].el, i); contained.push(0); }
    for (i = 0; i < n; i++) {
      for (p = out[i].el.parentElement; p; p = p.parentElement) {
        j = pos.get(p);
        if (j !== undefined) contained[j]++;
      }
    }
    var keep = [], isKeep = [];
    for (i = 0; i < n; i++) {
      isKeep.push(contained[i] < 3);
      if (isKeep[i]) keep.push(i);
    }
    var res = [];
    for (var k = 0; k < keep.length; k++) {
      i = keep[k];
      var inner = false;
      for (p = out[i].el.parentElement; p && !inner; p = p.parentElement) {
        j = pos.get(p);
        if (j !== undefined && isKeep[j]) inner = true;
      }
      if (!inner) res.push(out[i]);
    }
    return res;
  }

  function scan(scopeEl, layer) {
    var nodes = (scopeEl || document).querySelectorAll(SEL);
    var vw = window.innerWidth, vh = window.innerHeight;
    var out = [], i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (layer && !layer.contains(el)) continue;
      var r = visibleRect(el);
      if (!r) continue;
      var tag = el.tagName;
      // The volume slider is a trap for a D-pad (Left/Right would change the level instead of moving on); the TV has its own volume.
      if (el.getAttribute('aria-label') === 'Volume slider') continue;
      // A click-catcher covering the whole screen is a backdrop, not something to select.
      if (r.width * r.height > 0.85 * vw * vh && tag !== 'VIDEO' && tag !== 'IFRAME') continue;
      // An empty clickable box is an invisible hit area (the player's double-tap-to-seek thirds), not a control.
      if ((tag === 'DIV' || tag === 'SPAN') && !el.firstElementChild && !el.textContent && !el.hasAttribute('aria-label') &&
          !el.hasAttribute('title') && !el.hasAttribute('role') && !el.hasAttribute('tabindex')) continue;
      out.push({ el: el, r: r });
    }
    return dropNested(out);
  }

  // Measuring a few hundred elements is what makes a TV-class CPU feel slow, so a scan is kept until the DOM changes,
  // the window is resized, a layer opens/closes or a long while has passed. Scrolling only moves things: the scrolled
  // container's entries are re-measured (a rail is ~30 elements, the page ~450), nothing is re-classified.
  // Whatever gets picked is re-measured before it is used (see select), so a stale scan cannot mis-aim a move.
  var snap = null;
  var snapStats = { hit: 0, miss: 0 };
  var SNAP_TTL = 10000;
  var scrollSeen = new WeakMap();   // scroller -> position its entries were last measured at
  var pinMemo = new Map();          // element -> is it (inside) a fixed/sticky bar

  function invalidate(why) {
    if (DEBUG && snap) {
      var inv = window.__fxtvInv || (window.__fxtvInv = {});
      var k = typeof why === 'string' ? why : (why && why.length !== undefined && why[0]
        ? 'mut:' + why[0].type + ':' + (why[0].attributeName || '') + ':' + why[0].target.tagName + ':' + String(why[0].target.className).slice(0, 40)
        : (why && why.type) || 'code');
      inv[k] = (inv[k] || 0) + 1;
    }
    snap = null;
    pinMemo = new Map();
  }

  function scrollKey(n) {
    return n === document ? window.pageXOffset + ',' + window.pageYOffset : n.scrollLeft + ',' + n.scrollTop;
  }

  function noteScroll(n) {
    if (snap && snap.dirty.indexOf(n) < 0) snap.dirty.push(n);
  }

  function onScroll(e) {
    if (snap && scrollSeen.get(e.target) !== scrollKey(e.target)) noteScroll(e.target);
  }

  // Re-measure the entries that sit inside something that has scrolled. False if one collapsed (needs a real rescan).
  function refresh(s) {
    var d = s.dirty, list = s.list, all = false, i, j;
    s.dirty = [];
    for (i = 0; i < d.length; i++) {
      scrollSeen.set(d[i], scrollKey(d[i]));
      if (d[i] === document) all = true;
    }
    for (j = 0; j < list.length; j++) {
      var c = list[j], moved = all;
      for (i = 0; i < d.length && !moved; i++) moved = d[i].contains(c.el);
      if (!moved) continue;
      var r = c.el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return false;
      c.r = r;
    }
    return true;
  }

  function collect(scopeEl) {
    if (scopeEl) return scan(scopeEl, null);
    var layer = topLayer(), now = Date.now();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (snap && snap.layer === layer && snap.vw === vw && snap.vh === vh && now - snap.at < SNAP_TTL &&
        (!snap.dirty.length || refresh(snap))) {
      snapStats.hit++;
      return snap.list;
    }
    snapStats.miss++;
    if (DEBUG) {
      var mr = window.__fxtvMiss || (window.__fxtvMiss = []);
      mr.push(!snap ? 'null' : snap.layer !== layer ? 'layer' : (snap.vw !== vw || snap.vh !== vh) ? 'size' : now - snap.at >= SNAP_TTL ? 'ttl' : 'collapsed');
    }
    scrollSeen = new WeakMap();
    pinMemo = new Map();
    snap = { layer: layer, vw: vw, vh: vh, at: now, list: scan(null, layer), dirty: [] };
    return snap.list;
  }

  try {
    new MutationObserver(invalidate).observe(document, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'disabled', 'aria-hidden', 'aria-disabled', 'aria-expanded']
    });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', invalidate);
  } catch (e) {}

  // ------------------------------------------------------------------ geometry

  function isCandidate(dir, s, d) {
    switch (dir) {
      case 'right': return (s.left < d.left || s.right <= d.left) && s.right < d.right;
      case 'left': return (s.right > d.right || s.left >= d.right) && s.left > d.left;
      case 'down': return (s.top < d.top || s.bottom <= d.top) && s.bottom < d.bottom;
      default: return (s.bottom > d.bottom || s.top >= d.bottom) && s.top > d.top;
    }
  }

  // Left/Right only count things that share a good part of the row ("beam"); a sliver of overlap is another row.
  function sameRow(s, d) {
    var o = Math.min(s.bottom, d.bottom) - Math.max(s.top, d.top);
    return o > 0 && o >= Math.min(s.bottom - s.top, d.bottom - d.top) * 0.3;
  }

  function measure(dir, s, d) {
    var major, far, minor, beam;
    var scx = (s.left + s.right) / 2, scy = (s.top + s.bottom) / 2;
    var dcx = (d.left + d.right) / 2, dcy = (d.top + d.bottom) / 2;
    switch (dir) {
      case 'right':
        major = Math.max(0, d.left - s.right); far = d.right - s.right;
        minor = Math.abs(scy - dcy); beam = sameRow(s, d); break;
      case 'left':
        major = Math.max(0, s.left - d.right); far = s.left - d.left;
        minor = Math.abs(scy - dcy); beam = sameRow(s, d); break;
      case 'down':
        major = Math.max(0, d.top - s.bottom); far = d.bottom - s.bottom;
        minor = Math.abs(scx - dcx); beam = d.right > s.left && d.left < s.right; break;
      default:
        major = Math.max(0, s.top - d.bottom); far = s.top - d.top;
        minor = Math.abs(scx - dcx); beam = d.right > s.left && d.left < s.right; break;
    }
    return { major: major, far: far, beam: beam, score: 13 * major * major + minor * minor };
  }

  // A row stays a row and a column stays a column: Left/Right never hop to another row (Left on the first card of a
  // rail does nothing instead of landing on a button two sections up), and Up/Down take the nearest thing in their
  // own column before looking sideways (Up from a card reaches the rail above, not the lone "View all" link at its far
  // end). Only when the column is empty does Up/Down fall back to the nearest thing anywhere, so nothing is stranded.
  // (bestOf keeps the best candidate of each kind and decides between them.)

  // Sticky/fixed bars (the site header) stay on screen while the page scrolls, so by distance alone they always beat
  // whatever lies above the viewport: Up from a card halfway down the page would land on the header and the buttons
  // above could never be reached again.
  function isPinned(el) {
    var hit = pinMemo.get(el);
    if (hit !== undefined) return hit;
    var pos = window.getComputedStyle(el).position, p = el.parentElement;
    var res = pos === 'fixed' || pos === 'sticky' ||
      (!!p && p !== document.body && p !== document.documentElement && isPinned(p));
    pinMemo.set(el, res);
    return res;
  }

  function bestOf(from, cands, dir, exclude, bad, skipPinned) {
    var horizontal = dir === 'left' || dir === 'right';
    var vw = window.innerWidth, vh = window.innerHeight;
    var top = null, side = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (bad && bad.length && bad.indexOf(c.el) >= 0) continue;
      if (skipPinned && isPinned(c.el)) continue;
      if (exclude && (c.el === exclude || exclude.contains(c.el) || c.el.contains(exclude))) continue;
      if (!isCandidate(dir, from, c.r)) continue;
      var m = measure(dir, from, c.r);
      // Something outside the screen is only reachable in a straight line (next card of a rail, next row down);
      // otherwise Right from the header would jump to a rail that is scrolled out of sight.
      if (!m.beam && (c.r.right <= 0 || c.r.left >= vw || c.r.bottom <= 0 || c.r.top >= vh)) continue;
      if (horizontal && !m.beam) continue;
      m.cand = c;
      if (m.beam) { if (!top || m.score < top.score) top = m; }
      else if (!side || m.score < side.score) side = m;
    }
    // Something in the column normally wins, but not when it is a page away and a row of controls sits right below
    // (Down from the season chips must reach the episode list, not the similar-series cards after it).
    if (top && side && top.major - side.major > vh * 0.6) return side;
    return top || side;
  }

  function pick(from, cands, dir, exclude, bad) {
    var top = bestOf(from, cands, dir, exclude, bad, false);
    if (top && (dir === 'up' || dir === 'down') && isPinned(top.cand.el)) {
      // Look past the bar, but only to something in the same column: Up from the search box must reach the header
      // above it, not a toggle at the far right that merely sits a little closer.
      var past = bestOf(from, cands, dir, exclude, bad, true);
      if (past && past.beam) top = past;
    }
    return top && top.cand;
  }

  // ------------------------------------------------------------------ focus ring

  function visualTarget(el) {
    var t = el, n = 0;
    while (t && n < 3) {
      if (parseFloat(window.getComputedStyle(t).opacity) >= 0.05) return t;
      t = t.parentElement; n++;
    }
    return el;
  }

  function clearRing() {
    if (ringEl) { try { ringEl.removeAttribute(ATTR); } catch (e) {} }
    ringEl = null;
  }

  function blurActive() {
    var a = document.activeElement;
    editEl = null;
    if (a && a !== document.body && a.blur) { try { a.blur(); } catch (e) {} }
  }

  function realFocus(el) {
    var t = el.tagName;
    if (isTextLike(el)) { blurActive(); return; }   // never open the keyboard just by passing over a field
    if (t === 'IFRAME') return;                      // focusing a frame would send keys into it
    try {
      if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    } catch (e) {}
  }

  function ensureVisible(el) {
    var r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var vert = r.top < vh * 0.14 || r.bottom > vh * 0.88;
    var hor = r.left < vw * 0.03 || r.right > vw * 0.97;
    if (!vert && !hor) return;
    if (isPinned(el)) return;   // it stays put however far the page scrolls; "centring" it would just drag the page up
    // Remember what could scroll so the cached scan learns about it right away (the scroll event comes a frame later).
    var seen = [], n;
    for (n = el.parentElement; n; n = n.parentElement) seen.push(n, n.scrollLeft, n.scrollTop);
    var px = window.pageXOffset, py = window.pageYOffset;
    var opts = { block: vert ? 'center' : 'nearest', inline: hor ? 'center' : 'nearest', behavior: 'instant' };
    try { el.scrollIntoView(opts); }
    catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    for (var i = 0; i < seen.length; i += 3) {
      if (seen[i].scrollLeft !== seen[i + 1] || seen[i].scrollTop !== seen[i + 2]) noteScroll(seen[i]);
    }
    if (window.pageXOffset !== px || window.pageYOffset !== py) noteScroll(document);
  }

  function setFocus(el, noScroll) {
    clearRing();
    cur = el;
    ringEl = visualTarget(el);
    try { ringEl.setAttribute(ATTR, ''); } catch (e) {}
    realFocus(el);
    if (!noScroll) ensureVisible(ringEl);
    var r = el.getBoundingClientRect();
    lastCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    lastInLayer = !!topLayer();
  }

  function dropFocus() {
    clearRing();
    cur = null;
    if (!isTextLike(document.activeElement)) blurActive();
  }

  function curRect() {
    if (!cur || !document.documentElement.contains(cur)) return null;
    var r = cur.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return r;
  }

  // ------------------------------------------------------------------ page navigation

  function firstFocus(cands) {
    var vw = window.innerWidth, vh = window.innerHeight, best = null, bestScore = Infinity, i;
    var main = document.querySelector('main');
    for (i = 0; i < cands.length; i++) {
      var r = cands[i].r;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      var score = r.top * 4 + r.left + (main && main.contains(cands[i].el) ? -100000 : 0);
      if (cands[i].el.tagName === 'IFRAME' && frameWin(cands[i].el)) score -= 1000000;   // the player comes first
      if (score < bestScore) { bestScore = score; best = cands[i]; }
    }
    return best;
  }

  function nearestTo(cands, x, y) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].r, dx = (r.left + r.right) / 2 - x, dy = (r.top + r.bottom) / 2 - y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = cands[i]; }
    }
    return best;
  }

  function scrollPage(dir) {
    var step = Math.round(window.innerHeight * 0.6);
    var before = window.pageYOffset;
    window.scrollBy(0, dir === 'down' ? step : -step);
    return window.pageYOffset !== before;
  }

  function desc(el, r) {
    var t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return el.tagName + '"' + t + '"[' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.right) + ',' + Math.round(r.bottom) + ']';
  }

  // Runs choose() over the scan until it names a target that is really there: the scan may be a moment old, and
  // checking "is it covered / did it move" for the single winner is far cheaper than doing it for every candidate.
  function select(scopeEl, choose) {
    var cands = collect(scopeEl), bad = [], rescanned = false;
    for (var tries = 0; tries < 12; tries++) {
      var c = choose(cands, bad);
      if (!c) return null;
      var r = c.el.getBoundingClientRect();
      if (!scopeEl && !rescanned && (Math.abs(r.left - c.r.left) > 3 || Math.abs(r.top - c.r.top) > 3)) {
        rescanned = true; invalidate('moved'); cands = collect(null); bad = [];
        continue;
      }
      if (!covered(c.el, r)) return c;
      bad.push(c.el);
    }
    return null;
  }

  function without(cands, bad) {
    if (!bad.length) return cands;
    return cands.filter(function (c) { return bad.indexOf(c.el) < 0; });
  }

  function move(dir, scopeEl) {
    var t0 = DEBUG ? performance.now() : 0;
    var from = curRect();
    if (!from) {
      // Re-rendered node: continue from where it was. A closed modal: start over from the top of the page.
      var resume = lastCenter && !scopeEl && lastInLayer === !!topLayer();
      var start = select(scopeEl, function (cands, bad) {
        var list = without(cands, bad);
        var s = resume ? nearestTo(list, lastCenter.x, lastCenter.y) : null;
        return s || (scopeEl ? nearestTo(list, window.innerWidth / 2, window.innerHeight) : firstFocus(list));
      });
      if (DEBUG) log('move-start', dir, resume ? 'resume' : 'first', start ? desc(start.el, start.r) : 'none');
      if (start) setFocus(start.el, !!scopeEl);   // (inside the player everything is on screen: never scroll)
      return !!start;
    }
    var next = select(scopeEl, function (cands, bad) { return pick(from, cands, dir, cur, bad); });
    if (DEBUG) log('move', dir, 'from=' + desc(cur, from), 'next=' + (next ? desc(next.el, next.r) : 'none'));
    if (next) {
      var t1 = DEBUG ? performance.now() : 0;
      if (DEBUG && !scopeEl && window.__fxtvVerify) {
        // Self-check for the cached scan: a from-scratch scan must pick the same target.
        var fresh = scan(null, topLayer()), bad2 = [], ref = null;
        for (var v = 0; v < 12 && !ref; v++) {
          var fc = pick(from, fresh, dir, cur, bad2);
          if (!fc) break;
          if (covered(fc.el, fc.el.getBoundingClientRect())) bad2.push(fc.el); else ref = fc;
        }
        var vr = window.__fxtvVerify;
        vr.n++;
        if ((ref && ref.el) !== next.el) vr.bad.push(dir + ' cached=' + desc(next.el, next.r) + ' fresh=' + (ref ? desc(ref.el, ref.r) : 'none'));
      }
      setFocus(next.el, !!scopeEl);
      if (DEBUG) {
        var perf = window.__fxtvPerf || (window.__fxtvPerf = []);
        perf.push({ select: +(t1 - t0).toFixed(1), focus: +(performance.now() - t1).toFixed(1), hit: snapStats.hit, miss: snapStats.miss });
      }
      return true;
    }
    if (!scopeEl && (dir === 'up' || dir === 'down')) scrollPage(dir);
    return false;
  }

  // ------------------------------------------------------------------ activation

  function clickEl(el) {
    try { el.click(); } catch (e) {}
  }

  function startEditing(el) {
    editEl = el;
    try {
      el.focus();
      var n = (el.value || '').length;
      if (el.setSelectionRange && n) el.setSelectionRange(n, n);
    } catch (e) {}
    post({ t: 'ime' });
  }

  // The site's player is a same-origin iframe (/embed/...) that runs its own copy of this script.
  // Returns that frame's window, or null for a frame we cannot reach (cross-origin / not loaded yet).
  function frameWin(el) {
    try {
      var w = el.contentWindow;
      if (w && w.__fxtv && typeof w.__fxtvEnter === 'function') return w;
    } catch (e) {}
    return null;
  }

  function enterFrame(el, pressedOk) {
    enteredFrame = el;
    var w = frameWin(el);
    log('enterFrame', 'reachable=' + !!w);
    if (w) {
      clearRing();   // the player draws its own highlight; the page's ring would frame the whole screen
      // Keys now go to the frame's own copy of this script (player mode, controls, ...).
      try { el.focus({ preventScroll: true }); } catch (e) {}
      try { w.focus(); } catch (e) {}
      try { w.__fxtvEnter(!!pressedOk); } catch (e) {}
      return;
    }
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = clamp((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, 1, vw - 1);
    var y = clamp((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2, 1, vh - 1);
    post({ t: 'tap', x: x / vw, y: y / vh });   // a real touch, so a foreign frame takes focus and starts playing
  }

  // The same-origin iframe that currently has focus or is fullscreen (e.g. the player after the user clicked it).
  function focusedFrame() {
    try {
      var a = document.activeElement, f = document.fullscreenElement || document.webkitFullscreenElement;
      if (a && a.tagName === 'IFRAME' && frameWin(a)) return a;
      if (f && f.tagName === 'IFRAME' && frameWin(f)) return f;
    } catch (e) {}
    return null;
  }

  function leaveFrame() {
    var el = enteredFrame;
    enteredFrame = null;
    try {
      var w = el && frameWin(el);
      if (w && w.__fxtvLeave) w.__fxtvLeave();
      if (el && el.contentWindow) el.contentWindow.blur();
    } catch (e) {}
    try { if (document.activeElement && document.activeElement.tagName === 'IFRAME') document.activeElement.blur(); } catch (e) {}
    try { window.focus(); } catch (e) {}
    if (cur && document.documentElement.contains(cur)) setFocus(cur, true);   // bring the page's ring back
  }

  function activate(el) {
    var t = el.tagName;
    if (isTextLike(el)) return startEditing(el);
    if (t === 'SELECT') {
      try { el.focus(); if (el.showPicker) el.showPicker(); else el.click(); } catch (e) { clickEl(el); }
      return;
    }
    if (t === 'VIDEO') return activateVideo();
    if (t === 'IFRAME') return enterFrame(el, true);
    if (t === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'range') return;
    clickEl(el);
  }

  // ------------------------------------------------------------------ player

  function synthKey(key, code) {
    try {
      var ev = new KeyboardEvent('keydown', { key: key, code: code || '', bubbles: true, cancelable: true, view: window });
      window.dispatchEvent(ev);
    } catch (e) {}
  }

  function mainVideo() {
    var vs = document.getElementsByTagName('video'), best = null, bestArea = 0;
    for (var i = 0; i < vs.length; i++) {
      var r = vs[i].getBoundingClientRect(), a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = vs[i]; }
    }
    return bestArea > 0 ? best : null;
  }

  function playerBox(v) {
    return v.closest('.group') || (v.parentElement && v.parentElement.parentElement) || v.parentElement;
  }

  // The player when it fills the screen (HTML fullscreen, the site's pseudo-fullscreen, or an embed page).
  function fullPlayer() {
    var v = mainVideo();
    if (!v) return null;
    var box = playerBox(v), r = box.getBoundingClientRect();
    if (r.width >= window.innerWidth * 0.94 && r.height >= window.innerHeight * 0.94) return { v: v, box: box };
    return null;
  }

  function wake(box) {
    if (!box) { var p = fullPlayer(); if (!p) return; box = p.box; }
    var r = box.getBoundingClientRect();
    try {
      box.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
      }));
    } catch (e) {}
  }

  function activateVideo() {
    var v = mainVideo();
    if (!v) return;
    if (!fullPlayer()) synthKey('f', 'KeyF');          // go fullscreen (needs this trusted keypress)
    if (v.paused) synthKey(' ', 'Space');
  }

  function enterControls(p) {
    controlsMode = true;
    wake(p.box);
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = setInterval(function () {
      var fp = fullPlayer();
      if (!fp || !controlsMode) { exitControls(); return; }
      wake(fp.box);
    }, 1200);
    setTimeout(function () {
      var fp = fullPlayer();
      if (!fp || !controlsMode) return;
      var cands = collect(fp.box), best = null, i;
      for (i = 0; i < cands.length && !best; i++) {
        var lbl = cands[i].el.getAttribute('aria-label');
        if (lbl === 'Pause' || lbl === 'Play') best = cands[i];
      }
      if (!best) best = nearestTo(cands, window.innerWidth / 2, window.innerHeight);
      if (best) setFocus(best.el, true); else exitControls();
    }, 90);
  }

  function exitControls() {
    controlsMode = false;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    dropFocus();
  }

  function labelOf(el) { return (el && el.getAttribute && el.getAttribute('aria-label')) || ''; }

  function playerKey(e, dir, isEnter, p) {
    if (dir === 'left' || dir === 'right') { wake(p.box); return false; }     // the site seeks +-10s itself
    if (dir === 'up' || dir === 'down') { swallow(e); enterControls(p); return true; }
    if (isEnter) {
      swallow(e);
      if (!e.repeat) synthKey(' ', 'Space');
      wake(p.box);
      return true;
    }
    return false;
  }

  function controlsKey(e, dir, isEnter, p) {
    wake(p.box);
    var label = labelOf(cur) || labelOf(ringEl);
    var onTimeline = label === 'Video timeline scrubber';
    var onVolume = label === 'Volume slider';
    if (dir === 'left' || dir === 'right') {
      if (onTimeline) {                                  // native range steps are 1s; use the site's +-10s
        swallow(e);
        synthKey(dir === 'right' ? 'ArrowRight' : 'ArrowLeft', dir === 'right' ? 'ArrowRight' : 'ArrowLeft');
        return true;
      }
      if (onVolume) return false;                        // let the range input step itself
    }
    if (dir) {
      swallow(e);
      var moved = move(dir, p.box);
      if (!moved && dir === 'down') exitControls();      // nothing below the bottom bar: back to plain playback
      return true;
    }
    if (isEnter) {
      swallow(e);
      if (e.repeat) return true;
      if (cur && document.documentElement.contains(cur)) {
        if (onTimeline || onVolume) return true;
        clickEl(cur);
      } else {
        synthKey(' ', 'Space');
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ key handling

  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }

  function dirOf(e) {
    switch (e.key) {
      case 'ArrowLeft': return 'left';
      case 'ArrowRight': return 'right';
      case 'ArrowUp': return 'up';
      case 'ArrowDown': return 'down';
    }
    switch (e.keyCode) {
      case 37: return 'left';
      case 38: return 'up';
      case 39: return 'right';
      case 40: return 'down';
    }
    return null;
  }

  function editingKey(e, dir, isEnter, a) {
    if (dir === 'up' || dir === 'down') {
      swallow(e); cur = a; blurActive(); post({ t: 'hideime' }); move(dir); return true;
    }
    if (dir === 'left' || dir === 'right') {
      var ss = null, se = null;
      try { ss = a.selectionStart; se = a.selectionEnd; } catch (x) {}
      var len = (a.value || '').length;
      var atEdge = ss === null || (dir === 'left' ? (ss === 0 && se === 0) : (ss === len && se === len));
      if (atEdge) { swallow(e); cur = a; blurActive(); post({ t: 'hideime' }); move(dir); return true; }
      return false;
    }
    if (isEnter && a.tagName === 'INPUT') {
      // Let the site submit, then hand the D-pad back.
      setTimeout(function () { blurActive(); post({ t: 'hideime' }); }, 200);
    }
    return false;
  }

  function onKeyDown(e) {
    if (!e.isTrusted || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    var dir = dirOf(e);
    var isEnter = e.key === 'Enter' || e.keyCode === 13;
    if (!dir && !isEnter) return;

    var a = document.activeElement;
    if (a && isTextLike(a)) {
      if (a === editEl) { editingKey(e, dir, isEnter, a); return; }
      // The page focused the field itself (the search page does on load): no keyboard is up, so the D-pad is still
      // navigation. The first key just puts the ring on it, like on any other page; OK then opens the keyboard.
      var fresh = !cur;
      setFocus(a, true);
      if (fresh && dir) { swallow(e); return; }
    }

    // A fullscreen player frame never gets keyboard focus from the WebView, so the keys land here: pass them on.
    var fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe && fe.tagName === 'IFRAME') {
      var fw = frameWin(fe);
      if (fw && typeof fw.__fxtvKey === 'function') {
        enteredFrame = fe;
        try { fe.focus({ preventScroll: true }); fw.focus(); } catch (err) {}
        try { fw.__fxtvKey(e); } catch (err) {}
        return;
      }
    }

    if (enteredFrame) leaveFrame();   // the keys reached us, so the frame no longer has them

    if (dir && e.repeat) {
      var now = Date.now();
      if (now - lastNavAt < 90) { e.preventDefault(); return; }
    }
    lastNavAt = Date.now();

    var p = fullPlayer();
    if (DEBUG) log('key', e.key, 'player=' + !!p, 'controls=' + controlsMode, 'active=' + (document.activeElement && document.activeElement.tagName));
    if (controlsMode && !p) exitControls();
    if (p) {
      if (controlsMode ? controlsKey(e, dir, isEnter, p) : playerKey(e, dir, isEnter, p)) return;
      return;
    }

    if (dir) { swallow(e); move(dir); return; }
    if (isEnter && cur && document.documentElement.contains(cur)) {
      swallow(e);
      if (!e.repeat) activate(cur);
      return;
    }
    if (isEnter) {
      // Nothing selected yet: OK selects the first thing instead of doing nothing.
      var first = firstFocus(collect(null));
      if (first) {
        swallow(e);
        setFocus(first.el);
        if (first.el.tagName === 'IFRAME' && frameWin(first.el) && !e.repeat) enterFrame(first.el, true);   // watch page: OK starts the player
      }
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('focusout', function (e) { if (e.target === editEl) editEl = null; }, true);
  window.addEventListener('pointerdown', function (e) {
    if (e.isTrusted && e.target && isTextLike(e.target)) editEl = e.target;   // a tap / mouse click is a deliberate "type here"
  }, true);

  // The TV mangles the position of a natively fullscreen video (hardware layer, stale geometry). So the player never
  // uses native fullscreen: the iframe holding it is simply stretched over the whole window in the top page, where the
  // site's own centred, contained video layout does the rest. The frame is told its element "is fullscreen".
  if (!IS_TOP) (function () {
    var host = null, shown = null, saved = null;
    try { host = window.frameElement; if (!host) return; } catch (e) { return; }
    var pdoc = host.ownerDocument;
    function define(obj, name, getter) { try { Object.defineProperty(obj, name, { configurable: true, get: getter }); } catch (e) {} }
    function fire() {
      ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (n) {
        try { document.dispatchEvent(new Event(n, { bubbles: true })); } catch (e) {}
        try { pdoc.dispatchEvent(new Event(n, { bubbles: true })); } catch (e) {}
      });
    }
    function request() {
      var el = this;
      if (!shown) {
        saved = host.getAttribute('style');
        host.setAttribute('data-fxtv-fs', '1');
        host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +
          'width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;' +
          'padding:0!important;border:0!important;transform:none!important;z-index:2147483647!important;background:#000!important;';
      }
      shown = el;
      setTimeout(fire, 0);
      return Promise.resolve();
    }
    Element.prototype.requestFullscreen = request;
    Element.prototype.webkitRequestFullscreen = request;
    Element.prototype.webkitRequestFullScreen = request;
    function exit() {
      if (!shown) return Promise.resolve();
      shown = null;
      host.removeAttribute('data-fxtv-fs');
      if (saved === null) host.removeAttribute('style'); else host.setAttribute('style', saved);
      setTimeout(fire, 0);
      return Promise.resolve();
    }
    Document.prototype.exitFullscreen = exit;
    Document.prototype.webkitExitFullscreen = exit;
    Document.prototype.webkitCancelFullScreen = exit;
    function current() { return shown; }
    define(Document.prototype, 'fullscreenElement', current);
    define(Document.prototype, 'webkitFullscreenElement', current);
    define(Document.prototype, 'webkitCurrentFullScreenElement', current);
    define(Document.prototype, 'fullscreen', function () { return !!shown; });
    define(Document.prototype, 'webkitIsFullScreen', function () { return !!shown; });
    define(Document.prototype, 'fullscreenEnabled', function () { return true; });
    define(Document.prototype, 'webkitFullscreenEnabled', function () { return true; });
  })();

  // Top page: the player frame stretched over the window (see below) counts as the fullscreen element here too.
  if (IS_TOP) (function () {
    var proto = Document.prototype;
    function nativeGet(name) { var d = Object.getOwnPropertyDescriptor(proto, name); return d && d.get; }
    function fsFrame() { return document.querySelector('iframe[data-fxtv-fs]'); }
    ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement'].forEach(function (n) {
      var g = nativeGet(n);
      try { Object.defineProperty(proto, n, { configurable: true, get: function () { return (g && g.call(this)) || fsFrame(); } }); } catch (e) {}
    });
    var exit = proto.exitFullscreen || proto.webkitExitFullscreen;
    function leave() {
      var f = fsFrame();
      if (f) { try { return frameWin(f).document.exitFullscreen(); } catch (e) {} }
      return exit ? exit.call(this) : Promise.resolve();
    }
    proto.exitFullscreen = leave;
    proto.webkitExitFullscreen = leave;
    proto.webkitCancelFullScreen = leave;
  })();

  // A player that fills the screen must never scroll: it has nothing to scroll to, but a focus move, a hidden menu
  // hanging below the bar or the page's own scroll position can still push the whole picture up and leave a black
  // band at the bottom. Whatever holds the player (not the lists inside it) is put back to zero.
  var unshifting = false;
  function unshift() {
    if (unshifting) return;
    if (IS_TOP && (window.pageYOffset || window.pageXOffset) && (document.fullscreenElement || document.webkitFullscreenElement)) {
      unshifting = true;
      try { window.scrollTo(0, 0); } catch (e) {}
      unshifting = false;
    }
    var p = fullPlayer();
    if (!p) return;
    unshifting = true;
    try {
      for (var n = p.box; n; n = n.parentElement) {
        if (IS_TOP && (n === document.documentElement || n === document.body)) break;
        if (n.scrollTop || n.scrollLeft) { n.scrollTop = 0; n.scrollLeft = 0; }
      }
    } catch (e) {}
    unshifting = false;
  }
  document.addEventListener('scroll', unshift, true);

  // The page behind a fullscreen frame keeps its scroll position, and some WebViews lay the fullscreen frame out
  // relative to it, which shows up as the picture sitting too high. Park the page at the top while the frame is
  // fullscreen and bring it back afterwards.
  var savedScroll = null;
  function onFullscreenChange() {
    var fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe) {
      if (!savedScroll) savedScroll = [window.pageXOffset, window.pageYOffset];
      if ((window.pageXOffset || window.pageYOffset)) { try { window.scrollTo(0, 0); } catch (e) {} noteScroll(document); }
    } else if (savedScroll) {
      var s = savedScroll;
      savedScroll = null;
      try { window.scrollTo(s[0], s[1]); } catch (e) {}
      invalidate('fullscreen');
    }
  }
  if (IS_TOP) {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  }

  // ------------------------------------------------------------------ Back / media keys (called by native)

  function visibleByLabel(root, label) {
    var list = root.querySelectorAll('[aria-label="' + label + '"]');
    for (var i = 0; i < list.length; i++) {
      var r = visibleRect(list[i]);
      if (!r) continue;
      var x = clamp(r.left + r.width / 2, 1, window.innerWidth - 1), y = clamp(r.top + r.height / 2, 1, window.innerHeight - 1);
      if (hitOk(list[i], x, y)) return list[i];
    }
    return null;
  }

  var MENU_CLOSERS = ['Back to main settings', 'Close subtitles menu', 'Close server selection', 'Close settings'];

  window.__fxtvBack = function () {
    // 1. typing
    var a = document.activeElement;
    if (a && isTextLike(a)) {
      var typing = a === editEl;
      blurActive(); post({ t: 'hideime' });
      if (typing) return true;   // a field the page focused by itself is not "typing": Back carries on below
    }

    // 2. inside an iframe player: let the frame unwind its own menus / fullscreen first
    var af = enteredFrame || focusedFrame();
    if (af) {
      var fw = frameWin(af), handled = false;
      if (fw && fw.__fxtvBack) { try { handled = !!fw.__fxtvBack(); } catch (e) {} }
      if (handled) return true;
      if (enteredFrame) { leaveFrame(); return true; }
    }

    // 3. one of the player's menus
    var i, btn;
    for (i = 0; i < MENU_CLOSERS.length; i++) {
      btn = visibleByLabel(document, MENU_CLOSERS[i]);
      if (btn) { clickEl(btn); return true; }
    }

    // 4. player controls
    if (controlsMode) { exitControls(); return true; }

    // 5. fullscreen
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
      return true;
    }
    var p = fullPlayer();
    if (p && String(p.box.className).indexOf('z-[999999]') >= 0) {   // the site's own fixed-position fullscreen
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      } catch (e) {}
      return true;
    }

    // 6. a modal / popup on top
    var layer = topLayer();
    if (layer && !(p && layer.contains(p.box))) {
      var now = Date.now();
      if (lastModal.el === layer && now - lastModal.at < 1500) return false;   // refuses to close: don't trap the user
      lastModal = { el: layer, at: now };
      var close = layer.querySelector('[aria-label*="lose" i],[aria-label*="ismiss" i],[data-dismiss]');
      if (close && visibleRect(close)) clickEl(close);
      else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      return true;
    }

    // 7. nothing to undo: let the app go back in history
    return false;
  };

  window.__fxtvMedia = function (action) {
    var v = mainVideo();
    if (!v) {
      var fr = document.getElementsByTagName('iframe');   // the player usually lives in a same-origin frame
      for (var i = 0; i < fr.length; i++) {
        var w = frameWin(fr[i]);
        try { if (w && w.__fxtvMedia && w.__fxtvMedia(action)) return true; } catch (e) {}
      }
      return false;
    }
    var box = playerBox(v);
    if (action === 'play') { if (v.paused) synthKey(' ', 'Space'); }
    else if (action === 'pause') { if (!v.paused) synthKey(' ', 'Space'); }
    else if (action === 'forward') synthKey('ArrowRight', 'ArrowRight');
    else if (action === 'rewind') synthKey('ArrowLeft', 'ArrowLeft');
    else synthKey(' ', 'Space');
    wake(box);
    return true;
  };

  // Called by the parent page when the user "goes into" the player frame / comes back out.
  // The page above hands us key events when it holds Android's keyboard focus but we are the fullscreen player.
  window.__fxtvKey = function (e) { onKeyDown(e); };

  window.__fxtvEnter = function (pressedOk) {
    try { window.focus(); } catch (e) {}
    var p = fullPlayer();
    if (!p) return;
    wake(p.box);
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (pressedOk && !fs) synthKey('f', 'KeyF');                       // OK on the player: fullscreen (this is still inside the user's keypress)
  };

  window.__fxtvLeave = function () {
    if (controlsMode) exitControls();
    dropFocus();
    cur = null;
  };

  // ------------------------------------------------------------------ SPA navigation resets

  function resetState() {
    if (controlsMode) exitControls();
    enteredFrame = null;
    clearRing();
    cur = null;
    lastCenter = null;
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    history[name] = function () {
      var before = location.pathname;
      var res = orig.apply(this, arguments);
      if (location.pathname !== before) resetState();
      return res;
    };
  });
  window.addEventListener('popstate', resetState);

  log('ready', location.href);
})();
