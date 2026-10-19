import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  PageLastUpdate,
  ViewOptionsPopover,
} from "@fumadocs/base-ui/layouts/docs/page";
import { Card, Cards } from "@fumadocs/base-ui/components/card";
import { createRelativeLink } from "@fumadocs/base-ui/mdx";
import type * as PageTree from "fumadocs-core/page-tree";
import { getMDXComponents } from "@/components/mdx";
import { getPageMarkdownUrl, gitConfig } from "@/lib/shared";
import { source } from "@/lib/source";

export default async function Page(props: PageProps<"/[...slug]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">
        {page.data.description}
      </DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
        {page.slugs.length === 1 ? <SectionCards url={page.url} /> : null}
      </DocsBody>
      {page.data.lastModified ? (
        <PageLastUpdate date={page.data.lastModified} />
      ) : null}
    </DocsPage>
  );
}

function findSectionFolder(
  node: PageTree.Root | PageTree.Folder,
  url: string,
): PageTree.Folder | undefined {
  for (const child of node.children) {
    if (child.type !== "folder") continue;
    if (child.index?.url === url) return child;

    const found = findSectionFolder(child, url);
    if (found) return found;
  }

  return undefined;
}

function firstPageUrl(folder: PageTree.Folder): string | undefined {
  for (const child of folder.children) {
    if (child.type === "page") return child.url;
    if (child.type === "folder") {
      const url = child.index?.url ?? firstPageUrl(child);
      if (url) return url;
    }
  }

  return undefined;
}

function SectionCards({ url }: { url: string }) {
  const folder = findSectionFolder(source.getPageTree(), url);
  if (!folder) return null;

  return (
    <Cards>
      {folder.children.map((item) => {
        if (item.type === "separator") return null;
        if (item.type === "page" && item.url === url) return null;

        if (item.type === "folder") {
          const href = item.index?.url ?? firstPageUrl(item);
          if (!href) return null;

          return (
            <Card key={href} title={item.name} href={href}>
              {item.description}
            </Card>
          );
        }

        return (
          <Card key={item.url} title={item.name} href={item.url}>
            {item.description}
          </Card>
        );
      })}
    </Cards>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<"/[...slug]">,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
