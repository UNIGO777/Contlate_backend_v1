# Meta API Capacity Audit — Prachar

**Date:** 26 October 2026
**Scope:** Read-only audit of `Contlate_backend_v1`. No code, config, tokens, Meta settings or database records were modified. No live Meta API calls were made.
**Repository state audited:** working tree at time of audit, `master`.

Every claim below is labelled:

| Label | Meaning |
|---|---|
| **[MEASURED]** | Read directly from code at the cited path |
| **[DOC]** | Quoted from current Meta documentation, URL cited |
| **[CALC]** | Arithmetic from measured values and stated assumptions |
| **[ASSUMPTION]** | A modelling choice, stated so it can be challenged |
| **[UNVERIFIED]** | Cannot be resolved from this repository or public docs |

---

## 1. Executive summary

**Publishing volume is not the binding constraint. Job throughput is, and it binds roughly 8× earlier than any Meta quota.**

Three findings matter more than the capacity numbers:

1. **Every autopilot post for every customer is scheduled at the same instant.** `autoSchedulePosters` writes `scheduledAt` straight from the plan day with no stagger (`src/queues/scheduler.js:209`), and `autoPostTime` defaults to `"12:00"` for every business (`src/modules/plan/plan.controller.js:52`). The publisher drains 25 schedules per minute, sequentially. At ~1,200 customers the daily burst stops draining inside its own day; past that, posts are abandoned by the end-of-day retry deadline. **[MEASURED]**

2. **The Instagram quota formula is `4800 × Impressions`, and no minimum is documented.** A brand-new local business with no audience has impressions at or near zero. Whether that yields a near-zero call budget is **[UNVERIFIED]** and is the single most important thing to test before scaling, because Prachar's entire customer base is small local businesses starting from zero. **[DOC]**

3. **Two defects in the rate-limit path itself.** The 429 backoff computes `NaN` and retries instantly whenever `retry-after` is absent (`src/services/meta.service.js:233`), and container polling runs 6× more aggressively than Meta advises. Both make the app *worse* behaved precisely when a limit is being hit.

The app-level `200 × Users` rule that prompted this audit turns out to govern only onboarding and maintenance traffic — **not publishing**. Publishing is charged to per-account Business Use Case quotas instead. Applying `200 × Users` to publishing would have produced a capacity number that is wrong in both directions.

**Defensible verdict:** the current implementation safely supports **~1,000 customers**. Beyond that, fix the scheduling burst first. Meta quotas do not become the limiting factor until well past 10,000 customers — *if* the impressions question resolves favourably.

---

## 2. Architecture and Meta integration inventory

### 2.1 Two distinct Instagram paths **[MEASURED]**

The codebase maintains two separate Instagram integrations that use different hosts, different tokens and different code:

| | Instagram Login | Facebook Login for Business |
|---|---|---|
| Host | `graph.instagram.com/v22.0` | `graph.facebook.com/v21.0` |
| File | `src/services/instagram.service.js:201` | `src/services/meta.service.js:205` |
| Token | IG user token | Page access token |
| Detected by | `isInstagramLoginAccount()` — scopes starting `instagram_business_` (`instagram.service.js:286`) | fallback |
| Container polling | **Yes** (`waitForContainer`, line 252) | **No** (`meta.service.js:330`) |

Routing happens in `src/services/social.service.js:38-50`: Instagram Login is tried first, everything else falls through to the Graph path.

> **Risk:** the Graph path publishes a container immediately after creating it with no status check. That is the exact condition that produces error 9007 "Media ID is not available". The fix exists only on the Instagram Login path. **[MEASURED]**

### 2.2 API version configuration **[MEASURED]**

- Graph: `META_GRAPH_VERSION` env var, default `v21.0` (`src/config/env.js:170`)
- Instagram: hard-coded `v22.0` (`src/services/instagram.service.js:201`)

The two are pinned independently and can drift.

### 2.3 What is *not* implemented **[MEASURED]**

Confirmed absent by exhaustive grep:

- **No Meta insights or analytics calls whatsoever.** All analytics in the product are Google Business Profile, a separate API with separate quotas. The "daily analytics sync" scenario in the audit brief costs **zero Meta requests**.
- **No comment, message or engagement polling.**
- **No `content_publishing_limit` query.** The app never asks Meta how much publishing quota an account has left.
- **No video or Reels publishing.** Image posts only.
- **No pagination** on `/me/accounts` — `limit: 100`, single page (`meta.service.js:294`).

