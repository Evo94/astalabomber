# ⚽ Asta Fantacalcio — Piattaforma Aste in Tempo Reale

Applicazione web in tempo reale per gestire le aste del Fantacalcio con i tuoi amici: ognuno si connette dal proprio smartphone o computer, inserisce il proprio nome e rilancia con un solo tocco sul grande pulsante.

Tutti i rilanci, il timer e i dati sono **sincronizzati istantaneamente** su tutti i dispositivi grazie a Server-Sent Events (SSE).

---

## 🚀 Guida Completa: Come Pubblicare il Sito Gratis su Render.com

Render permette di pubblicare il sito online con un indirizzo web pubblico protetto da HTTPS (es. `https://mia-asta-fantacalcio.onrender.com`), accessibile da qualsiasi telefono senza dover aprire porte sul router o configurare indirizzi IP locali.

### Passo 1: Carica il Progetto su GitHub
1. Crea un nuovo repository su [GitHub.com](https://github.com) (pubblico o privato).
2. Carica i file del progetto sul repository:
   ```bash
   git add .
   git commit -m "Asta Fantacalcio pronta per il deploy"
   git push origin main
   ```

### Passo 2: Crea l'Account su Render
1. Vai su [render.com](https://render.com) e registrati (puoi accedere direttamente con il tuo account GitHub).

### Passo 3: Crea il Web Service
1. Dalla dashboard di Render, clicca sul pulsante **"New +"** in alto a destra e seleziona **"Web Service"**.
2. Seleziona **"Build and deploy from a Git repository"** e scegli il tuo repository di GitHub `astalabomber`.
3. Compila le impostazioni di base:
   - **Name**: `asta-fantacalcio` (o qualsiasi nome desideri; farà parte del link pubblico).
   - **Region**: `Frankfurt (EU)` (consigliata per la minima latenza dall'Italia).
   - **Branch**: `main` (o il branch in cui hai fatto il push).
   - **Runtime**: `Node`.
   - **Build Command**: lascia vuoto oppure inserisci `npm install` (non ci sono dipendenze esterne!).
   - **Start Command**: `node server.js` oppure `npm start`.
   - **Instance Type**: seleziona **Free** (gratuito).

### Passo 4: Variabili d'Ambiente (Opzionale ma consigliato)
Nella sezione **Environment Variables**:
- `ADMIN_PASSCODE`: inserisci la password segreta per l'astatore (es. `fantapass2026`). Se non specificata, la password predefinita sarà `admin`.
- `PORT`: impostata automaticamente da Render (il server ascolta su `process.env.PORT`).

### Passo 5: Deploy e Condivisione
1. Clicca su **"Create Web Service"**.
2. In meno di un minuto, Render completerà la pubblicazione e mostrerà il link pubblico in alto (es. `https://asta-fantacalcio.onrender.com`).
3. Condividi il link nel gruppo WhatsApp/Telegram della tua lega: tutti gli amici potranno entrare dal proprio telefono!

> 💡 **Nota sul piano Free di Render**: I server gratuiti vanno in "standby" (sleep) dopo 15 minuti di inattività. Quando aprite il link per la prima volta prima dell'asta, basterà attendere 30-40 secondi per il risveglio del server. Durante tutta la durata dell'asta rimarrà attivo e reattivo al 100%.

---

## 🛠️ Modalità Astatore (Admin)

L'accesso al pannello di controllo è protetto da passcode ed è accessibile cliccando su **"🔧 Astatore"** in alto a destra (passcode default: **`admin`**).

### 🎯 1. Modifica del Giocatore in Asta in Tempo Reale
L'amministratore può in qualsiasi momento:
- **Modificare il nome del giocatore corrente** direttamente dal form senza interrompere l'asta.
- **Cambiare il prezzo base** o correggere il valore attuale offerto.
- **Cambiare l'offerente in testa** se necessario.

### ⏱️ 2. Gestione Avanzata dei Tempi & Anti-Sniping (Estensione Rilanci)
Puoi personalizzare ogni singolo parametro del timer:
- **Durata Timer Asta (es. 30s)**: il countdown iniziale assegnato a ciascun giocatore (imposta `0` per gestire i tempi solo manualmente).
- **Soglia di Estensione (es. 10s)**: i rilanci **NON allungano il timer se mancano molti secondi** (es. se mancano 35s, un rilancio lascia il tempo inalterato a 35s). L'allungamento scatta **solo da questo valore in giù** (es. dai 10 secondi in giù).
- **Tempo Esteso per Rilancio (es. 10s)**: di quanto allungare o a quanto riportare il timer ad ogni rilancio effettuato sotto la soglia.
- **Modalità Estensione**:
  - *Riporta a X secondi* (consigliato): se mancano 3s e la soglia è 10s, il timer ritorna a 10s.
  - *Aggiungi +X secondi*: somma i secondi al tempo rimanente.
- **Avvio Countdown**: decidi se il timer deve partire subito all'apertura del giocatore o solo alla prima offerta.
- **Controlli Real-Time Live**:
  - ⏸️ **Pausa / Riprendi**
  - 🔄 **Riavvia Timer**
  - ➕ **+5s / +10s / -5s**

### ⚡ 3. Lancia Giocatore Rapido
Permette di inserire al volo `Nome` e `Base (€)` e avviare immediatamente l'asta per quel calciatore, senza dover preparare o caricare in anticipo una lista.

### 📋 4. Gestione Lista & Coda Giocatori
- Incolla una lista massiva (supporta `Nome, Base` oppure `Nome Base` oppure `Nome`).
- Dalla tabella interattiva puoi:
  - ▶️ Mettere subito in asta un giocatore specifico
  - ⬆️ / ⬇️ Spostare su e giù l'ordine della lista
  - 🗑️ Rimuovere singoli giocatori

### 📜 5. Storico & Rimborso Assegnazioni
- Elenco completo di tutti i giocatori aggiudicati con prezzo e vincitore.
- Se viene commesso un errore, l'amministratore può annullare la vendita: il calciatore viene rimosso dalla rosa del vincitore e i crediti spesi vengono automaticamente riaccreditati!

---

## 👤 Modalità Partecipante

1. Apri il link dal telefono o dal PC.
2. Inserisci il tuo nome (es. *Marco*) ed entra in sala.
3. Quando l'astatore apre un giocatore, premi il **grande pulsante verde** per rilanciare.
4. Se sei il migliore offerente, il pulsante diventa dorato (**"SEI IN TESTA! 🏆"**).
5. Tocca qualsiasi partecipante per visualizzare la sua rosa aggiornata e il totale crediti spesi.
6. Il tuo accesso rimane salvato nel browser anche se ricarichi la pagina o perdi temporaneamente la connessione.

---

## 💻 Avvio Locale

Se preferisci avviare il server in locale sul tuo PC:

```bash
# Avvio standard (porta 3000)
node server.js

# Oppure con porta e password personalizzate
PORT=8080 ADMIN_PASSCODE=segreto node server.js
```

Poi apri nel browser: `http://localhost:3000`.
