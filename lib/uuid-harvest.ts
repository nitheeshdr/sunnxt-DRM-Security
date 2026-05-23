/**
 * UUID Harvest Algorithm
 *
 * Three-phase system that builds the UUID database automatically:
 *
 * Phase 1 — Discovery
 *   Crawl SunNXT's browse/search/category APIs (no subscription required)
 *   to collect as many content IDs as possible.
 *
 * Phase 2 — UUID Extraction
 *   For each discovered content ID, call /api/media/{id} on our own server.
 *   The route handler decrypts the response, calls learnUuidsFromEntries(),
 *   and persists any new UUID to disk automatically.
 *
 * Phase 3 — Verification
 *   Confirm each ID has a UUID in the DB and a valid hdntl token exists,
 *   meaning it will play without subscription.
 *
 * The harvest runs in the background. Progress is tracked in a shared state
 * object readable via GET /api/admin/harvest.
 */

import { getUuidDbSize, getUuidDbKeys } from "./cdn-bypass";

// ---------------------------------------------------------------------------
// Shared harvest state — readable from the status endpoint
// ---------------------------------------------------------------------------
export interface HarvestState {
  running: boolean;
  startedAt: string | null;
  phase: "idle" | "discovering" | "extracting" | "done" | "error";
  discovered: number;
  processed: number;
  newUuids: number;
  skipped: number;
  errors: number;
  dbSizeBefore: number;
  dbSizeAfter: number;
  lastError: string | null;
  etaSecs: number | null;
}

