// Notensammlung – Schritt 1: Sammlung, Import, Anzeige, Halbseiten-Blättern, Fußpedal, Metronom
import * as pdfjsLib from './lib/pdf.min.mjs';

const APP_VERSION = '0.1.0';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

/* =========================================================
   Datenbank (IndexedDB) – bleibt lokal auf dem iPad
   Stores schon für spätere Schritte angelegt:
   scores, files, songbooks, annotations
   ========================================================= */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('notensammlung', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('scores')) d.createObjectStore('scores', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('songbooks')) d.createObjectStore('songbooks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('annotations')) {
          const a = d.createObjectStore('annotations', { keyPath: 'key' });
          a.createIndex('songbookId', 'songbookId');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  all(store) { return this.run(store, 'readonly', (s) => s.getAll()); },
  get(store, id) { return this.run(store, 'readonly', (s) => s.get(id)); },
  put(store, obj) { return this.run(store, 'readwrite', (s) => s.put(obj)); },
  del(store, id) { return this.run(store, 'readwrite', (s) => s.delete(id)); },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* =========================================================
   Hilfsfunktionen
   ========================================================= */
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

function groupLetter(title) {
  const c = (title || '').trim().charAt(0).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}
function titleFromFile(name) {
  return name.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2).replace('.', ',') + ' GB';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}

/* =========================================================
   Bildschirm 1: Notensammlung
   ========================================================= */
let scores = [];

async function loadScores() {
  scores = await DB.all('scores');
  scores.sort((a, b) => collator.compare(a.title, b.title));
  renderList();
  updateStorageInfo();
}

function matches(s, q) {
  if (!q) return true;
  const hay = [s.title, s.composer, ...(s.tags || [])].join(' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  const q = $('search').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const list = $('list');
  const visible = scores.filter((s) => matches(s, q));
  $('count').textContent = scores.length === 1 ? '1 Stück' : `${scores.length} Stücke`;
  $('empty').classList.toggle('hidden', scores.length > 0);

  let html = '';
  let current = null;
  const letters = new Set();
  for (const s of visible) {
    const L = groupLetter(s.title);
    if (L !== current) {
      current = L;
      letters.add(L);
      html += `<div class="group-letter" id="grp-${L === '#' ? 'num' : L}">${L}</div>`;
    }
    const tags = (s.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const meta = [s.composer, s.pages ? `${s.pages} S.` : ''].filter(Boolean).map(esc).join(' · ');
    html += `<div class="row" data-id="${s.id}">
      <div class="main"><div class="title">${esc(s.title)}</div><div class="sub">${meta}${tags}</div></div>
      <button class="more" data-edit="${s.id}" aria-label="Bearbeiten">⋯</button>
    </div>`;
  }
  if (!visible.length && scores.length) html = `<p class="muted" style="padding:24px 4px">Nichts gefunden.</p>`;
  list.innerHTML = html;

  const rail = $('rail');
  const all = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  rail.innerHTML = all.map((L) => `<button data-letter="${L}" ${letters.has(L) ? '' : 'disabled'}>${L}</button>`).join('');
}

$('list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEdit(edit.dataset.edit); return; }
  const row = e.target.closest('.row');
  if (row) openViewer(row.dataset.id);
});
$('rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-letter]');
  if (!b || b.disabled) return;
  const el = $('grp-' + (b.dataset.letter === '#' ? 'num' : b.dataset.letter));
  if (el) el.scrollIntoView({ block: 'start' });
});
$('search').addEventListener('input', renderList);

async function updateStorageInfo() {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      $('storage').textContent = `Speicher: ${fmtBytes(usage || 0)} belegt${quota ? ' von ' + fmtBytes(quota) : ''}` +
        (persisted ? ' · dauerhaft' : '');
    }
  } catch { /* egal */ }
}

/* ---------- Import ---------- */
$('btnImport').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await importFiles(files);
});

async function importFiles(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Keine PDF-Dateien ausgewählt.'); return; }
  // Daten dauerhaft speichern lassen (schützt vor automatischem Löschen durch Safari)
  try { await navigator.storage?.persist?.(); } catch { /* egal */ }

  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    toast(`Importiere ${i + 1} von ${pdfs.length}: ${f.name}`, 10000);
    if (scores.some((s) => s.fileName === f.name && s.size === f.size)) { skipped++; continue; }
    try {
      const buf = await f.arrayBuffer();
      const task = pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) });
      const doc = await task.promise;
      const pages = doc.numPages;
      await task.destroy();
      const id = uid();
      await DB.put('files', { id, data: buf });
      const score = {
        id, title: titleFromFile(f.name), composer: '', tags: [],
        fileName: f.name, size: f.size, pages, added: Date.now(), tempo: null,
      };
      await DB.put('scores', score);
      scores.push(score);
      added++;
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  scores.sort((a, b) => collator.compare(a.title, b.title));
  renderList();
  updateStorageInfo();
  const parts = [`${added} importiert`];
  if (skipped) parts.push(`${skipped} schon vorhanden`);
  if (failed) parts.push(`${failed} fehlerhaft`);
  toast(parts.join(' · '));
}

