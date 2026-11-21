// Notensammlung – Schritt 2: Sammlung, Songbooks, Anzeige, Halbseiten-Blättern, Fußpedal, Metronom
import * as pdfjsLib from './lib/pdf.min.mjs';

const APP_VERSION = '0.3.0';
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
  byIndex(store, index, value) { return this.run(store, 'readonly', (s) => s.index(index).getAll(IDBKeyRange.only(value))); },
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
function confirmDlg(title, text, yes = 'Löschen', no = 'Abbrechen', yesClass = 'danger') {
  return new Promise((resolve) => {
    const d = $('confirmDlg');
    $('cTitle').textContent = title;
    $('cText').textContent = text;
    $('cYes').textContent = yes;
    $('cYes').className = 'btn ' + yesClass;
    $('cNo').textContent = no;
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
async function deleteEntryNotes(sbId, eids) {
  if (!eids.length) return;
  const rows = await DB.byIndex('annotations', 'songbookId', sbId);
  for (const r of rows) if (eids.includes(r.eid)) await DB.del('annotations', r.key);
}

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
    const gone = sb.entries.filter((e) => e.scoreId === s.id).map((e) => e.eid);
    sb.entries = sb.entries.filter((e) => e.scoreId !== s.id);
    await saveSongbook(sb);
    await deleteEntryNotes(sb.id, gone);
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
    const eid = curSb.entries[idx].eid;
    const notes = (await DB.byIndex('annotations', 'songbookId', curSb.id)).filter((a) => a.eid === eid);
    if (notes.length && !(await confirmDlg('Stück entfernen?',
      `„${title}“ hat in diesem Songbook Notizen. Sie werden mit entfernt.`, 'Entfernen'))) return;
    curSb.entries.splice(idx, 1);
    await saveSongbook(curSb);
    await deleteEntryNotes(curSb.id, [eid]);
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
  const notes = await DB.byIndex('annotations', 'songbookId', src.id);
  let withNotes = false;
  if (notes.length) {
    withNotes = await confirmDlg('Notizen mitkopieren?',
      `„${src.name}“ enthält Notizen. Sollen sie in die Kopie übernommen werden? Danach sind beide unabhängig voneinander.`,
      'Mit Notizen', 'Ohne Notizen', 'primary');
  }
  if (withNotes) {
    const map = new Map(copy.entries.map((en) => [en.copiedFrom, en.eid]));
    for (const a of notes) {
      const eid = map.get(a.eid);
      if (!eid) continue;
      await DB.put('annotations', { key: `${copy.id}|${eid}|${a.page}`, songbookId: copy.id, eid, page: a.page, strokes: a.strokes });
    }
  }
  songbooks.push(copy);
  sortSongbooks();
  openSongbook(copy.id);
  toast(withNotes ? 'Songbook mit Notizen dupliziert' : 'Songbook dupliziert');
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

async function startPlayback(opts, startEntry) {
  closeDocs();
  await loadAnnotations(opts.songbook);
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
  $('btnInk').classList.toggle('hidden', !V.songbook);
  setInkMode(false);
  $('ink').getContext('2d').clearRect(0, 0, $('ink').width, $('ink').height);
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

  const place = (c) => ({ x: Math.round((W - c.width) / 2), y: Math.round((H - c.height) / 2), w: c.width, h: c.height });
  const parts = [];
  if (top === bottom) {
    const p = place(cTop);
    ctx.drawImage(cTop, p.x, p.y);
    parts.push({ seq: top, rect: p, clip: [0, H] });
  } else {
    const mid = Math.round(H / 2);
    ctx.save(); ctx.beginPath(); ctx.rect(0, mid, W, H - mid); ctx.clip();
    const pb = place(cBottom); ctx.drawImage(cBottom, pb.x, pb.y); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, mid); ctx.clip();
    const pt = place(cTop); ctx.drawImage(cTop, pt.x, pt.y); ctx.restore();
    ctx.fillStyle = '#D9A04A';
    ctx.fillRect(0, mid - Math.round(2 * dpr), W, Math.round(4 * dpr));
    parts.push({ seq: top, rect: pt, clip: [0, mid] }, { seq: bottom, rect: pb, clip: [mid, H] });
  }
  V.dpr = dpr;
  V.parts = V.songbook ? parts.map((p) => ({ ...p, key: annKey(p.seq) })) : [];
  renderInkBase();
  renderInk();
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
  $('vtitle').textContent = s.title;
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
  if (Ink.cur) commitStroke();
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
  if (Ink.cur) commitStroke();
  setInkMode(false);
  closeDocs();
  V.n = 0;
  if (V.songbook && songbooks.includes(V.songbook)) { curSb = V.songbook; renderSongbook(); showView('songbookView'); }
  else { renderLibrary(); showView('library'); }
});
$('btnHalf').addEventListener('click', () => setHalf(!V.half));

/* =========================================================
   Schritt 3: Pencil-Notizen – nur in Songbooks
   Eine Notiz-Ebene je Songbook-Eintrag und Seite:
   key = songbookId|eid|seite  →  { key, songbookId, eid, page, strokes }
   Koordinaten relativ zur Seite (0…1), damit sie bei jeder
   Bildschirmgröße und beim Drehen genau sitzen.
   Das Original-PDF wird nie verändert.
   ========================================================= */
const INK_COLORS = ['#C62828', '#1565C0', '#1F1D2B', '#2E7D32', '#F2B705'];
const INK_SIZES = { pen: [0.0016, 0.0028, 0.0048], marker: [0.012, 0.02, 0.03], text: [0.022, 0.03, 0.042] };
const Ink = {
  mode: false,                       // Notiz-Modus (Werkzeugleiste offen)
  tool: localStorage.getItem('inkTool') || 'pen',
  color: localStorage.getItem('inkColor') || INK_COLORS[0],
  markerColor: localStorage.getItem('inkMarkerColor') || INK_COLORS[4],
  size: Number(localStorage.getItem('inkSize') || 1),
  visible: localStorage.getItem('inkVisible') !== '0',
  ann: new Map(),                    // key -> strokes[]
  undo: [], redo: [],
  cur: null,                         // aktueller Strich
  erase: null,                       // { prev: Map(key -> strokes) }
  penActive: false,
  base: null,                        // Zwischenspeicher der fertigen Striche
};
V.parts = [];

const annKey = (seqIdx) => {
  const it = V.seq[seqIdx];
  return `${V.songbook.id}|${V.entries[it.e].eid}|${it.page}`;
};
const strokesOf = (key) => Ink.ann.get(key) || [];

async function loadAnnotations(sb) {
  Ink.ann.clear();
  Ink.undo = []; Ink.redo = [];
  if (!sb) return;
  const rows = await DB.byIndex('annotations', 'songbookId', sb.id);
  for (const r of rows) Ink.ann.set(r.key, r.strokes || []);
}
async function saveAnn(key) {
  const strokes = strokesOf(key);
  if (!strokes.length) { Ink.ann.delete(key); await DB.del('annotations', key); return; }
  const [songbookId, eid, page] = key.split('|');
  await DB.put('annotations', { key, songbookId, eid, page: Number(page), strokes });
}
function pushUndo(key, prev) {
  Ink.undo.push({ key, strokes: prev });
  if (Ink.undo.length > 100) Ink.undo.shift();
  Ink.redo = [];
  updateInkBar();
}
async function undoRedo(from, to) {
  const a = from.pop();
  if (!a) return;
  to.push({ key: a.key, strokes: strokesOf(a.key).slice() });
  Ink.ann.set(a.key, a.strokes);
  await saveAnn(a.key);
  // zur betroffenen Seite springen, falls sie nicht sichtbar ist
  if (!V.parts.some((p) => p.key === a.key)) {
    const i = V.seq.findIndex((_, k) => annKey(k) === a.key);
    if (i >= 0) { goToSeq(i); updateInkBar(); return; }
  }
  renderInkBase(); renderInk(); updateInkBar();
}

/* ---------- Zeichnen ---------- */
function drawStroke(ctx, st, r) {
  const X = (x) => r.x + x * r.w, Y = (y) => r.y + y * r.h;
  ctx.save();
  if (st.tool === 'text') {
    ctx.fillStyle = st.color;
    ctx.font = `600 ${Math.max(8, st.size * r.w)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(st.text, X(st.x), Y(st.y));
    ctx.restore();
    return;
  }
  const pts = st.pts;
  const base = st.w * r.w;
  ctx.strokeStyle = st.color;
  ctx.fillStyle = st.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (st.tool === 'marker') {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = base;
    ctx.beginPath();
    ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
    if (pts.length === 1) ctx.lineTo(X(pts[0][0]) + 0.1, Y(pts[0][1]));
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(X(pts[i][0]), Y(pts[i][1]), X(mx), Y(my));
    }
    if (pts.length > 1) ctx.lineTo(X(pts[pts.length - 1][0]), Y(pts[pts.length - 1][1]));
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Stift: Strichstärke folgt dem Andruck
  const wAt = (p) => base * (0.55 + 0.9 * (p[2] ?? 0.5));
  if (pts.length === 1) {
    ctx.beginPath(); ctx.arc(X(pts[0][0]), Y(pts[0][1]), wAt(pts[0]) / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  let px = X(pts[0][0]), py = Y(pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const nx = i < pts.length - 1 ? (X(p[0]) + X(pts[i + 1][0])) / 2 : X(p[0]);
    const ny = i < pts.length - 1 ? (Y(p[1]) + Y(pts[i + 1][1])) / 2 : Y(p[1]);
    ctx.lineWidth = wAt(p);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(X(p[0]), Y(p[1]), nx, ny);
    ctx.stroke();
    px = nx; py = ny;
  }
  ctx.restore();
}

function inkCanvas() {
  const c = $('ink'), m = $('canvas');
  if (c.width !== m.width || c.height !== m.height) {
    c.width = m.width; c.height = m.height;
    c.style.width = m.style.width; c.style.height = m.style.height;
  }
  return c;
}
// fertige Striche der sichtbaren Seiten in einen Zwischenspeicher zeichnen
function renderInkBase() {
  const c = inkCanvas();
  if (!Ink.base) Ink.base = document.createElement('canvas');
  const b = Ink.base;
  b.width = c.width; b.height = c.height;
  const ctx = b.getContext('2d');
  ctx.clearRect(0, 0, b.width, b.height);
  if (!Ink.visible || !V.songbook) return;
  for (const part of V.parts) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, part.clip[0], b.width, part.clip[1] - part.clip[0]); ctx.clip();
    for (const st of strokesOf(part.key)) drawStroke(ctx, st, part.rect);
    ctx.restore();
  }
}
function renderInk() {
  const c = inkCanvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (Ink.base) ctx.drawImage(Ink.base, 0, 0);
  if (Ink.cur) {
    const part = Ink.cur.part;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, part.clip[0], c.width, part.clip[1] - part.clip[0]); ctx.clip();
    drawStroke(ctx, Ink.cur.st, part.rect);
    ctx.restore();
  }
}

/* ---------- Eingabe ---------- */
function partAt(e) {
  const dpr = V.dpr || 1;
  const x = e.clientX * dpr, y = e.clientY * dpr;
  for (const part of V.parts) {
    if (y >= part.clip[0] && y < part.clip[1] && x >= part.rect.x && x <= part.rect.x + part.rect.w) {
      return { part, nx: (x - part.rect.x) / part.rect.w, ny: (y - part.rect.y) / part.rect.h };
    }
  }
  return null;
}
function normIn(part, e) {
  const dpr = V.dpr || 1;
  return [(e.clientX * dpr - part.rect.x) / part.rect.w, (e.clientY * dpr - part.rect.y) / part.rect.h];
}
const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

function inkDown(e) {
  const hit = partAt(e);
  if (!hit) return false;
  if (!Ink.visible) { Ink.visible = true; localStorage.setItem('inkVisible', '1'); renderInkBase(); updateInkBar(); }
  // Ohne Werkzeugleiste schreibt der Pencil immer mit dem Stift
  const tool = Ink.mode ? Ink.tool : 'pen';
  if (tool === 'text') { askText(hit); return true; }
  if (tool === 'eraser') {
    Ink.erase = { prev: new Map(), id: e.pointerId };
    eraseAt(e);
    return true;
  }
  const marker = tool === 'marker';
  const st = {
    tool, color: marker ? Ink.markerColor : Ink.color,
    w: INK_SIZES[marker ? 'marker' : 'pen'][Ink.size],
    pts: [[hit.nx, hit.ny, pressureOf(e)]],
  };
  Ink.cur = { st, part: hit.part, id: e.pointerId };
  renderInk();
  return true;
}
function inkMove(e) {
  if (Ink.erase && e.pointerId === Ink.erase.id) { eraseAt(e); return; }
  if (!Ink.cur || e.pointerId !== Ink.cur.id) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) {
    const [x, y] = normIn(Ink.cur.part, ev);
    const last = Ink.cur.st.pts[Ink.cur.st.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 0.0008) continue;
    Ink.cur.st.pts.push([+x.toFixed(5), +y.toFixed(5), +pressureOf(ev).toFixed(2)]);
  }
  renderInk();
}
async function inkUp(e) {
  if (Ink.erase && e.pointerId === Ink.erase.id) {
    const { prev } = Ink.erase;
    Ink.erase = null;
    for (const [key, strokes] of prev) { pushUndo(key, strokes); await saveAnn(key); }
    return;
  }
  if (!Ink.cur || e.pointerId !== Ink.cur.id) return;
  await commitStroke();
}
async function commitStroke() {
  if (!Ink.cur) return;
  const { st, part } = Ink.cur;
  Ink.cur = null;
  const prev = strokesOf(part.key).slice();
  Ink.ann.set(part.key, [...prev, st]);
  pushUndo(part.key, prev);
  renderInkBase(); renderInk();
  await saveAnn(part.key);
}

// Radierer: entfernt ganze Striche, die berührt werden
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function eraseAt(e) {
  const hit = partAt(e);
  if (!hit) return;
  const key = hit.part.key;
  const strokes = strokesOf(key);
  const R = 0.012;
  const keep = strokes.filter((st) => {
    if (st.tool === 'text') {
      const wApprox = st.size * 0.55 * st.text.length;
      return !(hit.nx >= st.x - R && hit.nx <= st.x + wApprox + R && Math.abs(hit.ny - st.y) < st.size * 0.6 + R);
    }
    const r = R + st.w / 2;
    const p = st.pts;
    if (p.length === 1) return Math.hypot(hit.nx - p[0][0], hit.ny - p[0][1]) > r;
    for (let i = 1; i < p.length; i++) if (segDist(hit.nx, hit.ny, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < r) return false;
    return true;
  });
  if (keep.length === strokes.length) return;
  if (!Ink.erase.prev.has(key)) Ink.erase.prev.set(key, strokes.slice());
  Ink.ann.set(key, keep);
  renderInkBase(); renderInk();
}

// Text: an der angetippten Stelle einfügen
let textTarget = null;
function askText(hit) {
  textTarget = hit;
  $('textInput').value = '';
  $('textDlg').showModal();
  setTimeout(() => $('textInput').focus(), 50);
}
$('textCancel').addEventListener('click', () => $('textDlg').close());
$('textForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('textInput').value.trim();
  $('textDlg').close();
  if (!text || !textTarget) return;
  const { part, nx, ny } = textTarget;
  const prev = strokesOf(part.key).slice();
  Ink.ann.set(part.key, [...prev, { tool: 'text', text, x: nx, y: ny, color: Ink.color, size: INK_SIZES.text[Ink.size] }]);
  pushUndo(part.key, prev);
  renderInkBase(); renderInk();
  await saveAnn(part.key);
});

/* ---------- Werkzeugleiste ---------- */
function setInkMode(on) {
  if (on && !V.songbook) return;
  Ink.mode = on;
  $('inkbar').classList.toggle('hidden', !on);
  $('btnInk').classList.toggle('on', on);
  $('viewer').classList.toggle('inking', on);
  if (on && !Ink.visible) { Ink.visible = true; localStorage.setItem('inkVisible', '1'); renderInkBase(); renderInk(); }
  updateInkBar();
  showChrome(true);
}
function updateInkBar() {
  document.querySelectorAll('#inkbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === Ink.tool));
  const activeColor = Ink.tool === 'marker' ? Ink.markerColor : Ink.color;
  document.querySelectorAll('#inkbar [data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === activeColor));
  document.querySelectorAll('#inkbar [data-size]').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === Ink.size));
  $('inkUndo').disabled = !Ink.undo.length;
  $('inkRedo').disabled = !Ink.redo.length;
  $('inkEye').classList.toggle('on', Ink.visible);
  $('inkEye').textContent = Ink.visible ? '👁 an' : '👁 aus';
}
function buildInkBar() {
  $('inkColors').innerHTML = INK_COLORS.map((c) => `<button data-color="${c}" style="--c:${c}" aria-label="Farbe"></button>`).join('');
  $('inkbar').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tool) { Ink.tool = t.dataset.tool; localStorage.setItem('inkTool', Ink.tool); }
    else if (t.dataset.color) {
      if (Ink.tool === 'marker') { Ink.markerColor = t.dataset.color; localStorage.setItem('inkMarkerColor', Ink.markerColor); }
      else { Ink.color = t.dataset.color; localStorage.setItem('inkColor', Ink.color); if (Ink.tool === 'eraser') Ink.tool = 'pen'; }
    } else if (t.dataset.size) { Ink.size = Number(t.dataset.size); localStorage.setItem('inkSize', Ink.size); }
    else if (t.id === 'inkUndo') { undoRedo(Ink.undo, Ink.redo); return; }
    else if (t.id === 'inkRedo') { undoRedo(Ink.redo, Ink.undo); return; }
    else if (t.id === 'inkEye') {
      Ink.visible = !Ink.visible; localStorage.setItem('inkVisible', Ink.visible ? '1' : '0');
      renderInkBase(); renderInk();
    } else if (t.id === 'inkClear') { clearVisible(); return; }
    else if (t.id === 'inkPrev') { go(-1); return; }
    else if (t.id === 'inkNext') { go(1); return; }
    else if (t.id === 'inkDone') { setInkMode(false); return; }
    updateInkBar();
  });
}
async function clearVisible() {
  let any = false;
  for (const part of V.parts) {
    const prev = strokesOf(part.key);
    if (!prev.length) continue;
    any = true;
    Ink.ann.set(part.key, []);
    pushUndo(part.key, prev.slice());
    await saveAnn(part.key);
  }
  if (!any) { toast('Auf dieser Seite gibt es keine Notizen.', 1500); return; }
  renderInkBase(); renderInk();
  toast('Notizen der Seite gelöscht – mit ↶ rückgängig', 2500);
}
$('btnInk').addEventListener('click', () => setInkMode(!Ink.mode));
buildInkBar();

let penHintShown = 0;

/* ---------- Touch: tippen links/rechts, wischen – Pencil schreibt ---------- */
let ptr = null;
const stage = $('stage');
stage.addEventListener('pointerdown', (e) => {
  const isPen = e.pointerType === 'pen';
  if (isPen) Ink.penActive = true;
  // Pencil schreibt immer (im Songbook); im Notiz-Modus auch Finger und Maus
  if (V.songbook && (isPen || Ink.mode)) {
    if (!isPen && Ink.penActive) return; // Handballen ignorieren, solange der Pencil schreibt
    if (inkDown(e)) { try { stage.setPointerCapture(e.pointerId); } catch { /* egal */ } e.preventDefault(); }
    return;
  }
  if (isPen) {
    if (Date.now() - penHintShown > 8000) { toast('Notizen schreibst du in einem Songbook – das Original bleibt sauber.', 3000); penHintShown = Date.now(); }
    return;
  }
  ptr = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
});
stage.addEventListener('pointermove', (e) => { if (Ink.cur || Ink.erase) inkMove(e); });
stage.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'pen') Ink.penActive = false;
  if (Ink.cur || Ink.erase) { inkUp(e); return; }
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  const dt = performance.now() - ptr.t;
  ptr = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
    go(dx < 0 ? 1 : -1);
    return;
  }
  if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
    const w = stage.clientWidth;
    if (e.clientX < w / 3) go(-1);
    else if (e.clientX > (2 * w) / 3) go(1);
    else toggleChrome();
  }
});
stage.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'pen') Ink.penActive = false;
  if (Ink.cur || Ink.erase) inkUp(e);
  ptr = null;
});

/* ---------- Tastatur / Bluetooth-Fußpedal ---------- */
document.addEventListener('keydown', (e) => {
  if (!$('viewer').classList.contains('active')) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && V.songbook) {
    e.preventDefault();
    if (e.shiftKey) undoRedo(Ink.redo, Ink.undo); else undoRedo(Ink.undo, Ink.redo);
    return;
  }
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
  DB, V, Ink, Metro, importFiles, openViewer, openSongbookPlayer, go, setHalf,
  get scores() { return scores; }, get songbooks() { return songbooks; }, get curSb() { return curSb; },
};
