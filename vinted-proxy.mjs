#!/usr/bin/env node
/**
 * Guidsell server-proxy
 * ---------------------
 * Klein, zonder dependencies (geen npm install nodig). Doet twee dingen:
 *
 *   1. Serveert de Guidsell-app (index.html) op http://localhost:8787
 *   2. /api/vinted?q=...  → haalt LIVE vergelijkbare items op van Vinted
 *      en rekent mediaan + prijsbereik uit.
 *
 * Hoe het werkt: Vinted's oude JSON-API (api/v2/catalog/items) is in 2026
 * verwijderd en hun bot-beveiliging (DataDome) blokkeert Node's fetch.
 * De pagina's zijn wel bereikbaar via curl — dus de proxy roept curl aan
 * met een cookie-jar (echte Chrome-headers) en parseert de catalogus-HTML,
 * waarin elk item een title-attribuut heeft met titel/merk/staat/maat/prijs.
 *
 * Starten:   node vinted-proxy.mjs
 * Daarna:    http://localhost:8787 openen
 *
 * Let op: gebruikt de publieke catalogus van Vinted (best effort). Als
 * Vinted de server blokkeert, valt de app netjes terug op AI-schattingen.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
const VINTED_HOST = process.env.VINTED_HOST || "https://www.vinted.nl";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* =====================================================
   ACCOUNTS — server-side, zodat inloggen op ELK apparaat werkt
   -----------------------------------------------------
   Vroeger stonden accounts alleen in de localStorage van één browser. Nu
   staat elke account (+ de app-data: items, kasboek, plan/quota) in één
   JSON-bestand naast de server. Wachtwoorden worden gehasht met scrypt en
   van de beveiligingsvraag bewaren we alleen een hash.

   Bestand: DATA_DIR/guidsell-accounts.json.
   DATA_DIR komt uit de env var; staat die niet ingesteld, dan kijken we of er
   een persistente mount bestaat (/var/data e.d.). Zo niet, dan gebruiken we de
   map van de server. Zonder persistente mount is het bestandssysteem op Render
   vluchtig: accounts overleven dan geen redeploy. Daarom loggen we dat expliciet
   bij het opstarten en geven we het door aan de app (/api/auth/me → persistent).
===================================================== */
function pickDataDir() {
  const env = String(process.env.DATA_DIR || "").trim();
  if (env) return env;
  for (const p of ["/var/data", "/data", "/var/guidsell", path.join(os.homedir(), ".guidsell")]) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        fs.accessSync(p, fs.constants.W_OK);
        return p;
      }
    } catch (e) { /* niet bruikbaar */ }
  }
  return __dirname;
}
const DATA_DIR = pickDataDir();
const PERSISTENT_DATA = path.resolve(DATA_DIR) !== path.resolve(__dirname);
const ACCOUNTS_FILE = path.join(DATA_DIR, "guidsell-accounts.json");
const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;   // sessie 90 dagen geldig
const MAX_STATE_BYTES = 8 * 1024 * 1024;         // max app-data per account

/* ---------------- Optionele externe opslag ----------------
   Render's gratis web services hebben GEEN persistente schijf: bij elke
   spin-down (15 min zonder bezoek!), restart of redeploy raakt de schijf leeg.
   Daarom kan de store ook in een externe key-value store staan die je via HTTP
   benadert — Upstash Redis heeft een gratis REST-API (geen account-kosten, geen
   verloopdatum). Zet daarvoor twee env vars:

     KV_REST_URL   = https://xxx.upstash.io
     KV_REST_TOKEN = de REST-token

   Zonder die vars werkt alles precies zoals eerst (bestand naast de server). */
// Accepteer ook de namen die Upstash zelf aanraadt, zodat je de variabelen uit
// het Upstash-dashboard één op één kunt overnemen zonder ze te hernoemen.
const KV_URL = String(process.env.KV_REST_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const KV_TOKEN = String(process.env.KV_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "");
const KV_KEY = String(process.env.KV_KEY || "guidsell-accounts").replace(/[^0-9a-zA-Z_\-]/g, "");
const KV_ENABLED = !!(KV_URL && KV_TOKEN);
let kvLastPayload = null;

// één commando naar de KV-REST-API; geeft de JSON-respons of null
function kvCall(method, kvPath, body) {
  const args = [
    "-X", method,
    "-H", "Authorization: Bearer " + KV_TOKEN,
    "-w", "\n__GS_STATUS__%{http_code}",
  ];
  if (body != null) args.push("--data-binary", body);
  args.push(KV_URL + kvPath);
  let out = "";
  try { out = curl(args, 30000).toString("utf8"); }
  catch (e) { console.log("[kv] verzoek mislukt:", e.message); return null; }
  const m = out.match(/\n__GS_STATUS__(\d+)\s*$/);
  const status = m ? Number(m[1]) : 0;
  if (status < 200 || status > 299) { console.log("[kv] HTTP " + status); return null; }
  try { return JSON.parse(m ? out.slice(0, m.index) : out); } catch (e) { return null; }
}

function kvLoad() {
  if (!KV_ENABLED) return null;
  const r = kvCall("GET", "/get/" + KV_KEY);
  if (!r || typeof r.result !== "string") return null;
  try { return JSON.parse(r.result); } catch (e) { return null; }
}

function kvSave(payload) {
  if (!KV_ENABLED) return false;
  if (payload === kvLastPayload) return true;                 // niets veranderd
  if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) { console.log("[kv] store te groot — niet opgeslagen"); return false; }
  const r = kvCall("POST", "/set/" + KV_KEY, payload);
  if (r && r.result === "OK") { kvLastPayload = payload; return true; }
  console.log("[kv] opslaan mislukt");
  return false;
}

/* lees een JSON-store veilig van schijf */
function readLocalStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (parsed && typeof parsed === "object") return { users: parsed.users || {}, sessions: parsed.sessions || {} };
  } catch (e) {
    if (e.code !== "ENOENT") console.log("[auth] accounts laden mislukt:", e.message);
  }
  return null;
}

/* b vult aan waar a niets heeft — zo raak je nooit accounts kwijt als één van
   de twee opslagplekken even niet bereikbaar was */
function mergeStores(a, b) {
  const out = { users: {}, sessions: {} };
  for (const src of [b, a]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src.users || {})) if (!out.users[k]) out.users[k] = v;
    for (const [k, v] of Object.entries(src.sessions || {})) if (!out.sessions[k]) out.sessions[k] = v;
  }
  return out;
}

const STORE_BACKEND = KV_ENABLED ? "kv" : (PERSISTENT_DATA ? "disk" : "file");

let store = { users: {}, sessions: {} };

function loadStore() {
  const local = readLocalStore();
  const remote = kvLoad();
  if (remote || local) {
    store = mergeStores(local, remote);                      // externe store leidend
    const n = Object.keys(store.users).length;
    if (remote) console.log(`[auth] ${n} account(s) geladen uit de externe store${local ? " (aangevuld met het lokale bestand)" : ""}`);
    else console.log(`[auth] ${n} account(s) geladen uit ${ACCOUNTS_FILE}`);
  }
}

let storeTimer = null;
function saveStore(immediate) {
  const write = () => {
    storeTimer = null;
    const payload = JSON.stringify(store);
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = ACCOUNTS_FILE + ".tmp";
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, ACCOUNTS_FILE);
    } catch (e) {
      console.log("[auth] accounts opslaan mislukt:", e.message);
    }
    kvSave(payload);                                        // externe store bijwerken
  };
  if (immediate) {
    if (storeTimer) clearTimeout(storeTimer);
    return write();
  }
  if (storeTimer) return;
  storeTimer = setTimeout(write, 400);
}

function hashSecret(value, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  return { salt: s, hash: crypto.scryptSync(String(value), s, 64).toString("hex") };
}
function verifySecret(value, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const calc = crypto.scryptSync(String(value), rec.salt, 64);
  const want = Buffer.from(rec.hash, "hex");
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
function normEmail(v) { return String(v || "").trim().toLowerCase(); }
function normAnswer(v) { return String(v || "").trim().toLowerCase().replace(/\s+/g, " "); }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of Object.entries(store.sessions)) {
    if (!s || !s.email || !store.users[s.email] || now - s.created > SESSION_TTL) delete store.sessions[t];
  }
}
function createSession(email) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("hex");
  store.sessions[token] = { email, created: Date.now() };
  return token;
}
function tokenEmail(token) {
  if (!token) return null;
  const s = store.sessions[token];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL || !store.users[s.email]) { delete store.sessions[token]; return null; }
  return s.email;
}
function publicUser(u) { return { email: u.email, name: u.name, hasSec: !!(u.secQ && u.secHash) }; }

// zeer lichte rem op wachtwoord-raden (per ip+e-mail)
const loginFails = new Map();
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "?";
}
function failLeft(key) {
  const rec = loginFails.get(key);
  if (!rec) return { blocked: false, left: 10 };
  if (Date.now() - rec.at > 10 * 60 * 1000) { loginFails.delete(key); return { blocked: false, left: 10 }; }
  return { blocked: rec.n >= 10, left: Math.max(0, 10 - rec.n) };
}
function noteFail(key) {
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.at > 10 * 60 * 1000) loginFails.set(key, { n: 1, at: Date.now() });
  else { rec.n++; rec.at = Date.now(); }
}
function clearFails(key) { loginFails.delete(key); }

// korte-lived reset-tokens (beveiligingsvraag correct beantwoord)
const resetTokens = new Map(); // token -> { email, at }
const forgotTries = new Map(); // email -> { n, at }

function storeReset(email) {
  const token = crypto.randomBytes(24).toString("hex");
  resetTokens.set(token, { email, at: Date.now() });
  return token;
}
function useReset(token) {
  const rec = resetTokens.get(token);
  if (!rec) return null;
  resetTokens.delete(token);
  if (Date.now() - rec.at > 15 * 60 * 1000) return null;
  return rec.email;
}

loadStore();

if (KV_ENABLED) {
  console.log("[auth] accounts staan in de externe store (KV_REST_URL) — ze overleven een redeploy, restart én spin-down ✔");
} else if (PERSISTENT_DATA) {
  console.log(`[auth] accounts worden bewaard op ${DATA_DIR} (blijft staan na een herstart/redeploy)`);
} else {
  console.log(`[auth] LET OP: accounts staan in ${DATA_DIR} — dat is geen persistente opslag.`);
  console.log("[auth] Op een gratis Render-service verdwijnen accounts dan bij elke restart/spin-down.");
  console.log("[auth] Twee oplossingen: (1) zet KV_REST_URL + KV_REST_TOKEN naar een gratis Upstash-Redis,");
  console.log("[auth] of (2) betaal een instance + koppel een Disk (mount bijv. /var/data) en zet DATA_DIR.");
}

/* ---------------- curl-gebaseerde Vinted client ---------------- */

// cookie-jar in een map waar we zeker mogen schrijven
const JAR = path.join(os.tmpdir(), "guidsell-vinted-jar.txt");
let lastFetchAt = 0;

function curl(args, timeoutMs = 25000) {
  const exe = process.platform === "win32" ? "curl.exe" : "curl";
  return execFileSync(exe, ["-s", "-m", String(Math.ceil(timeoutMs / 1000)), ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs + 5000,
    windowsHide: true,
  });
}

