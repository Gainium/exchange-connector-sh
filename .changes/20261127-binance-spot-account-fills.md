---
bump: patch
section: Fixed
---
- Binance spot account fills now return the account's own trades on the requested symbol (read in 24 h slices over the 7 days before `sinceMs`), instead of an empty page
