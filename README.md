# Gamebook Realm

Platforma pro tvorbu a hraní interaktivních příběhů (gamebooků). Autoři vytvářejí příběhy ze scén s větvením, čtenáři je hrají a ohodnocují.

Projekt je na začátku, hotová je jen kostra. Server drží data v paměti, takže po restartu zmizí.

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

Výchozí hodnoty stačí. Pro změnu zkopíruj `.env.example` na `.env` v dané složce.

| Proměnná | Kde | Výchozí | Popis |
| --- | --- | --- | --- |
| `PORT` | server | `3001` | port serveru |
| `CORS_ORIGIN` | server | `http://localhost:5173` | povolené originy, oddělené čárkou |
| `VITE_USE_MOCK` | client | `false` | `true` nebo `1` zapne mock data |
| `VITE_API_URL` | client | prázdné | adresa backendu, prázdné znamená relativní `/api` |
| `PROXY_TARGET` | client | `http://localhost:3001` | kam dev server přeposílá `/api` |

## Mock nebo backend

Klient může běžet nad mock daty, aby šel vyvíjet bez backendu. Implementace jsou v `client/src/api/` (`httpApi.js` a `mockApi.js`). Nový endpoint patří do obou a má vracet stejné chybové hlášky.

Zdroj dat určuje `VITE_USE_MOCK`, zkratka je `npm run dev:client:mock` (soubor `client/.env.mock`). Při vývoji jde zdroj přepnout i checkboxem v aplikaci. Volba platí jen v aktuálním tabu a do jeho zavření má přednost před env. V buildu checkbox není.
