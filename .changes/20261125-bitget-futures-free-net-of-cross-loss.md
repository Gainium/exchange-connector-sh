---
bump: patch
section: Fixed
---
- Bitget USDT-M / USDC-M futures: the free balance is capped at the amount the exchange accepts for a new order, which already subtracts the unrealized loss of open cross positions. It no longer reports more free balance than the exchange will let a bot spend.
