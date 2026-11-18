'use strict';
// Revision 4.3 - first-visit page (Start Bingo / Print a Card, no automatic player form),
//   Print a Card opens on the game's start day, "Uploading your submission…" spinner,
//   quiet review-status check so the phone reflects spreadsheet approval.
// Builds on Rev 4.2 (submit error note, storage reconnect fix, tap-to-remove/replace photo).
const API_URL = 'https://script.google.com/macros/s/AKfycbwTf3_KBWv-uMdS_cP5as62CDnZwR2KeSxB9xN58-CBog-Y0g_-oYastKuJOKHJLCD8/exec';
const TEST_KEY = new URLSearchParams(location.hash.slice(1)).get('test') || '';
const $ = id => document.getElementById(id), KEY = 'christmas-bingo-v2-token', LIST = 'christmas-bingo-players';
let db = null, dbPromise = null, ready = false, INFO = null, card = null, token = '', players = [], busy = false, selected = null, bgPromise = null, bgTimer = null, submitting = false;
const photos = new Map(), cardLocks = new Map();

function message(t, err = false) { $('message').textContent = t; $('message').className = err ? 'error' : ''; }

// ---------- Storage (reconnects automatically if the phone closes the database) ----------
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(TEST_KEY ? 'christmas-bingo-private-test' : 'christmas-bingo-v2', 2);
    r.onupgradeneeded = () => {
      for (const [n, k] of [['photos', 'key'], ['cards', 'token'], ['kv', 'key']])
        if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: k });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(Error('This browser cannot save your card. Use a regular browser.'));
    r.onblocked = () => rej(Error('Close other Bingo tabs and reopen.'));
  });
}
function getDB() {
  if (db) return Promise.resolve(db);
  if (!dbPromise) {
    dbPromise = openDB().then(d => {
      db = d;
      d.onclose = () => { if (db === d) db = null; };
      d.onversionchange = () => { try { d.close(); } catch (e) { } if (db === d) db = null; };
      return d;
    }).finally(() => { dbPromise = null; });
  }
  return dbPromise;
}
function isClosing(e) {
  const x = e && (e.cause || e);
  return !!x && (x.name === 'InvalidStateError' || /clos/i.test(String(x.message || '')));
}
async function withDB(fn) {
  for (let attempt = 0; ; attempt++) {
    const d = await getDB();
    try {
      return await fn(d);
    } catch (e) {
      if (attempt === 0 && isClosing(e)) {
        try { d.close(); } catch (_) { }
        if (db === d) db = null;
        continue;
      }
      throw e;
    }
  }
}
function read(store, key) {
  return withDB(d => new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
}
function all(store) {
  return withDB(d => new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
}
function writeRecords(records, deletes = []) {
  const stores = [...new Set([...records, ...deletes].map(r => r[0]))];
  return withDB(d => new Promise((res, rej) => {
    const tx = d.transaction(stores, 'readwrite');
    records.forEach(([s, v]) => tx.objectStore(s).put(v));
    deletes.forEach(([s, k]) => tx.objectStore(s).delete(k));
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => { const e = Error('Could not save on this device. Keep your original photos.'); e.cause = tx.error; rej(e); };
  }));
}

function cardLock(t, fn) {
  const prev = cardLocks.get(t) || Promise.resolve(), job = prev.catch(() => { }).then(fn);
  cardLocks.set(t, job);
  job.finally(() => { if (cardLocks.get(t) === job) cardLocks.delete(t); }).catch(() => { });
  return job;
}
async function mutateCard(t, fn) {
  return cardLock(t, async () => {
    const c = await read('cards', t);
    if (!c) return null;
    fn(c);
    await writeRecords([['cards', c]]);
    if (token === t) card = c;
    return c;
  });
}
async function saveCard() { await writeRecords([['cards', card]]); }
async function savePlayers() {
  await writeRecords([['kv', { key: 'players', value: players }], ['kv', { key: 'active', value: token }]]);
  if (!TEST_KEY)
    try { localStorage.setItem(LIST, JSON.stringify(players)); localStorage.setItem(KEY, token); } catch (e) { }
}
function legacy(k, f) {
  if (TEST_KEY) return f;
  try { return localStorage.getItem(k) || f; } catch (e) { return f; }
}

// ---------- Server ----------
async function rpc(action, ...args) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, args, ...(TEST_KEY ? { testKey: TEST_KEY } : {}) }), signal: controller.signal });
    let out;
    try { out = await res.json(); } catch (e) { throw Error('Unexpected server response. Check the deployment.'); }
    if (!out.ok) throw Error(out.error || 'Server error.');
    return out.data;
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) throw Error('Could not reach the game server. Your saved photos remain on this device.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Status ----------
function canPlay() { return !!INFO && INFO.state === 'open' && Date.now() >= INFO.startMs && Date.now() <= INFO.endMs && (!card || !card.eventId || card.eventId === INFO.eventId); }
// Rev 4.3: Print a Card opens at midnight (local time) on the day the game starts - not before.
function printOpensMs() { const d = new Date(INFO.startMs); d.setHours(0, 0, 0, 0); return d.getTime(); }
function canPrint() { return !!INFO && INFO.state !== 'paused' && INFO.state !== 'closed' && Date.now() >= printOpensMs() && Date.now() <= INFO.endMs; }
function isSubmitted(c = card) { return !!(c && (c.submitted || c.receipt)); }
function reviewText() {
  const r = card.reviewStatus || 'Pending review';
  if (r === 'Approved') return 'Your Bingo entry is approved for the drawing! Receipt: ' + card.receipt;
  if (r === 'Not approved') return 'Your entry needs attention. Please contact the organizer. Receipt: ' + card.receipt;
  if (r === 'Prize delivered') return 'Your prize is marked as delivered. Thank you for playing! Receipt: ' + card.receipt;
  return 'Entry received: ' + card.receipt + '. Awaiting organizer review.';
}
function statusText() {
  if (isSubmitted()) return reviewText();
  if (!INFO) return 'Open the game online once to prepare your card.';
  if (card && card.eventId !== INFO.eventId) return 'This card belongs to an earlier event. Start a new player card.';
  if (INFO.state === 'paused') return 'Christmas Bingo is paused. Please try again later.';
  if (Date.now() < INFO.startMs || INFO.state === 'upcoming') return 'Christmas Bingo opens ' + INFO.text.startDate + '.' + (canPrint() ? ' You can print a card today.' : ' See you then!');
  if (Date.now() > INFO.endMs || INFO.state === 'closed') return 'The entry deadline has passed. Thank you for playing!';
  if (!card) return 'Tap Start Bingo to play on this phone, or Print a Card to play on paper.';
  if (card.draft) return 'Submission started. Tap Submit Bingo to finish. Your photos remain on this device.';
  return 'Your progress saves automatically on this device.';
}
function applyInfo() {
  if ($('testBanner')) $('testBanner').hidden = !TEST_KEY;
  if (INFO)
    document.querySelectorAll('[data-i]').forEach(el => { if (INFO.text[el.dataset.i]) el.textContent = INFO.text[el.dataset.i]; });
}

// ---------- Bingo logic ----------
function lines() {
  const a = [];
  for (let n = 0; n < 5; n++) a.push(Array.from({ length: 5 }, (_, i) => n * 5 + i), Array.from({ length: 5 }, (_, i) => i * 5 + n));
  return a.concat([[0, 6, 12, 18, 24], [4, 8, 12, 16, 20]]);
}
function winning(order = card ? card.order : []) { const s = new Set(order); s.add(12); return lines().filter(l => l.every(i => s.has(i))); }
function firstCount(order) {
  for (let n = 1; n <= order.length; n++) if (winning(order.slice(0, n)).length) return n;
  return null;
}
function shortClue(c) { const s = c.replace(/^find (an? )?/i, ''); return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- Drawing ----------
function fitText() {
  document.querySelectorAll('.tile .clue').forEach(el => {
    el.style.fontSize = '';
    const tile = el.parentElement, max = tile.classList.contains('photo') ? tile.clientHeight * .45 : tile.clientHeight - 6;
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (size > 6.5 && (el.scrollWidth > el.clientWidth + .5 || el.scrollHeight > max)) { size -= .5; el.style.fontSize = size + 'px'; }
  });
}
// Rev 4.3: swap a button's label without losing the label written in index.html.
function setLabel(el, text) {
  if (!el) return;
  if (el.dataset.label === undefined) el.dataset.label = el.textContent;
  el.textContent = text || el.dataset.label;
}
function drawPlayers() {
  const sel = $('player');
  sel.replaceChildren();
  players.forEach(p => { const o = document.createElement('option'); o.value = p.token; o.textContent = p.label; o.selected = p.token === token; sel.append(o); });
  sel.disabled = busy || players.length < 2;
  sel.hidden = !players.length;
  // First visit: the New Player button becomes "Start Bingo".
  setLabel($('newPlayer'), players.length ? '' : 'Start Bingo');
  $('newPlayer').disabled = busy || !INFO || INFO.state !== 'open' || Date.now() < INFO.startMs || Date.now() > INFO.endMs;
  $('renamePlayer').hidden = !card;
  $('renamePlayer').disabled = busy || !card || isSubmitted();
}
function render() {
  const done = isSubmitted();
  if (done) card.submitted = true;
  if (card && card.submittedName) { const p = players.find(p => p.token === token); if (p) p.label = card.submittedName; }
  drawPlayers();
  $('save').hidden = !done;
  $('save').disabled = busy || !done;
  $('saveNote').hidden = !done;
  $('autosaveNote').hidden = done || !card;
  $('received').hidden = !done;
  // Rev 4.3: Print a Card shows on the first-visit page; enabled from the start day on.
  setLabel($('print'), card ? '' : 'Print a Card');
  $('print').hidden = done;
  $('print').disabled = busy || done || (!card && !canPrint());
  if ($('printNote')) $('printNote').hidden = done;
  $('refresh').hidden = !card;
  $('refresh').disabled = busy;
  $('claim').hidden = done || !card;
  $('claim').disabled = busy || !card || !winning().length || done || !canPlay();
  // Rev 4.3: no card yet = no empty grid at the bottom of the page.
  $('grid').hidden = !card;
  $('progress').hidden = !card;
  $('grid').replaceChildren();
  if (!card) { $('progress').textContent = ''; return; }
  const wins = new Set(winning().flat());
  card.clues.forEach((clue, i) => {
    const b = document.createElement('button'), p = card.order.includes(i) ? photos.get(i) : null;
    b.type = 'button';
    b.className = 'tile' + (i === 12 ? ' free' : '') + (p ? ' photo' : '') + (wins.has(i) ? ' win' : '');
    b.disabled = i === 12 || busy || done || card.draft || !canPlay();
    b.title = clue;
    b.setAttribute('aria-label', clue + (p ? ' (photo added - tap to replace or remove)' : ''));
    if (p) { const im = document.createElement('img'); im.src = p.data; im.alt = ''; b.append(im); }
    const t = document.createElement('span');
    t.className = 'clue';
    t.textContent = i === 12 ? 'FREE' : shortClue(clue);
    b.append(t);
    if (p) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '✓'; badge.title = 'Saved on this device'; b.append(badge); }
    b.onclick = () => { if (p) showPhotoMenu(i); else { selected = i; $('file').click(); } };
    $('grid').append(b);
  });
  $('progress').textContent = card.order.length + ' / 24 clues completed • Photos saved on this device' + (card.firstBingoCount ? ' • First Bingo after ' + card.firstBingoCount + ' clues' : '');
  fitText();
}
function resetForm() {
  if ($('entry').open) $('entry').close();
  $('entryForm').reset();
  $('entryError').textContent = '';
  $('uploadProgress').hidden = true;
}

// ---------- Players / cards ----------
async function activate(t) {
  const local = await read('cards', t);
  if (!local) throw Error('This card is not saved on this device.');
  token = t;
  card = local;
  photos.clear();
  for (const p of await all('photos')) if (p.token === t) photos.set(p.slot, p);
  if (card.submittedName) { const p = players.find(p => p.token === t); if (p) p.label = card.submittedName; }
  resetForm();
  await savePlayers();
  render();
  message(statusText());
}
async function acceptRemote(t, remote) {
  let allowed = new Set();
  await cardLock(t, async () => {
    let local = await read('cards', t);
    if (!local) {
      const old = (await all('photos')).filter(p => p.token === t), ids = [...new Set([...(remote.saved || []), ...old.map(p => p.slot)])];
      local = { token: t, clues: remote.clues, eventId: remote.eventId, order: remote.manifest ? remote.manifest.order.slice() : ids, historyReliable: ids.length === 0 && !remote.manifest, firstBingoCount: remote.manifest ? remote.manifest.firstBingoCount : null, prompted: false };
    }
    local.registered = true;
    local.receipt = remote.receipt || local.receipt || '';
    local.submitted = !!remote.submitted || !!local.receipt;
    local.reviewStatus = remote.reviewStatus || local.reviewStatus || 'Pending review';
    local.submittedName = remote.submittedName || local.submittedName || '';
    local.eventId = remote.eventId;
    local.clues = remote.clues;
    if (remote.manifest) {
      local.order = remote.manifest.order.slice();
      local.firstBingoCount = remote.manifest.firstBingoCount;
      local.historyReliable = remote.manifest.historyReliable;
      local.draft = !local.submitted;
    }
    allowed = new Set(local.order);
    await writeRecords([['cards', local]]);
  });
  if (!players.some(p => p.token === t)) players.push({ token: t, label: 'Player ' + (players.length + 1) });
  await activate(t);
  for (const i of remote.saved || []) {
    // Skip photos the player removed on this device (server copy is ignored).
    if (photos.has(i) || !allowed.has(i)) continue;
    try {
      const data = await rpc('getPhoto', t, i), p = { key: t + ':' + i, token: t, slot: i, data, requestId: remote.photoVersions?.[i] || crypto.randomUUID(), uploaded: true };
      await writeRecords([['photos', p]]);
      if (token === t) photos.set(i, p);
    } catch (e) {
      message('Some photo previews are unavailable. Keep the original playing device.', true);
    }
  }
  render();
}
async function refreshInfo() { const fresh = await rpc('info'); INFO = fresh; await writeRecords([['kv', { key: 'info', value: fresh }]]); applyInfo(); }
function randomBelow(n) {
  const max = Math.floor(4294967296 / n) * n;
  let v;
  do { v = crypto.getRandomValues(new Uint32Array(1))[0]; } while (v >= max);
  return v % n;
}
// Rev 4.3: shared shuffle for new player cards and printed paper cards.
function shuffledClues() {
  if (!INFO || !Array.isArray(INFO.clues) || INFO.clues.length !== 24) throw Error('Open the game online once to download clues.');
  const clues = INFO.clues.slice();
  for (let i = 23; i > 0; i--) { const j = randomBelow(i + 1); [clues[i], clues[j]] = [clues[j], clues[i]]; }
  clues.splice(12, 0, 'FREE');
  return clues;
}
function newPlayer() {
  if (busy) return;
  if (!INFO || INFO.state !== 'open' || Date.now() < INFO.startMs || Date.now() > INFO.endMs) { message(statusText(), true); return; }
  openPlayerDetails('new');
}
async function createLocalPlayer(details) {
  const clues = shuffledClues();
  const t = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const local = { token: t, clues, eventId: INFO.eventId, order: [], historyReliable: true, firstBingoCount: null, prompted: false, receipt: '', submitted: false, draft: false, registered: false, reviewStatus: 'Pending review', uploadConsent: true, uploadConsentAsked: true, details };
  await writeRecords([['cards', local]]);
  players.push({ token: t, label: details.name });
  await activate(t);
  message('Your card is ready. Progress saves automatically on this device.');
}
function renamePlayer() { if (!busy && card && !isSubmitted()) openPlayerDetails('edit'); }
function openEntry() {
  if (!card || isSubmitted() || !winning().length) return;
  if (!canPlay()) { message(statusText(), true); return; }
  if (!validDetails(card.details)) { openPlayerDetails('submit'); return; }
  $('entryError').textContent = '';
  $('entrySummary').textContent = 'Submitting for ' + card.details.name + '.';
  if (!$('entry').open) $('entry').showModal();
}

// ---------- Photos ----------
function loadImage(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(Error('Photo format not supported. Try a JPEG.')); im.src = src; }); }
async function compress(file) {
  if (file.size > 25000000) throw Error('Choose a photo under 25 MB.');
  const url = URL.createObjectURL(file);
  try {
    const im = await loadImage(url), s = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.width * s));
    c.height = Math.max(1, Math.round(im.height * s));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    for (const q of [.85, .75, .65, .5, .35]) { const d = c.toDataURL('image/jpeg', q); if (d.length <= 1300000) return d; }
    throw Error('Photo too large.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function attach(slot, file) {
  if (!card || isSubmitted() || card.draft || !canPlay()) throw Error('This card cannot be changed now.');
  const t = token, data = await compress(file);
  let show = false;
  await cardLock(t, async () => {
    const next = await read('cards', t);
    if (isSubmitted(next) || next.draft) throw Error('This card cannot be changed now.');
    if (!next.order.includes(slot)) next.order.push(slot);
    if (next.firstBingoCount === null && next.historyReliable && winning(next.order).length) next.firstBingoCount = next.order.length;
    show = !!winning(next.order).length && !next.prompted;
    if (show) next.prompted = true;
    const p = { key: t + ':' + slot, token: t, slot, data, requestId: crypto.randomUUID(), uploaded: false };
    await writeRecords([['photos', p], ['cards', next]]);
    if (token === t) { card = next; photos.set(slot, p); }
  });
  return show;
}
async function removePhoto(slot) {
  if (!card || isSubmitted() || card.draft || !canPlay()) throw Error('This card cannot be changed now.');
  const t = token;
  await cardLock(t, async () => {
    const next = await read('cards', t);
    if (!next || isSubmitted(next) || next.draft) throw Error('This card cannot be changed now.');
    next.order = next.order.filter(i => i !== slot);
    if (next.historyReliable) next.firstBingoCount = firstCount(next.order);
    if (!winning(next.order).length) next.prompted = false;
    await writeRecords([['cards', next]], [['photos', t + ':' + slot]]);
    if (token === t) { card = next; photos.delete(slot); }
  });
}
async function handlePhoto(e) {
  const f = e.target.files[0], slot = selected;
  e.target.value = '';
  if (!f || slot === null || busy) return;
  busy = true;
  render();
  let show = false;
  try {
    show = await attach(slot, f);
    message(show ? 'You have Bingo!' : 'Photo saved on this device.');
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
    render();
    if (show) openEntry();
    scheduleBackground();
  }
}

