import { AppWindow, NotebookPen, Server } from "lucide-react";
import Link from "next/link";
import { cva } from "class-variance-authority";
import { Hero } from "@/app/(home)/page.client";
import { cn } from "@/lib/cn";
import { gitConfig } from "@/lib/shared";
import { source } from "@/lib/source";

const buttonVariants = cva(
  "inline-flex justify-center px-5 py-3 rounded-full font-medium tracking-tight transition-colors",
  {
    variants: {
      variant: {
        primary: "bg-brand text-brand-foreground hover:bg-brand-200",
        secondary:
          "border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent",
      },
    },
    defaultVariants: {
      variant: "primary",
    },
  },
);

const cardVariants = cva("rounded-2xl text-sm p-6 bg-origin-border shadow-lg", {
  variants: {
    variant: {
      default: "border bg-fd-card",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const sectionCards = [
  {
    key: "fe",
    title: "前端",
    description: "React、Next.js、CSS、Vite、TanStack 以及 Yukino 前端系列",
    icon: AppWindow,
  },
  {
    key: "be",
    title: "后端",
    description: "Go、MySQL、Redis、ClickHouse、Kafka 以及 Yukino 后端系列",
    icon: Server,
  },
  {
    key: "docs",
    title: "工作笔记",
    description: "实习与工作期间的技术记录、项目复盘与源码解析",
    icon: NotebookPen,
  },
] as const;

export default function HomePage() {
  const pages = source.getPages();

  return (
    <div className="text-landing-foreground pt-4 pb-6 md:pb-12">
      <div className="relative flex min-h-130 h-[70vh] max-h-190 border rounded-2xl overflow-hidden mx-auto w-full max-w-300 bg-origin-border">
        <Hero />
        <div className="flex flex-col items-center justify-center z-2 px-4 size-full text-center md:p-12">
          <p className="text-xs text-brand font-medium rounded-full p-2 border border-brand/50 w-fit">
            26autumn
          </p>
          <h1 className="text-4xl my-8 leading-tighter font-medium xl:text-5xl">
            写给工程师的<span className="text-brand">技术学习笔记</span>
          </h1>
          <div className="flex flex-row items-center justify-center gap-4 flex-wrap w-fit">
            <Link href="/fe" className={cn(buttonVariants(), "max-sm:text-sm")}>
              开始阅读
            </Link>
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                buttonVariants({ variant: "secondary" }),
                "max-sm:text-sm",
              )}
            >
              Open GitHub
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 mt-12 px-6 mx-auto w-full max-w-300 md:px-12 md:grid-cols-3 lg:mt-20">
        {sectionCards.map((section) => {
          const Icon = section.icon;
          const count = pages.filter(
            (page) => page.slugs[0] === section.key,
          ).length;

          return (
            <Link
              key={section.key}
              href={`/${section.key}`}
              className={cn(cardVariants(), "flex flex-col text-start")}
            >
              <Icon className="mb-4 size-9 rounded-lg border bg-fd-background p-1.5 text-brand" />
              <h2 className="mb-2 text-xl font-medium tracking-tight lg:text-2xl">
                {section.title}
              </h2>
              <p className="text-fd-muted-foreground mb-4">
                {section.description}
              </p>
              <p className="mt-auto font-mono text-xs text-fd-muted-foreground">
                {count} 篇
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
