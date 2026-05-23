/**
 * CDN bypass implementation.
 *
 * Two independent mechanisms that together allow playback without a subscription:
 *
 * 1. UUID database — Maps content IDs to their internal CDN path UUID + CDN pattern.
 *    The UUID is the only piece of data not available from public endpoints.
 *    Populated from HAR analysis; grows as more sessions are observed.
 *
 * 2. hdntl token cache — Akamai wildcard token (acl=/*) that covers ALL CDN
 *    paths for 24 hours.  Extracted from any successful media API call and
 *    reused for subscription-blocked content.
 *
 * Chain: uuid + hdntl → MPD (403 without hdntl) + open segments (always 200)
 *        + modularLicense (no sub check) → full playback
 *
 * Token persistence:
 *   The hdntl token is saved to OS temp dir so it survives server restarts.
 *   On startup, the token is loaded from (in priority order):
 *     1. SUNNXT_HDNTL env var (set in .env.local — never committed)
 *     2. Disk cache at $TMPDIR/sunnxt-hdntl.json
 *   To refresh the token: update SUNNXT_HDNTL in .env.local and restart.
 *   The token is also automatically refreshed whenever a successful CDN
 *   response embeds a new hdntl value (e.g. via stream-proxy MPD processing).
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface VideoEntry {
  link: string;
  licenseUrl?: string;
  format: string;
  profile: string;
  resolution?: string;
}

// ---------------------------------------------------------------------------
// UUID database — maps contentId to CDN path info
//
// CDN patterns observed via HAR analysis:
//  movies1-suntvvod: /movies/{uuid}/{contentId}/hd/{contentId}_hd.mpd  (with quality subdir)
//  movies2-suntvvod: /movies2/{uuid}/{contentId}/{contentId}_hd.mpd     (no quality subdir)
//  DD variants always use no quality subdir regardless of main CDN pattern.
// ---------------------------------------------------------------------------
interface CdnEntry {
  uuid: string;
  // Base URL up to and including the /movies or /movies2 prefix
  // e.g. "https://movies1-suntvvod.akamaized.net/movies"
  cdnBase: string;
  // True when the standard CDN puts hd/sd in a subdirectory before the filename
  hasQualitySubdir: boolean;
}

const UUID_DB: Record<string, CdnEntry> = {
  "82850": {
    uuid: "2a0b194b81d4071cf41ccfeb69d690e2",
    cdnBase: "https://movies1-suntvvod.akamaized.net/movies",
    hasQualitySubdir: true,
  },
  "115249": {
    uuid: "f38231600b68e429d44dff546f96b29e",
    cdnBase: "https://movies1-suntvvod.akamaized.net/movies",
    hasQualitySubdir: true,
  },
  "251833": {
    uuid: "5bfb2a0404ec10ba52cb2d072c64cbf4",
    cdnBase: "https://movies2-suntvvod.akamaized.net/movies2",
    hasQualitySubdir: false,
  },
  "8118": {
    uuid: "7c74e6d95fbffafd294bccce75fe11e8",
    cdnBase: "https://movies1-suntvvod.akamaized.net/movies",
    hasQualitySubdir: true,
  },
  "7816": {
    uuid: "c26ea818615ece25aa6af6b8e8e03d59",
    cdnBase: "https://movies1-suntvvod.akamaized.net/movies",
    hasQualitySubdir: true,
  },
  "9999": {
    uuid: "5a114b74960c9a7b04a008ae83f91f36",
    cdnBase: "https://movies1-suntvvod.akamaized.net/movies",
    hasQualitySubdir: true,
  },
  "8101": { uuid: "c43449d3bd5acdfa0e35101c814975ce", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8102": { uuid: "aa05039258cc541f039d62bb465e7af2", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8103": { uuid: "012c2799a35fe45f9f802c41b3a71f47", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8104": { uuid: "56723d589c81c44d487fdc34395dd688", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8105": { uuid: "7a779033656c88764360558b92e796c7", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8109": { uuid: "0a5cc56417ca23f5cbe2184f7a0b592b", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8110": { uuid: "9d45aa68cd79a7697146bdea568ffac0", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8111": { uuid: "06ed0aecc0858d5a265482026d4effa3", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8112": { uuid: "3567716813596cff99d30b1fea2719c4", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8113": { uuid: "26df0065a5ae88e27e0ae570b28bb19b", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8114": { uuid: "b69faec8607a7ac330d0372ec1692280", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8115": { uuid: "2e1579d0397265c6d13b439ff127fec9", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8116": { uuid: "03fe559ffdf215747bd5f6a584d18b7d", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8119": { uuid: "6baa0f2c6a537511c6d8d865a11039d6", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8120": { uuid: "9d9f2e6097d33f58f7684b25cfbe3e7d", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8121": { uuid: "fff79da6b44af12b85302d5f91fd66ed", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8122": { uuid: "8048e229d899ec28810ae7e32c48a94c", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8123": { uuid: "1a3c5a79fd59816fd90c6fb299ecc019", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8124": { uuid: "ca7ce042f7fcb46bfff95b15e6a3cefd", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8125": { uuid: "0feb6a0717499701ce94493489721592", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8126": { uuid: "9029641c1aae9f2572cda9cac2ae369b", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8127": { uuid: "e73d4c4c299ac222e96594995604a026", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8128": { uuid: "8eff5bc37eb0aedfea708c5c52cd5b7f", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8129": { uuid: "66e0baf8679c89e5f497bd8a8576fd26", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8130": { uuid: "8930bee6de24dea18f8f4d8ce0a0d425", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8131": { uuid: "715c4de70334b15606775896ddbaab34", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8132": { uuid: "8fde9762bd4cdd3a04a21c78475afc27", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8133": { uuid: "8b1dcfa9670681c34a8aa4befce56b63", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8134": { uuid: "3cc64dfc806355510848e656b5122a98", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8135": { uuid: "94fc8868e97cd1e929e2575ef5add24e", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8136": { uuid: "d32e7db85ff5699eef62baaa01c72fa9", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8137": { uuid: "232969ae4d41f12ff31354fc63e47cc5", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8138": { uuid: "8b96a3cdaa191aec22ac0535fa9b25ef", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8139": { uuid: "e7ebae4d7422d0904050a7bd7244d022", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8140": { uuid: "1fdbbc7660a97c35a1b48b4c6d36e046", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8141": { uuid: "c3bef085d3967807d3cec0e737f21da8", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8143": { uuid: "79b9f928778f15738939aa65d674bfd5", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8144": { uuid: "61148922643906cc5b20420fa8c8eb62", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8145": { uuid: "29065aa90c3e8b16ae0e4fbdc7507723", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8146": { uuid: "923c9e5ab9ae25dfa8a7e1ffd9dc04f9", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8148": { uuid: "e292587473279c49ebd1174f7111ed28", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8149": { uuid: "279ff1fe836ca6ecfc4e5fb11571e013", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8150": { uuid: "f7ef805258a27526662cccf546e23443", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8151": { uuid: "9bf277bc44578ed306fd980fcfd04cd2", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8152": { uuid: "f6a033331be79997ba80bdb13412e8ad", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8153": { uuid: "d10a8b1ead455a138e9676282f7df41e", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8154": { uuid: "033476897eff4d6c7fa1001be5dbdeb4", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8155": { uuid: "d39b6aba63a27141d736c9de467d596a", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8156": { uuid: "ce217268b252946ca3b9d4157d3ae140", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8157": { uuid: "00bd250362ca61ca9030bb534cb924f0", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8158": { uuid: "ee9a3b1b5db4f5711800bf2d4bc721c8", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
  "8159": { uuid: "d2cc73f95e68d0aed87eaf003be12036", cdnBase: "https://movies1-suntvvod.akamaized.net/movies", hasQualitySubdir: true },
};

// ---------------------------------------------------------------------------
// UUID_DB disk persistence — survives server restarts
// ---------------------------------------------------------------------------
const UUID_DB_FILE = join(tmpdir(), "sunnxt-uuid-db.json");

function saveUuidDbToDisk(): void {
  try {
    writeFileSync(UUID_DB_FILE, JSON.stringify(UUID_DB), "utf8");
  } catch { /* non-fatal */ }
}

