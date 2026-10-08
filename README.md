# Momentus System – mobilapp + API

Mobilappen (en webbapp som läggs på hemskärmen) och ett litet HTTP-API i
samma paket. API:t använder **samma PostgreSQL-databas** och **samma
affärslogik** (`db.py`, `lager_export.py`) som skrivbordsprogrammet.
Skrivbordsprogrammet behöver inte ändras.

```
iPhone/Android  ──HTTPS──▶  Momentus (FastAPI: /api + web/)  ──▶  PostgreSQL  ◀──  Skrivbordsprogram
```

## Mobilappen (`web/`)

Öppna serverns adress i Safari på iPhone (t.ex. `https://momentus.example.com`),
logga in, tryck på **Dela** → **Lägg till på hemskärmen**. Därefter startar
Momentus från sin egen ikon i helskärm, utan webbläsarkanter. På Android:
webbläsarmenyn → **Lägg till på startskärmen**.

Fyra flikar: **Lager** (sök, filter, gruppering, lagervärde, +1/−1),
**Scanna** (kamera, sök/inleverans/uttag, ångra), **Artikelnr** (generator
och senaste nummer) och **Mer** (alla händelser, dubbletter, export,
språk, utloggning). Artikelsidan har saldo in/ut, markera inventerad,
historik, händelser, redigera och ta bort. Språk: svenska/engelska, byts i appen.

Alla texter ligger i `web/i18n.js`, en rad per text med svenska och engelska
bredvid varandra. Uppdatera appen = ladda upp nya filer i `web/`; alla
telefoner får den nya versionen nästa gång de öppnar appen.

Streckkodsläsaren använder ett litet bibliotek (`@zxing/library`) som laddas
från unpkg.com. Vill du slippa det beroendet: ladda ned
`https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js` till `web/zxing.min.js`
och ändra `<script src=...>` i `web/index.html` till `zxing.min.js`.

## Innehåll

| Fil | Vad |
|---|---|
| `main.py` | FastAPI-appen, alla endpoints under `/api`, serverar `web/` på `/` |
| `web/` | Mobilappen: `index.html`, `app.js`, `app.css`, `i18n.js`, `sw.js`, ikoner |
| `services.py` | Affärslogiken – speglar `ui_lager.py` / `ui_artikelnummer.py` / `ui_export.py` |
| `auth.py` | Inloggning, sessioner, lösenordshashning |
| `schemas.py` | In/ut-modeller (JSON) |
| `constants.py` | Kategorier, märken, valutor, kolumner – samma som skrivbordet |
| `manage_users.py` | Skapa/lista/inaktivera användare |
| `db.py`, `lager_export.py` | Oförändrade kopior från skrivbordsprogrammet |

Ändras `db.py` eller `lager_export.py` i skrivbordsprogrammet: kopiera hit igen.

## Komma igång (lokalt)

```bash
cd momentus_api
python -m venv .venv
.venv\Scripts\activate          # Windows   (source .venv/bin/activate på Mac/Linux)
pip install -r requirements.txt
copy .env.example .env          # fyll i DATABASE_URL
python manage_users.py add anna --name "Anna"
uvicorn main:app --host 0.0.0.0 --port 8000
```

Öppna `http://localhost:8000/` – mobilappen. `http://localhost:8000/docs` visar
API-dokumentationen där du kan prova varje endpoint (klicka **Authorize** och
klistra in token från `/api/auth/login`).

Testa på telefonen i samma wifi: `http://<datorns-ip>:8000/`. Kameran kräver
dock HTTPS (eller localhost), så streckkodsläsaren fungerar först när API:t
ligger bakom en riktig HTTPS-adress.

Vid start körs `db.ensure_schema` (samma som skrivbordet) plus två nya
tabeller: `app_users` och `app_sessions`. Inget annat i databasen rörs.

## Hosting

API:t måste nås från telefonen över internet, via HTTPS. Enklaste vägarna:

- **Railway / Render / Fly.io** – peka på mappen, `Dockerfile` finns. Sätt
  `DATABASE_URL` som miljövariabel i tjänsten. Du får en `https://...`-adress
  direkt.
