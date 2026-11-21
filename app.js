// Notensammlung – Schritt 2: Sammlung, Songbooks, Anzeige, Halbseiten-Blättern, Fußpedal, Metronom
import * as pdfjsLib from './lib/pdf.min.mjs';

const APP_VERSION = '0.2.1';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

/* =========================================================
   Datenbank (IndexedDB) – bleibt lokal auf dem Gerät
   scores, files, songbooks, annotations (Schritt 3)
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
  delByIndex(store, index, value) {
    return this.run(store, 'readwrite', (s) => {
      const r = s.index(index).openCursor(IDBKeyRange.only(value));
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
    });
  },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* =========================================================
   Hilfsfunktionen
   ========================================================= */
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function groupLetter(title) {
  const c = norm((title || '').trim().charAt(0)).toUpperCase();
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
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
function confirmDlg(title, text, yes = 'Löschen') {
  return new Promise((resolve) => {
    const d = $('confirmDlg');
    $('cTitle').textContent = title;
    $('cText').textContent = text;
    $('cYes').textContent = yes;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}

/* =========================================================
   Daten im Speicher
   ========================================================= */
let scores = [];
let songbooks = [];
const scoreById = (id) => scores.find((s) => s.id === id);
const sortScores = () => scores.sort((a, b) => collator.compare(a.title, b.title));
const sortSongbooks = () => songbooks.sort((a, b) => collator.compare(a.name, b.name));
function sbItems(sb) { return sb.entries.map((en) => ({ en, s: scoreById(en.scoreId) })).filter((x) => x.s); }
function sbPages(sb) { return sbItems(sb).reduce((n, x) => n + (x.s.pages || 0), 0); }
async function saveSongbook(sb) { sb.updated = Date.now(); await DB.put('songbooks', sb); }

/* =========================================================
   Bildschirm 1: Sammlung mit Reitern „Noten“ und „Songbooks“
   ========================================================= */
let tab = localStorage.getItem('tab') === 'songbooks' ? 'songbooks' : 'scores';

function setTab(t) {
  tab = t;
  localStorage.setItem('tab', t);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('btnPrimary').textContent = t === 'scores' ? '+ Importieren' : '+ Neues Songbook';
  $('search').placeholder = t === 'scores' ? 'Suchen nach Titel, Komponist oder Tag …' : 'Songbook suchen …';
  $('list').classList.toggle('hidden', t !== 'scores');
  $('rail').classList.toggle('hidden', t !== 'scores');
  $('sbList').classList.toggle('hidden', t !== 'songbooks');
  renderLibrary();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('btnPrimary').addEventListener('click', () => (tab === 'scores' ? $('fileInput').click() : openSbDialog(null)));
$('search').addEventListener('input', renderLibrary);

function renderLibrary() {
  if (tab === 'scores') renderList(); else renderSongbookList();
}

function matches(s, q) {
  if (!q) return true;
  const hay = norm([s.title, s.composer, ...(s.tags || [])].join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function setEmpty(show, title, text) {
  $('empty').classList.toggle('hidden', !show);
  if (show) $('empty').innerHTML = `<p class="empty-title">${title}</p><p>${text}</p>`;
}

function renderList() {
  const q = norm($('search').value.trim());
  const visible = scores.filter((s) => matches(s, q));
  $('count').textContent = plural(scores.length, 'Stück', 'Stücke');
  setEmpty(!scores.length, 'Noch keine Noten', 'Tippe auf <b>+ Importieren</b> und wähle eine oder mehrere PDF-Dateien aus.');

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
  $('list').innerHTML = html;

  const all = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  $('rail').innerHTML = all.map((L) => `<button data-letter="${L}" ${letters.has(L) ? '' : 'disabled'}>${L}</button>`).join('');
}

function renderSongbookList() {
  const q = norm($('search').value.trim());
  const visible = songbooks.filter((sb) => !q || norm(sb.name).includes(q));
  $('count').textContent = plural(songbooks.length, 'Songbook', 'Songbooks');
  setEmpty(!songbooks.length, 'Noch keine Songbooks',
    'Tippe auf <b>+ Neues Songbook</b>, gib ihm einen Namen und füge Stücke aus deiner Sammlung hinzu.');
  let html = visible.map((sb) => {
    const n = sbItems(sb).length;
    return `<div class="row sbrow" data-sb="${sb.id}">
      <div class="main"><div class="title">${esc(sb.name)}</div>
      <div class="sub">${plural(n, 'Stück', 'Stücke')} · ${sbPages(sb)} S.</div></div>
      <button class="more play" data-play="${sb.id}" aria-label="Spielen">▶</button>
    </div>`;
  }).join('');
  if (!visible.length && songbooks.length) html = `<p class="muted" style="padding:24px 4px">Nichts gefunden.</p>`;
  $('sbList').innerHTML = html;
}

$('list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openEdit(edit.dataset.edit); return; }
  const row = e.target.closest('.row');
  if (row) openViewer(row.dataset.id);
});
$('sbList').addEventListener('click', (e) => {
  const play = e.target.closest('[data-play]');
  if (play) { const sb = songbooks.find((x) => x.id === play.dataset.play); if (sb) openSongbookPlayer(sb, 0); return; }
  const row = e.target.closest('[data-sb]');
  if (row) openSongbook(row.dataset.sb);
});
$('rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-letter]');
  if (!b || b.disabled) return;
  const el = $('grp-' + (b.dataset.letter === '#' ? 'num' : b.dataset.letter));
  if (el) el.scrollIntoView({ block: 'start' });
});

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
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await importFiles(files);
});

async function importFiles(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Keine PDF-Dateien ausgewählt.'); return; }
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
  sortScores();
  if (tab !== 'scores') setTab('scores'); else renderList();
  updateStorageInfo();
  const parts = [`${added} importiert`];
  if (skipped) parts.push(`${skipped} schon vorhanden`);
  if (failed) parts.push(`${failed} fehlerhaft`);
  toast(parts.join(' · '));
}

// Drag & Drop am PC
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  if ($('library').classList.contains('active')) { dragDepth++; $('dropHint').classList.remove('hidden'); e.preventDefault(); }
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.add('hidden');
  if ($('library').classList.contains('active') && e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
});

