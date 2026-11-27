// Article de fond (H1, H2, H3, méthode) : un jour sur deux, en plus des actus.
// Sujet : mot-clé en longue traîne (DataForSEO, France), question d'abord, faible
// concurrence ensuite. Rédaction : Claude Sonnet via la CLI Claude Code (abonnement).
// Garde-fou strict : aucun chiffre, aucune date, aucun lien, pas de fait non sourcé.
// Usage : node scripts/fond-autopilote.mjs [--dry-run] [--force]
// (--force, ou FOND_FORCE=true, ignore la parité des jours.)
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as unicite from "./images/unicite.mjs";
import { rechercherImage } from "./images/recherche.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = join(ROOT, "content", "posts");
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force") || process.env.FOND_FORCE === "true";
const MODELE = "claude-sonnet-5-5";
const AUTEUR = "thomas-lefevre";
const MOTS_MIN = 900;
const MOTS_MAX = 1500;
const SEEDS = ["voiture électrique", "camping-car", "utilitaire", "assurance auto", "entretien voiture", "leasing voiture", "hybride rechargeable", "permis de conduire"];

const log = (m) => console.log(m);

// Un jour sur deux : parité du jour UTC (stable pour toute la journée).
const jourPair = Math.floor(Date.now() / 86400000) % 2 === 0;
if (!FORCE && !jourPair) {
  log("Jour impair : pas d'article de fond aujourd'hui.");
  process.exit(0);
}

const CATEGORIES = [...readFileSync(join(ROOT, "lib", "categories.ts"), "utf8").matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);

function normaliser(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s) {
  return normaliser(s).replace(/ /g, "-").slice(0, 90);
}

// ---------- Sujet : DataForSEO ----------
async function suggestionsDataForSEO(seed) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD absents");
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify([{ keywords: [seed], location_code: 2250, language_code: "fr", limit: 200 }]),
  });
  const json = await res.json();
  if (json.status_code !== 20000) throw new Error(`DataForSEO ${json.status_code} : ${json.status_message}`);
  return (json.tasks?.[0]?.result || []).filter(Boolean);
}

const QUESTION = /^(comment|pourquoi|quel|quelle|quels|quelles|combien|est ce|est il|peut|faut|que|qu est|quoi|ou|quand|vaut|dois|doit)\b/;

function niveauConcurrence(c) {
  if (c == null) return 2;
  if (typeof c === "number") return c < 0.33 ? 0 : c < 0.66 ? 1 : 2;
  return { LOW: 0, MEDIUM: 1, HIGH: 2 }[String(c).toUpperCase()] ?? 2;
}

function dejaCouvert(keyword, existants) {
  const k = normaliser(keyword);
  return existants.some((e) => e.includes(k));
}

function choisirSujet(items, existants) {
  return items
    .filter((r) => r.keyword && r.search_volume >= 30 && r.search_volume <= 3000 && normaliser(r.keyword).split(" ").length >= 3)
    .filter((r) => !dejaCouvert(r.keyword, existants))
    .sort(
      (a, b) =>
        (QUESTION.test(normaliser(b.keyword)) ? 1 : 0) - (QUESTION.test(normaliser(a.keyword)) ? 1 : 0) ||
        niveauConcurrence(a.competition) - niveauConcurrence(b.competition) ||
        b.search_volume - a.search_volume
    )[0];
}

function titresExistants() {
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => normaliser(f.replace(/\.md$/, "")));
}

