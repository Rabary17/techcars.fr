import type { MetadataRoute } from "next";
import { getAllAuthors, getAllPagesFull, getAllPosts, getAllTags } from "@/lib/wp";
import { SILOS } from "@/lib/taxonomy";
import { SERVED_LOCALES, silosFor, articlesFor, pathForArticle, urlPrefix } from "@/lib/i18n";
import { SITE_URL } from "@/lib/site";

// ISR : le sitemap n'est plus figé au build (il n'y a plus de build unique
// avec output:"export") — régénéré au plus toutes les heures, ce qui suffit
// largement à un rythme de publication de quelques articles/jour. Voir
// skills/seo.md section 5 : sitemaps segmentés par silo, ≤ 2 000 URLs/sitemap.
// En dessous de ce volume (test + démarrage), un seul fichier suffit ; à
// segmenter par silo quand le nombre d'articles publiés le justifiera.
export const revalidate = 3600;

// WP renvoie `modified_gmt` en UTC mais sans indicateur de fuseau (ex.
// "2026-07-30T05:08:18") — passé tel quel, Google Search Console rejette la
// date ("Date non valide", format W3C Datetime non respecté). Suffixe
// "+00:00" explicite (plutôt que "Z"/toISOString) pour matcher exactement le
// format des sitemaps WordPress natifs (ex. npi-magazine.com, non headless).
function toLastModified(modifiedGmt: string): string {
  return `${modifiedGmt}+00:00`;
}

// Taille d'un sitemap segmenté. Le cache de données Next refuse les réponses
// de plus de 2 Mo (constaté au build : sitemap.xml à 2,9 Mo non mis en cache).
// 1 000 URL restent bien en dessous.
const URLS_PAR_SITEMAP = 1000;

async function construireUrls(): Promise<MetadataRoute.Sitemap> {
  // Dégradation gracieuse (inspiré de next-wp/lib/wordpress.ts, voir
  // app/[slug]/page.tsx) : un sitemap partiel (sans la ressource en échec)
  // plutôt qu'un déploiement bloqué si WP est temporairement injoignable — il
  // sera complété à la prochaine revalidation (max 1h, voir plus haut).
  const [posts, pages, authors, tags] = await Promise.all([
    getAllPosts().catch((e) => {
      console.warn(`[sitemap] échec du fetch getAllPosts, fallback sur []: ${e}`);
      return [];
    }),
    getAllPagesFull().catch((e) => {
      console.warn(`[sitemap] échec du fetch getAllPagesFull, fallback sur []: ${e}`);
      return [];
    }),
    getAllAuthors().catch((e) => {
      console.warn(`[sitemap] échec du fetch getAllAuthors, fallback sur []: ${e}`);
      return [];
    }),
    getAllTags().catch((e) => {
      console.warn(`[sitemap] échec du fetch getAllTags, fallback sur []: ${e}`);
      return [];
    }),
  ]);

  const staticUrls: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/rubriques/`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/outils/`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE_URL}/en/tools/`, changeFrequency: "weekly", priority: 0.7 },
  ];

  const categoryUrls: MetadataRoute.Sitemap = SILOS.map((s) => ({
    url: `${SITE_URL}/categorie/${s.slug}/`,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  // Les pages /tag/ sont en `noindex, follow` (decision du 2026-08-06 : pages
  // listing fines, proches-doublons, qui gonflaient l'index sans valeur
  // propre). Les declarer AU SITEMAP etait donc contradictoire — un sitemap dit
  // « indexe ceci », la page repond « ne m'indexe pas ».
  //
  // Le cout etait mesurable, constate sur l'export GSC du 2026-08-24 : 332 des
  // 697 URLs du sitemap etaient des pages tag noindex, soit 48 % du sitemap.
  // Google en avait deja explore 73 pour decouvrir qu'elles etaient noindex, et
  // 327 URLs restaient « Detectee, actuellement non indexee » faute de budget
  // d'exploration — avec seulement 20 a 60 requetes/jour et un temps de reponse
  // monte a 1,2-2,1 s, chaque requete gaspillee retarde d'autant la decouverte
  // d'un vrai article.
  //
  // Les liens internes vers /tag/ restent en place : `follow` suffit a ce que
  // Google les emprunte pour circuler dans le maillage. Le sitemap n'est pas le
  // bon outil pour ca.
  const tagUrls: MetadataRoute.Sitemap = [];
  void tags;

  const authorUrls: MetadataRoute.Sitemap = authors.map((a) => ({
    url: `${SITE_URL}/auteur/${a.slug}/`,
    changeFrequency: "monthly",
    priority: 0.5,
  }));

  // Toutes les pages WP statiques (pas seulement "à propos" en dur) — chaque
  // page publiée dans WP doit apparaître ici sans intervention manuelle.
  const pageUrls: MetadataRoute.Sitemap = pages.map((p) => ({
    url: `${SITE_URL}/${p.slug}/`,
    lastModified: toLastModified(p.modified_gmt),
    changeFrequency: "monthly",
    priority: 0.3,
  }));

  const postUrls: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${SITE_URL}/${p.slug}/`,
    lastModified: toLastModified(p.modified_gmt),
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  // URLs traduites. Construites depuis `data/i18n-index.json` et non depuis
  // WordPress : l'index ne contient que ce qui est reellement insere, et il
  // porte deja le silo de chaque article — donc aucun appel reseau ici.
  //
  // Les listes francaises ci-dessus n'incluent PAS ces URLs : `getPosts` les
  // exclut par `categories_exclude` et les pages par slug (voir lib/wp.ts).
  // Sans cela, chaque traduction apparaitrait deux fois dans le sitemap, une
  // fois a son URL /en/ et une fois a une URL francaise inexistante.
  const localeUrls: MetadataRoute.Sitemap = [];
  for (const locale of SERVED_LOCALES) {
    const prefixe = urlPrefix(locale);
    if (prefixe) {
      localeUrls.push({ url: `${SITE_URL}${prefixe}/`, changeFrequency: "weekly", priority: 0.8 });
    }
    for (const silo of silosFor(locale)) {
      localeUrls.push({
        url: `${SITE_URL}${prefixe}/${silo.slug}/`,
        changeFrequency: "weekly",
        priority: 0.7,
      });
      for (const sc of silo.sousCocons) {
        localeUrls.push({
          url: `${SITE_URL}${prefixe}/${silo.slug}/${sc.slug}/`,
          changeFrequency: "weekly",
          priority: 0.6,
        });
      }
    }
    for (const a of articlesFor(locale)) {
      const chemin = pathForArticle(a);
      if (chemin) {
        localeUrls.push({ url: `${SITE_URL}${chemin}`, changeFrequency: "monthly", priority: 0.6 });
      }
    }
  }

  return [
    ...staticUrls, ...categoryUrls, ...tagUrls, ...authorUrls,
    ...pageUrls, ...postUrls, ...localeUrls,
  ];
}

// Index + sous-sitemaps (/sitemap/0.xml, /sitemap/1.xml…). /sitemap.xml reste
// l'URL déclarée dans robots.txt et dans la Search Console : Next la sert
// désormais comme index qui pointe vers les segments.
export async function generateSitemaps() {
  const urls = await construireUrls();
  const nombre = Math.max(1, Math.ceil(urls.length / URLS_PAR_SITEMAP));
  return Array.from({ length: nombre }, (_, id) => ({ id }));
}

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const urls = await construireUrls();
  return urls.slice(id * URLS_PAR_SITEMAP, (id + 1) * URLS_PAR_SITEMAP);
}
