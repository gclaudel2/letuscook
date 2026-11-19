/*
 * Zéro Blabla Cuisine — moteur d'extraction (côté navigateur, sans compilation)
 *
 *   1. Le relais Cloudflare récupère le HTML de la page (le navigateur ne peut pas le faire seul : CORS)
 *   2. Ici, dans le navigateur : lecture du JSON-LD schema.org/Recipe → gratuit, ~90 % des blogs
 *   3. Seulement si 2 échoue : texte nettoyé envoyé au relais, qui appelle l'IA (clé gardée côté relais)
 *
 * Utilisation :  const { recipe, warnings } = await ZBC.extractRecipe("https://…");
 *                ZBC.formatIngredient(ingredient, portionsVoulues / recipe.servings)
 */
(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────
  const CONFIG = {
    // Adresse du relais Cloudflare (à remplacer après son déploiement)
    WORKER_URL: "https://zbc-relais.VOTRE-COMPTE.workers.dev",
    MAX_AI_CHARS: 18000,
    MIN_TEXT_FOR_AI: 200,
  };
  const ACCESS_CODE_KEY = "zbc.accessCode"; // code facultatif, saisi une fois dans les réglages

  class ExtractError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ExtractError";
      this.code = code;
    }
  }

  // ── Ingrédients : analyse + recalcul ───────────────────────────
  const UNICODE_FRACTIONS = {
    "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
    "⅕": "1/5", "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
  };

  const UNITS = [
    ["kg", "kilogrammes?|kilos?|kg"],
    ["mg", "milligrammes?|mg"],
    ["g", "grammes?|gr\\.?|g"],
    ["ml", "millilitres?|ml"],
    ["cl", "centilitres?|cl"],
    ["dl", "décilitres?|decilitres?|dl"],
    ["l", "litres?|l"],
    ["c. à soupe", "cuill[eè]res?\\s+à\\s+soupe|cuill?\\.\\s*à\\s*soupe|c\\.\\s*à\\s*s(?:oupe)?\\.?|c\\.à\\.s\\.?|càs|cas|cs|tbsp\\.?|tablespoons?"],
    ["c. à café", "cuill[eè]res?\\s+à\\s+café|cuill?\\.\\s*à\\s*café|c\\.\\s*à\\s*c(?:afé)?\\.?|c\\.à\\.c\\.?|càc|cac|cc|tsp\\.?|teaspoons?"],
    ["tasse", "tasses?|cups?"], ["verre", "verres?"], ["bol", "bols?"], ["pincée", "pincées?"],
    ["sachet", "sachets?"], ["tranche", "tranches?"], ["gousse", "gousses?"], ["brin", "brins?"],
    ["botte", "bottes?"], ["bouquet", "bouquets?"], ["feuille", "feuilles?"], ["boîte", "bo[iî]tes?"],
    ["pot", "pots?"], ["poignée", "poignées?"], ["noix", "noix"], ["noisette", "noisettes?"],
    ["filet", "filets?"], ["morceau", "morceaux?"], ["cube", "cubes?"], ["bâton", "b[aâ]tons?"],
    ["oz", "oz"], ["lb", "lbs?"],
  ];
  const UNIT_PATTERNS = UNITS.slice()
    .sort((a, b) => b[1].length - a[1].length)
    .map(([canonical, p]) => ({ canonical, re: new RegExp(`^(?:${p})(?=$|[\\s,;:()])`, "i") }));

  // Fraction avant entier/décimal, sinon "1/2" serait lu "1"
  const NUM = "\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?";
  const QTY_RE = new RegExp(`^(?:env(?:iron|\\.)?\\s+|about\\s+)?(${NUM})(?:(?:\\s*[-–]\\s*|\\s+(?:à|ou|to)\\s+)(${NUM}))?`, "i");

  const METRIC_UNITS = new Set(["g", "kg", "mg", "ml", "cl", "dl", "l", "oz", "lb"]);
  const COUNTABLE_UNITS = new Set(["gousse", "tranche", "filet", "morceau", "cube", "feuille", "brin", "botte",
    "bouquet", "pot", "sachet", "boîte", "noix", "noisette", "bâton"]);
  const FRACTION_GLYPHS = [[0, ""], [1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"], [1, ""]];
  const HALF_GLYPHS = [[0, ""], [1 / 2, "½"], [1, ""]];

  function normalizeRaw(input) {
    let s = String(input).replace(/ | /g, " ");
    s = s.replace(/(\d)?\s*([½⅓⅔¼¾⅕⅙⅚⅛⅜⅝⅞])/g, (_m, d, f) => (d ? `${d} ${UNICODE_FRACTIONS[f]}` : UNICODE_FRACTIONS[f]));
    s = s.replace(/^[\s•·*▪◦–-]+/, "");
    return s.replace(/\s+/g, " ").trim();
  }

  function parseNumber(token) {
    const t = token.trim();
    const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
    if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
    const frac = /^(\d+)\/(\d+)$/.exec(t);
    if (frac) return Number(frac[2]) === 0 ? NaN : Number(frac[1]) / Number(frac[2]);
    return Number(t.replace(",", "."));
  }

  /** → { raw, quantity, quantityMax, unit, rest, name } */
  function parseIngredient(input) {
    const raw = normalizeRaw(input);
    const base = { raw, quantity: null, quantityMax: null, unit: null, rest: raw, name: raw };
    const q = QTY_RE.exec(raw);
    if (!q) return base;

    const quantity = parseNumber(q[1]);
    const quantityMax = q[2] ? parseNumber(q[2]) : null;
    if (!Number.isFinite(quantity) || quantity <= 0) return base;
    const rest = raw.slice(q[0].length).trim();
    if (!rest) return base;

    let unit = null;
    let name = rest;
    for (const { canonical, re } of UNIT_PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      const after = rest.slice(m[0].length).replace(/^\s*(?:de\s+|d['’]\s*|of\s+)/i, "").replace(/^[\s,;:]+/, "").trim();
      if (after) { unit = canonical; name = after; } // "3 noix" : rien derrière → c'est le nom
      break;
    }
    return {
      raw, quantity,
      quantityMax: quantityMax && Number.isFinite(quantityMax) && quantityMax > quantity ? quantityMax : null,
      unit, rest, name,
    };
  }

  function formatDecimal(n, maxDecimals) {
    const f = 10 ** maxDecimals;
    return String(Math.round(n * f) / f).replace(".", ",");
  }

  /** Arrondi "de cuisine" : 5 g près, cuillères au ¼, pièces au ½. */
  function formatQuantity(value, unit) {
    if (!Number.isFinite(value) || value <= 0) return "";
    if (unit && METRIC_UNITS.has(unit)) {
      if (value >= 100) return formatDecimal(Math.round(value / 5) * 5, 0);
      if (value >= 10) return formatDecimal(value, 0);
      return formatDecimal(value, 1);
    }
    if (value >= 10) return formatDecimal(value, 0);
    const glyphs = unit == null || COUNTABLE_UNITS.has(unit) ? HALF_GLYPHS : FRACTION_GLYPHS;
    let whole = Math.floor(value);
    const frac = value - whole;
    let best = glyphs[0];
    for (const c of glyphs) if (Math.abs(c[0] - frac) < Math.abs(best[0] - frac)) best = c;
    if (best[0] === 1) { whole += 1; best = glyphs[0]; }
    if (whole === 0 && !best[1]) return glyphs === HALF_GLYPHS ? "½" : "¼";
    return `${whole > 0 ? whole : ""}${best[1]}`;
  }

  function formatIngredient(ing, factor) {
    if (ing.quantity == null || factor === 1) return ing.raw;
    const q = formatQuantity(ing.quantity * factor, ing.unit);
    const max = ing.quantityMax != null ? formatQuantity(ing.quantityMax * factor, ing.unit) : "";
    return `${q}${max && max !== q ? `–${max}` : ""} ${ing.rest}`;
  }

  // ── Normalisation schema.org ───────────────────────────────────
  const ISO_DURATION = /^P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i;
  const num = (s) => (s ? Number(String(s).replace(",", ".")) : 0);

  /** "PT1H30M" → 90, "1h30" → 90, "45 min" → 45 ; null si absent ou nul */
  function parseDuration(value) {
    if (value == null || value === "") return null;
    if (Array.isArray(value)) return parseDuration(value[0]);
    if (typeof value === "number") return value > 0 ? Math.round(value) : null;
    const s = String(value).trim();
    const iso = ISO_DURATION.exec(s);
    if (iso && s.length > 1) {
      const [, , , w, d, h, m, sec] = iso;
      const t = num(w) * 7 * 1440 + num(d) * 1440 + num(h) * 60 + num(m) + num(sec) / 60;
      return t > 0 ? Math.round(t) : null;
    }
    const hm = /(\d+)\s*h\s*(\d{1,2})(?!\d)/i.exec(s);
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    const hours = /(\d+(?:[.,]\d+)?)\s*h(?:eures?|ours?|rs?)?(?![a-z])/i.exec(s);
    const mins = /(\d+)\s*(?:min(?:utes?|s)?|mn)(?![a-z])/i.exec(s);
    if (hours || mins) {
      const t = num(hours && hours[1]) * 60 + num(mins && mins[1]);
      return t > 0 ? Math.round(t) : null;
    }
    return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
  }

  function parseServings(value) {
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v != null && v !== "");
    let servings = null;
    let yieldText;
    for (const v of values) {
      if (typeof v === "number" && servings == null && v > 0) servings = Math.round(v);
      if (typeof v === "string") {
        const text = v.replace(/\s+/g, " ").trim();
        if (!yieldText && /[a-zà-ÿ]/i.test(text)) yieldText = text;
        const m = /\d+/.exec(text);
        if (m && servings == null && Number(m[0]) > 0) servings = Number(m[0]);
      }
    }
    if (servings != null && servings > 100) servings = null;
    return { servings, yieldText };
  }

  function pickImageUrl(value, baseUrl) {
    if (value == null) return undefined;
    if (Array.isArray(value)) {
      for (const v of value) { const u = pickImageUrl(v, baseUrl); if (u) return u; }
      return undefined;
    }
    let c = value;
    if (typeof value === "object") c = value.url || value.contentUrl || value["@id"];
    if (typeof c !== "string" || !c.trim()) return undefined;
    try {
      const u = new URL(c.trim(), baseUrl);
      return /^https?:$/.test(u.protocol) ? u.toString() : undefined;
    } catch { return undefined; }
  }

  function schemaTypes(value) {
    return (Array.isArray(value) ? value : [value])
      .filter((t) => typeof t === "string")
      .map((t) => t.trim().replace(/^.*[/:#]/, ""));
  }

  /** Balises + entités (y compris double-encodées), retours ligne conservés. Aucun script exécuté. */
  function cleanText(input) {
    if (input == null) return "";
    let s = String(input);
    for (let pass = 0; pass < 2 && /[<&]/.test(s); pass++) {
      s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|li|div|h[1-6]|tr)>/gi, "\n");
      s = new DOMParser().parseFromString(`<body>${s}</body>`, "text/html").body.textContent || "";
    }
    return s.replace(/ | /g, " ").replace(/[ \t\f\v]+/g, " ").replace(/ *\n\s*/g, "\n").trim();
  }
  const cleanInline = (v) => cleanText(v).replace(/\s*\n\s*/g, " ").trim();

  // ── JSON-LD ────────────────────────────────────────────────────
  const MAX_DEPTH = 12;

  function safeJsonParse(raw) {
    const text = String(raw).trim().replace(/^<!--|-->$/g, "").replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, "").trim();
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { /* on tente une réparation */ }
    try { return JSON.parse(text.replace(/[\u0000-\u001f]+/g, " ").replace(/,\s*([}\]])/g, "$1")); }
    catch { return undefined; }
  }

  function collectRecipes(node, out, depth) {
    if (node == null || depth > MAX_DEPTH || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => collectRecipes(n, out, depth + 1)); return; }
    if (schemaTypes(node["@type"]).includes("Recipe")) out.push(node);
    for (const v of Object.values(node)) if (v && typeof v === "object") collectRecipes(v, out, depth + 1);
  }

  function findJsonLdRecipes(doc) {
    const found = [];
    doc.querySelectorAll('script[type*="ld+json" i]').forEach((el) => {
      const parsed = safeJsonParse(el.textContent || "");
      if (parsed !== undefined) collectRecipes(parsed, found, 0);
    });
    return found;
  }

  const countList = (v) => (Array.isArray(v) ? v.length : v ? 1 : 0);
  const score = (o) => countList(o.recipeIngredient || o.ingredients) * 2 + countList(o.recipeInstructions);
  const pickBestCandidate = (list) => list.reduce((best, c) => (score(c) > score(best) ? c : best));

  const STEP_NUMBERING = /^(?:(?:étape|etape|step)\s*\d+\s*[.):–-]?|\d{1,2}\s*[.)]|\d{1,2}\s*[:–-]\s+)\s*/i;

  function flattenInstructions(value, section, depth = 0) {
    if (value == null || depth > MAX_DEPTH) return [];
    if (typeof value === "string") {
      return cleanText(value).split(/\n+/)
        .map((l) => l.replace(STEP_NUMBERING, "").trim())
        .filter((l) => l.length > 1)
        .map((text) => ({ text, section }));
    }
    if (Array.isArray(value)) return value.flatMap((v) => flattenInstructions(v, section, depth + 1));
    if (typeof value !== "object") return [];
    if (value.itemListElement != null) { // HowToSection / ItemList
      const name = schemaTypes(value["@type"]).includes("HowToSection") ? cleanInline(value.name) || section : section;
      return flattenInstructions(value.itemListElement, name, depth + 1);
    }
    const text = cleanText(value.text ?? value.description ?? value.name ?? "").replace(STEP_NUMBERING, "").trim();
    return text ? [{ text, section }] : [];
  }

  function toStringList(v) {
    if (v == null) return [];
    if (typeof v === "string") return cleanText(v).split(/\n+/);
    if (Array.isArray(v)) return v.flatMap(toStringList);
    if (typeof v === "object") return toStringList(v.text ?? v.name);
    return [String(v)];
  }

  function totalOf(prep, cook, total) {
    return total ?? (prep != null || cook != null ? (prep || 0) + (cook || 0) : null);
  }

  function jsonLdToRecipe(node, sourceUrl, meta) {
    const steps = flattenInstructions(node.recipeInstructions, undefined)
      .filter((s, i, arr) => i === 0 || s.text !== arr[i - 1].text);
    const prepTimeMin = parseDuration(node.prepTime);
    const cookTimeMin = parseDuration(node.cookTime);
    const { servings, yieldText } = parseServings(node.recipeYield ?? node.yield);
    const description = cleanInline(node.description) || meta.description;
    return {
      title: cleanInline(node.name) || meta.title || "Recette sans titre",
      description: description ? description.slice(0, 300) : undefined,
      image: pickImageUrl(node.image, sourceUrl) || meta.image,
      sourceUrl, siteName: meta.siteName,
      servings, yieldText, prepTimeMin, cookTimeMin,
      totalTimeMin: totalOf(prepTimeMin, cookTimeMin, parseDuration(node.totalTime)),
      ingredients: toStringList(node.recipeIngredient ?? node.ingredients).map(cleanInline).filter(Boolean).map(parseIngredient),
      steps,
      extractedVia: "jsonld",
      extractedAt: new Date().toISOString(),
    };
  }

  // ── Métadonnées et texte principal (pour l'IA) ─────────────────
  function getPageMeta(doc, pageUrl) {
    const meta = (...sels) => {
      for (const s of sels) { const v = cleanInline(doc.querySelector(s)?.getAttribute("content")); if (v) return v; }
      return undefined;
    };
    return {
      title: meta('meta[property="og:title"]', 'meta[name="twitter:title"]') || cleanInline(doc.title) || undefined,
      description: meta('meta[property="og:description"]', 'meta[name="description"]'),
      image: pickImageUrl(meta('meta[property="og:image"]', 'meta[name="twitter:image"]'), pageUrl),
      siteName: meta('meta[property="og:site_name"]') || new URL(pageUrl).hostname.replace(/^www\./, ""),
    };
  }

  const NOISE = [
    "script", "style", "noscript", "template", "iframe", "svg", "canvas", "video", "audio", "img", "picture",
    "nav", "header", "footer", "aside", "form", "button", "select",
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]',
    "#comments", ".comments", ".comment-list", "#respond",
    ".adsbygoogle", ".advertisement", ".advert", ".ads", ".ad", '[id^="ad-"]', '[class^="ad-"]', '[id*="google_ads"]',
    ".share", ".sharing", ".social", ".newsletter", ".related", ".related-posts", ".breadcrumb", ".sidebar",
    '[class*="cookie"]', '[class*="popup"]', '[class*="modal"]',
  ].join(",");

  /** ⚠️ Modifie le document : à appeler après la lecture du JSON-LD. */
  function extractMainText(doc) {
    doc.querySelectorAll(NOISE).forEach((el) => el.remove());
    let root = doc.body;
    let best = 0;
    doc.querySelectorAll('[class*="recipe" i], [id*="recipe" i], [class*="recette" i], [itemtype*="Recipe"]').forEach((el) => {
      const len = (el.textContent || "").length;
      if (len > best) { best = len; root = el; }
    });
    if (best < 400) {
      for (const sel of ["article", "main", '[role="main"]', ".entry-content", ".post-content"]) {
        const el = doc.querySelector(sel);
        if (el && (el.textContent || "").trim().length > 400) { root = el; break; }
      }
    }
    if (!root) return "";
    root.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
    root.querySelectorAll("li").forEach((el) => el.prepend("- "));
    root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, div, tr, section, dt, dd").forEach((el) => el.append("\n"));
    const text = (root.textContent || "")
      .replace(/ | /g, " ")
      .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    return text.slice(0, CONFIG.MAX_AI_CHARS);
  }

  // ── Réponse IA → recette (validation défensive) ────────────────
  const asNum = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : parseDuration(v));
  const asStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  function aiToRecipe(ai, sourceUrl, meta) {
    const ingredients = Array.isArray(ai.ingredients) ? ai.ingredients.filter((s) => typeof s === "string") : [];
    const steps = Array.isArray(ai.steps) ? ai.steps : [];
    const prepTimeMin = parseDuration(asNum(ai.prepTimeMinutes));
    const cookTimeMin = parseDuration(asNum(ai.cookTimeMinutes));
    return {
      title: asStr(ai.title) || meta.title || "Recette sans titre",
      description: asStr(ai.description) || meta.description,
      image: meta.image, sourceUrl, siteName: meta.siteName,
      servings: parseServings(asNum(ai.servings)).servings,
      yieldText: asStr(ai.yieldText),
      prepTimeMin, cookTimeMin,
      totalTimeMin: totalOf(prepTimeMin, cookTimeMin, parseDuration(asNum(ai.totalTimeMinutes))),
      ingredients: ingredients.map((s) => s.trim()).filter(Boolean).map(parseIngredient),
      steps: steps
        .map((s) => (typeof s === "string" ? { text: s } : s || {}))
        .map((s) => ({ text: asStr(s.text) || "", section: asStr(s.section) }))
        .filter((s) => s.text),
      extractedVia: "llm",
      extractedAt: new Date().toISOString(),
    };
  }

  function mergeRecipes(base, ai) {
    return {
      ...base,
      ingredients: base.ingredients.length ? base.ingredients : ai.ingredients,
      steps: base.steps.length ? base.steps : ai.steps,
      servings: base.servings ?? ai.servings,
      yieldText: base.yieldText ?? ai.yieldText,
      prepTimeMin: base.prepTimeMin ?? ai.prepTimeMin,
      cookTimeMin: base.cookTimeMin ?? ai.cookTimeMin,
      totalTimeMin: base.totalTimeMin ?? ai.totalTimeMin,
      description: base.description ?? ai.description,
      extractedVia: "llm",
    };
  }

  // ── Appels au relais ───────────────────────────────────────────
  async function callWorker(path, body) {
    let accessCode = "";
    try { accessCode = localStorage.getItem(ACCESS_CODE_KEY) || ""; } catch { /* stockage indisponible */ }
    let res;
    try {
      res = await fetch(CONFIG.WORKER_URL + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(accessCode ? { "x-access-code": accessCode } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ExtractError("OFFLINE", "Pas de connexion : l'extraction nécessite Internet (vos recettes enregistrées restent disponibles).");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new ExtractError(data?.error?.code || "FETCH_FAILED", data?.error?.message || `Erreur du relais (${res.status}).`);
    }
    return data;
  }

  /** Texte collé : accepte aussi "Gâteau au yaourt https://…" (partage iOS). */
  function parseTargetUrl(input) {
    const s = String(input || "").trim();
    if (!s) throw new ExtractError("INVALID_URL", "Collez l'adresse (URL) d'une recette.");
    const m = /https?:\/\/[^\s<>"']+/i.exec(s);
    try {
      const u = new URL(m ? m[0] : `https://${s}`);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error();
      return u.toString();
    } catch {
      throw new ExtractError("INVALID_URL", "Cette adresse n'est pas valide.");
    }
  }

  /** Analyse d'un HTML déjà récupéré (sans réseau) : utile aussi pour les tests. */
  function extractFromHtml(html, sourceUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html"); // DOMParser n'exécute aucun script
    const meta = getPageMeta(doc, sourceUrl);
    const candidates = findJsonLdRecipes(doc);
    const recipe = candidates.length ? jsonLdToRecipe(pickBestCandidate(candidates), sourceUrl, meta) : null;
    const complete = !!recipe && recipe.ingredients.length > 0 && recipe.steps.length > 0;
    return { recipe, complete, meta, getText: () => extractMainText(doc) };
  }

  async function extractRecipe(input) {
    const url = parseTargetUrl(input);
    const warnings = [];

    const page = await callWorker("/page", { url });
    const { recipe: partial, complete, meta, getText } = extractFromHtml(page.html, page.finalUrl || url);
    if (complete) return { recipe: partial, warnings };

    const hasPartial = !!partial && (partial.ingredients.length > 0 || partial.steps.length > 0);
    const text = getText();
    if (text.length < CONFIG.MIN_TEXT_FOR_AI) {
      if (hasPartial) return { recipe: partial, warnings: ["Recette incomplète : le site ne fournit pas toutes les informations."] };
      throw new ExtractError("NO_RECIPE", "Cette page ne contient pas de recette lisible.");
    }

    let ai = null;
    try {
      const res = await callWorker("/ia", { url: page.finalUrl || url, title: meta.title, text });
      if (res.recipe && res.recipe.found !== false) ai = aiToRecipe(res.recipe, page.finalUrl || url, meta);
      if (ai && ai.ingredients.length === 0 && ai.steps.length === 0) ai = null;
    } catch (err) {
      if (!hasPartial) throw err;
      warnings.push("Recette incomplète : " + err.message);
    }

    if (partial && ai) return { recipe: mergeRecipes(partial, ai), warnings };
    if (ai) return { recipe: ai, warnings };
    if (hasPartial) return { recipe: partial, warnings };
    throw new ExtractError("NO_RECIPE", "Aucune recette trouvée sur cette page.");
  }

  window.ZBC = {
    CONFIG, ACCESS_CODE_KEY, ExtractError,
    extractRecipe, extractFromHtml, parseTargetUrl,
    parseIngredient, formatIngredient, formatQuantity, parseDuration, parseServings,
  };
})();