// ---------- Rédaction ----------
function claude(system, user) {
  const args2 = ["-p", "--restricted", "--output-format", "json", "--model", MODELE, "--system-prompt", system];
  const res = spawnSync("claude", args2, { input: user, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (res.error) throw new Error(`CLI claude : ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude -p a échoué (code ${res.status}) : ${res.stderr}`);
  const data = JSON.parse(res.stdout);
  if (data.is_error) throw new Error(`claude -p : ${data.result || "erreur"}`);
  return String(data.result || "");
}

const PROMPT_FOND = `Tu rédiges un article de fond pour techcars.fr (automobile, utilitaire, camping-car, mobilité individuelle), à partir du mot-clé en longue traîne donné.
Réponds UNIQUEMENT par un JSON : {"title": "...", "description": "...", "categorie": "...", "body": "..."}
- title : 50 à 60 caractères, reprend la question précise du lecteur.
- description : entre 120 et 155 caractères.
- categorie : exactement un de ces slugs : ${CATEGORIES.join(", ")}.
- body : Markdown. Une introduction de 2 à 3 phrases qui répond directement à la question, avec les termes importants en **gras**. Puis 3 à 5 sections avec "## " (titres précis, de préférence en question), avec des sous-sections "### " quand c'est utile. Une section "## Notre méthode" explique comment l'article a été rédigé : règles, critères et démarches vérifiables, sans prétendre avoir testé un véhicule ni réalisé de mesure. Termine par "## Questions fréquentes" avec 3 questions en "### " et des réponses courtes.
- 900 à 1 500 mots. Au moins 5 passages en **gras**.
- INTERDIT dans le corps : tout chiffre, toute date, tout prix, toute statistique, tout numéro de loi ou d'article. Décris les critères sans chiffre.
- INTERDIT : lien, image, tiret cadratin (—), mention « À VÉRIFIER », affirmation d'essai ou de mesure personnelle.`;

function controler(c) {
  const echecs = [];
  const mots = c.body.trim().split(/\s+/).length;
  if (mots < MOTS_MIN || mots > MOTS_MAX) echecs.push(`${mots} mots (attendu ${MOTS_MIN} à ${MOTS_MAX})`);
  const gras = (c.body.match(/\*\*[^*\n]+\*\*/g) || []).length;
  if (gras < 5) echecs.push(`${gras} passage(s) en gras (min 5)`);
  if (/—/.test(c.body + c.title + c.description)) echecs.push("tiret cadratin");
  if (/\]\(|https?:\/\//.test(c.body)) echecs.push("lien dans le corps");
  if (/\d/.test(c.body)) echecs.push("chiffre dans le corps");
  if (/À VÉRIFIER/i.test(c.body)) echecs.push("marqueur à vérifier");
  const h2 = (c.body.match(/^## /gm) || []).length;
  if (h2 < 3) echecs.push(`${h2} H2 (min 3)`);
  if (!/^### /m.test(c.body)) echecs.push("aucun H3");
  if (!c.title || c.title.length > 65) echecs.push("titre hors bornes");
  if (!c.description || c.description.length < 100 || c.description.length > 165) echecs.push("description hors bornes");
  if (!CATEGORIES.includes(c.categorie)) echecs.push(`catégorie inconnue : ${c.categorie}`);
  return echecs;
}

function extraireJson(texte) {
  const m = texte.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("réponse sans JSON");
  return JSON.parse(m[0]);
}

async function main() {
  const existants = titresExistants();
  const decalage = Math.floor(Date.now() / 86400000);
  let sujet = null;
  for (let i = 0; i < SEEDS.length && !sujet; i++) {
    const seed = SEEDS[(decalage + i) % SEEDS.length];
    try {
      sujet = choisirSujet(await suggestionsDataForSEO(seed), existants);
    } catch (e) {
      log(`  sujets « ${seed} » indisponibles : ${e.message}`);
    }
  }
  if (!sujet) {
    log("Aucun sujet de fond éligible aujourd'hui.");
    return;
  }
  log(`Sujet : « ${sujet.keyword} » (volume ${sujet.search_volume}, concurrence ${sujet.competition})`);

  let contenu;
  let echecs;
  try {
    contenu = extraireJson(claude(PROMPT_FOND, `Mot-clé en longue traîne : « ${sujet.keyword} »`));
    echecs = controler(contenu);
    if (echecs.length) {
      // Une seule passe de correction : on renvoie la version et les problèmes exacts.
      log(`  première version refusée (${echecs.join(" ; ")}) : correction.`);
      contenu = extraireJson(
        claude(
          PROMPT_FOND,
          `Mot-clé en longue traîne : « ${sujet.keyword} »\nVersion à corriger :\n${JSON.stringify(contenu)}\nProblèmes à corriger : ${echecs.join(" ; ")}.\nRemplace chaque passage concerné par une formulation générale, sans chiffre, sans date, sans marqueur. Ne change rien d'autre. Réponds par le même JSON.`
        )
      );
      echecs = controler(contenu);
    }
  } catch (e) {
    log(`Rédaction échouée : ${e.message}`);
    return;
  }
  if (echecs.length) {
    log(`Garde-fou : ${echecs.join(" ; ")} — article non écrit.`);
    return;
  }

  const slug = slugify(contenu.title);
  const chemin = join(POSTS_DIR, `${slug}.md`);
  if (existsSync(chemin)) {
    log(`Déjà présent : ${slug}`);
    return;
  }
  const trouvee = await unicite.choisirImageUnique(
    unicite.requetesImage({ keyword: sujet.keyword, titre: contenu.title }),
    rechercherImage,
    unicite.idsUtilisees(POSTS_DIR)
  );
  const image = trouvee ? trouvee.url : "/images/articles/default-actualites.svg";
  const date = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(contenu.title)}`,
    `description: ${JSON.stringify(contenu.description)}`,
    `date: "${date}"`,
    `author: "${AUTEUR}"`,
    `category: "${contenu.categorie}"`,
    `wp_locale: "fr"`,
    `image: "${image}"`,
    `imageAlt: ${JSON.stringify(contenu.title)}`,
    "---",
    "",
    contenu.body.trim(),
    "",
  ].join("\n");
  if (!DRY) writeFileSync(chemin, frontmatter, "utf8");
  log(`${DRY ? "[dry-run] " : ""}écrit : content/posts/${slug}.md (image ${trouvee ? "trouvée" : "par défaut"})`);
}

main().catch((e) => {
  console.error("ÉCHEC :", e.message);
  process.exit(1);
});
