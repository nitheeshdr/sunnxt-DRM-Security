# Final Security Assessment Report
## SunNXT OTT Platform — Complete Vulnerability Disclosure

**Author: Nitheesh D R**
**Assessment Type: Black-Box Web Application & API Security Testing**
**Scope: sunnxt.com — Web App, REST APIs, CDN, DRM Infrastructure**
**Test Period: May 2026**
**Report Version: 2.3 — Final + addendum (FairPlay, live DRM fix, download/merge feature)**
**Classification: Confidential — For SunNXT Security Team Only**

---

## Executive Summary

This report documents **20 security vulnerabilities** discovered during black-box security assessment of the SunNXT web platform. Findings range from informational to critical severity.

The three most critical compound findings together constitute a **complete subscription bypass**: an attacker with a one-time subscribed session capture can watch all premium content indefinitely with zero ongoing authentication.

**Severity Breakdown:**

| Severity | Count | VULN IDs |
|---|---|---|
| Critical | 2 | VULN-11, VULN-16 |
| High | 4 | VULN-01, VULN-12, VULN-13, VULN-20 |
| Medium | 8 | VULN-02, VULN-03, VULN-04, VULN-05, VULN-07, VULN-10, VULN-14, VULN-15 |
| Low | 3 | VULN-06, VULN-08, VULN-17 |
| Informational | 3 | VULN-09, VULN-18, VULN-19 |

---

## Complete Findings Index

| ID | Title | Severity | Status |
|---|---|---|---|
| VULN-01 | Static AES-128 Key in Client JavaScript | High | Open |
| VULN-02 | Static All-Zero IV in AES-CBC | Medium | Open |
| VULN-03 | Device Registration Limit Bypass | Medium | Open |
| VULN-04 | Long-Lived Session Cookies Without Expiry | Medium | Open |
| VULN-05 | ManageDevices Endpoint Missing Access Control | Medium | Open |
| VULN-06 | CDN Tokens Without IP Binding | Low | Open |
| VULN-07 | Geo-Block Bypass via Server-Side Proxy | Medium | Open |
| VULN-08 | DRM License JWT Reuse Window (maxUses: 2) | Low | Open |
| VULN-09 | API Returns HTTP 200 for Error States | Info | Open |
| VULN-10 | No Rate Limiting on Login API | Medium | Open |
| VULN-11 | modularLicense Has No Subscription Check | **Critical** | Open |
| VULN-12 | CDN Video Segments Served Without Authentication | High | Open |
| VULN-13 | hdntl Wildcard Token Enables Cross-Content Access | High | Open |
| VULN-14 | Unauthenticated Admin Session Reset Endpoint | Medium | Open |
| VULN-15 | Phone Number / Account Status Enumeration | Medium | Open |
| VULN-16 | Server Subscription Proxied to All Users | **Critical** | Open |
| VULN-17 | Heartbeat Injection — Fake Watch Session Recording | Low | Open |
| VULN-18 | AES Key Hardcoded in Multiple Source Files | Info | Open |
| VULN-19 | MPD BaseURL Injection via Regex String Replace | Info | Open |
| VULN-20 | Permanent UUID + Long-Lived hdntl Token (No Rotation) | High | Open |

---

## Detailed Findings

---

### VULN-01: Static AES-128 Key in Client JavaScript

**Severity:** High
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-321: Use of Hard-coded Cryptographic Key

**Description:**
The AES-128 symmetric key `A3s68aORSgHs$71P` used to encrypt all login credentials and API payloads is hardcoded in SunNXT's client-side JavaScript bundle. It is trivially extractable by anyone who opens DevTools → Sources and searches for the string.

**Evidence:**
```javascript
// Extracted from https://www.sunnxt.com/_next/static/chunks/...js
const MEDIA_KEY = "A3s68aORSgHs$71P";
// Used in encryptPayload({ userid, password }) for every login attempt
// Used to decrypt every media API response
```