- **Egen server (Hetzner, VPS)** – `docker build -t momentus-api . && docker run -p 8000:8000 --env-file .env momentus-api`
  bakom Caddy eller nginx för HTTPS.
- **Lokal PC i kontoret** – kör `uvicorn` som ovan och exponera den med
  Cloudflare Tunnel eller Tailscale. Fungerar men PC:n måste vara på.

Databasen behöver *inte* vara nåbar från internet – bara API:t. Ligger
databasen på samma ställe som API:t räcker det.

## Två lager

Appen har två lager, samma som skrivbordsprogrammet: **Lager** (nya, förvalt)
och **Gamla lagret**. Man växlar överst på flikarna Lager, Scanna och Mer.
Varje lager har egna tabeller (se `WAREHOUSES` i `db.py`).

Alla endpoints som rör artiklar, scan, historik, dubbletter, export och
generering av artikelnummer tar `?warehouse=lager` eller `?warehouse=legacy`.
Utelämnas parametern gäller gamla lagret. `GET /meta` listar lagren och
leverantörskoderna. I nya lagret genereras artikelnummer per leverantör med M
framför, t.ex. `M5-02-SMP-000001` (`supplier` i anropet, tomt = den första).

## Endpoints

Alla ligger under `/api`. Alla utom `/api/health` och `/api/auth/login`
kräver `Authorization: Bearer <token>`.

**Auth**
- `POST /auth/login` `{username, password, device_name?}` → `{token, user}`
- `POST /auth/logout`, `GET /auth/me`

**Meta** (listor appen behöver för formulär)
- `GET /meta` → huvudkategorier, underkategorier, märken, märkeskoder, valutor, kolumner

**Artiklar**
- `GET /items?search=&main_category=&vehicle_brand=&shelf_location=&sort=&desc=` → `{items, summary}`
  – `summary` är lagervärdet per valuta, samma som raden längst ner i Lager
- `GET /items/{id}`, `GET /items/by-barcode/{barcode}`
- `POST /items` – skapa. `PUT /items/{id}` – uppdatera (skicka `expected_updated_at`
  från senaste läsning; 409 om någon annan hunnit ändra). `DELETE /items/{id}`
- `POST /items/{id}/inventoried?day=2026-09-14` – "Markera som inventerad"
- `GET /items/{id}/history` – ändringshistorik. `DELETE /history/{id}`
- `GET /items/{id}/transactions` – in/ut-händelser

**Scan / saldo**
- `POST /scan` `{barcode, mode: "lookup"|"in"|"out", qty}` → `{item, transaction, message}`
- `POST /items/{id}/adjust` `{delta, note?}` – +/– utan streckkod
- `POST /transactions/{tx_id}/undo` – ångra senaste in/ut (samma spärrar som skrivbordet)
- `GET /transactions?limit=` – senaste händelserna i hela lagret

**Artikelnummer**
- `POST /article-numbers/generate` `{k, uu, vehicle_brands[], multifit, item_id?|org_article_no?, overwrite}`
- `GET /article-numbers?search=&limit=` – senast genererade. `DELETE /article-numbers/{nr}`

**Övrigt**
- `GET /duplicates` – dubbletter på org-nummer, artikelnummer och streckkod
- `GET /views`, `PUT /views/{name}`, `DELETE /views/{name}` – sparade vyer (delas med skrivbordet)
- `POST /export` `{format: xlsx|csv|pdf|docx, columns[], search, ...}` → fil. Samma
  utseende som skrivbordets export; appen visar den i delningsmenyn.

Felmeddelanden kommer som `{"detail": "..."}` med samma svenska texter som
skrivbordsprogrammet, så appen kan visa dem rakt av.

## Säkerhet

- Databaslösenordet finns bara på servern, aldrig i appen.
- Lösenord hashas med scrypt. Sessioner går ut efter `SESSION_DAYS` utan aktivitet.
- Inaktivera en användare: `python manage_users.py disable anna` – loggar ut alla enheter.
- Kör alltid bakom HTTPS.