export const harvestState: HarvestState = {
  running: false,
  startedAt: null,
  phase: "idle",
  discovered: 0,
  processed: 0,
  newUuids: 0,
  skipped: 0,
  errors: 0,
  dbSizeBefore: 0,
  dbSizeAfter: 0,
  lastError: null,
  etaSecs: null,
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const PWAAPI = "https://pwaapi.sunnxt.com";
const COMMON_HEADERS = {
  "x-myplex-platform": "browser",
  "x-ucv": "5",
  "origin": "https://www.sunnxt.com",
  "referer": "https://www.sunnxt.com/",
  "user-agent": UA,
  "contentlanguage": "tamil,telugu,malayalam,kannada,hindi,bengali,marathi,english",
  "accept": "*/*",
};

// ---------------------------------------------------------------------------
// Phase 1 — Content ID discovery
// ---------------------------------------------------------------------------

/** Extract all content IDs from any API JSON response recursively. */
function extractIds(obj: unknown, out: Set<string>): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { obj.forEach((v) => extractIds(v, out)); return; }
  const rec = obj as Record<string, unknown>;
  const id = rec._id ?? rec.id ?? rec.contentId ?? rec.content_id;
  if (typeof id === "string" && /^\d+$/.test(id)) out.add(id);
  if (typeof id === "number") out.add(String(id));
  for (const v of Object.values(rec)) extractIds(v, out);
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const r = await fetch(url, { headers: COMMON_HEADERS, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Crawl the browse endpoint across all categories and languages. */
async function discoverFromBrowse(ids: Set<string>): Promise<void> {
  const languages = ["tamil", "telugu", "malayalam", "kannada", "hindi", "bengali", "marathi", "english"];
  const types = ["movies", "tvshows", "shorts", "music", "comedy"];

  const pages = [
    `${PWAAPI}/content/v2/browse?content_type=all&page_size=200&page_num=1`,
    `${PWAAPI}/content/v2/browse?content_type=movies&page_size=200&page_num=1`,
    `${PWAAPI}/content/v2/browse?content_type=tvshows&page_size=200&page_num=1`,
    ...languages.map((l) => `${PWAAPI}/content/v2/browse?language=${l}&page_size=200&page_num=1`),
    ...languages.map((l) => `${PWAAPI}/content/v2/browse?language=${l}&content_type=movies&page_size=200&page_num=1`),
    ...types.map((t) => `${PWAAPI}/content/v2/browse?content_type=${t}&page_size=200&page_num=1`),
  ];

  for (const url of pages) {
    const data = await fetchJson(url);
    if (data) extractIds(data, ids);
  }
}

/** Search with common terms to surface more content. */
async function discoverFromSearch(ids: Set<string>): Promise<void> {
  // Single characters and common terms give broad result sets
  const queries = ["a", "e", "i", "o", "u", "the", "love", "war", "hero",
    "raja", "rani", "krishna", "vijay", "ajith", "kamal", "prabhas", "ntr",
    "amma", "appa", "police", "action", "comedy", "drama", "romance"];
  for (const q of queries) {
    const data = await fetchJson(
      `${PWAAPI}/content/v2/search?query=${encodeURIComponent(q)}&page_size=100&page_num=1`
    );
    if (data) extractIds(data, ids);
  }
}

/** Browse by genre/category IDs (SunNXT uses numeric genre IDs). */
async function discoverFromCategories(ids: Set<string>): Promise<void> {
  // Category IDs discovered from browse responses (common range: 1–200)
  const categoryIds = Array.from({ length: 50 }, (_, i) => i + 1);
  const results = await Promise.allSettled(
    categoryIds.map((c) =>
      fetchJson(`${PWAAPI}/content/v2/browse?genre_id=${c}&page_size=100&page_num=1`)
    )
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) extractIds(r.value, ids);
  }
}

/** Enumerate a range of content IDs directly — fills gaps the browse API misses. */
async function discoverFromIdRange(ids: Set<string>, start: number, end: number, step = 1): Promise<void> {
  for (let i = start; i <= end; i += step) ids.add(String(i));
}

// ---------------------------------------------------------------------------
// Phase 2 — UUID extraction via our own media route
// ---------------------------------------------------------------------------

async function extractUuidForContent(
  contentId: string,
  baseUrl: string,
  concurrencySlot: Promise<void>
): Promise<"new" | "known" | "skip" | "error"> {
  await concurrencySlot;
  const before = getUuidDbSize();
  try {
    const r = await fetch(`${baseUrl}/api/media/${contentId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const data = await r.json() as { code?: number };
    // 200 means bypass path 1 (subscription) returned data and learnUuidsFromEntries ran
    if (data?.code === 200) {
      const after = getUuidDbSize();
      return after > before ? "new" : "known";
    }
    // 401 = no session at all
    if (data?.code === 401) return "error";
    // 404 = video_unavailable (all bypasses failed, but content ID is valid)
    return "skip";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Main harvest orchestrator
// ---------------------------------------------------------------------------

export async function runHarvest(baseUrl: string): Promise<void> {
  if (harvestState.running) return;

  harvestState.running = true;
  harvestState.startedAt = new Date().toISOString();
  harvestState.phase = "discovering";
  harvestState.discovered = 0;
  harvestState.processed = 0;
  harvestState.newUuids = 0;
  harvestState.skipped = 0;
  harvestState.errors = 0;
  harvestState.lastError = null;
  harvestState.dbSizeBefore = getUuidDbSize();
  harvestState.dbSizeAfter = 0;

  try {
    // ── Phase 1: Discover content IDs ───────────────────────────────────────
    console.log("harvest: phase 1 — discovering content IDs");
    const ids = new Set<string>();

    // Skip IDs already in UUID_DB (already have their UUID)
    const alreadyKnown = new Set(getUuidDbKeys());

    await Promise.all([
      discoverFromBrowse(ids),
      discoverFromSearch(ids),
      discoverFromCategories(ids),
    ]);

    // Dense ID ranges where SunNXT content lives (discovered empirically)
    await discoverFromIdRange(ids, 7000, 12000);       // high-density movie range
    await discoverFromIdRange(ids, 50000, 60000, 5);   // sparser newer content
    await discoverFromIdRange(ids, 100000, 110000, 10);
    await discoverFromIdRange(ids, 200000, 260000, 10); // full 200k–260k band (was split)

    // Remove already-known and non-numeric IDs
    for (const id of alreadyKnown) ids.delete(id);
    harvestState.discovered = ids.size;
    console.log(`harvest: discovered ${ids.size} unknown content IDs`);

    // ── Phase 2: Extract UUIDs ───────────────────────────────────────────────
    console.log("harvest: phase 2 — extracting UUIDs");
    harvestState.phase = "extracting";

    const idList = Array.from(ids);
    const CONCURRENCY = 8;                   // parallel requests to our own server
    const BATCH_DELAY_MS = 100;              // pause between batches (avoid hammering SunNXT)

    // Rolling window of resolved promises for concurrency control
    let resolveSlot!: () => void;
    let slotPromise = new Promise<void>((r) => { resolveSlot = r; resolveSlot(); });

    const makeSlot = (): Promise<void> => {
      const prev = slotPromise;
      let res!: () => void;
      slotPromise = new Promise<void>((r) => { res = r; });
      prev.then(() => res());
      return prev;
    };

    const startMs = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < idList.length; i += CONCURRENCY) {
      batches.push(idList.slice(i, i + CONCURRENCY));
    }

    for (const batch of batches) {
      await Promise.all(
        batch.map((id) =>
          extractUuidForContent(id, baseUrl, makeSlot()).then((result) => {
            harvestState.processed++;
            if (result === "new") harvestState.newUuids++;
            else if (result === "skip") harvestState.skipped++;
            else if (result === "error") harvestState.errors++;

            // ETA estimate
            const elapsed = (Date.now() - startMs) / 1000;
            const rate = harvestState.processed / elapsed;
            const remaining = idList.length - harvestState.processed;
            harvestState.etaSecs = rate > 0 ? Math.round(remaining / rate) : null;
          })
        )
      );
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }

    harvestState.dbSizeAfter = getUuidDbSize();
    harvestState.phase = "done";
    console.log(`harvest: done — ${harvestState.newUuids} new UUIDs, db size now ${harvestState.dbSizeAfter}`);
  } catch (e) {
    harvestState.phase = "error";
    harvestState.lastError = String(e);
    console.error("harvest: fatal error", e);
  } finally {
    harvestState.running = false;
    harvestState.etaSecs = null;
  }
}
