/* ═══════════════════════════════════════════════════
   LANG-APP  |  engine.js
   Language-agnostic game engine
   Supports: rapid, typeit, wordorder, fillblank,
             freewrite (transform/repair), match
═══════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────

const MIN_QUESTIONS = 8;   // min items needed to show a cabinet
const SAVE_KEY      = 'lang-app-save';
const TIMER_SECS    = 12;
const STREAK_MAX    = 6;
const DIFF_SETTINGS = {
  1: { label:'EASY',   lives:5, timer:15, distractors:3, fuzzyPct:0.30 },
  2: { label:'MEDIUM', lives:4, timer:12, distractors:4, fuzzyPct:0.22 },
  3: { label:'HARD',   lives:3, timer: 9, distractors:5, fuzzyPct:0.18 },
  4: { label:'BRUTAL', lives:2, timer: 6, distractors:6, fuzzyPct:0.12 }
};

// ─────────────────────────────────────────────────
//  APPLICATION STATE
// ─────────────────────────────────────────────────

const App = {
  // loaded data
  modules:   {},     // id → module manifest
  units:     {},     // id → unit data
  // current session
  moduleId:  null,
  activeUnits: [],   // unit ids selected
  activeCats:  [],   // category keys selected
  immersion: false,
  // game session
  mode:      null,
  difficulty: 2,
  queueSize:  10,
  queue:     [],
  qi:        0,
  score:     0,
  lives:     3,
  streak:    0,
  correct:   0,
  wrong:     0,
  // word-order state
  woZone:    [],
  woPool:    [],
  woCorrect: 0,
  // match state
  matchSel:  null,
  matchPairs:[],
  matchDone: 0,
  // save data (per-item progress)
  save: {
    items: {},    // itemId → { seen, correct, lastMs }
    scores: {}    // "moduleId:mode" → best score
  }
};

// ─────────────────────────────────────────────────
//  SAVE / LOAD
// ─────────────────────────────────────────────────

function saveToStorage() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(App.save)); }
  catch(e) { console.warn('Save failed', e); }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) App.save = JSON.parse(raw);
  } catch(e) { console.warn('Load failed', e); }
}

function recordItem(id, wasCorrect) {
  if (!id) return;
  if (!App.save.items[id]) App.save.items[id] = { seen:0, correct:0, lastMs:0 };
  App.save.items[id].seen++;
  if (wasCorrect) App.save.items[id].correct++;
  App.save.items[id].lastMs = Date.now();
  saveToStorage();
}

function recordScore(moduleId, mode, score) {
  const key = `${moduleId}:${mode}`;
  if (!App.save.scores[key] || score > App.save.scores[key]) {
    App.save.scores[key] = score;
    saveToStorage();
  }
}

function getBestScore(moduleId, mode) {
  return App.save.scores[`${moduleId}:${mode}`] || 0;
}

function exportSave() {
  const blob = new Blob([JSON.stringify(App.save, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lang-app-save.json';
  a.click();
  toast('Progress exported ✓');
}

function importSave(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      App.save = JSON.parse(e.target.result);
      saveToStorage();
      toast('Progress loaded ✓');
      refreshHubStats();
    } catch(err) { toast('Import failed — invalid file'); }
  };
  reader.readAsText(file);
}

// ─────────────────────────────────────────────────
//  MODULE / UNIT LOADING
// ─────────────────────────────────────────────────

async function loadManifest(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Cannot load ${path}`);
  return resp.json();
}

async function initApp() {
  console.log('[LangApp] initApp starting');
  loadFromStorage();

  let manifest;
  try {
    manifest = await loadManifest('manifest.json');
    console.log('[LangApp] manifest loaded:', manifest);
  } catch(e) {
    console.error('[LangApp] FAILED to load manifest.json:', e);
    showError('Cannot load manifest.json — make sure you are running from a web server (python3 -m http.server 8000), not opening the file directly. Error: ' + e.message);
    return;
  }

  if (!manifest.modules || !manifest.modules.length) {
    showError('manifest.json has no modules listed.');
    return;
  }

  for (const mod of manifest.modules) {
    try {
      console.log('[LangApp] loading module:', mod.path);
      const data = await loadManifest(mod.path);
      App.modules[data.id] = data;
      console.log('[LangApp] module loaded:', data.id, data.title);
    } catch(e) {
      console.error('[LangApp] FAILED to load module', mod.path, e);
    }
  }

  console.log('[LangApp] modules loaded:', Object.keys(App.modules));

  if (!Object.keys(App.modules).length) {
    showError('No modules could be loaded. Check the browser console for details.');
    return;
  }

  renderWelcome();
}

// Convert a unit path like "units/j4b/weather.json" → stable id "j4b/weather"
function unitIdFromPath(path) {
  return path.replace(/^units\//, '').replace(/\.json$/, '');
}

async function selectModule(moduleId) {
  App.moduleId = moduleId;
  const mod = App.modules[moduleId];

  for (const unitPath of mod.units) {
    const unitId = unitIdFromPath(unitPath);
    if (!App.units[unitId]) {
      try {
        const data = await loadManifest(unitPath);
        App.units[unitId] = data;
      } catch(e) { console.warn('Cannot load unit', unitPath, e); }
    }
  }

  App.activeUnits = mod.units.map(p => unitIdFromPath(p));
  App.activeCats  = [];

  showScreen('hub');
  renderHub();
}

// ─────────────────────────────────────────────────
//  POOL HELPERS  — build question pools from loaded units
// ─────────────────────────────────────────────────

function getActiveUnits() {
  return App.activeUnits
    .map(id => App.units[id])
    .filter(Boolean);
}

function catMatch(item) {
  if (!App.activeCats.length) return true;
  return item.c && item.c.some(c => App.activeCats.includes(c));
}

function poolVocab()     { return getActiveUnits().flatMap(u => (u.vocab     ||[]).filter(catMatch)); }
function poolBlanks()    { return getActiveUnits().flatMap(u => (u.blanks    ||[]).filter(catMatch)); }
function poolOrder()     { return getActiveUnits().flatMap(u => (u.order     ||[]).filter(catMatch)); }
function poolFreewrite() { return getActiveUnits().flatMap(u => (u.freewrite ||[]).filter(catMatch)); }
function poolRepair()    { return getActiveUnits().flatMap(u => (u.repair    ||[]).filter(catMatch)); }
function poolMatch()     { return getActiveUnits().flatMap(u => (u.vocab     ||[]).filter(catMatch)); }

function poolSize(mode) {
  switch(mode) {
    case 'rapid':     return poolVocab().length + poolBlanks().length;
    case 'typeit':    return poolVocab().length;
    case 'wordorder': return poolOrder().length;
    case 'fillblank': return poolBlanks().length;
    case 'freewrite': return poolFreewrite().length + poolRepair().length;
    case 'repair':    return poolRepair().length;
    case 'match':     return poolMatch().length;
    default:          return 0;
  }
}

// ─────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr, n) { return shuffle(arr).slice(0, n); }

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) =>
    Array.from({length: n+1}, (_, j) => i || j)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyMatch(typed, candidates, fuzzyPct) {
  // Returns { matched: bool, best: string }
  const t = norm(typed);
  if (!t) return { matched: false, best: candidates[0] };
  let bestDist = Infinity, best = candidates[0];
  for (const c of candidates) {
    const cn = norm(c);
    const dist = levenshtein(t, cn);
    if (dist < bestDist) { bestDist = dist; best = c; }
    if (dist === 0) return { matched: true, best: c };
  }
  const threshold = Math.ceil(norm(candidates[0]).length * fuzzyPct);
  return { matched: bestDist <= threshold, best };
}

// Find which answer in `candidates` is closest to `reference`
function closestTo(reference, candidates) {
  const r = norm(reference);
  let bestDist = Infinity, best = candidates[0];
  for (const c of candidates) {
    const dist = levenshtein(r, norm(c));
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function showError(msg) {
  document.body.innerHTML = `<div style="padding:40px;color:#ff2d78;font-family:monospace">${msg}</div>`;
}

function el(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(id);
  if (s) s.classList.add('active');
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────────
//  WELCOME / MODULE SELECT SCREEN
// ─────────────────────────────────────────────────

function renderWelcome() {
  console.log('[LangApp] renderWelcome — modules:', Object.keys(App.modules));
  const grid = el('module-grid');
  if (!grid) { console.error('[LangApp] module-grid element not found!'); return; }
  grid.innerHTML = '';

  for (const [id, mod] of Object.entries(App.modules)) {
    const totalItems = Object.values(App.units)
      .filter(u => u.module === id)
      .reduce((n, u) => n + (u.vocab||[]).length + (u.blanks||[]).length + (u.order||[]).length + (u.freewrite||[]).length + (u.repair||[]).length, 0);

    const seenItems = Object.keys(App.save.items).filter(k => k.startsWith(id+'-')).length;
    const pct = totalItems ? Math.round(seenItems / totalItems * 100) : 0;

    const card = document.createElement('div');
    card.className = 'module-card fade-in';
    card.innerHTML = `
      <div class="module-card-title">${mod.title}</div>
      <div class="module-card-sub">${mod.l2.toUpperCase()} · ${mod.level || ''}</div>
      <div class="module-card-desc">${mod.description || ''}</div>
      <div class="module-progress-bar"><div class="module-progress-fill" style="width:${pct}%"></div></div>
      <div class="module-progress-label">${pct}% explored</div>
    `;
    card.onclick = () => selectModule(id);
    grid.appendChild(card);
  }

  showScreen('welcome');
}

// ─────────────────────────────────────────────────
//  HUB SCREEN
// ─────────────────────────────────────────────────

function renderHub() {
  const mod = App.modules[App.moduleId];
  if (!mod) return;

  // Title — split last word for accent colour
  const words = mod.title.trim().split(' ');
  const last  = words.pop();
  el('hub-logo-text').innerHTML = (words.join(' ') + ' <span>' + last + '</span>').trim();
  el('hub-sub-text').textContent = mod.subtitle || '';

  refreshHubStats();
  el('immersion-toggle').checked = App.immersion;
  renderUnitTabs();
  renderCatButtons();
  renderCabinets();
}

function refreshHubStats() {
  const allItems = Object.values(App.save.items);
  const total   = allItems.reduce((n,i) => n + i.seen,    0);
  const correct = allItems.reduce((n,i) => n + i.correct, 0);
  const games   = Object.values(App.save.scores).filter(s => s > 0).length;
  el('stat-seen').textContent    = total;
  el('stat-correct').textContent = correct;
  el('stat-games').textContent   = games;
}

function renderUnitTabs() {
  const mod = App.modules[App.moduleId];
  const container = el('unit-tabs');
  container.innerHTML = '';

  for (const unitPath of mod.units) {
    const unitId = unitIdFromPath(unitPath);
    const unit   = App.units[unitId];
    if (!unit) continue;

    const btn = document.createElement('button');
    btn.className = 'unit-tab' + (App.activeUnits.includes(unitId) ? ' on' : '');
    btn.textContent = unit.title || unitId;
    btn.onclick = () => {
      if (App.activeUnits.includes(unitId)) {
        if (App.activeUnits.length === 1) return;
        App.activeUnits = App.activeUnits.filter(id => id !== unitId);
      } else {
        App.activeUnits.push(unitId);
      }
      btn.classList.toggle('on');
      renderCatButtons();
      renderCabinets();
    };
    container.appendChild(btn);
  }
}

function renderCatButtons() {
  // Collect all categories from active units
  const catMap = {};
  for (const unit of getActiveUnits()) {
    const allItems = [
      ...(unit.vocab||[]), ...(unit.blanks||[]),
      ...(unit.order||[]), ...(unit.freewrite||[]), ...(unit.repair||[])
    ];
    for (const item of allItems) {
      for (const c of (item.c||[])) {
        if (!catMap[c]) {
          catMap[c] = unit.categories?.[c] || c;
        }
      }
    }
  }

  const container = el('cat-grid');
  container.innerHTML = '';

  if (!Object.keys(catMap).length) {
    el('cat-hint').textContent = '';
    return;
  }

  for (const [key, label] of Object.entries(catMap)) {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (App.activeCats.includes(key) ? ' on' : '');
    btn.textContent = label;
    btn.onclick = () => {
      if (App.activeCats.includes(key)) {
        App.activeCats = App.activeCats.filter(c => c !== key);
      } else {
        App.activeCats.push(key);
      }
      btn.classList.toggle('on');
      updateCatHint();
      renderCabinets();
    };
    container.appendChild(btn);
  }
  updateCatHint();
}

function updateCatHint() {
  const vocab = poolVocab().length;
  const sents = poolBlanks().length + poolOrder().length + poolFreewrite().length + poolRepair().length;
  el('cat-hint').innerHTML =
    `<span>${vocab}</span> vocab · <span>${sents}</span> sentence questions available`;
}

function renderCabinets() {
  const MODES = [
    { id:'rapid',     cls:'rapid',     icon:'⚡', name:'Rapid Fire',   desc:'Timed MC — build your streak' },
    { id:'typeit',    cls:'typeit',    icon:'⌨️', name:'Type It',      desc:'Spell the answer correctly' },
    { id:'wordorder', cls:'wordorder', icon:'🔀', name:'Word Order',   desc:'Tap tiles to build the sentence' },
    { id:'fillblank', cls:'fillblank', icon:'📝', name:'Fill the Blank',desc:'Choose the missing word' },
    { id:'freewrite', cls:'freewrite', icon:'✍️', name:'Free Write',   desc:'Transform or rewrite sentences' },
    { id:'repair',    cls:'repair',    icon:'🔧', name:'Sentence Repair','desc':'Fix the grammar errors' },
    { id:'match',     cls:'match',     icon:'🔗', name:'Match Up',     desc:'Pair words with definitions' },
  ];

  const grid = el('cabinet-grid');
  grid.innerHTML = '';

  for (const m of MODES) {
    const count = poolSize(m.id);
    const hi    = getBestScore(App.moduleId, m.id);
    const enough = count >= MIN_QUESTIONS;

    const cab = document.createElement('div');
    cab.className = `cabinet ${m.cls}${enough ? '' : ' disabled'}`;
    cab.innerHTML = `
      <span class="cabinet-icon">${m.icon}</span>
      <div class="cabinet-name">${m.name}</div>
      <div class="cabinet-desc">${m.desc}</div>
      <div class="cabinet-count"><span>${count}</span> questions</div>
      <div class="cabinet-hi">BEST: <span>${hi || '—'}</span></div>
    `;
    if (enough) cab.onclick = () => openGame(m.id);
    grid.appendChild(cab);
  }
}

function goWelcome() {
  App.moduleId = null;
  App.activeUnits = [];
  App.activeCats  = [];
  renderWelcome();
}

function goHub() {
  clearTimer();
  renderHub();
  showScreen('hub');
}

// ─────────────────────────────────────────────────
//  GAME OPEN / CONFIG
// ─────────────────────────────────────────────────

const MODE_META = {
  rapid:     { name:'RAPID FIRE',    desc:'Answer before the timer runs out. Streak multiplier increases your score.' },
  typeit:    { name:'TYPE IT',       desc:'Read the definition — type the correct word or phrase.' },
  wordorder: { name:'WORD ORDER',    desc:'Tap tiles to build the sentence in the correct order. On Hard+, distractor tiles are added.' },
  fillblank: { name:'FILL THE BLANK',desc:'Choose the word that best completes the sentence.' },
  freewrite: { name:'FREE WRITE',    desc:'Read the prompt — write the transformed or corrected sentence.' },
  repair:    { name:'SENTENCE REPAIR',desc:'Find and fix all grammar errors in the broken sentence.' },
  match:     { name:'MATCH UP',      desc:'Tap a word and its definition to match them.' },
};

function openGame(mode) {
  App.mode = mode;
  const meta = MODE_META[mode];

  el('intro-title').textContent    = meta.name;
  el('intro-desc').textContent     = meta.desc;
  el('intro-mode-color').className = `cabinet-name ${mode}`;

  // Q count slider max = available questions capped at 20
  const available = Math.min(poolSize(mode), 20);
  const slider = el('cfg-qcount');
  slider.max   = available;
  slider.value = Math.min(10, available);
  el('cfg-qcount-val').textContent = slider.value;

  // Difficulty
  el('cfg-diff').value = App.difficulty;
  el('cfg-diff-val').textContent = DIFF_SETTINGS[App.difficulty].label;

  showScreen('gscreen');
  el('playview').style.display = 'none';
  el('resview').style.display  = 'none';
  el('introview').style.display = 'block';
}

// ─────────────────────────────────────────────────
//  GAME START
// ─────────────────────────────────────────────────

function startGame() {
  App.queueSize  = parseInt(el('cfg-qcount').value);
  App.difficulty = parseInt(el('cfg-diff').value);
  const diff     = DIFF_SETTINGS[App.difficulty];

  App.lives   = diff.lives;
  App.score   = 0;
  App.streak  = 0;
  App.correct = 0;
  App.wrong   = 0;
  App.qi      = 0;
  App.queue   = buildQueue(App.mode, App.queueSize);

  if (!App.queue.length) { toast('Not enough questions — add more categories'); return; }

  el('introview').style.display = 'none';
  el('resview').style.display   = 'none';
  el('playview').style.display  = 'block';

  el('play-mode-label').textContent = MODE_META[App.mode].name;
  updateHUD();
  nextQ();
}

// ─────────────────────────────────────────────────
//  QUEUE BUILDERS
// ─────────────────────────────────────────────────

function buildQueue(mode, n) {
  switch(mode) {
    case 'rapid':     return buildRapidQueue(n);
    case 'typeit':    return buildTypeItQueue(n);
    case 'wordorder': return buildWordOrderQueue(n);
    case 'fillblank': return buildFillBlankQueue(n);
    case 'freewrite': return buildFreeWriteQueue(n);
    case 'repair':    return buildRepairQueue(n);
    case 'match':     return buildMatchQueue(n);
    default: return [];
  }
}

function pickN(pool, n) {
  if (!pool.length) return [];
  const result = [];
  const s = shuffle([...pool]);
  for (let i = 0; i < n; i++) result.push(s[i % s.length]);
  return result;
}

// Rapid Fire: mix vocab MC + blank MC
function buildRapidQueue(n) {
  const vocab  = poolVocab();
  const blanks = poolBlanks();
  const all    = [
    ...vocab.map(v  => ({ ...v, _qtype:'vocab' })),
    ...blanks.map(b => ({ ...b, _qtype:'blank' }))
  ];
  return pickN(shuffle(all), n);
}

function buildTypeItQueue(n) {
  return pickN(poolVocab(), n);
}

function buildWordOrderQueue(n) {
  return pickN(poolOrder(), n);
}

function buildFillBlankQueue(n) {
  return pickN(poolBlanks(), n);
}

function buildFreeWriteQueue(n) {
  // Mix transforms and repairs in freewrite mode
  const fw  = poolFreewrite().map(i => ({ ...i, _qtype: 'transform' }));
  const rep = poolRepair().map(i => ({ ...i, _qtype: 'repair' }));
  return pickN(shuffle([...fw, ...rep]), n);
}

function buildRepairQueue(n) {
  return pickN(poolRepair().map(i => ({ ...i, _qtype: 'repair' })), n);
}

function buildMatchQueue(n) {
  // Match uses vocab; we build pairs in the game renderer, not here
  const vocab = poolMatch();
  const pairs = pick(vocab, Math.min(n, vocab.length, 8));
  return [{ _qtype:'matchgame', pairs }]; // single "question"
}

// ─────────────────────────────────────────────────
//  QUESTION RENDERING
// ─────────────────────────────────────────────────

function nextQ() {
  if (App.qi >= App.queue.length || App.lives <= 0) { endGame(); return; }
  const q = App.queue[App.qi];
  clearTimer();
  hideAllInputs();
  el('next-btn').classList.remove('show');
  el('feedback').className = '';

  updateProgress();
  updateHUD();

  const qtype = q._qtype || App.mode;
  switch(qtype) {
    case 'vocab':     renderRapidVocab(q);  break;
    case 'blank':     renderRapidBlank(q);  break;
    case 'typeit':    renderTypeIt(q);       break;
    case 'wordorder': renderWordOrder(q);    break;
    case 'fillblank': renderFillBlank(q);    break;
    case 'transform': renderFreeWrite(q);    break;
    case 'repair':    renderRepair(q);       break;
    case 'matchgame': renderMatch(q);        break;
    default:          renderRapidVocab(q);
  }
}

// ── RAPID FIRE — VOCAB ──────────────────────────

function renderRapidVocab(q) {
  // Question: show definition, answer: the l2 word
  showQCard();
  el('q-mode-tag').textContent = '⚡ RAPID FIRE';

  if (App.immersion) {
    el('q-text').textContent = q.def || q.l2;
    el('q-l1').style.display = 'none';
  } else {
    el('q-text').textContent = q.def || q.l1 || q.l2;
    el('q-l1').style.display = 'none';
  }

  el('q-hint').textContent = (q.hint && !App.immersion) ? `(${q.hint})` : '';
  el('q-hint').style.display = q.hint && !App.immersion ? 'block' : 'none';

  // Build options: one correct from a[], rest from other vocab
  const allA   = Array.isArray(q.a) ? q.a : [q.l2];
  const correct = allA[Math.floor(Math.random() * allA.length)];
  const forbidden = new Set(allA);

  const pool = poolVocab()
    .map(v => v.l2)
    .filter(w => !forbidden.has(w));

  const numD = DIFF_SETTINGS[App.difficulty].distractors - 1;
  const distractors = pick(pool, numD);
  const options = shuffle([correct, ...distractors]);

  renderOptions(options, correct, (chosen, wasCorrect) => {
    recordItem(q.id, wasCorrect);
    if (!wasCorrect) showExplanation(q.explanation || '');
  });

  startTimer(DIFF_SETTINGS[App.difficulty].timer);
}

// ── RAPID FIRE — BLANK ──────────────────────────

function renderRapidBlank(q) {
  showBlankWrap(q);

  const allA    = Array.isArray(q.a) ? q.a : [q.a];
  const correct = allA[Math.floor(Math.random() * allA.length)];
  const forbidden = new Set(allA);

  const pool = poolVocab().map(v => v.l2).filter(w => !forbidden.has(w));
  const numD = DIFF_SETTINGS[App.difficulty].distractors - 1;
  const safeD = (q.d || []).filter(x => !forbidden.has(x));
  const extra = pick(pool.filter(w => !safeD.includes(w)), Math.max(0, numD - safeD.length));
  const options = shuffle([correct, ...[...safeD, ...extra].slice(0, numD)]);

  renderOptions(options, correct, (chosen, wasCorrect) => {
    fillBlankSlot('blank-slot-0', chosen, wasCorrect);
    if (!App.immersion) el('blank-l1').style.display = 'block';
    recordItem(q.id, wasCorrect);
    if (!wasCorrect) showExplanation(q.explanation || '');
  });

  startTimer(DIFF_SETTINGS[App.difficulty].timer + 3);
}

// ── TYPE IT ─────────────────────────────────────

function renderTypeIt(q) {
  showQCard();
  el('q-mode-tag').textContent = '⌨️ TYPE IT';
  el('q-text').textContent = q.def || (App.immersion ? q.l2 : (q.l1 || q.def));
  el('q-hint').textContent = q.hint ? `hint: ${q.hint}` : '';
  el('q-hint').style.display = q.hint ? 'block' : 'none';
  el('q-l1').style.display = 'none';

  const inp = el('type-field');
  inp.value = '';
  inp.className = 'type-field';
  inp.disabled = false;
  el('typeinput').style.display = 'flex';
  setTimeout(() => inp.focus(), 80);
  inp.onkeydown = e => { if (e.key === 'Enter') submitType(); };
}

function submitType() {
  const q    = App.queue[App.qi];
  const inp  = el('type-field');
  const typed = inp.value.trim();
  if (!typed) return;
  inp.disabled = true;

  const allA   = Array.isArray(q.a) ? q.a : [q.l2];
  const diff   = DIFF_SETTINGS[App.difficulty];
  const { matched, best } = fuzzyMatch(typed, allA, diff.fuzzyPct);

  inp.className = 'type-field ' + (matched ? 'ok' : 'bad');
  handleResult(matched, q.id);
  if (!matched) {
    showExplanation(`Correct: "${best}"`+(q.explanation ? ` — ${q.explanation}` : ''));
  }
  revealQTranslation(q);
  showNextBtn();
}

// ── WORD ORDER ──────────────────────────────────

function renderWordOrder(q) {
  showQCard();
  el('q-mode-tag').textContent = '🔀 WORD ORDER';
  el('q-l1').style.display  = 'none';
  el('q-hint').style.display = 'none';

  const isHard = App.difficulty >= 3;
  const tiles  = [...q.w];
  if (isHard && q.d && q.d.length) {
    tiles.push(...pick(q.d, 2));
  }

  App.woZone     = [];
  App.woPool     = shuffle(tiles);
  App.woCorrect  = q.w.length; // number of tiles in the correct answer

  const zone = el('drop-zone');
  const pool = el('tile-pool');
  zone.innerHTML = '';
  pool.innerHTML = '';
  zone.className = 'drop-zone';

  App.woPool.forEach(w => {
    const t = makeTile(w, 'pool');
    pool.appendChild(t);
  });

  updateWOPrompt();
  el('wordorderwrap').style.display = 'flex';
  el('check-wo').style.display = 'none';
}

function updateWOPrompt() {
  const remaining = App.woCorrect - App.woZone.length;
  el('q-text').textContent = remaining > 0
    ? `Unscramble the sentence — ${remaining} word${remaining !== 1 ? 's' : ''} remaining`
    : 'Ready to check!';
}

function makeTile(word, loc) {
  const t = document.createElement('div');
  t.textContent = word;
  t.dataset.word = word;
  t.className = 'tile' + (loc === 'zone' ? ' in-zone' : '');
  t.onclick = () => moveTile(t, loc);
  return t;
}

function moveTile(tile, from) {
  const zone  = el('drop-zone');
  const opool = el('tile-pool');
  const word  = tile.dataset.word;
  tile.remove();

  if (from === 'pool') {
    // Move from pool → zone
    App.woZone.push(word);
    const t = makeTile(word, 'zone');
    zone.appendChild(t);
  } else {
    // Move from zone → pool — remove FIRST occurrence only
    const idx = App.woZone.indexOf(word);
    if (idx !== -1) App.woZone.splice(idx, 1);
    const t = makeTile(word, 'pool');
    opool.appendChild(t);
  }

  const hasTiles = zone.querySelectorAll('.tile').length > 0;
  zone.className = 'drop-zone' + (hasTiles ? ' has-tiles' : '');
  el('check-wo').style.display = hasTiles ? 'block' : 'none';
  updateWOPrompt();
}

function checkWordOrder() {
  const q     = App.queue[App.qi];
  const zone  = el('drop-zone');
  const built = [...zone.querySelectorAll('.tile')].map(t => t.dataset.word);

  const accepted = [q.w, ...(q.alts || [])];
  const ok = accepted.some(acc => JSON.stringify(built) === JSON.stringify(acc));

  zone.className = 'drop-zone ' + (ok ? 'ok' : 'bad');
  // lock tiles
  zone.querySelectorAll('.tile').forEach(t => { t.onclick = null; t.style.cursor = 'default'; });
  el('tile-pool').querySelectorAll('.tile').forEach(t => { t.onclick = null; t.style.cursor = 'default'; });
  el('check-wo').style.display = 'none';

  handleResult(ok, q.id);
  if (!ok) {
    showExplanation(`Correct order: "${q.w.join(' ')}"`);
  }
  revealQTranslation(q);
  showNextBtn();
}

// ── FILL THE BLANK ───────────────────────────────

function renderFillBlank(q) {
  showBlankWrap(q);

  const allA    = Array.isArray(q.a) ? q.a : [q.a];
  const correct = allA[Math.floor(Math.random() * allA.length)];
  const forbidden = new Set(allA);

  const pool  = poolVocab().map(v => v.l2).filter(w => !forbidden.has(w));
  const numD  = DIFF_SETTINGS[App.difficulty].distractors - 1;
  const safeD = (q.d || []).filter(x => !forbidden.has(x));
  const extra = pick(pool.filter(w => !safeD.includes(w)), Math.max(0, numD - safeD.length));
  const options = shuffle([correct, ...[...safeD, ...extra].slice(0, numD)]);

  renderOptions(options, correct, (chosen, wasCorrect) => {
    fillBlankSlot('blank-slot-0', chosen, wasCorrect);
    if (!App.immersion) el('blank-l1').style.display = 'block';
    recordItem(q.id, wasCorrect);
    if (!wasCorrect) showExplanation(q.explanation || '');
  });
}

// ── FREE WRITE (transform) ───────────────────────

function renderFreeWrite(q) {
  showQCard();
  el('q-mode-tag').textContent = '✍️ FREE WRITE';
  el('q-text').textContent = q.prompt;
  el('q-hint').style.display = 'none';
  el('q-l1').style.display   = 'none';

  if (q.broken) {
    el('fw-broken').textContent = q.broken;
    el('fw-broken').style.display = 'block';
  } else {
    el('fw-broken').style.display = 'none';
  }

  const field = el('fw-field');
  field.value = '';
  field.className = 'fw-field';
  field.disabled  = false;
  el('fw-model').style.display  = 'none';
  el('fw-explanation').style.display = 'none';
  el('freewritewrap').style.display  = 'flex';
  setTimeout(() => field.focus(), 80);
  field.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFreeWrite(); } };
}

function submitFreeWrite() {
  const q     = App.queue[App.qi];
  const field = el('fw-field');
  const typed = field.value.trim();
  if (!typed) return;
  field.disabled = true;

  const allA   = [...(q.a || []), ...(q.alts || [])];
  const diff   = DIFF_SETTINGS[App.difficulty];
  const { matched, best } = fuzzyMatch(typed, allA, diff.fuzzyPct);

  field.className = 'fw-field ' + (matched ? 'ok' : 'bad');

  // Determine which model answer to show
  let display;
  if (matched) {
    display = best;
  } else {
    // Check how close student got
    const tyNorm  = norm(typed);
    const distToTyped  = levenshtein(tyNorm, norm(best));
    const threshold    = Math.ceil(tyNorm.length * 0.4);
    if (distToTyped <= threshold) {
      // Student was close — show answer nearest their attempt
      display = closestTo(typed, allA);
    } else if (q.broken) {
      // Student went off-track — show minimal correction of the broken sentence
      display = closestTo(q.broken, allA);
    } else {
      display = allA[0];
    }
  }

  el('fw-model-answer').innerHTML = display;
  el('fw-model').style.display = 'block';

  if (!matched && q.explanation) {
    showExplanation(q.explanation);
  }

  handleResult(matched, q.id);
  showNextBtn();
}

// ── SENTENCE REPAIR ──────────────────────────────

function renderRepair(q) {
  showQCard();
  el('q-mode-tag').textContent = '🔧 SENTENCE REPAIR';
  el('q-text').textContent = 'Fix the grammar:';

  el('fw-broken').textContent    = q.broken;
  el('fw-broken').style.display  = 'block';

  const field = el('fw-field');
  field.value = '';
  field.className = 'fw-field';
  field.disabled  = false;
  el('fw-model').style.display       = 'none';
  el('fw-explanation').style.display = 'none';
  el('repair-checks').style.display  = 'none';
  el('freewritewrap').style.display  = 'flex';
  setTimeout(() => field.focus(), 80);
  field.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitRepair(); } };
}

// Word-boundary aware contains — prevents "erupt" matching inside "erupted"
function containsWord(text, word) {
  if (!word) return false;
  const n = norm(word);
  const t = norm(text);
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|\\s)' + escaped + '(?:\\s|$)').test(t);
}

function submitRepair() {
  const q     = App.queue[App.qi];
  const field = el('fw-field');
  const typed = field.value.trim();
  if (!typed) return;
  field.disabled = true;

  // Check all errors: ALL wrong forms must be absent AND one of right must be present
  let allOk = true;
  const checks = el('repair-checks');
  checks.innerHTML = '';

  for (const err of (q.errors || [])) {
    // Support wrong as string or array, plus optional wrong_alts
    const wrongForms = [
      ...(Array.isArray(err.wrong) ? err.wrong : (err.wrong ? [err.wrong] : [])),
      ...(err.wrong_alts || [])
    ];
    const rightForms = Array.isArray(err.right) ? err.right : (err.right ? [err.right] : []);

    const anyWrongPresent = wrongForms.some(w => containsWord(typed, w));
    const rightPresent    = rightForms.some(r => containsWord(typed, r));
    const ok = !anyWrongPresent && rightPresent;
    if (!ok) allOk = false;

    const displayWrong = wrongForms[0] || '?';
    const displayRight = rightForms[0] || '?';

    const row = document.createElement('div');
    row.className = 'repair-check-row';
    row.innerHTML = `
      <span class="check-icon">${ok ? '✅' : '❌'}</span>
      <span class="check-wrong">${displayWrong}</span>
      <span style="color:var(--sub)">→</span>
      <span class="check-right">${displayRight}</span>
      ${err.explanation ? `<span style="color:var(--sub);font-size:.72rem;margin-left:6px">— ${err.explanation}</span>` : ''}
    `;
    checks.appendChild(row);
  }

  checks.style.display = 'flex';
  field.className = 'fw-field ' + (allOk ? 'ok' : 'bad');

  // Show the canonical corrected sentence
  const allA = Array.isArray(q.a) ? q.a : [q.l2 || q.broken];
  el('fw-model-answer').textContent = closestTo(typed, allA);
  el('fw-model').style.display = 'block';

  handleResult(allOk, q.id);
  showNextBtn();
}

// ── MATCH UP ─────────────────────────────────────

function renderMatch(q) {
  const pairs = q.pairs;
  el('matchwrap').style.display = 'flex';

  const colWords = el('match-col-words');
  const colDefs  = el('match-col-defs');
  colWords.innerHTML = '';
  colDefs.innerHTML  = '';

  App.matchPairs = pairs;
  App.matchDone  = 0;
  App.matchSel   = null;

  const shuffledWords = shuffle(pairs.map((p,i) => ({text: p.l2, idx: i})));
  const shuffledDefs  = shuffle(pairs.map((p,i) => ({text: p.def, idx: i})));

  shuffledWords.forEach(({text, idx}) => {
    const item = makeMatchItem(text, idx, 'word');
    colWords.appendChild(item);
  });

  shuffledDefs.forEach(({text, idx}) => {
    const item = makeMatchItem(text, idx, 'def');
    colDefs.appendChild(item);
  });

  // Match game doesn't use standard nextQ flow — it ends when all matched
  el('next-btn').classList.remove('show');
}

function makeMatchItem(text, idx, side) {
  const item = document.createElement('div');
  item.className = 'match-item';
  item.textContent = text;
  item.dataset.idx  = idx;
  item.dataset.side = side;
  item.onclick = () => handleMatchClick(item);
  return item;
}

function handleMatchClick(item) {
  if (item.classList.contains('matched')) return;

  if (!App.matchSel) {
    App.matchSel = item;
    item.classList.add('selected');
    return;
  }

  // Same side — switch selection
  if (App.matchSel.dataset.side === item.dataset.side) {
    App.matchSel.classList.remove('selected');
    App.matchSel = item;
    item.classList.add('selected');
    return;
  }

  // Different side — check match
  const ok = App.matchSel.dataset.idx === item.dataset.idx;

  if (ok) {
    [App.matchSel, item].forEach(el => {
      el.classList.remove('selected');
      el.classList.add('matched');
      el.onclick = null;
    });
    App.matchDone++;
    App.score += 10;
    flashFeedback(true);
    updateHUD();

    if (App.matchDone === App.matchPairs.length) {
      setTimeout(() => {
        recordItem('match-' + App.moduleId, true);
        endGame();
      }, 600);
    }
  } else {
    App.matchSel.classList.remove('selected');
    item.classList.add('wrong-flash');
    App.matchSel.classList.add('wrong-flash');
    setTimeout(() => {
      item.classList.remove('wrong-flash');
      App.matchSel && App.matchSel.classList.remove('wrong-flash');
    }, 500);
    App.lives = Math.max(0, App.lives - 1);
    flashFeedback(false);
    updateHUD();
    if (App.lives <= 0) setTimeout(endGame, 800);
  }

  App.matchSel = null;
}

// ─────────────────────────────────────────────────
//  SHARED RENDER HELPERS
// ─────────────────────────────────────────────────

function showQCard() {
  el('qcard').style.display    = 'block';
  el('blankwrap').style.display = 'none';
  el('q-l1').style.display     = 'none';
  el('q-hint').style.display   = 'none';
  el('fw-explanation').style.display = 'none';
}

function showBlankWrap(q) {
  el('qcard').style.display    = 'none';
  el('blankwrap').style.display = 'block';

  // Build sentence with blank slot(s)
  const container = el('blank-sentence');
  container.innerHTML = '';
  let slotIdx = 0;

  (q.s || []).forEach(part => {
    if (part === '___') {
      const slot = document.createElement('span');
      slot.className = 'blank-slot';
      slot.id = `blank-slot-${slotIdx++}`;
      slot.textContent = '\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0';
      container.appendChild(slot);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  });

  // L1 translation shown after answer
  const l1 = el('blank-l1');
  l1.textContent = q.l2 || '';
  l1.style.display = 'none';

  el('fw-explanation').style.display = 'none';
}

function fillBlankSlot(slotId, text, ok) {
  const slot = el(slotId);
  if (!slot) return;
  slot.textContent = text;
  slot.classList.add('filled', ok ? 'ok' : 'bad');
}

function renderOptions(options, correct, onAnswer) {
  const grid = el('options-grid');
  grid.innerHTML = '';
  grid.style.display = 'grid';

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className   = 'opt-btn';
    btn.textContent = opt;
    btn.onclick = () => {
      // Disable all
      grid.querySelectorAll('.opt-btn').forEach(b => { b.disabled = true; });
      const ok = opt === correct;
      btn.classList.add(ok ? 'correct' : 'wrong');
      if (!ok) {
        grid.querySelectorAll('.opt-btn')
          .forEach(b => { if (b.textContent === correct) b.classList.add('correct'); });
      }
      handleResult(ok, null); // id handled by caller
      onAnswer(opt, ok);
      showNextBtn();
    };
    grid.appendChild(btn);
  });
}

function hideAllInputs() {
  el('options-grid').style.display    = 'none';
  el('typeinput').style.display       = 'none';
  el('wordorderwrap').style.display   = 'none';
  el('freewritewrap').style.display   = 'none';
  el('matchwrap').style.display       = 'none';
  el('blankwrap').style.display       = 'none';
  el('qcard').style.display           = 'block';
  // Reset sub-elements
  el('fw-broken').style.display       = 'none';
  el('fw-model').style.display        = 'none';
  el('fw-explanation').style.display  = 'none';
  el('repair-checks').style.display   = 'none';
  el('q-l1').style.display            = 'none';
  el('q-hint').style.display          = 'none';
  el('timer-wrap').style.display      = 'none';
}

function showExplanation(text) {
  if (!text) return;
  const exp = el('fw-explanation');
  exp.textContent = text;
  exp.style.display = 'block';
}

function revealQTranslation(q) {
  if (App.immersion) return;
  const l2 = q.l2 || q.en || '';
  if (!l2) return;
  el('q-l1').textContent     = l2;
  el('q-l1').style.display   = 'block';
}

// ─────────────────────────────────────────────────
//  RESULT HANDLING
// ─────────────────────────────────────────────────

function handleResult(ok, itemId) {
  if (ok) {
    App.streak  = Math.min(App.streak + 1, STREAK_MAX);
    App.correct++;
    const mult  = 1 + Math.floor(App.streak / 2);
    App.score  += 10 * mult;
    flashFeedback(true);
  } else {
    App.streak = 0;
    App.wrong++;
    App.lives  = Math.max(0, App.lives - 1);
    flashFeedback(false);
  }
  if (itemId) recordItem(itemId, ok);
  updateHUD();
  updateStreak();
}

function showNextBtn() {
  el('next-btn').classList.add('show');
}

function advanceQ() {
  App.qi++;
  el('next-btn').classList.remove('show');
  if (App.lives <= 0 || App.qi >= App.queue.length) { endGame(); return; }
  nextQ();
}

// ─────────────────────────────────────────────────
//  TIMER
// ─────────────────────────────────────────────────

let _timerInterval = null;
let _timerRemaining = 0;

function startTimer(secs) {
  clearTimer();
  _timerRemaining = secs;

  const arc  = el('timer-arc');
  const txt  = el('timer-text');
  const circ = 150.8; // 2π × r=24
  el('timer-wrap').style.display = 'flex';

  arc.style.stroke = 'var(--cyan)';
  arc.style.strokeDashoffset = '0';
  txt.textContent = secs;

  _timerInterval = setInterval(() => {
    _timerRemaining--;
    txt.textContent = _timerRemaining;
    arc.style.strokeDashoffset = String(circ * (1 - _timerRemaining / secs));

    if (_timerRemaining <= 3) arc.style.stroke = 'var(--pink)';
    else if (_timerRemaining <= 6) arc.style.stroke = 'var(--yellow)';

    if (_timerRemaining <= 0) {
      clearTimer();
      handleResult(false, App.queue[App.qi]?.id || null);
      if (!App.immersion) revealQTranslation(App.queue[App.qi] || {});
      showNextBtn();
      // disable all options
      el('options-grid').querySelectorAll('.opt-btn').forEach(b => b.disabled = true);
    }
  }, 1000);
}

function clearTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  el('timer-wrap').style.display = 'none';
}

// ─────────────────────────────────────────────────
//  HUD UPDATES
// ─────────────────────────────────────────────────

function updateHUD() {
  el('lives-display').textContent = '❤️'.repeat(App.lives) + '🖤'.repeat(Math.max(0, DIFF_SETTINGS[App.difficulty].lives - App.lives));
  el('score-display').textContent = App.score + ' XP';
}

function updateProgress() {
  const pct = App.queue.length ? (App.qi / App.queue.length * 100) : 0;
  el('progress-fill').style.width = pct + '%';
}

function updateStreak() {
  for (let i = 0; i < STREAK_MAX; i++) {
    const pip = el('p' + i);
    if (pip) pip.className = 'pip' + (i < App.streak ? ' lit' : '');
  }
}

function flashFeedback(ok) {
  const fb = el('feedback');
  fb.textContent = ok ? '✓ CORRECT' : '✗ WRONG';
  fb.className = ok ? 'show-ok' : 'show-bad';
  setTimeout(() => { fb.className = ''; }, 700);
}

// ─────────────────────────────────────────────────
//  END GAME / RESULTS
// ─────────────────────────────────────────────────

function endGame() {
  clearTimer();
  recordScore(App.moduleId, App.mode, App.score);

  const total = App.correct + App.wrong;
  const pct   = total ? Math.round(App.correct / total * 100) : 0;

  let title = 'GAME OVER';
  if (pct === 100) title = 'PERFECT!';
  else if (pct >= 80) title = 'GREAT!';
  else if (pct >= 60) title = 'GOOD!';

  el('res-title').textContent   = title;
  el('res-score').textContent   = App.score;
  el('res-sub').textContent     = MODE_META[App.mode]?.name || '';
  el('res-correct').textContent = App.correct;
  el('res-wrong').textContent   = App.wrong;
  el('res-pct').textContent     = pct + '%';

  const best = getBestScore(App.moduleId, App.mode);
  el('res-hi').textContent = App.score >= best && App.score > 0
    ? '🏆 NEW BEST SCORE!'
    : (best > 0 ? `Best: ${best} XP` : '');

  el('playview').style.display = 'none';
  el('resview').style.display  = 'block';
}

// ─────────────────────────────────────────────────
//  DOM WIRING  (called after DOM ready)
// ─────────────────────────────────────────────────

function wireDom() {
  // Config sliders
  el('cfg-qcount').oninput = e => { el('cfg-qcount-val').textContent = e.target.value; };
  el('cfg-diff').oninput   = e => {
    App.difficulty = parseInt(e.target.value);
    el('cfg-diff-val').textContent = DIFF_SETTINGS[App.difficulty].label;
  };

  // Next button
  el('next-btn').onclick = advanceQ;

  // Immersion toggle
  el('immersion-toggle').onchange = e => { App.immersion = e.target.checked; };

  // Save/load buttons
  el('btn-export').onclick = exportSave;
  el('btn-import').onclick = () => el('import-input').click();
  el('import-input').onchange = e => {
    if (e.target.files[0]) importSave(e.target.files[0]);
    e.target.value = '';
  };

  // Game back buttons — all go to hub
  document.querySelectorAll('.game-back-btn').forEach(btn => {
    btn.onclick = () => { clearTimer(); goHub(); };
  });

  // Hub back button — goes to welcome
  el('hub-back-btn') && (el('hub-back-btn').onclick = goWelcome);

  // Results buttons
  el('res-btn-again').onclick = startGame;
  el('res-btn-hub').onclick   = goHub;

  // Word order check button
  el('check-wo').onclick = checkWordOrder;

  // Free write submit
  el('btn-submit-fw').onclick = () => {
    const q = App.queue[App.qi];
    if (q._qtype === 'repair') submitRepair();
    else submitFreeWrite();
  };

  // Type it submit
  el('btn-submit-type').onclick = submitType;
}

// ─────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  console.log('[LangApp] DOMContentLoaded — wiring DOM');
  try {
    wireDom();
    console.log('[LangApp] wireDom OK');
  } catch(e) {
    console.error('[LangApp] wireDom FAILED:', e);
  }
  initApp();
});
