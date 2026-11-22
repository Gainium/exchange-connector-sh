---
bump: patch
section: Fixed
---
- Bybit open-order and position reads now follow the venue's page cursor and request the largest page size, so accounts with more rows than one default page get the complete list; a failed or non-terminating page fails the whole read instead of returning a partial list as complete