// ---------- Photo menu (Replace / Remove / Cancel) ----------
let menuSlot = null, menuConfirm = false;
function photoMenuEl() {
  let d = $('photoMenu');
  if (d) return d;
  const st = document.createElement('style');
  st.textContent = '#photoMenu{border:0;border-radius:14px;padding:18px;width:calc(100% - 40px);max-width:320px;background:#fffaf0;color:#0d3d29;text-align:center}' +
    '#photoMenu::backdrop{background:rgba(0,0,0,.55)}' +
    '#photoMenu img{display:block;max-width:100%;max-height:200px;margin:0 auto 10px;border-radius:8px}' +
    '#photoMenu p{margin:0 0 12px;font-weight:600}' +
    '#photoMenu .pm-btns{display:grid;gap:8px}' +
    '#photoMenu button{font:inherit;padding:11px;border-radius:10px;border:1px solid #0d3d29;background:#fff;color:#0d3d29}' +
    '#photoMenu button.pm-danger{background:#b3202a;border-color:#b3202a;color:#fff}' +
    '#photoMenu button[hidden]{display:none}';
  document.head.append(st);
  d = document.createElement('dialog');
  d.id = 'photoMenu';
  d.innerHTML = '<img alt=""><p class="pm-title"></p><div class="pm-btns">' +
    '<button type="button" data-a="replace">Replace photo</button>' +
    '<button type="button" class="pm-danger" data-a="remove">Remove photo</button>' +
    '<button type="button" data-a="cancel">Cancel</button></div>';
  document.body.append(d);
  d.addEventListener('click', e => { const b = e.target.closest('button'); if (b) photoMenuAction(b.dataset.a); });
  return d;
}
function drawPhotoMenu() {
  const d = $('photoMenu'), b = d.querySelectorAll('button');
  d.querySelector('.pm-title').textContent = menuConfirm ? 'Remove this photo? The square will be cleared.' : shortClue(card.clues[menuSlot]);
  b[0].hidden = menuConfirm;
  b[1].textContent = menuConfirm ? 'Yes, remove' : 'Remove photo';
  b[2].textContent = menuConfirm ? 'Keep photo' : 'Cancel';
}
function showPhotoMenu(i) {
  if (busy || !card || isSubmitted() || card.draft || !canPlay() || !photos.get(i)) return;
  const d = photoMenuEl();
  menuSlot = i;
  menuConfirm = false;
  d.querySelector('img').src = photos.get(i).data;
  drawPhotoMenu();
  if (!d.open) d.showModal();
}
async function photoMenuAction(a) {
  const d = $('photoMenu'), slot = menuSlot;
  if (a === 'cancel') { d.close(); return; }
  if (a === 'replace') { d.close(); selected = slot; $('file').click(); return; }
  if (!menuConfirm) { menuConfirm = true; drawPhotoMenu(); return; }
  d.close();
  if (busy) return;
  busy = true;
  render();
  try {
    await removePhoto(slot);
    message('Photo removed.');
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
    render();
  }
}

