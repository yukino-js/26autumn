import type { Metadata, Viewport } from "next";
import { TreeContextProvider } from "@fumadocs/base-ui/contexts/tree";
import { NextProvider } from "fumadocs-core/framework/next";
import { Provider } from "@/components/provider";
import { siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "技术学习笔记",
    template: "%s | 技术学习笔记",
  },
  description: "技术知识整理、实习与工作期间的技术笔记、项目源码解析",
  icons: {
    // icon URLs bypass metadataBase resolution, prefix /26autumn manually
    icon: "/26autumn/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
    { media: "(prefers-color-scheme: light)", color: "#f5f5f5" },
  ],
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="relative flex min-h-screen flex-col">
        <NextProvider>
          <TreeContextProvider tree={source.getPageTree()}>
            <Provider>{children}</Provider>
          </TreeContextProvider>
        </NextProvider>
      </body>
    </html>
  );
}
