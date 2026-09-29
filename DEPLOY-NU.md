# Guidsell staat online — status en wat er nog moet

**Live:** https://guidsell.onrender.com
**Service:** Guidsell op Render · Node · **Free ($0/maand)** · regio **Frankfurt** · branch `main`
**Repo:** https://github.com/Amin0-e/Guidsell (laatste commit `7ff8a5f`)

---

## Wat er gedaan is

1. **Nieuwe code naar GitHub gepusht.** De Vinted-koppeling via inloggen, de login-fix en de externe opslag staan nu in de repo.
2. **Render-service opnieuw aangemaakt.** De oude service bestond niet meer (`x-render-routing: no-server`). Namen, regio en start-commando staan goed; de instance staat bewust op **Free** (Render zet standaard het betaalde Starter-plan van $7 klaar).
3. **Gratis externe opslag gekoppeld.** Upstash Redis (Ierland, `eu-west-1`, Free Tier, $0) → accounts én app-data overleven nu een redeploy, restart en spin-down.
4. **Live getest.** Zie hieronder.

## Bewijs dat het werkt

Login werkte vroeger alleen in de browser van één apparaat. Nu:

| Test | Resultaat |
|---|---|
| Registreren via de live site | ✅ account aangemaakt |
| Inloggen vanaf een "ander apparaat" (leeg browservenster) | ✅ werkt |
| `GET /api/auth/me` | ✅ `persistent: true`, `storeBackend: "kv"` |
| **Service herstart (schijf volledig gewist)** | ✅ account kwam terug uit de externe store en inloggen werkte |
| Account dat nog in de oude, vluchtige opslag stond | ✅ terecht verdwenen — dus de test is echt |

De serverlog zegt het letterlijk:

```
[auth] accounts staan in de externe store (KV_REST_URL) — ze overleven een redeploy, restart én spin-down ✔
[auth] account aangemaakt: ...
[auth] 1 account(s) geladen uit de externe store      ← na de herstart
```

## Wat jij nog moet doen: de AI-sleutel

De AI-waardecheck werkt pas met jouw Google Gemini-sleutel. Die in `ai-key.txt` wordt voor mij afgeschermd zodra ik hem lees, dus dit stukje moet jij doen. Het veld staat al klaar:

1. Render → **Guidsell** → **Environment**
2. In de rij **GEMINI_API_KEY** (staat onderaan, klaargezet) → klik op het **VALUE**-vak ernaast
3. Plak je sleutel uit `ai-key.txt`
4. Klik **Save, rebuild, and deploy** (duurt ±1 minuut)

Daarna geeft `https://guidsell.onrender.com/api/ai/status` → `{"aiReady":true}`.

---

## Hoe je het zelf controleert

```
https://guidsell.onrender.com/api/ai/status        → aiReady
https://guidsell.onrender.com/api/auth/me?token=…  → persistent / storeBackend
```

In de serverlog van Render zie je bij elke start waar de accounts vandaan komen (`externe store` = goed).

## Rekening houden met

- **Gratis service slaapt** na 15 minuten zonder bezoek. Het eerste bezoek duurt dan ±50 seconden. Dat is normaal en kost niets.
- **750 gratis instance-uren per maand** — ruim voldoende voor één service die de hele maand draait.
- **Vinted blokkeert servers volledig** (DataDome op datacenter-IP's): álle `vinted.nl/api`-verzoeken geven vanaf Render een 403. Daarom verloopt de Vinted-koppeling via een bladwijzer die je **in je eigen browser** op vinted.nl klikt; deze server is dan alleen opslag. Zo staat het ook in deel 1B van ONLINE-ZETTEN.md.
- **De GitHub-token** die ik gebruikte (`Guidsell-deploy`, alleen `public_repo`) kun je intrekken via github.com/settings/tokens — dat mag je gerust doen, ik heb hem niet meer nodig.
- **Upstash** staat op $0 met 256 MB en 10 GB bandwidth per maand. Ruim genoeg; een accountbestand van 1000 gebruikers is een paar honderd kB.
