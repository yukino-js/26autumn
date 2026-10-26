import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";
import mermaid from "rspress-plugin-mermaid";

const siteOrigin = "https://yukino-js.github.io";

export default defineConfig({
  root: "content",
  base: "/26autumn/",
  siteOrigin,
  lang: "zh",
  title: "技术学习笔记",
  description: "技术知识整理、实习与工作期间的技术笔记、项目源码解析",
  icon: "/favicon.svg",
  logo: "/favicon.svg",
  logoText: "技术学习笔记",
  globalStyles: path.join(import.meta.dirname, "styles.css"),
  markdown: {
    showLineNumbers: true,
  },
  llms: true,
  themeConfig: {
    nav: [
      { text: "前端", link: "/fe/", activeMatch: "/fe/" },
      { text: "后端", link: "/be/", activeMatch: "/be/" },
      { text: "工作文档", link: "/docs/", activeMatch: "/docs/" },
    ],
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
  plugins: [mermaid(), pluginSitemap({ siteUrl: `${siteOrigin}/26autumn` })],
});
