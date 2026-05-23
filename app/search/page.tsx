"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getImageUrl } from "@/lib/api";
import type { ContentItem } from "@/types";

const LANGUAGES = ["All Languages", "Tamil", "Telugu", "Malayalam", "Kannada", "Hindi"];

const SECTION_MAP: { types: string[]; label: string; layout: "portrait" | "landscape" }[] = [
  { types: ["movie"],                               label: "MOVIES",       layout: "portrait"  },
  { types: ["tvepisode", "episode", "show", "tvSeries", "vod"], label: "TV SHOWS",    layout: "landscape" },
  { types: ["comedy"],                              label: "COMEDY CLIPS", layout: "landscape" },
  { types: ["musicvideo", "music"],                 label: "MUSIC VIDEOS", layout: "landscape" },
  { types: ["shortfilm", "shorts"],                 label: "SHORT FILMS",  layout: "landscape" },
  { types: ["live"],                                label: "LIVE TV",      layout: "landscape" },
];

function buildHref(item: ContentItem): string {
  const title = item.generalInfo?.title || item.globalServiceName || item.title || "watch";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (item.globalServiceId && item.globalServiceId !== item._id)
    return `/${slug}/detail/${item.globalServiceId}/${item._id}`;
  return `/${slug}/detail/${item._id}`;
}

function isFreeItem(item: ContentItem): boolean {
  return (
    item.generalInfo?.isSellable === false ||
    item.generalInfo?.heroBannerLabelText?.toLowerCase() === "free" ||
    item.generalInfo?.bottomCenterLabel?.toLowerCase() === "free"
  );
}

function groupResults(items: ContentItem[]) {
  const typeMap: Record<string, ContentItem[]> = {};
  for (const item of items) {
    const t = (item.generalInfo?.type || "other").toLowerCase();
    (typeMap[t] ??= []).push(item);
  }

  const sections: { label: string; layout: "portrait" | "landscape"; items: ContentItem[] }[] = [];
  const covered = new Set<string>();

  for (const sec of SECTION_MAP) {
    const bucket: ContentItem[] = [];
    for (const t of sec.types) {
      if (typeMap[t]) { bucket.push(...typeMap[t]); covered.add(t); }
    }
    if (bucket.length) sections.push({ label: sec.label, layout: sec.layout, items: bucket });
  }

  const rest = Object.entries(typeMap)
    .filter(([t]) => !covered.has(t))
    .flatMap(([, v]) => v);
  if (rest.length) sections.push({ label: "OTHER", layout: "landscape", items: rest });

  return sections;
}

function FreeRibbon() {
  return (
    <div className="absolute top-0 right-0 w-14 h-14 overflow-hidden pointer-events-none">
      <div className="absolute top-3 right-[-14px] bg-red-600 text-white text-[9px] font-bold px-5 py-[2px] rotate-45 tracking-wide">
        Free
      </div>
    </div>
  );
}

