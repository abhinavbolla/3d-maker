# Benchmark results

How to run these: see "Benchmarks" in the [README](../README.md). Each section is one run, newest first, so later changes can be compared against it.

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
