#!/usr/bin/env node
/* ============================================================
   ⚽ ASTA FANTACALCIO — server in tempo reale (zero dipendenze)
   Avvio:  node server.js          (porta 3000 di default)
   La porta si cambia con:  PORT=8080 node server.js
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
  '.json': 'application/json',
};

/* ---------------- stato ---------------- */
function freshState() {
  return {
    phase: 'lobby',            // 'lobby' | 'auction' | 'finished'
    queue: [],                 // [{name, base}] giocatori in lista
    current: null,             // {name, base} giocatore in asta
    value: 0,                  // valore attuale
    winner: null,              // nome del migliore offerente
    lastBidAt: 0,              // timestamp ultima offerta (per il countdown)
    participants: {},          // nome(minuscolo) -> {name, token, spent, roster, lastBidAt}
    tokens: {},                // token -> nome
    setting: {
      increment: 1,            // passo di rilancio
      autoClose: 4,            // secondi dall'ultima offerta (0 = manuale)
      autoNext: true,          // avvio automatico del prossimo giocatore
      baseDefault: 10,         // base usata se non indicata
      passcode: 'admin',       // passcode del pannello astatore
    },
    history: [],               // {player, winner, value, at}
  };
}

let state = freshState();
try {
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const saved = JSON.parse(raw);
  if (saved && saved.setting) state = Object.assign(freshState(), saved);
} catch (e) { /* primo avvio */ }

/* ---------------- helpers ---------------- */
const sseClients = new Set();
const adminTokens = new Set();
let closeTimer = null, nextTimer = null;

function clearClose() { clearTimeout(closeTimer); closeTimer = null; }
function clearBoth() { clearTimeout(closeTimer); clearTimeout(nextTimer); closeTimer = nextTimer = null; }

function scheduleSave() {
  clearTimeout(state._saveT);
  state._saveT = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
  }, 400);
}

function cleanName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
function validName(name) {
  return /^[\p{L}\p{N} .'\-]+$/u.test(name);
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
    lastBidAt: state.lastBidAt,
    increment: state.setting.increment,
    autoClose: state.setting.autoClose,
    autoNext: state.setting.autoNext,
    baseDefault: state.setting.baseDefault,
    queue: state.queue,
    history: state.history.slice(-80),
    participants: Object.keys(state.participants).map(k => ({
      name: state.participants[k].name,
      spent: state.participants[k].spent,
      roster: state.participants[k].roster,
    })),
  };
}

function broadcast() {
  const msg = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  }
  scheduleSave();
}

/* ---------------- logica asta ---------------- */
function startNext() {
  clearBoth();
  if (state.current) return false;
  if (!state.queue.length) {
    if (state.phase !== 'finished') { state.phase = 'finished'; broadcast(); }
    return false;
  }
  const p = state.queue.shift();
  state.current = { name: p.name, base: p.base };
  state.value = p.base;
  state.winner = null;
  state.lastBidAt = 0;
  state.phase = 'auction';
  broadcast();
  return true;
}

function award() {
  clearBoth();
  if (!state.current) return;
  const rec = { player: state.current.name, winner: state.winner, value: state.value, at: Date.now() };
  if (state.winner) {
    const p = getParticipant(state.winner);
    if (p) {
      if (!(rec.player in p.roster)) {
        p.roster[rec.player] = rec.value;
        p.spent += rec.value;
      }
    }
  }
  state.history.push(rec);
  state.current = null;
  state.winner = null;
  state.value = 0;
  state.lastBidAt = 0;
  if (state.queue.length) {
    state.phase = 'auction';
    broadcast();
    if (state.setting.autoNext) {
      nextTimer = setTimeout(() => { nextTimer = null; startNext(); }, 2200);
    }
  } else {
    state.phase = 'finished';
    broadcast();
  }
}

function armClose() {
  clearClose();
  if (!state.current || !state.setting.autoClose || !state.lastBidAt) return;
  const remaining = state.lastBidAt + state.setting.autoClose * 1000 - Date.now();
  closeTimer = setTimeout(() => { closeTimer = null; award(); }, Math.max(remaining, 100));
}

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => {
    b += c;
    if (b.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try { cb(JSON.parse(b || '{}')); } catch (e) { cb({}); }
  });
  req.on('error', () => cb({}));
}

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p.replace(/^\/+/, '')));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (e) { clearInterval(hb); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
}

