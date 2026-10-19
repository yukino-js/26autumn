import { DocsLayout } from "@fumadocs/base-ui/layouts/docs";
import { baseOptions, linkItems } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <DocsLayout
      {...baseOptions()}
      tree={source.getPageTree()}
      links={linkItems.filter((item) => item.type === "icon")}
    >
      {children}
    </DocsLayout>
  );
}