/* ---------- Stück bearbeiten / löschen / zu Songbook hinzufügen ---------- */
let editingId = null;
function openEdit(id) {
  const s = scoreById(id);
  if (!s) return;
  editingId = id;
  $('fTitle').value = s.title;
  $('fComposer').value = s.composer || '';
  $('fTags').value = (s.tags || []).join(', ');
  $('fInfo').textContent = `Datei: ${s.fileName} · ${s.pages} Seiten · ${fmtBytes(s.size)}`;
  renderEditSongbooks();
  $('editDlg').showModal();
}
function renderEditSongbooks() {
  const s = scoreById(editingId);
  const sel = $('fSongbook');
  sel.innerHTML = songbooks.length
    ? songbooks.map((sb) => `<option value="${sb.id}">${esc(sb.name)}</option>`).join('')
    : '<option value="">Noch keine Songbooks</option>';
  sel.disabled = !songbooks.length;
  $('fAddTo').disabled = !songbooks.length;
  const inSbs = songbooks.filter((sb) => sb.entries.some((e) => e.scoreId === s.id)).map((sb) => sb.name);
  $('fIn').textContent = inSbs.length ? 'Enthalten in: ' + inSbs.join(', ') : 'In keinem Songbook enthalten.';
}
$('fAddTo').addEventListener('click', async () => {
  const sb = songbooks.find((x) => x.id === $('fSongbook').value);
  if (!sb) return;
  sb.entries.push({ eid: uid(), scoreId: editingId });
  await saveSongbook(sb);
  renderEditSongbooks();
  toast(`Zu „${sb.name}“ hinzugefügt`);
});
$('fCancel').addEventListener('click', () => $('editDlg').close());
$('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = scoreById(editingId);
  if (!s) return;
  s.title = $('fTitle').value.trim() || s.title;
  s.composer = $('fComposer').value.trim();
  s.tags = $('fTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  await DB.put('scores', s);
  $('editDlg').close();
  sortScores();
  renderList();
});
$('fDelete').addEventListener('click', async () => {
  const s = scoreById(editingId);
  if (!s) return;
  const affected = songbooks.filter((sb) => sb.entries.some((e) => e.scoreId === s.id));
  const extra = affected.length ? ` Es wird auch aus ${plural(affected.length, 'Songbook', 'Songbooks')} entfernt.` : '';
  const ok = await confirmDlg('Stück löschen?', `„${s.title}“ wird aus der Sammlung entfernt. Die Datei auf deinem PC bleibt erhalten.${extra}`);
  if (!ok) return;
  for (const sb of affected) {
    sb.entries = sb.entries.filter((e) => e.scoreId !== s.id);
    await saveSongbook(sb);
  }
  await DB.del('scores', s.id);
  await DB.del('files', s.id);
  scores = scores.filter((x) => x.id !== s.id);
  $('editDlg').close();
  renderList();
  updateStorageInfo();
  toast('Gelöscht');
});