// ---------- Background uploads (one serial worker; never sets busy) ----------
function scheduleBackground(delay = 800) {
  clearTimeout(bgTimer);
  if (!ready || submitting) return;
  bgTimer = setTimeout(() => { bgTimer = null; runBackground(); }, delay);
}
async function markUploaded(p) {
  await cardLock(p.token, async () => {
    const latest = await read('photos', p.key);
    if (latest && latest.requestId === p.requestId) {
      latest.uploaded = true;
      await writeRecords([['photos', latest]]);
      if (token === p.token && photos.get(p.slot)?.requestId === p.requestId) photos.set(p.slot, latest);
    }
  });
}
async function runBackground() {
  if (bgPromise || submitting || !ready || navigator.onLine === false) return;
  bgPromise = (async () => {
    try {
      const eligible = (await all('cards')).filter(c => !isSubmitted(c) && !c.draft && c.uploadConsent);
      const queued = await all('photos');
      if (!eligible.some(c => queued.some(p => p.token === c.token && !p.uploaded))) return;
      await refreshInfo();
      if (INFO.photoMode !== 'All photos' || INFO.state !== 'open' || Date.now() > INFO.endMs) return;
      const cards = await all('cards');
      for (const snapshot of cards) {
        if (submitting) break;
        let c = await read('cards', snapshot.token);
        if (!c || isSubmitted(c) || c.draft || !c.uploadConsent || c.eventId !== INFO.eventId) continue;
        const pending = (await all('photos')).filter(p => p.token === c.token && !p.uploaded);
        if (!pending.length) continue;
        const remote = await rpc('registerCard', c.token, { clues: c.clues, eventId: c.eventId, uploadConsent: true });
        await mutateCard(c.token, local => { local.registered = true; });
        if (remote.submitted) continue;
        for (const old of pending) {
          if (submitting) break;
          c = await read('cards', c.token);
          if (!c || c.draft || isSubmitted(c)) break;
          const p = await read('photos', old.key);
          if (!p || p.uploaded) continue;
          await rpc('savePhoto', c.token, p.slot, p.data, p.requestId);
          await markUploaded(p);
        }
      }
    } catch (e) {
      /* Local originals remain queued. Foreground submission reports actionable errors. */
    } finally {
      bgPromise = null;
      if (!submitting) scheduleBackground(30000);
    }
  })();
  await bgPromise;
}