// Drag & Drop am PC
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ($('library').classList.contains('active')) { dragDepth++; $('dropHint').classList.remove('hidden'); e.preventDefault(); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.add('hidden');
  if ($('library').classList.contains('active') && e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
});

/* ---------- Bearbeiten / Löschen ---------- */
let editingId = null;
function openEdit(id) {
  const s = scores.find((x) => x.id === id);
  if (!s) return;
  editingId = id;
  $('fTitle').value = s.title;
  $('fComposer').value = s.composer || '';
  $('fTags').value = (s.tags || []).join(', ');
  $('fInfo').textContent = `Datei: ${s.fileName} · ${s.pages} Seiten · ${fmtBytes(s.size)}`;
  $('editDlg').showModal();
}
$('fCancel').addEventListener('click', () => $('editDlg').close());
$('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = scores.find((x) => x.id === editingId);
  if (!s) return;
  s.title = $('fTitle').value.trim() || s.title;
  s.composer = $('fComposer').value.trim();
  s.tags = $('fTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  await DB.put('scores', s);
  $('editDlg').close();
  scores.sort((a, b) => collator.compare(a.title, b.title));
  renderList();
});
$('fDelete').addEventListener('click', async () => {
  const s = scores.find((x) => x.id === editingId);
  if (!s) return;
  const ok = await confirmDlg('Stück löschen?', `„${s.title}“ wird aus der Sammlung entfernt. Die Datei auf deinem PC bleibt erhalten.`);
  if (!ok) return;
  await DB.del('scores', s.id);
  await DB.del('files', s.id);
  scores = scores.filter((x) => x.id !== s.id);
  $('editDlg').close();
  renderList();
  updateStorageInfo();
  toast('Gelöscht');
});
function confirmDlg(title, text) {
  return new Promise((resolve) => {
    const d = $('confirmDlg');
    $('cTitle').textContent = title;
    $('cText').textContent = text;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}

/* =========================================================
   Notenansicht mit Halbseiten-Blättern
   step-Logik:
   - normal:  step = Seitenindex (0 … n-1)
   - halb:    gerade step 2k  -> Seite k komplett
              ungerade 2k+1   -> oben Seite k+1, unten noch Seite k
   ========================================================= */
const V = {
  score: null, task: null, doc: null, n: 0, step: 0, half: false,
  cache: new Map(), // Seitenindex -> Promise<Canvas>
  renderToken: 0, hideTimer: null,
};

async function openViewer(id) {
  const score = scores.find((s) => s.id === id);
  const file = await DB.get('files', id);
  if (!score || !file) { toast('Datei nicht gefunden.'); return; }
  closeDoc();
  V.score = score;
  V.half = localStorage.getItem('halfPage') === '1';
  $('btnHalf').classList.toggle('on', V.half);
  $('vtitle').textContent = score.title;
  showView('viewer');
  try {
    V.task = pdfjsLib.getDocument({ data: new Uint8Array(file.data) });
    V.doc = await V.task.promise;
  } catch (err) {
    console.error(err);
    toast('PDF konnte nicht geöffnet werden.');
    showView('library');
    return;
  }
  V.n = V.doc.numPages;
  V.step = 0;
  Metro.loadFor(score);
  showChrome(true);
  draw();
}

function closeDoc() {
  V.cache.clear();
  if (V.task) { V.task.destroy(); V.task = null; }
  V.doc = null;
}

function maxStep() { return V.half ? Math.max(0, 2 * V.n - 2) : V.n - 1; }

function stageSize() {
  const st = $('stage');
  return { w: st.clientWidth, h: st.clientHeight, dpr: Math.min(window.devicePixelRatio || 1, 3) };
}

// Seite als Canvas rendern, passend (contain) in die Bühne
function pageCanvas(i) {
  if (V.cache.has(i)) return V.cache.get(i);
  const p = (async () => {
    const page = await V.doc.getPage(i + 1);
    const { w, h, dpr } = stageSize();
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(w / vp1.width, h / vp1.height);
    const vp = page.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  })();
  V.cache.set(i, p);
  return p;
}

function trimCache(keep) {
  for (const k of V.cache.keys()) if (Math.abs(k - keep) > 3) V.cache.delete(k);
}

async function draw() {
  if (!V.doc) return;
  const token = ++V.renderToken;
  const { w, h, dpr } = stageSize();
  const canvas = $('canvas');
  const W = Math.floor(w * dpr), H = Math.floor(h * dpr);

  let top, bottom; // Seitenindizes
  if (!V.half) { top = bottom = V.step; }
  else if (V.step % 2 === 0) { top = bottom = V.step / 2; }
  else { bottom = (V.step - 1) / 2; top = bottom + 1; }

  const [cTop, cBottom] = await Promise.all([pageCanvas(top), pageCanvas(bottom)]);
  if (token !== V.renderToken) return;

  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2B2A33';
  ctx.fillRect(0, 0, W, H);

  const place = (c) => ({ x: Math.round((W - c.width) / 2), y: Math.round((H - c.height) / 2) });
  if (top === bottom) {
    const p = place(cTop);
    ctx.drawImage(cTop, p.x, p.y);
  } else {
    const mid = Math.round(H / 2);
    // untere Hälfte: aktuelle Seite
    ctx.save(); ctx.beginPath(); ctx.rect(0, mid, W, H - mid); ctx.clip();
    const pb = place(cBottom); ctx.drawImage(cBottom, pb.x, pb.y); ctx.restore();
    // obere Hälfte: schon die nächste Seite
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, mid); ctx.clip();
    const pt = place(cTop); ctx.drawImage(cTop, pt.x, pt.y); ctx.restore();
    // Trennlinie
    ctx.fillStyle = '#D9A04A';
    ctx.fillRect(0, mid - Math.round(2 * dpr), W, Math.round(4 * dpr));
  }
  updatePageInfo(top, bottom);

  // Nachbarseiten vorbereiten
  trimCache(top);
  if (top + 1 < V.n) pageCanvas(top + 1);
  if (top + 2 < V.n) pageCanvas(top + 2);
}

function updatePageInfo(top, bottom) {
  const info = top === bottom
    ? `Seite ${top + 1} von ${V.n}`
    : `oben Seite ${top + 1} · unten Seite ${bottom + 1} · von ${V.n}`;
  $('pageInfo').textContent = info;
}

function go(delta) {
  if (!V.doc) return;
  const next = Math.min(maxStep(), Math.max(0, V.step + delta));
  if (next === V.step) {
    if (delta > 0) toast('Letzte Seite', 1200);
    return;
  }
  V.step = next;
  draw();
}

function setHalf(on) {
  if (V.half === on) return;
  if (on) V.step = V.step * 2; // Seite k -> step 2k
  else V.step = Math.ceil(V.step / 2); // halb: zeige die obere (neue) Seite
  V.half = on;
  V.step = Math.min(V.step, maxStep());
  localStorage.setItem('halfPage', on ? '1' : '0');
  $('btnHalf').classList.toggle('on', on);
  toast(on ? 'Halbe Seiten blättern: an' : 'Halbe Seiten blättern: aus', 1500);
  draw();
}

/* ---------- Bedienleisten ---------- */
function showChrome(autoHide) {
  $('viewer').classList.remove('chrome-hidden');
  clearTimeout(V.hideTimer);
  if (autoHide) V.hideTimer = setTimeout(() => {
    if ($('metro').classList.contains('hidden')) $('viewer').classList.add('chrome-hidden');
  }, 2500);
}
function toggleChrome() {
  const hidden = $('viewer').classList.contains('chrome-hidden');
  if (hidden) showChrome(false); else $('viewer').classList.add('chrome-hidden');
}

$('btnBack').addEventListener('click', () => {
  Metro.stop();
  $('metro').classList.add('hidden');
  closeDoc();
  showView('library');
});
$('btnHalf').addEventListener('click', () => setHalf(!V.half));

/* ---------- Touch: tippen links/rechts, wischen ---------- */
let ptr = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') return; // Pencil ist für Notizen reserviert (Schritt 3)
  ptr = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
});
$('stage').addEventListener('pointerup', (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  const dt = performance.now() - ptr.t;
  ptr = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
    go(dx < 0 ? 1 : -1);
    return;
  }
  if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
    const w = $('stage').clientWidth;
    if (e.clientX < w / 3) go(-1);
    else if (e.clientX > (2 * w) / 3) go(1);
    else toggleChrome();
  }
});
$('stage').addEventListener('pointercancel', () => { ptr = null; });

