# ⚽ Asta Fantacalcio — sito per le aste in tempo reale

Mini-sito per gestire le aste del fantacalcio con gli amici: ognuno apre il link
dal proprio telefono, inserisce il **nome**, e punta premendo un **grande pulsante**.
Tutto è sincronizzato in tempo reale su tutti i dispositivi.

## Come funziona

- **Pannello centrale** → mostra il giocatore in corso e il **valore attuale dell'asta** (euro, aggiornato in tempo reale).
- **Tasto gigante "PUNTA €…"** → il partecipante rilancia con un tocco.
- **Timer** → dopo l'ultima offerta l'asta si chiude automaticamente (configurabile), il giocatore viene aggiudicato e parte il successivo.
- **Aggiudicazioni** → storico dei giocatori venduti, spesa di ogni partecipante e classifica finale.

## Avvio

```bash
cd asta
node server.js          # oppure: PORT=8080 node server.js
```

Poi apri `http://localhost:3000` (o l'IP del computer sulla rete locale, es. `http://192.168.1.10:3000`,
per farlo usare anche dagli amici nella stessa Wi-Fi).

> ⚠️ Nota per l'uso da telefonino: apri la porta 3000 nel firewall del computer
> e usa l'indirizzo IP locale del PC (trovi l'IP con `ipconfig` su Windows o `ip a` su Linux/Mac).

## Ruoli

### 👤 Partecipante
1. Apre il sito → inserisce il nome → **ENTRA IN ASTA**.
2. Quando l'astatore apre un giocatore, premi il pulsante verde gigante per puntare.
3. Se sei in testa, il pulsante diventa dorato ("SEI IN TESTA! 🏆") e il timer conta alla rovescia.
4. Il nome resta salvato nel browser: ricaricando la pagina la sessione riprende da sola.

### 🛠️ Astatore (pannello)
Clicca su **"🔧 Astatore"** in alto a destra → passcode default: **`admin`**.

- **📥 Carica lista**: un giocatore per riga, base opzionale con la virgola:
  ```
  Vlahovic, 15
  Lautaro
  Calhanoglu, 8
  ```
- **▶ Prossimo** — apre l'asta del giocatore successivo (si può anche alla prima: alla lista carica parte da sola).
- **🏅 Aggiudica a [nome]** — assegna il giocatore al migliore offerente (o "🙅 Svenduto" se nessuno ha puntato).
- **⏹ Chiudi subito** — chiude l'asta in anticipo assegnando al migliore offerente.
- **⚙️ Impostazioni**: rilancio (€), autoscatto (secondi; 0 = manuale), base di default, avvio automatico del prossimo. Passcode modificabile da qui (campo `passcode`).

## File

| File | Descrizione |
|---|---|
| `server.js` | Server HTTP + API + realtime (zero dipendenze, solo Node.js) |
| `public/index.html` | Interfaccia completa (CSS e JS inclusi) |
| `state.json` | Stato salvato automaticamente (partecipanti, lista, storico) — cancellalo per ripartire da zero |

## Note tecniche

- Real-time tramite **Server-Sent Events** (`/events`), aggiornamento istantaneo su tutti i dispositivi.
- Lo stato sopravvive ai riavvii del server (salvataggio su `state.json`).
- Ogni partecipante ha un token salvato in `localStorage` per riconnettersi senza re-inserire il nome.
- Il pannello astatore è protetto da passcode (modificabile in `⚙️ Impostazioni` → campo passcode).
