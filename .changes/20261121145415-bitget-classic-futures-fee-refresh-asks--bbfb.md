---
bump: patch
section: Fixed
---
- Bitget classic futures fee refresh asks the pairs the batch rate call leaves out (USDC-M) one by one, so they get the account's own rate instead of the listed one
