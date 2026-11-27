---
bump: patch
section: Fixed
---
- Binance USDⓈ-M and COIN-M now answer the account-fills read for a given symbol, telling the bot's own trades apart from hand trades and venue closes, so a futures position closed outside the bot can be priced from the venue's own record
- The account-fills read takes an optional `symbol`; other venues ignore it
