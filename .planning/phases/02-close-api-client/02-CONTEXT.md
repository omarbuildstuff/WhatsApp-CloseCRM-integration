# Phase 2: Close API Client - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Phone numbers resolve to Close leads reliably without exhausting the rate limit. This phase delivers the CloseApiClient with retry logic, PhoneCache with 1-hour TTL, and E.164 phone normalization from WhatsApp JIDs.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

Key constraints from project research:
- Close API uses Basic auth with API key as username, empty password
- Phone number lookups must use 1-hour cache in close_phone_cache table
- libphonenumber-js needs to be installed for E.164 normalization
- Close API rate limit is ~100 requests/minute — must implement backoff retry on 429

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- src/config.ts — typed config with required() helper, has CLOSE_API_KEY
- src/db/pool.ts — PostgreSQL pool singleton
- src/db/schema.ts — close_phone_cache table already defined
- axios already in dependencies

### Established Patterns
- TypeScript strict mode, ES2022 target, CommonJS
- Singleton exports (pool, sessionManager)
- Parameterized SQL queries with $1, $2 placeholders

### Integration Points
- close_phone_cache table: phone TEXT PRIMARY KEY, lead_id TEXT, cached_at TIMESTAMPTZ
- Phase 3 will import the Close API client and phone cache for inbound message sync

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
