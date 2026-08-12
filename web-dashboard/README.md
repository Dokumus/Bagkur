# Job Seeker — Dashboard, Scanner & Application Toolkit

A local, zero-dependency web dashboard and job-scanning toolkit built on top of
[career-ops](https://github.com/santifer/career-ops). It discovers, scores and
tracks job openings against a candidate CV, and helps draft the application
materials. Target roles, companies and locations are fully configurable.

> Built with Node.js (built-in `http` + `fetch` only — no npm dependencies) and a
> single-file vanilla-JS dashboard. All personal data stays local and git-ignored.

## What it does

**1. High-volume discovery (`scan-jobs.mjs`)**
- Pulls full job lists directly from public ATS job-board APIs — **Greenhouse,
  Lever, SmartRecruiters, Ashby, Recruitee and Personio** — for every tracked company.
- Scrapes **LinkedIn's guest jobs endpoint** (no login) across role × location.
- Accepts user-added sources: an ATS board, a LinkedIn search link, or a plain
  careers page (it discovers the embedded/by-name ATS board automatically).
- Pulls **external job boards** defined in `config/job-boards.json` via adapters in
  `scan-boards.mjs` — Türkiye: **kariyer.net** (server-rendered search, Turkish
  keywords) and **techcareer.net** (Next.js data blob); Europe: **Arbeitnow**;
  remote: **Remotive, Jobicy, Himalayas** (only postings open to Türkiye/EU —
  US-only remote is dropped). These catch jobs at companies with no tracked ATS.
- Filters by title keywords + location scope, de-duplicates against history, and
  writes new in-scope offers to the pipeline.
- `--dry-run` fetches and filters everything but writes nothing (use when adding
  a source): `npm run scan:dry`.

**1b. Source health check (`probe-job-sources.mjs`)**
- `npm run sources:probe` hits every enabled board and reports count + field
  quality. HTML-parsing sources break silently when a site changes its markup;
  this makes that visible (exit code 1 if any source is broken).

**2. JD caching (`fetch-jds.mjs`)**
- Fetches each posting's full job description (LinkedIn JSON-LD, Greenhouse/Lever
  APIs, generic HTML) into a local cache so scoring is fast and reliable.

**3. Scored dashboard (`server.mjs` + `index.html`)**
- Reads the application tracker + evaluation reports and serves a scored job board
  with a clean, modern dark UI.
- Cards show **score ring, company avatar, sector, seniority, deadline, language
  requirement and fit-gap** (strong matches vs. known gaps), with a direct apply link.
- **Click a card → a side drawer renders the full evaluation report** (match table,
  gaps, verdict) inline.
- **One scan button** triggers the scanner as a child process and refreshes the
  board when new offers land.
- **One Evaluate button** turns discovered jobs into scored ones: in the background
  it caches the JDs, runs the bundled Claude Code CLI **headlessly** to write an
  evaluation report + tracker line per job (scored against your CV/profile, with
  language and role-fit caps), and merges them so the **To Apply** tab fills with
  ranked cards. Uses your existing Claude sign-in — no API key.
- Tabs: **To Apply / Discovered / Applied / Archive / Discarded / All**. Filter and
  sort by search, sector, min-score, score/date/deadline/company. Filters and the
  active tab persist across reloads; keyboard shortcuts (`/`, `Esc`, `1`–`6`).
- One-click actions (**Applied / Not-interested / Archive / restore**) write back to
  the tracker, which feeds the scanner's de-dup so nothing re-surfaces.
- Editable **location scope** and **sources** panels that drive the scanner.

**4. Application helpers (generated live from the CV + each job's evaluation)**
- **Cover letter** — a plain, natural, CV-consistent English letter tailored to the
  job's strongest matches. Editable, copy/download, regenerate for variants.
- **Interview prep** — pick the interviewer (**HR / Hiring Manager / Technical /
  Director**) and get persona-specific questions with CV-grounded sample answers.
- **Pros & Cons** — a rational, critical read of the job against the CV: strengths,
  real risks (language blockers, role adjacency, seniority/agency flags) and a
  bottom-line call.
- **Reference finder** — surfaces the people worth contacting for a referral:
  hiring manager / future peer / recruiter, plus **warm paths** derived from the CV
  (alumni and ex-colleagues now at the company). Each gives two LinkedIn searches —
  *all at company* and *2nd-degree* (reachable) — and a ready-to-send connection
  note. Set a company's LinkedIn id once for a strict *current-employees* filter.
  It never invents names: links open in your own LinkedIn session.

> All helpers parse the CV live, so updating the CV updates the output. They
> deliberately avoid AI-slop phrasing and never invent experience.

## Run it

```bash
# dashboard  → http://localhost:4317
npm run dashboard

# discover new jobs (needs the system CA store on some machines)
npm run scan:local

# cache job descriptions for offline scoring
node --use-system-ca web-dashboard/fetch-jds.mjs
```

## Notes
- Personal data (CV, profile, tracker, reports, `.env`, location/source config) is
  git-ignored and never committed — this repo contains tool code only.
- Built on the open-source [career-ops](https://github.com/santifer/career-ops)
  framework (MIT). See the repo root `LICENSE`.
