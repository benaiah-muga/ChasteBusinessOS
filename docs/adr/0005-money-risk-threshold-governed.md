# ADR 0005, Money risk is threshold-governed, not blanket-capped

Date: 2026-08-22 · Status: accepted

## Context
The org policy originally capped autonomy by risk rank
(`maxRiskAutonomous: write`), which silently required approval for *every*
money action, including an $11.50 coffee sale at POS. Found by live demo.

## Decision
For `money`-class capabilities, the governing control is the **amount
threshold** (`moneyThresholdMinor`, org policy overrides capability
default). The blanket risk cap applies only to non-money risks. Setting a
threshold of 0 gates all money actions for orgs that want maximum caution.

## Consequences
- Retail flows stay autonomous under $500 (configurable).
- Large payments still gate. Demo `demo:m5` proves both sides.
