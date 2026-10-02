# PAKRA pricing review for Terry

Initial Pokémon singles pricing handoff from Jun to Terry, prepared **2 October 2026**. This repository contains the existing scripts, pricing assumptions and dated examples needed for an initial review. Collection and integration are still in progress.

Jun continues the multi-IP catalog and storefront. Terry reviews pricing reliability, condition filtering, order-level shipping and the design of future automation. Proposed changes go to Jun and Hao before any live price changes.

## Start here

- [Full handoff guide](START-HERE.txt)
- [Current pricing assumptions](config/pricing-review.json)
- [10 historical pricing examples — CSV](data/historical-pricing-samples-10.csv) · [JSON with provenance](data/historical-pricing-samples-10.json)
- [120 historical card-to-Shopify mappings — CSV](data/historical-shopify-mapping-120.csv) · [JSON](data/historical-shopify-mapping-120.json)
- [Data scope and timestamp guide](DATA-NOTES.txt)
- [Source map](SOURCE-GUIDE.txt) · [Open questions and incomplete work](KNOWN-GAPS.txt)
- [Validation results](validation/VALIDATION.txt)
- [Download the original review ZIP](downloads/PAKRA-Terry-Pricing-Review-20261002.zip) · [ZIP checksum](downloads/SHA256SUMS.txt)

## Status and evidence limits

The selected saved independent audit is dated **1 October 2026, 08:23 UTC**. It records 120 products and 120 V9 catalog cards from a target of 543 single cards, with 423 still remaining at that checkpoint. A separate identity/image catalog has 544 records, including one held two-card set. These counts describe different stages.

All samples and mappings are historical local snapshots, not fresh Shopify or Jihuanshe reads. Source quotes are **not filtered to a verified card condition**. All 10 examples reproduce the saved Shopify price under the current formula; they illustrate pricing-model concerns, not confirmed market-price errors. Full screenshots and runtime evidence are not bundled; source pointers and hashes are retained for follow-up.

## Current formula under review

`USD = ceil((source CNY + 15 + 70) / (6.5 × (1 - 0.07 - 0.40)))`

The current listing model includes CNY 15 procurement shipping and CNY 70 international shipping in each card's price, a 7% fee and a 40% target net margin on gross revenue. The 40% target and shipping assumptions remain open for review. The separate local order calculator can charge shipping once for an aggregated procurement amount; this does not mean multi-card cart repricing is already implemented.

## Offline checks

Node.js 22 or later; no npm dependency installation is needed for these checks.

```sh
node review/reproduce-samples.mjs
node source/pokemon-single-card-sync/order-margin-pricing.mjs --cost-cny 79
```

The copied package passed 77 focused offline tests, and all 10 real historical examples recomputed successfully. See the [exact test command and results](validation/VALIDATION.txt).

## Source and access boundaries

The [source snapshot](source/) preserves original file bytes and relative imports. Workstation paths are retained as evidence; Windows/ADB/emulator/Python setup is not portable without configuration. Included integration and task scripts are for review and may access devices, services or perform writes. Use only the documented offline commands for initial inspection.

This repository is public so Terry can open the link without an invitation. It contains no credentials, customer/order/payment records, historical approval files, enabled execution mapping or permission to update store prices. Access to this repository does not grant Shopify access. Git changes and store deployment are separate actions.

The original [file manifest](FILE-MANIFEST.json) covers the 95 files inside the original review package, excluding itself. It intentionally excludes this GitHub README, Git settings and the ZIP download added for repository delivery. [Source provenance](SOURCE-MANIFEST.json) and [data provenance](data/provenance.json) retain the original evidence trail.