### 2.4 Rate-limit handling **[MEASURED]**

`graphFetch` (`src/services/meta.service.js:204`) is the only Graph wrapper. It:

- retries rate-limit errors at most twice
- reads `retry-after`, falling back to `x-app-usage`
- **never reads `x-app-usage` or `x-business-use-case-usage` proactively** — there is no throttling before a limit is hit, only reaction after

`src/services/instagram.service.js` does **not** use `graphFetch`. Its `igGet`/`igFetch` (lines 222, 231) call `fetch` directly with **no rate-limit handling, no retry and no backoff at all**.

---

## 3. Complete endpoint inventory

All paths relative to repository root. "Requests" counts real network calls.

| # | Operation | Endpoint | Ver | Trigger | Frequency | Req (typ) | Req (worst) | Token | Limit category | Code |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | OAuth code exchange (Meta) | `GET /oauth/access_token` | v21.0 | User connects | Once per connect | 1 | 1 | App | App-level | `meta.service.js:262` |
| 2 | Long-lived exchange | `GET /oauth/access_token` | v21.0 | After #1 | Once | 1 | 1 | App | App-level | `meta.service.js:278` |
| 3 | List Pages | `GET /me/accounts` | v21.0 | After #2 | Once | 1 | 1 | User | App-level | `meta.service.js:293` |
| 4 | Detect scopes | `GET /me/permissions` | v21.0 | After #3 | Once | 1 | 1 | User | App-level | `meta.service.js:556` |
| 5 | Webhook subscribe | `POST /{page}/subscribed_apps` | v21.0 | Page selected | Once per Page | 1 | 1 | Page | App-level | `meta.service.js:444` |
| 6 | OAuth exchange (IG Login) | `POST api.instagram.com/oauth/access_token` | — | User connects IG | Once | 1 | 1 | App | IG Platform | `instagram.service.js:84` |
| 7 | IG long-lived token | `GET /access_token` | v22.0 | After #6 | Once | 1 | 1 | IG user | IG Platform | `instagram.service.js:115` |
| 8 | IG profile | `GET /me` | v22.0 | After #7 | Once | 1 | 1 | IG user | IG Platform | `instagram.service.js:167` |
| 9 | **IG container create** | `POST /{ig}/media` | v22.0 | Publish | Per post | 1 | 1 | IG user | **IG BUC** | `instagram.service.js:316` |
| 10 | **IG container poll** | `GET /{container}` | v22.0 | After #9 | Per post | **2** | **30** | IG user | **IG BUC** | `instagram.service.js:256` |
| 11 | **IG publish** | `POST /{ig}/media_publish` | v22.0 | After #10 | Per post | 1 | 1 | IG user | **IG BUC** | `instagram.service.js:325` |
| 12 | IG permalink read-back | `GET /{media}` | v22.0 | After #11 | Per post | 1 | 1 | IG user | IG BUC | `instagram.service.js:291` |
| 13 | **FB Page publish** | `POST /{page}/photos` | v21.0 | Publish | Per post | 1 | 1 | Page | **Pages BUC** | `meta.service.js:318` |
| 14 | IG publish (Graph path) | `POST /{ig}/media` + `/media_publish` | v21.0 | Publish | Per post | 2 | 2 | Page | IG BUC | `meta.service.js:330` |
| 15 | Token refresh (Meta) | `GET /oauth/access_token` | v21.0 | Job, 6h | Per expiring acct | 1 | 1 | User | App-level | `tokenRefresh.job.js` |
| 16 | Token refresh (IG) | `GET /refresh_access_token` | v22.0 | Job, 6h | Per expiring acct | 1 | 1 | IG user | IG Platform | `instagram.service.js:142` |
| 17 | Health: token valid | `GET /me` | v21.0 | Job, 24h | Per acct / 7d | 1 | 1 | User | App-level | `accountHealthCheck.job.js:70` |
| 18 | Health: permissions | `GET /me/permissions` | v21.0 | After #17 | Per acct / 7d | 1 | 1 | User | App-level | `accountHealthCheck.job.js:81` |
| 19 | Health: Pages | `GET /me/accounts` | v21.0 | FB accts only | Per acct / 7d | 1 | 1 | User | App-level | `accountHealthCheck.job.js:107` |
| 20 | Health: IG detail | `GET /{ig}` | v21.0 | FB+IG linked | Per acct / 7d | 1 | 1 | User | App-level | `meta.service.js:516` |
| 21 | Connection state | `GET /me` | v21.0 | `/meta/connection-status` | On demand | 1 | 1 | User | App-level | `meta.service.js:651` |
| 22 | Webhook-triggered Pages | `GET /me/accounts` | v21.0 | Meta webhook | Per event | 1 | 1 | User | App-level | `meta.webhook.js:343` |

