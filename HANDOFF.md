# applyapply: model handoff

Updated: 2026-09-25

applyapply writes job applications. It finds postings that fit a person, writes a
resume tailored to each posting plus a cover letter and answers to the form's own
questions, and makes sending it fast. It never submits an application.

Express + Postgres on Railway, a Chrome MV3 extension, a text line over Sendblue,
an MCP server for agents, Claude for writing, Jev (TypeSafe) for judgment, Stripe
for credits.

## Where it runs

| | |
|---|---|
| Site | https://applyapply.xyz |
| Health | https://applyapply.xyz/health (reports `version`) |
| Server version | 0.72.0 |
| Extension | **1.21.0 in the working tree, 1.19.3 in the Chrome Web Store** |
| Deploy | push to `main`, Railway builds and restarts. No other step. |
| Repo | github.com/chadwittman/applyapply, local at `~/job-search` |

Railway project `remarkable-education`, service `applyapply`, production
environment. Secrets live in Railway variables and in a gitignored local `.env`;
never commit either. Names only: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`,
`SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_API_BASE`,
`SENDBLUE_FROM_NUMBER`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`,
`HYPERBROWSER_API_KEY`, `APPLYAPPLY_JWT_SECRET`, `APPLYAPPLY_ADMIN_SECRET`,
`IMESSAGE_TESTERS`.

### The extension does not deploy with the server

There are two channels and they move at different speeds.

`/extension.zip` is built from the deployed tree at request time, so pushing to
`main` does publish the extension: the site serves the current version within a
minute of a deploy, and `/extension` is a real distribution channel.

The Chrome Web Store is the other one, and it still serves **1.19.3**, tagged
`store-1.19.3`. It is the only channel that updates silently for people who
already installed. A zip install is a snapshot: it does not update itself, so
somebody who installed last week is running last week's extension until they
download again. The sidebar tells them when that has happened.

`test/run.sh` replays the extension suites against every `store-*` tag, so
server changes must stay compatible with what is actually installed out there.

**In 1.21.0, downloadable now, not yet in the Web Store:**

1. Fills a form inside a cross-origin iframe (Comparably fronting Greenhouse: the
   top frame has zero inputs and all 30 fields are in the embed).
2. Fills "Full Name", Ashby's standard field, which matched no rule before.
3. Places unrecognised fields by meaning through `/fill/map` (Jev), instead of a
   regex per label.
4. Says when a form is in an iframe it cannot reach, and links that form's own page.
5. The mic is the emoji, not an emoji on a filled circle.
6. A job opened from applyapply's own pages opens the sidebar by itself.

## Model choices

| Job | Model | Why |
|---|---|---|
| Kits, resumes, cover letters | `claude-sonnet-5`, low effort | Measured 21s vs Sonnet 4.6's 34s with equal or better writing |
| Text line agent | `claude-haiku-4-5-20251001` | Decides and writes a sentence; does not write the resume |
| Titles, form fields, answer reuse, bullet relevance, interest | Jev (TypeSafe) | ~180ms, ~$0.00003 a call |

Pattern used throughout: **deterministic rules first, a model for the tail, the
result cached.** Word rules place 79% of job titles; Jev reads the rest and the
decision is kept per distinct title forever. Same shape for form fields and for
answer reuse. Before rejecting a model call on cost, check whether the unit of
work is cacheable, which is the mistake made once here already.

## Map

```
server/server.js      every route, all pages (large; the site is server-rendered)
server/conversation.js the text line: state machine, tools, voice
server/agent.js       the tool-calling loop for the text line
server/intent.js      reads what a text means when no command matches
server/voice.md       what applyapply is, never does, charges, and how it writes
server/sendblue.js    send, react, parse inbound, phone normalisation
server/roles.js       title -> {functions[], seniority} word rules
server/title-class.js Jev title classification with a permanent cache
server/field-map.js   form field -> profile value, by meaning
server/interest.js    how interesting a job looks to one person
server/fast-kit.js    answer reuse, resume structure, bullet judgment
server/resume-dates.js one date format across a resume
server/card.js        the unfurl image for a kit link
server/db.js          schema and every query
source.js             sourcing and the shared listings ingest
extension/            MV3: content.js (sidebar + filling), background.js
test/run.sh           the whole suite: throwaway Postgres, real server, real Chrome
```