// ---------- Card picture (full photos fitted above clue labels) ----------
async function buildCardImage(opts = {}) {
  if (!card) throw Error('No card loaded.');
  const priv = !!opts.isPrivate, T = priv ? 360 : 240, G = 8, P = 30, H = priv ? 260 : 200, W = P * 2 + T * 5 + G * 4, HEIGHT = H + P + T * 5 + G * 4 + P, c = document.createElement('canvas');
  c.width = W;
  c.height = HEIGHT;
  const x = c.getContext('2d');
  x.fillStyle = '#0d3d29'; x.fillRect(0, 0, W, HEIGHT);
  x.fillStyle = '#b3202a'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#d9a634'; x.fillRect(0, H - 8, W, 8);
  x.textAlign = 'center';
  x.fillStyle = '#fff';
  x.font = 'bold ' + (priv ? 64 : 48) + 'px Georgia';
  x.fillText('Christmas Bingo', W / 2, 78);
  x.fillStyle = '#ffe7a8';
  x.font = 'italic bold ' + (priv ? 38 : 30) + 'px Georgia';
  x.fillText('Find Your Christmas Spirit.', W / 2, 128);
  x.fillStyle = '#fff';
  function fitLine(text, y, max) {
    let size = max;
    x.font = size + 'px system-ui';
    while (size > 12 && x.measureText(text).width > W - 60) { size--; x.font = size + 'px system-ui'; }
    x.fillText(text, W / 2, y);
  }
  if (priv) {
    fitLine(opts.name + ' • ' + new Date().toLocaleDateString(), 170, 32);
    fitLine([opts.phone, opts.email].filter(Boolean).join(' • '), 207, 28);
    fitLine(card.firstBingoCount ? 'Bingo after ' + card.firstBingoCount + ' clues • ' + card.order.length + ' completed' : 'Clues completed: ' + card.order.length, 240, 24);
  } else {
    fitLine('Community Christmas Bingo', 170, 24);
  }
  const win = new Set(winning().flat());
  function wrap(text, cx, y, width, size) {
    x.font = 'bold ' + size + 'px system-ui';
    const ls = [];
    let l = '';
    for (const w of text.split(' ')) {
      const test = l ? l + ' ' + w : w;
      if (x.measureText(test).width > width && l) { ls.push(l); l = w; } else l = test;
    }
    if (l) ls.push(l);
    ls.forEach((l, i) => x.fillText(l, cx, y + i * (size + 3)));
  }
  for (let i = 0; i < 25; i++) {
    const tx = P + (i % 5) * (T + G), ty = H + P + Math.floor(i / 5) * (T + G), p = photos.get(i), labelH = priv ? 85 : 68;
    x.fillStyle = i === 12 ? '#b3202a' : '#fffaf0';
    x.fillRect(tx, ty, T, T);
    if (i === 12) {
      x.fillStyle = '#fff';
      x.font = 'bold ' + (priv ? 64 : 44) + 'px Georgia';
      x.fillText('FREE', tx + T / 2, ty + T / 2 + 15);
    } else if (p && card.order.includes(i)) {
      const im = await loadImage(p.data), areaH = T - labelH, s = Math.min(T / im.width, areaH / im.height), w = im.width * s, h = im.height * s;
      x.fillStyle = '#0d3d29';
      x.fillRect(tx, ty, T, T);
      x.drawImage(im, tx + (T - w) / 2, ty + (areaH - h) / 2, w, h);
      x.fillStyle = '#fff';
      wrap(card.clues[i], tx + T / 2, ty + areaH + 24, T - 20, priv ? 23 : 18);
    } else {
      x.fillStyle = '#65756a';
      wrap(card.clues[i], tx + T / 2, ty + T / 2 - 20, T - 20, priv ? 23 : 18);
    }
    if (win.has(i)) { x.strokeStyle = '#d9a634'; x.lineWidth = 10; x.strokeRect(tx + 5, ty + 5, T - 10, T - 10); }
  }
  for (const q of [.9, .82, .72, .6, .45]) { const d = c.toDataURL('image/jpeg', q); if (d.length <= 5200000) return d; }
  throw Error('Card picture too large.');
}
async function saveMyCard() {
  if (busy || !isSubmitted()) return;
  busy = true;
  render();
  try {
    const data = await buildCardImage(), blob = await (await fetch(data)).blob(), file = new File([blob], 'christmas-bingo.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Christmas Bingo' });
    } else {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = file.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    message('Card picture ready. No name or contact information included.');
  } catch (e) {
    if (e.name !== 'AbortError') message(e.message, true);
  } finally {
    busy = false;
    render();
  }
}

