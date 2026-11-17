import path from "node:path";
import { defineConfig } from "@rspress/core";
import mermaid from "rspress-plugin-mermaid";

const siteOrigin = "https://yukino-js.github.io";
const siteBase = "/26autumn/";

export default defineConfig({
  root: "content",
  base: siteBase,
  siteOrigin,
  lang: "zh",
  title: "技术学习笔记",
  description:
    "技术知识整理、实习与工作期间的技术笔记、开源项目源码解析与求职面试备考资料",
  icon: "/favicon.svg",
  logo: "/favicon.svg",
  logoText: "技术学习笔记",
  globalStyles: path.join(import.meta.dirname, "styles.css"),
  markdown: {
    showLineNumbers: true,
  },
  llms: true,
  sitemap: {
    siteUrl: `${siteOrigin}${siteBase}`,
  },
  themeConfig: {
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/yukino-js/26autumn",
      },
    ],
    lastUpdated: true,
    editLink: {
      docRepoBaseUrl: "https://github.com/yukino-js/26autumn/tree/main/content",
    },
    llmsUI: true,
  },
  plugins: [
    // Mermaid 12 换了默认布局与视觉；显式锁回 dagre + classic，保证既有图表渲染不变。
    mermaid({
      mermaidConfig: {
        layout: "dagre",
        look: "classic",
      },
    }),
  ],
});
