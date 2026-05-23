# 13 — OWASP Top 10 Mapping

**[← Web Security Fundamentals](12-api-security-fundamentals.md) · [Back to Overview →](01-overview.md)**

> **Author:** Nitheesh D R

---

## What Is the OWASP Top 10?

The **Open Web Application Security Project (OWASP) Top 10** is the industry-standard list of the most critical web application security risks. Security teams, developers, and auditors use it as a common language for describing vulnerabilities.

Updated every few years (current version: 2021), it ranks risks by:
- Prevalence (how common is this type of vulnerability?)
- Detectability (how hard is it to find?)
- Technical impact (how bad is exploitation?)

---

## SunNXT Findings Mapped to OWASP Top 10 (All 20 Vulnerabilities)

| OWASP Category | SunNXT Vulnerabilities | Highest Severity |
|---|---|---|
| A01 — Broken Access Control | VULN-03, VULN-05, VULN-07, VULN-14, VULN-15, VULN-16, VULN-17 | **Critical** (VULN-16) |
| A02 — Cryptographic Failures | VULN-01, VULN-02, VULN-18 | High (VULN-01) |
| A03 — Injection | VULN-17, VULN-19 | Low (VULN-17) |
| A04 — Insecure Design | VULN-06, VULN-12, VULN-20 | High (VULN-06) |
| A05 — Security Misconfiguration | VULN-09, VULN-14 | Medium (VULN-14) |
| A07 — Identification & Auth Failures | VULN-04, VULN-08, VULN-10, VULN-11 | **Critical** (VULN-11) |
| A08 — Software Integrity Failures | VULN-13 | Medium (VULN-13) |
| A09 — Security Logging Failures | VULN-09 | Low |

**New findings (VULN-11 to VULN-20)** reveal two critical vulnerabilities that enable complete subscription bypass — see [SECURITY_REPORT.md](../SECURITY_REPORT.md) and [COMPREHENSIVE.md](COMPREHENSIVE.md) for full details.

---

## A01: 2021 — Broken Access Control

**Ranked #1** in OWASP 2021. Access control restricts what authenticated users are allowed to do. Failures mean users can act outside their intended permissions.

### VULN-03: Device Registration Limit Bypass

**OWASP test case:** WSTG-AUTHZ-02 (Testing for Bypassing Authorization Schema)

The device limit is an access control: "You are only allowed to register N devices." The bypass works because:
- The access control is enforced at UI level (the 423 response and webview)
- The underlying API (`removeDevice`) doesn't verify the user is the account owner

```
Access Control Model (what should happen):
  removeDevice allowed IF: current_session.userId == device.ownerId

Actual implementation:
  removeDevice allowed IF: valid token in URL (no session check)
```

**OWASP principle violated:** *"Deny by default — access should require explicit permission, not just absence of a deny."*

### VULN-05: ManageDevices Missing Access Control

This is a classic **IDOR (Insecure Direct Object Reference)** — the object reference is the `token` parameter, and it's not validated against the requesting user's identity.

**Detection method:** In a security test, access the ManageDevices URL from a different session (different browser, private window) using the same token. If it works → IDOR confirmed.

### VULN-07: Geo-Block Bypass

**OWASP test case:** WSTG-AUTHZ-03 (Testing for Privilege Escalation)

Geo-restrictions are access control: "Users in non-India IPs are not authorized to access paid content." Checking the IP only at login is access control that can be bypassed.

---

## A02: 2021 — Cryptographic Failures

Previously called "Sensitive Data Exposure." Focuses on failures related to cryptography that expose sensitive data.

### VULN-01: Static AES Key in Client JavaScript

**OWASP test case:** WSTG-CRYP-04 (Testing for Weak Encryption)

The key questions OWASP asks for cryptography:
1. Is encryption used where it should be? ✓ (yes, login payload is encrypted)
2. Is the algorithm strong? ✓ (AES-128 is acceptable)
3. Are keys properly managed? ✗ (**Key is in client-side code**)
4. Is the implementation correct? ✗ (Static IV)

**CWE reference:** CWE-321 (Use of Hard-coded Cryptographic Key)

This is especially dangerous because of the **false sense of security** it creates: developers see their traffic is "encrypted" and think it's safe, when in reality the encryption provides no security benefit.

### VULN-02: Static All-Zero IV

**CWE reference:** CWE-329 (Not Using a Random IV with CBC Mode)

In the context of OWASP A02:
- The key is already compromised (VULN-01)
- The static IV makes the encryption deterministic
- Combined: credentials are essentially transmitted in plaintext to anyone who inspects the JS bundle

**How to test:** Capture two login requests with the same password. Compare the first 32 hex characters of the encrypted payload. If they're identical → static IV confirmed.

---

## A07: 2021 — Identification and Authentication Failures

Previously "Broken Authentication." Covers weaknesses in confirming the user's identity and maintaining that identity over time.

### VULN-04: Long-Lived Sessions

**OWASP test case:** WSTG-SESS-07 (Testing Session Timeout)

OWASP recommends:
- Idle timeout: 2–30 minutes (financial: 2 min, streaming: 30 min–24h)
- Absolute timeout: 8 hours–30 days depending on risk
- Re-authentication for sensitive actions (password change, device management)

**How to test:**
1. Log in → copy session cookie value
2. Wait 24+ hours without any activity
3. Use the saved cookie in a new request
4. If it still works → no idle timeout ✗

### VULN-10: No Rate Limiting on Login

