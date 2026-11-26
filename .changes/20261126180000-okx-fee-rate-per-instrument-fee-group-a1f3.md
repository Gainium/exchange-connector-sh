---
bump: patch
section: Fixed
---
- OKX fee rates are read per instrument fee group, so pairs outside the USDT group (EUR, USDC, regional fiat, zero-fee) are no longer quoted at the USDT-pair rate
