import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { docsRoute } from "./shared";

const docs = defineDocs({
  // the whole content directory: fe/, be/ and docs/ sections are served from
  // the site root, keeping the rspress URLs (/fe/react, /be/go, /docs/...)
  dir: "content",
  docs: {
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      // exposes the processed Markdown via `page.data.getText("processed")`,
      // required by the llms.txt routes
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`,
});