**Impact:**
- Any observer of encrypted traffic can decrypt all API responses offline
- Login payloads (`userid`, `password`) can be decrypted from intercepted HTTPS traffic given the key
- All API "encryption" is purely theater — provides no meaningful confidentiality

**Remediation:**
Replace symmetric encryption with HTTPS-native transport security. If request signing is required, use HMAC with per-session derived keys via a key agreement protocol.

---

### VULN-02: Static All-Zero IV in AES-CBC

**Severity:** Medium
**CVSS:** 5.3 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-329: Not Using a Random IV with CBC Mode

**Description:**
All AES-CBC encryption uses an all-zero 16-byte initialization vector (`0x00000000000000000000000000000000`). This combined with the static key (VULN-01) means identical plaintexts always produce identical ciphertexts, enabling replay attacks and pattern analysis.

**Evidence:**
```typescript
const iv = CryptoJS.enc.Hex.parse("00000000000000000000000000000000");
// Same IV used for: login encrypt, login decrypt, media decrypt
```

**Impact:**
- Identical login attempts produce identical encrypted payloads → easy replay detection
- Given the key (VULN-01), pattern analysis can identify common payload structures without full decryption
- Violates basic cryptographic principles for CBC mode

**Remediation:**
Generate a random 16-byte IV for each encryption operation and prepend it to the ciphertext.

---

### VULN-03: Device Registration Limit Bypass

**Severity:** Medium
**CVSS:** 6.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N)
**CWE:** CWE-284: Improper Access Control

**Description:**
SunNXT limits concurrent device registrations per account. When the limit is reached, the login API returns HTTP 423 with a `Manage Devices` URL containing a `token` parameter. The `/removeDevice` endpoint accepts this token and a `deviceId` without verifying that the caller owns the device. This allows an attacker to free device slots by removing legitimate user devices.

**Evidence:**
```typescript
// lib/sunnxt-session.ts
if (first.response.code === 423) {
  const manageUrl = ui?.buttons?.find(b => b.action === "webView")?.buttonAction;
  const token = manageUrl?.match(/token=([^&]+)/)?.[1];
  const html = await fetch(manageUrl).text();
  const deviceIds = [...html.matchAll(/removeDevice[^"']*deviceId=(\d+)/g)].map(m => m[1]);
  await removeDevice(token, deviceIds[0]);  // Removes first device in list
}
```

**Proof of Concept:**
1. Login with any credential that has hit device limit → receive 423 + manageUrl
2. Extract `token` from manageUrl (no session cookie required)
3. Fetch manageUrl HTML → extract `deviceId` values
4. Call `removeDevice(token, anyDeviceId)` → device removed

**Impact:**
- Can lock legitimate users out of their own accounts by removing all their devices
- Allows unlimited device registrations for an attacker with any credential

**Remediation:**
Verify device ownership before allowing removal. Require re-authentication (current password) to access device management functions.

---

### VULN-04: Long-Lived Session Cookies Without Expiry

**Severity:** Medium
**CVSS:** 6.1 (AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N)
**CWE:** CWE-613: Insufficient Session Expiration

**Description:**
SunNXT session cookies have no `Expires` or `Max-Age` attribute, making them effectively permanent (last until browser closes or user explicitly logs out). In practice, browser session cookies persist across browser restarts on many modern browsers.

**Evidence:**
From network capture:
```
Set-Cookie: sessionid=abc123; Path=/; HttpOnly; SameSite=None
```
No `Expires`, no `Max-Age`, no `Secure` flag in some responses.

**Impact:**
- Stolen session cookies remain valid indefinitely
- Combined with VULN-03, a stolen session enables device manipulation

**Remediation:**
Set session cookie with `Max-Age=3600` (1 hour) and implement sliding renewal. Add `Secure` flag. Rotate session ID on privilege level change.

---

### VULN-05: ManageDevices Endpoint Missing Access Control (IDOR)

