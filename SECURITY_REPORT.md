# Security Assessment Report
## SunNXT OTT Platform — Web Application, API & CDN Infrastructure

---

| Field | Details |
|---|---|
| **Report Title** | SunNXT Web Platform Security Assessment |
| **Prepared By** | Nitheesh D R |
| **Assessment Type** | Black-Box Web Application, API & CDN Security Testing |
| **Scope** | sunnxt.com — Web App, REST APIs, CDN, DRM Infrastructure |
| **Test Period** | May 2026 |
| **Report Date** | May 23, 2026 |
| **Report Version** | 2.3 — Updated with FairPlay DRM support, live channel DRM fix, download feature, and server-side ffmpeg merge |
| **Classification** | Confidential — For SunNXT Security Team Only |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [Risk Rating Definitions](#3-risk-rating-definitions)
4. [Findings Summary](#4-findings-summary)
5. [Detailed Findings](#5-detailed-findings)
6. [Attack Chains](#6-attack-chains)
7. [DRM Architecture Analysis](#7-drm-architecture-analysis)
8. [CDN Architecture Analysis](#8-cdn-architecture-analysis)
9. [Stream Format Enumeration](#9-stream-format-enumeration)
10. [Remediation Summary](#10-remediation-summary)
11. [Conclusion](#11-conclusion)

---

## 1. Executive Summary

This report presents the findings of a black-box security assessment conducted against the SunNXT web platform (`www.sunnxt.com`), its backend REST APIs, CDN infrastructure, and DRM subsystem.

The assessment was performed through analysis of client-side JavaScript, network traffic interception (HAR files), API endpoint testing, CDN token analysis, and DRM architecture review.

**20 vulnerabilities** were identified across the platform:

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 8 |
| Low | 3 |
| Informational | 3 |

### Most Critical Findings

**VULN-11 (Critical):** The DRM license endpoint `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` issues valid Widevine decryption keys without authenticating the requester or verifying subscription status. Any person who can present a valid Widevine license challenge can obtain decryption keys for premium content.

**VULN-16 (Critical):** The stream proxy and download endpoints attach the server's subscribed session credentials to all requests, including those from completely unauthenticated browser users. This effectively makes the server a shared premium subscription proxy for anyone who accesses it.

**VULN-06 (High):** The Akamai `hdntl` CDN token uses a wildcard `acl=/*` scope, granting access to ALL CDN content with a single token. This token is valid for 24 hours, is not IP-bound, and does not validate subscription status.

**VULN-01 (High):** SunNXT's AES-128 encryption key (`A3s68aORSgHs$71P`) is hardcoded in the client-side JavaScript bundle delivered to every browser. The "encryption" of login credentials and API responses provides no security.

---

## 2. Scope & Methodology

### 2.1 Scope

| Asset | In Scope |
|---|---|
| `www.sunnxt.com` — Web Application | Yes |
| `www.sunnxt.com/next/api/*` — REST API | Yes |
| `pwaapi.sunnxt.com/*` — PWA REST API | Yes |
| `pwaapi.sunnxt.com/licenseproxy/*` — DRM License Proxy | Yes |
| `suntvvod1.sunnxt.com` — VOD CDN | Yes |
| `*.akamaized.net` (SunNXT VOD) — Akamai CDN | Yes |
| `livestream4.sunnxt.com` — Live TV CDN | Yes |
| Mobile apps (iOS / Android) | No |
| SunNXT backend infrastructure / servers | No |

### 2.2 Methodology

Testing followed the **OWASP Web Security Testing Guide (WSTG v4.2)** and **OWASP Top 10 2021** framework:

- **Information Gathering** — JavaScript source analysis, API endpoint discovery, HAR file analysis
- **Authentication Testing** — Login flow, session management, credential encryption
- **Authorization Testing** — Device limits, content access control, CDN bypass
- **Cryptography Review** — AES key/IV analysis, DRM token inspection
- **API Security** — Parameter tampering, unauthenticated endpoint testing
- **DRM Architecture Review** — License acquisition flow, PSSH analysis, Widevine EME testing
- **CDN Token Analysis** — Akamai hdntl/hdnea token scope, TTL, and IP binding

### 2.3 Tools Used

| Tool | Purpose |
|---|---|
| Chrome DevTools | Network traffic capture, JavaScript source review |
| HAR File Analysis | CDN URL extraction, token discovery |
| CryptoJS | AES-128-CBC decryption of API responses |
| Shaka Player 5.x | Stream playback, DRM license flow testing |
| Next.js custom proxy | CORS bypass, stream rewriting, session testing |
| curl + xxd | License endpoint binary response analysis |
| jwt.io | DRM JWT structure analysis |

---

## 3. Risk Rating Definitions

| Severity | CVSS Range | Description |
|---|---|---|
| **Critical** | 9.0 – 10.0 | Immediate exploitation; severe business and user impact |
| **High** | 7.0 – 8.9 | Exploitation likely; significant impact |
| **Medium** | 4.0 – 6.9 | Exploitation possible under specific conditions |
| **Low** | 0.1 – 3.9 | Limited impact; defense-in-depth weakness |
| **Informational** | N/A | No direct security impact; best-practice recommendation |

---

## 4. Findings Summary

| ID | Title | Severity | CVSS |
|---|---|---|---|
| VULN-01 | Static AES Key in Client JavaScript | **High** | 7.5 |
| VULN-02 | Static All-Zero IV in AES-CBC | **Medium** | 5.3 |
| VULN-03 | Device Registration Limit Bypass | **Medium** | 5.4 |
| VULN-04 | Long-Lived Session Cookies Without Expiry | **Medium** | 5.4 |
| VULN-05 | ManageDevices Endpoint Missing Access Control | **Medium** | 6.5 |
| VULN-06 | hdntl Wildcard CDN Token (`acl=/*`) | **High** | 7.5 |
| VULN-07 | Geo-Block Bypass via Server-Side IP | **Medium** | 5.4 |
| VULN-08 | DRM JWT Reuse Window (`maxUses: 2`) | **Low** | 3.7 |
| VULN-09 | HTTP 200 Returned for Error/Blocked States | **Low** | 3.1 |
| VULN-10 | No Rate Limiting on Login API | **Medium** | 7.5 |
| VULN-11 | `modularLicense` No Auth or Subscription Check | **Critical** | 9.1 |
| VULN-12 | Permanent Content UUIDs — CDN Paths Never Rotate | **High** | 7.4 |
| VULN-13 | PSSH Box in `init.mp4` DRM Trigger Not Validated | **Medium** | 5.9 |
| VULN-14 | Unauthenticated `clear-session` Endpoint | **Medium** | 5.3 |
| VULN-15 | Phone Number Enumeration via Status Endpoint | **Medium** | 5.3 |
| VULN-16 | Server Subscription Session Proxied to All Users | **Critical** | 9.3 |
| VULN-17 | Heartbeat Parameter Injection | **Low** | 3.1 |
| VULN-18 | AES Key Present in 4 Source Files | **Informational** | 2.0 |
| VULN-19 | MPD BaseURL Injection via Regex | **Informational** | 2.0 |
| VULN-20 | Permanent UUIDs + No CDN Token Rotation | **High** | 8.2 |

---

## 5. Detailed Findings

---

### VULN-01: Static AES Encryption Key in Client JavaScript

| Field | Detail |
|---|---|
| **Severity** | High |
| **CVSS v3.1** | 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-321: Use of Hard-coded Cryptographic Key |
| **Affected Component** | `www.sunnxt.com` JavaScript bundle |

#### Description

SunNXT encrypts login payloads and API responses using AES-128-CBC. The encryption key is a plaintext string hardcoded in the client-side JavaScript bundle delivered to every browser:

```
Key: A3s68aORSgHs$71P
IV:  00000000000000000000000000000000 (all zero)
Mode: AES-128-CBC
```

Any person with basic web development knowledge can extract this key from Chrome DevTools (Sources → Search for `A3s6`) in under 30 seconds.

#### Impact

- All API responses can be decrypted by anyone
- Login credentials "encrypted" with this key provide no confidentiality
- Enables all other bypass mechanisms that rely on reading API responses

#### Proof of Concept

```javascript
// Run in browser console after loading SunNXT:
const key = "A3s68aORSgHs$71P";  // found in JS bundle
const iv = CryptoJS.enc.Hex.parse("0".repeat(32));
const dec = CryptoJS.AES.decrypt(encryptedApiResponse, 
  CryptoJS.enc.Utf8.parse(key), { iv, mode: CryptoJS.mode.CBC });
console.log(dec.toString(CryptoJS.enc.Utf8));  // → plaintext JSON
```

#### Remediation

Move all API decryption server-side. For client-initiated encrypted communication, use ECDH key exchange to derive session-unique keys. Never ship a symmetric key in client JavaScript.

---

### VULN-02: Static All-Zero IV in AES-CBC

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **CWE** | CWE-329: Not Using an Unpredictable IV with CBC Mode |
| **Affected Component** | AES-CBC encryption across all API responses |

#### Description

The IV used in AES-CBC encryption is a 128-bit all-zero value. In CBC mode, a fixed IV means that two messages sharing the same plaintext prefix will also share the same ciphertext prefix. This leaks structural information about the plaintext.

#### Impact

Pattern analysis of encrypted traffic becomes trivial. Weakens an already-compromised encryption scheme. Violates cryptographic best practice.

#### Remediation

Generate a cryptographically random 16-byte IV per encryption operation. Prepend the IV to the ciphertext and parse it on decryption. Cost: minimal. Benefit: eliminates known-plaintext pattern leakage.

---

### VULN-03: Device Registration Limit Bypass

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.4 (AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N) |
| **CWE** | CWE-284: Improper Access Control |
| **Affected Component** | Session management, device registration |

#### Description

SunNXT enforces a per-account concurrent device limit. When the limit is reached, new logins prompt device deregistration. This limit can be bypassed:
1. Clear the server-side session cache (3 unauthenticated HTTP requests)
2. Force a fresh login — creates a new device slot
3. Repeat to register more devices than the limit allows

Old device entries are eventually pruned, allowing indefinite cycling.

#### Impact

Unlimited concurrent devices per account. Account credentials can be shared with many users without triggering the device limit enforcement.

#### Remediation

Enforce device limits at the session token level, not just registration count. Track active tokens server-side and revoke oldest on limit breach. Rate-limit new session creation per account (max 2/day).

---

### VULN-04: Long-Lived Session Cookies Without Expiry

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.4 (AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-613: Insufficient Session Expiration |
| **Affected Component** | `sessionid` cookie |

#### Description

The `sessionid` cookie has no `Expires` attribute, making it a session cookie by specification. However, SunNXT's server-side sessions persist for weeks to months without invalidation. In testing, sessions remained valid across browser restarts and days of inactivity.

#### Impact

A stolen session cookie provides access for an extended period. Standard 30-day automatic rotation is absent. No server-side session expiry enforcement was observed.

#### Remediation

Set `Expires` to a maximum of 30 days. Implement absolute session expiry server-side (independent of client cookie). Invalidate sessions on password change. Rotate session IDs on privilege changes.

---

### VULN-05: ManageDevices Endpoint Missing Access Control

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 6.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N) |
| **CWE** | CWE-639: Authorization Bypass Through User-Controlled Key |
| **Affected Component** | Device management API |

#### Description

The device management endpoint accepts a device ID as a parameter to deregister a device. The endpoint does not verify that the authenticated user owns the specified device ID. Any valid session can deregister any device by guessing or enumerating device IDs.

#### Impact

An attacker with a valid session can force other users' sessions to expire by deregistering their devices, effectively locking them out.

#### Remediation

Server-side ownership check: `WHERE device_id = ? AND user_id = authenticated_user_id`. Return 404 (not 403) for devices belonging to other users to prevent enumeration.

---

### VULN-06: hdntl Wildcard CDN Token (`acl=/*`)

| Field | Detail |
|---|---|
| **Severity** | High |
| **CVSS v3.1** | 7.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-284: Improper Access Control |
| **Affected Component** | Akamai CDN token system |

#### Description

SunNXT's Akamai CDN uses two token types: `hdnea` (per-content, 3h TTL) and `hdntl` (wildcard, 24h TTL). The `hdntl` token has `acl=/*` — a wildcard path that authorizes access to ALL content on the CDN with a single token.

Critically, `hdntl` does not validate subscription status. It only validates the HMAC signature and expiry. This means a token obtained from watching one piece of free content grants CDN access to all premium content for 24 hours.

**Token format:**
```
hdntl=exp=<unix_timestamp>~acl=/*~data=hdntl~hmac=<sha256>
```

The `acl=/*` is permanent in the token design — it is not per-session or per-user.

#### Impact

Any logged-in user (even on the free tier) who watches any content receives an hdntl token valid for all CDN content. CDN access is completely decoupled from subscription enforcement.

#### Remediation

Change `acl=/*` to content-specific paths: `acl=!*/<content-UUID>/*~`. Generate per-session, per-content CDN tokens. Consider Akamai Media Delivery Rules to validate subscription at the CDN edge.

---

### VULN-07: Geo-Block Bypass via Server-Side Proxy IP

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.4 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **CWE** | CWE-284: Improper Access Control |
| **Affected Component** | Geo-restriction enforcement |

#### Description

SunNXT's geo-restrictions check the IP address of the HTTP request. Since all requests are proxied through a Vercel server deployed in Mumbai (`bom1` region), the geo-check always sees an Indian IP, regardless of the actual user's location.

This allows users in any country to access SunNXT content that may be restricted in their region due to licensing agreements.

#### Impact

Regional licensing agreements may be violated. Content geo-restrictions are ineffective for any service running a server-side proxy in an unrestricted region.

#### Remediation

Enforce geo-restrictions at the CDN level using Akamai's built-in geo-filtering (EdgeLogic). CDN-level enforcement cannot be bypassed by server-side proxying. Supplement with user IP validation in the API if CDN-level enforcement is not feasible.

---

### VULN-08: DRM JWT Reuse Window (`maxUses: 2`)

| Field | Detail |
|---|---|
| **Severity** | Low |
| **CVSS v3.1** | 3.7 (AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **CWE** | CWE-294: Authentication Bypass by Capture-replay |
| **Affected Component** | Nagravision DRM JWT (`nagravisionDRMProxy`) |

#### Description

The Nagravision DRM JWT contains `maxUses: 2` — allowing each JWT to be used twice before invalidation. An intercepted JWT can be replayed once.

#### Impact

Limited. Requires JWT interception (MitM or shared proxy environment). Provides one additional DRM license issuance for the same content.

#### Remediation

Set `maxUses: 1`. Bind JWTs to the requesting session ID. Log and alert on double-use attempts.

---

### VULN-09: HTTP 200 Returned for Error and Blocked States

| Field | Detail |
|---|---|
| **Severity** | Low |
| **CVSS v3.1** | 3.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N) |
| **CWE** | CWE-392: Missing Report of Error Condition |
| **Affected Component** | Media API response status codes |

#### Description

The media API returns HTTP 200 for all states including:
- Subscription required
- Geo-blocked content
- Content not available
- Invalid content ID

The actual error state is encoded in the JSON body (`code`, `notify_type`, `blocked_reason`). Standard HTTP monitoring tools cannot detect these errors without parsing response bodies.

#### Impact

Breaks external monitoring and SIEM integrations. Log analysis tools miss subscription errors and geo-blocks. Makes automated testing unreliable.

#### Remediation

Return appropriate HTTP status codes: 402 (subscription required), 451 (geo-blocked), 404 (not found), 403 (forbidden). Keep error details in the response body.

---

### VULN-10: No Rate Limiting on Login API

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-307: Improper Restriction of Excessive Authentication Attempts |
| **Affected Component** | `/accounts/v3/login` |

#### Description

The login endpoint accepts unlimited password attempts with no rate limiting, CAPTCHA, lockout, or delay. An attacker can attempt thousands of password combinations per minute against any account.

Testing confirmed that 100 consecutive failed login attempts were accepted without any throttling.

#### Impact

Credential stuffing attacks are highly effective: a list of leaked email/phone → password pairs can be tested against SunNXT at scale. Brute-force attacks against known accounts are feasible.

SunNXT has a large subscriber base, making this a high-value target for account takeover.

#### Remediation

Implement rate limiting: 10 attempts per 15 minutes per IP address, per phone number, and per account. Add exponential backoff after 5 failures. Require CAPTCHA after repeated failures. Alert on accounts with >20 failed attempts per hour.

---

### VULN-11: `modularLicense` Endpoint Has No Authentication or Subscription Check

| Field | Detail |
|---|---|
| **Severity** | Critical |
| **CVSS v3.1** | 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-306: Missing Authentication for Critical Function |
| **Affected Component** | `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` |

#### Description

The DRM license endpoint issues valid Widevine decryption keys without:
1. Verifying the requester is authenticated (no session token check)
2. Checking whether the user has an active subscription
3. Validating that the `content_id` matches the license challenge

Any person who can present a syntactically valid Widevine license challenge for any `content_id` receives a valid license response in return.

#### Proof of Concept

```bash
# No authentication headers required:
curl -s \
  "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @widevine_challenge.bin \
  > license_response.bin

xxd license_response.bin | head -3
# 00000000: 1267 0861 1273 0a08 ...
# First byte 0x12 (protobuf) — valid Widevine binary license
# NOT 0x7B (JSON error) — license was issued successfully
```

The license challenge (`widevine_challenge.bin`) is generated by any CDM-capable browser when it encounters a CENC stream.

#### Impact

Combined with VULN-06 (wildcard hdntl CDN token) and VULN-20 (permanent content UUIDs):

1. Get any CDN URL (free content, leaked URL, VULN-20 known UUID)
2. Request hdntl token from free content playback (VULN-06)
3. Load CENC stream directly from CDN (no subscription check at CDN)
4. Browser's CDM generates a Widevine license challenge
5. Submit challenge to `modularLicense` without auth
6. Receive valid decryption key
7. Stream decrypts — premium content plays

**This constitutes a complete end-to-end bypass of the subscription paywall.**

#### Remediation

**Immediate (same day):**
- Require Bearer token authentication on `modularLicense`
- Validate subscription status before issuing any key

**Short-term:**
- Bind license requests to the authenticated session ID
- Log all license issuances with user context
- Rate-limit license requests per user (max 3/minute)

---

### VULN-12: Permanent Content UUIDs — CDN Paths Never Rotate

| Field | Detail |
|---|---|
| **Severity** | High |
| **CVSS v3.1** | 7.4 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-330: Use of Insufficiently Random Values |
| **Affected Component** | CDN URL structure |

#### Description

Each piece of content on SunNXT's CDN has a fixed UUID that maps permanently to its storage path:

```
https://movies1-suntvvod1.akamaized.net/movies1/<UUID>/auto/index.mpd
```

This UUID:
- Never changes (observed across multiple sessions over weeks)
- Cannot be invalidated without moving the physical files on the CDN
- Once known, provides a permanent CDN path for that content

CDN paths discovered during any session (via API response analysis or HAR capture) remain valid indefinitely.

#### Impact

A UUID database (partial example below) provides permanent CDN access once a valid hdntl token is available:

| Content ID | UUID | CDN Host |
|---|---|---|
| 82850 | 2a0b194b81d4071cf41ccfeb69d690e2 | movies1 |
| 115249 | f38231600b68e429d44dff546f96b29e | movies1 |
| 251833 | 5bfb2a0404ec10ba52cb2d072c64cbf4 | movies2 |

#### Remediation

Implement periodic CDN path rotation (monthly). Include a time-based component in content paths. Supplement with Akamai signed URLs that expire per-session. Accept that full rotation requires CDN content migration — plan accordingly.

---

### VULN-13: PSSH Box in `init.mp4` Activates DRM Without MPD Validation

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.9 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **CWE** | CWE-347: Improper Verification of Cryptographic Signature |
| **Affected Component** | `init.mp4` PSSH box, DRM bootstrap |

#### Description

SunNXT's CENC streams embed a PSSH (Protection System Specific Header) box directly in `init.mp4`. When a Widevine-capable browser encounters this, it automatically fires a license request via the EME API — even if the MPD manifest has no `<ContentProtection>` element.

This means:
- Removing `<ContentProtection>` from the MPD (e.g., via a rewriting proxy) does not suppress the DRM challenge
- The browser independently detects DRM from the init segment
- The license request is fired automatically and silently

#### Impact

The init.mp4 PSSH independently triggers `modularLicense` (VULN-11) via the browser's EME API. Even a minimally modified MPD (stripped ContentProtection) still results in a license request — and that request succeeds without auth (VULN-11).

This means VULN-13 + VULN-11 = DRM license obtained regardless of MPD manipulation.

#### Remediation

This is partially defense-in-depth: PSSH in init.mp4 is standard DRM practice. The actual fix is VULN-11 — if the license endpoint validates auth, the automatic challenge will fail, protecting the content.

---

### VULN-14: Unauthenticated `clear-session` Endpoint

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L) |
| **CWE** | CWE-306: Missing Authentication for Critical Function |
| **Affected Component** | `GET /api/auth/clear-session` |

#### Description

The endpoint `/api/auth/clear-session` triggers `forceRelogin()` on the server — clearing the cached session and forcing a fresh authentication with SunNXT using the `.env.local` credentials. This endpoint requires no authentication.

```typescript
// app/api/auth/clear-session/route.ts
export async function GET() {
  await forceRelogin();  // No auth check before this
  return NextResponse.json({ ok: true });
}
```

#### Proof of Concept

```bash
# Zero authentication required:
curl -s "https://your-clone.vercel.app/api/auth/clear-session"
# → {"ok":true}
# Server immediately re-authenticates with SunNXT
```

#### Impact

An automated script can repeatedly trigger this endpoint to:
- Consume SunNXT's login API quota for the server's account
- Generate excessive login events (potential account flag/lock)
- Disrupt streaming for all current users (session clears mid-stream)

#### Remediation

Add an authentication check: require an `Authorization: Bearer <admin-token>` header matching a secret from environment variables. Alternatively, restrict to internal/localhost requests only.

---

### VULN-15: Phone Number Enumeration via Status Endpoint

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **CVSS v3.1** | 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **CWE** | CWE-200: Exposure of Sensitive Information to an Unauthorized Actor |
| **Affected Component** | `GET /api/auth/status?mobile=<phone>` |

#### Description

The endpoint `/api/auth/status` accepts any phone number as a query parameter and returns detailed account information without requiring authentication:

```json
{
  "user_available": true,
  "subscription_status": "active",
  "password_available": true
}
```

This discloses whether the phone number has a SunNXT account, whether it has an active paid subscription, and whether a password (vs. OTP-only) is configured.

#### Proof of Concept

```bash
# No auth required:
curl "https://your-clone.vercel.app/api/auth/status?mobile=9876543210"
# → {"user_available":true,"subscription_status":"active","password_available":true}
```

#### Impact

Enables mass enumeration of SunNXT's subscriber database. Active subscribers (`subscription_status: active`) can be identified for:
- Targeted phishing (high-value accounts)
- Credential stuffing campaign targeting (confirmed existing accounts)
- Competitive intelligence (subscriber count estimation)

#### Remediation

Require authentication before returning account status. Return only a boolean "account exists" — never disclose subscription status or authentication method to unauthenticated callers. Add rate limiting (5 requests per minute per IP).

---

### VULN-16: Server Subscription Session Proxied to All Unauthenticated Users

| Field | Detail |
|---|---|
| **Severity** | Critical |
| **CVSS v3.1** | 9.3 (AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N) |
| **CWE** | CWE-284: Improper Access Control |
| **Affected Component** | `/api/stream-proxy`, `/api/download` |

#### Description

The stream proxy and download endpoints attach the server's `.env.local` subscribed session credentials to outgoing requests — regardless of whether the browser user is authenticated:

```typescript
// app/api/stream-proxy/route.ts (simplified)
export async function GET(request: NextRequest) {
  // No browser session check here
  const serverCookie = await getSunnxtCookies();  // server's subscription
  const response = await fetch(targetUrl, {
    headers: { cookie: serverCookie }  // attached to all requests
  });
  return response;
}
```

This means any internet user who knows the clone's URL can access CDN content authenticated with the server's paid subscription, without any login.

#### Proof of Concept

```bash
# Zero browser login required:
curl -s "https://your-clone.vercel.app/api/stream-proxy?url=<cdn-mpd-url>"
# Returns: DASH manifest authenticated with server's subscription credentials
```

#### Impact

The server's paid subscription becomes a shared gateway for unlimited unauthenticated users. This is the most operationally impactful vulnerability in the application:
- Any user accessing the clone gets premium CDN content for free
- The server's subscription account bears all usage charges
- SunNXT's subscription revenue is directly undermined

#### Remediation

**Immediate:** Add browser session verification before proxying:
```typescript
const browserCookie = request.headers.get("cookie") || "";
if (!browserCookie.includes("sessionid")) {
  return NextResponse.json({ error: "login_required" }, { status: 401 });
}
```

The proxy should use the browser user's own session, not the server's.

---

### VULN-17: Heartbeat Parameter Injection

| Field | Detail |
|---|---|
| **Severity** | Low |
| **CVSS v3.1** | 3.1 (AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N) |
| **CWE** | CWE-20: Improper Input Validation |
| **Affected Component** | `POST /api/heartbeat` |

#### Description

The heartbeat endpoint passes `contentId` and `action` query parameters to pwaapi without validation:

```typescript
// app/api/heartbeat/route.ts
const { contentId, action } = Object.fromEntries(url.searchParams);
// No validation of contentId or action
await fetch(`https://pwaapi.sunnxt.com/heartbeat?content_id=${contentId}&action=${action}`, ...);
```

A logged-in user can send heartbeat events for arbitrary content IDs not currently being watched, and with arbitrary action strings.

#### Impact

Watch history can be polluted with fake view events for any content. View count analytics can be inflated for specific titles. Low practical impact but violates data integrity.

#### Remediation

Validate `action` against `["Start", "Stop"]`. Consider validating that `contentId` is active in the user's current session. Rate-limit heartbeat calls to reasonable intervals (max 1 per 25 seconds per session).

---

### VULN-18: AES Key Present in 4 Source Files

| Field | Detail |
|---|---|
| **Severity** | Informational |
| **CVSS v3.1** | 2.0 |
| **CWE** | CWE-259: Use of Hard-coded Password |
| **Affected Component** | Multiple source files in the research repository |

#### Description

The AES key `A3s68aORSgHs$71P` (discovered from SunNXT's JS bundle) appears in 4 separate source files in this research project. While this is a research artifact demonstrating the key's discoverability, it illustrates how secrets proliferate when not stored in environment variables.

**Files containing the key:**
1. `lib/sunnxt-session.ts`
2. `app/api/media/[contentId]/route.ts`
3. `app/api/auth/login/route.ts`
4. `security-tests/decrypt-test.js`

#### Remediation

Extract to `SUNNXT_MEDIA_KEY` environment variable. Reference `process.env.SUNNXT_MEDIA_KEY` in all locations. Add the key to `.env.local.example` as a placeholder.

---

### VULN-19: MPD BaseURL Injection via String Regex

| Field | Detail |
|---|---|
| **Severity** | Informational |
| **CVSS v3.1** | 2.0 |
| **CWE** | CWE-116: Improper Encoding |
| **Affected Component** | Stream proxy MPD rewriting |

#### Description

The stream proxy injects `<BaseURL>` and `<dashif:Laurl>` tags into MPD XML using regex string replacement rather than an XML parser. Malformed MPD content matching the regex could produce invalid XML output.

#### Impact

Negligible — the MPD comes from Akamai CDN servers which SunNXT controls. An attacker would need to control CDN content to exploit this.

#### Remediation

Use a proper XML parser (e.g., `fast-xml-parser`) for MPD manipulation. Validate the output XML structure before returning. This eliminates any theoretical injection risk.

---

### VULN-20: Permanent UUIDs + No CDN Token Rotation = Permanent Content Access

| Field | Detail |
|---|---|
| **Severity** | High |
| **CVSS v3.1** | 8.2 (AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N) |
| **CWE** | CWE-284: Improper Access Control |
| **Affected Component** | CDN architecture (combined VULN-06 + VULN-12) |

#### Description

The combination of permanent content UUIDs (VULN-12) and wildcard hdntl tokens (VULN-06) with an auto-refresh mechanism creates a **permanent access path**:

1. **UUID never rotates** → CDN path is permanent, always valid
2. **hdntl `acl=/*`** → one token covers all content on the CDN
3. **hdntl self-refreshes** → when any content is played, the stream proxy extracts the new hdntl token from the MPD's segment templates, caches it to disk, and uses it for all future requests. The 24h token auto-renews with each playback session.
4. **No subscription check at CDN** → CDN tokens are not subscription-aware

**The result:**

A user who had a subscription (or borrowed one temporarily) can:
- Extract one hdntl token (`acl=/*`) during that session
- Discover content UUIDs from API responses
- Continue accessing ALL CDN content indefinitely after the subscription expires, by refreshing the hdntl token through any subsequent playback (even of free content)

This is not a theoretical vulnerability — it was demonstrated in this research after the test subscription expired. The system continued to serve premium CDN content.

#### Remediation

**Required in combination:**
1. **Scope hdntl tokens per-content** — change CDN configuration to `acl=!*/<UUID>/*~` (VULN-06 fix)
2. **Rotate CDN paths periodically** — monthly UUID rotation (VULN-12 fix)
3. **Add subscription validation at CDN edge** — Akamai EdgeLogic subscription check
4. **Fix VULN-11** — without DRM key access, CENC streams remain encrypted even if CDN access exists

Of these, fixing VULN-11 has the highest return: even with CDN access, CENC content cannot be decrypted without a valid license. VULN-11 fix alone prevents the complete bypass.

---

## 6. Attack Chains

### Chain A: Full Premium Content Bypass (No Subscription)

**Prerequisites:** Valid SunNXT account (free tier)  
**Complexity:** Medium  
**Vulnerabilities:** VULN-06 + VULN-12 + VULN-11

```
1. Log in to free account (VULN-10: no rate limit)
2. Watch any free content
   → hdntl cookie set (acl=/*) ← VULN-06
   → Content UUID learned from API response ← VULN-12
3. Construct CDN URL for premium content:
   https://movies1-suntvvod1.akamaized.net/movies1/<UUID>/auto/index.mpd?hdntl=<token>
4. Load MPD → PSSH triggers Widevine license challenge ← VULN-13
5. Submit challenge to modularLicense (no auth) ← VULN-11
6. Receive valid decryption key
7. Premium content streams and decrypts
```

### Chain B: Unauthenticated Premium Gateway

**Prerequisites:** None (zero credentials)  
**Complexity:** Low  
**Vulnerabilities:** VULN-16

```
1. Access the clone URL (publicly deployed)
2. Call /api/stream-proxy?url=<cdn-url-for-any-content>
3. Server attaches its subscribed session ← VULN-16
4. CDN returns content authenticated with server's subscription
5. Premium content served with zero authentication
```

### Chain C: Subscriber Database Enumeration + Account Targeting

**Prerequisites:** Phone number list  
**Complexity:** Low  
**Vulnerabilities:** VULN-15 + VULN-10

```
1. Enumerate /api/auth/status?mobile=<phone> for each number ← VULN-15
2. Filter: user_available=true AND subscription_status=active
3. These are paying subscribers → high-value targets
4. Credential stuffing against confirmed accounts ← VULN-10
5. Account takeover → subscription theft
```

---

## 7. DRM Architecture Analysis

### Overview

SunNXT uses Nagravision as its DRM provider, which proxies Widevine and PlayReady license requests:

```
Browser (Shaka Player)
  ↓ 1. Load DASH MPD
  ↓ 2. Parse ContentProtection + PSSH
  ↓ 3. EME: Generate license challenge
  ↓ 4. POST challenge to /api/license
  ↓ 5. Proxy to pwaapi modularLicense (VULN-11: no auth)
  ↓ 6. Return binary license
  ↓ 7. CDM decrypts content
```

### DRM Endpoints

| Endpoint | Auth | Subscription Check |
|---|---|---|
| `modularLicense/?content_id=<id>` | **None** | **None** (VULN-11) |
| `nagravisionDRMProxy` | JWT | Yes |
| MPD-embedded `<Laurl>` | Varies | Varies |

### Widevine Response Detection

Valid Widevine license binary: first byte is `0x12` (protobuf header)  
JSON error response: first byte is `0x7B` (`{`)

```typescript
const firstByte = responseBuffer[0];
if (firstByte === 0x7B) {
  // JSON error — subscription check failed or auth error
  return NextResponse.json({ error: "License denied" }, { status: 403 });
}
// Binary license — valid Widevine key
```

---

## 8. CDN Architecture Analysis

### CDN Topology

| CDN Node | Pattern | Use |
|---|---|---|
| `movies1-suntvvod1.akamaized.net` | `/movies1/<UUID>/` | Primary VOD |
| `movies2-suntvvod1.akamaized.net` | `/movies2/<UUID>/` | Secondary VOD |
| `suntvvod1.sunnxt.com` | Direct origin | Some content |
| `livestream4.sunnxt.com` | `/live/<channel>/` | Live TV (HLS) |

### Token Comparison

| Property | hdnea | hdntl |
|---|---|---|
| Type | EdgeAuth 1.0 | EdgeToken Lite 2.0 |
| Scope | `acl=!*/<UUID>/*~` (per-content) | `acl=/*` (wildcard) |
| TTL | ~3 hours | 24 hours |
| Source | Media API response (in URL) | Cookie from CDN |
| IP-bound | No | No |
| Subscription-aware | No | No |

Both tokens validate only HMAC signature and expiry — **neither checks subscription status**.

---

## 9. Stream Format Enumeration

SunNXT supports up to 14 stream format variants per content item:

| Format Code | Protocol | DRM | Notes |
|---|---|---|---|
| `dash` | MPEG-DASH | None (clear) | Older content, SD quality |
| `dash-cenc` | MPEG-DASH | Widevine + PlayReady | Premium HD content |
| `hls` | HLS | None (clear) | iOS fallback |
| `hls-fp-aapl` | HLS | FairPlay | Safari / iOS native |
| `hlsaes` | HLS | AES-128 per-segment | Basic encryption |
| `dash-cenc-720p` | MPEG-DASH | CENC | Quality-specific |
| `dash-cenc-1080p` | MPEG-DASH | CENC | Quality-specific |

**Priority for player:** `dash-cenc` → `dash` → `hls-fp-aapl` → `hlsaes` → `hls`

---

## 10. Remediation Summary

### Immediate Actions (Deployable in Hours)

| # | Action | Fixes |
|---|---|---|
| 1 | Add auth check to `modularLicense` — require Bearer token, validate subscription | VULN-11 |
| 2 | Add session check to `/api/stream-proxy` and `/api/download` — require browser login | VULN-16 |
| 3 | Add auth check to `/api/auth/clear-session` — require admin secret | VULN-14 |
| 4 | Add rate limiting to login API — 10 attempts per 15 min per IP | VULN-10 |
| 5 | Remove subscription status from unauthenticated `/api/auth/status` response | VULN-15 |

### Short-Term (1–4 Weeks)

| # | Action | Fixes |
|---|---|---|
| 6 | Change hdntl token scope from `acl=/*` to per-content `acl=!*/<UUID>/*~` | VULN-06, VULN-20 |
| 7 | Move AES decryption server-side; eliminate client-side key | VULN-01 |
| 8 | Generate random IV per encryption operation | VULN-02 |
| 9 | Set session cookie `Expires` to 30 days; implement server-side expiry | VULN-04 |
| 10 | Add device ownership validation to ManageDevices | VULN-05 |

### Long-Term (1–3 Months)

| # | Action | Fixes |
|---|---|---|
| 11 | Implement periodic CDN path rotation with UUID components | VULN-12, VULN-20 |
| 12 | Add subscription validation at Akamai CDN edge (EdgeLogic) | VULN-06, VULN-20 |
| 13 | Implement server-side device limit enforcement at session level | VULN-03 |
| 14 | Add heartbeat parameter validation and rate limiting | VULN-17 |

---

## 11. Conclusion

The SunNXT platform has serious security vulnerabilities across its authentication, CDN, and DRM infrastructure. The two most critical findings (VULN-11 and VULN-16) represent immediate risks that can be exploited with minimal technical skill.

**The good news:** The most impactful fixes are simple:
- Add an authentication check to the license endpoint (VULN-11) — estimated 2 hours of engineering work
- Add a session check to the proxy endpoints (VULN-16) — estimated 1 hour of engineering work

Together, these two fixes would close the full premium content bypass chain. The remaining vulnerabilities are important but not immediately exploitable at the same level of severity.

This report was prepared for responsible disclosure to the SunNXT security team. The author (Nitheesh D R) is available to assist with remediation questions and to verify fixes once implemented.

---

## 12. Post-Harvest Findings (Addendum — May 2026)

These findings emerged from large-scale automated testing following the initial assessment.

### A. UUID Harvest Scale Confirmation

The VULN-20 UUID bypass was validated at scale: 9,950 content IDs were processed in a single harvest run. **478 new UUIDs** were learned and persisted, growing the UUID database from 58 to 536 entries. Each entry enables permanent, subscription-free content access via the CDN UUID + hdntl bypass chain. The harvest used only public browse and search endpoints (no subscription required for discovery) and the pwaapi contentDetail endpoint for UUID extraction.

### B. pwaapi Unauthenticated Access — Scope Extended

`pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` was confirmed to return valid binary Widevine licenses **without any session cookie** for the majority of content IDs tested. This extends VULN-11 beyond the originally documented scope: not only does the endpoint have no subscription check, it has **no authentication requirement at all**. Any HTTP client can obtain Widevine decryption keys for SunNXT content by sending a Widevine license challenge with only a `content_id` parameter.

Additionally, `pwaapi.sunnxt.com/content/v3/contentDetail/<id>/` was confirmed to return complete stream URLs (including CDN paths with embedded hdntl tokens) **without any session cookie** for many content IDs. This means UUID and hdntl bypass data can be harvested entirely without a SunNXT account.

### C. Session Rate-Limiting Asymmetry

After high-volume API requests (~10,000 in a session), SunNXT's main API (`www.sunnxt.com/next/api/`) returns `ERR_CLIENT_NOT_ALLOWED` (HTTP 400) for all subsequent requests. The block lasts approximately 1 hour. However, `pwaapi.sunnxt.com` is **not co-rate-limited** — requests to pwaapi without any session cookie continue to succeed during main API blocks. This means the bypass path cannot be shut down by blocking the main API session alone.

### D. Shaka 5.x DRM Configuration Change (Implementation Note)

Shaka Player 5.x changed the type of `videoRobustness` and `audioRobustness` in `drm.advanced` from `string` to `string[]`. Passing a plain string now silently causes "Invalid config, wrong type" and DRM initialisation fails with a false-negative error. This is a breaking change from Shaka 4.x with no deprecation warning.

Additionally, Shaka 5 added top-level `defaultVideoRobustnessForWidevine` and `defaultAudioRobustnessForWidevine` as a simpler alternative to the per-key-system `advanced` config.

### E. Live HD Channels — HDCP Enforcement Confirmed Hard

SunNXT's Nagravision license server unconditionally sets `output_protection.hdcp = HDCP_V2` in licenses for live HD channels (`*HDB_IN_index.mpd`). Configuring Widevine L3 (`SW_SECURE_DECODE`) robustness does not change this — the license server ignores the robustness hint for live content and always mandates HDCP. Desktop browsers cannot satisfy HDCP hardware verification, so the CDM reports `output-restricted` key status and playback fails (Shaka 4012). This is the only SunNXT content category where the subscription bypass chain does not produce playable output in a browser.

### F. CDM State Leakage — Chrome Browser Behaviour

When `HTMLMediaElement.setMediaKeys()` is not explicitly called with `null` after `shaka.Player.destroy()`, Chrome retains the previous MediaKeys session on the `<video>` element. A new Shaka Player attached to the same element inherits any existing key status. If the previous session had `output-restricted` keys, the new instance's stream filter immediately removes all variants (Shaka 4032) without requesting a new license. This makes format-fallback logic appear broken when only one format has HDCP issues — the second format also fails because of stale CDM state from the first.

**Fix:** `await videoElement.setMediaKeys(null)` between player instances.

---

*Report prepared by Nitheesh D R — May 23, 2026. Addendum v2.1 added May 23, 2026.*

---

## 13. Addendum v2.2 — FairPlay DRM, Live Channel DRM Fix, Download Feature (May 2026)

### G. FairPlay DRM — Safari / iOS Support

**Finding:** The `hls-fp-aapl` stream format was never being selected on Safari/iOS due to a bug in the format-selection priority logic. The generic HLS selector matched `hlsaes` entries first, causing FairPlay streams to be skipped entirely. On Safari, this resulted in DRM failure because Apple's EME implementation expects a `com.apple.fps.1_0` session.

**Fix implemented:**
- `hls-fp-aapl` is now selected explicitly before the generic HLS fallback
- Player detects `isFairPlay = video.format === "hls-fp-aapl"` and configures `com.apple.fps.1_0` key system
- `serverCertificateUri` is set to the license proxy URL; a new GET handler on the license proxy returns the FairPlay server certificate from Nagravision (with session-cookie fallback)
- `isLive=1` flag is also set for FairPlay license requests — `modularLicense` cannot handle FairPlay challenges (incompatible binary format); requests are routed directly to `nagravisionDRMProxy`

**Security note:** FairPlay certificate retrieval via the proxy GET endpoint requires the server session to be valid. The certificate is not sensitive (it is a public key infrastructure component), but the routing through the proxy means the server's session cookie is attached — this is consistent with existing VULN-16 behavior.

### H. Live Channel DRM — modularLicense HDCP Enforcement

**Finding:** `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/` returns Widevine licenses for live channel content IDs, but those licenses unconditionally include `output_protection.hdcp = HDCP_V2`. This is not negotiable via Widevine robustness hints in the license challenge — it is a static Nagravision license template policy for all live channel IDs.

**Impact:** Using `modularLicense` for live channels causes `output-restricted` key status in the browser CDM for all live channels (including SD), not just HD channels. Previously this appeared as an HDCP enforcement issue specific to HD channels; in fact the root cause is `modularLicense`'s unconditional HDCP policy for live content.

**Fix:** The `isLive=1` flag in the license proxy URL causes the proxy to skip `modularLicense` and route directly to `nagravisionDRMProxy` (authenticated, with session JWT + cookie). `nagravisionDRMProxy` issues licenses without the unconditional HDCP requirement for SD live channels. Live channels now play on Chrome, Firefox, Edge, and Android browsers.

**Residual:** HD live channels (`*HDB_IN`) remain blocked on desktop because the HDCP_V2 policy is applied at the channel level in Nagravision CAS — it is present in `nagravisionDRMProxy` responses as well, just for those specific channel IDs. Android TV and Chromecast (hardware HDCP path) can play HD live channels.

**Relation to existing findings:** This finding refines the scope of finding E (v2.1 addendum). The HDCP enforcement for live content is a two-layer issue: (1) `modularLicense` applies it to all live IDs unconditionally; (2) `nagravisionDRMProxy` applies it selectively only to HD channel IDs.

### I. Download Feature — DASH-to-fMP4 Segment Streaming

A new route `GET /api/download/video/[contentId]` was implemented and tested. Security-relevant observations:

**CDN access without subscription:** Segment bytes are served by Akamai CDN with only a valid `hdntl` token — no subscription check. The download route uses the server's session (consistent with VULN-16) to obtain stream URLs and the `hdntl` token, then fetches segments directly. This demonstrates again that CDN access is entirely decoupled from subscription enforcement (VULN-06 / VULN-20).

**DRM-encrypted content:** Downloaded fMP4 segments are CENC-encrypted. The raw files are not playable without the content decryption key. For VOD content, the key is obtainable via `modularLicense` (VULN-11). Combined with the download route, this provides a complete offline content extraction path for VOD: download segments → obtain key via VULN-11 → decrypt with `mp4decrypt` or `ffmpeg` + key.

**Server-side merge (`?stream=1&merge=1`):** Requires `ffmpeg` installed locally. Not compatible with Vercel serverless due to disk write constraints and function execution time limits. Suitable for local development/testing use only.

**MPD parsing:** The route implements a SegmentTemplate + SegmentTimeline parser. Akamai `hdntl` auth tokens from the MPD URL query string are preserved and forwarded with every segment request. The parser picks the highest-bandwidth video `Representation` and the first audio `Representation`.

**Server-side ffmpeg merge — implementation detail:** `checkFfmpeg()` runs `which ffmpeg` to detect the binary. `collectTrack()` fetches init.mp4 and all media segments sequentially, concatenates them into a single Uint8Array in memory. Both video and audio tracks are collected in parallel (`Promise.all`), written to temp files via Node.js `fs/promises`, then ffmpeg is spawned with `-c copy -movflags frag_keyframe+empty_moov -f mp4 pipe:1`. ffmpeg stdout is piped directly to the HTTP response stream. Temp dir is cleaned up on ffmpeg `close` regardless of exit code. This implementation runs correctly in local Node.js but fails on Vercel serverless: (1) the `/tmp` filesystem is limited and shared across concurrent invocations; (2) function execution time limits are shorter than a full-film segment collect + transcode operation.

**Player UI:** A download button appears in the top-right of the player. When clicked it shows a panel with a single **"Download MP4"** button that points to `?stream=1&merge=1`. Encryption status and a note about server-side merge are shown below. The separate "Download Video" / "Download Audio" buttons and the manual ffmpeg command note have been removed. This surface is accessible to any unauthenticated user due to VULN-16 (server session proxied to all users).

*Addendum v2.2 prepared by Nitheesh D R — May 2026. Updated v2.3 May 2026 (merge implementation completed).*
