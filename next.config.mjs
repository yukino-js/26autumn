import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // GitHub Pages static hosting under /26autumn/
  output: "export",
  basePath: "/26autumn",
  images: {
    unoptimized: true,
  },
};

export default createMDX()(config);
