# Guidsell online zetten + betalingen ontvangen

Complete gids — van localhost naar een echte site waar vrienden (en strangers) accounts maken en voor PRO betalen.

> ⚡ **Snel online zetten?** Gebruik [DEPLOY-NU.md](DEPLOY-NU.md). Daar staat in 4 stappen hoe je Guidsell opnieuw live zet, inclusief waarom de gratis Render-tier géén schijf kan bewaren en hoe je dat met een gratis externe key-value store oplost.

---

## DEEL 1 — Online zetten

Je server (`vinted-proxy.mjs`) moet online draaien, anders werken live Vinted-prijzen en automatische AI niet. De makkelijkste gratis optie is **Render.com**.

### Optie A: Render.com via GitHub (aanbevolen om te starten)

1. **Zet je project op GitHub**
   - Maak een account op [github.com](https://github.com) en een nieuwe repository (bijv. `guidsell`)
   - Upload deze 3 bestanden: `index.html`, `vinted-proxy.mjs`, `package.json`
   - **Upload `ai-key.txt` NIET** (daar zit je geheime sleutel in — die voer je later in bij Render)

2. **Deploy op Render**
   - Ga naar [render.com](https://render.com) → maak gratis account
   - "New +" → "Web Service" → kies je GitHub-repo
   - Instellingen:
     - **Runtime**: Node
     - **Build Command**: (leeg laten)
     - **Start Command**: `node vinted-proxy.mjs`
     - **Instance type**: Free
   - Onder "Environment" → voeg toe:
     - `GEMINI_API_KEY` = jouw Gemini-sleutel
     - `KV_REST_URL` + `KV_REST_TOKEN` = van je gratis Upstash-Redis (zie hieronder)
   - Klik "Create Web Service" → na 2 minuten heb je een URL zoals `https://guidsell.onrender.com`
   - **Sneller:** zet `render.yaml` in je repo en kies **New + → Blueprint**; Render maakt de service dan aan met alle instellingen goed, en vraagt alleen om de secrets.

> ⚠️ **Belangrijk — accounts bewaren.** Accounts én de app-data (items, kasboek,
> plan/quota) staan op de server. Op Render is het bestandssysteem van een **gratis
> instantie vluchtig** — en een gratis service gaat na 15 minuten zonder bezoek in
> slaap en **gooit dan de schijf leeg**. Bovendien ondersteunt de gratis tier
> **geen** persistent disks (alleen betaalde instances).
>
> Zet daarom deze twee env vars, dan staan accounts in een externe key-value store
> die altijd blijft bestaan:
>
> ```
> KV_REST_URL   = https://xxx.upstash.io     (gratis Upstash Redis → REST API)
> KV_REST_TOKEN = de REST-token
> ```
>
> Je mag ook de namen uit het Upstash-dashboard zelf overnemen
> (`UPSTASH_REDIS_REST_URL` en `UPSTASH_REDIS_REST_TOKEN`) — de server accepteert
> ze allebei. Op Render kun je een heel .env-blok in één keer plakken via
> *Environment* → *Add variable* → **Import from .env**.
>
> Kies je toch voor een **betaalde** instance (Starter, $7/mnd), dan kan wél een
> disk: *Disks* → *Add disk* met mount `/var/data`, plus `DATA_DIR` = `/var/data`.
> De server zoekt zo'n persistente map trouwens ook zelf als `DATA_DIR` leeg is.
>
> Wat de server gebruikt zie je in de log bij het opstarten:
> - `accounts staan in de externe store ... ✔` → goed
> - `accounts worden bewaard op ... (blijft staan na een herstart)` → goed (betaalde disk)
> - `LET OP: accounts staan in ... — dat is geen persistente opslag` → nog niet goed
>
> In de app zie je hetzelfde via `/api/auth/me` → `"persistent"` en `"storeBackend"`
> (`kv`, `disk` of `file`). Zonder externe opslag werkt login wél, maar ben je
> accounts kwijt na een spin-down of redeploy.

3. **Test** → open je Render-URL, registreer, doe een check. Klaar!

> ⚠️ Gratis Render-instanties "slapen" na 15 minuten inactiviteit. Eerste bezoek duurt dan ~30 seconden. $7/mnd houdt hem wakker.

### Optie B: VPS (geen slaapstand, eigen domein)

Bijvoorbeeld [Hetzner](https://hetzner.com) (€4/mnd) of [DigitalOcean](https://digitalocean.com) ($6/mnd):

```bash
# 1. Log in op je server
ssh root@jouw-server-ip

# 2. Installeer Node
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. Upload je bestanden (vanaf je pc, in dezelfde map)
scp index.html vinted-proxy.mjs package.json root@jouw-server-ip:/opt/guidsell/

# 4. Start de server met systemd (blijft draaien na reboot)
cat > /etc/systemd/system/guidsell.service << 'EOF'
[Unit]
Description=Guidsell
After=network.target

[Service]
WorkingDirectory=/opt/guidsell
Environment=PORT=8787
Environment=GEMINI_API_KEY=plak_hier_jouw_sleutel
ExecStart=/usr/bin/node vinted-proxy.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now guidsell

# 5. Installeer Caddy (gratis SSL + domein)
apt install -y caddy
cat > /etc/caddy/Caddyfile << 'EOF'
guidsell.nl {
    reverse_proxy localhost:8787
}
EOF
systemctl reload caddy
```

Koop een domein bij [Namecheap](https://namecheap.com) (~€10/jaar) en verwijs het naar je server-IP.

---

---

## DEEL 1B — Vinted-account koppelen (kast, biedingen, berichten)

In de app staat op het dashboard **Koppel je Vinted-account**. Daarmee haalt Guidsell je échte kast (inventaris met prijzen, views en favourites), je **biedingen/berichten** uit je Vinted-inbox en kun je **direct antwoorden**, ook op mensen die een bod deden.

### Eerst de waarheid: Vinted blokkeert servers

Vinted zet datacenter-IP's (waaronder alles van Render) op de zwarte lijst met DataDome. Vanaf een gehoste server krijg je op **elk** `vinted.nl/api/...`-verzoek een **403** — dus niet alleen op inloggen. Daarom werkt koppelen vanaf de server principieel niet, hoe goed de code ook is.

**De oplossing:** de Vinted-verzoeken gebeuren in **jouw eigen browser** (jouw thuis-IP, niet geblokkeerd). Guidsell is dan alleen nog opslag.

### Zo koppel je — eenmalig een bladwijzer, daarna één klik

1. Op het dashboard: **sleep** de knop **🔗 Guidsell × Vinted** naar je bladwijzerbalk.
2. Open **vinted.nl** (waar je bent ingelogd) en **klik daar op die bladwijzer**.

Klaar. Je browser haalt je kast, biedingen en berichten op en stuurt ze naar Guidsell; kom je terug, dan laadt Guidsell ze automatisch in. De knop bevat een **vaste koppelsleutel** per account, dus hij blijft werken — ook na opnieuw inloggen of na maanden. Je Vinted-wachtwoord komt er **niet** aan te pas.

**Antwoorden sturen:** typ je antwoord in Guidsell → klik op **🔄 Verversen** nadat je op vinted.nl op de bladwijzer klikte. Het bericht gaat mee diezelfde klik naar Vinted.

**Zo werkt het technisch:** de bladwijzer draait op vinted.nl zelf (zelfde domein, dus geen CORS/CSP-probleem), zoekt de gebruikte API-paden op uit de requests die de pagina al doet (blijft dus werken als Vinted iets hernoemt) en post het resultaat naar `POST /api/vinted/push` op dit adres. Die endpoint heeft bewust `Access-Control-Allow-Origin: *` en accepteert alleen de vaste koppelsleutel van jouw account.

- **🩺 Status** in de app laat zien wat de laatste klik opleverde: account, items, gesprekken, wachtende antwoorden en — bij problemen — welke paden faalden.
- Vragen de inklapbare **andere manieren** om een sessie te plakken (F12 → Copy as cURL), dan is dat alleen bedoeld voor als je Guidsell **op je eigen pc** draait; daar is de server niet geblokkeerd.
- Koppelen is gratis; je live kast en de inbox/biedingen zitten in **PRO**.
- De opgehaalde Vinted-gegevens staan in hetzelfde bestand als de accounts (`guidsell-accounts.json`) → zet dus echt een persistent disk of externe store (zie deel 1).

---

## DEEL 2 — Betalingen activeren

### Stripe Payment Links (2 abonnementen) — aanbevolen

Je maakt **twee** Payment Links: één voor **€3/week** en één voor **€10/maand**.

1. Maak een account op [stripe.com](https://stripe.com) (gratis; Stripe houdt ~1,5% + €0,25 per transactie)
2. Activeer je account met je KVK + IBAN (geld komt rechtstreeks op je rekening)
3. Links in het menu: **"Payment links"** → **"+ New"** (doe dit 2×)

   **Link A — PRO Week:**
   - Product: `Guidsell PRO Week`
   - Prijs: `€ 3,00` → **Recurring** → `Weekly`
   - Na betaling: **"Redirect customers to your website"** → vul in: `https://JOUW-DOMEIN/?pro=success&plan=weekly`

   **Link B — PRO Maand (aanrader):**
   - Product: `Guidsell PRO Maand`
   - Prijs: `€ 10,00` → **Recurring** → `Monthly`
   - Na betaling: **"Redirect customers to your website"** → vul in: `https://JOUW-DOMEIN/?pro=success&plan=monthly`

4. Je krijgt twee URL's zoals `https://buy.stripe.com/xxxx_weekly` en `..._monthly`

5. **Plak die links in de code** — open `index.html` en zoek bovenin het script:

```js
const PAYMENT_LINK_WEEKLY  = ""; // bv. "https://buy.stripe.com/xxxx_weekly"
const PAYMENT_LINK_MONTHLY = ""; // bv. "https://buy.stripe.com/xxxx_monthly"
```

   Legacy fallback (mag leeg blijven):
```js
const PAYMENT_LINK = "";
```

6. Deploy opnieuw (bij Render: automatisch na git push)

**Hoe het werkt in de app:**
- Gebruiker kiest **Week (€3)** of **Maand (€10)** → gaat naar de juiste Stripe-betaalpagina
- Na betaling → terug naar jouw site met `?pro=success&plan=weekly` of `&plan=monthly`
- De app activeert automatisch **PRO Week (7 dagen)** of **PRO Maand (30 dagen)** op dat account ✅
- Na verloop vervalt PRO automatisch terug naar FREE (expiry staat in `proUntil`)
- Zolang beide links leeg zijn, werkt de demo-activering (voor testen — activeert zonder echte betaling)

> 💡 **Tip:** Maand = ~€2,50/week → in de UI gemarkeerd als *BESTE DEAL · BESPAAR 18%* vs 4× week.

### Mollie (Nederlands alternatief)

Zelfde principe: [mollie.com](https://mollie.com) → "Payment links" → zelfde stappen. Iets hogere kosten (€0,29 + ~2,8%) maar Nederlandse support en sterk op iDEAL.

### Strikt legaal (NL)

- Schrijf je in bij de **KVK** zodra je structureel geld ontvangt (eenmanszaak is prima om te starten)
- Facturatie doet Stripe/Mollie automatisch; bewaar zelf je administratie
- Privacy: vermeld in je footer welke data je opslaat (accounts, checkgeschiedenis)

---

## DEEL 3 — Checklist voor livegang

- [ ] 3 bestanden op GitHub (index.html, vinted-proxy.mjs, package.json)
- [ ] Render/VPS deploy met `GEMINI_API_KEY` ingesteld
- [ ] Persistent disk gekoppeld (bijv. mount `/var/data`) — check dat de serverlog *niet* "geen persistente mount" zegt
- [ ] Account op 2 apparaten getest (registreren op A → inloggen op B)
- [ ] Vinted-koppeling getest met je eigen account (e-mail + wachtwoord) → kast + inbox zichtbaar → **Test verbinding** is 5× groen
- [ ] Site getest: registreren → check doen → live Vinted-prijzen verschijnen
- [ ] Stripe Payment Link gemaakt en in index.html gezet
- [ ] Betaling getest (betaal jezelf €1 en refund het)
- [ ] Footer checken: naam, contact, disclaimer "prijzen zijn indicatief"

---

## DEEL 4 — Belangrijke kanttekeningen

1. **Vinted blokkeert servers volledig** (DataDome op datacenter-IP's): live prijzen én de Vinted-koppeling werken daarom alleen vanuit **jouw eigen browser** (de bladwijzer). De app valt anders automatisch terug op AI-schattingen — de site blijft dan werken, alleen zonder live Vinted-gegevens. Volledig automatisch vanaf de server? Dan is een residentiële proxy nodig (±€3–10/maand).

2. **Accounts staan op de server** (`guidsell-accounts.json`): inloggen werkt op elk apparaat en de items/kasboek/quota reizen mee — een registratie verdwijnt dus niet meer met je browsergegevens. Wachtwoorden worden gehasht met scrypt; alleen de sessie-token staat in de browser (90 dagen geldig). Zorg dat het bestand op een **persistent disk** staat (de server zoekt die zelf, of zet `DATA_DIR` — zie deel 1). Raak je een account toch kwijt door een redeploy zonder disk: registreer opnieuw met hetzelfde e-mailadres en wachtwoord, dan zet de app de gegevens die nog op dat apparaat staan automatisch terug. Voor veel gebruikers (duizenden) is een echt database-systeem (bijv. Supabase) de volgende stap.

3. **AI-kosten**: op je eigen server betaal je het Gemini-gebruik. De gratis tier is ruim genoeg voor honderden checks per maand; daarna kost flash ~€0,01 per check.

4. **Quota & plan-status**: die staan nu per account op de server en reizen dus mee naar elk apparaat. Let op: PRO wordt nog steeds geactiveerd zodra de app de Stripe-redirect binnenkrijgt — voor echt waterdichte betalingen wil je later een Stripe-webhook die het plan server-side zet.
