import { createGetUrl } from "fumadocs-core/source";

export const appName = "技术学习笔记";
// canonical site URL, used by metadataBase and the sitemap
export const siteUrl = "https://yukino-js.github.io/26autumn";
// docs are served from the site root, keeping the rspress URLs
// (e.g. /be/go) unchanged
export const docsRoute = "/";
// Markdown URLs are consumed client-side (fetch / plain anchors) where
// Next's basePath is not applied automatically, so carry /26autumn explicitly.
export const docsContentRoute = "/26autumn/llms.mdx";

export const gitConfig = {
  user: "yukino-js",
  repo: "26autumn",
  branch: "main",
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];

  return { segments, url: getContentUrl(segments, page.locale) };
}
