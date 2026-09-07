#!/usr/bin/env node
/* ============================================================
   ⚽ ASTA FANTACALCIO — Server in tempo reale (zero dipendenze)
   Avvio:   node server.js
   Porta:   PORT=8080 node server.js (o da variabile d'ambiente Render)
   Passcode: ADMIN_PASSCODE=segreto node server.js
   Lo stato viene salvato in state.json (sopravvive ai riavvii).
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ---------------- Stato predefinito ---------------- */
function freshState() {
  return {
    phase: 'lobby',            // 'lobby' | 'auction' | 'finished'
    queue: [],                 // [{ id, name, base }]
    current: null,             // { id, name, base } | null
    value: 0,                  // valore attuale offerto (€)
    winner: null,              // nome del miglior offerente
    expiresAt: 0,              // timestamp (ms) in cui scade l'asta (0 se nessun timer)
    isPaused: false,           // timer in pausa
    pausedRemaining: 0,        // ms rimanenti quando messo in pausa
    lastBidAt: 0,              // timestamp ultima offerta
    participants: {},          // nome(lowercase) -> { name, token, spent, roster, lastBidAt }
    tokens: {},                // token -> nome
    setting: {
      increment: 1,            // passo di rilancio (€)
      timerDuration: 30,       // durata timer asta in secondi (0 = manuale)
      extendThreshold: 10,     // soglia sotto cui il rilancio allunga il countdown (es. 10s)
      extendSeconds: 10,       // a quanto riportare (o quanto aggiungere) il timer (es. 10s)
      extendMode: 'set',       // 'set' (riporta ad almeno extendSeconds) | 'add' (aggiunge extendSeconds)
      startTimerOnOpen: true,  // avvia countdown appena si apre il giocatore
      autoNext: true,          // avvio automatico del prossimo giocatore
      autoNextDelay: 3,        // secondi di attesa prima del prossimo giocatore
      baseDefault: 1,          // base di default se non specificata (€)
      passcode: process.env.ADMIN_PASSCODE || 'admin', // password pannello astatore
    },
    history: [],               // [{ id, player, winner, value, at }]
  };
}

let state = freshState();
try {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      const def = freshState();
      state = Object.assign(def, saved);
      state.setting = Object.assign(def.setting, saved.setting || {});
      if (process.env.ADMIN_PASSCODE) {
        state.setting.passcode = process.env.ADMIN_PASSCODE;
      }
    }
  }
} catch (e) {
  console.error('Info: Nuovo stato inizializzato (nessun file state.json precedente valido)');
}

/* ---------------- Gestione Timer & Salvataggio ---------------- */
const sseClients = new Set();
const adminTokens = new Set();
let closeTimer = null;
let nextTimer = null;

function clearClose() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

function clearBoth() {
  clearClose();
  if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
}

