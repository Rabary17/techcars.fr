#!/usr/bin/env node
// Autopilote actus techcars.fr (site statique) — même principe que techno-play :
// le script écrit un article Markdown dans content/posts/, le workflow fait le
// commit et le push, et Vercel reconstruit le site.
//
// Chaîne : sheet de veille (onglet « Technologie automobile ») → tri (langue,
// pertinence) → texte source réel → rédaction (Claude) → garde-fous → fichier.
//
// Usage : node scripts/actus-autopilote.mjs [--n=2] [--dry-run]
//
// Variables d'environnement (secrets GitHub) :
//   SHEETS_SERVICE_ACCOUNT_JSON  compte de service Google (éditeur du sheet)
//   VEILLE_SHEET_ID              identifiant du sheet (défaut ci-dessous)
//   CLAUDE_CODE_OAUTH_TOKEN      tri et rédaction (CLI Claude Code, abonnement)
//   UNSPLASH_ACCESS_KEY, PEXELS_API_KEY, PIXABAY_API_KEY   images libres (facultatives)

import { createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = join(ROOT, "content", "posts");

const SHEET_ID = process.env.VEILLE_SHEET_ID || "1EBgO2wj8Tw2e9ZGkjRc3stOIEKhkjwVlwl0p6ckUf8g";
const ONGLET = "Technologie automobile";
const MODELE_TRI = "claude-haiku-5-5";
const MODELE_REDACTION = "claude-sonnet-5-5";
const MAX_MOTS = 400;
const AUTEUR = "thomas-lefevre"; // persona des actus générales (lib/authors.ts)
const RUBRIQUE = "actualites"; // slug de lib/categories.ts
const IMAGE_PAR_DEFAUT = "/images/articles/default-actualites.svg"; // si la source n'a pas d'image

const args = process.argv.slice(2);
const N = Number((args.find((a) => a.startsWith("--n=")) || "--n=2").split("=")[1]);
const DRY = args.includes("--dry-run");

const log = (...m) => console.log(new Date().toISOString(), ...m);

// ---------- Google Sheets (compte de service, JWT signé sans dépendance) ----------

async function jetonSheets() {
  const compte = JSON.parse(process.env.SHEETS_SERVICE_ACCOUNT_JSON || "null");
  if (!compte) throw new Error("SHEETS_SERVICE_ACCOUNT_JSON absent");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const entete = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const charge = b64(
    JSON.stringify({
      iss: compte.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = createSign("RSA-SHA256").update(`${entete}.${charge}`).sign(compte.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${entete}.${charge}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`jeton Sheets refusé (${res.status})`);
  return (await res.json()).access_token;
}

async function lireActus(jeton) {
  const plage = encodeURIComponent(`'${ONGLET}'!A2:F1000`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${plage}`, {
    headers: { Authorization: `Bearer ${jeton}` },
  });
  if (!res.ok) throw new Error(`lecture du sheet impossible (${res.status})`);
  const lignes = (await res.json()).values || [];
  return lignes.map((r, i) => ({
    ligne: i + 2,
    titre: r[1] || "",
    resume: r[2] || "",
    url: r[3] || "",
    statut: r[5] || "",
  }));
}

async function marquerStatut(jeton, ligne, texte) {
  if (DRY) return;
  const plage = encodeURIComponent(`'${ONGLET}'!F${ligne}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${plage}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[texte]] }),
    }
  );
  if (!res.ok) log(`  ⚠ statut non écrit ligne ${ligne} (${res.status})`);
}

// ---------- Claude (API Messages) ----------