**Note on #21:** the frontend never calls `/meta/connection-status` (verified against `Contlate_frontend/lib/api.ts`). It is cached 5 minutes server-side regardless (`meta.service.js:476`). Not a volume contributor today.

---

## 4. Meta's documented rate limits

### 4.1 Application-level (Graph API) **[DOC]**

> "Calls within one hour = 200 * Number of Users"
> "The Number of Users is based on the number of unique **daily active users** an app has. In cases where there are slow periods of daily usage ... the weekly and monthly active Users are used."
> "This is not a per User limit but a limit on calls made by your app."

- **Source:** https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- **Window:** rolling 1 hour
- **Type:** dynamic — the denominator moves with your own activity
- **Monitoring:** `X-App-Usage` header — `call_count`, `total_cputime`, `total_time`, each a percentage of allowance
- **Errors:** code 4 (app-level), code 17 (user-level)

**What "Users" means here is the crux.** Meta says *daily active users of the app*. It does **not** say registered customers, connected accounts or Pages. For Prachar — where background jobs act on behalf of customers who may not open the app that day — whether those customers count toward DAU is **[UNVERIFIED]**. See §12.

### 4.2 Pages API **[DOC]**

> "Calls within 24 hours = 4800 * Number of Engaged Users"
> "The Number of Engaged Users is the number of Users who engaged with the Page per 24 hours."

- **Source:** as above
- **Applies to:** calls with a **Page access token** — i.e. operation #13, Facebook publishing
- **Window:** rolling 24 hours, **per Page**
- **Errors:** code 32, code 80001

### 4.3 Instagram Platform **[DOC]**

> "Calls within 24 hours = 4800 * Number of Impressions"
> "The number of times any content from the app user's Instagram professional account has entered a person's screen within the last 24 hours."
> "An app's call count is unique for each app and app user pair."

- **Source:** https://developers.facebook.com/docs/instagram-platform/overview/
- **Window:** rolling 24 hours, **per app + IG account pair**
- **Applies to:** operations #9–#12, #14 — all Instagram publishing
- **Minimum/floor for zero-impression accounts: not documented.** **[UNVERIFIED]**
- Documentation states rate limits do **not** differ between `graph.instagram.com` and `graph.facebook.com` for these endpoints

### 4.4 Instagram content publishing quota **[DOC]**

> "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period. Carousels count as a single post."
> "We recommend that your app also enforce the publishing rate limit, especially if your app allows app users to schedule posts to be published in the future."

- **Source:** https://developers.facebook.com/docs/instagram-platform/content-publishing/
- **Type:** hard quota, per IG account
- **Monitoring:** `GET /{ig-id}/content_publishing_limit` — **never called by this codebase** **[MEASURED]**

**Prachar enforces 25/day locally** (`src/constants/publishingLimits.js`), comfortably under Meta's 100. One caveat: the local counter uses **UTC calendar days** (`publish.service.js:22`) while Meta uses a **rolling 24-hour window**. At 25 vs 100 the headroom absorbs this; it would matter if the local cap were raised.

### 4.5 Container polling guidance **[DOC]**

> "We recommend querying a container's status once per minute, for no more than 5 minutes."

**Prachar polls every 2 seconds for up to 60 seconds** — `CONTAINER_POLL_MS = 2000`, `CONTAINER_MAX_WAIT_MS = 60000` (`instagram.service.js:247`). That is up to **30 polls where Meta advises at most 5**, and 30× the recommended frequency. **[MEASURED]**

### 4.6 Advanced Access **[UNVERIFIED]**

Whether the Meta app holds Advanced Access for `instagram_content_publish`, `pages_manage_posts` etc. cannot be determined from this repository. App review status lives in the Meta dashboard. Without Advanced Access, the app can only act for users with a role on the app, which caps real customers at ~25 regardless of every number below. **This must be confirmed before any scaling discussion.**

