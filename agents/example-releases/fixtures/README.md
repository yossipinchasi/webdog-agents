# How these two fixtures were made

`2-live.json` is a live recording (`npm run agent:record example-releases`,
2026-10-02), with each release trimmed to the seven fields `normalize()` reads
— the release notes made it half a megabyte and nothing reads them.

`1-baseline.json` is the same recording with the newest published release of
each project removed: what the API looked like a poll earlier. Replaying
1 → 2 is "three projects each published a release", which is what `match()`
exists to notice.
