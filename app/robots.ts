import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/shared";

// static export: emitted to out/robots.txt
export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