/* =========================================================
   Bildschirm 2: Songbook
   Eintrag = { eid, scoreId }  – ein Verweis, keine Kopie des PDFs.
   eid ist eindeutig, damit ein Stück auch zweimal vorkommen darf
   und Notizen (Schritt 3) genau an diesem Eintrag hängen.
   ========================================================= */
let curSb = null;

function openSongbook(id) {
  curSb = songbooks.find((x) => x.id === id);
  if (!curSb) return;
  renderSongbook();
  showView('songbookView');
}

function renderSongbook() {
  const sb = curSb;
  $('sbName').textContent = sb.name;
  const items = sbItems(sb);
  $('sbInfo').textContent = `${plural(items.length, 'Stück', 'Stücke')} · ${sbPages(sb)} Seiten`;
  $('sbEmpty').classList.toggle('hidden', items.length > 0);
  $('sbPlay').disabled = !items.length;
  $('sbEntries').innerHTML = items.map(({ en, s }, i) => `
    <div class="entry" data-eid="${en.eid}">
      <span class="grip" aria-label="Verschieben">☰</span>
      <span class="pos">${i + 1}</span>
      <div class="main" data-playfrom="${i}">
        <div class="title">${esc(s.title)}</div>
        <div class="sub">${[s.composer, `${s.pages} S.`].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
      <button class="more" data-remove="${en.eid}" aria-label="Aus Songbook entfernen">✕</button>
    </div>`).join('');
}

$('sbBack').addEventListener('click', () => { curSb = null; setTab('songbooks'); showView('library'); });
$('sbPlay').addEventListener('click', () => openSongbookPlayer(curSb, 0));
$('sbAdd').addEventListener('click', openPicker);
$('sbMore').addEventListener('click', () => openSbDialog(curSb));
$('sbEmptyAdd').addEventListener('click', openPicker);

$('sbEntries').addEventListener('click', async (e) => {
  if (dragJustEnded) return;
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const idx = curSb.entries.findIndex((x) => x.eid === rm.dataset.remove);
    if (idx < 0) return;
    const title = scoreById(curSb.entries[idx].scoreId)?.title || 'Stück';
    curSb.entries.splice(idx, 1);
    await saveSongbook(curSb);
    renderSongbook();
    toast(`„${title}“ entfernt – das Original bleibt in der Sammlung`);
    return;
  }
  const pf = e.target.closest('[data-playfrom]');
  if (pf) openSongbookPlayer(curSb, Number(pf.dataset.playfrom));
});

/* ---------- Reihenfolge per Ziehen am Griff ☰ ---------- */
let drag = null;
let dragJustEnded = false;
const box = $('sbEntries');

