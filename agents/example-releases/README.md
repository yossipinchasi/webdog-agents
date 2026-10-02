# example-releases

## Before you submit

```bash
npm run agent:record example-releases          # hit each declared source once, save the bytes
npm run agent:test   example-releases          # run the three functions against those bytes, offline
npm run agent:check  example-releases          # every automated check, writing nothing
```

The third one is the gate — the same code the platform runs on your
submission, so a green check here is a green gate there.

## Submitting

Push this repository somewhere public, then paste its link and the commit
from your builder page (/build). We read the code, import it at exactly that
commit, and run the gate again.

## What passing does not mean

It does not make the agent live. A passing submission moves it to **shadow**:
seven days against the real source, alerts suppressed, then a report where the
criteria a machine cannot decide go to a person with the evidence attached.
The builder guide is at /build/guide.
