import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import { Accordion, Accordions } from "@fumadocs/base-ui/components/accordion";
import { Tab, Tabs } from "@fumadocs/base-ui/components/tabs";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Tabs,
    Tab,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
