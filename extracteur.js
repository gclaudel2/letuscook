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
    // Valeurs par défaut : celles de config.js (communes à tous), sinon à saisir dans les Réglages
    WORKER_URL: (window.ZBC_CONFIG && window.ZBC_CONFIG.WORKER_URL) || "https://zbc-relais.VOTRE-COMPTE.workers.dev",
    ACCESS_CODE: (window.ZBC_CONFIG && window.ZBC_CONFIG.ACCESS_CODE) || "",
    MAX_AI_CHARS: 18000,
    MIN_TEXT_FOR_AI: 200,
  };
  const ACCESS_CODE_KEY = "zbc.accessCode"; // code facultatif, saisi une fois dans les réglages
  // App iPhone publiée (App Store) : clé du relais fournie par l'app, et jamais d'IA
  const APP = (window.LUC_APP && typeof window.LUC_APP === "object") ? window.LUC_APP : null;
  const NO_AI = !!(APP && APP.noAI);
  const WORKER_URL_KEY = "zbc.workerUrl"; // adresse du relais saisie dans les réglages (prioritaire)

  function readSetting(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  }

  /** Adresse du relais : réglages de l'appli, sinon CONFIG ; "" si pas encore configurée. */
  function getWorkerUrl() {
    const url = (readSetting(WORKER_URL_KEY) || CONFIG.WORKER_URL).trim().replace(/\/+$/, "");
    return /VOTRE-COMPTE/.test(url) ? "" : url;
  }

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
      rating: parseRating(node.aggregateRating),
      calories: parseCalories(node.nutrition),
      difficulty: normalizeDifficulty(findDifficultyValue(node)),
      extractedVia: "jsonld",
      extractedAt: new Date().toISOString(),
    };
  }


  // ── Infos de choix : note, calories, difficulté ────────────────
  function parseRating(r) {
    if (!r || typeof r !== "object") return undefined;
    if (Array.isArray(r)) return parseRating(r[0]);
    const value = Number(String(r.ratingValue ?? "").replace(",", "."));
    const best = Number(String(r.bestRating ?? 5).replace(",", ".")) || 5;
    const count = parseInt(String(r.ratingCount ?? r.reviewCount ?? "0").replace(/\D/g, ""), 10) || 0;
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return { value: Math.round((value / best) * 5 * 10) / 10, count };
  }

  function parseCalories(n) {
    if (!n || typeof n !== "object") return undefined;
    const m = /(\d+(?:[.,]\d+)?)/.exec(String(n.calories ?? ""));
    const kcal = m ? Math.round(Number(m[1].replace(",", "."))) : 0;
    return kcal > 0 && kcal < 5000 ? kcal : undefined;
  }

  /** Propriété non standard parfois présente : "difficulty", "recipeDifficulty"… */
  function findDifficultyValue(node) {
    for (const [k, v] of Object.entries(node || {})) {
      if (/difficult/i.test(k) && (typeof v === "string" || typeof v === "number")) return String(v);
    }
    return undefined;
  }

  const DIFFICULTY_LEVELS = [
    [/tr[eè]s\s*facile|very\s*easy|d[ée]butant/i, "Très facile"],
    [/facile|easy|simple/i, "Facile"],
    [/moyen|interm[ée]diaire|medium|confirm/i, "Moyenne"],
    [/tr[eè]s\s*difficile|expert/i, "Difficile"],
    [/difficile|hard|[ée]lev[ée]|avanc/i, "Difficile"],
  ];
  function normalizeDifficulty(text) {
    if (!text) return undefined;
    const t = String(text).trim();
    if (/^[1-5]$/.test(t)) return ["Très facile", "Facile", "Moyenne", "Difficile", "Difficile"][Number(t) - 1];
    for (const [re, label] of DIFFICULTY_LEVELS) if (re.test(t)) return label;
    return undefined;
  }

  /** Difficulté affichée sur la page (pas dans schema.org) : éléments "difficulty", ou "Difficulté : facile". */
  function findDifficultyInPage(doc) {
    for (const el of doc.querySelectorAll('[class*="difficult" i], [id*="difficult" i], [data-difficulty]')) {
      const own = el.getAttribute("data-difficulty") || normSpace(el.textContent);
      const txt = own && own.length <= 40 ? own : el.parentElement && normSpace(el.parentElement.textContent).length <= 60 ? normSpace(el.parentElement.textContent) : "";
      const d = normalizeDifficulty(txt.replace(/difficult[ée]\s*:?/i, ""));
      if (d) return d;
    }
    const m = /(?:difficult[ée]|niveau)\s*:?\s*(tr[eè]s facile|facile|moyenne?|interm[ée]diaire|difficile|[ée]lev[ée]e?)/i.exec(normSpace(doc.body ? doc.body.textContent : ""));
    return m ? normalizeDifficulty(m[1]) : undefined;
  }


  // ── Recettes de chefs ──────────────────────────────────────────
  /** Minuscules sans accents (comparaisons de texte). */
  const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae");
  /* Grands chefs (étoilés Michelin, Meilleurs Ouvriers de France, pâtissiers renommés). */
  const CHEFS = [
    "Paul Bocuse", "Alain Ducasse", "Joël Robuchon", "Pierre Gagnaire", "Alain Passard", "Guy Savoy", "Anne-Sophie Pic",
    "Hélène Darroze", "Yannick Alléno", "Thierry Marx", "Michel Guérard", "Georges Blanc", "Régis Marcon", "Jacques Marcon",
    "Michel Bras", "Sébastien Bras", "Marc Veyrat", "Emmanuel Renaut", "Jean Sulpice", "Glenn Viel", "Mauro Colagreco",
    "Arnaud Lallement", "Arnaud Donckele", "Christopher Coutanceau", "Olivier Nasti", "Michel Troisgros", "César Troisgros",
    "Alexandre Mazzia", "Eric Fréchon", "Éric Fréchon", "Christian Le Squer", "Jean-François Piège", "Christian Constant",
    "Philippe Etchebest", "Cyril Lignac", "Mory Sacko", "Stéphanie Le Quellec", "Amandine Chaignot", "Julia Sedefdjian",
    "Dominique Crenn", "Georgiana Viou", "Nadia Sammut", "Fanny Rey", "Jacques Maximin", "Bernard Loiseau", "Patrick Bertron",
    "Paul Haeberlin", "Marc Haeberlin", "Jean-Georges Klein", "Gilles Goujon", "Jean-Luc Rabanel", "Gérald Passédat",
    "Edouard Loubet", "Édouard Loubet", "Pascal Barbot", "David Toutain", "Eric Pras", "Éric Pras", "Michel Sarran",
    "Guillaume Gomez", "Jean-Pierre Coffe", "Frédéric Anton", "Philippe Faure-Brac", "Akrame Benallal", "Pierre Sang",
    "Juan Arbelaez", "Norbert Tarayre", "Jean-François Mallet", "Hugo Roellinger", "Olivier Roellinger", "Christophe Hay",
    "Alexandre Couillon", "Jean-André Charial", "Romain Meder", "Paul Pairet", "Gordon Ramsay", "Massimo Bottura",
    "Ferran Adrià", "Heston Blumenthal", "Yotam Ottolenghi", "Jamie Oliver",
    // Pâtissiers
    "Pierre Hermé", "Christophe Michalak", "Cédric Grolet", "Philippe Conticini", "Christophe Felder", "Christophe Adam",
    "Jean-Paul Hévin", "Pierre Marcolini", "Yann Couvreur", "Nina Métayer", "Claire Heitzler", "Jessica Préalpato",
    "Nicolas Paciello", "François Perret", "Pierre Lecoq", "Gaston Lenôtre", "Philippe Urraca", "Jacques Génin",
    "Patrick Roger", "Sébastien Gaudard", "Fabrice Le Bourdat", "Arnaud Larher", "Gontran Cherrier", "Eric Kayser",
  ];
  const chefKey = (n) => fold(n).replace(/[-\s]+/g, " ").trim();
  const CHEF_INDEX = new Map(CHEFS.map((n) => [chefKey(n), n]));
  const CHEF_RE = new RegExp(`(?:^|[^a-z])(${[...CHEF_INDEX.keys()].map((k) => k.replace(/ /g, "[\\s-]+")).join("|")})(?![a-z])`);

  function authorNames(a) {
    if (!a) return [];
    if (typeof a === "string") return [a];
    if (Array.isArray(a)) return a.flatMap(authorNames);
    if (typeof a === "object") return authorNames(a.name);
    return [];
  }
  /** "… du chef Jean Dupont" → "Jean Dupont" */
  const CHEF_IN_TITLE = /\bchefs?\s+(?:étoilé\s+|pâtissier\s+)?([A-ZÀ-Ý][\wà-ÿ'’-]+(?:\s+(?:de\s+|le\s+|la\s+)?[A-ZÀ-Ý][\wà-ÿ'’-]+){1,2})/;

  /** Nom du chef de la recette, s'il est connu ; sinon undefined. */
  function detectChef(node, doc, meta) {
    const authors = authorNames(node && node.author).map(normSpace).filter(Boolean);
    const h1 = normSpace(doc.querySelector("h1")?.textContent);
    const intro = normSpace((doc.querySelector("article, main, [role=main]") || doc.body || doc.documentElement).textContent).slice(0, 1500);
    // 1. Nom connu dans l'auteur, le titre, la description ou le début de l'article
    for (const text of [authors.join(" "), node && node.name, h1, meta.title, node && node.description, meta.description, intro]) {
      const m = CHEF_RE.exec(fold(text || "").replace(/[-\s]+/g, " "));
      if (m) return CHEF_INDEX.get(m[1].replace(/[\s-]+/g, " ")) || undefined;
    }
    // 2. "Recette du chef Jean Dupont" dans le titre
    for (const text of [h1, node && node.name, meta.title]) {
      const m = CHEF_IN_TITLE.exec(normSpace(text));
      if (m) return m[1];
    }
    // 3. Auteur qui se présente comme chef ("Chef Damien")
    const chefAuthor = authors.find((a) => /\bchef\b/i.test(a) && a.length <= 60);
    return chefAuthor ? chefAuthor.replace(/^\s*(?:le\s+)?chef\s+/i, "") : undefined;
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
    '[class*="breadcrumb" i]', '[id*="breadcrumb" i]', '[class*="ariane" i]', '[aria-label*="breadcrumb" i]', '[aria-label*="fil d" i]',
    '[itemtype*="BreadcrumbList"]', '[class*="newsletter" i]', '[id*="newsletter" i]',
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

  // ── Lecture sans IA des recettes "en texte libre" ──────────────
  /*
   * Pour les blogs sans données structurées. On repère :
   *  - les ingrédients : lignes/paragraphes/listes où la plupart des éléments commencent par
   *    une quantité ("225 g de biscuits, 65 g de beurre…"), avec leur rubrique ("La base :") ;
   *  - les étapes : liste numérotée de phrases, sinon paragraphes numérotés "1. …",
   *    sinon paragraphes sous un titre "Préparation" ;
   *  - portions et temps : "Pour 6 à 8 personnes", "préparation 30 min", "cuisson 1h30".
   */
  const normSpace = (s) => String(s || "").replace(/ | /g, " ").replace(/\s+/g, " ").trim();
  const hasQty = (s) => parseIngredient(s).quantity != null;
  const IMPERATIVE = /\b(?!(?:assez|chez)\b)[a-zàâçéèêëîïôûùüÿœ]{3,}ez\b/i; // "Préchauffez", "mélangez"…
  const NOT_INGREDIENT_LABEL = /ustensile|mat[ée]riel|astuce|conseil|note|remarque|variante|conservation|pour \d|personne|portion|temps|pr[ée]paration|cuisson|repos/i;
  const STEP_HEADING = /pr[ée]paration|[ée]tapes?|instructions|r[ée]alisation|d[ée]roul[ée]|m[ée]thode|la recette/i;
  const ING_HEADING = /ingr[ée]dients?/i;

  /** Découpe "225 g de biscuits (moitié A, moitié B), 65 g de beurre, 1,5 kg…" aux virgules de premier niveau. */
  function splitItems(text) {
    const parts = [];
    let depth = 0, cur = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "[") depth++;
      else if ((c === ")" || c === "]") && depth > 0) depth--;
      const decimal = c === "," && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "");
      if ((c === "," || c === ";") && depth === 0 && !decimal) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts
      .flatMap((p) => p.split(/\s\+\s(?=\d)/)) // "300 g de X + 100 g de Y"
      .map((s) => s.trim().replace(/^(?:et|and)\s+/i, "").replace(/[.;:]+$/, "").trim())
      .filter(Boolean);
  }

  /** Lignes d'un bloc, en respectant les <br>. */
  function blockLines(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    return (c.textContent || "").split("\n").map(normSpace).filter(Boolean);
  }

  /** Classe une ligne : "ing" (ingrédients sûrs), "maybe" (courte, sans quantité : "sel, poivre"), "label" (titre seul), "other". */
  function classifyLine(line, fromList) {
    let label = null;
    let body = line;
    const m = /^([^:]{2,50}?)\s*:\s*(.*)$/.exec(line);
    if (m && !m[1].includes(",") && !/https?$/i.test(m[1])) { label = normSpace(m[1]); body = m[2]; }
    if (label && !body) return { kind: "label", label };
    if (label && NOT_INGREDIENT_LABEL.test(label)) return { kind: "other", label };

    const items = fromList ? [body] : splitItems(body);
    if (!items.length) return { kind: "other" };
    const withQty = items.filter(hasQty).length;
    const short = items.every((s) => s.length <= 110);
    const prose = /[.!?]\s+[A-ZÀ-Ý]/.test(body) || items.some((s) => IMPERATIVE.test(s));

    if (short && !prose) {
      if (items.length >= 2 && withQty >= 2 && withQty / items.length >= 0.5) return { kind: "ing", label, items };
      if (items.length === 1 && withQty === 1 && body.length <= 90) return { kind: "ing", label, items };
      if (body.length <= 70 && withQty === 0) return { kind: "maybe", label, items };
    }
    return { kind: "other", label, text: line };
  }

  function linkRatio(el) {
    const total = (el.textContent || "").trim().length || 1;
    let linked = 0;
    el.querySelectorAll("a").forEach((a) => { linked += (a.textContent || "").trim().length; });
    return linked / total;
  }

  function extractHeuristic(doc, sourceUrl, meta) {
    const d = doc.cloneNode(true);
    d.querySelectorAll(NOISE + ',[class*="comment" i],[id*="comment" i],[class*="menu" i],[class*="navigation" i]').forEach((el) => el.remove());
    const root = d.body;
    if (!root) return null;

    // 1. Parcours des blocs dans l'ordre du document
    const BLOCKS = "h1, h2, h3, h4, h5, h6, p, ul, ol, div";
    const entries = []; // { kind, label, items, text, section, el }
    let section = null;
    let afterStepHeading = false;
    for (const el of root.querySelectorAll(BLOCKS)) {
      const tag = el.tagName;
      if (tag !== "UL" && tag !== "OL" && el.closest("li")) continue; // contenu d'un élément de liste : traité avec la liste
      if (/^H[1-6]$/.test(tag)) {
        const t = normSpace(el.textContent);
        const isTitle = tag === "H1" || (meta.title && meta.title.toLowerCase().includes(t.toLowerCase()));
        // le titre de la page (« La recette de pot-au-feu de… ») n'annonce pas les étapes
        afterStepHeading = !isTitle && STEP_HEADING.test(t) && !ING_HEADING.test(t);
        section = !afterStepHeading && !ING_HEADING.test(t) && !isTitle && t.length <= 50 ? t.replace(/\s*:$/, "") : null;
        entries.push({ kind: "heading", text: t, step: afterStepHeading });
        continue;
      }
      if (tag === "DIV" && el.querySelector("p, div, ul, ol, table, h1, h2, h3, h4, h5, h6")) continue; // conteneur
      if (tag === "UL" || tag === "OL") {
        if (el.parentElement && el.parentElement.closest("ul, ol")) continue; // sous-liste
        const lis = [...el.children].filter((c) => c.tagName === "LI");
        if (!lis.length || linkRatio(el) > 0.6) continue;
        const texts = lis.map((li) => normSpace(li.textContent)).filter(Boolean);
        const linkedItems = lis.filter((li) => linkRatio(li) > 0.5).length; // fil d'Ariane, « à lire aussi »…
        entries.push({ kind: "list", ordered: tag === "OL", texts, section, step: afterStepHeading, links: linkedItems / lis.length });
        continue;
      }
      // Intertitre sans deux-points : paragraphe court entièrement en gras, ou "Ingrédients pour 4 personnes", "Préparation"…
      const lines = blockLines(el);
      const boldText = normSpace([...el.querySelectorAll("strong, b")].map((s) => s.textContent).join(" "));
      const whole = normSpace(el.textContent);
      const looksLikeTitle =
        lines.length === 1 && whole.length <= 60 && !hasQty(whole) &&
        ((boldText && boldText.length >= whole.length - 2 && !/[.!?]$/.test(whole)) ||
          /^(?:les?\s+)?(?:ingr[ée]dients?|pr[ée]paration|[ée]tapes?|instructions|r[ée]alisation|pour (?:la|le|les|l['’]) )/i.test(whole));
      if (looksLikeTitle) {
        const t = whole.replace(/\s*:$/, "");
        const isStep = STEP_HEADING.test(t) && !ING_HEADING.test(t) && !/^pour /i.test(t);
        afterStepHeading = isStep;
        section = !isStep && !ING_HEADING.test(t) && !NOT_INGREDIENT_LABEL.test(t) && !(meta.title && meta.title.toLowerCase().includes(t.toLowerCase())) ? t : null;
        entries.push({ kind: "heading", text: t, step: isStep });
        continue;
      }
      const emText = normSpace([...el.querySelectorAll("em, i")].map((x) => x.textContent).join(" "));
      const italic = !!emText && emText.length >= whole.length * 0.8; // crédit du livre, légende…
      for (const line of lines) {
        const c = classifyLine(line, false);
        c.italic = italic;
        if (c.kind === "label") {
          const isStepLabel = STEP_HEADING.test(c.label) && !ING_HEADING.test(c.label);
          afterStepHeading = isStepLabel;
          section = !isStepLabel && !ING_HEADING.test(c.label) && !NOT_INGREDIENT_LABEL.test(c.label) ? c.label : null;
          entries.push({ kind: "heading", text: c.label, step: isStepLabel });
          continue;
        }
        entries.push({ ...c, section: c.label || section, text: line, step: afterStepHeading });
      }
    }

    // 2. Ingrédients : lignes sûres + lignes courtes sans quantité qui les suivent ("sel, poivre")
    const ingredients = [];
    let prevWasIng = false;
    for (const e of entries) {
      if (e.kind === "list" && !e.step) {
        const cls = e.texts.map((t) => classifyLine(t, true));
        const ing = cls.filter((c) => c.kind === "ing").length;
        const ok = e.texts.length >= 2 && ing / e.texts.length >= 0.5 && cls.every((c) => c.kind === "ing" || c.kind === "maybe");
        if (ok) {
          e.texts.forEach((t) => ingredients.push({ ...parseIngredient(t), section: e.section || undefined }));
          prevWasIng = true;
        } else prevWasIng = false;
        continue;
      }
      if (e.kind === "ing" || (e.kind === "maybe" && prevWasIng)) {
        e.items.forEach((t) => ingredients.push({ ...parseIngredient(t), section: e.section || undefined }));
        prevWasIng = true;
      } else if (e.kind !== "heading" || e.step) {
        prevWasIng = false;
      }
    }

    // 3. Étapes : listes numérotées de phrases…
    let steps = [];
    const firstIng = entries.findIndex((e) => e.kind === "ing" || (e.kind === "list" && !e.step && e.texts.filter((t) => classifyLine(t, true).kind === "ing").length >= 2));
    for (const [idx, e] of entries.entries()) {
      if (e.kind !== "list" || (!e.ordered && !e.step)) continue;
      if (e.links > 0.5) continue;                                  // liste de liens (fil d'Ariane…)
      if (!e.step && firstIng >= 0 && idx < firstIng) continue;    // liste numérotée AVANT les ingrédients : pas la préparation
      const avg = e.texts.reduce((n, t) => n + t.length, 0) / e.texts.length;
      const qtyRatio = e.texts.filter((t) => classifyLine(t, true).kind === "ing").length / e.texts.length;
      if (e.texts.length >= 2 && avg >= 25 && qtyRatio < 0.5) {
        e.texts.forEach((t) => steps.push({ text: t.replace(STEP_NUMBERING, "").trim() }));
        e.isSteps = true;
      }
    }
    // Petites recettes annexes après les étapes ("Le coulis : 300 g de…" puis "Mixez le tout…")
    const lastStepList = entries.map((e) => !!e.isSteps).lastIndexOf(true);
    if (lastStepList >= 0) {
      let annexSection = null;
      for (const e of entries.slice(lastStepList + 1)) {
        if (e.kind === "ing") annexSection = e.section || null;
        else if (e.kind === "other" && annexSection && e.text && e.text.length >= 15 && IMPERATIVE.test(e.text)) {
          steps.push({ text: e.text.replace(STEP_NUMBERING, "").trim(), section: annexSection });
        } else if (e.kind === "heading" || e.kind === "list") annexSection = null;
      }
    }
    // … sinon paragraphes numérotés "1. …", "Étape 2 : …"
    if (steps.length < 2) {
      // toute ligne qui commence par un numéro d'étape, même courte (« ÉTAPE 5 : Au moment de servir, ajouter… »)
      const numbered = entries.filter((e) => e.kind !== "heading" && e.kind !== "list" && e.text && /^(?:[ée]tape\s*)?\d{1,2}\s*[.):–-]\s*\S/i.test(e.text));
      if (numbered.length >= 2) steps = numbered.map((e) => ({ text: e.text.replace(STEP_NUMBERING, "").trim() }));
    }
    // … sinon paragraphes sous un titre "Préparation"
    if (steps.length < 2) {
      // On s'arrête au premier texte qui n'est plus la recette (crédit du livre en italique, « Découvrez aussi », signature…)
      const END = /^(?:d[ée]couvre[zr]?|[àa] lire|lire aussi|voir aussi|retrouve[zr]?|[ée]crit par|par la r[ée]daction|cr[ée]dits?|photos?\s*:|©|source\s*:|recette (?:extraite|issue|tir[ée]e)|extrait d)/i;
      steps = [];
      for (const e of entries) {
        if (!e.step || e.kind === "heading" || e.kind === "list" || !e.text || e.text.length < 20) continue;
        if (END.test(e.text) || e.italic || /\d\s*€|€\s*\d|[ée]d(?:\.|itions?)\s+[A-Z]/.test(e.text)) { if (steps.length >= 2) break; continue; }
        steps.push({ text: e.text.replace(STEP_NUMBERING, "").trim() });
      }
    }

    if (ingredients.length < 2 || steps.length < 2) return null;

    // 4. Portions et temps, dans le texte de la page
    const text = normSpace(root.textContent);
    const serv = /pour\s+(\d{1,2})(?:\s*(?:à|-|–)\s*\d{1,2})?\s*(?:personnes?|pers\b|parts?|portions?|gourmands?|convives?)/i.exec(text);
    const timeAfter = (word) => {
      const m = new RegExp(`${word}\\s*:?\\s*((?:\\d+\\s*(?:h|heures?|min(?:utes?)?|mn)\\s*)+)`, "i").exec(text);
      return m ? parseDuration(m[1]) : null;
    };
    const prepTimeMin = timeAfter("pr[ée]paration");
    const cookTimeMin = timeAfter("cuisson");

    // Titre : le <h1> de la page, sinon le titre de l'onglet sans le nom du site ("… - Lady Coquillette")
    const h1 = normSpace(doc.querySelector("h1")?.textContent);
    const tabTitle = (meta.title || "").split(/\s+[-|–—·»]\s+/)[0];
    return {
      title: (h1 && h1.length <= 120 ? h1 : tabTitle) || "Recette sans titre",
      description: meta.description ? meta.description.slice(0, 300) : undefined,
      image: meta.image,
      sourceUrl, siteName: meta.siteName,
      servings: serv ? Number(serv[1]) : null,
      yieldText: serv ? normSpace(serv[0]) : undefined,
      prepTimeMin, cookTimeMin,
      totalTimeMin: totalOf(prepTimeMin, cookTimeMin, null),
      ingredients,
      steps: steps.filter((s, i, arr) => s.text && (i === 0 || s.text !== arr[i - 1].text)),
      extractedVia: "html",
      extractedAt: new Date().toISOString(),
    };
  }


  // ── Photo d'une recette : lecture du texte SUR L'IPHONE (Tesseract.js), puis découpage sans IA ──
  /*
   * Le module de lecture (OCR) est chargé seulement au premier usage, depuis jsDelivr.
   * Les données de langue (français) sont gardées par Tesseract dans le navigateur : ensuite ça marche hors ligne.
   * Aucune photo n'est envoyée nulle part.
   */
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractLoading) {
      tesseractLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL; s.async = true; s.crossOrigin = "anonymous";
        s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("module absent")));
        s.onerror = () => reject(new Error("chargement impossible"));
        document.head.append(s);
      }).catch((err) => {
        tesseractLoading = null;
        throw new ExtractError("OCR_UNAVAILABLE", navigator.onLine === false
          ? "La lecture des photos a besoin d'Internet la toute première fois (téléchargement du module). Réessayez une fois connecté."
          : `Impossible de charger le module de lecture des photos (${err.message}).`);
      });
    }
    return tesseractLoading;
  }

  /** Photo → image redressée, en niveaux de gris, contrastée, ~2000 px : ce que l'OCR lit le mieux. */
  function prepareImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w0 = img.naturalWidth, h0 = img.naturalHeight;
        const scale = Math.min(2, 2000 / Math.max(w0, h0));
        const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const data = ctx.getImageData(0, 0, w, h);
          const px = data.data, n = w * h, hist = new Uint32Array(256), gray = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            const g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
            gray[i] = g; hist[g]++;
          }
          let lo = 0, hi = 255, acc = 0;
          for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
          acc = 0;
          for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
          const span = Math.max(1, hi - lo);
          for (let i = 0; i < n; i++) {
            const v = Math.max(0, Math.min(255, ((gray[i] - lo) * 255) / span));
            px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
          }
          ctx.putImageData(data, 0, 0);
        } catch { /* image protégée : on garde la couleur */ }
        resolve(canvas);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new ExtractError("BAD_IMAGE", "Cette image n'a pas pu être ouverte.")); };
      img.src = url;
    });
  }

  /** Lit le texte d'une ou plusieurs photos (dans l'ordre). → { text, lines: [{ text, h, photo }] } */
  async function readPhotos(files, onProgress = () => {}) {
    const t0 = performance.now();
    const log = (message, status = "info") => { try { onProgress(message, status, Math.round(performance.now() - t0)); } catch { /* */ } };
    const list = [...files].filter((f) => f && /^image\//.test(f.type || "image/"));
    if (!list.length) throw new ExtractError("BAD_IMAGE", "Choisissez une photo.");
    log(window.Tesseract ? "Module de lecture prêt" : "Chargement du module de lecture (la 1re fois : ~15 Mo, ensuite instantané)…", "run");
    const T = await loadTesseract();
    log("Préparation de la lecture en français…", "run");
    let worker;
    try {
      worker = await T.createWorker("fra", 1);
    } catch (err) {
      log("Module de lecture indisponible", "error");
      throw new ExtractError("OCR_UNAVAILABLE", "Le module de lecture n'a pas pu démarrer (connexion nécessaire la toute première fois).");
    }
    const texts = [], lines = [];
    try {
      for (let i = 0; i < list.length; i++) {
        log(list.length > 1 ? `Lecture de la photo ${i + 1}/${list.length} (10 à 20 s)…` : "Lecture de la photo (10 à 20 s)…", "run");
        const canvas = await prepareImage(list[i]);
        const { data } = await worker.recognize(canvas);
        texts.push(data.text || "");
        (data.lines || []).forEach((l) => lines.push({ text: l.text || "", h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0, photo: i }));
      }
    } finally {
      try { await worker.terminate(); } catch { /* */ }
    }
    const text = texts.join("\n\n");
    log(`Texte lu : ${normSpace(text).length.toLocaleString("fr-FR")} caractères`, "ok");
    return { text, lines };
  }

  /** Photo → JPEG ~1600 px en base64 (sans le préfixe data:), assez net pour l'IA et léger à envoyer. */
  function photoToBase64(file, maxSide = 1600) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82).split(",")[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new ExtractError("BAD_IMAGE", "Cette image n'a pas pu être ouverte.")); };
      img.src = url;
    });
  }

  /** Photo(s) → recette, lue par l'IA via le relais (Gemini). Meilleur résultat, y compris l'écriture manuscrite. */
  async function photosToRecipeAI(files, onProgress = () => {}) {
    const t0 = performance.now();
    const log = (message, status = "info") => { try { onProgress(message, status, Math.round(performance.now() - t0)); } catch { /* */ } };
    const list = [...files].filter(Boolean).slice(0, 4);
    if (!list.length) throw new ExtractError("BAD_IMAGE", "Choisissez une photo.");
    log("Préparation de la photo…", "run");
    const images = [];
    for (const f of list) images.push(await photoToBase64(f, 1400));
    const kb = Math.round(images.reduce((n, b) => n + b.length * 0.75, 0) / 1024);
    log(`Lecture par l'IA (${list.length > 1 ? `${list.length} photos, ` : ""}${kb} Ko envoyés, souvent 10 à 40 s)…`, "run");
    let res;
    // Un essai par appel au relais (< 1 min chacun). Texte de livre refusé → étapes résumées ;
    // trop lent ou saturé → modèle « lite », plus rapide. 4 essais au plus.
    // On commence par la combinaison qui a marché la dernière fois (au tout début : étapes résumées + modèle rapide,
    // le plus sûr pour une page de livre). Mémorisée après chaque réussite.
    let { mode, model } = (() => {
      try { const v = JSON.parse(localStorage.getItem("zbc.photoAI")); if (v && v.mode && v.model) return v; } catch { /* */ }
      return { mode: "compact", model: "lite" };
    })();
    for (let n = 1; n <= 4; n++) {
      log(`Essai ${n} : ${mode === "compact" ? "étapes résumées" : "lecture mot à mot"}, modèle ${model === "lite" ? "rapide" : "principal"}…`, "run");
      try {
        res = await callWorker("/photo", { images, mode, model });
        try { localStorage.setItem("zbc.photoAI", JSON.stringify({ mode, model })); } catch { /* */ }
        break;
      } catch (err) {
        if (err.code === "NOT_FOUND") err.message = "Le relais n'est pas à jour : recollez le fichier relais.js dans Cloudflare pour activer la lecture des photos par l'IA.";
        const slow = ["LLM_TIMEOUT", "LLM_BUSY", "RELAY_CUT"].includes(err.code);
        if (n < 4 && err.code === "RECITATION" && mode === "normal") { log("Gemini refuse de recopier un texte de livre", "warn"); mode = "compact"; continue; }
        if (n < 4 && slow) { log(err.code === "LLM_BUSY" ? "Gemini saturé" : "Gemini trop lent", "warn"); model = model === "lite" ? "main" : "lite"; continue; }
        if (n < 4 && err.code === "LLM_FAILED" && model === "lite") { log("Le modèle rapide n'a pas su lire la photo", "warn"); model = "main"; continue; }
        log(err.message, "error");
        throw err;
      }
    }
    const who = PROVIDER_NAMES[res.provider] || "l'IA";
    if (!res.recipe || res.recipe.found === false) {
      log(`${who} ne voit pas de recette sur la photo`, "error");
      throw new ExtractError("NO_RECIPE", "L'IA ne voit pas de recette sur cette photo. Cadrez la page entière, bien nette.");
    }
    const recipe = aiToRecipe(res.recipe, undefined, { siteName: "Photo" });
    recipe.extractedVia = "photo-llm";
    recipe.aiProvider = res.provider;
    log(`Recette lue par ${who} : ${recipe.ingredients.length} ingrédients, ${recipe.steps.length} étapes`, recipe.ingredients.length && recipe.steps.length ? "ok" : "warn");
    return recipe;
  }

  /*
   * Texte lu sur une photo → recette. L'OCR coupe les phrases en fin de ligne visuelle : on recolle les lignes,
   * on repère les rubriques (« Ingrédients », « Préparation », « Pour la pâte : »), puis les ingrédients
   * (lignes avec quantité) et les étapes (numérotées, ou paragraphes / phrases).
   */
  const OCR_BULLET = /^[\s•●▪■◦·*»>~=_|©®¢°o◆◇►▶✓✔-]{1,3}\s+(?=\S)/;
  const OCR_ING_HEAD = /^(?:les?\s+)?ingr[ée]dients?\b[^.]{0,40}$/i;
  const OCR_STEP_HEAD = /^(?:la\s+)?(?:pr[ée]paration|[ée]tapes?|instructions|r[ée]alisation|d[ée]roul[ée]|m[ée]thode|recette|progression)\s*:?\s*$/i;
  const OCR_STOP = /^(?:astuces?|conseils?|le conseil|bon [àa] savoir|variantes?|notes?|le petit plus|accord mets|vin conseill)/i;
  const OCR_STEP_START = /^(?:[ée]tape\s*)?\d{1,2}\s*[.)/:–-]\s*(?=\S)/i;
  const OCR_SECTION = /^(?:(?:pour|la|le|les|l['’])\s.{2,45}|[^\d,]{2,40}):\s*$/i;

  function recipeFromText(raw, opts = {}) {
    // 1. Lignes nettoyées (lignes vides = fin de paragraphe), mots coupés recollés
    const src = String(raw || "").replace(/\r/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").split("\n");
    const L = [];
    for (let i = 0; i < src.length; i++) {
      let line = src[i].replace(/\s+/g, " ").trim();
      if (!line) { L.push({ blank: true }); continue; }
      const bullet = OCR_BULLET.test(line);
      line = line.replace(OCR_BULLET, "").trim();
      if (!/[a-zà-ÿ0-9½¼¾]/i.test(line)) continue; // bruit (traits, points…)
      const prev = L[L.length - 1];
      if (prev && !prev.blank && /[a-zà-ÿ]-$/i.test(prev.text) && /^[a-zà-ÿ]/.test(line)) { prev.text = prev.text.slice(0, -1) + line; continue; }
      L.push({ text: line, bullet });
    }
    const lines = L.filter((l) => !l.blank);
    if (!lines.length) return null;
    const fullText = normSpace(lines.map((l) => l.text).join(" "));

    const isIngLine = (t) => hasQty(t) && t.length <= 90 && !(/[.!?]\s+[A-ZÀ-Ý]/.test(t)) && !IMPERATIVE.test(t.replace(/^\S+\s+\S+/, ""));
    const isTimeLine = (t) => /^(?:temps\s+de\s+)?(?:pr[ée]paration|cuisson|repos|total)\s*:?\s*\d/i.test(t) || /^pour\s+\d+\s*(?:personnes?|pers|parts?|portions?)/i.test(t);
    const isSection = (t) => OCR_SECTION.test(t) && !hasQty(t) && !OCR_STEP_HEAD.test(t) && !OCR_ING_HEAD.test(t.replace(/:$/, ""));

    // 2. Repères : rubrique ingrédients, rubrique étapes
    const idx = (re, from = 0) => L.findIndex((l, i) => i >= from && !l.blank && re.test(l.text.replace(/\s*:\s*$/, "")) && !/\d/.test(l.text.replace(/pour\s+\d+.*$/i, "")));
    const iIngHead = L.findIndex((l) => !l.blank && OCR_ING_HEAD.test(l.text));
    let iIng = iIngHead; // les ingrédients commencent juste après
    const iStep = idx(OCR_STEP_HEAD, iIng >= 0 ? iIng + 1 : 0);
    if (iIng < 0) {
      // pas de titre « Ingrédients » : premier groupe d'au moins 2 lignes avec quantité
      for (let i = 0; i < L.length - 1; i++) {
        if (L[i].blank || !isIngLine(L[i].text)) continue;
        const next = L.slice(i + 1).find((l) => !l.blank);
        if (next && isIngLine(next.text)) { iIng = i - 1; break; }
      }
    }
    const looksLikeStep = (t) => !hasQty(t) && (t.length > 45 || /[.!?]\s+\S/.test(t) || (/[.!]$/.test(t) && t.length > 25));

    // 3. Ingrédients
    const ingredients = [];
    let section;
    let endIng = iStep >= 0 ? iStep : L.length;
    if (iIng >= -1 && (iIng >= 0 || L.some((l) => !l.blank && isIngLine(l.text)))) {
      let last = null;
      for (let i = iIng + 1; i < endIng; i++) {
        const l = L[i];
        if (l.blank) { last = null; continue; }
        const t = l.text;
        if (OCR_STOP.test(t)) { endIng = i; break; }
        if (isTimeLine(t)) continue;
        if (isSection(t)) { section = t.replace(/\s*:\s*$/, ""); last = null; continue; }
        if (iStep < 0 && (looksLikeStep(t) || OCR_STEP_START.test(t) && !hasQty(t.replace(OCR_STEP_START, "")) && t.length > 30)) { endIng = i; break; }
        if (last && !l.bullet && !hasQty(t) && /^[a-zà-ÿ(]/.test(t) && last.raw.length + t.length < 120) {
          last.raw += " " + t; Object.assign(last.ing, parseIngredient(last.raw)); continue; // suite de la ligne précédente
        }
        const items = !hasQty(t) && t.includes(",") && t.length <= 70 ? splitItems(t) : [t];
        for (const it of items) {
          const ing = { ...parseIngredient(it), section: section || undefined };
          ingredients.push(ing);
          last = { raw: it, ing };
        }
      }
    }

    // 4. Étapes
    let stepFrom = iStep >= 0 ? iStep + 1 : endIng;
    const steps = [];
    let cur = null, stepSection, markedSteps = 0;
    const flush = () => { if (cur && normSpace(cur.text).length >= 8) steps.push({ text: normSpace(cur.text), section: cur.section }); cur = null; };
    let newPara = true;
    for (let i = stepFrom; i < L.length; i++) {
      const l = L[i];
      if (l.blank) { newPara = true; continue; }
      const t = l.text;
      if (OCR_STOP.test(t)) break;
      if (isTimeLine(t) || OCR_STEP_HEAD.test(t.replace(/\s*:\s*$/, ""))) continue;
      if (isSection(t) && t.length <= 45) { flush(); stepSection = t.replace(/\s*:\s*$/, ""); newPara = true; continue; }
      const numbered = OCR_STEP_START.test(t) && !isIngLine(t.replace(OCR_STEP_START, ""));
      const prevEnded = cur && /[.!]$/.test(cur.text);
      if (numbered || l.bullet) markedSteps++;
      if (!cur || numbered || l.bullet || (newPara && prevEnded) || (prevEnded && /^[A-ZÀ-Ý]/.test(t) && cur.text.length > 160)) {
        flush();
        cur = { text: t.replace(OCR_STEP_START, ""), section: stepSection || undefined };
      } else {
        cur.text += " " + t;
      }
      newPara = false;
    }
    flush();
    // Texte en bloc (cahier manuscrit, pas de numéros) : une étape par phrase, les phrases très courtes restent avec la suivante
    if (markedSteps < 2 && steps.some((st) => st.text.length > 150)) {
      const out = [];
      for (const st of steps) {
        const sentences = st.text.split(/(?<=[.!])\s+(?=[A-ZÀ-Ý])/);
        let acc = "";
        for (const s0 of sentences) {
          acc = acc ? acc + " " + s0 : s0;
          if (acc.length >= 45) { out.push({ text: acc, section: st.section }); acc = ""; }
        }
        if (acc) {
          const prev = out[out.length - 1];
          if (prev && prev.section === st.section && acc.length < 30) prev.text += " " + acc;
          else out.push({ text: acc, section: st.section });
        }
      }
      steps.splice(0, steps.length, ...out);
    }

    if (!ingredients.length && !steps.length) return null;

    // 5. Titre : la ligne écrite le plus gros en haut de la 1re photo, sinon la 1re ligne de texte
    const firstMark = [iIngHead >= 0 ? iIngHead : iIng + 1, iStep].filter((i) => i >= 0);
    const headLimit = firstMark.length ? Math.min(...firstMark) : Math.min(L.length, 6);
    const headTexts = L.slice(0, Math.max(0, headLimit)).filter((l) => !l.blank).map((l) => l.text)
      .filter((t) => /[a-zà-ÿ]{3}/i.test(t) && t.length <= 90 && !isTimeLine(t) && !hasQty(t));
    let title = headTexts[0];
    const big = (opts.lines || []).filter((x) => x.photo === 0 && x.h > 0).slice(0, 12)
      .map((x) => ({ t: normSpace(x.text).replace(OCR_BULLET, ""), h: x.h }))
      .filter((x) => headTexts.includes(x.t));
    if (big.length) title = big.reduce((a, b) => (b.h > a.h * 1.15 ? b : a)).t;

    // 6. Portions et temps
    const serv = /pour\s+(\d{1,2})(?:\s*(?:à|-|–)\s*\d{1,2})?\s*(?:personnes?|pers\b|parts?|portions?|gourmands?|convives?)/i.exec(fullText);
    const timeAfter = (word) => {
      const m = new RegExp(`${word}\\s*:?\\s*((?:\\d+\\s*(?:h|heures?|min(?:utes?)?|mn)\\s*\\d*\\s*)+)`, "i").exec(fullText);
      return m ? parseDuration(m[1]) : null;
    };
    const prepTimeMin = timeAfter("pr[ée]paration");
    const cookTimeMin = timeAfter("cuisson");
    return {
      title: title ? (title === title.toUpperCase() && /[A-ZÀ-Ý]{3}/.test(title) ? title.charAt(0) + title.slice(1).toLowerCase() : title).replace(/[.:]+$/, "") : "Recette en photo",
      siteName: "Photo",
      servings: serv ? Number(serv[1]) : null,
      yieldText: serv ? normSpace(serv[0]) : undefined,
      prepTimeMin, cookTimeMin,
      totalTimeMin: totalOf(prepTimeMin, cookTimeMin, null),
      ingredients,
      steps,
      extractedVia: "photo",
      extractedAt: new Date().toISOString(),
    };
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
      ingredients: ingredients.map((s) => s.trim()).filter(Boolean).map((s) => {
        const m = /^\[([^\]]{1,60})\]\s*(.+)$/.exec(s); // "[Pour la pâte] 250 g de farine"
        return m ? { ...parseIngredient(m[2]), section: m[1].trim() } : parseIngredient(s);
      }),
      steps: steps
        .map((s) => (typeof s === "string" ? { text: s } : s || {}))
        .map((s) => ({ text: asStr(s.text) || "", section: asStr(s.section) }))
        .filter((s) => s.text),
      extractedVia: "llm",
      extractedAt: new Date().toISOString(),
    };
  }

  function mergeRecipes(base, ai, via = "llm") {
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
      extractedVia: via,
    };
  }

  // ── Appels au relais ───────────────────────────────────────────
  async function callWorker(path, body) {
    const workerUrl = getWorkerUrl();
    if (!workerUrl) throw new ExtractError("NO_RELAY", "Indiquez d'abord l'adresse du relais dans les Réglages.");
    const accessCode = readSetting(ACCESS_CODE_KEY) || CONFIG.ACCESS_CODE;
    let res;
    try {
      res = await fetch(workerUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(APP && APP.key ? { "x-app-key": APP.key } : accessCode ? { "x-access-code": accessCode } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      if (navigator.onLine === false) {
        throw new ExtractError("OFFLINE", "Pas de connexion : l'extraction nécessite Internet (vos recettes enregistrées restent disponibles).");
      }
      throw new ExtractError(
        "RELAY_UNREACHABLE",
        `Impossible de joindre le relais (${workerUrl}). Vérifiez son adresse dans les Réglages : en l'ouvrant dans Safari, vous devez voir un message commençant par « Relais ».`,
      );
    }
    let raw = "", readFailed = false;
    try { raw = await res.text(); } catch { readFailed = true; }
    let data = null;
    try { data = JSON.parse(raw.trim()); } catch { /* réponse coupée ou illisible */ }
    if (!data && res.ok) {
      throw new ExtractError("RELAY_CUT", readFailed || !raw.trim()
        ? "La réponse du relais a été coupée avant la fin (lecture trop longue). Réessayez ; si ça recommence, vérifiez que relais.js est bien à jour dans Cloudflare."
        : `Réponse illisible du relais : ${raw.trim().slice(0, 120)}`);
    }
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
  /**
   * Analyse d'un HTML déjà récupéré (sans réseau). `log(message, état)` reçoit chaque étape.
   * états : "run" (en cours), "ok", "info", "warn", "error".
   */
  function extractFromHtml(html, sourceUrl, log = () => {}) {
    const doc = new DOMParser().parseFromString(html, "text/html"); // DOMParser n'exécute aucun script
    const meta = getPageMeta(doc, sourceUrl);
    const isComplete = (r) => !!r && r.ingredients.length > 0 && r.steps.length > 0;
    const counts = (r) => `${r.ingredients.length} ingrédient${r.ingredients.length > 1 ? "s" : ""}, ${r.steps.length} étape${r.steps.length > 1 ? "s" : ""}`;

    log("Recherche des données structurées de la recette (schema.org)…", "run");
    const candidates = findJsonLdRecipes(doc);
    const bestNode = candidates.length ? pickBestCandidate(candidates) : null;
    let recipe = bestNode ? jsonLdToRecipe(bestNode, sourceUrl, meta) : null;
    if (isComplete(recipe)) log(`Données structurées trouvées : ${counts(recipe)}`, "ok");
    else if (recipe) log(`Données structurées incomplètes (${counts(recipe)})`, "warn");
    else log("Pas de données structurées sur cette page", "info");

    // Pas de JSON-LD exploitable : lecture du texte libre, toujours sans IA
    if (!isComplete(recipe)) {
      log("Lecture du texte de la page (sans IA)…", "run");
      let found = null;
      try { found = extractHeuristic(doc, sourceUrl, meta); } catch (err) { console.warn("lecture texte libre", err); }
      if (found) {
        recipe = recipe ? mergeRecipes(recipe, found, "html") : found;
        log(`Recette reconnue dans le texte : ${counts(found)}`, "ok");
      } else {
        log("Recette non reconnue dans le texte", "info");
      }
    }
    if (recipe && !recipe.difficulty) {
      try { recipe.difficulty = findDifficultyInPage(doc); } catch { /* facultatif */ }
    }
    if (recipe) {
      try { recipe.chef = detectChef(bestNode, doc, meta); } catch { /* facultatif */ }
      if (recipe.chef) log(`Recette du chef ${recipe.chef}`, "info");
    }
    return { recipe, complete: isComplete(recipe), meta, getText: () => extractMainText(doc) };
  }

  const PROVIDER_NAMES = { gemini: "Gemini", mistral: "Mistral", anthropic: "Claude", openai: "ChatGPT" };

  /** onProgress(message, état) est appelé à chaque étape (journal affiché dans l'appli). */
  async function extractRecipe(input, onProgress = () => {}) {
    const t0 = performance.now();
    const log = (message, status = "info") => {
      try { onProgress(message, status, Math.round(performance.now() - t0)); } catch { /* affichage */ }
    };
    const url = parseTargetUrl(input);
    const warnings = [];

    log(`Récupération de la page via le relais (${new URL(url).hostname})…`, "run");
    let page;
    try {
      page = await callWorker("/page", { url });
    } catch (err) {
      log(err.message, "error");
      throw err;
    }
    log(`Page reçue (${Math.max(1, Math.round(page.html.length / 1024))} Ko)`, "ok");

    const { recipe: partial, complete, meta, getText } = extractFromHtml(page.html, page.finalUrl || url, log);
    if (complete) {
      log(partial.extractedVia === "jsonld" ? "Terminé sans IA (données structurées)" : "Terminé sans IA (lecture du texte)", "ok");
      return { recipe: partial, warnings };
    }

    const hasPartial = !!partial && (partial.ingredients.length > 0 || partial.steps.length > 0);
    if (NO_AI) { // app App Store : pas d'analyse par l'IA
      if (hasPartial) {
        log("Recette partielle conservée (lecture du texte)", "warn");
        return { recipe: partial, warnings: ["Recette incomplète : cette page n'est pas lisible entièrement sans IA. Vérifiez sur le site d'origine."] };
      }
      log("Pas de recette lisible sur cette page", "error");
      throw new ExtractError("NO_RECIPE", "Cette page ne contient pas de recette lisible automatiquement. Ouvrez-la sur le site d'origine.");
    }
    const text = getText();
    if (text.length < CONFIG.MIN_TEXT_FOR_AI) {
      if (hasPartial) {
        log("Texte trop court pour l'IA : recette partielle conservée", "warn");
        return { recipe: partial, warnings: ["Recette incomplète : le site ne fournit pas toutes les informations."] };
      }
      log("Pas assez de texte sur la page", "error");
      throw new ExtractError("NO_RECIPE", "Cette page ne contient pas de recette lisible.");
    }

    log(`Analyse par l'IA (${text.length.toLocaleString("fr-FR")} caractères envoyés, 5 à 30 s)…`, "run");
    let ai = null;
    try {
      const res = await callWorker("/ia", { url: page.finalUrl || url, title: meta.title, text });
      if (res.recipe && res.recipe.found !== false) ai = aiToRecipe(res.recipe, page.finalUrl || url, meta);
      if (ai && ai.ingredients.length === 0 && ai.steps.length === 0) ai = null;
      const who = PROVIDER_NAMES[res.provider] || "l'IA";
      if (ai) {
        ai.aiProvider = res.provider;
        log(`Recette extraite par ${who} : ${ai.ingredients.length} ingrédients, ${ai.steps.length} étapes`, "ok");
      } else {
        log(`${who} n'a pas trouvé de recette dans la page`, "warn");
      }
    } catch (err) {
      log(err.message, hasPartial ? "warn" : "error");
      if (!hasPartial) throw err;
      warnings.push("Recette incomplète : " + err.message);
    }

    if (partial && ai) return { recipe: mergeRecipes(partial, ai), warnings };
    if (ai) return { recipe: ai, warnings };
    if (hasPartial) return { recipe: partial, warnings };
    throw new ExtractError("NO_RECIPE", "Aucune recette trouvée sur cette page.");
  }

  // ── Recherche directe sur les sites de recettes (sans service tiers) ──
  /*
   * L'appli ouvre la page de résultats de recherche de chaque site (via la route /page du relais)
   * et en extrait les liens de recettes, avec leur photo.
   *
   * Pour ajouter un site : son nom, son domaine et une ou plusieurs adresses de recherche
   * (essayées dans l'ordre jusqu'à ce qu'une réponde). "recipe" (facultatif) décrit la forme
   * exacte de ses adresses de recettes ; sans lui, les liens sont reconnus automatiquement.
   */
  const enc = encodeURIComponent;
  /*
   * Liste d'origine. L'utilisateur peut la modifier dans les Réglages (enregistrée sur l'appareil).
   * urls : adresses de recherche, {q} = mots cherchés (essayées dans l'ordre).
   * recipe : forme exacte des adresses de recettes (facultatif ; sinon reconnaissance automatique).
   */
  const DEFAULT_SEARCH_SITES = [
    { id: "marmiton", name: "Marmiton", host: "www.marmiton.org", urls: ["https://www.marmiton.org/recettes/recherche.aspx?aqt={q}"], recipe: "^/recettes/recette_[\\w-]+\\.aspx$" },
    { id: "elle", name: "Elle à table", host: "www.elle.fr", urls: ["https://www.elle.fr/Recherche?q={q}", "https://www.elle.fr/recherche?q={q}"], recipe: "^/Elle-a-Table/Recettes-de-cuisine/[\\w-]+-\\d+$" },
    { id: "cuisineactuelle", name: "Cuisine Actuelle", host: "www.cuisineactuelle.fr", urls: ["https://www.cuisineactuelle.fr/recherche?q={q}", "https://www.cuisineactuelle.fr/recherche?search={q}"], recipe: "^/recettes/[\\w-]+-\\d+$" },
    { id: "750g", name: "750g", host: "www.750g.com", urls: ["https://www.750g.com/recherche/?q={q}"], recipe: "^/[\\w-]+-r\\d+\\.htm$" },
    { id: "jdf", name: "Journal des Femmes", host: "cuisine.journaldesfemmes.fr", urls: ["https://cuisine.journaldesfemmes.fr/s/?f_libelle={q}"], recipe: "^/recette/\\d+-[\\w-]+$" },
    { id: "cuisineaz", name: "Cuisine AZ", host: "www.cuisineaz.com", urls: ["https://www.cuisineaz.com/recettes/recherche_terme.aspx?recherche={q}"], recipe: "^/recettes/[\\w-]+-\\d+\\.aspx$" },
    { id: "ricardo", name: "Ricardo", host: "www.ricardocuisine.com", urls: ["https://www.ricardocuisine.com/recherche?searchValue={q}"], recipe: "^/recettes/\\d+-[\\w-]+$" },
    { id: "papilles", name: "Papilles et Pupilles", host: "www.papillesetpupilles.fr", urls: ["https://www.papillesetpupilles.fr/?s={q}"], recipe: "^/\\d{4}/\\d{2}/[\\w-]+\\.html/?$" },
    { id: "chefsimon", name: "Chef Simon", host: "chefsimon.com", urls: ["https://chefsimon.com/recherche?q={q}", "https://chefsimon.com/search?q={q}"] },
    { id: "herve", name: "Hervé Cuisine", host: "www.hervecuisine.com", urls: ["https://www.hervecuisine.com/?s={q}"] },
    { id: "ietflp", name: "Il était une fois la pâtisserie", host: "www.iletaitunefoislapatisserie.com", urls: ["https://www.iletaitunefoislapatisserie.com/?s={q}"] },
    { id: "ptitchef", name: "Ptitchef", host: "www.ptitchef.com", urls: ["https://www.ptitchef.com/recettes/recherche?q={q}", "https://www.ptitchef.com/recherche?q={q}"] },
    // Recettes de chefs (étoilés et grands noms)
    { id: "atelierdeschefs", name: "L'Atelier des Chefs", host: "www.atelierdeschefs.fr", chef: true, urls: ["https://www.atelierdeschefs.fr/fr/recherche?q={q}", "https://www.atelierdeschefs.fr/recherche?q={q}"] },
  ];
  // Les sites ajoutés dans une nouvelle version rejoignent aussi les listes déjà personnalisées
  const SITES_VERSION = 4;
  // Retirés : Michelin (remplacé par l'index), Madame Figaro (bloque les lectures automatiques),
  // Cuisine et Vins de France (erreur 526 : refuse les connexions du relais)
  const RETIRED_SITES = ["michelin", "madamefigaro", "cvf"];
  const SITES_VERSION_KEY = "zbc.sites.version";
  const SITES_REMOVED_KEY = "zbc.sites.removed";
  const SITES_KEY = "zbc.sites";

  /** "https://www.Elle.fr/Elle-a-Table" ou "elle.fr" → "www.elle.fr" / "elle.fr" */
  function normalizeHost(input) {
    const t = String(input || "").trim();
    if (!t) return "";
    try { return new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return ""; }
  }
  /** Sans adresse de recherche connue : formats les plus courants (WordPress, puis /recherche, /search). */
  function guessSearchUrls(host) {
    return [`https://${host}/?s={q}`, `https://${host}/recherche?q={q}`, `https://${host}/search?q={q}`];
  }
  /** Liste de l'utilisateur (Réglages), sinon liste d'origine. */
  function getSearchSites() {
    try {
      const stored = JSON.parse(localStorage.getItem(SITES_KEY) || "null");
      if (Array.isArray(stored)) {
        let list = stored.filter((x) => x && x.host && !RETIRED_SITES.includes(x.id));
        if (Number(localStorage.getItem(SITES_VERSION_KEY) || 1) < SITES_VERSION) {
          const removed = JSON.parse(localStorage.getItem(SITES_REMOVED_KEY) || "[]");
          const ids = new Set(list.map((x) => x.id));
          list = list.concat(DEFAULT_SEARCH_SITES.filter((d) => !ids.has(d.id) && !removed.includes(d.id)).map((d) => ({ ...d, enabled: true })));
          localStorage.setItem(SITES_KEY, JSON.stringify(list));
          localStorage.setItem(SITES_VERSION_KEY, String(SITES_VERSION));
        }
        return list;
      }
    } catch { /* liste illisible : on repart de l'origine */ }
    return DEFAULT_SEARCH_SITES.map((x) => ({ ...x, enabled: true }));
  }
  /** Mémorise qu'un site d'origine a été supprimé (pour ne pas le rajouter lors d'une mise à jour). */
  function rememberRemovedSite(id) {
    try {
      const removed = JSON.parse(localStorage.getItem(SITES_REMOVED_KEY) || "[]");
      if (!removed.includes(id)) localStorage.setItem(SITES_REMOVED_KEY, JSON.stringify(removed.concat(id)));
    } catch { /* */ }
  }
  function saveSearchSites(list) {
    try { localStorage.setItem(SITES_KEY, JSON.stringify(list)); localStorage.setItem(SITES_VERSION_KEY, String(SITES_VERSION)); } catch { /* stockage indisponible */ }
  }
  function resetSearchSites() {
    try { localStorage.removeItem(SITES_KEY); localStorage.removeItem(SITES_REMOVED_KEY); } catch { /* */ }
  }
  /** Prépare un site pour la recherche (adresses → fonctions, forme des recettes → RegExp). */
  function compileSite(raw) {
    let recipe = null;
    if (raw.recipe) { try { recipe = new RegExp(raw.recipe, "i"); } catch { recipe = null; } }
    const templates = (raw.urls || []).filter((t) => /\{q\}/.test(t));
    return {
      name: raw.name || raw.host,
      host: raw.host,
      chef: !!raw.chef,
      recipe,
      url: (templates.length ? templates : guessSearchUrls(raw.host)).map((t) => (q) => t.split("{q}").join(enc(q))),
    };
  }
  const activeSites = () => getSearchSites().filter((x) => x.enabled !== false).map(compileSite);
  const PER_SITE = 3;
  const MAX_RESULTS = 20;

  const STOP = new Set(["recette", "recettes", "avec", "sans", "pour", "les", "des", "aux", "une", "facile", "rapide", "maison"]);
  function queryWords(q) {
    return fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/(?:s|x)$/, ""));
  }
  /** Le lien parle-t-il bien de la recette cherchée ? (écarte les "recettes populaires" des marges) */
  function matchesQuery(text, words) {
    if (!words.length) return true;
    const t = fold(text);
    const hits = words.filter((w) => t.includes(w)).length;
    // 1 ou 2 mots : tous ; au-delà : au moins 60 % ("gâteau chocolat noisette" ≈ "gâteau au chocolat")
    return words.length <= 2 ? hits === words.length : hits >= Math.ceil(words.length * 0.6);
  }
  /** Texte de lien qui n'est pas un titre de recette (« Lire plus », « Voir la recette »…). */
  const GENERIC_LINK = /^(?:lire|voir|découvrir|decouvrir|en savoir|read|see|more|plus|suite|la suite|cliquez|>|›|»|→)(?:\s|$)|^(?:lire|voir) (?:la )?(?:suite|plus|recette|l'article)|^(?:read|see) (?:more|recipe)|^(?:en )?savoir plus$/i;
  const goodTitle = (t) => !!t && t.length >= 3 && !GENERIC_LINK.test(normSpace(t));
  /** Titre affichable d'une recette indexée : le texte du lien, sinon le titre tiré de l'adresse. */
  const indexTitle = (it) => (goodTitle(it.t) ? it.t : titleFromSlug(new URL(it.u).pathname));
  const titleFromSlug = (path) => {
    const slug = decodeURIComponent(path.split("/").filter(Boolean).pop() || "")
      .replace(/\.(aspx|html?|php)$/i, "").replace(/^recette_/, "").replace(/^\d+-|[-_]r?\d+$|-fid-\d+$/g, "").replace(/[-_]+/g, " ").trim();
    return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "";
  };

  /** Adresse "qui ressemble à une recette" quand le site n'a pas de forme connue. */
  const NOT_RECIPE_PATH = /\/(?:recherche|search|tag|tags|categor(?:y|ie|ies)|rubrique|theme|auteur|author|page\/\d+|feed|wp-|login|compte|account|newsletter|contact|mentions|cgu|cookies?|abonnement|boutique|shop|videos?|dossiers?|selection|idees?|menus?|top-|les-meilleures)(?:[/-]|$)/i;
  function looksLikeRecipePath(path) {
    if (NOT_RECIPE_PATH.test(path) || /\/recettes?-de-/i.test(path)) return false;
    const last = path.split("/").filter(Boolean).pop() || "";
    return last.replace(/\.(aspx|html?|php)$/i, "").length >= 8 && /[a-z]-[a-z]/i.test(last);
  }

  /** Meilleure source d'une image (gère le chargement différé : data-src, srcset…). */
  function bestFromSrcset(srcset) {
    if (!srcset) return "";
    const items = srcset.split(",").map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
    if (!items.length) return "";
    const width = (p) => parseInt(p[1], 10) || 0;
    items.sort((a, b) => Math.abs(width(a) - 400) - Math.abs(width(b) - 400));
    return items[0][0];
  }
  function imageFromElement(root, base) {
    if (!root) return "";
    const nodes = [...root.querySelectorAll("img, picture source")].slice(0, 4);
    for (const el of nodes) {
      const candidates = [
        el.getAttribute("data-src"), el.getAttribute("data-lazy-src"), el.getAttribute("data-original"),
        bestFromSrcset(el.getAttribute("data-srcset")), bestFromSrcset(el.getAttribute("srcset")), el.getAttribute("src"),
      ];
      for (const c of candidates) {
        if (!c || /^data:/i.test(c) || /\.svg(?:[?#]|$)/i.test(c) || /(?:pixel|placeholder|blank|spacer|logo|avatar|icon)/i.test(c)) continue;
        try {
          const u = new URL(c.trim(), base);
          if (/^https?:$/.test(u.protocol)) return u.toString();
        } catch { /* adresse invalide */ }
      }
    }
    return "";
  }
  /** Photo d'un résultat : dans le lien lui-même, sinon dans sa "carte" (bloc qui l'entoure). */
  function imageForLink(a, base) {
    const own = imageFromElement(a, base);
    if (own) return own;
    let box = a.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      if (box.querySelectorAll("a[href]").length > 4 || (box.textContent || "").length > 700) break;
      const img = imageFromElement(box, base);
      if (img) return img;
    }
    return "";
  }

  function linksFromSearchPage(site, html, words) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = `https://${site.host}/`;
    const sameSite = (h) => h.replace(/^www\./, "") === site.host.replace(/^www\./, "");
    const isRecipe = (path) => (site.recipe ? site.recipe.test(path) : looksLikeRecipePath(path));
    const found = new Map(); // url → { title, image }
    const add = (href, title, image) => {
      let u;
      try { u = new URL(href, base); } catch { return; }
      if (!sameSite(u.hostname) || !isRecipe(u.pathname)) return;
      u.search = ""; u.hash = "";
      const key = u.toString();
      const clean = normSpace(title);
      const prev = found.get(key) || { title: "", image: "" };
      found.set(key, {
        title: prev.title || (clean.length >= 3 && clean.length <= 140 ? clean : ""),
        image: prev.image || image || "",
      });
    };
    // 1. Liens visibles (avec titre et photo)
    doc.querySelectorAll("a[href]").forEach((a) => {
      const title = a.getAttribute("title") || a.querySelector("h1,h2,h3,h4,[class*=title i]")?.textContent || a.textContent || a.querySelector("img[alt]")?.getAttribute("alt");
      add(a.getAttribute("href"), title || "", imageForLink(a, base));
    });
    // 2. Liens présents dans les données de la page (sites construits en JavaScript)
    const raw = html.replace(/\\\//g, "/");
    const re = new RegExp(`(?:https?://${site.host.replace(/\./g, "\\.")})?(/[\\w%./-]{6,200})`, "gi");
    for (const m of raw.matchAll(re)) if (isRecipe(m[1])) add(m[1], "", "");

    const out = [];
    for (const [url, info] of found) {
      const path = new URL(url).pathname;
      const t = info.title || titleFromSlug(path);
      if (!matchesQuery(`${t} ${path}`, words)) continue;
      out.push({ url, title: t, image: info.image || undefined, site: site.name, chefSite: site.chef || undefined });
      if (out.length >= PER_SITE) break;
    }
    return out;
  }

  const RELAY_DOWN = ["NO_RELAY", "UNAUTHORIZED", "FORBIDDEN_ORIGIN", "OFFLINE", "RELAY_UNREACHABLE"];

  async function searchOneSite(site, query, words) {
    let lastError = null;
    for (const makeUrl of site.url) {
      try {
        const page = await callWorker("/page", { url: makeUrl(query) });
        const links = linksFromSearchPage(site, page.html, words);
        if (links.length) return { links, error: null };
        lastError = null; // page lue mais vide : on tente l'adresse suivante
      } catch (err) {
        if (RELAY_DOWN.includes(err.code)) throw err;
        lastError = err;
      }
    }
    // Recherche du site refusée, introuvable ou sans résultat lisible : on passe par un moteur de recherche
    // (« site:www.exemple.fr gratin »), qui renvoie les mêmes pages de recettes.
    const viaEngine = await searchViaEngine(site, query, words);
    if (viaEngine.links.length) return { links: viaEngine.links, error: null, via: viaEngine.engine };
    return { links: [], error: lastError ? lastError.message : null };
  }

  // ── Recherche de secours par moteur de recherche (Bing, puis DuckDuckGo) ──
  const SEARCH_ENGINES = [
    { name: "Bing", url: (host, q) => `https://www.bing.com/search?q=${encodeURIComponent(`site:${host} ${q}`)}&setlang=fr&cc=FR&count=30` },
    { name: "DuckDuckGo", url: (host, q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:${host} ${q}`)}&kl=fr-fr` },
  ];
  /** Lien d'un moteur → vraie adresse (Bing et DuckDuckGo passent parfois par une adresse de redirection). */
  function unwrapEngineLink(href, base) {
    let u;
    try { u = new URL(href, base); } catch { return null; }
    if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get("uddg")) {
      try { return new URL(u.searchParams.get("uddg")); } catch { return null; }
    }
    if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/")) {
      const enc = u.searchParams.get("u") || "";
      if (enc.startsWith("a1")) {
        try { return new URL(atob(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
      }
      return null;
    }
    return u;
  }
  async function searchViaEngine(site, query, words) {
    const sameSite = (h) => h.replace(/^www\./, "") === site.host.replace(/^www\./, "");
    const isRecipe = (path) => (site.recipe ? site.recipe.test(path) : looksLikeRecipePath(path));
    for (const engine of SEARCH_ENGINES) {
      let page;
      try { page = await callWorker("/page", { url: engine.url(site.host, query) }); } catch (err) {
        if (RELAY_DOWN.includes(err.code)) throw err;
        continue;
      }
      const doc = new DOMParser().parseFromString(page.html, "text/html");
      const found = new Map();
      doc.querySelectorAll("a[href]").forEach((a) => {
        const u = unwrapEngineLink(a.getAttribute("href"), page.finalUrl || engine.url(site.host, query));
        if (!u || !sameSite(u.hostname) || !isRecipe(u.pathname)) return;
        u.search = ""; u.hash = "";
        const key = u.toString();
        // titre du résultat, sans le « - Marmiton » ou « | Ptitchef » ajouté par le site
        const t = normSpace(a.textContent).replace(/\s*[-|–—·:]\s*[^-|–—·:]{2,40}$/, "").slice(0, 140);
        if (!found.has(key) || (!goodTitle(found.get(key)) && goodTitle(t))) found.set(key, t);
      });
      const out = [];
      for (const [url, t0] of found) {
        const path = new URL(url).pathname;
        const t = goodTitle(t0) && !/^https?:/.test(t0) ? t0 : titleFromSlug(path);
        if (!matchesQuery(`${t} ${path}`, words)) continue;
        out.push({ url, title: t, image: cachedImage(url) || undefined, site: site.name, chefSite: site.chef || undefined });
        if (out.length >= PER_SITE) break;
      }
      if (out.length) return { links: out, engine: engine.name };
    }
    return { links: [] };
  }


  // ── Index des recettes de chefs ────────────────────────────────
  /*
   * Certains sites de chefs n'ont pas de moteur de recherche interrogeable : on parcourt leurs
   * listes de recettes une fois par semaine (le relais ne renvoie que les liens, quelques Ko),
   * et l'index est gardé sur l'appareil. Chaque recherche y puise instantanément.
   */
  const CHEF_CATALOGS = [
    { id: "gm-fr", name: "Gault&Millau", host: "fr.gaultmillau.com", maxPages: 40,
      page: (n) => (n === 1 ? "https://fr.gaultmillau.com/fr/collections/recettes" : `https://fr.gaultmillau.com/fr/collections/recettes?page=${n}`),
      motif: "^/fr/news/[\\w-]+$" },
    { id: "gm-ch", name: "Gault&Millau Suisse", host: "www.gaultmillau.ch", maxPages: 80,
      page: (n) => (n === 1 ? "https://www.gaultmillau.ch/fr/recettes" : `https://www.gaultmillau.ch/fr/recettes?page=${n - 1}`),
      motif: "^/fr/recettes/[\\w-]+-\\d+$" },
    { id: "lhr", name: "L'Hôtellerie Restauration", host: "www.lhotellerie-restauration.fr", maxPages: 80,
      page: (n) => (n === 1 ? "https://www.lhotellerie-restauration.fr/actualite/theme/recette" : `https://www.lhotellerie-restauration.fr/actualite/theme/recette?page=${n}`),
      motif: "^/actualite/[\\w-]+$" },
    // Arts & Gastronomie : ~2 250 recettes de chefs, rangées par « classement » (pages WordPress /page/N/)
    { id: "artsgastro", name: "Arts & Gastronomie", host: "www.arts-et-gastronomie.com", maxPages: 40,
      lists: ["bistronomique", "gastronomique", "une-etoile", "deux-etoiles", "trois-etoiles"].map((k) => (n) =>
        (n === 1 ? `https://www.arts-et-gastronomie.com/classement/${k}/` : `https://www.arts-et-gastronomie.com/classement/${k}/page/${n}/`)),
      motif: "^/recette/[\\w-]+/?$" },
    // AFTouch Cuisine : ~3 000 recettes créées ou corrigées par un chef étoilé (Patrick Asfaux), 24 par page
    { id: "aftouch", name: "AFTouch Cuisine", host: "aftouch-cuisine.com", maxPages: 40,
      lists: ["entrees", "viandes", "poissons-crustaces", "plats", "desserts", "sauces", "legumes"].map((k) => (n) =>
        (n === 1 ? `https://aftouch-cuisine.com/category/${k}` : `https://aftouch-cuisine.com/category/${k}?page=${n}`)),
      motif: "^/recette/[\\w-]+-\\d+\\.html$" },
    { id: "lefooding", name: "Le Fooding", host: "lefooding.com", maxPages: 60,
      page: (n) => (n === 1 ? "https://lefooding.com/recettes/" : `https://lefooding.com/recettes/?page=${n}`),
      motif: "^/recettes/[\\w-]+/?$" },
    { id: "doitinparis", name: "Do It in Paris (chefs)", host: "www.doitinparis.com", maxPages: 1,
      page: () => "https://www.doitinparis.com/fr/recettes/recettes-de-chefs",
      motif: "^/fr/[\\w-]+-\\d+$" },
    { id: "lhr-recettes", name: "L'Hôtellerie Restauration (recettes)", host: "www.lhotellerie-restauration.fr", maxPages: 50,
      page: (n) => (n === 1 ? "https://www.lhotellerie-restauration.fr/actualite/theme/recettes" : `https://www.lhotellerie-restauration.fr/actualite/theme/recettes?page=${n}`),
      motif: "^/actualite/[\\w-]+$" },
  ];
  const CHEF_INDEX_KEY = "zbc.chefIndex";
  const CHEF_SOURCES_OFF_KEY = "zbc.chefSourcesOff";
  const INDEX_MAX_AGE = 7 * 24 * 3600 * 1000;

  function readChefIndex() {
    try { return JSON.parse(localStorage.getItem(CHEF_INDEX_KEY) || "null") || { sites: {} }; } catch { return { sites: {} }; }
  }
  function writeChefIndex(idx) {
    try { localStorage.setItem(CHEF_INDEX_KEY, JSON.stringify(idx)); } catch { /* stockage plein : on garde l'index en mémoire */ }
  }
  function chefSourcesOff() {
    try { return JSON.parse(localStorage.getItem(CHEF_SOURCES_OFF_KEY) || "[]"); } catch { return []; }
  }
  function setChefSourceEnabled(id, on) {
    const off = new Set(chefSourcesOff());
    if (on) off.delete(id); else off.add(id);
    try { localStorage.setItem(CHEF_SOURCES_OFF_KEY, JSON.stringify([...off])); } catch { /* */ }
  }
  /** État de l'index, pour les Réglages. */
  // ── Sources de chefs ajoutées par l'utilisateur (Réglages) ──
  const CHEF_CUSTOM_KEY = "zbc.chefCustom";
  function customChefSources() {
    try { const v = JSON.parse(localStorage.getItem(CHEF_CUSTOM_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function customToCatalog(c) {
    const page = (n) => {
      if (n === 1) return c.url;
      const u = new URL(c.url);
      if (c.paging === "query") { u.searchParams.set(c.param || "page", String(n)); return u.toString(); }
      u.pathname = u.pathname.replace(/\/?$/, `/page/${n}/`); // c.paging === "path"
      return u.toString();
    };
    return { id: c.id, name: c.name, host: c.host, maxPages: c.paging === "none" ? 1 : 40, page, motif: c.motif, custom: true };
  }
  const allChefCatalogs = () => [...CHEF_CATALOGS, ...customChefSources().map(customToCatalog)];

  /**
   * Analyse une page de liste de recettes choisie par l'utilisateur : trouve la forme de ses liens de
   * recettes (le groupe de liens le plus nombreux du même site) et la façon de passer à la page 2.
   */
  async function detectChefSource(input) {
    const url = parseTargetUrl(input);
    const page = await callWorker("/page", { url });
    const base = new URL(page.finalUrl || url);
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const groups = new Map();
    let paging = "none", param = "page";
    doc.querySelectorAll("a[href]").forEach((a) => {
      let u; try { u = new URL(a.getAttribute("href"), base); } catch { return; }
      if (u.hostname !== base.hostname) return;
      const pm = /[?&]((?:p|pg|page|paged))=2(?:&|$)/i.exec(u.search);
      if (pm && paging === "none") { paging = "query"; param = pm[1]; }
      if (/\/page\/2\/?$/.test(u.pathname) && paging === "none") paging = "path";
      const m = /^(.*\/)([^/]+?)(\.html?)?(\/?)$/.exec(u.pathname);
      if (!m) return;
      const [, prefix, slug, ext = "", slash] = m;
      if (!slug.includes("-") || slug.length < 8 || prefix === "/" && !ext) return; // un titre de recette en « slug »
      const key = `${prefix}*${ext}`;
      u.search = ""; u.hash = "";
      const g = groups.get(key) || { prefix, ext, slash, items: new Map() };
      const t = normSpace(a.textContent).slice(0, 160);
      const prev = g.items.get(u.toString()) || { u: u.toString(), t: "", i: "" };
      if (!goodTitle(prev.t) && goodTitle(t)) prev.t = t;
      prev.i = prev.i || imageFromElement(a, base.toString());
      g.items.set(u.toString(), prev);
      groups.set(key, g);
    });
    const best = [...groups.values()].sort((a, b) => b.items.size - a.items.size)[0];
    if (!best || best.items.size < 4) throw new ExtractError("NO_LINKS", "Je ne trouve pas de liste de recettes sur cette page. Donnez l'adresse d'une page qui liste des recettes (catégorie, « toutes les recettes »…).");
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const motif = `^${esc(best.prefix)}[\\w.%-]+${best.ext ? esc(best.ext) : "/?"}$`;
    const siteName = normSpace((doc.querySelector('meta[property="og:site_name"]') || {}).content || "")
      || base.hostname.replace(/^www\./, "");
    const items = [...best.items.values()];
    return { name: siteName.slice(0, 60), host: base.hostname, url: base.toString(), paging, param, motif, count: items.length,
      sample: items.slice(0, 3).map((x) => x.t || titleFromSlug(new URL(x.u).pathname)) };
  }
  function addChefSource(src) {
    const list = customChefSources();
    const id = `u-${Date.now().toString(36)}`;
    list.push({ id, name: src.name, host: src.host, url: src.url, paging: src.paging, param: src.param, motif: src.motif });
    localStorage.setItem(CHEF_CUSTOM_KEY, JSON.stringify(list));
    return id;
  }
  function removeChefSource(id) {
    localStorage.setItem(CHEF_CUSTOM_KEY, JSON.stringify(customChefSources().filter((c) => c.id !== id)));
    const idx = readChefIndex();
    delete idx.sites[id];
    writeChefIndex(idx);
  }

  function chefIndexStatus() {
    const idx = readChefIndex();
    const off = chefSourcesOff();
    return allChefCatalogs().map((c) => {
      const e = idx.sites[c.id];
      return { id: c.id, name: c.name, host: c.host, custom: !!c.custom, enabled: !off.includes(c.id), count: e ? e.items.length : 0, at: e ? e.at : 0, error: e ? e.error || "" : "" };
    });
  }

  let indexing = null; // indexation en cours (une seule à la fois)

  /** Liens de recettes d'une page de liste : via /liens (léger), sinon via /page (relais ancien). */
  let linksRouteMissing = false; // relais pas encore mis à jour : inutile de retenter /liens
  async function catalogPageLinks(cat, n, page = cat.page) {
    const url = page(n);
    try {
      if (linksRouteMissing) throw new ExtractError("NOT_FOUND", "");
      const res = await callWorker("/liens", { url, motif: cat.motif });
      return res.links || [];
    } catch (err) {
      if (err.code !== "NOT_FOUND") throw err;
      linksRouteMissing = true;
      // Relais pas encore mis à jour : on lit la page entière
      const page = await callWorker("/page", { url });
      const doc = new DOMParser().parseFromString(page.html, "text/html");
      const re = new RegExp(cat.motif, "i");
      const out = new Map();
      doc.querySelectorAll("a[href]").forEach((a) => {
        let u; try { u = new URL(a.getAttribute("href"), url); } catch { return; }
        if (u.hostname !== cat.host || !re.test(u.pathname)) return;
        u.search = ""; u.hash = "";
        const k = u.toString();
        const prev = out.get(k) || { u: k, t: "", i: "" };
        let txt = normSpace(a.textContent).slice(0, 160);
        if (!goodTitle(txt)) { // « Lire plus » : on prend le titre de la carte qui contient le lien
          let box = a.parentElement;
          for (let k = 0; box && k < 4 && !box.querySelector("h1,h2,h3,h4"); k++) box = box.parentElement;
          const head = box && box.querySelector("h1,h2,h3,h4");
          if (head) txt = normSpace(head.textContent).slice(0, 160);
        }
        if (!goodTitle(prev.t) && goodTitle(txt)) prev.t = txt;
        prev.i = prev.i || imageFromElement(a, url);
        out.set(k, prev);
      });
      return [...out.values()];
    }
  }

  async function indexCatalog(cat, onProgress) {
    const items = new Map();
    const lists = cat.lists || [cat.page]; // une source peut avoir plusieurs listes (catégories)
    let firstError = null, pagesRead = 0;
    for (const page of lists) {
      let emptyStreak = 0;
      for (let n = 1; n <= cat.maxPages; n++) {
        let links;
        try { links = await catalogPageLinks(cat, n, page); pagesRead++; } catch (err) {
          if (n === 1) { firstError = firstError || err; }
          break; // fin de la pagination (404) ou liste indisponible : on garde ce qu'on a
        }
        if (n === 1 && !links.length) break;
        let added = 0;
        for (const l of links) {
          const t = goodTitle(l.t) ? l.t : "";
          if (!items.has(l.u)) { items.set(l.u, { u: l.u, t: t || titleFromSlug(new URL(l.u).pathname), i: l.i || "", slugTitle: !t }); added++; }
          else {
            const it = items.get(l.u);
            if (t && it.slugTitle) { it.t = t; delete it.slugTitle; } // un autre lien vers la même recette porte son vrai nom
            if (l.i && !it.i) it.i = l.i;
          }
        }
        onProgress(cat, pagesRead, items.size);
        emptyStreak = added ? 0 : emptyStreak + 1;
        if (emptyStreak >= 2) break; // plus rien de nouveau : dernière page atteinte
      }
    }
    if (!items.size) {
      throw firstError || new ExtractError("NO_LINKS", "Aucune recette trouvée sur sa page de liste (site protégé ou modifié). Mettez le relais à jour, puis réessayez.");
    }
    return [...items.values()];
  }

  /**
   * Met à jour l'index (sources activées). force = ignorer l'âge de l'index.
   * onProgress({ site, page, count, done, total }).
   */
  function refreshChefIndex({ force = false, only = null, onProgress = () => {} } = {}) {
    if (indexing) return indexing;
    indexing = (async () => {
      const idx = readChefIndex();
      const off = chefSourcesOff();
      const todo = only
        ? allChefCatalogs().filter((c) => c.id === only) // une seule source, à la demande (bouton de sa ligne)
        : allChefCatalogs().filter((c) => !off.includes(c.id) && (force || !idx.sites[c.id] || Date.now() - idx.sites[c.id].at > INDEX_MAX_AGE || idx.sites[c.id].error));
      let done = 0;
      // 2 sources à la fois : rapide sans surcharger le relais
      const queue = todo.slice();
      const worker = async () => {
        while (queue.length) {
          const cat = queue.shift();
          try {
            const items = await indexCatalog(cat, (c, page, count) => onProgress({ site: c.name, page, count, done, total: todo.length }));
            idx.sites[cat.id] = { at: Date.now(), items };
          } catch (err) {
            if (["NO_RELAY", "OFFLINE", "RELAY_UNREACHABLE", "UNAUTHORIZED", "FORBIDDEN_ORIGIN"].includes(err.code)) throw err;
            idx.sites[cat.id] = { at: Date.now(), items: (idx.sites[cat.id] && idx.sites[cat.id].items) || [], error: err.message };
          }
          done++;
          writeChefIndex(idx);
          onProgress({ site: cat.name, done, total: todo.length });
        }
      };
      await Promise.all([worker(), worker()]);
      return chefIndexStatus();
    })();
    indexing.finally(() => { indexing = null; });
    return indexing;
  }
  const chefIndexStale = () => {
    const idx = readChefIndex(); const off = chefSourcesOff();
    return allChefCatalogs().some((c) => !off.includes(c.id) && (!idx.sites[c.id] || Date.now() - idx.sites[c.id].at > INDEX_MAX_AGE));
  };

  // ── Photos des recettes : cache local + aperçus groupés par le relais ──
  const IMG_CACHE_KEY = "zbc.imgCache";
  const IMG_CACHE_MAX = 1500;
  let imgCache = null;
  const readImgCache = () => {
    if (!imgCache) { try { imgCache = JSON.parse(localStorage.getItem(IMG_CACHE_KEY) || "{}") || {}; } catch { imgCache = {}; } }
    return imgCache;
  };
  let imgSaveTimer = 0;
  function saveImgCache() {
    clearTimeout(imgSaveTimer);
    imgSaveTimer = setTimeout(() => {
      const keys = Object.keys(imgCache);
      if (keys.length > IMG_CACHE_MAX) keys.slice(0, keys.length - IMG_CACHE_MAX).forEach((k) => delete imgCache[k]);
      try { localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(imgCache)); } catch { /* stockage plein */ }
    }, 300);
  }
  const cachedImage = (url) => readImgCache()[url] || "";
  /** Mémorise la photo d'une recette (cache + index des chefs) pour l'afficher tout de suite la prochaine fois. */
  function rememberImage(url, img) {
    if (!url || !img || !/^https?:\/\//i.test(img)) return;
    const c = readImgCache();
    if (c[url] === img) return;
    delete c[url]; c[url] = img; // plus récent en dernier
    saveImgCache();
  }
  let apercusMissing = false; // relais pas encore mis à jour : on attend l'analyse des pages
  /** Photos principales de plusieurs recettes, en un seul appel au relais : { url: photo } */
  async function previewImages(urls) {
    const list = [...new Set(urls)].filter(Boolean).slice(0, 12);
    if (!list.length || apercusMissing) return {};
    try {
      const { images } = await callWorker("/apercus", { urls: list });
      Object.entries(images || {}).forEach(([u, img]) => rememberImage(u, img));
      return images || {};
    } catch (err) {
      if (err.code === "NOT_FOUND") apercusMissing = true;
      return {};
    }
  }

  /** Recettes de chefs de l'index qui correspondent à la recherche. */
  /** Nombre de recettes de chefs indexées (sources activées). */
  function chefIndexCount() {
    const idx = readChefIndex(); const off = chefSourcesOff();
    return allChefCatalogs().filter((c) => !off.includes(c.id) && idx.sites[c.id]).reduce((n, c) => n + idx.sites[c.id].items.length, 0);
  }
  /** Toutes les recettes de chefs indexées, pour les parcourir : [{ url, title, image, site, sourceId }] */
  function chefIndexItems() {
    const idx = readChefIndex(); const off = chefSourcesOff();
    return allChefCatalogs().filter((c) => !off.includes(c.id) && idx.sites[c.id]).flatMap((c) =>
      idx.sites[c.id].items.map((it) => ({ url: it.u, title: indexTitle(it), image: it.i || cachedImage(it.u) || undefined, site: c.name, sourceId: c.id, chefSite: true })));
  }

  function searchChefIndex(words, perSource = 4) {
    const idx = readChefIndex();
    const off = chefSourcesOff();
    return allChefCatalogs().filter((c) => !off.includes(c.id) && idx.sites[c.id]).map((c) =>
      idx.sites[c.id].items
        .filter((it) => matchesQuery(`${it.t} ${new URL(it.u).pathname}`, words))
        .slice(0, perSource)
        .map((it) => ({ url: it.u, title: indexTitle(it), image: it.i || cachedImage(it.u) || undefined, site: c.name, chefSite: true })));
  }

  /**
   * Cherche sur tous les sites en parallèle. onSite(nom, nombre, erreur) informe de l'avancement.
   * Résultats entrelacés (1er de chaque site, puis 2e…) pour varier les sources.
   */
  async function searchRecipes(q, onSite = () => {}) {
    const query = normSpace(q);
    if (query.length < 2) throw new ExtractError("INVALID_QUERY", "Tapez au moins 2 lettres.");
    const words = queryWords(query);
    const sites = activeSites();
    const onlyIndex = !sites.length; // aucun site de recherche : on cherche seulement dans l'index des chefs
    if (onlyIndex && !chefIndexCount()) {
      throw new ExtractError("NO_SITES", "Aucun site de recherche activé et aucune recette de chef indexée : choisissez des sites dans les Réglages.");
    }
    const perSite = await Promise.all(sites.map(async (site) => {
      const { links, error, via } = await searchOneSite(site, query, words);
      onSite(site.name, links.length, error, via);
      return links;
    }));
    // Recettes de chefs de l'index (instantané, sans réseau)
    const fromIndex = searchChefIndex(words, onlyIndex ? MAX_RESULTS : 4);
    fromIndex.forEach((list) => { if (list.length) onSite(`${list[0].site} (index)`, list.length, null); });
    const lists = perSite.concat(fromIndex);
    const results = [];
    const seen = new Set();
    for (let i = 0; i < (onlyIndex ? MAX_RESULTS : 4) && results.length < MAX_RESULTS; i++) {
      for (const list of lists) {
        const r = list[i];
        if (r && !seen.has(r.url) && results.length < MAX_RESULTS) {
          seen.add(r.url);
          if (r.image) rememberImage(r.url, r.image); else r.image = cachedImage(r.url) || undefined;
          results.push(r);
        }
      }
    }
    return results;
  }

  /** Teste un site (Réglages) : nombre de recettes trouvées pour une recherche d'essai. */
  async function testSearchSite(raw, q = "gâteau au chocolat") {
    const site = compileSite(raw);
    const { links, error } = await searchOneSite(site, q, queryWords(q));
    return { count: links.length, error, sample: links[0] ? links[0].title : "" };
  }

  /** Texte → voix (Gemini via le relais) : { audio (base64), mimeType } */
  async function synthesize(text) {
    return callWorker("/voix", { text });
  }

  /** Récupère et analyse une page SANS IA (pour les fiches de résultats). */
  async function analyzeUrl(url) {
    const page = await callWorker("/page", { url });
    const finalUrl = page.finalUrl || url;
    const { recipe, complete } = extractFromHtml(page.html, finalUrl);
    return { recipe, complete, finalUrl };
  }

  window.ZBC = {
    CONFIG, ACCESS_CODE_KEY, WORKER_URL_KEY, getWorkerUrl, ExtractError, NO_AI, APP,
    extractRecipe, extractFromHtml, parseTargetUrl, searchRecipes, readPhotos, recipeFromText, photosToRecipeAI, analyzeUrl, previewImages, rememberImage, cachedImage, synthesize, refreshChefIndex, chefIndexStatus, chefIndexStale, setChefSourceEnabled, CHEF_CATALOGS, detectChefSource, addChefSource, removeChefSource, chefIndexItems, chefIndexCount, matchesQuery, queryWords, getSearchSites, saveSearchSites, resetSearchSites, rememberRemovedSite, normalizeHost, testSearchSite, DEFAULT_SEARCH_SITES,
    parseIngredient, formatIngredient, formatQuantity, parseDuration, parseServings,
  };
})();