---

## 5. Request cost per workflow **[CALC]**

Derived from §3, with polling at 2 (typical) / 1 (best) / 30 (worst).

| Workflow | Best | Typical | Worst | Quota charged |
|---|---|---|---|---|
| Connect 1 IG (Instagram Login) | 3 | 3 | 3 | IG Platform |
| Connect 1 FB Page | 5 | 5 | 5 | App-level |
| Connect both | 8 | 8 | 8 | mixed |
| **1 IG post published** | **4** | **5** | **33** | IG BUC |
| **1 FB post published** | **1** | **1** | **1** | Pages BUC |
| 1 IG post, all retries exhausted | — | ~60 | ~396 | IG BUC |
| Token refresh, per account | 1 | 1 | 1 | App / IG |
| Health check, IG account | 2 | 2 | 2 | App-level |
| Health check, FB account | 4 | 4 | 4 | App-level |
| Daily analytics sync | **0** | **0** | **0** | — |

**Retry cost note [MEASURED]:** since the recent change, retryable failures retry hourly until the end of the client's calendar day rather than stopping after 5 attempts (`postPublisher.job.js`, `computeBackoffMs` + `retryDeadlineAt`). A post failing all day makes ~12 attempts. At 5 requests each that is ~60 requests for one undelivered post — 12× the cost of a successful one.

### Per-customer daily totals **[CALC]**

Assumes 1 IG + 1 FB connected (the plan cap is one per platform — `src/constants/limits.js`, `maxAccountsPerPlatform: 1`), and amortised maintenance of ~0.9 req/customer/day.

| Scenario | IG req | FB req | Maint | **Total/day** | Peak hour |
|---|---|---|---|---|---|
| Basic (1 post/day) | 5 | 1 | 0.9 | **6.9** | 6 (single burst) |
| Standard (2/day) | 10 | 2 | 0.9 | **12.9** | 6 |
| Heavy (5/day) | 25 | 5 | 0.9 | **30.9** | 6 |

**Peak hour ≈ 6 because all posts land in one instant** (§6.1), so the entire day's publishing traffic for a customer is concentrated, not spread.

---

## 6. Infrastructure capacity audit

### 6.1 The scheduling burst — the real bottleneck **[MEASURED]**

Three facts compound:

1. `buildDayDocuments` sets every day's `scheduledPostAt` to `autoPostTime` (`src/services/planGeneration.service.js:262`)
2. `autoPostTime` defaults to `"12:00"` for every business (`src/modules/plan/plan.controller.js:52`)
3. `autoSchedulePosters` writes `scheduledAt: new Date(day.scheduledPostAt)` with **no stagger** (`src/queues/scheduler.js:209`)

The `Schedule` model *has* a `staggerOffsetMinutes` field and the **manual** scheduling path uses it (`schedule.service.js:27`). The **autopilot** path does not. So every customer who never changes their posting time has all 28 days scheduled at exactly the same second.

Publisher throughput **[MEASURED]**:
- `BATCH_SIZE = 25`, `DEFAULT_INTERVAL_MS = 60000` (`postPublisher.job.js:21`)
- the batch loop is **fully sequential** — `await processOne(schedule)` inside a `for` loop (line 623)
- one IG publish is 4+ sequential HTTP calls including a ≥2s sleep → **~3–8 seconds**

**[CALC]** 25 sequential publishes ≈ 75–200 s, which exceeds the 60 s tick. `setInterval` has **no re-entrancy guard** (line 609), so ticks overlap. Duplicate publishing is prevented — `claimNext` is an atomic `findOneAndUpdate` flipping `pending → processing` (line 49) — but concurrency grows unbounded under backlog, which is itself a burst risk against Meta.

Conservative sustained throughput: **~20 publishes/minute**.

| Customers | Posts in burst | Drain time @20/min | Inside the day? |
|---|---|---|---|
| 100 | 200 | 10 min | ✅ |
| 500 | 1,000 | 50 min | ✅ |
| 1,000 | 2,000 | 1 h 40 m | ✅ |
| 5,000 | 10,000 | 8 h 20 m | ⚠️ marginal |
| 10,000 | 20,000 | 16 h 40 m | ❌ **exceeds the day** |

At 10,000 customers a 12:00 burst finishes at ~04:40 the following day. The end-of-day retry deadline marks everything unreached as `skipped`, so **a large fraction of posts are silently abandoned** — a correctness failure, not a rate-limit one.

