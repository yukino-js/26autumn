import { defineConfig } from "fumadocs-mdx/config";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins/rehype-code";

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      parseMetaString(meta, node, tree) {
        const data =
          rehypeCodeDefaultOptions.parseMetaString?.(meta, node, tree) ?? {};
        data["data-line-numbers"] = true;
        return data;
      },
    },
  },
});