/* ---------- Tastatur / Bluetooth-Fußpedal ---------- */
document.addEventListener('keydown', (e) => {
  if (!$('viewer').classList.contains('active')) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const nextKeys = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
  const prevKeys = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
  if (nextKeys.includes(e.key)) { e.preventDefault(); go(1); }
  else if (prevKeys.includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key === 'Escape') $('btnBack').click();
});

/* ---------- Größe / Drehen ---------- */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (V.doc) { V.cache.clear(); draw(); } }, 150);
});

/* =========================================================
   Metronom (Web Audio, exaktes Timing mit Vorausplanung)
   ========================================================= */
const Metro = {
  ctx: null, bpm: 100, beats: 4, running: false, nextTime: 0, beat: 0, timer: null,
  taps: [], saveTimer: null, score: null,

  loadFor(score) {
    this.stop();
    this.score = score;
    this.setBpm(score.tempo?.bpm || Number(localStorage.getItem('lastBpm')) || 100, false);
    this.beats = score.tempo?.beats || 4;
    $('beatsSelect').value = String(this.beats);
    this.renderBeats(-1);
  },
  setBpm(v, save = true) {
    this.bpm = Math.max(30, Math.min(240, Math.round(v)));
    $('bpmValue').textContent = this.bpm;
    $('bpmSlider').value = this.bpm;
    if (save) this.save();
  },
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      localStorage.setItem('lastBpm', this.bpm);
      if (this.score) {
        this.score.tempo = { bpm: this.bpm, beats: this.beats };
        DB.put('scores', this.score);
      }
    }, 600);
  },
  start() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();
    this.running = true;
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.schedule(), 25);
    $('metroStart').textContent = 'Stopp';
    $('btnMetro').classList.add('on');
    $('beatDot').classList.remove('hidden');
  },
  stop() {
    this.running = false;
    clearInterval(this.timer);
    $('metroStart').textContent = 'Start';
    $('btnMetro').classList.toggle('on', !$('metro').classList.contains('hidden'));
    $('beatDot').classList.add('hidden');
    this.renderBeats(-1);
  },
  schedule() {
    const ahead = 0.12;
    while (this.nextTime < this.ctx.currentTime + ahead) {
      const b = this.beat % this.beats;
      const accent = this.beats > 1 && b === 0;
      this.click(this.nextTime, accent);
      const delay = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
      setTimeout(() => this.visual(b, accent), delay);
      this.nextTime += 60 / this.bpm;
      this.beat++;
    }
  },
  click(t, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.06);
  },
  visual(b, accent) {
    if (!this.running) return;
    this.renderBeats(b);
    const d = $('beatDot');
    d.classList.toggle('accent', accent);
    d.classList.add('flash');
    setTimeout(() => d.classList.remove('flash'), 90);
  },
  renderBeats(active) {
    const n = this.beats > 1 ? this.beats : 1;
    $('beatRow').innerHTML = Array.from({ length: n }, (_, i) =>
      `<i class="${i === active ? 'on' : ''} ${i === 0 && this.beats > 1 ? 'accent' : ''}"></i>`).join('');
  },
  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) {
      const iv = [];
      for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
      this.setBpm(60000 / avg);
    }
  },
};