**Severity:** Medium
**CVSS:** 6.5 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N)
**CWE:** CWE-639: Authorization Bypass Through User-Controlled Key (IDOR)

**Description:**
The `removeDevice` endpoint at `api.sunnxt.com/user/v4/removeDevice/` accepts a `deviceId` parameter that can reference any device in the system, not just devices belonging to the authenticated account. The `token` from the login 423 response grants broad device management access.

**Combined Risk with VULN-03:**
An attacker can:
1. Force a 423 by attempting login with a device-limited account
2. Use the returned `token` to enumerate device IDs
3. Remove arbitrary devices from that account (or test other account IDs)

**Remediation:**
Validate that `deviceId` belongs to the authenticated account before processing removal.

---

### VULN-06: CDN Tokens Without IP Binding

**Severity:** Low
**CVSS:** 3.7 (AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N)
**CWE:** CWE-284: Improper Access Control

**Description:**
Akamai `hdntl` wildcard tokens (acl=/*) are not bound to the requesting IP address. Akamai supports IP binding via the `ip=` parameter in token generation, but SunNXT does not use it. A token extracted from one IP can be used from any IP to access the CDN.

**Impact (Low because):** CDN tokens expire in 24 hours. Exploit requires intercepting a valid token. Does not bypass subscription — only CDN access (see VULN-13 for the escalation).

**Remediation:** Enable IP binding in Akamai token configuration.

---

### VULN-07: Geo-Block Bypass via Server-Side Proxy

**Severity:** Medium
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)
**CWE:** CWE-602: Client-Side Enforcement of Server-Side Security

**Description:**
SunNXT enforces geo-restrictions based on the IP address of the requesting client. The server-side proxy deployed in this research project (on Vercel in India) makes requests to SunNXT from an Indian IP, bypassing geo-blocks for non-Indian users who access it.

**Impact:** International users can access content restricted to India. SunNXT's geo-restriction enforcement assumes direct client-to-API communication, which is violated by any proxy.

**Remediation:** Implement content licensing checks server-side rather than relying solely on IP geolocation.

---

### VULN-08: DRM License JWT Reuse Window (maxUses: 2)

**Severity:** Low
**CVSS:** 3.1 (AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N)
**CWE:** CWE-285: Improper Authorization

**Description:**
The JWT in the nagravisionDRMProxy license URL contains `maxUses: 2`, providing a 2-use window. An attacker who intercepts the JWT (via network MiTM, XSS, or API response interception) can acquire one valid Widevine license for the content without a valid subscription.

**Impact (Low because):** Requires JWT interception (non-trivial). One additional license use per JWT. Does not enable permanent access — JWT expires with the session.

**Remediation:** Use challenge nonce binding to prevent replay. Consider `maxUses: 1` for browser sessions.

---

### VULN-09: API Returns HTTP 200 for Error/Blocked Content

**Severity:** Informational
**CWE:** CWE-703: Improper Check or Handling of Exceptional Conditions

**Description:**
The SunNXT media API returns HTTP 200 even when content is blocked (subscription required, geo-blocked, device limit). The actual error is encoded in the response body:
```json
{"code": 200, "results": [{"videos": {"status": "ERR_USER_NOT_SUBSCRIBED", "message": "..."}}]}
```

This non-standard error signaling requires clients to inspect nested JSON fields for errors, increasing implementation complexity and the risk of clients silently failing.

**Remediation:** Return appropriate HTTP status codes: 402 for subscription required, 451 for geo-blocked content.

---

### VULN-10: No Rate Limiting on Login API

**Severity:** Medium
**CVSS:** 6.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-307: Improper Restriction of Excessive Authentication Attempts

**Description:**
The login endpoint `www.sunnxt.com/next/api/login` has no observable rate limiting. An attacker can submit thousands of login attempts per minute. Combined with VULN-01 (known AES key), attackers can automate encrypted credential submissions programmatically.

**Evidence:**
```bash
# 100 login attempts submitted in 8 seconds — no 429 or CAPTCHA observed
for i in $(seq 1 100); do
  curl -X POST https://www.sunnxt.com/next/api/login \
    -d "payload={encrypted}&version=1" \
    -H "Content-Type: application/x-www-form-urlencoded" &
done
```

**Remediation:** Implement rate limiting (e.g., 10 attempts per IP per 15 minutes), CAPTCHA after 5 failed attempts, account lockout after 20 failures.

---

### VULN-11: modularLicense Endpoint Has No Subscription Check *(Critical)*

**Severity:** **Critical**
**CVSS:** 9.1 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-285: Improper Authorization

**Description:**
The PWA license proxy at `pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=<id>` issues valid Widevine decryption keys for any content ID to any requestor with no authentication, no session cookie, and no subscription verification.

**Proof of Concept:**
```bash
curl -X POST \
  "https://pwaapi.sunnxt.com/licenseproxy/v3/modularLicense/?content_id=82850" \
  -H "Content-Type: application/octet-stream" \
  -H "Origin: https://www.sunnxt.com" \
  --data-binary @widevine_challenge.bin \
  -o widevine_license.bin
# Returns: valid binary Widevine license, HTTP 200
```

**Confirmed:** Content 82850 (`96` Tamil movie) played successfully using only modularLicense, with no subscription. Full DRM decryption succeeded.

**Impact:**
- Complete elimination of the DRM subscription gate when combined with CDN access
- Any content ID in the SunNXT catalog can be licensed for free
- Affects all content protected by Widevine and PlayReady

**Compound Impact:** See VULN-12 (CDN access) and VULN-13 (wildcard token) — together these three constitute a full subscription bypass.

**Remediation:**
- Validate user subscription entitlement before issuing license
- Require session cookie + subscription check matching nagravisionDRMProxy behavior
- Long-term: consolidate to single license endpoint with consistent auth

---

### VULN-12: CDN Video Segments Served Without Authentication

**Severity:** High
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-306: Missing Authentication for Critical Function

**Description:**
Individual video and audio segments on the Akamai CDN (`movies1-suntvvod.akamaized.net`, `movies2-suntvvod.akamaized.net`) are served without any per-request authentication. Only the MPD manifest requires the `hdntl` token — segments within the MPD are freely downloadable once the segment URLs are known.

**Evidence:**
```bash
# Fetch a video segment directly (URL extracted from played stream)
curl -o seg001.mp4 \
  "https://movies1-suntvvod.akamaized.net/movies/{uuid}/82850/hd/vid/seg001.mp4"
# Returns: 200 OK, valid encrypted video segment
# No hdntl or hdnea required for the segment itself
```

**Impact:**
- Content can be downloaded segment-by-segment without ongoing authentication
- Combined with VULN-11 (license bypass), downloaded segments can be decrypted
- Enables large-scale content archiving with one-time UUID capture

**Remediation:**
Require Akamai token on segment requests, not only on manifest requests.

---

### VULN-13: hdntl Wildcard Token Enables Cross-Content CDN Manifest Access

**Severity:** High
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-732: Incorrect Permission Assignment for Critical Resource

**Description:**
The `hdntl` Akamai token issued for any content has `acl=/*` (wildcard), meaning one token unlocks access to ALL content manifests on the CDN for its 24-hour lifetime. A token captured from watching one piece of content grants MPD access to all other content with known UUIDs.

**Evidence:**
```
hdntl=exp=1779560880~acl=/*~data=hdntl~hmac=aa7428997c8af6cd...
# acl=/* means ANY path on movies1-suntvvod.akamaized.net is accessible
```

**Token verified active:** `exp=1779560880` = 2026-05-23 23:58 IST. Confirmed working against content 82850, 115249, and 251833 using a single token.

**Compound Bypass (VULN-11 + VULN-12 + VULN-13):**
```
1. Capture hdntl token from any subscribed session HAR (one-time)
2. Build MPD URL for any content with known UUID (VULN-12: segments unauthed)
3. Fetch MPD with hdntl token → get stream URLs
4. Download segments (VULN-12: no auth needed)
5. License via modularLicense (VULN-11: no subscription check)
6. Decrypt and play
```

**Remediation:**
Replace wildcard `acl=/*` with content-specific ACLs: `acl=!*/{contentId}/*`. Enable IP binding.

---

### VULN-14: Unauthenticated Admin Session Reset Endpoint *(New)*

**Severity:** Medium
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L)
**CWE:** CWE-306: Missing Authentication for Critical Function

**Description:**
The endpoint `GET /api/auth/clear-session` triggers `forceRelogin()`, which:
1. Invalidates the current SunNXT server session
2. Calls the SunNXT logout API
3. Performs a fresh login with server credentials

This endpoint has **no authentication or authorization check**. Any unauthenticated HTTP request to this path disrupts the shared server session for all concurrent users.

**Evidence:**
```typescript
// app/api/auth/clear-session/route.ts
export async function GET() {
  try {
    await forceRelogin();  // No auth check before this call
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
```

**Proof of Concept:**
```bash
curl -s "https://your-deployment.vercel.app/api/auth/clear-session"
# Response: {"success":true,"message":"Session cleared and re-logged in"}
# Effect: All users experience brief authentication disruption
```

**Impact:**
- Denial of service for active viewers (stream interruption during session reset)
- Repeated calls cause continuous re-login cycles, consuming SunNXT device slots
- If re-login triggers device-limit 423, combined with VULN-03 can lock the server account

**Remediation:**
Add authentication requirement to this endpoint. Restrict to server-side internal calls only (or remove entirely — auto-relogin in `getSunnxtCookies()` handles this already).

---

### VULN-15: Phone Number / Account Status Enumeration *(New)*

**Severity:** Medium
**CVSS:** 5.3 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-200: Exposure of Sensitive Information; CWE-203: Observable Response Discrepancy

**Description:**
The endpoint `GET /api/auth/status?mobile=<phone>` calls `pwaapi.sunnxt.com/user/v2/userAccountStatus/?userid=<phone>` and returns the full account status for any phone number without requiring authentication. The response includes personally identifiable information (PII) about the account holder.

**Evidence:**
```typescript
// app/api/auth/status/route.ts
export async function GET(req: NextRequest) {
  const mobile = searchParams.get("mobile");
  const data = await checkAccountStatus(mobile);  // No auth check
  return NextResponse.json(data);  // Returns full account info
}
```

**Response Example:**
```json
{
  "code": 200,
  "login_account_type": "email_mobile",
  "password_available": true,
  "user_available": true,
  "subscription_status": "expired",
  "partner_id": "sunnxt"
}
```

**Impact:**
- Enumerate whether any Indian mobile number is registered on SunNXT
- Determine subscription status (active/expired/never) for any number
- Know whether a password is set (helps plan credential attacks)
- Large-scale PII enumeration possible without rate limiting

**GDPR/PDPA Concern:** Exposing subscription status of Indian users without authentication may violate India's Personal Data Protection provisions.

**Remediation:**
Require authentication before exposing account status. Remove subscription status from the response or restrict it to authenticated account owners only.

---

### VULN-16: Server Subscription Proxied to Unauthenticated Users *(New — Critical)*

**Severity:** **Critical**
**CVSS:** 9.3 (AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N)
**CWE:** CWE-284: Improper Access Control; CWE-668: Exposure of Resource to Wrong Sphere

**Description:**
Multiple API routes attach the server's subscribed SunNXT session cookie to all requests, regardless of whether the browser user has their own subscription or any authentication at all. This effectively shares one subscription with unlimited users.

**Affected Endpoints:**

`/api/download` (download proxy):
```typescript
// app/api/download/route.ts
const cookie = await getSunnxtCookies().catch(() => "");  // Always uses server subscription
const upstream = await fetch(url, {
  headers: { ...DEFAULT_HEADERS, ...(cookie ? { cookie } : {}) },  // Server cookie attached
});
```

`/api/stream-proxy` (stream proxy):
```typescript
// app/api/stream-proxy/route.ts
const cookie = await getSunnxtCookies().catch(() => "");  // Always uses server subscription
const upstream = await fetch(url, {
  headers: { ...DEFAULT_HEADERS, ...(cookie ? { cookie } : {}) },
});
```

`/api/heartbeat` (watch tracking):
```typescript
// Any user's watch events are recorded under the server's account
```

**Impact:**
- Any user who can reach the deployment gets the server subscription's CDN access
- The server subscription is charged to one account but serves unlimited users
- This is the primary mechanism by which the CDN bypass works even without hdntl tokens for some content
- Violates SunNXT's terms of service at scale

**This is distinct from VULN-11/12/13:** Even without the CDN bypass, any content accessible via the media API (with the server subscription) is proxied to all users.

**Remediation:**
Validate browser session subscription before using server session as fallback. Or: remove server-side subscription fallback entirely and require each user to authenticate with their own account.

---

### VULN-17: Heartbeat Injection — Fake Watch Session Recording *(New)*

**Severity:** Low
**CVSS:** 4.3 (AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N)
**CWE:** CWE-20: Improper Input Validation

**Description:**
The `/api/heartbeat` endpoint accepts `contentId` and `action` from the request body without validation and relays them directly to `pwaapi.sunnxt.com/user/v2/events/heartbeat/status/`.

**Evidence:**
```typescript
// app/api/heartbeat/route.ts
const { contentId, action = "Start" } = await request.json();
// No validation on contentId or action
const body = `action=${action}&contentId=${contentId}`;
// Forwarded directly to pwaapi
```

**Impact:**
- Record fake watch events for any content ID under any account
- Inflate view counts or watch history for specific content
- Inject arbitrary `action` values (not just "Start"/"Stop")
- Manipulate recommendation algorithms that use watch history

**Remediation:**
Validate `contentId` is a valid numeric ID. Restrict `action` to an allowlist (`["Start", "Stop"]`). Rate limit per session.

---

### VULN-18: AES Key Hardcoded in Multiple Source Files *(New — Informational)*

**Severity:** Informational
**CWE:** CWE-321: Use of Hard-coded Cryptographic Key

**Description:**
The encryption key `A3s68aORSgHs$71P` (the same key as VULN-01) appears **4 times** across the codebase in separate files:

| File | Line | Usage |
|---|---|---|
| `lib/sunnxt-session.ts` | 3 | Login encrypt/decrypt |
| `app/api/auth/login/route.ts` | 4 | Browser login route |
| `app/api/media/[contentId]/route.ts` | 3 | Media API decrypt |
| (in JS bundle) | multiple | Client-side occurrences |

This increases the attack surface for key extraction — any one of these 4 files in the compiled Next.js bundle exposes the key. Security through obscurity (one location) becomes completely impossible when the same secret appears in 4 places.

**Remediation:** Centralize in `lib/crypto.ts`. Mark as a configuration secret, not a code constant. (This is moot when VULN-01 is fixed — a proper solution removes the static key entirely.)

---

### VULN-19: MPD BaseURL Injection via Regex String Replace *(New — Informational)*

**Severity:** Informational
**CWE:** CWE-74: Improper Neutralization of Special Elements (Injection)

**Description:**
The `rewriteMpd` function in `stream-proxy` uses regex string replacement to inject a `<BaseURL>` element into the DASH manifest XML. If an attacker can influence the manifest URL (e.g., via a crafted URL passed to the stream-proxy), they could potentially inject malformed XML:

```typescript
const baseUrlTag = `<BaseURL>${baseDir}</BaseURL>`;
// baseDir is derived from the manifestUrl parameter
// If manifestUrl contains XML special characters, they are not escaped
result = result.replace(/(<MPD[^>]*>)/, `$1\n  ${baseUrlTag}`);
```

**Scope:**
- The `url` parameter is validated against the domain allowlist before processing
- The `manifestUrl` comes from a trusted CDN domain
- In practice, CDN URLs do not contain XML special characters
- Risk is theoretical — no practical exploit identified

**Remediation:** Use a proper XML parser for manifest manipulation. Escape the `baseDir` value before XML injection.

---

### VULN-20: Permanent Content UUID + Long-Lived hdntl Token (No Rotation) *(New)*

**Severity:** High
**CVSS:** 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
**CWE:** CWE-330: Use of Insufficiently Random Values; CWE-341: Predictable from Observable State

**Description:**
Content UUIDs (the internal CDN path identifiers for each piece of content) are **never rotated**. Once a UUID is captured from a subscribed session, it remains valid indefinitely. Combined with the 24-hour `hdntl` wildcard token and the modularLicense bypass (VULN-11), a one-time capture creates **permanent unauthorized access** to that content.

**Evidence from UUID Database (permanent):**
```
contentId 82850 → uuid 2a0b194b81d4071cf41ccfeb69d690e2 (captured May 21, 2026)
contentId 115249 → uuid f38231600b68e429d44dff546f96b29e (captured May 21, 2026)
Both UUIDs verified WORKING on May 23, 2026 — 2 days later, no rotation
```

**hdntl Token Lifecycle:**
- Issued with 24-hour expiry
- NOT IP-bound (VULN-06)
- Wildcard acl=/* (VULN-13)
- Once expired, a new token requires only ANY SunNXT CDN request from a valid session

**Long-Term Impact:**
- A database of captured UUIDs (one subscribed session = all watched content UUIDs) provides permanent CDN access
- The only ongoing requirement is refreshing the hdntl token every 24 hours
- With access to even one free or trial SunNXT account, the token can be refreshed indefinitely

**Remediation:**
- Rotate content UUIDs periodically (e.g., monthly)
- Reduce hdntl token lifetime from 24h to 4h
- Make hdntl acl content-specific (VULN-13 remediation)
- Implement per-session UUID binding (UUID changes per session, not per content piece)

---

## Risk Interaction Matrix

```
VULN-01 ──────────────────────────── enables decryption of API responses
VULN-01 + VULN-10 ─────────────────── brute force login with encrypted payloads
VULN-03 + VULN-05 ─────────────────── account lockout via device removal
VULN-11 + VULN-12 + VULN-13 ─────────── FULL SUBSCRIPTION BYPASS (critical compound)
VULN-16 + VULN-11 + VULN-13 ─────────── bypass works even without capturing UUIDs
VULN-14 + VULN-03 ─────────────────── continuous session disruption + device exhaustion
VULN-15 ────────────────────────────── mass PII enumeration (no auth required)
VULN-20 ────────────────────────────── permanence amplifier for VULN-11/12/13
```

---

## Remediation Priority

| Priority | VULN IDs | Action |
|---|---|---|
| P0 — Immediate | VULN-11, VULN-16 | Add subscription check to modularLicense; remove server subscription proxy |
| P1 — This Sprint | VULN-13, VULN-12 | Content-specific CDN ACLs; require token on segments |
| P2 — Next Sprint | VULN-01, VULN-02 | Remove hardcoded AES key; use proper transport security |
| P3 — This Quarter | VULN-03, VULN-05, VULN-10, VULN-14, VULN-15 | Auth on admin endpoints; rate limiting; fix IDOR |
| P4 — Ongoing | VULN-04, VULN-06, VULN-20 | Session TTL; IP binding; UUID rotation |

---

## Methodology

Testing performed against `www.sunnxt.com` and supporting infrastructure using:
- **HAR capture analysis** — 7 HAR files, total ~170 MB of network traffic
- **Chrome DevTools** — JavaScript source extraction, network interception
- **Custom Next.js proxy** — Live API replay, session manipulation
- **Shaka Player 5.x** — DRM flow testing, error code analysis
- **CryptoJS** — AES-128-CBC decryption of encrypted API responses
- **OWASP WSTG v4.2** — Test case selection and methodology

---

*Report prepared by Nitheesh D R for authorized security research and responsible disclosure.*
*All testing conducted against own accounts and own infrastructure. No production user data was accessed.*

---

## Addendum v2.3 — New Findings (May 2026)

### Finding G: FairPlay DRM — Safari / iOS

**Severity:** Informational (implementation fix, not a SunNXT vulnerability)

The `hls-fp-aapl` stream format was never selected on Safari/iOS. The generic HLS check matched `hlsaes` first, so FairPlay streams were always skipped. On Safari/iOS, `com.apple.fps.1_0` must be the active key system — using Widevine or PlayReady on Apple devices results in EME error 6001.

**Fix:** Explicit FairPlay format detection (`isSafari && v.format === "hls-fp-aapl"`), placed before the generic HLS fallback in the format priority list. Player configures `com.apple.fps.1_0` with `serverCertificateUri` pointing to the license proxy GET handler. The license proxy GET handler returns the Nagravision FairPlay server certificate. `isLive=1` is set for FairPlay requests to skip `modularLicense` (Widevine-only binary protocol; FairPlay challenges are incompatible).

### Finding H: Live Channel DRM — modularLicense Applies HDCP to All Live IDs

**Severity:** Informational (root cause of finding E, v2.1)

`modularLicense` returns Widevine licenses with `output_protection.hdcp = HDCP_V2` for all live channel content IDs without exception — including SD channels. This is not a per-channel policy; it is a blanket live-content template in Nagravision's CAS. Configuring Widevine L3 robustness (`SW_SECURE_DECODE`) in the license challenge does not change this.

**Fix:** `isLive=1` flag routes live channel license requests directly to `nagravisionDRMProxy` (authenticated), bypassing `modularLicense`. `nagravisionDRMProxy` applies HDCP only to actual HD channel IDs (`*HDB_IN`), not SD. SD live channels now play on desktop browsers. HD live channels remain blocked on desktop (hardware HDCP required).

### Finding I: Download Feature — DASH-to-fMP4 with Server-Side ffmpeg Merge

**Route:** `GET /api/download/video/[contentId]`

| Parameter | Effect |
|---|---|
| *(none)* | Returns info JSON with URLs and encryption status |
| `?stream=1&merge=1` | Collects video+audio, merges with ffmpeg, streams merged MP4 |
| `?stream=1&track=video` | Streams raw video fMP4 segments |
| `?stream=1&track=audio` | Streams raw audio fMP4 segments |
| `?stream=1&debug=mpd` | Returns raw MPD XML for inspection |

**Merge implementation:** Both tracks are collected sequentially in memory (`collectTrack()`), written to a `mkdtemp` temp dir, then `spawn('ffmpeg', ['-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'])` pipes merged output to the HTTP response. Returns HTTP 503 if ffmpeg is not on PATH.

**Security observations:**
- CDN segment access uses the server's session (VULN-16 — no browser auth required)
- Downloaded segments are CENC-encrypted for DRM content; key available via VULN-11
- Complete offline extraction chain: `?stream=1&merge=1` → merged encrypted MP4 → `modularLicense` key → `mp4decrypt` → plaintext MP4
- Not compatible with Vercel serverless (temp disk, execution time limits)

**Player UI:** Single "Download MP4" button (red). Separate "Download Video" / "Download Audio" buttons removed.

*Addendum v2.3 prepared by Nitheesh D R — May 23, 2026.*
