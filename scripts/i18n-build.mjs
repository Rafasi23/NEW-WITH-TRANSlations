import fs from "fs";
import path from "path";
import fg from "fast-glob";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { minify } from "html-minifier-terser";

// --------- SETTINGS ----------
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "new-main");  // <- your Portuguese site folder
const DIST_DIR = path.join(ROOT, "dist");     // output
const CACHE_DIR = path.join(ROOT, ".i18n-cache");
const I18N_DIR = path.join(ROOT, "i18n");

const DEFAULT_LOCALE = "pt";
const TARGET_LOCALES = ["en", "es"];
const SITE_ORIGIN = "https://www.queenacademy.pt"; // used for hreflang links

// Minify HTML output
const MINIFY_OPTS = {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true
};

// --------- HELPERS ----------
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function ensureFileCopy(srcFile, destFile) { ensureDir(path.dirname(destFile)); fs.copyFileSync(srcFile, destFile); }
function readJSON(p, fallback = {}) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJSON(p, obj) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); }

function readEnvKey(k) {
  try {
    const txt = fs.readFileSync(".env", "utf8");
    for (const line of txt.split(/\r?\n/)) if (line.startsWith(k + "=")) return line.split("=").slice(1).join("=").trim();
  } catch {}
  return "";
}
const DEEPL_KEY = process.env.DEEPL_KEY || readEnvKey("DEEPL_KEY");

function isSkippableTag(tag) { return /^(script|style|noscript|code|pre|textarea|svg|math)$/i.test(tag); }

function gatherTextNodes(doc) {
  const { NodeFilter } = doc.defaultView;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const p = n.parentElement;
      if (!p || isSkippableTag(p.tagName)) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function extractStringsFromHTML(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const set = new Set();

  // Body text nodes
  gatherTextNodes(doc).forEach(n => set.add(n.nodeValue.trim()));

  // Meta title + description
  const title = doc.querySelector("title");
  if (title && title.textContent.trim()) set.add(title.textContent.trim());
  const desc = doc.querySelector('meta[name="description"]');
  if (desc && desc.getAttribute("content")) set.add(desc.getAttribute("content").trim());

  // Common attributes
  const ATTRS = ["alt","title","placeholder","aria-label","value"];
  ATTRS.forEach(attr => {
    doc.querySelectorAll(`[${attr}]`).forEach(el => {
      const v = el.getAttribute(attr);
      if (v && v.trim()) set.add(v.trim());
    });
  });

  return Array.from(set);
}

async function translateWithDeepL(texts, target) {
  if (!texts.length) return [];
  const params = new URLSearchParams();
  texts.forEach(t => params.append("text", t));
  params.append("target_lang", target.toUpperCase());
  const r = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: { "Authorization": `DeepL-Auth-Key ${DEEPL_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!r.ok) throw new Error(`DeepL error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.translations || []).map(x => x.text);
}

async function translateBatch(texts, target) {
  const out = [];
  const CHUNK = 40;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const part = await translateWithDeepL(slice, target);
    out.push(...part);
  }
  return out;
}

function relPathFrom(file, baseDir) {
  const r = path.relative(baseDir, file).replace(/\\/g, "/");
  return "/" + r;
}

function urlFor(locale, relPath) {
  const base = locale === DEFAULT_LOCALE ? SITE_ORIGIN : `${SITE_ORIGIN}/${locale}`;
  return `${base}${relPath}`;
}

function injectSEO(doc, relPath, locale) {
  doc.documentElement.setAttribute("lang", locale);
  doc.querySelectorAll('link[rel="alternate"][hreflang]').forEach(n => n.remove());
  const locales = [DEFAULT_LOCALE, ...TARGET_LOCALES];
  for (const lc of locales) {
    const link = doc.createElement("link");
    link.setAttribute("rel", "alternate");
    link.setAttribute("hreflang", lc);
    link.setAttribute("href", urlFor(lc, relPath));
    doc.head.appendChild(link);
  }
  const x = doc.createElement("link");
  x.setAttribute("rel", "alternate");
  x.setAttribute("hreflang", "x-default");
  x.setAttribute("href", urlFor(DEFAULT_LOCALE, relPath));
  doc.head.appendChild(x);
}

function injectLangSwitcher(doc, relPath) {
  const bar = doc.createElement("div");
  bar.id = "qa-lang-switcher";
  bar.innerHTML = `
    <style>
      #qa-lang-switcher{position:fixed;top:10px;right:10px;z-index:9999;font:14px/1.2 system-ui,
      -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#fff;padding:6px 8px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
      #qa-lang-switcher a{margin:0 4px;text-decoration:none}
    </style>
    <a href="${urlFor("pt", relPath)}">PT</a> | 
    <a href="${urlFor("en", relPath)}">EN</a> | 
    <a href="${urlFor("es", relPath)}">ES</a>
  `;
  doc.body.appendChild(bar);
}

function translateString(lang, src, caches, overrides) {
  const ov = overrides[lang] || {};
  if (ov[src]) return ov[src];
  const c = caches[lang] || {};
  return c[src] || src;
}

// Optional post-fix (light touch; overrides should handle most)
function postFix(lang, text) {
  if (!text) return text;
  if (lang === "en") {
    text = text.replace(/\/\s*Hora\b/gi, "/ hour");
  }
  if (lang === "es") {
    text = text.replace(/\/\s*Hora\b/gi, "/ hora");
  }
  return text;
}