## Text line status

**Working and verified in production:** inbound webhook (`POST
/sendblue/webhook`), outbound replies, phone verification both ways (a texted
link, or a six-digit code from the profile page), STOP/START/HELP, kit writing
from a texted job link, gap questions one at a time, voice notes with credit
charging past two minutes, corrections, the agent answering in plain English.

**Built but never seen working against the real service:**

- **Sending tapback reactions.** `POST /api/send-reaction` is documented; its
  `from_number` field is ambiguous and is being sent as the conversation's
  number. A 👋 on "hey" is the thing to watch.
- **Receiving tapbacks.** Undocumented entirely. Inbound reads a named field,
  the plain-text SMS form (`Liked "…"`), and a bare emoji. Unknown payloads log
  their **keys only** (`[sendblue] unread payload`), so the real shape can be
  learned from the Railway log without a message body landing in it.
- **Inline reply resolution.** Every role is texted as its own message and the
  outbound handle is stored against that role, so replying to one message should
  resolve to that job. The inbound field carrying the reply target is guessed
  from five plausible names. The numbered and by-name paths work regardless.

**Identity, which is the part worth not breaking:** a number in a From field
proves nothing. An unrecognised number gets exactly one reply, a link good for
thirty minutes, spent in a browser where the person is already signed in. It is
never told whether an account exists. Codes are hashed at rest, single use, five
wrong guesses burn them. A number belongs to one account.

## Sourcing and coverage

12,512 postings, 11,395 distinct jobs, five sources: Himalayas 6,687, a16z 3,012,
Sequoia 2,450, Hacker News 259, We Work Remotely 104. Browse them at `/listings`.

Roughly 9% of rows were redundant because boards list one job once per location;
they collapse by company plus role. 35% carry no function, mostly genuinely not
product or growth work (Himalayas is a general remote board).

**The coverage plan, not yet built.** Greenhouse, Lever, Ashby and Workday are
read one posting at a time, on demand. Their board APIs are free, unauthenticated
and enumerable by company token:
`boards-api.greenhouse.io/v1/boards/{token}/jobs` returns a whole company in one
call. Harvest tokens from every job link anyone sends us, crawl them wholesale,
dedupe across sources. That is the unlock, and it is also the prerequisite for
selling normalised job data to agents over MCP, which was discussed and not
started.

## How to work here

```bash
bash test/run.sh                      # everything: ~31 suites, needs local Postgres + Chrome
AA_TEST_SUITES="test/foo.mjs" bash test/run.sh   # one suite
node --check server/server.js         # syntax only
```

`test/run.sh` exits non-zero on failure. **Check the exit status, not the tail of
the output**; a passing final line above a failed suite has caused a red commit
here before.

House rules, learned the hard way:

- **No em dashes anywhere in our own copy.** The text line and the site are lower
  case and brief. `server/voice.md` is the source of truth for tone and for every
  claim the product makes about itself; a test binds its prices to the code.
- **Dash handling uses unicode escapes (U+2014, U+2013)** in `cleanEmDashes`,
  because a bulk find-and-replace over the file once rewrote that regex into a
  hyphen and put a period inside every date range in production.
- **Quality over speed for anything written.** Do not swap a model-written piece
  for a faster stand-in unless it shortens the wait the person actually sees.
- **Anything guaranteed by construction becomes a prompt line when an agent takes
  over.** When the text line became agent-written, the kit link stopped arriving
  because the model had to remember to include it. Links are now appended in code
  after the model replies. Look for that class of regression.
- Bump `VERSION` in `server/server.js` and the extension manifest each session.

## Open, in rough priority order

1. **Submit extension 1.21.0 to the Chrome Web Store.** It is downloadable from
   `/extension` today, but only the store updates existing installs silently.
2. **Verify the three unverified Sendblue behaviours** above from a real phone.
3. **Crawl ATS board tokens** for coverage.
4. Backups are unverified; resume PDFs live in Postgres (~90 users on a 500MB
   volume); there is no error tracking; a live Stripe purchase has never been
   tested end to end.
5. `/about` still has unknowns: HQ city, social links, whether to publish the
   founder backstory.
