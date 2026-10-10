import { createGetUrl } from "fumadocs-core/source";

export const appName = "技术学习笔记";
export const siteUrl = "https://yukino-js.github.io/26autumn";
export const docsRoute = "/";
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
