# Fast Static Site Generator — a makefun-site 1.0.0 drop-in

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/alwi-betcoin/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/alwi-betcoin/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for the make.fun bounty [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns, byte for
byte, the exact output tree that makefun-site 1.0.0's build returns for a case's
site — every page's `index.html`, the index and tag pages, `build-report.txt`
and each static file — only faster. `main.ts` is the harness driver: it reads
every case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

Verified against the house baseline (makefun-site 1.0.0 itself): the kit
practice set passes 3/3 identical, and a differential run over generated and
hand-built edge cases (front matter, slug, Markdown and template corners)
matches on every case. Locally it runs about 3.1x faster than the baseline on
the practice cases.

## Run it

```
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

MIT licensed.