// ---------- Printing ----------
// Rev 4.3: prints the player's card, or a freshly shuffled paper card on the first-visit page.
function preparePrint(clues) {
  const g = $('pgrid');
  g.replaceChildren();
  clues.forEach((clue, i) => {
    const d = document.createElement('div');
    if (i === 12) {
      d.className = 'pc pfree';
      d.innerHTML = '<small>✶</small>FREE<small>✶</small>';
    } else {
      d.className = 'pc';
      const c = document.createElement('div'); c.className = 'pclue'; c.textContent = clue;
      const w = document.createElement('div'); w.className = 'ploc'; w.textContent = 'Location:';
      const w2 = document.createElement('div'); w2.className = 'ploc2';
      const box = document.createElement('div'); box.append(w, w2);
      d.append(c, box);
    }
    g.append(d);
  });
  $('purl').textContent = location.origin + location.pathname;
}
function printCard() {
  if (busy || isSubmitted()) return;
  try {
    if (!card && !canPrint()) {
      message(INFO && INFO.text && INFO.text.startDate ? 'Print a Card opens ' + INFO.text.startDate + '.' : statusText(), true);
      return;
    }
    preparePrint(card ? card.clues : shuffledClues());
    window.print();
  } catch (e) {
    message(e.message, true);
  }
}

