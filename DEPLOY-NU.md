# Guidsell nu online zetten — de korte route

## Wat er nu aan de hand is

Ik heb live gekeken en dit is de stand van zaken:

| | status |
|---|---|
| `https://guidsell.onrender.com` | ❌ **bestaat niet meer** — Render antwoordt `x-render-routing: no-server` (= geen service) |
| GitHub `Amin0-e/Guidsell` | ✅ bestaat, laatste upload vandaag 19:55 (exact de code van vóór mijn wijzigingen) |
| Jouw code lokaal | ✅ nieuwste versie, klaar om te pushen |

Dus "de vinted link werkt niet" klopt: er staat op dat adres helemaal geen server meer. Er valt niets te koppelen.

## Wat ik niet zelf kan doen

Ik kan geen accounts voor je aanmaken en niet inloggen als jou. Voor online zetten is één van deze twee dingen nodig:

- **jij** voert de stappen hieronder uit (5 minuten), of
- **jij** geeft me een GitHub-token (en eventueel een Render API-key), dan push ik het en zet ik de service voor je aan.

---

## Belangrijk om te weten: gratis Render kan geen schijf bewaren

Render zegt het zelf: *"Free web services ... Persistent disks: not supported"*. Erger nog: een gratis service gaat na **15 minuten zonder bezoek** in slaap en **gooit dan zijn hele schijf leeg**. Zonder maatregel ben je dus elke 15 minuten al je accounts kwijt.

Daarom zit er nu een tweede opslag in de server: hij kan accounts én app-data in een **externe key-value store** zetten (gratis Upstash Redis met REST-API, geen verloopdatum). Env vars:

```
KV_REST_URL   = https://xxx.upstash.io
KV_REST_TOKEN = de REST-token
```

Ik heb dit getest: account aangemaakt → **de hele schijf gewist** (precies wat Render doet) → server opnieuw gestart → inloggen werkte nog steeds, want het account kwam uit de externe store. Zonder die twee variabelen werkt alles zoals eerst (lokaal bestand), dus je kunt niets stukmaken.

---

## Route A — gratis (aanbevolen)

### Stap 1 — Nieuwe code naar GitHub

De twee gewijzigde bestanden zijn [index.html](index.html) en [vinted-proxy.mjs](vinted-proxy.mjs), plus de nieuwe [render.yaml](render.yaml).

**Optie 1: via de website** (zoals je hiervoor deed)
1. [github.com/Amin0-e/Guidsell](https://github.com/Amin0-e/Guidsell) → **Add file** → **Upload files**
2. Sleep `index.html`, `vinted-proxy.mjs` en `render.yaml` erin → **Commit changes**

**Optie 2: via git** (eenmalig, daarna is het één commando)
```bash
cd "C:/Users/n.soubati/Desktop/Guidsell"
git add index.html vinted-proxy.mjs render.yaml ONLINE-ZETTEN.md DEPLOY-NU.md
git commit -m "Vinted koppelen via inloggen + accounts in externe opslag"
git push
```

### Stap 2 — Gratis opslag aanmaken (Upstash)

1. [upstash.com](https://upstash.com) → gratis account (geen creditcard)
2. **Create database** → naam `guidsell`, type **Regional**, regio **eu-central-1 (Frankfurt)**
3. Open de database → tab **REST API** → kopieer:
   - **UPSTASH_REDIS_REST_URL** → dat wordt `KV_REST_URL`
   - **UPSTASH_REDIS_REST_TOKEN** → dat wordt `KV_REST_TOKEN`

### Stap 3 — Service aanmaken op Render

1. [render.com](https://render.com) → inloggen → **New +** → **Blueprint**
2. Kies de repo `Amin0-e/Guidsell` → **Apply** (Render leest `render.yaml`)
3. Render vraagt om de secrets — vul in:
   - `GEMINI_API_KEY` = je Google Gemini-sleutel
   - `KV_REST_URL` = de Upstash URL
   - `KV_REST_TOKEN` = de Upstash token
4. **Create** → wachten tot de deploy groen is → je krijgt een adres zoals `https://guidsell.onrender.com`

### Stap 4 — Controleren of het echt goed staat

Open je Render-URL → registreer een account → log uit → **log op je telefoon in met hetzelfde account**. Dat moet werken.

Extra controle in de serverlog van Render: je hoort deze regel te zien
```
[auth] accounts staan in de externe store (KV_REST_URL) — ze overleven een redeploy, restart én spin-down ✔
```
Zie je in plaats daarvan `LET OP: accounts staan in ... — dat is geen persistente opslag`, dan zijn `KV_REST_URL`/`KV_REST_TOKEN` niet goed ingesteld.

---

## Route B — betaald ($7/maand), zonder externe opslag

1. Render → je service → **Settings** → **Instance Type** → **Starter** ($7/mnd)
2. **Disks** → **Add disk**: naam `guidsell-data`, **Mount path** `/var/data`, 1 GB
3. **Environment** → zet `DATA_DIR` = `/var/data`
4. Deploy opnieuw

Voordeel: geen aparte dienst nodig, en je service slaapt niet meer (geen wachttijd van 50 seconden bij het eerste bezoek). Nadeel: het kost geld.

---

## Wat er in deze update allemaal nieuw is

- **Vinted koppelen**: gewoon je Vinted-e-mailadres + wachtwoord invullen en op **Koppel mijn Vinted** klikken. Geen F12, geen "Copy as cURL". Je wachtwoord wordt niet bewaard; alleen de toegangssleutel van Vinted staat op de server en wordt automatisch ververst.
- **Kast, biedingen en berichten** van je eigen account, met antwoorden kunnen sturen (getest met een nagebouwde Vinted: kast 3 items, inbox 2 gesprekken met bod, gesprek lezen, antwoord versturen, verbindingstest 5/5 groen).
- **Accounts op de server** (waren ze al) met nu een échte persistente optie voor de gratis tier.
- **Na het koppelen** blijf je op het dashboard staan in plaats van naar de upgrade-pagina gestuurd te worden.