// Optional full-HTML post-processing (helps when words are split across spans)
function postProcessHTML(locale, html) {
  if (locale === "en") {
    // fix PT split and wrong EN MT
    html = html.replace(/Sobre\s+Mim/gi, "About Me");
    html = html.replace(/About\s+Mim/gi, "About Me");
    // marketing check-up variants
    html = html.replace(/Check[-\s]?up\s+de\s+Marketing/gi, "Marketing check-up");
  } else if (locale === "es") {
    html = html.replace(/Sobre\s+Mim/gi, "Sobre mí");
  }
  return html;
}

// --------- MAIN BUILD ----------
(async () => {
  if (!DEEPL_KEY) {
    console.error("ERROR: No DEEPL_KEY found in .env");
    process.exit(1);
  }

  ensureDir(DIST_DIR);
  ensureDir(CACHE_DIR);
  ensureDir(I18N_DIR);

  // Copy static assets to all outputs
  const staticFiles = await fg(["**/*", "!**/*.html"], { cwd: SRC_DIR, absolute: true, onlyFiles: true, dot: true });
  function copyStaticsTo(base) {
    staticFiles.forEach(file => {
      const rel = path.relative(SRC_DIR, file);
      const out = path.join(base, rel);
      ensureFileCopy(file, out);
    });
  }
  copyStaticsTo(DIST_DIR);
  copyStaticsTo(path.join(DIST_DIR, "pt"));
  copyStaticsTo(path.join(DIST_DIR, "en"));
  copyStaticsTo(path.join(DIST_DIR, "es"));

  const htmlFiles = await fg("**/*.html", { cwd: SRC_DIR, absolute: true });

  // Load overrides + caches
  const overrides = {
    en: readJSON(path.join(I18N_DIR, "overrides.en.json"), {}),
    es: readJSON(path.join(I18N_DIR, "overrides.es.json"), {})
  };
  const caches = {
    en: readJSON(path.join(CACHE_DIR, "en.json"), {}),
    es: readJSON(path.join(CACHE_DIR, "es.json"), {})
  };

  // Collect all unique PT strings
  const allPT = new Set();
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    extractStringsFromHTML(html).forEach(s => allPT.add(s));
  }
  const base = Array.from(allPT);

  // Translate missing per language
  for (const lang of TARGET_LOCALES) {
    const cache = caches[lang];
    const ov = overrides[lang];
    const need = base.filter(s => !(s in cache) && !(s in ov));
    if (need.length) {
      console.log(`[${lang}] translating ${need.length} strings...`);
      const tr = await translateBatch(need, lang);
      need.forEach((src, i) => cache[src] = tr[i]);
      writeJSON(path.join(CACHE_DIR, `${lang}.json`), cache);
    } else {
      console.log(`[${lang}] nothing to translate (using cache/overrides).`);
    }
  }

  const ATTRS = ["alt","title","placeholder","aria-label","value"];

  async function processOne(file, outFile, locale) {
    const html = fs.readFileSync(file, "utf8");
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const rel = relPathFrom(file, SRC_DIR);

    if (locale !== "pt") {
      // Text nodes
      gatherTextNodes(doc).forEach(n => {
        const original = n.nodeValue;
        const trimmed = original.trim();
        if (!trimmed) return;
        const lead = original.match(/^\s*/)[0];
        const trail = original.match(/\s*$/)[0];
        const tr = translateString(locale, trimmed, caches, overrides);
        n.nodeValue = lead + postFix(locale, tr) + trail;
      });

      // Attributes
      ATTRS.forEach(attr => {
        doc.querySelectorAll(`[${attr}]`).forEach(el => {
          const v = el.getAttribute(attr);
          if (v && v.trim()) {
            el.setAttribute(attr, postFix(locale, translateString(locale, v.trim(), caches, overrides)));
          }
        });
      });

      // Title
      const title = doc.querySelector("title");
      if (title && title.textContent.trim()) {
        title.textContent = postFix(locale, translateString(locale, title.textContent.trim(), caches, overrides));
      }

      // Meta description
      const desc = doc.querySelector('meta[name="description"]');
      if (desc && desc.getAttribute("content")) {
        const v = desc.getAttribute("content").trim();
        desc.setAttribute("content", postFix(locale, translateString(locale, v, caches, overrides)));
      }
    }

    // SEO + switcher
    injectSEO(doc, rel, locale);
    injectLangSwitcher(doc, rel);

    // Serialize + post-process + minify
    let outHTML = dom.serialize();
    outHTML = postProcessHTML(locale, outHTML);
    outHTML = await minify(outHTML, MINIFY_OPTS);

    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, outHTML, "utf8");
  }

  // Build PT (root + /pt)
  for (const file of htmlFiles) {
    const rel = path.relative(SRC_DIR, file);
    const outRoot = path.join(DIST_DIR, rel);
    const outPT   = path.join(DIST_DIR, "pt", rel);
    await processOne(file, outRoot, "pt");
    await processOne(file, outPT, "pt");
  }

  // Build EN/ES
  for (const lang of TARGET_LOCALES) {
    for (const file of htmlFiles) {
      const rel = path.relative(SRC_DIR, file);
      const outFile = path.join(DIST_DIR, lang, rel);
      await processOne(file, outFile, lang);
    }
  }

  console.log("✅ Build complete. Output in /dist (root=PT, plus /pt, /en, /es)");
})();

