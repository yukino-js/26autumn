import { HomeLayout } from "@fumadocs/base-ui/layouts/home";
import { DefaultNotFound } from "@fumadocs/base-ui/layouts/home/not-found";
import { NotFoundSuggestions } from "@/components/not-found";
import { baseOptions, linkItems } from "@/lib/layout.shared";

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()} links={linkItems}>
      <main className="flex flex-1 flex-col justify-center py-12">
        <DefaultNotFound />
        <NotFoundSuggestions />
      </main>
    </HomeLayout>
  );
}
