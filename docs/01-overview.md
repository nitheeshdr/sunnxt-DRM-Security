# 01 — Project Overview

**[← Back to README](../README.md) · [Next: Architecture →](02-architecture.md)**

---

## What Is This Project?

This is a **reverse-engineered SunNXT clone** built with Next.js 15. It replicates the core functionality of the SunNXT OTT (Over-The-Top) streaming platform by:

- Calling SunNXT's real REST APIs
- Decrypting encrypted API responses using the AES-128 key discovered in their client-side JavaScript
- Proxying video streams through a Next.js server to bypass CORS restrictions
- Handling DRM (Widevine/PlayReady) license acquisition via a server-side proxy

This project was built as a **security research and learning tool** to understand how OTT platforms implement authentication, encryption, CDN delivery, and DRM — and to identify security weaknesses for responsible disclosure to SunNXT.

---

## Why Build a Custom Client?

### The Limitation of Browser-Only Testing

Most OTT security research stops at observing network traffic in Chrome DevTools. That gives you a one-shot view:
- You see individual requests and responses
- Encrypted responses appear as opaque blobs
- You can't test behavior across session states automatically
- You can't replay requests with modified parameters at scale

### What a Programmable Client Enables

By building a full working client that:
1. **Knows the encryption key** → can decrypt ALL responses programmatically
2. **Automates session lifecycle** → login, logout, re-login, device management
3. **Proxies any request** → observe CORS and CDN behavior from server side
4. **Integrates Shaka Player** → test DRM license flows end-to-end

...we gain the ability to do **systematic, repeatable security testing** that's impossible through a browser UI alone.

---

## What Security Issues Were Found?

During this project, **20 security vulnerabilities** were identified across the SunNXT platform:

| Severity | Count | Examples |
|---|---|---|
| **Critical** | 2 | DRM license endpoint has no auth (VULN-11); server subscription shared to all users (VULN-16) |
| **High** | 4 | Static AES key in client JS; wildcard CDN token; permanent UUIDs; permanent access chain |
| **Medium** | 8 | Device limit bypass, no rate limiting, phone enumeration, geo-block bypass, and more |
| **Low** | 3 | DRM JWT reuse, HTTP 200 for errors, heartbeat injection |
| **Informational** | 3 | Key in multiple files, regex injection, best-practice gaps |

See [SECURITY_REPORT.md](../SECURITY_REPORT.md) for the full detailed report.

The most critical finding: **the DRM license endpoint issues Widevine decryption keys without any authentication or subscription check (VULN-11)**. Combined with a wildcard CDN token (`acl=/*`, VULN-06) and permanent content UUIDs (VULN-12), this enables complete subscription bypass.

The foundational discovery: **the AES-128 encryption key used to "secure" API responses is shipped to every browser** in SunNXT's client-side JavaScript. Anyone can find it in Chrome DevTools in 30 seconds.

---

## What This Research Demonstrates

This research demonstrates a complete chain from "unsubscribed user" to "full premium content access":

1. **CDN access** — wildcard hdntl token (`acl=/*`) lets any token cover all content (VULN-06)
2. **Permanent CDN paths** — content UUIDs never rotate (VULN-12)
3. **DRM keys without auth** — modularLicense issues keys without any auth (VULN-11)
4. **Self-refreshing** — hdntl tokens auto-renew from MPD segment templates

The three fixes that would break this chain: scope hdntl tokens per-content, add auth to modularLicense, and rotate CDN paths periodically.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server-side API proxying + React UI |
| Language | TypeScript | Type safety across all API shapes |
| Styling | Tailwind CSS | Rapid UI development |
| Video Player | Shaka Player 5.x | DASH + HLS + Widevine/PlayReady DRM |
| Encryption | CryptoJS | AES-128-CBC matching SunNXT's implementation |
| Deployment | Vercel (Mumbai region) | Indian IP for geo-unrestricted API access |

---

## Project Structure

```
sunnxt-clone/
├── app/
│   ├── page.tsx                        # Homepage (carousels, trending)
│   ├── login/page.tsx                  # Two-step login flow
│   ├── player/[contentId]/page.tsx     # Video player + DRM
│   └── api/
│       ├── auth/login/route.ts         # Login proxy
│       ├── auth/status/route.ts        # Account lookup
│       ├── media/[contentId]/route.ts  # Stream URL resolver + normalizer
│       ├── stream-proxy/route.ts       # CORS-bypass CDN proxy
│       ├── license/route.ts            # DRM license proxy
│       └── heartbeat/route.ts          # Playback heartbeat
├── lib/
│   ├── api.ts                          # Browse/search/catalogue API
│   └── sunnxt-session.ts               # Server-side session management
├── docs/                               # This documentation
└── SECURITY_REPORT.md                  # Full security assessment by Nitheesh D R
```

---

## Recommended Learning Order

| Step | Document | What You Learn |
|---|---|---|
| 1 | [Architecture](02-architecture.md) | How 3 layers (browser, server, SunNXT) interact |
| 2 | [API Encryption](03-api-encryption.md) | AES-CBC, why static keys are dangerous |
| 3 | [Session & Auth](04-session-auth.md) | Login flow, cookies, device limits |
| 4 | [CORS Proxy](05-cors-proxy.md) | Browser security model, how proxies work |
| 5 | [Video Player](06-video-player.md) | DASH/HLS adaptive streaming |
| 6 | [DRM](07-drm.md) | Widevine, PlayReady, FairPlay — content protection |
| 7 | [Geo & Security](08-geo-security.md) | Geo-blocking, all security findings |
| 8 | [Vulnerability Deep Dive](10-vulnerability-deep-dive.md) | Each vulnerability explained in depth |
| 9 | [Web Security Fundamentals](12-api-security-fundamentals.md) | Core concepts behind all findings |
| 10 | [OWASP Mapping](13-owasp-top10-mapping.md) | How findings map to the OWASP Top 10 |

---

**[Next: Architecture →](02-architecture.md)**