function SearchCard({ item, layout }: { item: ContentItem; layout: "portrait" | "landscape" }) {
  const href = buildHref(item);
  const title =
    item.generalInfo?.displayTitle ||
    item.generalInfo?.title ||
    item.title ||
    item.globalServiceName || "";
  const free = isFreeItem(item);
  const isLive = item.generalInfo?.type === "live";

  const imgUrl =
    layout === "portrait"
      ? getImageUrl(item.images, "poster", "xhdpi") || getImageUrl(item.images, "preview", "xhdpi")
      : getImageUrl(item.images, "preview", "xhdpi") ||
        getImageUrl(item.images, "landscape", "xhdpi") ||
        getImageUrl(item.images, "poster", "xhdpi");

  const cardCls =
    layout === "portrait"
      ? "w-[106px] sm:w-[120px] aspect-[2/3]"
      : "w-[170px] sm:w-[200px] aspect-video";

  return (
    <Link href={href} className="group shrink-0">
      <div className={`relative overflow-hidden rounded-lg bg-gray-800 ${cardCls}`}>
        {imgUrl ? (
          <Image
            src={imgUrl}
            alt={title}
            fill
            unoptimized
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center p-2">
            <span className="text-gray-500 text-[10px] text-center leading-tight">{title}</span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 rounded-full p-2">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        {/* Free ribbon — top-right diagonal badge */}
        {free && !isLive && <FreeRibbon />}

        {/* Live badge */}
        {isLive && (
          <div className="absolute top-1.5 left-1.5">
            <span className="flex items-center gap-1 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
              <span className="w-1 h-1 bg-white rounded-full animate-pulse" />
              LIVE
            </span>
          </div>
        )}
      </div>

      <p className="mt-1.5 text-white text-[11px] sm:text-xs font-medium line-clamp-2 leading-snug group-hover:text-red-400 transition-colors"
        style={{ maxWidth: layout === "portrait" ? 106 : 200 }}>
        {title}
      </p>
    </Link>
  );
}

function SearchResults() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const q = searchParams.get("q") || "";

  const [query, setQuery]           = useState(q);
  const [results, setResults]       = useState<ContentItem[]>([]);
  const [loading, setLoading]       = useState(false);
  const [hasSearched, setHasSearched] = useState(!!q);
  const [language, setLanguage]     = useState("All Languages");
  const [langOpen, setLangOpen]     = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const langRef     = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(async (term: string) => {
    if (!term.trim()) return;
    setLoading(true);
    setHasSearched(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (q) { setQuery(q); doSearch(q); }
  }, [q, doSearch]);

  // Close lang dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const pushSearch = (term: string) => {
    router.replace(term ? `/search?q=${encodeURIComponent(term)}` : "/search", { scroll: false });
  };

  const handleChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim()) { setResults([]); setHasSearched(false); pushSearch(""); return; }
    debounceRef.current = setTimeout(() => { pushSearch(val); doSearch(val); }, 400);
  };

  const clearSearch = () => {
    setQuery(""); setResults([]); setHasSearched(false);
    router.replace("/search", { scroll: false });
    inputRef.current?.focus();
  };

  const sections = groupResults(results);

  // Language-filter (client-side) — filter by item.language if a language is selected
  const filtered = language === "All Languages"
    ? sections
    : sections.map((s) => ({
        ...s,
        items: s.items.filter(
          (item) => !item.language || item.language.toLowerCase() === language.toLowerCase()
        ),
      })).filter((s) => s.items.length > 0);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white pb-16">
      {/* ── Search bar row ───────────────────────────────── */}
      <div className="px-4 sm:px-6 lg:px-10 pt-5 pb-4 max-w-screen-xl mx-auto">
        <div className="flex items-center gap-3">
          {/* Search input */}
          <form
            className="flex-1 relative"
            onSubmit={(e) => { e.preventDefault(); if (query.trim()) { pushSearch(query); doSearch(query); } }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleChange(e.target.value)}
              placeholder="Movies, shows, channels..."
              autoFocus
              className="w-full bg-white text-gray-900 placeholder-gray-400 text-sm px-4 py-2.5 rounded-lg outline-none focus:ring-2 focus:ring-red-500/60 pr-9"
            />
            {query ? (
              <button type="button" onClick={clearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </form>

          {/* Languages dropdown */}
          <div ref={langRef} className="relative shrink-0">
            <button
              onClick={() => setLangOpen((v) => !v)}
              className="flex items-center gap-2 bg-white text-gray-800 text-sm font-medium px-3 py-2.5 rounded-lg whitespace-nowrap hover:bg-gray-50 transition-colors"
            >
              Languages
              <svg className={`w-4 h-4 text-gray-500 transition-transform ${langOpen ? "rotate-180" : ""}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {langOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white rounded-xl shadow-2xl z-50 min-w-[150px] overflow-hidden border border-gray-100">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    onClick={() => { setLanguage(lang); setLangOpen(false); }}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-gray-50 ${
                      language === lang ? "text-red-600 font-semibold bg-red-50" : "text-gray-700"
                    }`}
                  >
                    {lang}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Loading ──────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <div className="w-7 h-7 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* ── Grouped results ──────────────────────────────── */}
      {!loading && hasSearched && filtered.length > 0 && (
        <div className="space-y-7 mt-2">
          {filtered.map((sec) => (
            <section key={sec.label} className="px-4 sm:px-6 lg:px-10 max-w-screen-xl mx-auto">
              <h2 className="text-white font-bold text-sm sm:text-[15px] tracking-widest uppercase mb-3">
                {sec.label}
              </h2>
              <div
                className="flex gap-3 sm:gap-4 overflow-x-auto pb-3"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
              >
                {sec.items.map((item) => (
                  <SearchCard key={item._id} item={item} layout={sec.layout} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* ── No results ───────────────────────────────────── */}
      {!loading && hasSearched && filtered.length === 0 && (
        <div className="text-center py-24 px-4">
          <p className="text-5xl mb-4">🎬</p>
          <p className="text-gray-400 font-semibold">No results found</p>
          <p className="text-gray-600 text-sm mt-1">Try a different keyword or language</p>
        </div>
      )}

      {/* ── Empty / pre-search state ─────────────────────── */}
      {!hasSearched && !loading && (
        <div className="flex flex-col items-center justify-center py-28 px-4 gap-4 text-gray-600">
          <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <p className="text-sm text-center">Search for Tamil, Telugu, Malayalam movies &amp; shows</p>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  );
}