**OWASP test case:** WSTG-ATHN-03 (Testing for Weak Lock Out Mechanism)

OWASP minimum requirement: accounts should lock after 10 failed attempts.

**How to test:**
```bash
# Send 20 consecutive failed login attempts
# Observe: Does response time increase? Does a lockout occur? CAPTCHA appear?
for i in $(seq 1 20); do
  curl -s -X POST "https://www.sunnxt.com/next/api/login" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "payload=invalid_payload_test_$i&version=1"
done
# If all 20 return the same error (no lockout) → vulnerability confirmed
```

---

## A04: 2021 — Insecure Design

New in 2021. Distinguishes design flaws from implementation bugs. "You can't fix an insecure design with a perfect implementation."

### VULN-06: CDN Tokens Without IP Binding

This is an **insecure design** choice: the system was designed to use time-limited tokens without IP binding. No amount of implementation fixes will help — the Akamai token configuration needs to change.

**OWASP secure design principle violated:** *"Limit exposure — if someone can share stream URLs, design the system to detect and prevent sharing."*

### VULN-08: DRM JWT IP Bound to Server, Not Browser

Also an insecure design: the architecture routes DRM license requests through a server proxy, but the IP binding was designed for direct browser-to-Nagravision requests. The proxy architecture makes IP binding ineffective.

**Design fix required:** Either:
1. Don't proxy license requests (bind to browser IP directly), or
2. Pass the end-user's IP in a trusted header to Nagravision, or
3. Remove IP binding in favor of shorter expiry + maxUses=1

---

## A05: 2021 — Security Misconfiguration

Covers missing security hardening, improper configurations, or default settings.

### VULN-09: HTTP 200 for Error States

**Why this is misconfiguration:** HTTP status codes are part of the security infrastructure. Monitoring systems, WAFs (Web Application Firewalls), and rate limiters use HTTP status codes to detect anomalies.

If geo-blocks return 200, a WAF configured to alert on 403/451 responses won't trigger. If brute force returns 200 (with an error body), rate limiters that count 4xx responses won't count it.

**Correct mapping:**
```
Geo-blocked content:          451 Unavailable For Legal Reasons
Subscription required:        402 Payment Required  
Authentication required:      401 Unauthorized
Missing credentials:          403 Forbidden
Content not found:            404 Not Found
```

---

## A06: 2021 — Vulnerable and Outdated Components

Not directly found in this assessment (we didn't test third-party library versions), but worth noting:

**Observation:** SunNXT uses `x-ucv: 5` (client version 5). Older API versions may still be accessible at `x-ucv: 1` through `4`. Older API versions sometimes have fewer security controls than current versions.

**Test:** Try the same login/media requests with `x-ucv: 1` through `x-ucv: 4`. If different responses or missing validation → vulnerable legacy API.

---

## A08: 2021 — Software and Data Integrity Failures

### Observation: Response Integrity

The AES encryption on API responses is supposed to ensure integrity (responses haven't been tampered with). But since:
- The key is public (VULN-01)
- The IV is static (VULN-02)

An attacker who can perform a MITM attack could potentially:
1. Intercept an encrypted response
2. Decrypt it with the known key
3. Modify the data
4. Re-encrypt with the same key + IV
5. Forward the modified response

This is a **data integrity failure** — the encryption provides no authentication (no HMAC/signature to verify the message is from the genuine server).

---

## A09: 2021 — Security Logging and Monitoring Failures

### Observation: No Anomaly Detection Observed

During testing, the following suspicious activities were performed without triggering any visible security response:
- 20+ rapid consecutive login attempts
- Login from multiple different User-Agent strings
- Multiple device removals in rapid succession
- Accessing the ManageDevices page from different sessions with the same token

This suggests the platform may lack security event logging and anomaly detection.

**OWASP recommendation:** Log all authentication events (success and failure), alert on:
- >5 failed logins from same IP in 5 minutes
- Login from a new country
- Sudden surge in API calls
- Multiple device registrations/removals

---

## Summary: OWASP Coverage of SunNXT Findings

```
OWASP A01 (Broken Access Control):        VULN-03, VULN-05, VULN-07  ← 3 findings
OWASP A02 (Cryptographic Failures):       VULN-01, VULN-02            ← 2 findings  
OWASP A04 (Insecure Design):              VULN-06, VULN-08            ← 2 findings
OWASP A05 (Security Misconfiguration):    VULN-09                     ← 1 finding
OWASP A07 (Auth Failures):               VULN-04, VULN-10            ← 2 findings
─────────────────────────────────────────────────────────────────────
                                          10 total findings
```

All findings map cleanly to the OWASP Top 10. This confirms the assessment covered the most important risk categories and that SunNXT's security posture has room for improvement across multiple OWASP dimensions.

---

## Recommended Reading

To learn more about each OWASP category:

| Resource | URL |
|---|---|
| OWASP Top 10 2021 | owasp.org/Top10 |
| OWASP Testing Guide v4.2 | owasp.org/www-project-web-security-testing-guide |
| OWASP WSTG Checklists | github.com/OWASP/wstg/tree/master/checklists |
| CWE Dictionary | cwe.mitre.org |
| NVD CVSS Calculator | nvd.nist.gov/vuln-metrics/cvss |
| HackTricks (practical testing) | book.hacktricks.xyz |
| PortSwigger Web Academy (free labs) | portswigger.net/web-security |

---

**[Back to Overview →](01-overview.md) · [Read Full Security Report →](../SECURITY_REPORT.md)**