function loadUuidDbFromDisk(): void {
  try {
    const raw = readFileSync(UUID_DB_FILE, "utf8");
    const loaded = JSON.parse(raw) as Record<string, CdnEntry>;
    let added = 0;
    for (const [id, entry] of Object.entries(loaded)) {
      if (!UUID_DB[id]) { UUID_DB[id] = entry; added++; }
    }
    if (added > 0) console.log(`cdn-bypass: loaded ${added} uuid entries from disk (total ${Object.keys(UUID_DB).length})`);
  } catch { /* file doesn't exist yet */ }
}

// Merge disk entries on module load
loadUuidDbFromDisk();

function registerContentEntry(contentId: string, entry: CdnEntry): void {
  UUID_DB[contentId] = entry;
  saveUuidDbToDisk();
}

function getContentEntry(contentId: string): CdnEntry | null {
  return UUID_DB[contentId] ?? null;
}

export function getUuidDbSize(): number {
  return Object.keys(UUID_DB).length;
}

export function getUuidDbKeys(): string[] {
  return Object.keys(UUID_DB);
}

// ---------------------------------------------------------------------------
// hdntl wildcard token cache + persistence
// ---------------------------------------------------------------------------
interface HdntlCache {
  value: string;      // raw token string, e.g. "exp=...~acl=/*~hmac=..."
  expiresAt: number;  // milliseconds
}

