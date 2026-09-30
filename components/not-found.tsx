"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { staticClient } from "fumadocs-core/search/client/orama-static";

interface Suggestion {
  title: string;
  url: string;
}

export function NotFoundSuggestions() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    let cancelled = false;

    const pathname = window.location.pathname.replace(/^\/26autumn/, "");
    const query = pathname.split("/").filter(Boolean).pop() ?? "";
    if (query.length === 0) return;

    const client = staticClient({ from: "/26autumn/api/search" });
    void Promise.resolve(client.search(query)).then((results) => {
      if (cancelled) return;

      const seen = new Set<string>();
      const next: Suggestion[] = [];
      for (const result of results) {
        if (result.type !== "page" || seen.has(result.url)) continue;
        seen.add(result.url);
        next.push({ title: result.content, url: result.url });
        if (next.length >= 5) break;
      }

      setSuggestions(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (suggestions.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-md px-8">
      <p className="mb-2 text-center text-sm text-fd-muted-foreground">
        你可能想找:
      </p>
      <div className="flex flex-col gap-1">
        {suggestions.map((item) => (
          <Link
            key={item.url}
            href={item.url}
            className="rounded-lg border p-3 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <p className="font-medium">{item.title}</p>
            <p className="text-xs text-fd-muted-foreground">{item.url}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
