---
bump: patch
section: Fixed
---
- Bybit unified account: the free USDT/USDC balance is capped at the account's available balance, which nets out open positions' unrealized loss, so the bot no longer sends orders the venue refuses for available balance