// ---------- Submission ----------
async function finishSubmission(remote, enteredName) {
  card.receipt = remote.receipt;
  card.submitted = true;
  card.draft = false;
  card.reviewStatus = remote.reviewStatus || 'Pending review';
  card.submittedName = remote.submittedName || enteredName || card.submittedName || '';
  const p = players.find(p => p.token === token);
  if (p && card.submittedName) p.label = card.submittedName;
  await saveCard();
  await savePlayers();
  resetForm();
  render();
  message(statusText());
}
async function submit(e) {
  e.preventDefault();
  if (busy || !card) return;
  const info = card.details;
  $('entryError').textContent = '';
  if (!validDetails(info)) { openPlayerDetails('submit'); return; }
  busy = true;
  submitting = true;
  clearTimeout(bgTimer);
  $('send').disabled = true;
  $('later').disabled = true;
  $('editFromEntry').disabled = true;
  setUploading(true);
  render();
  try {
    if (bgPromise) await bgPromise;
    await refreshInfo();
    if (!canPlay()) throw Error(statusText());
    card = await read('cards', token);
    const remote = await rpc('registerCard', token, { clues: card.clues, eventId: card.eventId, uploadConsent: card.uploadConsent === true });
    card.registered = true;
    await saveCard();
    if (remote.submitted) { await finishSubmission(await rpc('loadCard', token), info.name); return; }
    for (const i of card.order) if (!photos.has(i)) throw Error('Some photos are missing. Use the original playing device.');
    const versions = Object.fromEntries(card.order.map(i => [i, photos.get(i).requestId])),
      m = await rpc('prepareSubmission', token, { order: card.order, historyReliable: card.historyReliable, versions });
    if (m.receipt) { await finishSubmission(await rpc('loadCard', token), info.name); return; }
    if (JSON.stringify(m.order) !== JSON.stringify(card.order)) throw Error('Submission started with a different card state. Refresh Status and retry.');
    card.draft = true;
    await saveCard();
    for (const i of m.selected) {
      const p = photos.get(i), serverVersion = remote.photoVersions?.[i];
      if (!p.uploaded || serverVersion !== p.requestId) {
        await rpc('savePhoto', token, i, p.data, p.requestId);
        await markUploaded(p);
      }
    }
    const priv = await buildCardImage({ isPrivate: true, ...info }), pub = await buildCardImage(), r = await rpc('submitEntry', token, info, priv, pub);
    await finishSubmission(r, info.name);
  } catch (e) {
    $('entryError').textContent = 'Your entry has not been confirmed. Your photos are still saved on this device. Tap Submit Bingo to try again. If it still does not work, refresh this page and submit again. (' + e.message + ')';
  } finally {
    busy = false;
    submitting = false;
    $('send').disabled = false;
    $('later').disabled = false;
    $('editFromEntry').disabled = false;
    setUploading(false);
    render();
    scheduleBackground(30000);
  }
}
async function refreshStatus() {
  if (busy) return;
  busy = true;
  render();
  try {
    if (bgPromise) { submitting = true; await bgPromise; submitting = false; }
    await refreshInfo();
    if (card && card.registered !== false) await acceptRemote(token, await rpc('loadCard', token));
    message(statusText());
  } catch (e) {
    message(e.message, true);
  } finally {
    submitting = false;
    busy = false;
    render();
    scheduleBackground();
  }
}
// Rev 4.3: when a submitted player comes back to the page, quietly pick up the
// organizer's spreadsheet decision (Approved / Not approved / Prize delivered).
let lastStatusCheck = 0;
async function quietStatusCheck() {
  if (busy || submitting || !ready || !card || !isSubmitted() || card.registered === false || navigator.onLine === false) return;
  if (card.reviewStatus === 'Prize delivered' || Date.now() - lastStatusCheck < 60000) return;
  lastStatusCheck = Date.now();
  const t = token;
  try {
    const remote = await rpc('loadCard', t);
    if (busy || token !== t) return;
    await acceptRemote(t, remote);
    message(statusText());
  } catch (e) { /* Keep showing the last known status. */ }
}
function warnLeave(e) { e.preventDefault(); e.returnValue = ''; }
// Rev 4.3: simple "Uploading your submission…" with a rotating indicator - no photo counts.
function uploadProgressEl() {
  const el = $('uploadProgress');
  if (el.dataset.ready) return el;
  const st = document.createElement('style');
  st.textContent = '#uploadProgress:not([hidden]){display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 0;text-align:center}' +
    '#uploadProgress .up-row{display:flex;align-items:center;gap:10px;font-weight:700}' +
    '#uploadProgress .up-spin{width:22px;height:22px;flex:none;border:3px solid #d9a634;border-top-color:transparent;border-radius:50%;animation:up-spin .8s linear infinite}' +
    '#uploadProgress .up-note{font-size:.9em;opacity:.85}' +
    '@keyframes up-spin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){#uploadProgress .up-spin{animation-duration:2.4s}}';
  document.head.append(st);
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<div class="up-row"><span class="up-spin" aria-hidden="true"></span><span>Uploading your submission…</span></div>' +
    '<div class="up-note">Please keep this page open.</div>';
  el.dataset.ready = '1';
  return el;
}
function setUploading(on) {
  if (on) window.addEventListener('beforeunload', warnLeave);
  else window.removeEventListener('beforeunload', warnLeave);
  uploadProgressEl().hidden = !on;
  $('entryForm').setAttribute('aria-busy', String(on));
  $('send').textContent = on ? 'Submitting…' : 'Submit Bingo';
}
async function cacheShell() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offlineReady').textContent = 'Offline reopening is unavailable here. Use the published HTTPS page.';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await reg.update();
    await navigator.serviceWorker.ready;
    $('offlineReady').textContent = 'Page prepared for offline reopening. Keep this browser and device.';
  } catch (e) {
    $('offlineReady').textContent = 'Photos save locally, but offline reopening is not ready.';
  }
}

