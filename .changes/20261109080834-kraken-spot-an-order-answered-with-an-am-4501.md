---
bump: patch
section: Fixed
---
- Kraken spot: an order answered with an ambiguous timeout error (Expired request / Deadline elapsed) is now looked up by its client id before anything else — returned if it was placed, re-sent once only if it is definitely absent — instead of being reported as failed and left unplaced.
