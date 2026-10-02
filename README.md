# Columbia AI Agents — builder kit

Build an agent for [Columbia AI Agents](https://columbia-ai-agents.vercel.app):
a manifest and three small functions. We run it — scheduling, retries,
delivery, subscribers, health. You run nothing.

**The full guide is at [/build/guide](https://columbia-ai-agents.vercel.app/build/guide).**
This page is the short version.

## Start

```bash
# Fork or "Use this template" on GitHub, then:
git clone https://github.com/<you>/<your-copy>.git && cd <your-copy>
npm install                              # typescript and @types/node, nothing else
npm run agent:check example-releases     # a complete agent that passes — read it first
npm run agent:new my-agent               # scaffold yours
```

Node 22.6 or newer. Nothing here needs a key, an account or a database.

## The loop

```bash
npm run agent:record my-agent    # hit each declared source once, save what came back
npm run agent:test   my-agent    # run your three functions against those bytes, offline
npm run agent:check  my-agent    # every automated check the platform runs, writing nothing
```

`agent:check` is **the platform's gate** — the same code, generated from the
platform's repository (`KIT_VERSION` says which commit). A green check here is
a green gate when we import your agent.

## What an agent is

```
agents/my-agent/
  agent.yaml          what it reads, how often, what it tells people, what it will NOT do
  index.ts            fetch(ctx) → normalize(raw) → match(prev, curr, config)
  fixtures/           recorded responses, so the test runs offline
  subscribers.json    a few example configs, so the test has someone to alert
```

- **`fetch(ctx)`** — get the raw data, only through `ctx.fetch(sourceId, params)`.
  One call serves every subscriber; never fetch per person. No `fetch()`, no
  `process.env`, no clock — the check refuses them.
- **`normalize(raw)`** — pure. Turn the response into `{ items, fetchedAt }`.
  Throw on anything you do not understand; never return empty to "handle" it.
- **`match(prev, curr, config)`** — which items are news for this person.
  `prev` is null on the first run, which must never alert. `lib/patterns/`
  has the common shapes (`newListingWatcher`, `availabilityWatcher`).
- **`enrich(items, ctx)`** *(optional)* — call a model through `ctx.model`
  on the platform's key, if you declare what it costs (`cost.enrich`).

## Already built an agent somewhere else?

Most of what you built, we already run. Port the part only you know:

| You built | Here it becomes |
|---|---|
| A cron job or scheduler | `poll.frequency` in the manifest |
| A database of what you have seen | nothing — `prev` is handed to `match()` |
| Slack / email / webhook senders | nothing — return alerts; we deliver |
| Your own API key for a scraping or data service | a source with `auth: none`, or tell us what you need (we never hold a builder's key) |
| Your own OpenAI / Anthropic key | `ctx.model` in `enrich()`, priced by the cost check |
| Per-user settings in your UI | `user_config` — we render the form |
| A hosted app with logins | nothing — we never store a password, and your agent never sees who subscribes |

If your source needs something the runtime cannot do yet, submit anyway and
say what it needs. That is a platform change, not your problem.

## Submit

1. Push your repository somewhere public (GitHub is easiest). The check runs
   on every push (`.github/workflows/check.yml`).
2. On [your builder page](https://columbia-ai-agents.vercel.app/build), on the
   request you claimed, paste the repository link, the commit, and the agent id.
3. We read the code, import it at **exactly that commit**, and run the gate
   again. Then it runs seven days against the real source with every alert held
   back, and a person checks it against the contract the requester approved.
   You hear about each step under **Updates**.

Becoming a builder is by application:
[/build/apply](https://columbia-ai-agents.vercel.app/build/apply). You can use
this kit before you apply — it is the best way to know whether your agent fits.

## The rules that are not negotiable

Agents alert; they never book, buy, apply or act for anyone. No passwords or
logins, ever. No source that blocks bots or has objected. The first run never
alerts. A failed fetch is not "everything disappeared".
