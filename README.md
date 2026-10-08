# PL Fair Price

What every Premier League market on [XO](https://beta.xo.market) should cost, priced from the markets with real money.

Live: https://tannnnnnnnnnnnn.github.io/pl-fair-price/ · GW numbers: https://tannnnnnnnnnnnn.github.io/pl-fair-price/gw.html

## How it works
- `pipeline/fetch.sh` pulls live XO markets, Polymarket's EPL markets and the official FPL API.
- `pipeline/engine.py` fits a Dixon-Coles Poisson model to Polymarket's match prices (calibrated to the league's goals per game), simulates every remaining fixture, and prices each XO market. Season questions map directly to Polymarket. Questions without a defensible reference stay unpriced. "Rough" prices carry heavy assumptions.
- A GitHub Action refreshes everything every 20 minutes. `VERIFY.md` shows every input and fit check.

Built by [@CryptoTan01](https://x.com/CryptoTan01). Not affiliated with any club.