### 6.2 Batch caps that break before quotas do **[MEASURED]**

| Job | Interval | Cap | Max accounts/day | Breaks at |
|---|---|---|---|---|
| `tokenRefresh` | 6 h | 50 | **200** | >200 accounts needing refresh |
| `accountHealthCheck` | 24 h | 50 | **50** | >350 accounts (7-day cycle) |

Both use a hard `.limit(BATCH_SIZE)` with no cursor or continuation (`tokenRefresh.job.js:45`, `accountHealthCheck.job.js:44`). At 1,000 customers (~2,000 accounts), token refresh covers 200/day against 2,000 needing periodic refresh. **Tokens will expire unrefreshed, and accounts will silently stop publishing.** This bites at roughly **100–200 customers** — far earlier than any Meta limit.

### 6.3 Queue and retry behaviour **[MEASURED]**

| Property | Finding |
|---|---|
| Worker concurrency | posterPrompt 10, posterImage 3, welcomePoster 2, contentPlan 5, gbpSync 2 |
| Publisher concurrency | 1 (sequential), but overlapping ticks |
| Duplicate publish risk | **Low** — atomic claim + `stillNeeded` guard |
| Stale lock recovery | Yes — `STALE_LOCK_MS` 10 min |
| Idempotency on Meta side | **None** — no idempotency key sent |
| Global API rate limiting | **None.** No limiter per app, per account or per token |
| Cross-customer fairness | Partial — `deferred` list prevents starvation *within* a tick only |
| Failed jobs amplifying traffic | **Yes** — ~12 retries/day/post, ~60 requests for one failed post |

### 6.4 Defects found in the rate-limit path

**(a) Zero-delay retry on 429** **[MEASURED]** — `src/services/meta.service.js:233`

```js
const retryAfterHeader = res.headers.get("retry-after") || res.headers.get("x-app-usage");
const waitMs = retryAfterHeader ? Math.min(parseInt(retryAfterHeader, 10) * 1000, 5*60*1000) : ...
```

`x-app-usage` is JSON — `{"call_count":25,...}`. `parseInt()` returns `NaN`; `Math.min(NaN, …)` is `NaN`; `setTimeout(fn, NaN)` fires immediately. Meta sends `x-app-usage` on virtually every Graph response, so whenever `retry-after` is absent — the common case — **the app retries a rate-limit error with no delay at all**, then does it again. Verified by direct evaluation.

**(b) No proactive throttling** **[MEASURED]** — `x-app-usage` and `x-business-use-case-usage` are never parsed for their percentages. The app cannot slow down at 80% usage because it never reads usage.

**(c) Instagram path has no retry handling at all** **[MEASURED]** — `igGet`/`igFetch` (`instagram.service.js:222,231`) call `fetch` directly. A 429 from `graph.instagram.com` surfaces as a generic error with no backoff. This is the path that carries **all** Instagram publishing.

**(d) Polling 6× over guidance** **[MEASURED]** — §4.5.

---

## 7. Capacity tables

**Shared assumptions [ASSUMPTION]:** 1 customer = 1 business; plan cap of 1 IG + 1 FB (`maxAccountsPerPlatform: 1`); all customers paid and active; posting at the default 12:00.

### 7.1 Instagram only

| Customers | IG accts | Posts/day | Req/day | Peak/hr | Quota | Utilisation | Bottleneck |
|---|---|---|---|---|---|---|---|
| 100 | 100 | 100 | 500 | 500 | 4800 × impressions, **per account** | 5 req/acct/day | None |
| 500 | 500 | 500 | 2,500 | 2,500 | per account | 5 req/acct/day | None |
| 1,000 | 1,000 | 1,000 | 5,000 | 5,000 | per account | 5 req/acct/day | Token refresh cap |
| 5,000 | 5,000 | 5,000 | 25,000 | ~3,000 | per account | 5 req/acct/day | **Publisher drain** |
| 10,000 | 10,000 | 10,000 | 50,000 | ~1,200 | per account | 5 req/acct/day | **Burst exceeds day** |

Because the IG quota is **per app-user pair**, total customer count never aggregates into one ceiling. 5 requests/account/day against `4800 × impressions` is immaterial **unless impressions ≈ 0** — see §12.

### 7.2 Facebook only

