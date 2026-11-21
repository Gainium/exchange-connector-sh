---
bump: patch
section: Fixed
---
- Bitget classic fee refresh reads every pair's rate in one request per product line, so it finishes inside the caller's deadline