function scheduleSave() {
  clearTimeout(state._saveT);
  state._saveT = setTimeout(() => {
    try {
      const toSave = Object.assign({}, state);
      delete toSave._saveT;
      fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
    } catch (e) {
      console.error('Errore salvataggio stato:', e.message);
    }
  }, 300);
}

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function cleanName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function validName(name) {
  return /^[\p{L}\p{N} .'\-_]+$/u.test(name);
}

function getParticipant(name) {
  return state.participants[String(name || '').toLowerCase()];
}

function publicState() {
  return {
    phase: state.phase,
    current: state.current,
    value: state.value,
    winner: state.winner,
    expiresAt: state.expiresAt,
    isPaused: state.isPaused,
    pausedRemaining: state.pausedRemaining,
    lastBidAt: state.lastBidAt,
    serverNow: Date.now(),
    setting: {
      increment: state.setting.increment,
      timerDuration: state.setting.timerDuration,
      extendThreshold: state.setting.extendThreshold,
      extendSeconds: state.setting.extendSeconds,
      extendMode: state.setting.extendMode,
      startTimerOnOpen: state.setting.startTimerOnOpen,
      autoNext: state.setting.autoNext,
      autoNextDelay: state.setting.autoNextDelay,
      baseDefault: state.setting.baseDefault,
    },
    // Compatibilità legacy
    increment: state.setting.increment,
    autoClose: state.setting.timerDuration,
    autoNext: state.setting.autoNext,
    baseDefault: state.setting.baseDefault,
    queue: state.queue,
    history: state.history.slice(-100),
    participants: Object.keys(state.participants).map(k => ({
      name: state.participants[k].name,
      spent: state.participants[k].spent || 0,
      roster: state.participants[k].roster || {},
    })),
  };
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
  scheduleSave();
}

/* ---------------- Logica Asta ---------------- */
function armClose() {
  clearClose();
  if (!state.current || !state.expiresAt || state.isPaused) return;
  const remaining = state.expiresAt - Date.now();
  if (remaining <= 0) {
    award();
    return;
  }
  closeTimer = setTimeout(() => {
    closeTimer = null;
    award();
  }, Math.max(remaining, 40));
}

function startPlayerAuction(playerObj) {
  clearBoth();
  const name = cleanName(playerObj && playerObj.name);
  if (!name) return false;
  let base = Number(playerObj.base);
  if (!Number.isFinite(base) || base < 0) base = state.setting.baseDefault;
  base = Math.round(base);

  state.current = { id: playerObj.id || uid(), name, base };
  state.value = base;
  state.winner = null;
  state.lastBidAt = 0;
  state.isPaused = false;
  state.pausedRemaining = 0;
  state.phase = 'auction';

  if (state.setting.timerDuration > 0 && state.setting.startTimerOnOpen) {
    state.expiresAt = Date.now() + (state.setting.timerDuration * 1000);
    armClose();
  } else {
    state.expiresAt = 0;
  }

  broadcast();
  return true;
}

function startNext() {
  clearBoth();
  if (state.current) return false;
  if (!state.queue.length) {
    if (state.phase !== 'finished') {
      state.phase = 'finished';
      broadcast();
    }
    return false;
  }
  const next = state.queue.shift();
  return startPlayerAuction(next);
}

function award() {
  clearBoth();
  if (!state.current) return;
  const curr = state.current;
  const finalPrice = state.winner ? state.value : 0;
  const rec = {
    id: curr.id || uid(),
    player: curr.name,
    winner: state.winner || null,
    value: finalPrice,
    at: Date.now()
  };

  if (state.winner) {
    const p = getParticipant(state.winner);
    if (p) {
      p.roster = p.roster || {};
      p.roster[rec.player] = rec.value;
      p.spent = (p.spent || 0) + rec.value;
    }
  }

  state.history.push(rec);
  state.current = null;
  state.winner = null;
  state.value = 0;
  state.expiresAt = 0;
  state.lastBidAt = 0;
  state.isPaused = false;
  state.pausedRemaining = 0;

  if (state.queue.length > 0) {
    state.phase = 'auction';
    broadcast();
    if (state.setting.autoNext) {
      const delay = Math.max(1, (state.setting.autoNextDelay || 3)) * 1000;
      nextTimer = setTimeout(() => {
        nextTimer = null;
        startNext();
      }, delay);
    }
  } else {
    state.phase = 'finished';
    broadcast();
  }
}

/* Ripristino timer se il server viene riavviato mentre l'asta era aperta */
if (state.current && state.expiresAt && !state.isPaused) {
  armClose();
}

/* ---------------- Risposte HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => {
    b += c;
    if (b.length > 2e6) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(JSON.parse(b || '{}'));
    } catch (e) {
      cb({});
    }
  });
  req.on('error', () => cb({}));
}

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const cleanPath = p.replace(/^\/+/, '');

  // Cerca prima in public/ se esiste, altrimenti nella root del progetto
  let file = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!fs.existsSync(file) || !file.startsWith(PUBLIC_DIR)) {
    file = path.normalize(path.join(__dirname, cleanPath));
  }

  // Protezione file sensibili
  if (!file.startsWith(__dirname) || file.endsWith('state.json') || file.includes('.git')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Accesso negato');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      if (p === '/index.html' || p === '/') {
        const rootIndex = path.join(__dirname, 'index.html');
        if (fs.existsSync(rootIndex)) {
          return fs.readFile(rootIndex, (err2, data2) => {
            if (err2) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              return res.end('File index.html non trovato');
            }
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            return res.end(data2);
          });
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('File non trovato');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 1500\n\n');
  res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
  sseClients.add(res);

  const hb = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch (e) {
      clearInterval(hb);
      sseClients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
}

/* ---------------- Gestione Endpoint API ---------------- */
function handlePost(req, res, url) {
  readBody(req, body => {
    try {
      /* === PARTECIPANTE: JOIN === */
      if (url === '/api/join') {
        const token = String(body.token || '');
        if (token && state.tokens[token]) {
          const existing = state.tokens[token];
          return sendJson(res, 200, { ok: true, name: existing, token });
        }
        const name = cleanName(body.name);
        if (!name) return sendJson(res, 400, { ok: false, error: 'Inserisci il tuo nome' });
        if (!validName(name)) return sendJson(res, 400, { ok: false, error: 'Caratteri non validi nel nome' });
        const key = name.toLowerCase();
        if (state.participants[key]) {
          return sendJson(res, 409, { ok: false, error: 'Nome già occupato da un altro partecipante' });
        }
        const newToken = crypto.randomBytes(12).toString('hex');
        state.tokens[newToken] = name;
        state.participants[key] = {
          name,
          token: newToken,
          spent: 0,
          roster: {},
          lastBidAt: 0,
        };
        broadcast();
        return sendJson(res, 200, { ok: true, name, token: newToken });
      }

      /* === PARTECIPANTE: RILANCIO (PUNTA) === */
      if (url === '/api/bid') {
        const name = state.tokens[String(body.token || '')];
        if (!name) return sendJson(res, 401, { ok: false, error: 'Partecipante non registrato' });
        const p = getParticipant(name);
        if (!p) return sendJson(res, 401, { ok: false, error: 'Sessione scaduta, reinserisci il nome' });
        if (state.phase !== 'auction' || !state.current) {
          return sendJson(res, 400, { ok: false, error: 'Nessuna asta in corso al momento' });
        }
        if (state.isPaused) {
          return sendJson(res, 400, { ok: false, error: 'Asta momentaneamente in pausa dall\'astatore' });
        }
        if (state.winner === name) {
          return sendJson(res, 400, { ok: false, error: 'Sei già il miglior offerente! 🏆' });
        }

        const now = Date.now();
        if (p.lastBidAt && now - p.lastBidAt < 250) {
          return sendJson(res, 400, { ok: false, error: 'Calma, attendi una frazione di secondo…' });
        }
        p.lastBidAt = now;
        state.lastBidAt = now;

        // Calcolo nuovo prezzo: se prima offerta parte dalla base, altrimenti incrementa
        if (!state.winner) {
          state.value = state.current.base;
        } else {
          state.value = state.value + state.setting.increment;
        }
        state.winner = name;

        // Gestione Timer & Anti-Sniping (Estensione Rilanci)
        if (state.setting.timerDuration > 0) {
          if (!state.expiresAt || state.expiresAt <= now) {
            // Avvio timer per la prima offerta se non era già attivo
            state.expiresAt = now + (state.setting.timerDuration * 1000);
          } else {
            const remainingSec = (state.expiresAt - now) / 1000;
            const threshold = state.setting.extendThreshold || 10;
            const extSec = state.setting.extendSeconds || 10;

            // Se il tempo rimanente è minore o uguale alla soglia (es. <= 10 secondi)
            if (remainingSec <= threshold) {
              if (state.setting.extendMode === 'add') {
                // Modalità 'add': Aggiunge X secondi al tempo residuo
                state.expiresAt = state.expiresAt + (extSec * 1000);
              } else {
                // Modalità predefinita 'set': Ripristina il timer ad almeno extSec secondi
                state.expiresAt = Math.max(state.expiresAt, now + (extSec * 1000));
              }
            }
            // NOTA: Se mancano più di threshold secondi (es. 40s), l'asta NON viene allungata inutilmente!
          }
          armClose();
        }

        broadcast();
        return sendJson(res, 200, { ok: true, value: state.value, winner: state.winner });
      }

      /* === ADMIN: LOGIN === */
      if (url === '/api/admin/login') {
        const pass = String(body.passcode || '').trim();
        if (pass === String(state.setting.passcode).trim()) {
          const t = crypto.randomBytes(16).toString('hex');
          adminTokens.add(t);
          return sendJson(res, 200, { ok: true, adminToken: t });
        }
        return sendJson(res, 401, { ok: false, error: 'Passcode errato' });
      }

      /* === ADMIN: AZIONI PROTETTE === */
      if (url === '/api/admin') {
        const token = String(body.adminToken || '');
        if (!adminTokens.has(token)) {
          return sendJson(res, 401, { ok: false, error: 'Sessione amministratore scaduta o non autorizzata' });
        }
        const action = String(body.action || '');
        const payload = body.payload || {};

        /* --- 1. Modifica diretta del giocatore in asta --- */
        if (action === 'editCurrent') {
          if (!state.current) {
            return sendJson(res, 400, { ok: false, error: 'Nessun giocatore attualmente in asta da modificare' });
          }
          if (payload.name) {
            state.current.name = cleanName(payload.name);
          }
          if (payload.base !== undefined && Number.isFinite(Number(payload.base))) {
            state.current.base = Math.max(0, Math.round(Number(payload.base)));
          }
          if (payload.value !== undefined && Number.isFinite(Number(payload.value))) {
            state.value = Math.max(0, Math.round(Number(payload.value)));
          }
          if (payload.winner !== undefined) {
            state.winner = payload.winner ? cleanName(payload.winner) : null;
          }
          broadcast();
          return sendJson(res, 200, { ok: true, current: state.current, value: state.value, winner: state.winner });
        }

        /* --- 2. Lancia giocatore personalizzato al volo --- */
        if (action === 'startCustom') {
          const name = cleanName(payload.name);
          if (!name) return sendJson(res, 400, { ok: false, error: 'Inserisci il nome del giocatore' });
          let base = Number(payload.base);
          if (!Number.isFinite(base) || base < 0) base = state.setting.baseDefault;
          const ok = startPlayerAuction({ id: uid(), name, base: Math.round(base) });
          return sendJson(res, ok ? 200 : 400, { ok });
        }

        /* --- 3. Controllo Timer in tempo reale --- */
        if (action === 'adjustTimer') {
          if (!state.current) return sendJson(res, 400, { ok: false, error: 'Nessuna asta in corso' });
          const now = Date.now();

          // Pausa / Riprendi
          if (typeof payload.pause === 'boolean') {
            if (payload.pause && !state.isPaused) {
              if (state.expiresAt && state.expiresAt > now) {
                state.pausedRemaining = Math.max(0, state.expiresAt - now);
              }
              state.isPaused = true;
              state.expiresAt = 0;
              clearClose();
            } else if (!payload.pause && state.isPaused) {
              state.isPaused = false;
              if (state.pausedRemaining > 0) {
                state.expiresAt = now + state.pausedRemaining;
                state.pausedRemaining = 0;
                armClose();
              }
            }
          }

          // Aggiungi o togli secondi (+5s, +10s, -5s)
          if (Number.isFinite(Number(payload.addSeconds))) {
            const addMs = Number(payload.addSeconds) * 1000;
            if (state.isPaused) {
              state.pausedRemaining = Math.max(1000, state.pausedRemaining + addMs);
            } else {
              const currentExp = state.expiresAt && state.expiresAt > now ? state.expiresAt : now;
              state.expiresAt = Math.max(now + 1000, currentExp + addMs);
              armClose();
            }
          }

          // Riavvia timer
          if (payload.restart) {
            state.isPaused = false;
            state.pausedRemaining = 0;
            state.expiresAt = now + ((state.setting.timerDuration || 30) * 1000);
            armClose();
          }

          broadcast();
          return sendJson(res, 200, { ok: true, expiresAt: state.expiresAt, isPaused: state.isPaused });
        }

        /* --- 4. Impostazioni Asta e Regole Timer --- */
        if (action === 'settings') {
          if (Number.isFinite(Number(payload.increment))) {
            state.setting.increment = Math.max(1, Math.min(1000, Math.round(Number(payload.increment))));
          }
          if (Number.isFinite(Number(payload.timerDuration))) {
            state.setting.timerDuration = Math.max(0, Math.min(300, Math.round(Number(payload.timerDuration))));
          }
          if (Number.isFinite(Number(payload.extendThreshold))) {
            state.setting.extendThreshold = Math.max(1, Math.min(120, Math.round(Number(payload.extendThreshold))));
          }
          if (Number.isFinite(Number(payload.extendSeconds))) {
            state.setting.extendSeconds = Math.max(1, Math.min(120, Math.round(Number(payload.extendSeconds))));
          }
          if (payload.extendMode === 'set' || payload.extendMode === 'add') {
            state.setting.extendMode = payload.extendMode;
          }
          if (Number.isFinite(Number(payload.baseDefault))) {
            state.setting.baseDefault = Math.max(0, Math.min(10000, Math.round(Number(payload.baseDefault))));
          }
          if (typeof payload.startTimerOnOpen === 'boolean') {
            state.setting.startTimerOnOpen = payload.startTimerOnOpen;
          }
          if (typeof payload.autoNext === 'boolean') {
            state.setting.autoNext = payload.autoNext;
          }
          if (Number.isFinite(Number(payload.autoNextDelay))) {
            state.setting.autoNextDelay = Math.max(1, Math.min(30, Math.round(Number(payload.autoNextDelay))));
          }
          if (typeof payload.passcode === 'string' && payload.passcode.trim()) {
            state.setting.passcode = payload.passcode.trim().slice(0, 50);
          }

          broadcast();
          return sendJson(res, 200, { ok: true, setting: state.setting });
        }

        /* --- 5. Carica o sovrascrivi intera lista --- */
        if (action === 'queue') {
          const list = Array.isArray(payload.list) ? payload.list.slice(0, 500) : [];
          state.queue = list.map(it => {
            const name = cleanName(it && it.name);
            if (!name) return null;
            let base = Number(it.base);
            if (!Number.isFinite(base) || base < 0) base = state.setting.baseDefault;
            return { id: it.id || uid(), name, base: Math.round(base) };
          }).filter(Boolean);
          clearBoth();
          broadcast();
          return sendJson(res, 200, { ok: true, count: state.queue.length });
        }

        /* --- 6. Aggiungi singolo giocatore alla coda --- */
        if (action === 'queueAdd') {
          const name = cleanName(payload.name);
          if (!name) return sendJson(res, 400, { ok: false, error: 'Nome giocatore richiesto' });
          let base = Number(payload.base);
          if (!Number.isFinite(base) || base < 0) base = state.setting.baseDefault;
          state.queue.push({ id: uid(), name, base: Math.round(base) });
          broadcast();
          return sendJson(res, 200, { ok: true, count: state.queue.length });
        }

        /* --- 7. Rimuovi giocatore dalla coda --- */
        if (action === 'queueRemove') {
          const idx = Number(payload.index);
          if (idx >= 0 && idx < state.queue.length) {
            state.queue.splice(idx, 1);
            broadcast();
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 400, { ok: false, error: 'Indice non valido' });
        }

        /* --- 8. Sposta giocatore nella coda --- */
        if (action === 'queueMove') {
          const from = Number(payload.fromIndex);
          const to = Number(payload.toIndex);
          if (from >= 0 && from < state.queue.length && to >= 0 && to < state.queue.length) {
            const [item] = state.queue.splice(from, 1);
            state.queue.splice(to, 0, item);
            broadcast();
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 400, { ok: false, error: 'Indici non validi' });
        }

        /* --- 9. Avvia un giocatore specifico della coda --- */
        if (action === 'queueStart') {
          const idx = Number(payload.index);
          if (idx >= 0 && idx < state.queue.length) {
            const [item] = state.queue.splice(idx, 1);
            startPlayerAuction(item);
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 400, { ok: false, error: 'Giocatore non trovato nella lista' });
        }

        /* --- 10. Prossimo giocatore dalla coda --- */
        if (action === 'startNext') {
          const ok = startNext();
          return sendJson(res, ok ? 200 : 400, {
            ok,
            error: ok ? '' : 'Asta già in corso o nessun giocatore in lista'
          });
        }

        /* --- 11. Aggiudica / Svenduto --- */
        if (action === 'award') {
          if (!state.current) {
            return sendJson(res, 400, { ok: false, error: 'Nessuna asta in corso da aggiudicare' });
          }
          if (payload.none) {
            state.winner = null;
          }
          award();
          return sendJson(res, 200, { ok: true });
        }

        /* --- 12. Annulla/Elimina assegnazione dallo storico --- */
        if (action === 'historyDelete') {
          const idx = Number(payload.index);
          if (idx >= 0 && idx < state.history.length) {
            const rec = state.history[idx];
            if (rec.winner) {
              const p = getParticipant(rec.winner);
              if (p && p.roster && rec.player in p.roster) {
                delete p.roster[rec.player];
                p.spent = Math.max(0, (p.spent || 0) - (rec.value || 0));
              }
            }
            state.history.splice(idx, 1);
            broadcast();
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 400, { ok: false, error: 'Elemento storico non trovato' });
        }

        /* --- 13. Concludi asta --- */
        if (action === 'finish') {
          if (state.current) award();
          clearBoth();
          state.current = null;
          state.winner = null;
          state.value = 0;
          state.expiresAt = 0;
          state.isPaused = false;
          state.phase = 'finished';
          broadcast();
          return sendJson(res, 200, { ok: true });
        }

        /* --- 14. Reset totale --- */
        if (action === 'reset') {
          const keepSettings = state.setting;
          state = freshState();
          state.setting = keepSettings;
          try {
            if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
          } catch (e) {}
          broadcast();
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 400, { ok: false, error: 'Azione non riconosciuta' });
      }

      sendJson(res, 404, { ok: false, error: 'Endpoint non trovato' });
    } catch (e) {
      console.error('API Error:', e);
      sendJson(res, 500, { ok: false, error: 'Errore interno server: ' + e.message });
    }
  });
}

/* ---------------- Creazione Server HTTP ---------------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // SSE Stream
  if (req.method === 'GET' && url === '/events') {
    return sse(req, res);
  }
  // API State
  if (req.method === 'GET' && url === '/api/state') {
    return sendJson(res, 200, publicState());
  }
  // API POST
  if (req.method === 'POST') {
    return handlePost(req, res, url);
  }
  // File Statici
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Non trovato');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ Asta Fantacalcio avviata con successo su http://0.0.0.0:${PORT}`);
  console.log(`🔧 Pannello Admin: Passcode predefinita: "${state.setting.passcode}"`);
});