let hdntlCache: HdntlCache | null = null;

const CACHE_FILE = join(tmpdir(), "sunnxt-hdntl.json");

function saveCacheToDisk(cache: HdntlCache): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
  } catch { /* non-fatal */ }
}

function loadCacheFromDisk(): HdntlCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const c = JSON.parse(raw) as HdntlCache;
    return Date.now() < c.expiresAt ? c : null;
  } catch { return null; }
}

function seedFromToken(token: string, source: string): boolean {
  const expM = token.match(/exp=(\d+)/);
  if (!expM) return false;
  const expiresAt = parseInt(expM[1]) * 1000;
  if (Date.now() >= expiresAt) return false;
  hdntlCache = { value: token, expiresAt };
  saveCacheToDisk(hdntlCache);
  console.log(`cdn-bypass: hdntl seeded from ${source}, expires ${new Date(expiresAt).toISOString()}`);
  return true;
}

// Seed on module load: env var first, then disk.
(function initHdntlCache() {
  const envToken = process.env.SUNNXT_HDNTL;
  if (envToken && seedFromToken(envToken, "SUNNXT_HDNTL env")) return;
  const disk = loadCacheFromDisk();
  if (disk) {
    hdntlCache = disk;
    console.log(`cdn-bypass: hdntl loaded from disk, expires ${new Date(disk.expiresAt).toISOString()}`);
  }
})();

/** Extract hdntl from any list of video entry URLs and cache it. */
export function extractAndCacheHdntl(entries: VideoEntry[]): void {
  for (const v of entries) {
    const m = v.link.match(/[?&]hdntl=([^&\s]+)/);
    if (!m) continue;
    const token = decodeURIComponent(m[1]);
    if (seedFromToken(token, "video entry URL")) return;
  }
}

/** Also accept plain URL strings (e.g. from a single licenseUrl or link). */
export function extractAndCacheHdntlFromUrl(url: string): void {
  extractAndCacheHdntl([{ link: url, format: "", profile: "" }]);
}

function getHdntl(): string | null {
  if (!hdntlCache || Date.now() >= hdntlCache.expiresAt) return null;
  return hdntlCache.value;
}

/** Returns true when bypass path 2 can fire immediately (UUID in DB + valid hdntl). */
export function hasFullBypassFor(contentId: string): boolean {
  return !!(getContentEntry(contentId) && getHdntl());
}

// ---------------------------------------------------------------------------
// Build synthetic video entries for subscription-blocked content
// ---------------------------------------------------------------------------