// ---------- Startup ----------
async function start() {
  busy = true;
  try {
    await getDB();
    ready = true;
    players = (await read('kv', 'players'))?.value || JSON.parse(legacy(LIST, '[]'));
    token = (await read('kv', 'active'))?.value || legacy(KEY, '');
    INFO = (await read('kv', 'info'))?.value || null;
    applyInfo();
    if (token && (await read('cards', token))) await activate(token);
    let online = false;
    try { await refreshInfo(); online = true; } catch (e) { if (!card) throw e; }
    if (online && token && (!card || card.registered !== false)) {
      try {
        await acceptRemote(token, await rpc('loadCard', token));
        lastStatusCheck = Date.now();
      } catch (e) {
        if (!/Card not found/.test(e.message)) throw e;
        message('This old card is no longer on the server. Create a new player card.', true);
      }
    }
    // Rev 4.3: no automatic player form. First visit shows the instructions with
    // Start Bingo and Print a Card; the player form opens only when Start Bingo is tapped.
    message(statusText());
    cacheShell();
    scheduleBackground();
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
    render();
  }
}

// ---------- Player details ----------
let detailsPurpose = 'new';
function validDetails(d) { return !!(d && d.consent === true && typeof d.name === 'string' && d.name.trim() && d.name.length <= 100 && typeof d.phone === 'string' && typeof d.email === 'string' && (d.phone || d.email) && (!d.phone || (/^\d{7,15}$/.test(d.phone.replace(/\D/g, '')))) && (!d.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))); }
function openPlayerDetails(purpose) {
  detailsPurpose = purpose;
  const f = $('playerForm');
  f.reset();
  $('playerError').textContent = '';
  const d = purpose === 'new' ? null : card?.details, cur = players.find(p => p.token === token);
  f.elements.name.value = d?.name || ((purpose !== 'new' && cur?.label && !/^Player \d+$/.test(cur.label)) ? cur.label : '');
  f.elements.phone.value = d?.phone || '';
  f.elements.email.value = d?.email || '';
  f.elements.consent.checked = d?.consent === true;
  $('playerTitle').textContent = purpose === 'new' ? 'Create a player' : 'Player details';
  $('playerSave').textContent = purpose === 'new' ? 'Start Playing' : purpose === 'submit' ? 'Continue to Submit' : 'Save Details';
  if ($('entry').open) $('entry').close();
  if (!$('playerDetails').open) $('playerDetails').showModal();
}
async function savePlayerDetails(e) {
  e.preventDefault();
  if (busy) return;
  const f = $('playerForm'), details = { name: f.elements.name.value.trim(), phone: f.elements.phone.value.trim(), email: f.elements.email.value.trim(), consent: f.elements.consent.checked, consentVersion: 'organizer-review-background-v1', consentedAt: new Date().toISOString() };
  if (details.phone.length > 40 || details.email.length > 254 || /[\x00-\x1f]/.test(details.name + details.phone + details.email) || !validDetails(details)) {
    $('playerError').textContent = 'Enter a name, a valid phone number or email, and check the agreement.';
    return;
  }
  busy = true;
  $('playerSave').disabled = true;
  $('playerCancel').disabled = true;
  render();
  let success = false;
  try {
    if (detailsPurpose === 'new') {
      await createLocalPlayer(details);
    } else {
      const t = token;
      await mutateCard(t, c => { c.details = details; c.uploadConsent = true; c.uploadConsentAsked = true; });
      const player = players.find(p => p.token === t);
      if (player) player.label = details.name;
      await savePlayers();
    }
    $('playerDetails').close();
    success = true;
  } catch (err) {
    $('playerError').textContent = err.message;
  } finally {
    busy = false;
    $('playerSave').disabled = false;
    $('playerCancel').disabled = false;
    render();
  }
  if (success) {
    scheduleBackground();
    if (detailsPurpose === 'submit') openEntry();
  }
}

// ---------- Wiring ----------
$('file').onchange = handlePhoto;
$('claim').onclick = openEntry;
$('later').onclick = () => { if (!busy) $('entry').close(); };
$('entry').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
$('entryForm').onsubmit = submit;
$('playerForm').onsubmit = savePlayerDetails;
$('playerCancel').onclick = () => { if (!busy) $('playerDetails').close(); };
$('playerDetails').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
$('editFromEntry').onclick = () => { if (!busy) openPlayerDetails('submit'); };
$('save').onclick = saveMyCard;
$('print').onclick = printCard;
$('refresh').onclick = refreshStatus;
$('newPlayer').onclick = newPlayer;
$('renamePlayer').onclick = renamePlayer;
$('player').onchange = async (e) => {
  if (busy) return;
  try { await activate(e.target.value); } catch (err) { message(err.message, true); }
};
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitText, 120); });
window.addEventListener('online', () => { scheduleBackground(); quietStatusCheck(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { scheduleBackground(); quietStatusCheck(); }
});
// Rev 4.3: if the first-visit page is left open, Start Bingo / Print a Card unlock on time.
setInterval(() => { if (!busy && !card) { render(); message(statusText()); } }, 60000);
start();
// END OF app.js
