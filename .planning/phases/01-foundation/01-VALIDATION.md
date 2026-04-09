---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-09
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner or tsx scripts |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `npx tsx src/db-init.ts` |
| **Full suite command** | `npm run build && node dist/db-init.js` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsx src/db-init.ts`
- **After every plan wave:** Run `npm run build`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | SESS-02 | — | N/A | integration | `npx tsx src/db-init.ts` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | SESS-03 | — | N/A | integration | `npm run build` | ❌ W0 | ⬜ pending |
| 1-01-03 | 01 | 1 | SESS-04 | — | N/A | integration | `npm run build` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/db-init.ts` — schema initialization script
- [ ] `src/db.ts` — database connection pool

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Session reconnects on network drop | SESS-03 | Requires live WhatsApp connection | Connect session, kill network, verify reconnect |
| Terminal disconnect stops reconnect | SESS-04 | Requires device logout | Connect session, log out from phone, verify status changes to needs_qr |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
