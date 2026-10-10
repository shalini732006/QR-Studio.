/* QR Studio — UI logic. Uses QR.encode() from qrcode.js. */
(() => {
  'use strict';

  // ---------- Light themes ----------
  // Each theme restyles the page and suggests matching QR colours.
  const THEMES = [
    { key: 'snow',     label: 'Snow',     fg: '#1f2937', bg: '#ffffff', dot: '#4f46e5' },
    { key: 'sky',      label: 'Sky',      fg: '#0c4a6e', bg: '#f0f9ff', dot: '#0284c7' },
    { key: 'mint',     label: 'Mint',     fg: '#064e3b', bg: '#ecfdf5', dot: '#059669' },
    { key: 'peach',    label: 'Peach',    fg: '#7c2d12', bg: '#fff7ed', dot: '#ea580c' },
    { key: 'lavender', label: 'Lavender', fg: '#4c1d95', bg: '#f5f3ff', dot: '#7c3aed' },
    { key: 'rose',     label: 'Rose',     fg: '#881337', bg: '#fff1f2', dot: '#e11d48' },
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    themeList: $('themeList'),
    tabs: Array.from(document.querySelectorAll('.tab')),
    panels: {
      text: $('panel-text'), wifi: $('panel-wifi'), email: $('panel-email'), phone: $('panel-phone'),
    },
    text: $('textInput'),
    wifiSsid: $('wifiSsid'), wifiPass: $('wifiPass'), wifiSec: $('wifiSec'), wifiHidden: $('wifiHidden'),
    mailTo: $('mailTo'), mailSubject: $('mailSubject'), mailBody: $('mailBody'),
    phone: $('phoneInput'),
    fg: $('fgColor'), bg: $('bgColor'), fgHex: $('fgHex'), bgHex: $('bgHex'),
    shapeBtns: Array.from(document.querySelectorAll('#shapeGroup button')),
    ecc: $('eccSelect'),
    size: $('sizeRange'), sizeOut: $('sizeOut'),
    margin: $('marginRange'), marginOut: $('marginOut'),
    reset: $('resetBtn'),
    canvas: $('previewCanvas'), placeholder: $('placeholder'),
    meta: $('meta'), warn: $('warn'), error: $('error'),
    dlPng: $('dlPng'), dlSvg: $('dlSvg'), copy: $('copyBtn'),
    toast: $('toast'),
  };

  const state = { type: 'text', shape: 'square', theme: 'snow', qr: null };

  // ---------- Storage (may be blocked, so always guarded) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };

  // ---------- Payload builders ----------
  const escapeWifi = (s) => s.replace(/([\\;,:"])/g, '\\$1');

  function getPayload() {
    switch (state.type) {
      case 'wifi': {
        const ssid = el.wifiSsid.value;
        if (!ssid) return '';
        const sec = el.wifiSec.value;
        const pass = sec === 'nopass' ? '' : `P:${escapeWifi(el.wifiPass.value)};`;
        const hidden = el.wifiHidden.checked ? 'H:true;' : '';
        return `WIFI:T:${sec};S:${escapeWifi(ssid)};${pass}${hidden};`;
      }
      case 'email': {
        const to = el.mailTo.value.trim();
        if (!to) return '';
        const params = [];
        if (el.mailSubject.value.trim()) params.push('subject=' + encodeURIComponent(el.mailSubject.value.trim()));
        if (el.mailBody.value.trim()) params.push('body=' + encodeURIComponent(el.mailBody.value.trim()));
        return 'mailto:' + to + (params.length ? '?' + params.join('&') : '');
      }
      case 'phone': {
        const n = el.phone.value.replace(/[^\d+]/g, '');
        return n ? 'tel:' + n : '';
      }
      default:
        return el.text.value.trim();
    }
  }

  // ---------- Colour helpers ----------
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function contrastNotice(fg, bg) {
    const lf = luminance(fg);
    const lb = luminance(bg);
    if (lf > lb) return 'The code is lighter than its background. Many scanners can only read dark-on-light codes.';
    const ratio = (lb + 0.05) / (lf + 0.05);
    if (ratio < 4) return 'Low contrast between code and background — it may be hard to scan. Try a darker code colour.';
    return '';
  }

  // ---------- Rendering ----------
  const isFinder = (x, y, n) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

  // "Connected" rounding: a module only rounds a corner that sticks out, i.e. when
  // neither neighbour touching that corner is dark. Blocks of modules (like the three
  // finder squares) stay solid, so the code keeps scanning reliably.
  const ROUND = 0.5; // corner radius as a fraction of one module

  function cornersOf(qr, x, y) {
    const d = (xx, yy) => xx >= 0 && yy >= 0 && xx < qr.size && yy < qr.size && qr.modules[yy][xx];
    const up = d(x, y - 1), down = d(x, y + 1), left = d(x - 1, y), right = d(x + 1, y);
    return [!up && !left, !up && !right, !down && !right, !down && !left]; // tl, tr, br, bl
  }

  function roundedModulePath(ctx, x, y, s, c) {
    const r = s * ROUND;
    const [tl, tr, br, bl] = c.map((on) => (on ? r : 0));
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + s - tr, y);
    if (tr) ctx.arcTo(x + s, y, x + s, y + tr, tr);
    ctx.lineTo(x + s, y + s - br);
    if (br) ctx.arcTo(x + s, y + s, x + s - br, y + s, br);
    ctx.lineTo(x + bl, y + s);
    if (bl) ctx.arcTo(x, y + s, x, y + s - bl, bl);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  /** Draws the QR code onto `canvas` at roughly `targetPx` and returns the real pixel size. */
  function paint(canvas, qr, opt, targetPx) {
    const n = qr.size;
    const total = n + opt.margin * 2;
    const cell = Math.max(1, Math.floor(targetPx / total));
    const px = cell * total;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = opt.bg;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opt.fg;
    ctx.beginPath();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!qr.modules[y][x]) continue;
        const cx = (x + opt.margin) * cell;
        const cy = (y + opt.margin) * cell;
        if (opt.shape === 'rounded') {
          roundedModulePath(ctx, cx, cy, cell, cornersOf(qr, x, y));
        } else if (opt.shape === 'dots' && !isFinder(x, y, n)) {
          ctx.moveTo(cx + cell / 2 + cell * 0.45, cy + cell / 2);
          ctx.arc(cx + cell / 2, cy + cell / 2, cell * 0.45, 0, Math.PI * 2);
        } else {
          ctx.rect(cx, cy, cell, cell);
        }
      }
    }
    ctx.fill();
    return px;
  }

  /** Builds an SVG string in module units, scaled to `px` pixels. */
  function toSVG(qr, opt, px) {
    const n = qr.size;
    const m = opt.margin;
    const total = n + m * 2;
    let d = '';
    if (opt.shape === 'square') {
      // Merge horizontal runs to keep the file small
      for (let y = 0; y < n; y++) {
        let x = 0;
        while (x < n) {
          if (!qr.modules[y][x]) { x++; continue; }
          const start = x;
          while (x < n && qr.modules[y][x]) x++;
          const len = x - start;
          d += `M${start + m} ${y + m}h${len}v1h-${len}z`;
        }
      }
    } else {
      const r = ROUND;
      const dr = 0.45;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (!qr.modules[y][x]) continue;
          const gx = x + m;
          const gy = y + m;
          if (opt.shape === 'rounded') {
            const [tl, tr, br, bl] = cornersOf(qr, x, y).map((on) => (on ? r : 0));
            d += `M${gx + tl} ${gy}H${gx + 1 - tr}`;
            if (tr) d += `a${tr} ${tr} 0 0 1 ${tr} ${tr}`;
            d += `V${gy + 1 - br}`;
            if (br) d += `a${br} ${br} 0 0 1 -${br} ${br}`;
            d += `H${gx + bl}`;
            if (bl) d += `a${bl} ${bl} 0 0 1 -${bl} -${bl}`;
            d += `V${gy + tl}`;
            if (tl) d += `a${tl} ${tl} 0 0 1 ${tl} -${tl}`;
            d += 'z';
          } else if (isFinder(x, y, n)) {
            d += `M${gx} ${gy}h1v1h-1z`;
          } else {
            d += `M${gx + 0.5 + dr} ${gy + 0.5}a${dr} ${dr} 0 1 0 -${2 * dr} 0a${dr} ${dr} 0 1 0 ${2 * dr} 0z`;
          }
        }
      }
    }
    const crisp = opt.shape === 'square' ? ' shape-rendering="crispEdges"' : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}"${crisp}>` +
      `<rect width="${total}" height="${total}" fill="${opt.bg}"/>` +
      `<path fill="${opt.fg}" d="${d}"/></svg>\n`;
  }

  const options = () => ({
    fg: el.fg.value, bg: el.bg.value, shape: state.shape, margin: +el.margin.value,
  });

  // ---------- Main render ----------
  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  function setActionsEnabled(on) {
    el.dlPng.disabled = !on;
    el.dlSvg.disabled = !on;
    el.copy.disabled = !on;
  }

  function render() {
    const payload = getPayload();
    const opt = options();
    el.fgHex.textContent = opt.fg;
    el.bgHex.textContent = opt.bg;
    el.sizeOut.textContent = el.size.value + ' px';
    el.marginOut.textContent = el.margin.value;

    state.qr = null;
    showError('');
    el.warn.hidden = true;

    if (!payload) {
      el.canvas.hidden = true;
      el.placeholder.hidden = false;
      el.meta.textContent = '';
      setActionsEnabled(false);
      return;
    }

    let qr;
    try {
      qr = QR.encode(payload, el.ecc.value);
    } catch (err) {
      el.canvas.hidden = true;
      el.placeholder.hidden = false;
      el.meta.textContent = '';
      setActionsEnabled(false);
      showError(`That is too much for a single QR code (limit is about ${QR.maxBytes(el.ecc.value)} characters at this error-correction level). Shorten it or choose a lower level.`);
      return;
    }

    state.qr = qr;
    const dpr = window.devicePixelRatio || 1;
    paint(el.canvas, qr, opt, Math.round(300 * dpr));
    el.canvas.hidden = false;
    el.placeholder.hidden = true;
    el.meta.textContent = `Version ${qr.version} · ${qr.size}×${qr.size} modules · ${qr.dataBytes} bytes`;

    const notice = contrastNotice(opt.fg, opt.bg);
    el.warn.textContent = notice;
    el.warn.hidden = !notice;
    setActionsEnabled(true);
  }

  let timer = 0;
  const renderSoon = () => { clearTimeout(timer); timer = setTimeout(render, 120); };

  // ---------- Downloads ----------
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pngBlob() {
    return new Promise((resolve, reject) => {
      const c = document.createElement('canvas');
      paint(c, state.qr, options(), +el.size.value);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png');
    });
  }

  const fileStem = () => `qr-${state.type}`;

  el.dlPng.addEventListener('click', async () => {
    if (!state.qr) return;
    try {
      saveBlob(await pngBlob(), fileStem() + '.png');
      toast('PNG downloaded');
    } catch (_) { toast('Sorry, the download failed'); }
  });

  el.dlSvg.addEventListener('click', () => {
    if (!state.qr) return;
    const svg = toSVG(state.qr, options(), +el.size.value);
    saveBlob(new Blob([svg], { type: 'image/svg+xml' }), fileStem() + '.svg');
    toast('SVG downloaded');
  });

  el.copy.addEventListener('click', async () => {
    if (!state.qr) return;
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      toast('Copying images isn’t supported here — use Download instead');
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pngBlob() })]);
      toast('Image copied to clipboard');
    } catch (_) { toast('Couldn’t copy — try Download instead'); }
  });

  // ---------- Themes ----------
  function applyTheme(key, { recolor }) {
    const theme = THEMES.find((t) => t.key === key) || THEMES[0];
    state.theme = theme.key;
    document.documentElement.dataset.theme = theme.key;
    Array.from(el.themeList.children).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === theme.key)));
    if (recolor) {
      el.fg.value = theme.fg;
      el.bg.value = theme.bg;
    }
    store.set('qr-theme', theme.key);
  }

  THEMES.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-btn';
    b.dataset.key = t.key;
    b.title = t.label;
    b.setAttribute('aria-label', `${t.label} theme`);
    b.setAttribute('aria-pressed', 'false');
    b.style.setProperty('--dot', t.dot);
    b.addEventListener('click', () => { applyTheme(t.key, { recolor: true }); render(); });
    el.themeList.appendChild(b);
  });

  // ---------- Tabs ----------
  function selectTab(type, focus) {
    state.type = type;
    el.tabs.forEach((t) => {
      const on = t.dataset.type === type;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    Object.entries(el.panels).forEach(([k, p]) => { p.hidden = k !== type; });
    render();
  }

  el.tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.dataset.type, false));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = el.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + el.tabs.length) % el.tabs.length];
      selectTab(next.dataset.type, true);
    });
  });

  // ---------- Style controls ----------
  el.shapeBtns.forEach((b) => b.addEventListener('click', () => {
    state.shape = b.dataset.style;
    el.shapeBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));

  [el.text, el.wifiSsid, el.wifiPass, el.mailTo, el.mailSubject, el.mailBody, el.phone].forEach((i) => i.addEventListener('input', renderSoon));
  [el.wifiSec, el.wifiHidden, el.ecc].forEach((i) => i.addEventListener('change', render));
  [el.fg, el.bg, el.size, el.margin].forEach((i) => i.addEventListener('input', render));

  el.reset.addEventListener('click', () => {
    [el.text, el.wifiSsid, el.wifiPass, el.mailTo, el.mailSubject, el.mailBody, el.phone].forEach((i) => { i.value = ''; });
    el.wifiSec.value = 'WPA';
    el.wifiHidden.checked = false;
    el.ecc.value = 'M';
    el.size.value = 512;
    el.margin.value = 4;
    state.shape = 'square';
    el.shapeBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.style === 'square')));
    applyTheme('snow', { recolor: true });
    selectTab('text', false);
    toast('Reset');
  });

  // ---------- Init ----------
  const saved = store.get('qr-theme');
  applyTheme(THEMES.some((t) => t.key === saved) ? saved : 'snow', { recolor: true });
  render();
})();