box.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip) return;
  e.preventDefault();
  const row = grip.closest('.entry');
  const r = row.getBoundingClientRect();
  drag = { row, id: e.pointerId, grab: e.clientY - r.top, y: e.clientY, scrollTimer: null };
  row.setPointerCapture(e.pointerId);
  row.classList.add('dragging');
  drag.scrollTimer = setInterval(autoScroll, 30);
});
box.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.y = e.clientY;
  placeDragged();
});
function placeDragged() {
  const { row } = drag;
  row.style.transform = '';
  let r = row.getBoundingClientRect();
  const center = drag.y - drag.grab + r.height / 2;
  let prev = row.previousElementSibling;
  while (prev && center < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
    box.insertBefore(row, prev);
    prev = row.previousElementSibling;
  }
  let next = row.nextElementSibling;
  while (next && center > next.getBoundingClientRect().top + next.offsetHeight / 2) {
    box.insertBefore(row, next.nextElementSibling);
    next = row.nextElementSibling;
  }
  r = row.getBoundingClientRect();
  row.style.transform = `translateY(${drag.y - drag.grab - r.top}px)`;
  [...box.children].forEach((el, i) => { const p = el.querySelector('.pos'); if (p) p.textContent = i + 1; });
}
function autoScroll() {
  if (!drag) return;
  const b = box.getBoundingClientRect();
  const edge = 70;
  let dy = 0;
  if (drag.y < b.top + edge) dy = -Math.ceil((b.top + edge - drag.y) / 6);
  else if (drag.y > b.bottom - edge) dy = Math.ceil((drag.y - (b.bottom - edge)) / 6);
  if (dy) { box.scrollTop += dy; placeDragged(); }
}
async function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  clearInterval(drag.scrollTimer);
  drag.row.classList.remove('dragging');
  drag.row.style.transform = '';
  drag = null;
  dragJustEnded = true;
  setTimeout(() => { dragJustEnded = false; }, 50);
  const order = [...box.querySelectorAll('.entry')].map((el) => el.dataset.eid);
  const byEid = new Map(curSb.entries.map((en) => [en.eid, en]));
  const changed = order.some((eid, i) => sbItems(curSb)[i]?.en.eid !== eid);
  if (!changed) { renderSongbook(); return; }
  // Einträge ohne vorhandenes Stück (sollte nicht vorkommen) hinten behalten
  const rest = curSb.entries.filter((en) => !order.includes(en.eid));
  curSb.entries = [...order.map((eid) => byEid.get(eid)), ...rest];
  await saveSongbook(curSb);
  renderSongbook();
}
box.addEventListener('pointerup', endDrag);
box.addEventListener('pointercancel', endDrag);

/* ---------- Stücke auswählen ---------- */
let pickSel = [];
function openPicker() {
  if (!scores.length) { toast('Importiere zuerst Noten in die Sammlung.'); return; }
  pickSel = [];
  $('pickSearch').value = '';
  renderPick();
  $('pickDlg').showModal();
}
function renderPick() {
  const q = norm($('pickSearch').value.trim());
  const inSb = new Set(curSb.entries.map((e) => e.scoreId));
  const list = $('pickList');
  const top = list.scrollTop;
  list.innerHTML = scores.filter((s) => matches(s, q)).map((s) => {
    const k = pickSel.indexOf(s.id);
    const sub = [s.composer, `${s.pages} S.`].filter(Boolean).map(esc).join(' · ');
    return `<div class="pick ${k >= 0 ? 'sel' : ''}" data-id="${s.id}">
      <span class="check">${k >= 0 ? k + 1 : ''}</span>
      <div class="main"><div class="title">${esc(s.title)}</div>
      <div class="sub">${sub}${inSb.has(s.id) ? ' · <b>schon im Songbook</b>' : ''}</div></div>
    </div>`;
  }).join('') || '<p class="muted">Nichts gefunden.</p>';
  list.scrollTop = top;
  $('pickCount').textContent = pickSel.length ? `${pickSel.length} ausgewählt` : 'Reihenfolge = Antipp-Reihenfolge';
  $('pickOk').disabled = !pickSel.length;
}
$('pickList').addEventListener('click', (e) => {
  const p = e.target.closest('.pick');
  if (!p) return;
  const k = pickSel.indexOf(p.dataset.id);
  if (k >= 0) pickSel.splice(k, 1); else pickSel.push(p.dataset.id);
  renderPick();
});
$('pickSearch').addEventListener('input', renderPick);
$('pickCancel').addEventListener('click', () => $('pickDlg').close());
$('pickOk').addEventListener('click', async () => {
  for (const id of pickSel) curSb.entries.push({ eid: uid(), scoreId: id });
  await saveSongbook(curSb);
  $('pickDlg').close();
  renderSongbook();
  toast(`${plural(pickSel.length, 'Stück', 'Stücke')} hinzugefügt`);
});

