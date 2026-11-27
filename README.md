# Gamebook Realm

Platforma pro tvorbu a hraní interaktivních příběhů (gamebooků). Autoři vytvářejí příběhy ze scén s větvením, čtenáři je hrají a ohodnocují.

Projekt je ve vývoji. Backend tvoří gateway a čtyři služby (story, gameplay, discovery, audit), data se ukládají do MongoDB.

## Struktura

- `server/` backend (Node.js, Express)
- `client/` frontend (React, Vite)

## Spuštění

Potřeba Node.js 22.12+.

```bash
npm run install:all
npm run dev:server   # http://localhost:3001
npm run dev:client   # http://localhost:5173
npm test
npm run build        # client/dist
```

Produkční nasazení zatím není vyřešené, server soubory z `client/dist` nevrací.

Pro změnu nastavení zkopíruj `.env.example` na `.env` v dané složce. Endpointy, které vyžadují přihlášení, fungují jen s nastaveným `SESSION_SECRET`.

| Proměnná | Kde | Výchozí | Popis |
| --- | --- | --- | --- |
| `PORT` | server | `3001` | port gateway |
| `HOST` | server | `127.0.0.1` | adresa, na které poslouchá gateway |
| `SERVICE_HOST` | server | `127.0.0.1` | adresa, na které poslouchají služby |
| `STORY_PORT`, `GAMEPLAY_PORT`, `DISCOVERY_PORT`, `AUDIT_PORT` | server | `3002`–`3005` | porty služeb |
| `STORY_SERVICE_URL`, `GAMEPLAY_SERVICE_URL`, `DISCOVERY_SERVICE_URL`, `AUDIT_SERVICE_URL` | server | `http://127.0.0.1:<port služby>` | adresy služeb, pokud běží jinde |
| `SERVICE_TIMEOUT_MS` | server | `3000` | timeout volání mezi službami |
| `INTERNAL_SERVICE_TOKEN` | server | prázdné | token pro volání mezi službami, při prázdném ho vygeneruje `scripts/run.mjs` |
| `SESSION_SECRET` | server | prázdné | klíč pro podpis session cookie, aspoň 32 znaků |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | server | prázdné | Google OAuth, bez nich `/api/auth` vrací 503 |
| `FRONTEND_URL` | server | `http://localhost:5173` | kam gateway přesměruje po přihlášení |
| `CORS_ORIGIN` | server | `http://localhost:5173` | povolené originy, oddělené čárkou |
| `VITE_USE_MOCK` | client | `false` | `true` nebo `1` zapne mock data |
| `VITE_API_URL` | client | prázdné | adresa backendu, prázdné znamená relativní `/api` |
| `PROXY_TARGET` | client | `http://localhost:3001` | kam dev server přeposílá `/api` |

## Databáze (MongoDB)

Každá služba má vlastní databázi v jednom MongoDB clusteru: `gamebook_story` (příběhy a scény), `gamebook_gameplay` (hraní), `gamebook_discovery` (hodnocení) a `gamebook_audit` (audit log). Přístup k datům je v DAO vrstvě `server/src/services/<služba>/dao/`.

```bash
npm run db:init   # založí kolekce a indexy (lze spouštět opakovaně)
npm run db:seed   # totéž + nahraje testovací příběh „Ztracený důkaz“
```

| Proměnná | Kde | Výchozí | Popis |
| --- | --- | --- | --- |
| `MONGODB_URI` | server | `mongodb://127.0.0.1:27017/?directConnection=true` | připojení k MongoDB (lokálně nebo Atlas) |
| `MONGODB_DB_PREFIX` | server | `gamebook` | prefix názvů databází služeb |

Serverové testy si spouští vlastní MongoDB v paměti přes `mongodb-memory-server`, žádná instalace není potřeba. Při prvním spuštění se MongoDB stáhne (na Windows asi 600 MB, v cache pak zabírá kolem 60 MB).

## Lokální vývoj

Lokální MongoDB běží jako jednouzlový replica set, stejně jako Atlas. Spustit ji jde dvěma způsoby:

```bash
# a) Docker
npm run db:up      # MongoDB na 127.0.0.1:27017, data ve volume
npm run db:down    # zastavení (data zůstanou, smazání: docker compose down -v)
docker compose --profile tools up -d   # navíc mongo-express na http://localhost:8081

# b) bez Dockeru (stejná binárka jako testy, data v server/.mongo-data)
npm run db:local   # běží v popředí, ukončení Ctrl+C
```

Pak v jiném terminálu:

```bash
cp server/.env.example server/.env   # poprvé; doplň SESSION_SECRET (min. 32 znaků)
npm run db:seed    # kolekce, indexy a testovací příběh
npm run dev        # gateway + 4 služby + klient
```

Přihlášení bez Google OAuth: `npm run dev:session -- jan` (autor seedu) nebo `npm run dev:session -- petr` (hráč) vypíše cookie `gr_session` podepsanou `SESSION_SECRET`. Skript ukáže příklad pro `curl` i příkaz pro konzoli prohlížeče. Google přihlášení (`/api/auth/google`) potřebuje navíc `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` a `GOOGLE_REDIRECT_URI`.

## Mock nebo backend

Klient může běžet nad mock daty, aby šel vyvíjet bez backendu. Implementace jsou v `client/src/api/` (`httpApi.js` a `mockApi.js`). Nový endpoint patří do obou a má vracet stejné chybové hlášky.

Zdroj dat určuje `VITE_USE_MOCK`, zkratka je `npm run dev:client:mock` (soubor `client/.env.mock`). Při vývoji jde zdroj přepnout i checkboxem v aplikaci. Volba platí jen v aktuálním tabu a do jeho zavření má přednost před env. V buildu checkbox není.
