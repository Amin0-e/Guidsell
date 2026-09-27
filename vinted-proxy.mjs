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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
const VINTED_HOST = process.env.VINTED_HOST || "https://www.vinted.nl";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
    return k || null;
  } catch {
    return process.env.GEMINI_API_KEY || null;
  }
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

  for (const model of AI_MODELS) {
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
        if (RETRYABLE_STATUS.has(res.status) && model !== AI_MODELS[AI_MODELS.length - 1]) {
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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(data);
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
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  Guidsell server gestart ✔");
  console.log(`  App + live Vinted-prijzen:  http://localhost:${PORT}`);
  console.log("");
  console.log("  Open de app via dit adres zodat live Vinted-prijzen werken.");
  console.log("");
  // sessie meteen warmen
  warmSession();
});