/* ---------- Songbook anlegen / umbenennen / duplizieren / löschen ---------- */
let sbEditing = null; // null = neu
function openSbDialog(sb) {
  sbEditing = sb;
  $('sbDlgTitle').textContent = sb ? 'Songbook' : 'Neues Songbook';
  $('sbFName').value = sb ? sb.name : '';
  $('sbFDelete').classList.toggle('hidden', !sb);
  $('sbFDup').classList.toggle('hidden', !sb);
  $('sbDlg').showModal();
  setTimeout(() => $('sbFName').focus(), 50);
}
$('sbFCancel').addEventListener('click', () => $('sbDlg').close());
$('sbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('sbFName').value.trim();
  if (!name) return;
  $('sbDlg').close();
  if (sbEditing) {
    sbEditing.name = name;
    await saveSongbook(sbEditing);
    sortSongbooks();
    renderSongbook();
  } else {
    const sb = { id: uid(), name, entries: [], created: Date.now(), updated: Date.now() };
    await DB.put('songbooks', sb);
    songbooks.push(sb);
    sortSongbooks();
    openSongbook(sb.id);
  }
});
$('sbFDup').addEventListener('click', async () => {
  const src = sbEditing;
  $('sbDlg').close();
  const copy = {
    id: uid(), name: src.name + ' (Kopie)', created: Date.now(), updated: Date.now(),
    entries: src.entries.map((en) => ({ eid: uid(), scoreId: en.scoreId, copiedFrom: en.eid })),
  };
  await DB.put('songbooks', copy);
  songbooks.push(copy);
  sortSongbooks();
  openSongbook(copy.id);
  toast('Songbook dupliziert');
});
$('sbFDelete').addEventListener('click', async () => {
  const sb = sbEditing;
  $('sbDlg').close();
  const ok = await confirmDlg('Songbook löschen?',
    `„${sb.name}“ und seine Notizen werden gelöscht. Die Noten bleiben in der Sammlung.`);
  if (!ok) return;
  await DB.del('songbooks', sb.id);
  await DB.delByIndex('annotations', 'songbookId', sb.id);
  songbooks = songbooks.filter((x) => x.id !== sb.id);
  curSb = null;
  setTab('songbooks');
  showView('library');
  toast('Songbook gelöscht');
});

/* =========================================================
   Bildschirm 3: Notenansicht
   Alle Seiten aller Stücke werden zu einer Folge „seq“ verkettet:
   seq[i] = { e: Eintrag-Nr., scoreId, page }
   step-Logik:
   - normal:  step = Index in seq
   - halb:    gerade step 2k  -> seq[k] komplett
              ungerade 2k+1   -> oben seq[k+1], unten noch seq[k]
   ========================================================= */
const V = {
  title: '', songbook: null, entries: [], seq: [], entryStart: [], n: 0, step: 0, half: false,
  docs: new Map(),  // scoreId -> { task, promise }
  cache: new Map(), // seq-Index -> Promise<Canvas>
  curEntry: -1, renderToken: 0, hideTimer: null,
};

function openViewer(scoreId) {
  const s = scoreById(scoreId);
  if (!s) return;
  startPlayback({ title: s.title, songbook: null, entries: [{ eid: 'single', scoreId }] }, 0);
}
function openSongbookPlayer(sb, startEntry) {
  const entries = sbItems(sb).map((x) => x.en);
  if (!entries.length) { toast('Das Songbook ist noch leer.'); return; }
  startPlayback({ title: sb.name, songbook: sb, entries }, startEntry);
}

function startPlayback(opts, startEntry) {
  closeDocs();
  V.title = opts.title;
  V.songbook = opts.songbook;
  V.entries = opts.entries;
  V.seq = [];
  V.entryStart = [];
  V.entries.forEach((en, e) => {
    const s = scoreById(en.scoreId);
    V.entryStart.push(V.seq.length);
    for (let p = 0; p < (s.pages || 1); p++) V.seq.push({ e, scoreId: s.id, page: p });
  });
  V.n = V.seq.length;
  V.half = localStorage.getItem('halfPage') === '1';
  V.curEntry = -1;
  $('btnHalf').classList.toggle('on', V.half);
  $('btnToc').classList.toggle('hidden', !V.songbook);
  $('btnBack').textContent = V.songbook ? '‹ Songbook' : '‹ Sammlung';
  showView('viewer');
  goToSeq(V.entryStart[startEntry] || 0);
  showChrome(true);
}

function goToSeq(i) {
  V.step = V.half ? 2 * i : i;
  V.step = Math.min(V.step, maxStep());
  draw();
}