| Customers | Pages | Posts/day | Req/day | Quota | Utilisation |
|---|---|---|---|---|---|
| 100 | 100 | 100 | 100 | 4800 × engaged users, per Page | 1 req/Page/day |
| 1,000 | 1,000 | 1,000 | 1,000 | per Page | 1 req/Page/day |
| 10,000 | 10,000 | 10,000 | 10,000 | per Page | 1 req/Page/day |

Facebook publishing is **one request per post**. It is the cheapest operation in the system and will not be a constraint at any modelled scale. Same zero-denominator caveat applies to "Engaged Users".

### 7.3 Both platforms — combined workload

| Customers | Accts | Posts/day | Meta req/day | App-level req/day | App-level budget/hr | Verdict |
|---|---|---|---|---|---|---|
| 100 | 200 | 200 | ~690 | ~90 | 20,000 (DAU 100) | ✅ Comfortable |
| 500 | 1,000 | 1,000 | ~3,450 | ~450 | 100,000 | ⚠️ Token refresh cap |
| 1,000 | 2,000 | 2,000 | ~6,900 | ~900 | 200,000 | ⚠️ Refresh + drain |
| 5,000 | 10,000 | 10,000 | ~34,500 | ~4,500 | 1,000,000 | ❌ Drain 8 h |
| 10,000 | 20,000 | 20,000 | ~69,000 | ~9,000 | 2,000,000 | ❌ Posts abandoned |

**App-level utilisation never exceeds ~0.5% at any scale**, because publishing is charged to BUC quotas, not the app pool. The `200 × Users` rule is simply not where this system runs out of room — *provided* DAU is counted as assumed.

### 7.4 Best / typical / conservative

| | Polls/post | Retry rate | Req/customer/day | 1,000 customers |
|---|---|---|---|---|
| Best | 1 | 0% | 5.9 | 5,900/day |
| Typical | 2 | 5% | 6.9 | 6,900/day |
| Conservative | 4 | 20% | 14.2 | 14,200/day |

Even the conservative case is far under every documented aggregate quota.

---

## 8. Bottleneck ranking

| # | Bottleneck | Binds at | Severity | Evidence |
|---|---|---|---|---|
| 1 | `tokenRefresh` 50/batch cap | **~150 customers** | **Critical** — silent publish failure | `tokenRefresh.job.js:45` |
| 2 | `accountHealthCheck` 50/batch cap | **~350 customers** | High — stale health data | `accountHealthCheck.job.js:44` |
| 3 | Unstaggered burst + 25/min drain | **~1,200 customers** | **Critical** — posts abandoned | `scheduler.js:209` |
| 4 | Zero-delay 429 retry | Any scale, on first 429 | **High** — worsens throttling | `meta.service.js:233` |
| 5 | No retry/backoff on IG path | Any scale | High | `instagram.service.js:222` |
| 6 | Container polling 6× guidance | Any scale | Medium | `instagram.service.js:247` |
| 7 | Graph IG path lacks polling | Any scale | Medium — 9007 errors | `meta.service.js:330` |
| 8 | IG BUC with zero impressions | **Unknown** | **Unknown — possibly critical** | §4.3 |
| 9 | App-level `200 × DAU` | >100,000 customers | Low | §4.1 |

**Every Meta quota ranks below three infrastructure problems.**

---

## 9. Recommended strategy

### Required before exceeding ~150 customers

1. **Remove the batch caps.** Replace `.limit(50)` in `tokenRefresh` and `accountHealthCheck` with cursor-based iteration, or scale the cap with account count. Without this, accounts stop publishing silently.
2. **Fix the backoff bug.** Parse `x-app-usage` as JSON; never `parseInt` it. Fall back to a fixed 60 s when `retry-after` is absent.
3. **Stagger autopilot scheduling.** The `staggerOffsetMinutes` field already exists and the manual path already uses it. Apply a deterministic per-business offset (e.g. hash of `businessId` over a 0–59 minute window) at `scheduler.js:209`.

### Required before exceeding ~1,000 customers

4. **Redis-backed distributed limiter**, with separate buckets per category — app-level, per-IG-account, per-Page — since the quotas are genuinely different and sharing one bucket would throttle the wrong thing.
5. **Proactive throttling from headers.** Parse `x-app-usage.call_count` and `x-business-use-case-usage`; pause a bucket above 80%.
6. **Retry/backoff on the Instagram path.** Route `igGet`/`igFetch` through a shared wrapper with the same 429 handling as `graphFetch`.
7. **Publisher concurrency with a bounded pool** — e.g. 5–10 parallel publishes with a global cap — instead of a sequential loop racing an overlapping timer.

