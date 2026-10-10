import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...source.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
  ];
}
