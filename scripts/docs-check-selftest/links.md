# check-links self-test

Expected verdict: exactly **3 broken** (marked BROKEN). Everything else resolves or is ignored.

- resolves: [target file](links-target.md)
- resolves, heading anchor: [section two](links-target.md#section-two)
- resolves, punctuation and an em dash in the heading: [punctuated](links-target.md#3-a-heading-with-punctuation-and-a--dash)
- resolves, duplicate heading gets -1: [dup](links-target.md#duplicate-1)
- resolves, explicit HTML anchor: [html](links-target.md#custom-anchor)
- resolves, same-file anchor: [top](#check-links-self-test)
- resolves, directory: [this directory](./)
- ignored, external: [ext](https://example.invalid/page)
- ignored, mailto: [mail](mailto:nobody@example.invalid)
- ignored, inline code: `[code](nope-in-code.md)`
- BROKEN, missing file: [missing](does-not-exist.md)
- BROKEN, missing heading: [no such heading](links-target.md#no-such-heading)
- BROKEN, escapes the root: [escape](../../.gitignore)

```text
[fenced](nope-in-fence.md) — ignored, inside a fence
```

[ref]: links-target.md
[V citation 2018]: wind ≥ 10 mph → prose, not a definition (text continues after the destination)