### Recommended

8. Query `GET /{ig}/content_publishing_limit` before publishing and cache per account per hour. Meta explicitly recommends this for apps that schedule.
9. Align container polling with guidance: 1 poll per minute, 5 max.
10. Add container polling to the Graph IG path, or retire that path entirely.
11. Switch the local daily cap to a rolling 24-hour window to match Meta's semantics.
12. Dead-letter queue for posts exhausting their retry window.
13. Send an idempotency key on publish to make retries safe.

---

## 10. Monitoring checklist

- [ ] `x-app-usage.call_count` — alert at 80%
- [ ] `x-business-use-case-usage` per IG account and per Page — alert at 80%
- [ ] `estimated_time_to_regain_access` — any non-zero value is an active throttle
- [ ] Meta error codes 4, 17, 32, 80001, 80004 — rate by hour
- [ ] Publisher backlog depth (`pending` with `scheduledAt <= now`) — alert above 500
- [ ] Burst drain time — alert if the daily burst takes >2 h
- [ ] Count of `skipped` plan days per day — should be near zero
- [ ] `tokenRefresh` accounts-needing-refresh vs accounts-processed — alert if the gap grows
- [ ] Accounts with `status: expired` — trend
- [ ] IG container poll count per publish — alert above 5
- [ ] Requests per endpoint / token type / customer

---

## 11. Unverified assumptions and how to resolve them

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| 1 | **Does the app hold Advanced Access?** | Without it, real customers cap at ~25 regardless of everything above | Meta App Dashboard → App Review → Permissions |
| 2 | **Is there a floor on `4800 × Impressions`?** | A new business has ~0 impressions. If the floor is 0, new customers may be unable to publish at all | Instrument `x-business-use-case-usage` on the next real publish for a low-audience account |
| 3 | **How does Meta count DAU for `200 × Users`?** | Determines whether the app-level pool is large or near-zero | Compare observed `call_count` percentage against known request volume |
| 4 | Same for "Engaged Users" on Pages | Same shape for FB publishing | Same method |
| 5 | Which IG path do live accounts use? | Graph path lacks polling and costs 2 req vs 5 | Query `grantedScopes` across `socialaccounts` |
| 6 | Real container finish time | Drives poll count, the largest variable in IG cost | Log poll counts per publish |
| 7 | Does Meta throttle per-app or per-token on `graph.instagram.com`? | Determines limiter granularity | Observe headers under load |

**Items 1 and 2 are blocking.** No capacity number in this report is safe to rely on until both are answered with live data.

---

## 12. Final verdict

**Supported by current evidence: ~1,000 customers**, and only after fixing the token-refresh batch cap, which otherwise degrades from ~150.

**What the evidence shows clearly:**
- Meta's published quotas are not the limiting factor at any scale modelled. Publishing is charged to per-account BUC quotas that do not aggregate across customers, and the app-level pool stays under 1% utilised even at 10,000 customers.
- The binding constraints are all local: two 50-row batch caps, and a scheduling burst with no stagger drained by a sequential 25/minute loop.
- The rate-limit handling code contains a defect that makes the app retry with zero delay exactly when Meta is asking it to slow down.

**What remains genuinely uncertain:**
- Whether Advanced Access is held. If not, the real ceiling is ~25 users.
- Whether `4800 × Impressions` has a floor. Prachar's customers are small local businesses with little or no audience — precisely the population this formula treats worst. This could invert the entire analysis, making per-account IG quota the first binding constraint rather than the last.

**Test before scaling:**
1. Confirm Advanced Access in the dashboard.
2. Log `x-business-use-case-usage` for one low-impression IG account across a full publish, and read the actual denominator.
3. Load-test the publisher with 500 schedules at one timestamp and measure real drain time.
4. Verify token refresh covers the full account set at 200+ accounts.

Until 1 and 2 are answered, treat **1,000 customers as a planning figure, not a guarantee**.

---

## Sources

- [Graph API Rate Limits — Meta for Developers](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [Instagram Platform Overview — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/overview/)
- [Publish Content using the Instagram Platform — Meta for Developers](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