function getDoc(scoreId) {
  if (V.docs.has(scoreId)) return V.docs.get(scoreId).promise;
  const d = { task: null };
  d.promise = (async () => {
    const file = await DB.get('files', scoreId);
    if (!file) throw new Error('Datei fehlt');
    d.task = pdfjsLib.getDocument({ data: new Uint8Array(file.data) });
    return d.task.promise;
  })();
  V.docs.set(scoreId, d);
  return d.promise;
}
function closeDocs() {
  V.cache.clear();
  for (const d of V.docs.values()) d.task?.destroy();
  V.docs.clear();
}
// Nur die PDFs rund um die aktuelle Seite offen halten (spart Speicher bei langen Songbooks)
function trimAround(i) {
  for (const k of V.cache.keys()) if (Math.abs(k - i) > 3) V.cache.delete(k);
  const keep = new Set();
  for (let k = Math.max(0, i - 3); k <= Math.min(V.n - 1, i + 3); k++) keep.add(V.seq[k].scoreId);
  for (const [id, d] of V.docs) if (!keep.has(id)) { d.task?.destroy(); V.docs.delete(id); }
}

function maxStep() { return V.half ? Math.max(0, 2 * V.n - 2) : V.n - 1; }

function stageSize() {
  const st = $('stage');
  return { w: st.clientWidth, h: st.clientHeight, dpr: Math.min(window.devicePixelRatio || 1, 3) };
}

// Seite als Canvas rendern, passend (contain) in die Bühne
function pageCanvas(i) {
  if (V.cache.has(i)) return V.cache.get(i);
  const it = V.seq[i];
  const p = (async () => {
    const doc = await getDoc(it.scoreId);
    const page = await doc.getPage(it.page + 1);
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
  p.catch(() => { if (V.cache.get(i) === p) V.cache.delete(i); });
  V.cache.set(i, p);
  return p;
}

async function draw() {
  if (!V.n) return;
  const token = ++V.renderToken;
  const { w, h, dpr } = stageSize();
  const canvas = $('canvas');
  const W = Math.floor(w * dpr), H = Math.floor(h * dpr);

  let top, bottom; // seq-Indizes
  if (!V.half) { top = bottom = V.step; }
  else if (V.step % 2 === 0) { top = bottom = V.step / 2; }
  else { bottom = (V.step - 1) / 2; top = bottom + 1; }

  onEntry(V.seq[top].e);

  let cTop, cBottom;
  try {
    [cTop, cBottom] = await Promise.all([pageCanvas(top), pageCanvas(bottom)]);
  } catch (err) {
    console.error(err);
    if (token === V.renderToken) toast('Seite konnte nicht angezeigt werden.');
    return;
  }
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
    ctx.save(); ctx.beginPath(); ctx.rect(0, mid, W, H - mid); ctx.clip();
    const pb = place(cBottom); ctx.drawImage(cBottom, pb.x, pb.y); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, mid); ctx.clip();
    const pt = place(cTop); ctx.drawImage(cTop, pt.x, pt.y); ctx.restore();
    ctx.fillStyle = '#D9A04A';
    ctx.fillRect(0, mid - Math.round(2 * dpr), W, Math.round(4 * dpr));
  }
  updatePageInfo(top, bottom);

  trimAround(top);
  if (top + 1 < V.n) pageCanvas(top + 1).catch(() => {});
  if (top + 2 < V.n) pageCanvas(top + 2).catch(() => {});
}

// Neues Stück im Songbook erreicht
function onEntry(e) {
  if (e === V.curEntry) return;
  V.curEntry = e;
  const s = scoreById(V.entries[e].scoreId);
  $('vtitle').textContent = V.songbook ? `${s.title}` : s.title;
  if (!Metro.running) Metro.loadFor(s);
  else Metro.score = s; // läuft weiter im aktuellen Tempo
}

function updatePageInfo(top, bottom) {
  const t = V.seq[top], b = V.seq[bottom];
  const sT = scoreById(t.scoreId), sB = scoreById(b.scoreId);
  const multi = !!V.songbook;
  const piece = multi ? `Stück ${t.e + 1}/${V.entries.length} · ` : '';
  let txt;
  if (top === bottom) txt = `${piece}Seite ${t.page + 1} von ${sT.pages}`;
  else if (t.e === b.e) txt = `${piece}oben S. ${t.page + 1} · unten S. ${b.page + 1} · von ${sT.pages}`;
  else txt = `oben: ${sT.title} S. ${t.page + 1} · unten: ${sB.title} S. ${b.page + 1}`;
  if (multi) txt = `${V.title} · ${txt}`;
  $('pageInfo').textContent = txt;
}

