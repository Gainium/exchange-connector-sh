---
bump: patch
section: Fixed
---
- Kraken spot: an order answered with EService:Timeout is no longer re-sent blind; it is looked up by its client id first, like other ambiguous timeouts, so it cannot be placed twice.
