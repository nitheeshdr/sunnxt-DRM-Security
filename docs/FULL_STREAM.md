# Complete Video Streaming Flow — SunNXT Technical Reference

**Author: Nitheesh D R**
**Scope: End-to-end DASH/HLS streaming, CDN architecture, DRM integration**

---

## Table of Contents

1. [Stream Format Inventory](#1-stream-format-inventory)
2. [CDN Architecture](#2-cdn-architecture)
3. [Complete Request Lifecycle](#3-complete-request-lifecycle)
4. [DASH Manifest (MPD) Structure](#4-dash-manifest-mpd-structure)
5. [HLS Manifest Structure](#5-hls-manifest-structure)
6. [Akamai Token System](#6-akamai-token-system)
7. [stream-proxy — Deep Dive](#7-stream-proxy--deep-dive)
8. [MPD Rewriting Logic](#8-mpd-rewriting-logic)
9. [CDN Bypass Mechanism — Full Flow](#9-cdn-bypass-mechanism--full-flow)
10. [Segment Download Pattern](#10-segment-download-pattern)
11. [Subtitle / Caption Flow](#11-subtitle--caption-flow)
12. [Live TV Streaming](#12-live-tv-streaming)
13. [Heartbeat and Session Tracking](#13-heartbeat-and-session-tracking)
14. [Quality Adaptation (ABR)](#14-quality-adaptation-abr)
15. [Error Recovery and Format Fallback](#15-error-recovery-and-format-fallback)

---

## 1. Stream Format Inventory

SunNXT returns multiple stream formats per content in the `videos.values` array. Each entry has a `format` field:

| Format String | Protocol | DRM | CDN | Notes |
|---|---|---|---|---|
| `dash` | MPEG-DASH | Widevine + PlayReady | Akamai OR suntvvod1 | Primary format; 2 variants |
| `dash-cenc` | MPEG-DASH | Widevine + PlayReady | suntvvod1 | CENC mode; explicit license URL |
| `hls` | HLS | AES-128 / None | suntvvod1 | iOS fallback |
| `hls-fp-aapl` | HLS | FairPlay | suntvvod1 | Safari/iOS only |
| `hlsaes` | HLS | AES-128 | suntvvod1 | Older encrypted HLS |

### 1.1 Format Selection Priority (Player)

On Safari/iOS, FairPlay HLS is preferred because Apple's EME only supports `com.apple.fps.1_0`:

```typescript
// app/player/[contentId]/page.tsx
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const fairPlayHls = isSafari ? videos.find((v) => v.format === "hls-fp-aapl") : undefined;

const ordered = (isSafari
  ? [clearDash, fairPlayHls, hlsVideo, cencDash, widevineDash, videos[0]]
  : [clearDash, widevineDash, cencDash, hlsVideo, videos[0]]
)
```

FairPlay config:
```typescript
if (isFairPlay) {
  player.configure({
    drm: {
      servers: { "com.apple.fps.1_0": proxyLicenseUrl },
      advanced: { "com.apple.fps.1_0": { serverCertificateUri: proxyLicenseUrl } },
    },
  });
}
```

Non-Safari priority:
```typescript
const ordered = [
  clearDash,    // format=dash, no licenseUrl (Akamai CDN — nominally unencrypted)
  widevineDash, // format=dash, with licenseUrl (modularLicense/nagravision)
  cencDash,     // format=dash-cenc, with licenseUrl
  hlsVideo,     // format=hls or hlsaes (not hls-fp-aapl)
  videos[0],    // fallback: first entry
]
.filter(not already failed)
.filter(not Safari-only FairPlay unless Safari)
```

### 1.2 CDN Variants Per Format

**Akamai CDN (movies1-suntvvod / movies2-suntvvod):**
- HD: `movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/{contentId}_hd.mpd`
- SD: `movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/sd/{contentId}_sd.mpd`
- EST-HD: `movies1-suntvvod-dd.akamaized.net/movies/{uuid}/{contentId}/{contentId}_est_hd.mpd`
- EST-SD: `movies1-suntvvod-dd.akamaized.net/movies/{uuid}/{contentId}/{contentId}_est_sd.mpd`

**suntvvod1 (direct SunNXT CDN):**
- Format: `https://suntvvod1.sunnxt.com/{session_token}/{content_token}/{filename}`
- URLs include time-limited tokens in the path segments, not query parameters

---

## 2. CDN Architecture

```
                          SunNXT Backend
                               │
                    ┌──────────┴──────────┐
                    │                     │
              suntvvod1.sunnxt.com    Akamai CDN
              (SunNXT's own CDN)      (third-party)
                    │                     │
            ┌───────┴──────┐    ┌────────┴────────┐
            │              │    │                  │
       dash-cenc        hlsaes  movies1-suntvvod  movies2-suntvvod
       hls/hls-fp      format   .akamaized.net    .akamaized.net
                                (hasQualitySubdir) (no quality subdir)
                                       │
                                movies1-suntvvod-dd
                                .akamaized.net
                                (EST/download variants)
```

### 2.1 Akamai CDN URL Pattern Analysis

**movies1 pattern** (most Tamil/Telugu content):
```
https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/{contentId}_hd.mpd
                                              ▲─────────────────────────────────────────
                                              32-char hex UUID (not the contentId)
                                              Only obtainable from subscribed API response
```

**movies2 pattern** (newer content):
```
https://movies2-suntvvod.akamaized.net/movies2/{uuid}/{contentId}/{contentId}_hd.mpd
                                                                   ▲────────────────
                                                                   No quality subdirectory
```

**movies1-suntvvod-dd pattern** (EST/download):
```
https://movies1-suntvvod-dd.akamaized.net/movies/{uuid}/{contentId}/{contentId}_est_hd.mpd
```

### 2.2 UUID Discovery

The content UUID is the only information not derivable from public endpoints. It lives in the SunNXT content database and must be extracted from an authenticated media API response. Once captured, it is **permanent** — UUIDs are never rotated.

Known UUIDs (from HAR analysis):
| contentId | UUID | CDN | hasQualitySubdir |
|---|---|---|---|
| 82850 (96) | `2a0b194b81d4071cf41ccfeb69d690e2` | movies1 | Yes |
| 115249 (The Cricketer) | `f38231600b68e429d44dff546f96b29e` | movies1 | Yes |
| 251833 | `5bfb2a0404ec10ba52cb2d072c64cbf4` | movies2 | No |

---

## 3. Complete Request Lifecycle

### 3.1 Initial Page Load → First Video Frame

```
T=0ms    Browser → GET /player/82850
         Next.js renders player page, triggers two parallel fetches:
         (a) GET /api/content/82850  → metadata (title, images)
         (b) GET /api/media/82850    → stream URLs

T=100ms  /api/media/82850 handler:
         1. Check browser session cookie (has sessionid?)
         2. If no session → use server SUNNXT_USERID/PASSWORD session
         3. POST www.sunnxt.com/next/api/media/82850 with session cookie
         4. Response: AES-128-CBC encrypted blob → decrypt with MEDIA_KEY
         5. Check: videos.status === "ERR_USER_NOT_SUBSCRIBED"?
            → Yes: run bypass cascade (VULN-11, VULN-12, VULN-13)
            → No: extract video entries, harvest hdntl + UUID
         6. Return video entries as JSON

T=150ms  Player receives entries, selects format (clearDash or widevineDash)
         Initiates Shaka Player with the chosen format

T=160ms  Shaka Player → GET /api/stream-proxy?url={mpd_url}&licenseUrl={lic_url}
         stream-proxy fetches MPD from Akamai CDN

T=250ms  Akamai CDN → returns MPD XML
         stream-proxy:
         1. Extracts hdntl token from segment template URLs → caches
         2. Injects <BaseURL> (for relative segment URL resolution)
         3. Injects <dashif:Laurl> into Widevine ContentProtection
         4. Returns rewritten MPD to Shaka

T=260ms  Shaka parses MPD:
         - Finds ContentProtection with Widevine UUID
         - Reads <dashif:Laurl> → knows license URL
         - Selects initial quality (lowest for fast start)

T=280ms  Shaka → GET /api/stream-proxy?url={init.mp4}  (initialization segment)
         stream-proxy proxies init segment from Akamai

T=320ms  CDM reads init.mp4 → finds PSSH box → generates Widevine challenge
         Shaka → POST /api/license?url={licenseUrl}&contentId=82850
                 Body: Widevine challenge bytes

T=400ms  license proxy → POST pwaapi modularLicense/?content_id=82850
         pwaapi → returns binary Widevine license (~450 bytes)
         license proxy validates (first byte ≠ 0x7B) → returns to Shaka

T=410ms  CDM processes license → extracts content keys → decrypts AES key table
         Shaka begins downloading video segments

T=500ms  First video frame decoded and displayed
```

### 3.2 Subsequent Segment Downloads

```
Shaka (ABR) → GET /api/stream-proxy?url={segment.mp4}
              request filter: if URL is SunNXT CDN → proxy it
              + inject hdnea token if present in original manifest URL

stream-proxy → GET {segment.mp4} from Akamai (with server session cookie if needed)
             → Returns binary segment (video/audio samples, AES-CBC encrypted)

Shaka decryptor (using CDM-provided key) → decrypts segment
Video decoder → decode H.264/H.265 frames → render
```

---

## 4. DASH Manifest (MPD) Structure

### 4.1 Typical SunNXT MPD (Akamai CDN)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns:dashif="https://dashif.org/CPS"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns="urn:mpeg:dash:schema:mpd:2011"
     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
     type="static"
     mediaPresentationDuration="PT9756.9S"
     minBufferTime="PT4.0S">

  <!-- Injected by stream-proxy rewriteMpd() -->
  <BaseURL>https://movies1-suntvvod.akamaized.net/movies/2a0b194b81d4071cf41ccfeb69d690e2/82850/hd/</BaseURL>

  <Period id="1" start="PT0S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028" frameRate="25">

      <!-- Widevine DRM signalling -->
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <!-- Injected by stream-proxy rewriteMpd() -->
        <dashif:Laurl>http://localhost:3000/api/license?url=...&contentId=82850</dashif:Laurl>
        <cenc:pssh>AAAAWnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADoIARIQlKwk...</cenc:pssh>
      </ContentProtection>

      <!-- PlayReady DRM signalling -->
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95">
        <mspr:pro>QgMAAAEAAQA4AzwAVwBSAE0ASABFAEFARABFAFIAY...</mspr:pro>
      </ContentProtection>

      <!-- Quality representations -->
      <Representation id="video_1" bandwidth="4500000" width="1920" height="1080">
        <SegmentTemplate
          media="vid/seg$Number$.mp4?hdntl=exp%3D1779560880~acl%3D%2F*~data%3Dhdntl~hmac%3D..."
          initialization="vid/init.mp4?hdntl=exp%3D1779560880~acl%3D%2F*~data%3Dhdntl~hmac%3D..."
          startNumber="1"
          duration="96000"
          timescale="24000"/>
      </Representation>
      <Representation id="video_2" bandwidth="2000000" width="1280" height="720">
        <!-- similar -->
      </Representation>
    </AdaptationSet>

    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2">
      <ContentProtection .../>
      <Representation id="audio_1" bandwidth="128000">
        <SegmentTemplate
          media="aud/seg$Number$.mp4?hdntl=..."
          initialization="aud/init.mp4?hdntl=..."/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
```

### 4.2 Key Observations

1. **hdntl in segment template URLs** — Every segment URL includes the wildcard Akamai token embedded in the `SegmentTemplate` `media` and `initialization` attributes. stream-proxy extracts this for bypass caching.

2. **PSSH in ContentProtection** — The Widevine PSSH box contains the content key ID. Even if ContentProtection elements are stripped from the MPD, the PSSH is also embedded in the `init.mp4` segment, so Shaka still triggers license acquisition.

3. **`<BaseURL>` injection** — Without this, Shaka resolves relative segment paths against the proxy URL (`localhost:3000/api/stream-proxy?url=...`) rather than the CDN URL. The injected `<BaseURL>` points to the CDN directory, so segments resolve correctly before being re-routed through the request filter.

4. **`<dashif:Laurl>` injection** — Shaka 5.x uses `TXml.findChildNS()` with namespace `https://dashif.org/CPS` to find the license URL. Without this element, Shaka falls back to `player.configure({drm:{servers:{...}}})`, which can silently fail for some manifest structures → error 6012.

---

## 5. HLS Manifest Structure

### 5.1 Master Playlist (`.m3u8`)

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://suntvvod1.sunnxt.com/{token}/{content_token}/hd/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
https://suntvvod1.sunnxt.com/{token}/{content_token}/sd/stream.m3u8
```

### 5.2 Media Playlist

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://api.sunnxt.com/key/...",IV=0x00000000000000000000000000000001
#EXTINF:10.0,
seg001.ts
#EXTINF:10.0,
seg002.ts
...
#EXT-X-ENDLIST
```

### 5.3 HLS Manifest Rewriting (stream-proxy)

The `rewriteM3u8` function converts all URIs (segment lines and `URI=` attributes) to proxied paths:

```typescript
// Before rewriting:
seg001.ts
// After rewriting:
/api/stream-proxy?url=https%3A%2F%2Fsuntvvod1.sunnxt.com%2F{token}%2F...%2Fseg001.ts

// Before:
#EXT-X-KEY:METHOD=AES-128,URI="https://api.sunnxt.com/key/..."
// After:
#EXT-X-KEY:METHOD=AES-128,URI="/api/stream-proxy?url=https%3A%2F%2Fapi.sunnxt.com%2Fkey%2F..."
```

---

## 6. Akamai Token System

### 6.1 Two Token Types

SunNXT uses two different Akamai token schemes:

**hdnea (EdgeAuth Token 1.0) — Content-specific:**
```
st=1779358753~exp=1779369553~acl=!*/115249/*~hmac=37a59f0b...
```
- `st` = start time (Unix)
- `exp` = expiry time (Unix, typically +3 hours)
- `acl` = access control list — `!*/115249/*` means "only paths containing `/115249/`"
- `hmac` = HMAC-SHA256 signature using Akamai's secret
- **Not transferable to other content** — acl is content-specific

**hdntl (EdgeToken Lite 2.0) — Wildcard:**
```
exp=1779560880~acl=/*~data=hdntl~hmac=aa7428997c8af6cd...
```
- `exp` = expiry time (Unix, typically +24 hours)
- `acl=/*` = **wildcard — covers ALL paths on the CDN**
- `data=hdntl` = token type identifier
- `hmac` = signature
- **Transferable to any content** — this is what bypass path 3 exploits

### 6.2 Token Extraction from MPD

```typescript
// app/api/stream-proxy/route.ts
const hdntlM = xml.match(/hdntl=([^"&\s]+)/);
if (hdntlM) extractAndCacheHdntlFromUrl(`https://cdn.sunnxt.com/?hdntl=${hdntlM[1]}`);
```

The hdntl token is URL-encoded in the segment template attributes. The regex extracts it; `extractAndCacheHdntlFromUrl` parses `exp=` to compute TTL, validates it's not expired, caches in memory, and persists to disk at `$TMPDIR/sunnxt-hdntl.json`.

### 6.3 Token Persistence

```typescript
// lib/cdn-bypass.ts — IIFE runs on module load
(function initHdntlCache() {
  const envToken = process.env.SUNNXT_HDNTL;
  if (envToken && seedFromToken(envToken, "SUNNXT_HDNTL env")) return;
  const disk = loadCacheFromDisk();           // $TMPDIR/sunnxt-hdntl.json
  if (disk) { hdntlCache = disk; }
})();
```

Priority: env var → disk file → empty (no bypass 3 available).

### 6.4 Token Re-Injection for Segments

The player's request filter injects `hdnea` (the content-specific token from the original MPD URL) into every segment request:

```typescript
// app/player/[contentId]/page.tsx
let hdnea: string | null = null;
try { hdnea = new URL(video.link).searchParams.get("hdnea"); } catch {}

player.getNetworkingEngine().registerRequestFilter((_type, request) => {
  const url = request.uris[0];
  if (url.includes("/api/stream-proxy")) return;
  if (isSunnxtCdnUrl(url)) {
    let cdnUrl = url;
    if (hdnea && !cdnUrl.includes("hdnea=")) {
      cdnUrl += (cdnUrl.includes("?") ? "&" : "?") + `hdnea=${encodeURIComponent(hdnea)}`;
    }
    request.uris[0] = `/api/stream-proxy?url=${encodeURIComponent(cdnUrl)}`;
  }
});
```

For bypass path 3 content, `hdnea` is null (no content-specific token); `hdntl` is embedded directly in the segment URLs from the MPD, so Akamai accepts them.

---

## 7. stream-proxy — Deep Dive

### 7.1 Route: `GET /api/stream-proxy`

**Parameters:**
| Param | Required | Description |
|---|---|---|
| `url` | Yes | Full CDN URL to proxy |
| `licenseUrl` | No | License URL to inject into MPD `<dashif:Laurl>` |
| `stripDrm` | No | `true` = remove all ContentProtection from MPD |

**Domain Allowlist:**
```typescript
const ALLOWED_HOSTS = [
  "livestream.sunnxt.com",
  "suntvvod1.sunnxt.com",
  "sunnxt.com",       // *.sunnxt.com via endsWith check
  "akamaized.net",    // guarded: hostname.includes("suntvvod")
  "cloudfront.net",   // SunNXT subtitle CDN
];
```

For `akamaized.net`, an additional check ensures only `movies*-suntvvod*.akamaized.net` is allowed, preventing abuse of the wildcard.

### 7.2 Content Type Detection

```typescript
const isMpd = contentType.includes("dash+xml") || contentType.includes("mpd")
           || url.split("?")[0].endsWith(".mpd");

const isM3u8 = contentType.includes("mpegurl")
            || url.split("?")[0].endsWith(".m3u8");
```

Both content-type header AND URL extension are checked — CDN servers sometimes return `application/octet-stream` for manifest files.

### 7.3 Binary Segment Passthrough

For video/audio segments, the response body is streamed directly without buffering:

```typescript
return new NextResponse(upstream.body, {  // upstream.body is a ReadableStream
  status: 200,
  headers: {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "cache-control": cacheControl,
  },
});
```

Using `upstream.body` (streaming) rather than `await upstream.arrayBuffer()` (buffering) is critical for large segment files — buffering would exhaust memory on the server and add significant latency.

---

## 8. MPD Rewriting Logic

### 8.1 `<BaseURL>` Injection

```typescript
function rewriteMpd(xml: string, manifestUrl: string, licenseUrl?: string): string {
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);
  const baseUrlTag = `<BaseURL>${baseDir}</BaseURL>`;
  
  result = result.replace(/(<MPD[^>]*>)/, `$1\n  ${baseUrlTag}`);
}
```

`manifestUrl` is the full CDN URL of the MPD (with hdntl token). `baseDir` strips the filename, leaving the directory URL:
```
https://movies1-suntvvod.akamaized.net/movies/2a0b194b81d4071cf41ccfeb69d690e2/82850/hd/82850_hd.mpd?hdntl=...
→ baseDir = https://movies1-suntvvod.akamaized.net/movies/2a0b194b81d4071cf41ccfeb69d690e2/82850/hd/
```

Shaka resolves `vid/seg001.mp4` against this `<BaseURL>` → full CDN URL → request filter catches it → proxies it.

### 8.2 `<dashif:Laurl>` Injection

```typescript
// Register namespace on MPD root
result = result.replace(/(<MPD\b)/, '$1 xmlns:dashif="https://dashif.org/CPS"');

// Inject <dashif:Laurl> into each Widevine ContentProtection
const widevineScheme = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const laUrlTag = `<dashif:Laurl>${licenseUrl}</dashif:Laurl>`;
result = result.replace(
  new RegExp(`(<ContentProtection\\b[^>]*schemeIdUri="${widevineScheme}"[^>]*>)`, "gi"),
  `$1\n      ${laUrlTag}`
);
// Also handle self-closing variant
result = result.replace(
  new RegExp(`<ContentProtection(\\b[^>]*schemeIdUri="${widevineScheme}"[^>]*)\\/>`, "gi"),
  `<ContentProtection$1>\n      ${laUrlTag}\n    </ContentProtection>`
);
```

Shaka 5.x uses `TXml.findChildNS("Laurl", "https://dashif.org/CPS")` to find the license URL in the manifest. The `xmlns:dashif` declaration on the MPD root is required for `findChildNS` to resolve the prefix.

### 8.3 `stripDrm` Mode

```typescript
function stripContentProtection(xml: string): string {
  return xml
    .replace(/<ContentProtection\b[^>]*>[\s\S]*?<\/ContentProtection>/gi, "")
    .replace(/<ContentProtection\b[^>]*\/>/gi, "");
}
```

Used for `format=dash` streams from the Akamai CDN that include ContentProtection in the MPD but where segments might be unencrypted. However, this approach fails when segments are actually encrypted — the PSSH in `init.mp4` still triggers CDM license acquisition (Shaka error 6010 `NO_LICENSE_SERVER_GIVEN`). The current fix is to infer a `modularLicense` URL for Akamai streams instead.

---

## 9. CDN Bypass Mechanism — Full Flow

### 9.1 Prerequisites

```
UUID_DB: { contentId → { uuid, cdnBase, hasQualitySubdir } }
hdntlCache: { value: "exp=...~acl=/*~...", expiresAt: unix_ms }
```

### 9.2 `buildBypassEntries(contentId)`

```typescript
// lib/cdn-bypass.ts
export function buildBypassEntries(contentId: string): VideoEntry[] | null {
  const entry = getContentEntry(contentId);  // UUID_DB lookup
  if (!entry) return null;

  const hdntl = getHdntl();  // check hdntlCache, validate expiry
  if (!hdntl) return null;

  const { uuid, cdnBase, hasQualitySubdir } = entry;
  const tok = `hdntl=${encodeURIComponent(hdntl)}`;
  const cdnBaseDD = cdnBase.replace("-suntvvod.", "-suntvvod-dd.");
  const base = `${cdnBase}/${uuid}/${contentId}`;

  const hdLink = hasQualitySubdir
    ? `${base}/hd/${contentId}_hd.mpd?${tok}`
    : `${base}/${contentId}_hd.mpd?${tok}`;

  return [
    { format: "dash", profile: "High", link: hdLink,
      licenseUrl: `https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=${contentId}` },
    // ... SD, EST-HD, EST-SD variants
  ];
}
```

### 9.3 UUID Auto-Learning

When a subscribed session succeeds, the CDN URLs are scraped:

```typescript
// lib/cdn-bypass.ts
export function learnUuidsFromEntries(contentId: string, entries: VideoEntry[]): void {
  for (const v of entries) {
    if (v.link.includes("-suntvvod-dd.")) continue;  // skip DD CDN
    const m = v.link.match(
      /^(https:\/\/movies\d*-suntvvod\.akamaized\.net\/movies2?)\/([a-f0-9]{32})\/(\d+)\/(hd\/|sd\/)?[\w.-]+\.mpd/
    );
    if (!m || m[3] !== contentId) continue;
    registerContentEntry(contentId, {
      uuid: m[2],
      cdnBase: m[1],
      hasQualitySubdir: !!(m[4]),
    });
  }
}
```

---

## 10. Segment Download Pattern

### 10.1 DASH Segment Types

| File | Purpose |
|---|---|
| `init.mp4` | Initialization segment — contains PSSH, codec info, no media samples |
| `segN.mp4` (numbered) | Media segment — ~4-second chunk of video or audio |
| `seg$Number$.mp4` | Template-based segments (number substituted by Shaka) |

### 10.2 Encryption Within Segments

SunNXT uses **CENC (Common Encryption)** with **CTR mode (cenc)** for video samples:
- Each sample is AES-128-CTR encrypted with the content key
- IV is constructed from the sample number (counter)
- The key ID is referenced in the `init.mp4` PSSH box
- CDM provides the content key after license acquisition

The transport layer (MP4 container) is not encrypted — only the raw video/audio bitstream within each sample.

### 10.3 Segment URL Pattern

After MPD rewriting, Shaka constructs segment URLs by:
1. Taking the `<BaseURL>` value
2. Appending the segment template media attribute with `$Number$` substituted
3. The resulting URL contains the full Akamai path + hdntl token

Example:
```
BaseURL:    https://movies1-suntvvod.akamaized.net/movies/{uuid}/{id}/hd/
media attr: vid/seg$Number$.mp4?hdntl=exp%3D...~acl%3D%2F*~...
→ Segment:  https://movies1-suntvvod.akamaized.net/movies/{uuid}/{id}/hd/vid/seg1.mp4?hdntl=...
```

The request filter catches this URL (matches `isSunnxtCdnUrl`) → proxy to stream-proxy.

---

## 11. Subtitle / Caption Flow

### 11.1 Subtitle Discovery

Subtitles are included in the `subtitles` field of the content API response. Each subtitle entry has:
- `language` — ISO language code
- `link` — URL to the subtitle file (typically `.vtt` or `.srt`)
- `format` — `vtt` or `srt`

### 11.2 Subtitle CDN

Subtitles are served from `d2hdl36b3yoqpz.cloudfront.net` (Amazon CloudFront), a separate CDN from video content. No authentication is required for subtitle files — they are publicly accessible.

### 11.3 Download Proxy

The `/api/download` route handles subtitle downloads:
```
GET /api/download?url={subtitle_url}&filename={lang}.vtt
→ Fetches from CloudFront (or sunnxt.com)
→ Sets Content-Disposition: attachment; filename="{filename}"
→ Proxies binary content
```

---

## 12. Live TV Streaming

### 12.1 Live Channel Discovery

Live channels are fetched from:
```
GET https://pwaapi.sunnxt.com/content/v2/carousel/liveChannels
    ?level=devicemax&startIndex=1&count=60&contentlang=...
```

### 12.2 Live Stream CDN

Live streams use a dedicated CDN: `livestream.sunnxt.com`
```
https://livestream.sunnxt.com/live/{channel_id}/master.m3u8
```

Live streams are typically HLS with AES-128 encryption. The stream-proxy handles the master playlist and media playlists, rewriting all URIs to proxy paths.

### 12.3 Live vs VOD Differences

| Property | VOD | Live |
|---|---|---|
| CDN | Akamai / suntvvod1 | livestream.sunnxt.com |
| Format | DASH (primary) + HLS | HLS (only) |
| Manifest type | Static MPD | Dynamic M3U8 |
| Segments | Pre-encoded, time-unlimited | Rolling 30-60 second window |
| DRM | Widevine / PlayReady | AES-128 HLS |
| Token | hdntl/hdnea (Akamai) | Session-based URL |

---

## 13. Heartbeat and Session Tracking

### 13.1 Heartbeat Protocol

Every 30 seconds during playback, the player sends:
```
POST /api/heartbeat
Body: { contentId: "82850", action: "Start" }
```

The heartbeat proxy forwards to:
```
POST https://pwaapi.sunnxt.com/user/v2/events/heartbeat/status/
Body: action=Start&contentId=82850
```

On playback stop (page unload / player destroy):
```
POST /api/heartbeat
Body: { contentId: "82850", action: "Stop" }
```

### 13.2 Server-Side Session for Heartbeat

The heartbeat endpoint uses the browser session if available, falling back to the server session:
```typescript
let cookieHeader = browserCookie;
if (!cookieHeader.includes("sessionid")) {
  cookieHeader = await getSunnxtCookies();
}
```

This means heartbeat events are recorded under the server's account even when the browser user is watching via the bypass mechanism — a potential data integrity issue for SunNXT's analytics (VULN-17).

---

## 14. Quality Adaptation (ABR)

### 14.1 Shaka ABR Configuration

Shaka Player uses **BOLA (Buffer Occupancy Based Lyapunov Algorithm)** for ABR by default in version 5.x. It dynamically switches quality levels based on:
- Network throughput estimate
- Buffer occupancy
- Target buffer size

No explicit ABR configuration is set in the player — Shaka's defaults are used.

### 14.2 Quality Representations

A typical SunNXT DASH MPD contains 3-5 video representations:
| Profile | Bitrate | Resolution |
|---|---|---|
| HD | 4,500 kbps | 1920×1080 |
| HD | 2,500 kbps | 1280×720 |
| SD | 1,200 kbps | 854×480 |
| SD | 600 kbps | 640×360 |
| Mobile | 300 kbps | 426×240 |

Audio representations:
| Codec | Bitrate | Channels |
|---|---|---|
| AAC-LC | 128 kbps | Stereo |
| Dolby Digital Plus (EC-3) | 192 kbps | 5.1 (if `isDolby: true`) |

---

## 15. Error Recovery and Format Fallback

### 15.1 Format Fallback Loop

```typescript
// app/player/[contentId]/page.tsx
let lastErr: unknown = null;
for (const video of ordered) {
  try {
    await startPlayback(video, id, fallbackLicenseUrl);
    return; // success — break loop
  } catch (e) {
    lastErr = e;
    console.warn("Player: format", video.format, "failed — trying next");
  }
}
throw lastErr ?? new Error("No playable stream found.");
```

### 15.2 DRM Error Recovery

Runtime DRM errors (after initial load) trigger re-fetch of media and retry:

```typescript
player.addEventListener("error", (event) => {
  if (!loadingDone) return;  // only handle post-load errors
  const code = detail?.code ?? 0;
  const isDrm = detail?.category === 6   // Shaka DRM category
             || (code >= 6000 && code < 7000)
             || code === 4012;            // RESTRICTIONS_CANNOT_BE_MET

  if (isDrm && currentVideoRef.current) {
    failedFormatsRef.current.add(currentVideoRef.current.format);
    loadAndPlay(id);  // re-fetch media API → get fresh bypass entries
    return;
  }
  setError(msg);
});
```

### 15.3 Known Shaka Error Codes

| Code | Name | Cause in SunNXT context | Fix Applied |
|---|---|---|---|
| 6012 | NO_LICENSE_SERVER_GIVEN | MPD has no `<dashif:Laurl>`, no `drm.servers` configured | Inject `<dashif:Laurl>` in stream-proxy; infer license URL for Akamai streams |
| 6010 | REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE | Browser doesn't support Widevine | Graceful error message |
| 4012 | RESTRICTIONS_CANNOT_BE_MET | CDM rejected license (JSON error passed as binary) | Validate first byte in license proxy; 4012 added to DRM error set |
| 1001 | HTTP_ERROR | Segment download 403/404 | Format fallback; CDN token check |
| 4016 | CONTENT_TRANSFORMATION_FAILED | Decryption failed despite valid license | Usually key mismatch; retry with fresh license |

---

---

## 16. Download Feature — DASH-to-fMP4 Segment Streaming

### 16.1 Route Structure

```
GET /api/download/video/[contentId]
  → (no params)          Info JSON: title, encryption status, download URLs
  → ?stream=1&merge=1    Server-side ffmpeg merge (video+audio → single MP4)
  → ?stream=1&track=video  Raw video fMP4 segments streamed directly
  → ?stream=1&track=audio  Raw audio fMP4 segments streamed directly
  → ?stream=1&debug=mpd  Raw MPD XML returned for inspection
```

### 16.2 MPD Parser

The route implements a regex-based SegmentTemplate + SegmentTimeline parser:

```
1. Parse MPD-level <BaseURL> → mpdBase
2. For each <AdaptationSet>:
   a. Check mimeType attribute (video/* or audio/*)
   b. Parse AdaptationSet-level <BaseURL>
   c. Parse <SegmentTemplate>: initialization, media, startNumber, timescale, duration
   d. Parse <SegmentTimeline> <S> elements: d (duration), r (repeat count) → segment count
   e. Find highest-bandwidth <Representation> (opening tag only — body not needed)
   f. Expand $RepresentationID$, $Bandwidth$, $Number$ templates
   g. Resolve against adaptBase, append MPD URL query string (Akamai hdntl token)
3. Return highest-bandwidth AdaptationSet result
```

Fallback: when SegmentTimeline is absent, count = ceil(periodDuration × timescale / tmplDuration).

### 16.3 fMP4 Assembly

Segments are fetched and streamed (or collected) in order: `init.mp4` first, then all media segments numbered `startNumber` to `startNumber + count - 1`. The result is a valid fragmented MP4 (CMAF / fMP4) that can be played directly if the content is unencrypted, or decrypted with the content key if CENC-encrypted.

### 16.4 Server-Side Merge

```
?stream=1&merge=1 flow:
1. checkFfmpeg() → which ffmpeg → path or 503
2. parseMpdTrack(mpdXml, ..., "video") + parseMpdTrack(mpdXml, ..., "audio")
3. collectTrack() × 2 in parallel (Promise.all)
   - Each: init.mp4 + all segments → single concatenated Uint8Array
4. mkdtemp → write video.mp4 + audio.mp4 to temp dir
5. spawn ffmpeg -i video.mp4 -i audio.mp4 -c copy -movflags frag_keyframe+empty_moov -f mp4 pipe:1
6. Pipe ffmpeg stdout → HTTP response (TransformStream)
7. On ffmpeg close: rm -rf temp dir
```

Limitations: not compatible with Vercel serverless (temp disk, execution time cap).

### 16.5 Live Channel DRM — isLive=1 Flag

The license proxy accepts `?isLive=1` to skip `modularLicense`. This is used for:
- Live channels: `modularLicense` returns HDCP_V2-enforcing licenses for all live content IDs unconditionally
- FairPlay: `modularLicense` speaks Widevine binary protocol; FairPlay challenges are incompatible

When `isLive=1`, the proxy routes directly to the original `nagravisionDRMProxy` URL (authenticated, with session JWT + cookie).

---

*Document prepared from reverse engineering of sunnxt.com network traffic, source code analysis, and live playback testing.*
*For security research and educational purposes.*