function handlePost(req, res, url) {
  readBody(req, body => {
    try {
      /* --- partecipante: entra --- */
      if (url === '/api/join') {
        const name = cleanName(body.name);
        if (!name) return sendJson(res, 400, { ok: false, error: 'Inserisci un nome' });
        if (!validName(name)) return sendJson(res, 400, { ok: false, error: 'Nome non valido' });
        const token = String(body.token || '');
        if (token && state.tokens[token]) {
          const existing = state.tokens[token];
          return sendJson(res, 200, { ok: true, name: existing, token });
        }
        const key = name.toLowerCase();
        if (state.participants[key]) {
          return sendJson(res, 409, { ok: false, error: 'Nome già in uso, scegline un altro' });
        }
        const newToken = crypto.randomBytes(12).toString('hex');
        state.tokens[newToken] = name;
        state.participants[key] = { name, token: newToken, spent: 0, roster: {}, lastBidAt: 0 };
        broadcast();
        return sendJson(res, 200, { ok: true, name, token: newToken });
      }

      /* --- partecipante: rilancio --- */
      if (url === '/api/bid') {
        const name = state.tokens[String(body.token || '')];
        if (!name) return sendJson(res, 401, { ok: false, error: 'Non sei registrato' });
        const p = getParticipant(name);
        if (state.phase !== 'auction' || !state.current) {
          return sendJson(res, 400, { ok: false, error: 'Nessuna asta in corso' });
        }
        if (state.winner === name) {
          return sendJson(res, 400, { ok: false, error: 'Sei già in testa 🏆' });
        }
        const now = Date.now();
        if (p.lastBidAt && now - p.lastBidAt < 400) {
          return sendJson(res, 400, { ok: false, error: 'Calma, un attimo…' });
        }
        p.lastBidAt = now;
        state.value = state.winner ? state.value + state.setting.increment : state.current.base;
        state.winner = name;
        state.lastBidAt = now;
        armClose();
        broadcast();
        return sendJson(res, 200, { ok: true, value: state.value });
      }

      /* --- admin: login --- */
      if (url === '/api/admin/login') {
        if (String(body.passcode || '') === String(state.setting.passcode)) {
          const t = crypto.randomBytes(16).toString('hex');
          adminTokens.add(t);
          return sendJson(res, 200, { ok: true, adminToken: t });
        }
        return sendJson(res, 401, { ok: false, error: 'Passcode errato' });
      }

      /* --- admin: azioni --- */
      if (url === '/api/admin') {
        if (!adminTokens.has(String(body.adminToken || ''))) {
          return sendJson(res, 401, { ok: false, error: 'Sessione admin scaduta' });
        }
        const action = String(body.action || '');
        const payload = body.payload || {};

        if (action === 'queue') {
          const list = Array.isArray(payload.list) ? payload.list.slice(0, 300) : [];
          state.queue = list.map(it => {
            const name = cleanName(it && it.name);
            if (!name) return null;
            let base = Number(it.base);
            if (!Number.isFinite(base)) base = state.setting.baseDefault;
            return { name, base: Math.max(0, Math.min(9999, Math.round(base))) };
          }).filter(Boolean);
          clearBoth();
          broadcast();
          return sendJson(res, 200, { ok: true, count: state.queue.length });
        }

        if (action === 'startNext') {
          const ok = startNext();
          return sendJson(res, ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: ok ? '' : 'Asta già in corso o lista vuota' });
        }

        if (action === 'award') {
          if (!state.current) return sendJson(res, 400, { ok: false, error: 'Nessuna asta in corso' });
          if (payload.none) state.winner = null;
          award();
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'settings') {
          if (Number.isFinite(Number(payload.increment))) state.setting.increment = Math.max(1, Math.min(500, Math.round(Number(payload.increment))));
          if (Number.isFinite(Number(payload.autoClose))) state.setting.autoClose = Math.max(0, Math.min(60, Number(payload.autoClose)));
          if (Number.isFinite(Number(payload.baseDefault))) state.setting.baseDefault = Math.max(0, Math.min(5000, Math.round(Number(payload.baseDefault))));
          if (typeof payload.autoNext === 'boolean') state.setting.autoNext = payload.autoNext;
          if (typeof payload.passcode === 'string' && payload.passcode.trim()) state.setting.passcode = payload.passcode.trim().slice(0, 40);
          armClose();
          broadcast();
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'finish') {
          if (state.current) award();
          clearBoth();
          state.current = null; state.winner = null; state.value = 0; state.lastBidAt = 0;
          state.phase = 'finished';
          broadcast();
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'reset') {
          const keep = state.setting;
          state = freshState();
          state.setting = keep;
          try { fs.unlinkSync(STATE_FILE); } catch (e) {}
          broadcast();
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 400, { ok: false, error: 'Azione sconosciuta' });
      }

      sendJson(res, 404, { ok: false, error: 'Rotta non trovata' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'Errore interno: ' + e.message });
    }
  });
}

/* ---------------- server ---------------- */
if (state.current && state.lastBidAt) armClose();    // riprende il timer dopo un riavvio

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/events') return sse(req, res);
  if (req.method === 'GET' && url === '/api/state') return sendJson(res, 200, publicState());
  if (req.method === 'POST') return handlePost(req, res, url);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ Asta Fantacalcio in ascolto su http://0.0.0.0:${PORT}`);
});
