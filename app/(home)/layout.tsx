import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import { baseOptions, linkItems } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <HomeLayout {...baseOptions()} links={linkItems}>
      {children}
    </HomeLayout>
  );
}
