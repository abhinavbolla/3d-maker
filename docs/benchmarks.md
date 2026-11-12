# Benchmark results

Each section below is one run, newest first, so later changes can be compared against it.

## How to run them

Both benchmarks use your real Claude Code and a fair amount of your Claude plan. Results go to `runs/bench/` (not in git), and a stopped run picks up where it left off.

```bash
node test/bench/objects.mjs --parallel 2      # our 8 complex, moving objects, scored by a judge
node test/bench/cadprompt.mjs --per 5         # 20 of CADPrompt's 200 single parts, scored against their real meshes
node test/render-run.mjs runs/x/model.js runs/x "Part A,Part B"   # pictures and fit check of a saved script, no Claude
```

- **Objects** ([test/bench/objects.json](../test/bench/objects.json)): a helicopter, drone, robot arm, race car, watch, yacht, office chair and engine. A fresh Claude that sees only the prompt and the pictures, not the builder's reply, scores recognisability, proportions, form, detail and mechanism from 1 to 10. It looks three times and the scores are averaged, because one look varies by about ±1. Next to the scores are what the app measures: parts, overlaps, a closed STL and time.
- **CADPrompt** (Alrashedy et al., ICLR 2025): the most-cited text-to-CAD benchmark. It has 200 descriptions of single mechanical parts, each with a ground-truth mesh. The dataset is not in this repo because it states no licence. Fetch it with `git clone https://github.com/Kamel773/CAD_Code_Generation runs/bench/cadprompt-src`.
  - **Prompt wording:** its prompts ask for "Python code using CADQuery", so that request is dropped and the description kept.
  - **Scoring:** [test/bench/mesh-score.mjs](../test/bench/mesh-score.mjs) follows the paper. Both meshes are scaled into the unit cube, sampled to 1,000 points and aligned with ICP. A failed model scores √3 point-cloud distance and 0 IoGT.
  - **Two scores:** "as built" starts the alignment from the model's own orientation, as the paper does. "Any turn" also tries the other right-angle turns.
  - **Caveats:** the paper ships no scoring code, so this is our reading of it. The paper's best is 0.127 point-cloud distance and 0.944 IoGT (GPT-4 with CADCodeVerify, all 200 parts); a 20-part subset is not directly comparable.

## Rounded bodies and flat views, 10 November 2026 (commit d78c876)

**What changed:**
- `views({ side, top, round, belly, tumble })` makes bodies with rounded cross-sections.
- Side, top and front screenshots are now flat, true to scale, and fill the picture.
- The reference has new form rules for every kind of object.

**How it was compared:** the baseline models were re-rendered with the new camera and judged again, so both columns are scored from the same kind of picture. With the new pictures the baseline scored 5.9 overall and 5.0 for form, the same as with the old ones.

| Object | Overall, before | Overall, after | Form, before | Form, after | Time (s), after |
|---|---|---|---|---|---|
| helicopter | 5.7 | 6.2 | 5.3 | 6.0 | 990 |
| drone | 5.6 | 5.9 | 5.0 | 5.3 | 755 |
| robot arm | 5.9 | 6.7 | 5.0 | 6.3 | 668 |
| race car | 6.4 | 6.7 | 6.3 | 7.0 | 1059 |
| watch | 5.8 | 6.3 | 4.3 | 4.7 | 226 |
| yacht | 6.1 | 6.4 | 5.0 | 5.0 | 863 |
| office chair | 6.3 | 7.0 | 4.3 | 5.7 | 536 |
| engine | 5.7 | 5.8 | 5.0 | 5.0 | 252 |
| **mean** | **5.9** | **6.4** | **5.0** | **5.6** | |

**Results:**
- All 8 objects scored higher overall.
- Detail rose from 5.3 to 6.0, and mechanism from 5.7 to 6.0.
- Claude used rounded bodies in 5 of the 8 objects, and revolve in all of them.

**Costs and side effects:**
- Runs took longer: the helicopter went from 476 to 990 s. Part of that is 3 runs sharing the machine instead of 2. The rest is more changes and more looks per model.
- 4 of 8 runs lost a turn to `tube(..., true/false)`. Since this run, tube accepts that.

## Baseline, 10 November 2026 (commit 7ee0890)

### CADPrompt: 20 of 200 parts, prompts with measurements

These are the first 5 parts at each of the dataset's four expert complexity levels. Every part was built (20 of 20). One part failed the first time because the test harness failed to start, which has since been fixed; on its rerun it built normally.

| Level | Built | Point-cloud distance ↓ | Hausdorff ↓ | IoGT ↑ | IoGT, any turn ↑ |
|---|---|---|---|---|---|
| All 20 | 100% | 0.033 | 0.121 | 0.916 | 0.973 |
| Simple | 100% | 0.021 | 0.064 | 0.999 | 0.998 |
| Moderate | 100% | 0.024 | 0.133 | 0.877 | 0.930 |
| Complex | 100% | 0.027 | 0.088 | 0.881 | 0.977 |
| Very complex | 100% | 0.061 | 0.197 | 0.908 | 0.989 |

**For reference, the paper's best:** GPT-4 with CADCodeVerify scored 0.127 / 0.419 / 0.944 over all 200 parts, with a 96.5% compile rate.

**Caveats:**
- This is a 20-part subset.
- The scorer is our own reading of the paper.
- The scorer's floor is about 0.021: a part compared with itself scores that, because both sides are sampled to 1,000 points.

**What lowers IoGT** is mostly parts built standing on a different face. Trying the other right-angle turns lifts IoGT from 0.916 to 0.973.

### Our 8 complex objects, judged

A fresh Claude scored each object from the pictures and the prompt alone, taking 3 looks per object.

| Object | Recognisable | Proportions | Form | Detail | Mechanism | Overall | Parts | Overlaps | Time (s) |
|---|---|---|---|---|---|---|---|---|---|
| helicopter | 6.7 | 5.0 | 5.0 | 4.0 | 5.3 | 5.2 | 49 | 0 | 476 |
| drone | 8.0 | 6.0 | 4.0 | 5.0 | 4.3 | 5.5 | 31 | 0 | 364 |
| robot arm | 8.0 | 6.0 | 5.0 | 4.7 | 6.7 | 6.1 | 13 | 0 | 222 |
| race car | 8.0 | 6.7 | 6.3 | 5.7 | 5.0 | 6.3 | 46 | 0 | 638 |
| watch | 8.0 | 6.0 | 4.3 | 5.3 | 5.7 | 5.9 | 16 | 0 | 202 |
| yacht | 8.0 | 6.3 | 5.0 | 5.0 | 6.0 | 6.1 | 25 | 0 | 853 |
| office chair | 8.3 | 6.7 | 4.7 | 6.0 | 6.3 | 6.4 | 29 | 0 | 548 |
| engine | 7.0 | 5.7 | 4.7 | 5.7 | 5.0 | 5.6 | 12 | 0 | 256 |
| **mean** | **7.8** | **6.1** | **4.9** | **5.2** | **5.5** | **5.9** | | | |

**Form is the weakest score for every object.** The judge's complaints repeat across objects: "flat slab", "straight-sided cylinder", "plain box" and "tube". It names the cabin, hull, seat, crankcase, watch case and drone body.

**Hand-fix test:** we rebuilt the helicopter body from helicopter v3 as a loft of real cross-sections, using only features the kernel already had: a squarish cabin with tumblehome, then an oval tail cone, then a round boom. We also gave it a keel-mounted tail strut and sponsons. The judge scored it 5.9, up from 5.3 for the original, and form rose from 3.7 to 5.7. The kernel can make these shapes; Claude doesn't reach for them yet.