async function claude(model, system, user) {
  // Même méthode que techno-play : CLI Claude Code en mode headless, authentifiée
  // par CLAUDE_CODE_OAUTH_TOKEN (abonnement). Pas d'appel direct à l'API payante.
  const args = ["-p", "--restricted", "--output-format", "json", "--model", model];
  if (system) args.push("--system-prompt", system);
  const res = spawnSync("claude", args, { input: user, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (res.error) throw new Error(`Échec du lancement de la CLI claude : ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude -p a échoué (code ${res.status}) : ${res.stderr}`);
  let data;
  try { data = JSON.parse(res.stdout); } catch { throw new Error("sortie de claude -p non JSON"); }
  if (data.is_error) throw new Error(`claude -p : ${data.result || "erreur inconnue"}`);
  return String(data.result || "");
}

function extraireJson(texte) {
  const m = texte.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("réponse sans JSON");
  return JSON.parse(m[0]);
}

// ---------- Tri : langue + pertinence ----------

function sembleNonFrancais(texte) {
  if (/[Ѐ-ӿ぀-ヿ一-鿿가-힯]/.test(texte)) return true;
  return [
    /\bl·l\b|l·|·l/i,
    /\b(és|això|amb|però|molt|també|què)\b/i,
    /\b(está|esto|pero|muy|también|qué|cómo|años)\b/i,
    /\b(questo|però|anche|perché|molto)\b/i,
  ].some((r) => r.test(texte));
}

async function retenir(actu) {
  const texte = await claude(
    MODELE_TRI,
    'Réponds UNIQUEMENT par un JSON {"retenir": true|false, "raison": "..."}.',
    `Tu filtres des actus automobiles pour un média grand public francophone (techcars.fr).
Critères pour retenir : article en français, source sérieuse (presse ou site spécialisé reconnu), sujet concret et compréhensible, fait confirmé (pas une rumeur, pas une spéculation, pas un résumé IA sans substance).
Titre : ${actu.titre}
Résumé : ${actu.resume.slice(0, 500)}
Source : ${actu.url}`,
    200
  );
  return extraireJson(texte);
}

// ---------- Texte source réel (anti-hallucination) ----------

const ENTITES = { "&eacute;": "é", "&egrave;": "è", "&agrave;": "à", "&ecirc;": "ê", "&rsquo;": "’", "&#039;": "'", "&amp;": "&", "&nbsp;": " ", "&hellip;": "…", "&quot;": '"', "&laquo;": "«", "&raquo;": "»" };
const decoder = (s) => s.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITES[m] ?? m);

async function texteSource(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; techcars-actus/1.0)" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => decoder(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 80 && p.length <= 800);
  const texte = paras.join("\n\n").slice(0, 6000);
  if (texte.length < 200) throw new Error("texte source trop court (paywall ou page dynamique)");
  return texte;
}

// ---------- Images libres de droit (même méthode que techno-play) ----------
// Unsplash, puis Pexels, puis Pixabay : on prend le premier résultat non encore utilisé.
// L'URL distante est enregistrée dans le frontmatter ; rien n'est téléchargé.

async function chercherUnsplash(requete) {
  const cle = process.env.UNSPLASH_ACCESS_KEY;
  if (!cle) return [];
  const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(requete)}&per_page=10&orientation=landscape`, {
    headers: { Authorization: `Client-ID ${cle}` },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.results || []).map((r) => ({ url: r.urls.regular, alt: r.alt_description || "" }));
}

async function chercherPexels(requete) {
  const cle = process.env.PEXELS_API_KEY;
  if (!cle) return [];
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(requete)}&per_page=10&orientation=landscape`, {
    headers: { Authorization: cle },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.photos || []).map((p) => ({ url: p.src.large, alt: p.alt || "" }));
}

