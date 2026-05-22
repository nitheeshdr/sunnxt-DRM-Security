# Security Assessment Report
## SunNXT OTT Platform — Web Application & API

---

| Field | Details |
|---|---|
| **Report Title** | SunNXT Web Platform Security Assessment |
| **Prepared By** | Nitheesh D R |
| **Assessment Type** | Black-Box Web Application & API Security Testing |
| **Scope** | sunnxt.com — Web App, REST APIs, CDN, DRM Infrastructure |
| **Test Period** | May 2026 |
| **Report Date** | May 22, 2026 |
| **Report Version** | 1.0 — Final |
| **Classification** | Confidential — For SunNXT Security Team Only |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [Risk Rating Definitions](#3-risk-rating-definitions)
4. [Findings Summary](#4-findings-summary)
5. [Detailed Findings](#5-detailed-findings)
   - [VULN-01: Static AES Encryption Key in Client JavaScript](#vuln-01-static-aes-encryption-key-in-client-javascript)
   - [VULN-02: Static All-Zero IV in AES-CBC Encryption](#vuln-02-static-all-zero-iv-in-aes-cbc-encryption)
   - [VULN-03: Device Registration Limit Bypass](#vuln-03-device-registration-limit-bypass)
   - [VULN-04: Long-Lived Session Cookies Without Expiry](#vuln-04-long-lived-session-cookies-without-expiry)
   - [VULN-05: ManageDevices Endpoint Missing Access Control](#vuln-05-managedevices-endpoint-missing-access-control)
   - [VULN-06: Time-Limited CDN Tokens Without IP Binding](#vuln-06-time-limited-cdn-tokens-without-ip-binding)
   - [VULN-07: Geo-Block Bypass via Server-Side IP Spoofing](#vuln-07-geo-block-bypass-via-server-side-ip-spoofing)
   - [VULN-08: DRM License JWT Reuse Window (maxUses: 2)](#vuln-08-drm-license-jwt-reuse-window-maxuses-2)
   - [VULN-09: API Returns HTTP 200 for Blocked/Error Content](#vuln-09-api-returns-http-200-for-blockederror-content)
   - [VULN-10: No Rate Limiting on Login API](#vuln-10-no-rate-limiting-on-login-api)
6. [DRM Architecture Analysis](#6-drm-architecture-analysis)
7. [Stream Format Enumeration](#7-stream-format-enumeration)
8. [Remediation Summary](#8-remediation-summary)
9. [Conclusion](#9-conclusion)

---

## 1. Executive Summary

This report presents the findings of a black-box security assessment conducted against the SunNXT web platform (`www.sunnxt.com`), its backend REST APIs, CDN infrastructure, and DRM (Digital Rights Management) subsystem.

The assessment was performed through analysis of client-side JavaScript, network traffic interception, API endpoint testing, and DRM architecture review.

**10 vulnerabilities** were identified across the platform. The most critical findings are:

- A **static AES-128 encryption key** hardcoded into the client-side JavaScript bundle, used to encrypt login credentials
- A **static all-zero initialization vector** in CBC mode encryption, weakening all encrypted communications
- A **device registration limit bypass** that can be executed in approximately 3 unauthenticated HTTP requests
- **Session cookies without a short TTL**, enabling persistent unauthorized access if a session is stolen

The DRM infrastructure (Widevine and PlayReady via Nagravision) is correctly implemented at the cryptographic level. No bypass of content decryption keys was found. Premium content cannot be accessed without a valid licensed account.

---

## 2. Scope & Methodology

### 2.1 Scope

| Asset | In Scope |
|---|---|
| `www.sunnxt.com` — Web Application | Yes |
| `www.sunnxt.com/next/api/*` — REST API | Yes |
| `api.sunnxt.com` — DRM License Proxy | Yes |
| `suntvvod1.sunnxt.com` — VOD CDN | Yes |
| `*.akamaized.net` (SunNXT VOD) — CDN | Yes |
| `livestream.sunnxt.com` — Live TV CDN | Yes |
| Mobile apps (iOS / Android) | No |
| SunNXT backend infrastructure / servers | No |

### 2.2 Methodology

Testing followed the **OWASP Web Security Testing Guide (WSTG v4.2)** and **OWASP Top 10** framework, focusing on:

- **Information Gathering** — JavaScript source analysis, API endpoint discovery, response header inspection
- **Authentication Testing** — Login flow, session management, credential encryption
- **Authorization Testing** — Device limit enforcement, content access control, geo-restriction bypass
- **Cryptography Review** — Encryption algorithm, key management, IV usage
- **API Security** — Parameter tampering, response analysis, error handling
- **DRM Architecture Review** — Stream format enumeration, license acquisition flow, CDN token analysis

### 2.3 Tools Used

| Tool | Purpose |
|---|---|
| Browser DevTools (Chrome) | Network traffic analysis, JavaScript source review |
| Custom Node.js scripts | API endpoint testing, DRM analysis |
| CryptoJS | AES decryption of encrypted API responses |
| Shaka Player 5.x | Stream playback and DRM integration testing |
| Next.js (custom proxy) | CORS bypass, stream proxying, session testing |
| jwt.io / manual decode | JWT structure analysis |

---

## 3. Risk Rating Definitions

| Severity | CVSS Score Range | Description |
|---|---|---|
| **Critical** | 9.0 – 10.0 | Immediate exploitation possible; severe business impact |
| **High** | 7.0 – 8.9 | Exploitation likely; significant impact on users or platform |
| **Medium** | 4.0 – 6.9 | Exploitation possible under specific conditions |
| **Low** | 0.1 – 3.9 | Limited impact; defense-in-depth weaknesses |
| **Informational** | N/A | No direct security impact; best-practice recommendations |

---

## 4. Findings Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| VULN-01 | Static AES Key in Client JavaScript | **High** | Open |
| VULN-02 | Static All-Zero IV in AES-CBC | **Medium** | Open |
| VULN-03 | Device Limit Bypass | **Medium** | Open |
| VULN-04 | Long-Lived Session Cookies | **Medium** | Open |
| VULN-05 | ManageDevices Missing Access Control | **Medium** | Open |
| VULN-06 | CDN Tokens Without IP Binding | **Low** | Open |
| VULN-07 | Geo-Block Bypass via Server-Side Proxy | **Medium** | Open |
| VULN-08 | DRM JWT Reuse Window | **Low** | Open |
| VULN-09 | HTTP 200 Returned for Error States | **Informational** | Open |
| VULN-10 | No Rate Limiting on Login API | **Medium** | Open |
| VULN-11 | `modularLicense` Endpoint Has No Subscription Check | **Critical** | Open |
| VULN-12 | CDN Video Segments Served Without Authentication | **High** | Open |
| VULN-13 | `hdntl` Wildcard Token Enables Cross-Content CDN Access | **High** | Open |

---

## 5. Detailed Findings

---

### VULN-01: Static AES Encryption Key in Client JavaScript

| Field | Detail |
|---|---|
| **Severity** | High |
| **CVSS v3.1 Score** | 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **Affected Component** | `www.sunnxt.com` — JavaScript bundle |
| **CWE** | CWE-321: Use of Hard-coded Cryptographic Key |

#### Description

SunNXT encrypts login payloads and API responses using AES-128-CBC. The encryption key is hardcoded as a plaintext string inside the client-side JavaScript bundle delivered to every browser.

**Extracted key:**
```
A3s68aORSgHs$71P
```

#### Evidence

The key was located by searching for `CryptoJS.AES.encrypt` in the minified JavaScript bundle via Chrome DevTools → Sources tab.

The login flow:
```
Client → encrypts { userid, password } with static key → POST /next/api/login
Server → returns encrypted JSON response → client decrypts with same static key
```

#### Impact

- Any user can extract the key from their browser and decrypt all login payloads intercepted on the network (if TLS is stripped or via a MITM position)
- The key also decrypts API responses including stream URLs, DRM license URLs, and user account metadata
- No key rotation mechanism was identified

#### Recommendation

- Move login encryption to a server-side challenge-response flow (e.g., RSA public key for credential exchange)
- If symmetric encryption must be used, derive a per-session key from a server-issued nonce rather than using a static key
- At minimum, rotate the static key periodically and obfuscate it more aggressively in the bundle

---

### VULN-02: Static All-Zero IV in AES-CBC Encryption

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 5.3 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **Affected Component** | Login API, Media API response decryption |
| **CWE** | CWE-329: Not Using a Random IV with CBC Mode |

#### Description

All AES-CBC encrypted payloads use a fixed initialization vector of 16 zero bytes:

```javascript
const iv = CryptoJS.enc.Hex.parse("00000000000000000000000000000000");
```

This applies to both the login request payload encryption and the API response decryption.

#### Impact

- **Deterministic ciphertext:** Two users with the same password produce identical first cipher blocks. This allows statistical analysis across a large dataset of intercepted login requests.
- **Pattern leakage:** In CBC mode with a predictable IV, the first block of the ciphertext is entirely deterministic given the same plaintext. This weakens the effective security of the encryption.
- Compound risk with VULN-01: attacker who has the static key + static IV can trivially decrypt any intercepted payload.

#### Recommendation

- Generate a cryptographically random 16-byte IV per encryption operation
- Prepend the IV to the ciphertext (standard practice)
- The server must be updated to read the IV from the first 16 bytes of each received payload

---

### VULN-03: Device Registration Limit Bypass

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 5.4 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N) |
| **Affected Component** | `POST /next/api/login`, ManageDevices endpoint |
| **CWE** | CWE-284: Improper Access Control |

#### Description

SunNXT enforces a device registration limit (HTTP code `423` in login response) to prevent excessive account sharing. This limit can be completely bypassed in three HTTP requests without requiring a second device or manual user action.

#### Proof of Concept (Steps)

1. **Trigger the device limit:** Attempt login → receive `{ code: 423 }` response with a `ui.buttons[].buttonAction` URL containing a `token` parameter

2. **Fetch device list without authentication:** The `buttonAction` URL (ManageDevices webview) returns an HTML page listing all registered devices with their `deviceId` values embedded in `removeDevice` links. No additional auth beyond the token in the URL is required.

3. **Remove a device:** Call the remove endpoint:
   ```
   GET https://api.sunnxt.com/user/v4/removeDevice/?token=<TOKEN>&deviceId=<ID>&redirectUrl=
   ```
   No CSRF token. No secondary confirmation. Device is immediately removed.

4. **Re-attempt login:** The slot is now free and login succeeds.

#### Impact

- The device limit provides no real security barrier — it can be bypassed programmatically without user interaction
- An attacker with valid credentials can maintain login access indefinitely by evicting legitimate devices
- Shared/compromised accounts can be accessed from unlimited simultaneous devices

#### Recommendation

- Require session authentication (not just a URL token) to access the ManageDevices page
- Add CSRF protection to the `removeDevice` endpoint
- Rate-limit device removal operations per account
- Send a push notification / email to the account owner when a device is removed

---

### VULN-04: Long-Lived Session Cookies Without Expiry

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 5.9 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **Affected Component** | Session management (`sessionid` cookie) |
| **CWE** | CWE-613: Insufficient Session Expiration |

#### Description

The `sessionid` cookie issued upon successful login does not have a short TTL enforced server-side. In testing, session cookies remained valid for extended periods without requiring re-authentication.

#### Impact

- If a session cookie is extracted from a user's browser (via XSS, browser extension compromise, or physical access), the attacker gains persistent account access
- No automatic logout after inactivity
- Compounded by VULN-03: a stolen session can also be used to remove legitimate devices and lock the real user out

#### Recommendation

- Enforce server-side session expiry (e.g., 24 hours of inactivity, 30 days absolute)
- Implement sliding-window session renewal for active users
- Provide users with a "sessions" page showing all active sessions with the ability to revoke them

---

### VULN-05: ManageDevices Endpoint Missing Access Control

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 6.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N) |
| **Affected Component** | `https://www.sunnxt.com/managedevices?token=...` |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |

#### Description

The ManageDevices endpoint is a webview accessible via a URL-embedded token. The server does not verify that the token is associated with the currently authenticated session or the requesting IP address.

#### Evidence

The `token` parameter is extracted directly from the `423` login response body. It is a plain URL parameter, not a cryptographically signed bearer token tied to a session.

#### Impact

- Any party who intercepts or receives a `423` login response can access and modify the device list for that account
- The token has no observed expiry — a token from a past device-limit event may remain valid
- Combined with VULN-03, this allows complete takeover of account device registration

#### Recommendation

- Require a valid authenticated session cookie alongside the token
- Bind the token to the session that generated the `423` response
- Set a short TTL (e.g., 10 minutes) on these tokens

---

### VULN-06: Time-Limited CDN Tokens Without IP Binding

| Field | Detail |
|---|---|
| **Severity** | Low |
| **CVSS v3.1 Score** | 3.7 (AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **Affected Component** | Akamai CDN — `hdntl` / `hdnea` tokens |
| **CWE** | CWE-284: Improper Access Control |

#### Description

Stream segment URLs returned by the media API embed Akamai CDN authentication tokens with the following structure:

```
hdntl=exp=<unix_timestamp>~acl=<path_pattern>~hmac=<signature>
```

These tokens are **not IP-bound**. Once a valid stream URL is obtained via an authenticated API call, the URL can be shared with any third party and will remain valid until the `exp` timestamp (observed validity: 4–8 hours).

#### Impact

- A user with a valid subscription can share raw stream URLs with non-subscribers during the token validity window
- No session cookie is required to download CDN segments once the URL is known
- The `acl` path restriction limits which content paths the token covers, reducing but not eliminating the risk

#### Recommendation

- Enable Akamai IP-binding (`hdntl` supports `ip=` parameter) for authenticated subscriber streams
- Reduce CDN token TTL (2 hours or less)
- Implement token refresh at the application layer for long-running streams

---

### VULN-07: Geo-Block Bypass via Server-Side Proxy

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 4.3 (AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N) |
| **Affected Component** | `POST /next/api/login`, geo-restriction enforcement |
| **CWE** | CWE-602: Client-Side Enforcement of Server-Side Security |

#### Description

SunNXT enforces geo-restrictions (India-only access for paid content) by checking the **server IP address during session creation**, not per-request. This means:

1. Any user who routes their login request through an Indian-IP proxy or VPN can create a geo-unrestricted session
2. Subsequent requests (including stream URL fetching and DRM license requests) are not individually geo-checked beyond the session flag

**Demonstrated:** Deploying the application on Vercel's Mumbai region (`bom1`) routes all login requests through an Indian IP (`103.21.x.x`), creating sessions that can then stream paid content from any geographic location.

#### Impact

- Users outside India can access India-restricted paid content by routing login through an Indian IP
- No per-request IP validation prevents the session from being used internationally after creation

#### Recommendation

- Validate the requesting IP on every media API call, not only at session creation
- Tie the session's geo-permission to the IP range used at login, with re-validation on significant IP changes
- Consider periodic re-validation (e.g., every 24 hours) during active sessions

---

### VULN-08: DRM License JWT Reuse Window

| Field | Detail |
|---|---|
| **Severity** | Low |
| **CVSS v3.1 Score** | 3.1 (AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N) |
| **Affected Component** | `api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy` |
| **CWE** | CWE-294: Authentication Bypass by Capture-Replay |

#### Description

DRM license acquisition JWTs embedded in the `licenseUrl` field of the media API response were found to have the following properties:

```json
{
  "content_id": "82850",
  "maxUses": 2,
  "device": "web",
  "userId": "2750313",
  "expiryTime": 1779436600,
  "ip_address": "157.51.128.36",
  "video_format": "dash-cenc"
}
```

- `maxUses: 2` allows the JWT to be used twice
- `ip_address` is the **server IP**, not the end-user's IP — meaning the IP binding is ineffective for any client-side bypass
- `expiryTime` corresponds to approximately a 2-hour window

#### Impact

- A JWT extracted from a media API response can be used to request a DRM license from a different client within the `maxUses` limit and validity window
- IP binding is to the server/proxy IP, not the end-user browser, so IP validation provides no protection against client-to-client sharing

#### Recommendation

- Bind the JWT to the end-user client IP, not the server/proxy IP
- Reduce `maxUses` to `1` for high-value content
- Consider hardware-bound DRM (Widevine L1) for premium content rather than L3 (software)

---

### VULN-09: API Returns HTTP 200 for Blocked/Error Content

| Field | Detail |
|---|---|
| **Severity** | Informational |
| **Affected Component** | `GET /next/api/media/{contentId}` |
| **CWE** | CWE-390: Detection of Error Condition Without Action |

#### Description

The SunNXT API returns HTTP `200 OK` for all responses including geo-blocked content, roaming errors, and content unavailability. Error conditions are communicated inside the JSON body:

```json
{
  "code": 200,
  "results": [{
    "blocked_reason": "roaming_expired_30",
    "notify_type": "error_notify",
    "title": "International Roaming Expired"
  }]
}
```

#### Impact

- Client applications must parse the response body to detect errors rather than relying on HTTP status codes
- Increases the risk of client-side error handling bugs where a `200` response is assumed to be successful
- Makes automated monitoring and alerting more complex

#### Recommendation

- Return appropriate HTTP status codes: `403` for geo-block, `401` for auth errors, `404` for unavailable content
- Maintain the JSON body for backward compatibility but align status codes with HTTP semantics

---

### VULN-10: No Rate Limiting on Login API

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1 Score** | 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **Affected Component** | `POST /next/api/login` |
| **CWE** | CWE-307: Improper Restriction of Excessive Authentication Attempts |

#### Description

No rate limiting or account lockout was observed on the login endpoint during testing. Repeated login attempts with different passwords did not trigger any CAPTCHA, lockout, or throttling response.

#### Impact

- The login endpoint is vulnerable to credential stuffing and password spraying attacks
- Combined with VULN-01 (known encryption key), an attacker can craft and submit large numbers of login attempts programmatically
- No alerting mechanism was observed for repeated failed logins

#### Recommendation

- Implement rate limiting: maximum 5 failed login attempts per account per 15-minute window
- Add account lockout with unlock via email/SMS after repeated failures
- Implement CAPTCHA after 3 consecutive failed attempts
- Set up server-side alerting for unusual login volumes from a single IP

---

---

### VULN-11: `modularLicense` Endpoint Has No Subscription Check

| Field | Detail |
|---|---|
| **Severity** | **Critical** |
| **CVSS v3.1 Score** | 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N) |
| **Affected Component** | `POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=` |
| **CWE** | CWE-862: Missing Authorization |

#### Description

The **real SunNXT player** does not use the `licenseUrl` returned by the media API (`https://api.sunnxt.com/licenseproxy/v3/nagravisionDRMProxy/?content_id=X&token=JWT`). Instead it silently overrides it and always calls:

```
POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id={id}
```

This endpoint:
- Requires **no session cookie**
- Requires **no JWT token**
- Requires **no subscription validation**
- Only checks that `Origin: https://www.sunnxt.com` is present in the request header

#### Proof of Concept — Confirmed Live

```bash
# Subscription-locked content (id=251833) — HTTP 200 with DRM license bytes
curl -s -o /tmp/license.bin -w "%{http_code}" \
  -X POST "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=251833" \
  -H "origin: https://www.sunnxt.com" \
  -H "content-type: application/octet-stream" \
  --data-binary @widevine_challenge.bin

# Returns: 200  (705 bytes of Widevine license data)
```

All three tested content IDs — including **subscription-locked content 251833** — returned HTTP `200` with identical `705`-byte Widevine license responses regardless of whether the account is subscribed or not.

#### Evidence from HAR

In `watch-moive.har`, the Shaka player's `requestFilter` was observed overriding every `licenseUrl` with this endpoint before the challenge was sent:

```
HAR entry: POST https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=115249
  request body: 7578 bytes (real Widevine challenge from CDM)
  response status: 200
  response body: valid Widevine license (binary)
  cookies sent: NONE
```

#### Impact

If an attacker has a valid CDN stream URL (MPD manifest path + Akamai token) for any content:

1. Load the MPD through the stream proxy
2. Shaka Player generates a Widevine challenge automatically
3. POST the challenge to `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id={id}`
4. Receive a valid DRM license — **no subscription required**

This completely eliminates the DRM subscription gate **if** the attacker has the CDN stream URL. The only remaining protection is the Akamai `hdnea` token on the MPD manifest (see VULN-12, VULN-13).

#### Recommendation

- **Immediately**: Add subscription validation to `modularLicense`. Check that the requesting user has an active subscription for the requested `content_id`.
- Add JWT authentication (same as `nagravisionDRMProxy`) to `modularLicense`.
- Log all `modularLicense` calls and alert on content_ids without valid subscriptions in the session.
- Consider deprecating `modularLicense` entirely in favor of `nagravisionDRMProxy` which correctly validates subscription.

---

### VULN-12: CDN Video Segments Served Without Authentication

| Field | Detail |
|---|---|
| **Severity** | **High** |
| **CVSS v3.1 Score** | 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **Affected Component** | `movies1-suntvvod.akamaized.net` — all `.m4s` and `.mp4` segment files |
| **CWE** | CWE-284: Improper Access Control |

#### Description

While DASH manifest files (`.mpd`) correctly require a valid Akamai EdgeAuth token (`hdnea` or `hdntl`), all video and audio **segment files** (`.m4s`, init `.mp4`) are served without **any authentication**:

```
GET https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/video/2/seg-1.m4s
→ HTTP 200 (63,517 bytes) — no cookie, no token
```

#### Proof of Concept — Confirmed Live

```bash
# No token, no cookie — returns 200 with content
curl -s -o seg.m4s -w "%{http_code}" \
  "https://movies1-suntvvod.akamaized.net/movies/f38231600b68e429d44dff546f96b29e/115249/hd/video/2/seg-1.m4s"
# Returns: 200  (63517 bytes)

# Confirmed for multiple segments, multiple content IDs, init and audio segments
```

#### CDN URL Structure (Predictable Once UUID Known)

```
https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/{quality}/video/{trackId}/seg-{n}.m4s
https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/{quality}/audio/{lang}/mp4a/{trackId}/seg-{n}.m4s
https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/{quality}/video/{trackId}/init.mp4
```

The `uuid` is a random UUID v4 stored in the SunNXT content database. It is not derivable from the `contentId`. The only legitimate way to obtain it currently is via the subscription-gated media API response (see VULN-13 for an escalation path).

#### Impact

- Once the `uuid` for any content is known (e.g., extracted from a subscribed account's network traffic, or obtained through VULN-13), all segments of that content can be downloaded indefinitely by anyone with no authentication.
- Even after the Akamai `hdnea` token expires (3-hour window), segments remain downloadable.
- Combined with VULN-11 (license bypass), a complete high-quality stream can be obtained and decrypted.

#### Recommendation

- Apply Akamai EdgeAuth token validation to all segment requests, not just manifests.
- Alternatively, sign segment URLs individually so each `.m4s` URL contains a per-segment HMAC.
- Enable Akamai IP-binding on ALL token-protected paths (not just manifests).

---

### VULN-13: `hdntl` Wildcard Token Enables Cross-Content CDN Manifest Access

| Field | Detail |
|---|---|
| **Severity** | **High** |
| **CVSS v3.1 Score** | 7.4 (AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:N) |
| **Affected Component** | Akamai `hdntl` token — issued with every media API response |
| **CWE** | CWE-732: Incorrect Permission Assignment for Critical Resource |

#### Description

The media API response includes **two** Akamai CDN tokens embedded in stream URLs:

| Token | ACL | TTL | Scope |
|---|---|---|---|
| `hdnea` | `!*/115249/*` | 3 hours | Content-specific (only the requested content's path) |
| `hdntl` | `/*` | **24 hours** | **Wildcard — ALL paths on the CDN** |

The `hdntl` token, captured from a legitimate session watching content `115249`:

```
hdntl=exp=1779445939~acl=/*~data=hdntl~hmac=95b1a8770d53920bdd823cec5eabbfec
```

`acl=/*` means this single token is valid for **every content path on `movies1-suntvvod.akamaized.net`**.

#### Attack Chain

This creates a two-step subscription bypass when combined with VULN-11 and VULN-12:

**Step 1 — Get a valid `hdntl` token (requires any logged-in session):**

A logged-in account, even unsubscribed, may receive a `hdntl` token if it can access at least one media API endpoint (e.g., a free/trial content item). Because `hdntl` has `acl=/*`, this single token is valid for ALL content on the CDN for 24 hours.

**Step 2 — Use `hdntl` to fetch MPD for any subscription content:**

```bash
curl "https://movies1-suntvvod.akamaized.net/movies/{uuid}/{contentId}/hd/{contentId}_hd.mpd?hdntl={TOKEN}"
# Returns: 200 with full DASH manifest if token is valid
```

**Step 3 — Download all segments (VULN-12: no auth needed for segments)**

**Step 4 — Get DRM license (VULN-11: no subscription check):**

```bash
curl -X POST "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id={id}" \
  -H "origin: https://www.sunnxt.com" --data-binary @challenge.bin
# Returns: 200 with Widevine license
```

**Remaining obstacle:** The content `uuid` (first path segment in the CDN URL) is only exposed via the subscription-gated media API. It is not in `pwaapi contentDetail`, carousel data, or any other public endpoint. This is currently the only effective gate remaining once a `hdntl` token is obtained.

#### Evidence

From `watch-moive.har` — all segment requests use only `hdntl` (not `hdnea`):

```
https://movies1-suntvvod.akamaized.net/movies/f38231600b68e429d44dff546f96b29e/115249/hd/video/6/seg-1.m4s?hdntl=...
```

The `hdntl` token is shared across ALL segments of ALL quality variants of ALL content in a session.

#### Recommendation

- **Replace wildcard `hdntl` tokens** with per-content ACL tokens scoped to `!*/{contentId}/*` (same as `hdnea`).
- If `hdntl` must remain wildcard, reduce its TTL to match `hdnea` (3 hours, not 24).
- The 24-hour wildcard token combined with publicly accessible segments (VULN-12) creates a large exposure window.

---

## 6. DRM Architecture Analysis

### 6.1 DRM Systems in Use

SunNXT uses a **multi-DRM** architecture via **Nagravision** (Kudelski Group) as the license proxy:

| DRM System | Stream Format | CDN | Browser Support |
|---|---|---|---|
| PlayReady | `dash-cenc` | suntvvod1.sunnxt.com | Edge, IE (Windows only) |
| Widevine | `dash` (CENC) | Akamai (`movies1-suntvvod.akamaized.net`) | Chrome, Firefox, Android |
| FairPlay | `hls-fp-aapl` | suntvvod1.sunnxt.com | Safari (Apple only) |
| Widevine Classic | `wvm` | Akamai | Legacy Android (deprecated) |
| AES-128 | `hlsaes` | suntvvod1.sunnxt.com | All (no CDM required) |

### 6.2 License Acquisition Flow

```
Browser → Shaka Player generates Widevine challenge
       → POST /api/license?url=<nagravision_proxy_url>
       → Next.js license proxy → POST to Nagravision with JWT + session cookie
       → Nagravision validates JWT (content_id, userId, ip, expiryTime)
       → Returns encrypted DRM license
       → Shaka decrypts content with license keys
```

### 6.3 DRM Security Assessment

- **Widevine L3** (software CDM) is used in browser environments. L3 provides basic content protection but keys can theoretically be extracted by sophisticated attackers with full system access.
- **No clear/unencrypted streams** were found for premium content. All `format=dash` Akamai streams confirmed CENC-encrypted with Widevine PSSH.
- **License URL JWT is IP-bound to the server proxy IP** (see VULN-08), not the end-user browser, reducing the effectiveness of IP binding.
- **FairPlay** (Safari) is correctly implemented with separate license acquisition.

### 6.4 Stream Format Enumeration (Content ID: 82850)

The following 14 stream entries were found in a media API response for a sample premium movie:

| # | Format | CDN | Quality | HTTP Status (no session) | DRM |
|---|---|---|---|---|---|
| 1 | `dash-cenc` | suntvvod1.sunnxt.com | HD | 200 | PlayReady |
| 2 | `hls-fp-aapl` | suntvvod1.sunnxt.com | HD | 200 | FairPlay |
| 3 | `wvm` | Akamai | 1080p | 200 | Widevine Classic |
| 4 | `wvm` | Akamai | 720p | 200 | Widevine Classic |
| 5 | `wvm` | Akamai | 480p | 200 | Widevine Classic |
| 6 | `wvm` | Akamai | 360p | 200 | Widevine Classic |
| 7 | `hlsaes` | suntvvod1.sunnxt.com | Low | 403 | AES-128 |
| 8–14 | `dash` | Akamai | HD/SD variants | 200 | Widevine CENC |

**Note:** CDN segments return HTTP 200 without a session cookie once the CDN token URL is known. However, all premium content segments are encrypted — playback is not possible without a valid DRM license from Nagravision.

---

## 7. Stream Format Enumeration

### 7.1 API Endpoints Tested

| Endpoint | Auth Required | Notes |
|---|---|---|
| `GET /next/api/media/{contentId}` | Yes (session cookie) | Returns stream URLs + DRM license URL |
| `GET /pwaapi.sunnxt.com/api/v2/contents/{id}` | No | Metadata only, no stream URLs |
| `GET /next/api/logout` | Yes | Invalidates session |
| `POST /next/api/login` | No | Returns encrypted response |
| `GET /user/v4/removeDevice/` | URL token only | Device removal (see VULN-03/05) |
| `GET /licenseproxy/v3/nagravisionDRMProxy/` | JWT in URL + session | DRM license acquisition |

### 7.2 Browse API — No Authentication Required

The browse/catalogue API (`pwaapi.sunnxt.com`) works without authentication:
- Homepage carousel
- Trending content
- Live TV channel list
- Content search
- Content detail metadata (title, description, cast, images)

Stream URLs and DRM licenses are strictly gated behind authentication. No bypass of stream access was found.

---

## 8. Remediation Summary

| ID | Recommendation | Priority | Effort |
|---|---|---|---|
| VULN-11 | Add subscription check to `modularLicense` endpoint | **Critical** | Low |
| VULN-12 | Apply Akamai EdgeAuth to segment files, not just manifests | **High** | Medium |
| VULN-13 | Replace wildcard `hdntl` (`acl=/*`) with per-content ACL | **High** | Low |
| VULN-01 | Replace static AES key with server-issued per-session key | High | High |
| VULN-02 | Use random IV per encryption operation | High | Low |
| VULN-03 | Add session auth + CSRF to ManageDevices | Medium | Medium |
| VULN-04 | Enforce server-side session TTL (24h inactivity) | Medium | Low |
| VULN-05 | Bind ManageDevices token to session | Medium | Low |
| VULN-06 | Enable Akamai IP-binding on CDN tokens | Low | Low |
| VULN-07 | Add per-request geo-validation on media API | Medium | Medium |
| VULN-08 | Bind DRM JWT to end-user IP; reduce maxUses to 1 | Low | Medium |
| VULN-09 | Return correct HTTP status codes for error states | Info | Low |
| VULN-10 | Add rate limiting and lockout to login endpoint | Medium | Medium |

---

## 9. Conclusion

This assessment reveals that the SunNXT platform has a **near-complete subscription bypass chain** made possible by three independent vulnerabilities (VULN-11, VULN-12, VULN-13) that, when chained together, allow a logged-in unsubscribed user to watch any DRM-protected premium content.

### The Bypass Chain

```
[Unsubscribed logged-in account]
         │
         ├─► GET any free content via media API
         │   → receives hdntl token (acl=/*, 24h TTL)           [VULN-13]
         │
         ├─► Use hdntl to GET {uuid}/{contentId}_hd.mpd
         │   → MPD manifest with segment structure (if uuid known)  [VULN-13]
         │
         ├─► Download all .m4s segments directly from CDN
         │   → HTTP 200, no auth required                       [VULN-12]
         │
         └─► POST Widevine challenge to modularLicense
             → HTTP 200 with valid DRM license keys             [VULN-11]
             → Full HD playback without subscription ✓
```

**The one remaining gate** is the content `uuid` (a random UUID v4 stored in the SunNXT database, not publicly exposed outside the subscription-gated media API). Obtaining this uuid requires either:
- A subscribed account (legitimate path)
- Network traffic capture from a subscribed user
- A future API endpoint that leaks it

### Critical Fix Required

The three new vulnerabilities (VULN-11, VULN-12, VULN-13) each independently contribute to the bypass:

- **VULN-11 alone** breaks the DRM subscription gate entirely (no subscription check on licenses).
- **VULN-12 alone** means any attacker with a valid CDN URL can download all segments forever.
- **VULN-13 alone** means any logged-in user can access ANY content's manifest for 24 hours.

Fixing VULN-11 is the highest-priority, lowest-effort fix — a single server-side subscription check in the `modularLicense` handler closes the entire bypass chain.

The pre-existing findings (VULN-01 through VULN-10) compound these risks but are secondary to the DRM bypass chain described above.

---

**Prepared by:** Nitheesh D R
**Date:** May 22, 2026
**Contact:** For questions regarding this report, contact the tester directly.

---

*This report is confidential and intended solely for the SunNXT security team. Findings should not be shared publicly until remediation is complete.*