$('btnMetro').addEventListener('click', () => {
  const panel = $('metro');
  panel.classList.toggle('hidden');
  $('btnMetro').classList.toggle('on', !panel.classList.contains('hidden') || Metro.running);
  showChrome(false);
});
$('metroClose').addEventListener('click', () => {
  $('metro').classList.add('hidden');
  $('btnMetro').classList.toggle('on', Metro.running);
  showChrome(true);
});
$('metroStart').addEventListener('click', () => (Metro.running ? Metro.stop() : Metro.start()));
$('bpmMinus').addEventListener('click', () => Metro.setBpm(Metro.bpm - 1));
$('bpmPlus').addEventListener('click', () => Metro.setBpm(Metro.bpm + 1));
$('bpmSlider').addEventListener('input', (e) => Metro.setBpm(Number(e.target.value)));
$('btnTap').addEventListener('click', () => Metro.tap());
$('beatsSelect').addEventListener('change', (e) => {
  Metro.beats = Number(e.target.value);
  Metro.beat = 0;
  Metro.renderBeats(-1);
  Metro.save();
});

/* =========================================================
   Start
   ========================================================= */
async function init() {
  $('version').textContent = 'Version ' + APP_VERSION;
  try {
    await DB.open();
  } catch (err) {
    console.error(err);
    toast('Speicher konnte nicht geöffnet werden.', 8000);
    return;
  }
  await loadScores();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker:', err));
  }
}
init();

// Für automatische Tests
window.__ns = { DB, V, Metro, importFiles, openViewer, go, setHalf, get scores() { return scores; } };