function warmSession() {
  // eerste bezoek → cookies ophalen (access_token_web e.d.)
  try {
    curl([
      "-c", JAR, "-b", JAR,
      "-A", UA,
      "-H", "Accept: text/html,application/xhtml+xml",
      "-H", "Accept-Language: nl-NL,nl;q=0.9",
      VINTED_HOST + "/",
    ], 20000);
    console.log("[vinted] sessie warm (cookies opgeslagen)");
  } catch (e) {
    console.log("[vinted] sessie opwarmen mislukt:", e.message);
  }
}

function fetchCatalogHtml(query) {
  // nette 1,2s tussenruimte tussen Vinted-verzoeken
  const wait = 1200 - (Date.now() - lastFetchAt);
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  lastFetchAt = Date.now();

  const url = `${VINTED_HOST}/catalog?search_text=${encodeURIComponent(query)}`;
  const html = curl([
    "-b", JAR, "-c", JAR, // jar bijwerken (cookies roteren soms)
    "-A", UA,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",
    "-H", `Referer: ${VINTED_HOST}/`,
    url,
  ], 25000).toString("utf8");

  // DataDome-detectie: te klein of zonder item-links
  const linkCount = (html.match(/href="\/items\//g) || []).length;
  if (html.length < 100000 || linkCount === 0) {
    const err = new Error("vinted_bot_controle");
    err.blocked = true;
    throw err;
  }
  return html;
}

const ITEM_ANCHOR_RE = /href="(\/items\/[^"?]+)[^"]*"\s+[^>]*?title="([^"]+)"/g;
const TITLE_ATTR_RE = /^(.*?), Merk: (.*?)(?:, Staat: (.*?))?(?:, Maat: (.*?))?, ([0-9]+(?:[.,][0-9]+)?) €(?:, ([0-9]+(?:[.,][0-9]+)?) €)?$/;

function parseCatalogHtml(html) {
  const comps = [];
  const seen = new Set();
  let m;
  ITEM_ANCHOR_RE.lastIndex = 0;
  while ((m = ITEM_ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    const raw = m[2]
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    const t = TITLE_ATTR_RE.exec(raw);
    if (!t) continue;
    const idMatch = href.match(/(\d{6,})/);
    const id = idMatch ? idMatch[1] : href;
    if (seen.has(id)) continue;
    seen.add(id);
    const price = parseFloat(t[5].replace(",", "."));
    if (!isFinite(price) || price <= 0 || price > 1500) continue;
    comps.push({
      id,
      title: t[1].trim(),
      brand: t[2].trim(),
      status: (t[3] || "").trim(),
      size: (t[4] || "").trim(),
      price,
      priceWithProtection: t[6] ? parseFloat(t[6].replace(",", ".")) : price,
      url: VINTED_HOST + href,
    });
  }
  return comps;
}

/* ---------------- AI (Gemini) via de server ---------------- */
// Jij stelt één keer een sleutel in (start.bat vraagt erom, of zet hem
// handmatig in ai-key.txt naast dit bestand). Alle gebruikers van de site
// krijgen daarna automatisch AI — zonder ooit een sleutel te zien.

function readApiKey() {
  try {
    const k = fs.readFileSync(path.join(__dirname, "ai-key.txt"), "utf8").trim();
    if (k) return k;
  } catch { /* geen bestand → val terug op env var */ }
  return process.env.GEMINI_API_KEY || null;
}

// Volgorde: meest capabel eerst, dan steeds lichtere/less-drukte varianten.
// Bij "high demand"/overload (429/503) probeert hij automatisch het volgende model.
const AI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
];
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);

async function callGeminiServer(prompt, imagesBase64) {
  const key = readApiKey();
  if (!key) { const e = new Error("geen_sleutel"); e.noKey = true; throw e; }

  const parts = [{ text: prompt }];
  (imagesBase64 || []).slice(0, 3).forEach(b64 =>
    parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } }));

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
  });

  // Twee rondes langs de modellen: "high demand" is meestal een korte piek,
  // dus na één ronde wachten we even en proberen we alles nog eens.
  const queue = [...AI_MODELS, ...AI_MODELS];
  for (let i = 0; i < queue.length; i++) {
    const model = queue[i];
    const isLast = i === queue.length - 1;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body,
          signal: AbortSignal.timeout(40000),
        }
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.log(`[ai] ${model} geweigerd (${res.status}):`, errText.slice(0, 120));
        // high demand / overload → korte wachttijd en volgend model proberen
        if (RETRYABLE_STATUS.has(res.status) && !isLast) {
          await new Promise(r => setTimeout(r, 1200));
        }
        continue;
      }
      const j = await res.json();
      const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      return JSON.parse(String(txt).replace(/```json|```/g, "").trim());
    } catch { /* volgend model */ }
  }
  throw new Error("ai_onbereikbaar");
}

/* =====================================================
   VINTED-ACCOUNT KOPPELEN — kast (inventaris), biedingen, berichten
   -----------------------------------------------------
   Vinted heeft géén publieke koppel-API voor derden, maar wél een gewoon
   inlog-endpoint (POST /oauth/token, grant_type=password). Daarom kan de
   gebruiker gewoon zijn Vinted-e-mail + wachtwoord invullen:

     1. Wij loggen daarmee server-side in bij Vinted (/api/vinted/me/login).
     2. We bewaren het access_token + refresh_token ALLEEN op deze server,
        bij zijn Guidsell-account (het wachtwoord bewaren we niet).
     3. De refresh_token houdt de toegang automatisch vers, dus zijn kast,
        biedingen en gesprekken blijven werken.

   Valt het inloggen bij Vinted toch dicht (tweestapsverificatie, botcontrole),
   dan blijft /api/vinted/me/link bestaan als terugvaloptie: één keer een
   cookie-regel of 'Copy as cURL' uit de browser plakken.
   /api/vinted/me/diagnose laat precies zien wat Vinted wel/niet teruggeeft.
===================================================== */