async function chercherPixabay(requete) {
  const cle = process.env.PIXABAY_API_KEY;
  if (!cle) return [];
  const res = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(cle)}&q=${encodeURIComponent(requete)}&image_type=photo&orientation=horizontal&per_page=10&safesearch=true`);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.hits || []).map((h) => ({ url: h.largeImageURL, alt: h.tags || "" }));
}

async function trouverImage(requete, dejaUtilisees) {
  const texte = (requete || "").trim();
  if (!texte) return null;
  let premier = null;
  for (const chercher of [chercherUnsplash, chercherPexels, chercherPixabay]) {
    try {
      const resultats = await chercher(texte);
      if (resultats.length && !premier) premier = resultats[0];
      const libre = resultats.find((r) => !dejaUtilisees.has(r.url));
      if (libre) return libre;
    } catch (e) {
      log(`  recherche image échouée : ${e.message}`);
    }
  }
  return premier;
}

// Images déjà présentes dans les articles, pour ne pas reprendre la même photo.
function imagesDejaUtilisees() {
  const urls = new Set();
  for (const f of readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md"))) {
    const m = readFileSync(join(POSTS_DIR, f), "utf8").match(/^image:\s*"([^"]+)"/m);
    if (m) urls.add(m[1]);
  }
  return urls;
}

// ---------- Rédaction + garde-fous ----------

const PROMPT_REDACTION = `Tu rédiges une brève d'actualité automobile/mobilité pour techcars.fr, à partir du texte RÉEL fourni.
Réponds UNIQUEMENT par un JSON : {"title": "...", "description": "...", "body": "...", "requete_image": "..."}
- requete_image : 2 à 4 mots-clés pour chercher une photo libre illustrant le sujet (ex. « borne recharge voiture électrique »), sans nom de marque ni de personne.
- body : paragraphes en Markdown séparés par une ligne vide. 250 à 350 mots. Pas de liste, pas de tableau, pas d'image, pas de lien, pas de titre.
- Factuel, phrases courtes. INTERDIT d'inventer un fait, un chiffre, un nom ou une citation absent du texte source.
- Cite le média source dans le texte (ex. « selon Caradisiac »).
- Jamais de tiret cadratin (—).
- title ≤ 60 caractères ; description entre 120 et 155 caractères.`;

function motsDans(texte) {
  return texte.trim().split(/\s+/).filter(Boolean).length;
}

function chiffresInventes(texte, source) {
  const nombres = [...texte.matchAll(/\d[\d\s.,]{2,}\d|\d{3,}/g)].map((m) => m[0].replace(/\s/g, ""));
  const sourceSansEspaces = source.replace(/\s/g, "");
  return [...new Set(nombres)].filter((n) => !sourceSansEspaces.includes(n));
}

function controler(contenu, source) {
  const echecs = [];
  if (motsDans(contenu.body) > MAX_MOTS) echecs.push(`trop long (${motsDans(contenu.body)} mots)`);
  if (/—/.test(contenu.body + contenu.title)) echecs.push("tiret cadratin");
  if (/\]\(|https?:\/\//.test(contenu.body)) echecs.push("lien dans le corps");
  if (!contenu.title || contenu.title.length > 65) echecs.push("titre hors bornes");
  if (!contenu.description || contenu.description.length < 100 || contenu.description.length > 165) echecs.push("description hors bornes");
  const inventes = chiffresInventes(contenu.body, source);
  if (inventes.length) echecs.push(`chiffre(s) absent(s) de la source : ${inventes.join(", ")}`);
  return echecs;
}

// ---------- Écriture de l'article (Markdown, comme content/posts/*.md) ----------

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 90);
}

async function ecrireArticle(contenu, source) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(contenu.title);
  const chemin = join(POSTS_DIR, `${slug}.md`);
  if (existsSync(chemin)) return { slug, chemin, existait: true };
  const trouvee = await trouverImage(contenu.requete_image, imagesDejaUtilisees());
  const image = trouvee ? trouvee.url : IMAGE_PAR_DEFAUT;
  const fm = [
    "---",
    `title: ${JSON.stringify(contenu.title)}`,
    `description: ${JSON.stringify(contenu.description)}`,
    `date: "${date}"`,
    `author: "${AUTEUR}"`,
    `category: "${RUBRIQUE}"`,
    `wp_locale: "fr"`,
    `source: ${JSON.stringify(source.url)}`,
    `image: "${image}"`,
    `imageAlt: ${JSON.stringify(contenu.title)}`,
    "---",
    "",
    contenu.body.trim(),
    "",
  ].join("\n");
  if (!DRY) writeFileSync(chemin, fm, "utf8");
  return { slug, chemin, existait: false };
}

// ---------- Orchestration ----------

async function main() {
  log(`Autopilote actus techcars (statique) — n=${N}${DRY ? " (dry-run)" : ""}`);
  const jeton = await jetonSheets();
  const actus = await lireActus(jeton);
  const candidates = actus.filter((a) => a.titre && !a.statut && a.url.startsWith("http") && !/news\.google\.com/.test(a.url));
  log(`${candidates.length} actu(s) non traitée(s) dans l'onglet « ${ONGLET} »`);

  let ecrits = 0;
  for (const actu of candidates) {
    if (ecrits >= N) break;
    log(`\n— ${actu.titre}`);
    if (sembleNonFrancais(`${actu.titre} ${actu.resume}`)) {
      await marquerStatut(jeton, actu.ligne, "Écarté (langue)");
      continue;
    }
    const tri = await retenir(actu).catch((e) => ({ retenir: false, raison: `erreur tri : ${e.message}` }));
    if (!tri.retenir) {
      await marquerStatut(jeton, actu.ligne, `Écarté (${String(tri.raison).slice(0, 150)})`);
      continue;
    }
    let source;
    try {
      source = { url: actu.url, texte: await texteSource(actu.url) };
    } catch (e) {
      log(`  source non exploitable : ${e.message}`);
      await marquerStatut(jeton, actu.ligne, `Écarté (source : ${e.message.slice(0, 120)})`);
      continue;
    }
    let contenu;
    try {
      const texte = await claude(MODELE_REDACTION, PROMPT_REDACTION, `Titre source : "${actu.titre}"\nTexte réel (seule base autorisée) :\n"""\n${source.texte}\n"""`, 3000);
      contenu = extraireJson(texte);
    } catch (e) {
      log(`  rédaction échouée : ${e.message}`);
      continue;
    }
    const echecs = controler(contenu, source.texte);
    if (echecs.length) {
      log(`  garde-fou : ${echecs.join(" ; ")} — non écrit`);
      await marquerStatut(jeton, actu.ligne, `Écarté (garde-fou : ${echecs.join(", ").slice(0, 150)})`);
      continue;
    }
    const article = await ecrireArticle(contenu, source);
    if (article.existait) {
      log(`  déjà présent : ${article.slug}`);
      continue;
    }
    log(`  ${DRY ? "[dry-run] " : ""}écrit : content/posts/${article.slug}.md`);
    await marquerStatut(jeton, actu.ligne, `Publié ${new Date().toISOString().slice(0, 10)} /${article.slug}/`);
    ecrits++;
  }
  log(`\nTerminé : ${ecrits} article(s) ${DRY ? "prêt(s)" : "écrit(s)"}.`);
}

main().catch((e) => {
  console.error("ÉCHEC :", e.message);
  process.exit(1);
});
