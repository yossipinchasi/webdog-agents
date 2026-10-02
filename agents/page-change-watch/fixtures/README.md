# How these fixtures were made

`2-live.json` is a live recording (`npm run agent:record page-watch`,
2026-10-02) of both pages, verbatim.

`1-baseline.json` is the same recording with one event title — "What would it
cost to end extreme poverty?" — removed from the CS homepage: the page as it
looked before that event was posted. Replaying 1 → 2 is "a listed page gained
one line", which is what `match()` exists to notice; the Library page is
identical in both, so a Library-only subscriber must get nothing.