function parseVintedSession(raw, uaOverride) {
  const text = String(raw || "").trim();
  const out = { cookies: "", token: "", ua: String(uaOverride || "").trim() };
  if (!text) return out;
  // "Copy as cURL" van een Vinted-verzoek (Network-tab → rechtermuis → Copy as cURL)
  const curlCookie = text.match(/-H\s+(['"])cookie:\s*([\s\S]*?)\1/i) || text.match(/--header\s+(['"])cookie:\s*([\s\S]*?)\1/i);
  if (curlCookie) out.cookies = curlCookie[2].replace(/\\"/g, '"').trim();
  const curlB = text.match(/\s-b\s+(['"])([^'"]+)\1/);
  if (!out.cookies && curlB) out.cookies = curlB[2].trim();
  const curlUa = text.match(/-H\s+['"]user-agent:\s*([^'"]+)['"]/i) || text.match(/-A\s+['"]([^'"]+)['"]/i);
  if (curlUa) out.ua = curlUa[1].trim();
  const bearer = text.match(/authorization:\s*bearer\s+([A-Za-z0-9._\-]+)/i);
  if (bearer) out.token = bearer[1];
  if (!out.cookies) {
    if (text.includes("access_token_web=")) out.cookies = text.replace(/^cookie:\s*/i, "").trim();
    else if (/^[A-Za-z0-9._\-]{20,}$/.test(text)) out.cookies = "access_token_web=" + text;   // alleen de token-waarde
    else if (text.includes("=")) out.cookies = text;
  }
  if (/\.vinted\./.test(out.cookies) && out.cookies.split("=").length === 2) out.cookies = "access_token_web=" + out.cookies;
  if (/^https?:\/\//i.test(out.cookies)) out.cookies = "";   // geplakte URL is geen cookie
  if (!out.token) {
    const m = out.cookies.match(/access_token_web=([^;\s]+)/);
    if (m) out.token = m[1];
  }
  out.cookies = out.cookies.replace(/[\r\n]+/g, " ").slice(0, 4000);
  out.ua = out.ua.slice(0, 300);
  return out;
}

function throttleVinted() {
  const wait = 1200 - (Date.now() - lastFetchAt);
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  lastFetchAt = Date.now();
}

// één Vinted API-call met de sessie van de gebruiker; geeft status + json terug
function vintedFetch(sess, apiPath, opts = {}) {
  const method = opts.method || "GET";
  const timeoutMs = opts.timeoutMs || 20000;
  throttleVinted();
  const args = ["-s", "-m", String(Math.ceil(timeoutMs / 1000))];
  if (method !== "GET") args.push("-X", method);
  args.push(
    "-A", (sess && sess.ua) || UA,
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",
    "-H", "X-Requested-With: XMLHttpRequest",
    "-H", "Referer: " + VINTED_HOST + "/",
  );
  if (sess && sess.cookies) args.push("-H", "Cookie: " + sess.cookies);
  if (sess && sess.token) args.push("-H", "Authorization: Bearer " + sess.token);
  if (sess && sess.csrf) args.push("-H", "X-CSRF-Token: " + sess.csrf);
  if (opts.json) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(opts.json));
  args.push("-w", "\n__GS_STATUS__%{http_code}", VINTED_HOST + apiPath);
  let out = "";
  try { out = curl(args, timeoutMs).toString("utf8"); }
  catch (e) { return { status: 0, raw: "", json: null, error: e.message }; }
  const m = out.match(/\n__GS_STATUS__(\d+)\s*$/);
  const status = m ? Number(m[1]) : 0;
  const raw = m ? out.slice(0, m.index) : out;
  let json = null;
  try { json = JSON.parse(raw); } catch (e) {}
  return { status, raw, json };
}

function vintedErrMsg(r) {
  if (!r) return "onbekende fout";
  if (r.status === 0) return "Geen antwoord van Vinted (" + (r.error || "timeout") + ")";
  if (r.json && r.json.message) return "Vinted " + r.status + ": " + r.json.message;
  if (r.status === 401 || r.status === 400) return "Vinted-sessie ongeldig of verlopen — koppel opnieuw.";
  if (r.status === 403) return "Vinted blokkeert dit verzoek (botcontrole) — probeer het later opnieuw.";
  if (r.status === 404) return "Dit endpoint bestaat niet (meer) bij Vinted (404).";
  if (r.status === 429) return "Te veel verzoeken — wacht even en probeer opnieuw.";
  return "Vinted gaf status " + r.status;
}

/* ---- inloggen met je Vinted-account zelf (e-mail + wachtwoord) ----
   Vinted heeft geen OAuth voor derden, maar het web-login-endpoint
   (POST /oauth/token met grant_type=password) accepteert gewone Vinted-
   inloggegevens. Daarmee halen we een access_token + refresh_token op,
   zodat de gebruiker alleen nog e-mail + wachtwoord hoeft in te vullen.
   Het wachtwoord wordt NIET opgeslagen. */
/* Vinted zet bij het eerste bezoek een DataDome-cookie. Zonder die cookie ziet
   hun botbeveiliging een kale POST naar het inlog-endpoint (zeker vanaf een
   datacenter-IP) en blokkeert die met 403. Daarom warmen we eerst de cookies op
   en sturen we ze mee met het inlogverzoek. */
function vintedWarmCookies(paths) {
  for (const p of paths) {
    try {
      curl([
        "-b", JAR, "-c", JAR, "-A", UA,
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",
        "-H", "Referer: " + VINTED_HOST + "/",
        VINTED_HOST + p,
      ], 20000);
    } catch (e) { /* volgende pad */ }
  }
}

function jarCookieNames() {
  try {
    return fs.readFileSync(JAR, "utf8")
      .split(/\r?\n/)
      .filter(l => l && l[0] !== "#")
      .map(l => (l.split("\t")[5] || "").trim())
      .filter(Boolean);
  } catch (e) { return []; }
}

function vintedOauth(params) {
  const body = Object.keys(params)
    .filter(k => params[k] != null)
    .map(k => k + "=" + encodeURIComponent(params[k]))
    .join("&");
  const args = [
    "-X", "POST",
    "-b", JAR, "-c", JAR,          // meenemen: DataDome- + sessiecookies
    "-A", UA,
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",
    "-H", "X-Requested-With: XMLHttpRequest",
    "-H", "Origin: " + VINTED_HOST,
    "-H", "Referer: " + VINTED_HOST + "/login",
    "-d", body,
    "-w", "\n__GS_STATUS__%{http_code}",
    VINTED_HOST + "/oauth/token",
  ];
  let out = "";
  try { out = curl(args, 25000).toString("utf8"); }
  catch (e) { return { status: 0, raw: "", json: null, error: e.message }; }
  const m = out.match(/\n__GS_STATUS__(\d+)\s*$/);
  const status = m ? Number(m[1]) : 0;
  const raw = m ? out.slice(0, m.index) : out;
  let json = null;
  try { json = JSON.parse(raw); } catch (e) {}
  return { status, raw, json };
}

function vintedLoginWithCredentials(username, password) {
  throttleVinted();
  // eerst de inlogpagina bezoeken zodat Vinted z'n DataDome-cookie zet
  vintedWarmCookies(["/login", "/"]);
  const params = { grant_type: "password", username, password, client_id: "web", scope: "default" };
  let r = vintedOauth(params);
  // geblokkeerd? cookies verversen en één keer opnieuw proberen
  if (r.status === 403 || r.status === 429) {
    console.log("[vinted] login geblokkeerd (" + r.status + ") — cookies verversen en opnieuw proberen");
    vintedWarmCookies(["/", "/login"]);
    throttleVinted();
    r = vintedOauth(params);
  }
  if (r.status === 200 && r.json && r.json.access_token) {
    return {
      ok: true,
      token: r.json.access_token,
      refreshToken: r.json.refresh_token || "",
      expiresIn: Number(r.json.expires_in) || 3600,
    };
  }
  // altijd loggen wat Vinted teruggeeft: dit is precies waar het misgaat
  console.log(`[vinted] login-antwoord: status=${r.status} cookies=[${jarCookieNames().join(",").slice(0, 90)}] body=${String(r.raw || "").replace(/\s+/g, " ").slice(0, 240)}`);
  if (r.status === 0) return { ok: false, error: "onbereikbaar", message: "Geen antwoord van Vinted (" + (r.error || "timeout") + "). Probeer het opnieuw." };
  if (r.status === 403 || r.status === 429) {
    const body = String(r.raw || "");
    const dataDome = /datadome|captcha-delivery|geo\.captcha/i.test(body);
    return {
      ok: false,
      error: "geblokkeerd",
      dataDome,
      message: dataDome
        ? "Vinted blokkeert inloggen vanaf onze server (botcontrole). Gebruik daarom de makkelijke koppeling via je eigen browser hieronder — die werkt altijd."
        : "Vinted gaf een blokkade (" + r.status + "). Probeer het over een paar minuten opnieuw.",
      detail: body.slice(0, 200),
    };
  }
  const desc = String((r.json && r.json.error_description) || "");
  if (/two.?factor|verification|verificatie|2fa|sms|code/i.test(desc)) {
    return { ok: false, error: "2fa", message: "Dit Vinted-account gebruikt tweestapsverificatie. Zet die even uit tijdens het koppelen, of gebruik de andere manier hieronder." };
  }
  if (r.status === 400 || r.status === 401) {
    return { ok: false, error: "verkeerde_gegevens", message: "Vinted-login mislukt — controleer je e-mailadres en wachtwoord van Vinted." };
  }
  return { ok: false, error: "onbekend", message: "Vinted gaf status " + r.status + ((r.json && r.json.error) ? " (" + r.json.error + ")" : "") };
}

/* verlopen access_token stil vernieuwen met de refresh_token */
function vintedRefresh(sess) {
  if (!sess || !sess.refreshToken) return false;
  const r = vintedOauth({ grant_type: "refresh_token", refresh_token: sess.refreshToken, client_id: "web" });
  if (r.status !== 200 || !r.json || !r.json.access_token) return false;
  sess.token = r.json.access_token;
  if (r.json.refresh_token) sess.refreshToken = r.json.refresh_token;
  sess.tokenExpiresAt = Date.now() + (Number(r.json.expires_in) || 3600) * 1000;
  sess.cookies = "access_token_web=" + sess.token;
  sess.lastStatus = "ok";
  return true;
}

// houdt de Vinted-toegang vers zolang de refresh_token geldig is
function vintedEnsureFresh(sess) {
  if (!sess || !sess.refreshToken || !sess.tokenExpiresAt) return sess;
  if (Date.now() > sess.tokenExpiresAt - 120000) {
    const ok = vintedRefresh(sess);
    console.log("[vinted] token vernieuwen:", ok ? "ok" : "mislukt");
    if (ok) saveStore();
    else sess.lastStatus = "verlopen";
  }
  return sess;
}

function vintedValidate(sess) {
  const r = vintedFetch(sess, "/api/v2/users/me", { timeoutMs: 20000 });
  if (r.status !== 200 || !r.json) return { ok: false, error: vintedErrMsg(r), status: r.status };
  const u = r.json.user || r.json.current_user || r.json;
  if (!u || !u.id) return { ok: false, error: "Vinted-antwoord zonder gebruiker", status: r.status };
  return { ok: true, user: u };
}

function mapVintedUser(u) {
  const photo = u.photo || u.avatar || null;
  const avatar = (photo && (photo.url || photo.full_size_url || photo.thumb_url)) || u.avatar_url || "";
  const feedbackCount = u.feedback_count != null ? Number(u.feedback_count) : null;
  const positive = u.positive_feedback_count != null ? Number(u.positive_feedback_count) : null;
  return {
    memberId: String(u.id || ""),
    username: u.login || u.username || u.name || "",
    avatar: String(avatar).slice(0, 300),
    rating: (feedbackCount && positive != null) ? Math.round((positive / feedbackCount) * 50) / 10 : null,
    reviews: feedbackCount,
    followers: u.follower_count != null ? u.follower_count : null,
    following: u.following_count != null ? u.following_count : null,
    location: u.city || u.country_title || u.location || "",
    itemCount: u.item_count != null ? u.item_count : null,
    balance: (u.balance && (u.balance.available || u.balance.amount)) || null,
    profileUrl: "https://www.vinted.nl/member/" + (u.id || ""),
    session: true,
  };
}

// zoekt in een Vinted-antwoord de lijst die we zoeken (API-vormen verschillen per versie)
function firstArray(obj, keys) {
  if (!obj || typeof obj !== "object") return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  for (const k of keys) if (obj[k] && typeof obj[k] === "object") {
    for (const kk of keys) if (Array.isArray(obj[k][kk])) return obj[k][kk];
  }
  return [];
}
function mapVintedItem(it) {
  const photo = (Array.isArray(it.photos) && it.photos[0]) || it.photo || null;
  const image = photo ? (photo.url || photo.full_size_url || photo.thumb_url || photo.dominant_color_url || "") : "";
  const price = (it.price && (it.price.amount || it.price)) || it.total_item_price || null;
  return {
    id: String(it.id || it.item_id || ""),
    title: String(it.title || it.name || "").slice(0, 120),
    brand: String(it.brand || it.brand_title || (it.brand_dto && it.brand_dto.title) || "").slice(0, 60),
    size: String(it.size_title || it.size || "").slice(0, 20),
    price: price != null && price !== "" ? Number(price) : null,
    image: String(image).slice(0, 300),
    url: it.url || it.path || (it.id ? "https://www.vinted.nl/items/" + it.id : ""),
    views: it.view_count != null ? it.view_count : null,
    favourites: it.favourite_count != null ? it.favourite_count : null,
    status: it.status || it.state || "",
    createdAt: it.created_at_ts ? it.created_at_ts * 1000 : (it.created_at ? Date.parse(it.created_at) : null),
  };
}
function mapVintedThread(c, usersById) {
  const withUser = c.user || c.other_user || (usersById && usersById[String(c.user_id || c.other_user_id)]) || null;
  const last = c.last_message || c.latest_message || null;
  const offer = c.offer || c.item_offer || (last && last.offer) || null;
  return {
    id: String(c.id || ""),
    unread: !!c.unread || Number(c.unread_count || 0) > 0,
    updatedAt: c.updated_at_ts ? c.updated_at_ts * 1000 : (c.updated_at ? Date.parse(c.updated_at) : null),
    username: (withUser && (withUser.login || withUser.username)) || c.user_login || "",
    avatar: (withUser && withUser.photo && (withUser.photo.url || withUser.photo.thumb_url)) || "",
    itemId: c.item_id != null ? String(c.item_id) : (c.item && String(c.item.id)) || "",
    itemTitle: (c.item && (c.item.title || c.item.name)) || "",
    preview: String((last && (last.body || last.text)) || c.preview || "").slice(0, 160),
    offer: offer ? { amount: Number(offer.amount || offer.price || 0) || null, status: offer.status || "" } : null,
  };
}
function mapVintedMessage(m, usersById) {
  const withUser = m.user || (usersById && usersById[String(m.user_id)]) || null;
  return {
    id: String(m.id || ""),
    body: String(m.body || m.text || "").slice(0, 2000),
    createdAt: m.created_at_ts ? m.created_at_ts * 1000 : (m.created_at ? Date.parse(m.created_at) : null),
    mine: !!(m.is_mine || m.by_current_user || m.mine),
    username: (withUser && (withUser.login || withUser.username)) || m.user_login || "",
    offer: m.offer ? { amount: Number(m.offer.amount || m.offer.price || 0) || null, status: m.offer.status || "" } : null,
  };
}
// CSRF-token ophalen (Vinted wil die bij POST's)
function vintedCsrf(sess) {
  try {
    throttleVinted();
    const html = curl([
      "-s", "-m", "20", "-A", (sess && sess.ua) || UA,
      "-H", "Accept: text/html,application/xhtml+xml",
      "-H", "Accept-Language: nl-NL,nl;q=0.9",
      "-H", "Cookie: " + ((sess && sess.cookies) || ""),
      VINTED_HOST + "/",
    ], 20000).toString("utf8");
    const m = html.match(/name="csrf-token"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+name="csrf-token"/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}

/* ---------------- Utility ---------------- */

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const cache = new Map(); // query -> { at, body }
const CACHE_TTL = 5 * 60 * 1000;

function sendJson(res, status, body, cors = true) {
  const data = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  // auth-endpoints bewust zonder wildcard-CORS: alleen de app zelf mag daar bij
  if (cors) headers["Access-Control-Allow-Origin"] = "*";
  res.writeHead(status, headers);
  res.end(data);
}

function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => {
      raw += c;
      if (raw.length > maxBytes) { reject(new Error("te_groot")); try { req.destroy(); } catch (e) {} }
    });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("ongeldige_json")); } });
    req.on("error", reject);
  });
}

/* ---------------- HTTP server ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  /* ---- Accounts + app-data (server-side → login werkt op elk apparaat) ---- */
  if (u.pathname.startsWith("/api/auth/") || u.pathname === "/api/state") {
    let body = {};
    if (req.method === "POST") {
      try { body = await readJsonBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message === "te_groot" ? "te_groot" : "ongeldige_request" }, false); }
    }
    const token = String(body.token || u.searchParams.get("token") || "");
    const action = u.pathname === "/api/state" ? "state" : u.pathname.slice("/api/auth/".length);

    // ---- registreren ----
    if (action === "register" && req.method === "POST") {
      const email = normEmail(body.email);
      const pass = String(body.pass || "");
      const name = String(body.name || "").trim().slice(0, 60) || email.split("@")[0];
      const secQ = String(body.secQ || "").trim().slice(0, 200);
      const secA = normAnswer(body.secA).slice(0, 200);
      if (!validEmail(email)) return sendJson(res, 200, { ok: false, error: "ongeldig_email" }, false);
      if (pass.length < 4) return sendJson(res, 200, { ok: false, error: "wachtwoord_te_kort" }, false);
      if (store.users[email]) return sendJson(res, 200, { ok: false, error: "bestaat_al" }, false);
      const pw = hashSecret(pass);
      const sec = secA && secA.length >= 2 ? hashSecret(secA) : null;
      store.users[email] = {
        email, name,
        passHash: pw.hash, passSalt: pw.salt,
        secQ: sec ? secQ : "", secHash: sec ? sec.hash : "", secSalt: sec ? sec.salt : "",
        created: Date.now(), data: null, dataUpdatedAt: 0,
      };
      const t = createSession(email);
      saveStore(true);
      console.log(`[auth] account aangemaakt: ${email}`);
      return sendJson(res, 200, { ok: true, token: t, user: publicUser(store.users[email]) }, false);
    }

    // ---- inloggen ----
    if (action === "login" && req.method === "POST") {
      const email = normEmail(body.email);
      const pass = String(body.pass || "");
      const key = clientIp(req) + "|" + email;
      const gate = failLeft(key);
      if (gate.blocked) return sendJson(res, 200, { ok: false, error: "te_vaak" }, false);
      const user = store.users[email];
      if (!user) {
        noteFail(key);
        return sendJson(res, 200, { ok: false, error: "geen_account", left: failLeft(key).left }, false);
      }
      if (!verifySecret(pass, { salt: user.passSalt, hash: user.passHash })) {
        noteFail(key);
        return sendJson(res, 200, { ok: false, error: "onjuist", left: failLeft(key).left }, false);
      }
      clearFails(key);
      const t = createSession(email);
      saveStore(true);
      return sendJson(res, 200, { ok: true, token: t, user: publicUser(user), dataUpdatedAt: user.dataUpdatedAt || 0 }, false);
    }

    // ---- sessie controleren (bij het openen van de app) ----
    if (action === "me") {
      const email = tokenEmail(token);
      if (!email) return sendJson(res, 200, { ok: false, error: "geen_sessie" }, false);
      return sendJson(res, 200, {
        ok: true,
        user: publicUser(store.users[email]),
        dataUpdatedAt: store.users[email].dataUpdatedAt || 0,
        // overleeft de accountopslag een restart/redeploy/spin-down?
        persistent: KV_ENABLED || PERSISTENT_DATA,
        storeBackend: STORE_BACKEND,
        storeDir: KV_ENABLED ? "(externe store)" : DATA_DIR,
        accounts: Object.keys(store.users).length,
      }, false);
    }

    // ---- uitloggen ----
    if (action === "logout" && req.method === "POST") {
      if (token && store.sessions[token]) { delete store.sessions[token]; saveStore(true); }
      return sendJson(res, 200, { ok: true }, false);
    }

    // ---- app-data laden (items, kasboek, plan/quota) ----
    if (action === "state" && req.method !== "POST") {
      const email = tokenEmail(token);
      if (!email) return sendJson(res, 200, { ok: false, error: "geen_sessie" }, false);
      const user = store.users[email];
      return sendJson(res, 200, { ok: true, data: user.data || null, updatedAt: user.dataUpdatedAt || 0 }, false);
    }

    // ---- app-data opslaan ----
    if (action === "state" && req.method === "POST") {
      const email = tokenEmail(token);
      if (!email) return sendJson(res, 200, { ok: false, error: "geen_sessie" }, false);
      const payload = JSON.stringify(body.data || null);
      if (payload.length > MAX_STATE_BYTES) return sendJson(res, 200, { ok: false, reason: "te_groot" }, false);
      const user = store.users[email];
      user.data = body.data || null;
      user.dataUpdatedAt = Number(body.updatedAt) || Date.now();
      saveStore();
      return sendJson(res, 200, { ok: true, updatedAt: user.dataUpdatedAt }, false);
    }

    // ---- oude accounts van dit apparaat eenmalig naar de server verhuizen ----
    if (action === "import" && req.method === "POST") {
      const list = Array.isArray(body.accounts) ? body.accounts.slice(0, 25) : [];
      const results = {}; const tokens = {};
      for (const acc of list) {
        const email = normEmail(acc && acc.email);
        const pass = String((acc && acc.pass) || "");
        if (!validEmail(email) || pass.length < 4) { if (email) results[email] = "overgeslagen"; continue; }
        const existing = store.users[email];
        if (existing) {
          if (verifySecret(pass, { salt: existing.passSalt, hash: existing.passHash })) {
            results[email] = "bestond_al"; tokens[email] = createSession(email);
          } else { results[email] = "bestaat_met_ander_wachtwoord"; }
          continue;
        }
        const pw = hashSecret(pass);
        const secA = normAnswer(acc.secA).slice(0, 200);
        const sec = secA.length >= 2 ? hashSecret(secA) : null;
        store.users[email] = {
          email,
          name: String(acc.name || "").trim().slice(0, 60) || email.split("@")[0],
          passHash: pw.hash, passSalt: pw.salt,
          secQ: sec ? String(acc.secQ || "").trim().slice(0, 200) : "",
          secHash: sec ? sec.hash : "", secSalt: sec ? sec.salt : "",
          created: Date.now(), data: null, dataUpdatedAt: 0,
        };
        results[email] = "verhuisd";
        tokens[email] = createSession(email);
      }
      // meteen ook de app-data van dit apparaat meenemen
      const dataEmail = normEmail(body.dataEmail);
      if (dataEmail && store.users[dataEmail] && body.data && !store.users[dataEmail].data) {
        store.users[dataEmail].data = body.data;
        store.users[dataEmail].dataUpdatedAt = Number(body.data.updatedAt) || Date.now();
      }
      saveStore(true);
      const moved = Object.values(results).filter(r => r === "verhuisd").length;
      if (moved) console.log(`[auth] ${moved} account(s) van dit apparaat verhuisd naar de server`);
      return sendJson(res, 200, { ok: true, results, tokens }, false);
    }

    // ---- wachtwoord vergeten: stap 1 — beveiligingsvraag opvragen ----
    if (action === "forgot/question" && req.method === "POST") {
      const email = normEmail(body.email);
      if (!validEmail(email)) return sendJson(res, 200, { ok: false, error: "ongeldig_email" }, false);
      const user = store.users[email];
      if (!user) return sendJson(res, 200, { ok: false, error: "geen_account" }, false);
      if (!user.secQ || !user.secHash) return sendJson(res, 200, { ok: false, error: "geen_vraag" }, false);
      forgotTries.delete(email);
      return sendJson(res, 200, { ok: true, secQ: user.secQ }, false);
    }

    // ---- wachtwoord vergeten: stap 2 — antwoord controleren (max 3 pogingen) ----
    if (action === "forgot/verify" && req.method === "POST") {
      const email = normEmail(body.email);
      const user = store.users[email];
      if (!user || !user.secHash) return sendJson(res, 200, { ok: false, error: "verlopen" }, false);
      let rec = forgotTries.get(email);
      if (!rec || Date.now() - rec.at > 30 * 60 * 1000) rec = { n: 0, at: Date.now() };
      if (rec.n >= 3) return sendJson(res, 200, { ok: false, error: "te_vaak", left: 0 }, false);
      if (!verifySecret(normAnswer(body.answer), { salt: user.secSalt, hash: user.secHash })) {
        rec.n++; rec.at = Date.now(); forgotTries.set(email, rec);
        const left = Math.max(0, 3 - rec.n);
        if (left === 0) forgotTries.delete(email);
        return sendJson(res, 200, { ok: false, error: left === 0 ? "te_vaak" : "onjuist_antwoord", left }, false);
      }
      forgotTries.delete(email);
      return sendJson(res, 200, { ok: true, resetToken: storeReset(email) }, false);
    }

    // ---- wachtwoord vergeten: stap 3 — nieuw wachtwoord zetten ----
    if (action === "forgot/reset" && req.method === "POST") {
      const email = useReset(String(body.resetToken || ""));
      if (!email) return sendJson(res, 200, { ok: false, error: "verlopen" }, false);
      const pass = String(body.newPass || "");
      if (pass.length < 4) return sendJson(res, 200, { ok: false, error: "wachtwoord_te_kort" }, false);
      const user = store.users[email];
      if (!user) return sendJson(res, 200, { ok: false, error: "geen_account" }, false);
      const pw = hashSecret(pass);
      user.passHash = pw.hash; user.passSalt = pw.salt;
      // oude sessies van deze account intrekken, behalve de nieuwe hieronder
      for (const [t, s] of Object.entries(store.sessions)) if (s.email === email) delete store.sessions[t];
      const t = createSession(email);
      saveStore(true);
      return sendJson(res, 200, { ok: true, token: t, user: publicUser(user) }, false);
    }

    // ---- account + data definitief wissen (instellingen → "Wis mijn data") ----
    if (action === "wipe" && req.method === "POST") {
      const email = tokenEmail(token);
      if (!email) return sendJson(res, 200, { ok: false, error: "geen_sessie" }, false);
      delete store.users[email];
      for (const [t, s] of Object.entries(store.sessions)) if (s.email === email) delete store.sessions[t];
      saveStore(true);
      console.log(`[auth] account gewist: ${email}`);
      return sendJson(res, 200, { ok: true }, false);
    }

    return sendJson(res, 404, { ok: false, error: "onbekend_auth_endpoint" }, false);
  }

  // ---- AI-status (voor de app) ----
  if (u.pathname === "/api/ai/status") {
    const k = readApiKey();
    return sendJson(res, 200, { aiReady: !!k });
  }

  // ---- AI foto-analyse ----
  if (u.pathname === "/api/analyze" && req.method === "POST") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 15 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const { prompt, images } = JSON.parse(raw);
        if (!prompt) return sendJson(res, 400, { error: "prompt ontbreekt" });
        const result = await callGeminiServer(prompt, images);
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        if (e.noKey) return sendJson(res, 200, { ok: false, reason: "geen_sleutel" });
        console.log("[ai] analyze mislukt:", e.message);
        return sendJson(res, 200, { ok: false, reason: "ai_fout", error: e.message });
      }
    });
    return;
  }

  // ---- Vinted endpoint ----
  if (u.pathname === "/api/vinted") {
    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return sendJson(res, 400, { error: "query param 'q' ontbreekt" });

    const key = q.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      return sendJson(res, 200, { ...hit.body, cached: true });
    }

    try {
      let comps = parseCatalogHtml(fetchCatalogHtml(q));

      // relevantie: bewaar items die minstens één zoekterm bevatten
      if (comps.length > 6) {
        const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (words.length) {
          const scored = comps.filter(c => {
            const hay = (c.title + " " + c.brand).toLowerCase();
            return words.some(w => hay.includes(w));
          });
          if (scored.length >= 5) comps = scored;
        }
      }

      if (comps.length < 3) {
        return sendJson(res, 200, { ok: false, reason: "te_weinig_resultaten", comps: [] });
      }

      const body = {
        ok: true,
        count: comps.length,
        comps: comps.slice(0, 12),
        stats: {
          median: Math.round(median(comps.map(c => c.price)) * 100) / 100,
          p25: Math.round(percentile(comps.map(c => c.price), 0.25) * 100) / 100,
          p75: Math.round(percentile(comps.map(c => c.price), 0.75) * 100) / 100,
        },
      };
      cache.set(key, { at: Date.now(), body });
      console.log(`[vinted] "${q}" → ${comps.length} items (mediaan €${body.stats.median})`);
      return sendJson(res, 200, body);
    } catch (e) {
      console.log(`[vinted] "${q}" mislukt:`, e.message);
      return sendJson(res, 200, {
        ok: false,
        reason: e.blocked ? "geblokkeerd_door_vinted" : "onbereikbaar",
        error: e.message,
      });
    }
  }

  // ---- AI gewicht/volume schatting voor verzendcalculator (link → AI) ----
  if (u.pathname === "/api/ship-estimate" && req.method === "POST") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const url = String(body.url || "").trim();
        if (!url) return sendJson(res, 400, { error: "url ontbreekt" });
        let parsed; try { parsed = new URL(url); } catch { return sendJson(res, 400, { error: "ongeldige url" }); }
        if (!["http:", "https:"].includes(parsed.protocol)) return sendJson(res, 400, { error: "alleen http(s)" });
        // cache
        const key = "ship-est:" + url.toLowerCase();
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL) return sendJson(res, 200, { ...hit.body, cached: true });

        // context voor AI: titel/host uit body of vers ophalen via /api/product-achtig
        let title = String(body.title || "").trim().slice(0, 160);
        let host = String(body.host || parsed.hostname).slice(0, 80);
        let priceHint = body.price != null ? Number(body.price) : null;
        let weightHint = body.weightKg != null ? Number(body.weightKg) : null;
        // als geen titel, probeer OG-title te halen (kort, zonder jar-vervuiling)
        if (!title) {
          try {
            const html = curl(["-L", "-A", UA, "-H", "Accept: text/html,application/xhtml+xml", "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8", url], 12000).toString("utf8");
            const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
            title = og.trim().slice(0, 160).replace(/\s+/g, " ");
            if (!priceHint) {
              const ogPrice = html.match(/<meta[^>]+property=["'](?:og:price:amount|product:price:amount)["'][^>]*content=["']([0-9.,]+)["']/i);
              if (ogPrice) priceHint = parseFloat(ogPrice[1].replace(",", "."));
            }
          } catch {}
        }

        // presets voor fallback/validatie (server-kant)
        const PRESETS = {
          "t-shirt": [0.20, [30,25,2]], "hoodie": [0.55,[35,30,6]], "sweater": [0.50,[35,30,5]], "jas": [1.10,[45,35,10]],
          "broek": [0.45,[35,25,4]], "jeans": [0.65,[35,25,5]], "jurk": [0.35,[35,25,4]], "sneakers": [1.05,[34,20,13]],
          "schoenen": [0.90,[32,18,12]], "tas": [0.60,[35,25,15]], "accessoire": [0.15,[25,20,8]], "overig": [0.40,[30,20,10]]
        };
        function guessType(s){
          const t=(s||"").toLowerCase();
          if(/hoodie|hoody|zip\s*hood|sweat.*hood|trui/.test(t)) return "hoodie";
          if(/sneaker|trainer|shoe.*sneak/.test(t)) return "sneakers";
          if(/jeans|denim/.test(t)) return "jeans";
          if(/coat|parka|jacket|jas\b|puffer|down/.test(t)) return "jas";
          if(/\bbag\b|tas\b|backpack|handbag|crossbody/.test(t)) return "tas";
          if(/dress|jurk\b/.test(t)) return "jurk";
          if(/\bpant\b|broek|trouser|chino|cargo.*pant/.test(t)) return "broek";
          if(/tee|t-shirt|tshirt|shirt/.test(t)) return "t-shirt";
          if(/cap|hat|beanie|muts|pet\b|accessoire/.test(t)) return "accessoire";
          if(/schoen|shoe/.test(t)) return "schoenen";
          return "overig";
        }
        function clampEstimate(j){
          const allowed=["t-shirt","hoodie","sweater","jas","broek","jeans","jurk","sneakers","schoenen","tas","accessoire","overig"];
          let t = String(j.item_type||j.type||"").toLowerCase().trim();
          if(!allowed.includes(t)) t = guessType(title+" "+host);
          let w = Number(j.weight_kg ?? j.weightKg ?? j.w);
          let L = Number(j.length_cm ?? j.l ?? j.length);
          let W = Number(j.width_cm ?? j.w2 ?? j.width);
          let H = Number(j.height_cm ?? j.h ?? j.height);
          const fb = PRESETS[t] || PRESETS.overig;
          if(!(w>0 && w<30)) w = fb[0];
          if(!(L>0 && L<120)) L = fb[1][0];
          if(!(W>0 && W<120)) W = fb[1][1];
          if(!(H>0 && H<80)) H = fb[1][2];
          w = Math.round(w*100)/100; L=Math.round(L); W=Math.round(W); H=Math.round(H);
          let p = j.price_eur!=null?Number(j.price_eur): (j.price!=null?Number(j.price):priceHint);
          if(!(p>0 && p<5000)) p=null; else p=Math.round(p*100)/100;
          const conf = ["laag","gemiddeld","hoog"].includes(String(j.confidence))? String(j.confidence): "gemiddeld";
          return { item_type:t, weight_kg:w, length_cm:L, width_cm:W, height_cm:H, price_eur:p, confidence:conf, reason:String(j.reason||"").slice(0,180) };
        }

        const k = readApiKey();
        if (!k) {
          const t = guessType(title+" "+host+" "+url);
          const fb = PRESETS[t];
          const est = { item_type:t, weight_kg:fb[0], length_cm:fb[1][0], width_cm:fb[1][1], height_cm:fb[1][2], price_eur: (priceHint&&isFinite(priceHint)?Math.round(priceHint*100)/100:null), confidence:"laag", reason:"Geen AI-sleutel — preset op basis van titel" };
          const bodyOut = { ok:true, estimate:est, source:"preset", title, host };
          cache.set(key,{at:Date.now(), body:bodyOut});
          return sendJson(res,200, bodyOut);
        }

        const prompt = `Je bent verzend-expert voor Chinese shops (Weidian/Taobao/1688) → EU.\nGegeven PRODUCT_URL: ${url}\nHOST: ${host}\nTITEL: ${title||"(geen titel)"}\nPRICE_HINT: ${priceHint!=null? priceHint+" eur/¥":"onbekend"}\nWEIGHT_HINT: ${weightHint||"onbekend"}\nSchat: item_type (één van [t-shirt,hoodie,sweater,jas,broek,jeans,jurk,sneakers,schoenen,tas,accessoire,overig]), gewicht kg per stuk, afmetingen L×B×H cm gevouwen (realistisch pakket), prijs_eur indien afleidbaar.\nAntwoord ALLEEN geldige JSON: {"item_type":"t-shirt","weight_kg":0.20,"length_cm":30,"width_cm":25,"height_cm":2,"price_eur":null,"confidence":"laag|gemiddeld|hoog","reason":"kort"}\nRichtlijnen gewicht: t-shirt 0.18-0.25, hoodie 0.5-0.65, jeans 0.6-0.8, sneakers 0.9-1.2 incl doos, tas 0.4-0.9, jas 0.9-1.4, accessoire 0.1-0.2. Afmetingen gevouwen: t-shirt 30x25x2, hoodie 35x30x6, sneakers 34x20x13, etc. Wees conservatief.`;
        try {
          const j = await callGeminiServer(prompt, []);
          const est = clampEstimate(j||{});
          const bodyOut = { ok:true, estimate:est, source:"ai", title, host };
          cache.set(key,{at:Date.now(), body:bodyOut});
          console.log(`[ship-estimate] ${host} "${title.slice(0,40)}" → ${est.item_type} ${est.weight_kg}kg ${est.length_cm}x${est.width_cm}x${est.height_cm} (${est.confidence})`);
          return sendJson(res,200, bodyOut);
        } catch (e) {
          console.log("[ship-estimate] AI mislukt:", e.message, "→ fallback preset");
          const t = guessType(title+" "+host);
          const fb = PRESETS[t];
          const est = { item_type:t, weight_kg:fb[0], length_cm:fb[1][0], width_cm:fb[1][1], height_cm:fb[1][2], price_eur: (priceHint&&isFinite(priceHint)?Math.round(priceHint*100)/100:null), confidence:"laag", reason:"AI onbereikbaar — preset" };
          const bodyOut = { ok:true, estimate:est, source:"preset_fallback", title, host, error:e.message };
          cache.set(key,{at:Date.now(), body:bodyOut});
          return sendJson(res,200, bodyOut);
        }
      } catch (e) {
        return sendJson(res, 200, { ok:false, reason:"fout", error:e.message });
      }
    });
    return;
  }

  // ---- AI manuele haul-schatting: vrije tekst → gewicht/volume (zonder link) ----
  if (u.pathname === "/api/ship-manual-estimate" && req.method === "POST") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        let text = String(body.text || body.q || "").trim().slice(0, 800);
        if (!text) return sendJson(res, 400, { error: "tekst ontbreekt — typ bijv. '2x UGG schoenen, Nike Elite tas'" });
        // normaliseer: komma/newline/“ en ” -> scheiden, maar laat AI het echte splitten doen
        const cacheKey = "ship-manual:" + text.toLowerCase().slice(0, 200);
        const hit = cache.get(cacheKey);
        if (hit && Date.now() - hit.at < CACHE_TTL) return sendJson(res, 200, { ...hit.body, cached: true });

        const PRESETS_M = {
          "t-shirt": [0.20, [30,25,2]], "hoodie": [0.55,[35,30,6]], "sweater": [0.50,[35,30,5]], "jas": [1.10,[45,35,10]],
          "broek": [0.45,[35,25,4]], "jeans": [0.65,[35,25,5]], "jurk": [0.35,[35,25,4]], "sneakers": [1.05,[34,20,13]],
          "schoenen": [1.00,[34,20,14]], "tas": [0.60,[35,25,15]], "accessoire": [0.15,[25,20,8]], "overig": [0.40,[30,20,10]]
        };
        function guessTypeM(s){
          const t=(s||"").toLowerCase();
          if(/ugg|boot|laars|timberland|dr\.\s*martens|drmartens/.test(t)) return "schoenen";
          if(/hoodie|hoody|zip\s*hood|sweat.*hood|trui/.test(t)) return "hoodie";
          if(/sneaker|trainer|air\s*max|jordan|dunk|yeezy/.test(t)) return "sneakers";
          if(/jeans|denim/.test(t)) return "jeans";
          if(/coat|parka|jacket|puffer|doudoune|jas\b/.test(t)) return "jas";
          if(/\btas\b|bag|backpack|handbag|crossbody|elite\s*tas|duffel|shoulder\s*bag/.test(t)) return "tas";
          if(/dress|jurk\b/.test(t)) return "jurk";
          if(/\bpant\b|broek|trouser|chino|cargo.*pant/.test(t)) return "broek";
          if(/sweater|knit|pullover/.test(t)) return "sweater";
          if(/tee|t-shirt|tshirt|shirt/.test(t)) return "t-shirt";
          if(/cap|hat|beanie|muts|pet\b|accessoire|sjaal|handschoen/.test(t)) return "accessoire";
          if(/schoen|shoe|loafer|mocassin|clog/.test(t)) return "schoenen";
          return "overig";
        }
        function clampOne(j, fallbackText){
          const allowed=["t-shirt","hoodie","sweater","jas","broek","jeans","jurk","sneakers","schoenen","tas","accessoire","overig"];
          let t = String(j.item_type||j.type||"").toLowerCase().trim();
          if(!allowed.includes(t)) t = guessTypeM(String(j.raw||j.title||fallbackText||""));
          let w = Number(j.weight_kg ?? j.weightKg ?? j.w);
          let L = Number(j.length_cm ?? j.l ?? j.length);
          let W = Number(j.width_cm ?? j.w2 ?? j.width);
          let H = Number(j.height_cm ?? j.h ?? j.height);
          let q = parseInt(j.qty ?? j.aantal ?? "1",10); if(!(q>=1 && q<=99)) q=1;
          const fb = PRESETS_M[t] || PRESETS_M.overig;
          if(!(w>0 && w<30)) w = fb[0];
          if(!(L>0 && L<120)) L = fb[1][0];
          if(!(W>0 && W<120)) W = fb[1][1];
          if(!(H>0 && H<80)) H = fb[1][2];
          w = Math.round(w*100)/100; L=Math.round(L); W=Math.round(W); H=Math.round(H);
          const conf = ["laag","gemiddeld","hoog"].includes(String(j.confidence))? String(j.confidence): "gemiddeld";
          const rawTitle = String(j.raw || j.title || fallbackText || t).slice(0,80).trim() || PRESETS_M[t] ? t : "item";
          return { item_type:t, qty:q, weight_kg:w, length_cm:L, width_cm:W, height_cm:H, confidence:conf, raw: rawTitle, reason:String(j.reason||"").slice(0,140) };
        }
        // fallback zonder AI: split op komma/newline/en/;
        function fallbackFromText(txt){
          const parts = txt.split(/[,;\n]+|\s+en\s+|\s+&\s+/i).map(s=>s.trim()).filter(Boolean).slice(0,12);
          if(parts.length===0) parts.push(txt);
          return parts.map(p=>{
            let q=1, rest=p;
            let m = p.match(/^\s*(\d+)\s*[x×]\s*(.+)/i);
            if(m){ q=Math.min(99,Math.max(1,parseInt(m[1],10)||1)); rest=m[2].trim(); }
            else {
              m = p.match(/^\s*(\d+)\s+(.+)/);
              if(m && guessTypeM(m[2])!=="overig" || (m && /hoodie|jean|tas|schoen|sneaker|ugg|broek|jas|trui|sweater|t-shirt/i.test(m[2]))){ q=Math.min(99,Math.max(1,parseInt(m[1],10)||1)); rest=m[2].trim(); }
            }
            const t = guessTypeM(rest);
            const fb=PRESETS_M[t];
            return { item_type:t, qty:q, weight_kg:fb[0], length_cm:fb[1][0], width_cm:fb[1][1], height_cm:fb[1][2], confidence:"laag", raw: rest.slice(0,80), reason:"preset op basis van tekst (geen AI)" };
          });
        }

        const k = readApiKey();
        if (!k) {
          const ests = fallbackFromText(text);
          const bodyOut = { ok:true, source:"preset", estimates: ests, text };
          cache.set(cacheKey,{at:Date.now(), body:bodyOut});
          return sendJson(res,200, bodyOut);
        }
        const prompt = `Je bent verzend-expert voor Chinese shops (Weidian/Taobao/1688 etc) → verzending naar EU.\nGebruiker typt vrij wat hij in zijn haul heeft (zonder link). Tekst: "${text.replace(/"/g,"'").slice(0,600)}"\n\nTaak: splits in losse items (herken aantallen zoals "2x UGG schoenen" = qty 2, "Nike Elite tas" = qty 1, komma/enter = nieuw item, "en" = nieuw item). Voor elk item schat: item_type (één van [t-shirt,hoodie,sweater,jas,broek,jeans,jurk,sneakers,schoenen,tas,accessoire,overig]), qty (1-99), gewicht kg per stuk, afmetingen L×B×H cm gevouwen (realistisch pakket incl. doos voor schoenen), confidence (laag/gemiddeld/hoog).\nVoorbeelden: "2x UGG schoenen" → schoenen 1.0kg 34×20×14, "Nike Elite tas" → tas 0.65kg 35×25×15, "hoodie" → 0.55kg 35×30×6.\nAntwoord ALLEEN geldige JSON array, geen uitleg: [{"raw":"UGG schoenen","item_type":"schoenen","qty":2,"weight_kg":1.0,"length_cm":34,"width_cm":20,"height_cm":14,"confidence":"gemiddeld","reason":"kort"}]\nRichtlijnen gewicht: t-shirt 0.18-0.25, hoodie 0.5-0.65, sweater 0.45-0.6, jas 0.9-1.6, jeans 0.6-0.8, broek 0.4-0.6, sneakers 0.9-1.2 incl doos, schoenen/boots/UGG 0.9-1.4, tas 0.4-0.9 (Elite/duffel 0.6-0.9), accessoire 0.1-0.25. Afmetingen: t-shirt 30x25x2, hoodie 35x30x6, schoenen/boots 34x20x14, sneakers 34x20x13, tas 35x25x15, jas 45x35x10. Wees conservatief.`;
        try {
          const rawJ = await callGeminiServer(prompt, []);
          let arr = Array.isArray(rawJ) ? rawJ : (rawJ.estimates || rawJ.items || (rawJ.item_type ? [rawJ] : []));
          if(!Array.isArray(arr) || arr.length===0) throw new Error("lege AI response");
          let ests = arr.slice(0,12).map(j=> clampOne(j||{}, text));
          // qty cap en merge duplicate raws? laat los
          const bodyOut = { ok:true, source:"ai", estimates: ests, text };
          cache.set(cacheKey,{at:Date.now(), body:bodyOut});
          console.log(`[ship-manual] "${text.slice(0,50)}" → ${ests.length} items AI (${ests.map(e=>e.qty+"×"+e.item_type).join(", ")})`);
          return sendJson(res,200, bodyOut);
        } catch (e) {
          console.log("[ship-manual] AI mislukt:", e.message, "→ fallback");
          const ests = fallbackFromText(text);
          const bodyOut = { ok:true, source:"preset_fallback", estimates: ests, text, error:e.message };
          cache.set(cacheKey,{at:Date.now(), body:bodyOut});
          return sendJson(res,200, bodyOut);
        }
      } catch (e) {
        return sendJson(res, 200, { ok:false, reason:"fout", error:e.message });
      }
    });
    return;
  }

  // ---- Vinted profiel koppelen: /api/vinted/profile?url=... of ?id=... ----
  if (u.pathname === "/api/vinted/profile") {
    const rawUrl = (u.searchParams.get("url") || "").trim();
    const rawId = (u.searchParams.get("id") || "").trim();
    let memberId = rawId;
    let profileUrl = rawUrl;
    if (!memberId && rawUrl) {
      try {
        const m = rawUrl.match(/\/member\/(\d{5,})/);
        if (m) memberId = m[1];
        else if (/^\d{5,}$/.test(rawUrl)) memberId = rawUrl.trim();
      } catch {}
    }
    if (!memberId) return sendJson(res, 400, { error: "Geef ?url=https://www.vinted.nl/member/… of ?id=… op" });
    if (!profileUrl) profileUrl = `https://www.vinted.nl/member/${memberId}`;
    // accepteer ook vinted.com/.fr etc — normaliseer naar .nl voor fetch maar bewaar origineel
    try { new URL(profileUrl); } catch { profileUrl = `https://www.vinted.nl/member/${memberId}`; }
    const cKey = "vinted-profile:" + memberId;
    const cHit = cache.get(cKey);
    if (cHit && Date.now() - cHit.at < CACHE_TTL) return sendJson(res, 200, { ...cHit.body, cached: true });
    try {
      // profiel als "gewone" GET — geen Vinted-jar (verse DataDome, anders session-refresh loop)
      // We gebruiken een aparte jar via -L zonder -b main JAR
      const html = curl(["-L","-A",UA,"-H","Accept: text/html,application/xhtml+xml","-H","Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",profileUrl],20000).toString("utf8");
      const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)||[])[1] || "";
      const ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)||[])[1] || "";
      // username uit <h1 data-testid="profile-username">
      const userM = html.match(/data-testid="profile-username"[^>]*>([^<]+)<\/h1>/);
      const username = (userM ? userM[1].trim() : ogTitle.trim()) || "";
      if (!username && html.length < 50000) throw new Error("profiel niet bereikbaar");
      // rating uit aria-label op rating-button
      const ratingM = html.match(/aria-label="Lid is beoordeeld met een\s*([0-9]+[.,][0-9]+)/);
      const rating = ratingM ? parseFloat(ratingM[1].replace(",",".")) : null;
      const reviewsM = html.match(/>(\d+)\s*reviews</);
      const reviews = reviewsM ? parseInt(reviewsM[1],10) : null;
      const locationM = html.match(/data-testid="profile-location-info--content"[^>]*>([^<]+)</);
      const location = locationM ? locationM[1].trim() : "";
      // volgers/volgend uit aria-label
      const followersM = html.match(/aria-label="(\d+)\s*Volgers"/);
      const followingM = html.match(/aria-label="(\d+)\s*Volgend"/);
      const followers = followersM ? parseInt(followersM[1],10) : null;
      const following = followingM ? parseInt(followingM[1],10) : null;
      // avatar — kies de vinted image met largest f800/f310 etc die bij profiel hoort (eerste images1)
      let avatar = ogImage;
      const avatarM = html.match(/<img[^>]+src="(https:\/\/images[^"']*vinted\.net[^"']+)"[^>]*alt=""/);
      if (avatarM && !avatar) avatar = avatarM[1];
      const body = {
        ok: true,
        memberId,
        profileUrl: `https://www.vinted.nl/member/${memberId}`,
        username,
        avatar: avatar.slice(0,500),
        rating: rating && isFinite(rating) ? rating : null,
        reviews: reviews!=null?reviews:null,
        location,
        followers, following,
      };
      cache.set(cKey,{at:Date.now(), body});
      console.log(`[vinted-profile] ${memberId} → @${username} ★${rating||"?"} · ${followers||0} volgers`);
      return sendJson(res,200, body);
    } catch(e){
      return sendJson(res,200,{ ok:false, reason:"onbereikbaar", error:e.message, memberId });
    }
  }

  // ---- Vinted closet: /api/vinted/closet?id=… of ?url=…  (zoek via catalog?search_text=username) ----
  if (u.pathname === "/api/vinted/closet") {
    const rawUrl = (u.searchParams.get("url") || "").trim();
    const rawId = (u.searchParams.get("id") || "").trim();
    const limit = Math.min(24, Math.max(1, parseInt(u.searchParams.get("limit")||"12",10)||12));
    let memberId = rawId;
    let profileUrl = rawUrl;
    if (!memberId && rawUrl) { const m=rawUrl.match(/\/member\/(\d{5,})/); if(m) memberId=m[1]; }
    if (!memberId) return sendJson(res,400,{error:"Geef ?url=… (member-link) of ?id=… op"});
    if (!profileUrl) profileUrl = `https://www.vinted.nl/member/${memberId}`;
    const cKey = `vinted-closet:${memberId}:${limit}`;
    const cHit = cache.get(cKey);
    if (cHit && Date.now()-cHit.at < CACHE_TTL) return sendJson(res,200,{...cHit.body, cached:true});
    try{
      // eerst profiel ophalen om username te kennen (vereist voor catalog zoek)
      const profHtml = curl(["-L","-A",UA,"-H","Accept: text/html,application/xhtml+xml","-H","Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",profileUrl],20000).toString("utf8");
      const ogTitle = (profHtml.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)||[])[1] || "";
      const userM = profHtml.match(/data-testid="profile-username"[^>]*>([^<]+)<\/h1>/);
      const username = (userM ? userM[1].trim() : ogTitle.trim()) || "";
      if (!username) throw new Error("kon gebruikersnaam niet bepalen");
      // throttling voor catalog
      const wait = 1200 - (Date.now() - lastFetchAt); if(wait>0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,wait); lastFetchAt=Date.now();
      const catUrl = `${VINTED_HOST}/catalog?search_text=${encodeURIComponent(username)}`;
      const catHtml = curl(["-L","-A",UA,"-H","Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","-H","Accept-Language: nl-NL,nl;q=0.9,en;q=0.8","-H",`Referer: ${VINTED_HOST}/`,catUrl],25000).toString("utf8");
      let comps = parseCatalogHtml(catHtml);
      // beperk tot items die echt bij dit account lijken te horen: filter op username in titel is niet betrouwbaar,
      // Vinted toont via search_text=username alleen closet-items van die user
      // maar als zoekterm generiek is (bv. "shop123"), vallen er ruis-items tussen — extra guard: bewaar max 24.
      const body = {
        ok: true,
        memberId, username,
        count: comps.length,
        items: comps.slice(0, limit).map(c=>({
          id: c.id, title: c.title, brand: c.brand, status: c.status, size: c.size,
          price: c.price, priceWithProtection: c.priceWithProtection, url: c.url,
          // probeer image uit catalog html te halen (data-testid per id)
        })),
      };
      // verrijk met images: parse src bij elk product-item-id (robust: ook --image--img variant)
      const imgById = new Map();
      // variant 1: --image--img
      for(const m of catHtml.matchAll(/product-item-id-(\d+)--image--img[^>]*src="(https:[^"]+)"/g)){
        if(!imgById.has(m[1])) imgById.set(m[1], m[2]);
      }
      // variant 2: direct img onder product-item-id container
      const imgRe = /data-testid="product-item-id-(\d+)[^"]*"[^>]*>[\s\S]{0,800}?<img[^>]+src="(https:[^"]+vinted\.net[^"]+)"/g;
      let im;
      while((im=imgRe.exec(catHtml))!==null){ if(!imgById.has(im[1])) imgById.set(im[1], im[2]); }
      body.items = body.items.map(it=> ({...it, image: (imgById.get(it.id)||"").slice(0,500)}));
      cache.set(cKey,{at:Date.now(), body});
      console.log(`[vinted-closet] ${memberId} @${username} → ${body.items.length}/${comps.length} items`);
      return sendJson(res,200, body);
    }catch(e){
      console.log(`[vinted-closet] ${memberId} mislukt:`, e.message);
      return sendJson(res,200,{ ok:false, reason:e.blocked?"geblokkeerd_door_vinted":"onbereikbaar", error:e.message, memberId });
    }
  }

  // ---- Product-link (Chinese shops) — haalt titel/prijs/gewicht op voor verzendcalculator ----
  if (u.pathname === "/api/product") {
    const rawUrl = (u.searchParams.get("url") || "").trim();
    if (!rawUrl) return sendJson(res, 400, { error: "param 'url' ontbreekt" });
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return sendJson(res, 400, { error: "ongeldige url" }); }
    if (!["http:", "https:"].includes(parsed.protocol)) return sendJson(res, 400, { error: "alleen http(s)" });
    const pKey = rawUrl.toLowerCase();
    const pHit = cache.get("product:" + pKey);
    if (pHit && Date.now() - pHit.at < CACHE_TTL) return sendJson(res, 200, { ...pHit.body, cached: true });
    try {
      // product-pagina's niet via de Vinted cookie-jar (voorkomt vervuiling van Vinted-sessie)
      const html = curl([
        "-L",
        "-A", UA,
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: nl-NL,nl;q=0.9,en;q=0.8",
        rawUrl,
      ], 20000).toString("utf8");
      const title = (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
      const ogPrice = html.match(/<meta[^>]+property=["'](?:og:price:amount|product:price:amount)["'][^>]*content=["']([0-9.,]+)["']/i);
      const priceText = html.match(/(?:¥|CNY|\$)\s*([0-9]+(?:[.,][0-9]+)?)/);
      const weightM = html.match(/([0-9]+(?:[.,][0-9]+)?)\s*(kg|g)\b/i);
      let weightKg = null;
      if (weightM) {
        const v = parseFloat(weightM[1].replace(",", "."));
        weightKg = /g/i.test(weightM[2]) && v > 5 ? v / 1000 : v;
      }
      const price = ogPrice ? parseFloat(ogPrice[1].replace(",", ".")) : (priceText ? parseFloat(priceText[1].replace(",", ".")) : null);
      const image = (html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
      const body = {
        ok: true,
        url: rawUrl,
        host: parsed.hostname,
        title: title.trim().slice(0, 120).replace(/\s+/g, " "),
        price: price && isFinite(price) && price > 0 && price < 5000 ? price : null,
        weightKg: weightKg && isFinite(weightKg) && weightKg > 0 && weightKg < 50 ? Math.round(weightKg * 100) / 100 : null,
        image: image.slice(0, 300),
      };
      cache.set("product:" + pKey, { at: Date.now(), body });
      return sendJson(res, 200, body);
    } catch (e) {
      return sendJson(res, 200, { ok: false, reason: "onbereikbaar", error: e.message, host: parsed.hostname });
    }
  }

  /* ---- Mijn Vinted-account: koppelen, kast, biedingen, berichten ---- */
  if (u.pathname.startsWith("/api/vinted/me/")) {
    let vb = {};
    if (req.method === "POST") {
      try { vb = await readJsonBody(req, 512 * 1024); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "ongeldige_request" }, false); }
    }
    const gtok = String(vb.token || u.searchParams.get("token") || "");
    const email = tokenEmail(gtok);
    if (!email) return sendJson(res, 200, { ok: false, error: "geen_sessie" }, false);
    const gu = store.users[email];
    const sub = u.pathname.slice("/api/vinted/me/".length).replace(/\/$/, "");
    const sess = gu.vinted || null;
    const notLinked = () => sendJson(res, 200, { ok: false, error: "niet_gekoppeld", message: "Koppel eerst je Vinted-account." }, false);
    // toegang stil verversen voordat we iets bij Vinted opvragen
    if (sess) vintedEnsureFresh(sess);

    // ---- koppelen met het Vinted-account zelf (e-mail + wachtwoord) ----
    if (sub === "login" && req.method === "POST") {
      const vEmail = String(vb.vintedEmail || vb.email || "").trim();
      const vPass = String(vb.vintedPassword || vb.pass || "");
      if (!vEmail || !vEmail.includes("@")) return sendJson(res, 200, { ok: false, error: "geen_email", message: "Vul het e-mailadres van je Vinted-account in." }, false);
      if (!vPass) return sendJson(res, 200, { ok: false, error: "geen_wachtwoord", message: "Vul je Vinted-wachtwoord in." }, false);
      const lg = vintedLoginWithCredentials(vEmail, vPass);
      if (!lg.ok) {
        console.log(`[vinted] inloggen ${email} mislukt: ${lg.error}`);
        return sendJson(res, 200, { ok: false, error: lg.error, message: lg.message }, false);
      }
      const candidate = {
        cookies: "access_token_web=" + lg.token,
        token: lg.token,
        refreshToken: lg.refreshToken,
        tokenExpiresAt: Date.now() + lg.expiresIn * 1000,
        ua: UA,
        csrf: "",
        method: "login",
      };
      const check = vintedValidate(candidate);
      if (!check.ok) {
        return sendJson(res, 200, { ok: false, error: "koppelen_mislukt", message: "Vinted-login lukte, maar het account uitlezen niet: " + check.error, detail: check.error, status: check.status }, false);
      }
      const prof = mapVintedUser(check.user);
      gu.vinted = { ...candidate, ...prof, linkedAt: Date.now(), lastCheck: Date.now(), lastStatus: "ok" };
      saveStore(true);
      console.log(`[vinted] ${email} gekoppeld via Vinted-login als @${prof.username} (id ${prof.memberId})`);
      return sendJson(res, 200, { ok: true, profile: prof, method: "login" }, false);
    }

    // ---- diagnose van de koppeling zelf (werkt ook zónder gekoppeld account) ----
    if (sub === "probe") {
      const out = { cookies: [], login: null, api: null };
      vintedWarmCookies(["/", "/login"]);
      out.cookies = jarCookieNames();
      const p = vintedOauth({ grant_type: "password", username: "probe-" + Date.now() + "@example.com", password: "x", client_id: "web", scope: "default" });
      out.login = { status: p.status, body: String(p.raw || "").replace(/\s+/g, " ").slice(0, 300) };
      const a = vintedFetch({ ua: UA, cookies: "" }, "/api/v2/users/me", { timeoutMs: 15000 });
      out.api = { status: a.status, body: String(a.raw || "").replace(/\s+/g, " ").slice(0, 200) };
      console.log(`[vinted] probe ${email}: login=${p.status} api=${a.status} cookies=[${out.cookies.join(",")}]`);
      return sendJson(res, 200, { ok: true, probe: out }, false);
    }

    // ---- koppelen: cookie / 'Copy as cURL' plakken en valideren ----
    if (sub === "link" && req.method === "POST") {
      const parsed = parseVintedSession(vb.session || vb.cookie || vb.curl || "", vb.ua);
      if (!parsed.cookies && !parsed.token) {
        return sendJson(res, 200, { ok: false, error: "geen_sessie_gevonden", message: "Geen Vinted-sessie gevonden. Plak de cookie-regel of de volledige 'Copy as cURL' van een Vinted-verzoek." }, false);
      }
      const check = vintedValidate(parsed);
      if (!check.ok) {
        const hint = (check.status === 400 || check.status === 401)
          ? "Vinted accepteert deze sessie niet (401) — je bent daar niet (meer) ingelogd. Log opnieuw in bij Vinted en kopieer de 'Copy as cURL' van een vinted.nl-verzoek."
          : check.error;
        return sendJson(res, 200, { ok: false, error: "koppelen_mislukt", message: hint, detail: check.error, status: check.status }, false);
      }
      const prof = mapVintedUser(check.user);
      const oldRefresh = (gu.vinted && gu.vinted.refreshToken) || "";
      gu.vinted = { cookies: parsed.cookies, token: parsed.token, refreshToken: oldRefresh, ua: parsed.ua, csrf: "", method: "paste", ...prof, linkedAt: Date.now(), lastCheck: Date.now(), lastStatus: "ok" };
      saveStore(true);
      console.log(`[vinted] ${email} gekoppeld als @${prof.username} (id ${prof.memberId})`);
      return sendJson(res, 200, { ok: true, profile: prof }, false);
    }

    // ---- status (nooit de sessie zelf terugsturen!) ----
    if (sub === "status") {
      return sendJson(res, 200, {
        ok: true,
        linked: !!sess,
        linkedAt: sess ? sess.linkedAt : null,
        lastStatus: sess ? sess.lastStatus || "" : "",
        method: sess ? (sess.method || "paste") : "",
        refresh: !!(sess && sess.refreshToken),
        profile: sess ? { memberId: sess.memberId, username: sess.username, avatar: sess.avatar, rating: sess.rating, reviews: sess.reviews, location: sess.location, itemCount: sess.itemCount, balance: sess.balance, profileUrl: sess.profileUrl } : null,
      }, false);
    }

    if (sub === "unlink" && req.method === "POST") {
      delete gu.vinted;
      saveStore(true);
      return sendJson(res, 200, { ok: true }, false);
    }

    // ---- verbindingstest: laat precies zien wat Vinted wel/niet teruggeeft ----
    if (sub === "diagnose") {
      if (!sess) return notLinked();
      const paths = [
        "/api/v2/users/me",
        "/api/v2/users/me/items?page=1&per_page=5",
        "/api/v2/inbox?page=1&per_page=5",
        "/api/v2/my_orders",
        "/api/v2/users/currencies",
      ];
      const checks = [];
      for (const p of paths) {
        const r = vintedFetch(sess, p, { timeoutMs: 15000 });
        let detail = "";
        if (r.status === 200 && r.json) {
          const items = firstArray(r.json, ["items", "wardrobe", "item_ids"]);
          const convos = firstArray(r.json, ["conversations", "inbox", "threads"]);
          const orders = firstArray(r.json, ["orders", "my_orders", "transactions"]);
          if (r.json.user) detail = "gebruiker @" + (r.json.user.login || r.json.user.username || r.json.user.id);
          else if (items.length) detail = items.length + " items";
          else if (convos.length) detail = convos.length + " gesprekken";
          else if (orders.length) detail = orders.length + " orders";
          else detail = "data ontvangen (" + Object.keys(r.json).slice(0, 4).join(", ") + ")";
        }
        checks.push({ path: p, status: r.status, ok: r.status === 200, message: r.status === 200 ? detail : vintedErrMsg(r) });
      }
      const allOk = checks.length && checks.every(c => c.ok);
      const userPathOk = checks[0] && checks[0].ok;
      gu.vinted.lastCheck = Date.now();
      gu.vinted.lastStatus = allOk ? "ok" : (userPathOk ? "deels" : "verlopen");
      if (userPathOk) {
        const me = vintedFetch(sess, "/api/v2/users/me", { timeoutMs: 15000 });
        if (me.status === 200 && me.json && me.json.user) Object.assign(gu.vinted, mapVintedUser(me.json.user));
      }
      saveStore();
      console.log(`[vinted] diagnose ${email}: ${checks.map(c => c.status).join("/")}`);
      return sendJson(res, 200, { ok: true, checks, linkedAt: sess.linkedAt, lastStatus: gu.vinted.lastStatus }, false);
    }

    // ---- kast / inventaris ----
    if (sub === "inventory") {
      if (!sess) return notLinked();
      const page = Math.max(1, Math.min(20, Number(u.searchParams.get("page")) || 1));
      let r = vintedFetch(sess, `/api/v2/users/me/items?page=${page}&per_page=40`);
      if (r.status === 404 && sess.memberId) r = vintedFetch(sess, `/api/v2/wardrobe/${sess.memberId}/items?page=${page}&per_page=40`);
      if (!r.json && r.status === 200 && sess.memberId) r = { ...(vintedFetch(sess, `/api/v2/wardrobe/${sess.memberId}/items?page=${page}&per_page=40`)) };
      if (r.status !== 200 || !r.json) {
        if (r.status === 400 || r.status === 401) { gu.vinted.lastStatus = "verlopen"; saveStore(); }
        return sendJson(res, 200, { ok: false, error: "vinted_fout", status: r.status, message: vintedErrMsg(r) }, false);
      }
      const items = firstArray(r.json, ["items", "wardrobe", "item_ids"]).map(mapVintedItem).filter(i => i.id);
      const total = r.json.pagination ? (r.json.pagination.total_entries || r.json.pagination.total || null) : null;
      console.log(`[vinted] kast ${email}: ${items.length} items`);
      return sendJson(res, 200, { ok: true, items, total, page }, false);
    }

    // ---- inbox: biedingen + berichten ----
    if (sub === "inbox") {
      if (!sess) return notLinked();
      const page = Math.max(1, Math.min(20, Number(u.searchParams.get("page")) || 1));
      const r = vintedFetch(sess, `/api/v2/inbox?page=${page}&per_page=30`);
      if (r.status !== 200 || !r.json) {
        if (r.status === 400 || r.status === 401) { gu.vinted.lastStatus = "verlopen"; saveStore(); }
        return sendJson(res, 200, { ok: false, error: "vinted_fout", status: r.status, message: vintedErrMsg(r) }, false);
      }
      const usersById = {};
      firstArray(r.json, ["users"]).forEach(x => { if (x && x.id != null) usersById[String(x.id)] = x; });
      const threads = firstArray(r.json, ["conversations", "inbox", "threads"]).map(c => mapVintedThread(c, usersById)).filter(t => t.id);
      console.log(`[vinted] inbox ${email}: ${threads.length} gesprekken`);
      return sendJson(res, 200, { ok: true, threads, page }, false);
    }

    // ---- één gesprek (met biedingen erin) ----
    if (sub === "thread") {
      if (!sess) return notLinked();
      const id = String(vb.id || u.searchParams.get("id") || "").replace(/[^0-9a-zA-Z_\-]/g, "");
      if (!id) return sendJson(res, 200, { ok: false, error: "geen_id", message: "Geen gesprek-id meegegeven." }, false);
      let r = vintedFetch(sess, `/api/v2/conversations/${id}?per_page=50`);
      if (r.status === 404) r = vintedFetch(sess, `/api/v2/inbox/${id}`);
      if (r.status !== 200 || !r.json) return sendJson(res, 200, { ok: false, error: "vinted_fout", status: r.status, message: vintedErrMsg(r) }, false);
      const usersById = {};
      firstArray(r.json, ["users"]).forEach(x => { if (x && x.id != null) usersById[String(x.id)] = x; });
      const convo = r.json.conversation || r.json.thread || null;
      const messages = firstArray(r.json, ["messages", "conversation_messages"]).map(m => mapVintedMessage(m, usersById));
      return sendJson(res, 200, {
        ok: true,
        id,
        thread: convo ? mapVintedThread(convo, usersById) : null,
        messages,
      }, false);
    }

    // ---- antwoorden sturen ----
    if (sub === "reply" && req.method === "POST") {
      if (!sess) return notLinked();
      const id = String(vb.conversationId || "").replace(/[^0-9a-zA-Z_\-]/g, "");
      const text = String(vb.text || "").trim().slice(0, 1000);
      if (!id) return sendJson(res, 200, { ok: false, error: "geen_id" }, false);
      if (!text) return sendJson(res, 200, { ok: false, error: "leeg_bericht" }, false);
      if (!sess.csrf) { sess.csrf = vintedCsrf(sess); saveStore(); }
      const attempts = [
        { path: `/api/v2/conversations/${id}/messages`, body: { message: { body: text } } },
        { path: `/api/v2/inbox/${id}/messages`, body: { message: { body: text } } },
        { path: `/api/v2/conversations/${id}/messages`, body: { message: { body: text, conversation_id: id } } },
      ];
      const tried = [];
      for (const a of attempts) {
        const r = vintedFetch(sess, a.path, { method: "POST", json: a.body, timeoutMs: 20000 });
        tried.push({ path: a.path, status: r.status });
        if (r.status === 200 || r.status === 201) {
          console.log(`[vinted] antwoord verstuurd naar gesprek ${id} via ${a.path}`);
          return sendJson(res, 200, { ok: true, via: a.path, status: r.status }, false);
        }
        if (r.status === 404) continue;                      // verkeerd pad → volgende proberen
        return sendJson(res, 200, { ok: false, error: "vinted_fout", status: r.status, message: vintedErrMsg(r), tried }, false);
      }
      return sendJson(res, 200, { ok: false, error: "endpoint_onbekend", status: 404, message: "Vinted accepteert geen bericht via de bekende endpoints — meld dit, dan pas ik het pad aan.", tried }, false);
    }

    return sendJson(res, 404, { ok: false, error: "onbekend_endpoint", path: u.pathname }, false);
  }

  // ---- Statische bestanden ----
  let file = u.pathname === "/" ? "/index.html" : u.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(__dirname, file);
  if (!full.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Niet gevonden");
    }
    const ext = path.extname(full).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      // geen oude versies in de browser-cache: de app praat met de API van de
      // server, dus een verouderde index.html breekt login/analyse.
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  Guidsell server gestart ✔");
  console.log(`  App + live Vinted-prijzen:  http://localhost:${PORT}`);
  console.log("  Open de app via dit adres zodat live Vinted-prijzen werken.");
  console.log(`  Accounts/app-data:  ${ACCOUNTS_FILE}`);
  console.log("");
  // sessie meteen warmen
  warmSession();
});
