import { generateSitemaps } from "@/app/sitemap";
import { SITE_URL } from "@/lib/site";

// Index des sitemaps (/sitemap.xml) : Next génère /sitemap/<id>.xml avec
// generateSitemaps() mais ne crée pas l'index lui-même. Cette route liste les
// segments ; c'est l'URL déclarée dans robots.txt et dans la Search Console.
export const revalidate = 3600;

export async function GET() {
  const segments = await generateSitemaps();
  const entrees = segments
    .map((s) => `  <sitemap><loc>${SITE_URL}/sitemap/${s.id}.xml</loc></sitemap>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entrees}\n</sitemapindex>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