function go(delta) {
  if (!V.n) return;
  const next = Math.min(maxStep(), Math.max(0, V.step + delta));
  if (next === V.step) {
    if (delta > 0) toast(V.songbook ? 'Ende des Songbooks' : 'Letzte Seite', 1200);
    return;
  }
  V.step = next;
  draw();
}

function setHalf(on) {
  if (V.half === on) return;
  if (on) V.step = V.step * 2;
  else V.step = Math.ceil(V.step / 2);
  V.half = on;
  V.step = Math.min(V.step, maxStep());
  localStorage.setItem('halfPage', on ? '1' : '0');
  $('btnHalf').classList.toggle('on', on);
  toast(on ? 'Halbe Seiten blättern: an' : 'Halbe Seiten blättern: aus', 1500);
  draw();
}

/* ---------- Inhaltsverzeichnis im Songbook ---------- */
$('btnToc').addEventListener('click', () => {
  $('tocTitle').textContent = V.title;
  $('tocList').innerHTML = V.entries.map((en, i) => {
    const s = scoreById(en.scoreId);
    return `<div class="pick ${i === V.curEntry ? 'sel' : ''}" data-entry="${i}">
      <span class="check">${i + 1}</span>
      <div class="main"><div class="title">${esc(s.title)}</div>
      <div class="sub">${[s.composer, `${s.pages} S.`].filter(Boolean).map(esc).join(' · ')}</div></div>
    </div>`;
  }).join('');
  $('tocDlg').showModal();
});
$('tocList').addEventListener('click', (e) => {
  const p = e.target.closest('[data-entry]');
  if (!p) return;
  $('tocDlg').close();
  goToSeq(V.entryStart[Number(p.dataset.entry)]);
});

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
  setMetroView('closed');
  closeDocs();
  V.n = 0;
  if (V.songbook && songbooks.includes(V.songbook)) { curSb = V.songbook; renderSongbook(); showView('songbookView'); }
  else { renderLibrary(); showView('library'); }
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
  if (document.querySelector('dialog[open]')) return;
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
  resizeTimer = setTimeout(() => { if (V.n) { V.cache.clear(); draw(); } }, 150);
});

/* =========================================================
   Metronom (Web Audio, exaktes Timing mit Vorausplanung)
   ========================================================= */
const Metro = {
  ctx: null, bpm: 100, beats: 4, running: false, mini: false, nextTime: 0, beat: 0, timer: null,
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
    const score = this.score;
    this.saveTimer = setTimeout(() => {
      localStorage.setItem('lastBpm', this.bpm);
      if (score) {
        score.tempo = { bpm: this.bpm, beats: this.beats };
        DB.put('scores', score);
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
    $('beatDot').classList.toggle('hidden', this.mini);
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
    const html = Array.from({ length: n }, (_, i) =>
      `<i class="${i === active ? 'on' : ''} ${i === 0 && this.beats > 1 ? 'accent' : ''}"></i>`).join('');
    $('beatRow').innerHTML = html;
    $('miniBeats').innerHTML = html;
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

// Metronom-Fenster: offen / minimiert (nur Schlagpunkte) / zu
function setMetroView(state) { // 'open' | 'mini' | 'closed'
  Metro.mini = state === 'mini';
  $('metro').classList.toggle('hidden', state !== 'open');
  $('metroMini').classList.toggle('hidden', state !== 'mini');
  $('beatDot').classList.toggle('hidden', !(Metro.running && state !== 'mini'));
  $('btnMetro').classList.toggle('on', state !== 'closed' || Metro.running);
  if (state === 'open') showChrome(false); else showChrome(true);
}
$('btnMetro').addEventListener('click', () => setMetroView($('metro').classList.contains('hidden') ? 'open' : 'closed'));
$('metroClose').addEventListener('click', () => setMetroView('closed'));
$('metroMin').addEventListener('click', () => setMetroView('mini'));
$('metroMini').addEventListener('click', () => setMetroView('open'));
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
  scores = await DB.all('scores');
  songbooks = await DB.all('songbooks');
  sortScores();
  sortSongbooks();
  setTab(tab);
  updateStorageInfo();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker:', err));
  }
}
init();

// Für automatische Tests
window.__ns = {
  DB, V, Metro, importFiles, openViewer, openSongbookPlayer, go, setHalf,
  get scores() { return scores; }, get songbooks() { return songbooks; }, get curSb() { return curSb; },
};