/**
 * Try to build CDN stream URLs for a content ID using the UUID database
 * and a cached hdntl token.
 *
 * Returns null if:
 * - The content UUID is not in the database, OR
 * - No valid hdntl token is cached (MPD manifests need hdntl; segments don't)
 */
export function buildBypassEntries(contentId: string): VideoEntry[] | null {
  const entry = getContentEntry(contentId);
  if (!entry) {
    console.log(`cdn-bypass: no UUID for content ${contentId}`);
    return null;
  }

  const hdntl = getHdntl();
  if (!hdntl) {
    console.log(`cdn-bypass: no valid hdntl token cached`);
    return null;
  }

  const { uuid, cdnBase, hasQualitySubdir } = entry;
  const tok = `hdntl=${encodeURIComponent(hdntl)}`;

  // Derive the DD (download/EST) CDN base from the main CDN base by inserting -dd
  // e.g. movies1-suntvvod → movies1-suntvvod-dd
  const cdnBaseDD = cdnBase.replace("-suntvvod.", "-suntvvod-dd.");

  const base    = `${cdnBase}/${uuid}/${contentId}`;
  const baseDD  = `${cdnBaseDD}/${uuid}/${contentId}`;

  // licenseUrl → pwaapi modularLicense (no subscription check — VULN-11).
  // Without this, the player strips ContentProtection from the MPD entirely,
  // which causes playback failure for Widevine-encrypted streams.
  const licenseUrl = `https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=${contentId}`;

  const hdLink = hasQualitySubdir
    ? `${base}/hd/${contentId}_hd.mpd?${tok}`
    : `${base}/${contentId}_hd.mpd?${tok}`;
  const sdLink = hasQualitySubdir
    ? `${base}/sd/${contentId}_sd.mpd?${tok}`
    : `${base}/${contentId}_sd.mpd?${tok}`;

  const entries: VideoEntry[] = [
    { format: "dash", profile: "High", link: hdLink,                                         licenseUrl },
    { format: "dash", profile: "Low",  link: sdLink,                                         licenseUrl },
    { format: "dash", profile: "High", link: `${baseDD}/${contentId}_est_hd.mpd?${tok}`,     licenseUrl },
    { format: "dash", profile: "Low",  link: `${baseDD}/${contentId}_est_sd.mpd?${tok}`,     licenseUrl },
  ];

  console.log(`cdn-bypass: built ${entries.length} bypass entries for content ${contentId} uuid=${uuid.slice(0, 8)}... cdnBase=${cdnBase}`);
  return entries;
}

/**
 * Scan a media API result and register any newly seen content UUIDs + CDN patterns
 * so they can be used for future bypass attempts.
 *
 * URL pattern (HAR-derived):
 *   movies1: https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/{id}_hd.mpd
 *   movies2: https://movies2-suntvvod.akamaized.net/movies2/{uuid}/{contentId}/{id}_hd.mpd
 */
export function learnUuidsFromEntries(contentId: string, entries: VideoEntry[]): void {
  if (UUID_DB[contentId]) return; // already known

  for (const v of entries) {
    // Skip DD (download) CDN — DD hosts don't use quality subdirs; learn from main CDN only
    if (v.link.includes("-suntvvod-dd.")) continue;

    // Capture: (cdnBase) / (uuid) / (contentId) / (optional quality subdir) / (filename)
    const m = v.link.match(
      /^(https:\/\/movies\d*-suntvvod\.akamaized\.net\/movies2?)\/([a-f0-9]{32})\/(\d+)\/(hd\/|sd\/)?[\w.-]+\.mpd/
    );
    if (!m || m[3] !== contentId) continue;

    const cdnBase = m[1];
    const uuid = m[2];
    const hasQualitySubdir = !!(m[4]); // group 4 is "hd/" or "sd/" or undefined

    registerContentEntry(contentId, { uuid, cdnBase, hasQualitySubdir });
    console.log(`cdn-bypass: learned uuid for content ${contentId}: ${uuid} cdnBase=${cdnBase} qualitySubdir=${hasQualitySubdir}`);
    return;
  }
}
