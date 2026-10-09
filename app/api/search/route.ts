import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// static export: the whole index is exported as a JSON file at build time
// (out/api/search) and searched in the browser
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
