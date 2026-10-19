import { createMDX } from "fumadocs-mdx/next";

const config = {
  reactStrictMode: true,
  output: "export",
  basePath: "/26autumn",
  images: {
    unoptimized: true,
  },
};

export default createMDX()(config);
