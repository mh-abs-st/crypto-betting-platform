# YuuBet business and product plan

Status: draft for the owners to confirm, November 2026. Figures marked *assumption* are planning inputs to be replaced with real data; figures with a source are as published at the time of writing. Nothing here is legal advice: licensing and market decisions need a gaming lawyer.

## 1. Summary

YuuBet is a crypto casino built around games a player can check for themselves. It launches with three in-house games (Versus, Jackpot and Roulette), stablecoin balances, and a public verification page for every bet. Slots and a sportsbook come later through providers.

The plan has three ideas:

1. **Lead with player-versus-player games.** In Versus and Jackpot the house takes a fee from the pot and never bets against the player, so revenue does not depend on luck and the launch bankroll can be small. Roulette, where the house is the counterparty, runs under strict limits until the bankroll grows.
2. **Make fairness visible, not just claimed.** Every bet gets a shareable verification page, draws use public outside entropy, the verifier is open source, and an outside party audits the scheme. This is the reason to choose YuuBet over a larger site.
3. **Ship a play-money beta before taking real money.** A public beta with no deposits tests the product, the load and the fairness experience with real players, and builds a community and waiting list, while the licence and compliance work, which takes months, runs in parallel.

Real money is accepted only when the licence, identity and age checks, anti-money-laundering controls, responsible-gambling tools and security review are in place (milestone M3).

## 2. Market

- **Size.** Crypto gambling generated an estimated $81.4 billion of gross gaming revenue (GGR) in 2024, about five times the 2022 level, according to Yield Sec as reported by the Financial Times. Estimates vary widely, because most operators are offshore and publish no audited figures; conservative trackers put the market far lower. The plan does not depend on the headline number: a small operator needs only a tiny share.
- **Concentration.** The largest operator, Stake, reported an estimated $4.7 billion GGR in 2024. The leaders compete on brand, sponsorships and slot catalogues. A newcomer cannot outspend them and should not try.
- **Currency.** Stablecoins are a large and growing share of crypto bets, and USDT on Tron is commonly the fastest and cheapest rail. YuuBet already keeps balances in USDT, which removes price risk for players and for the house.
- **Game mix.** Slots are the largest share of crypto casino revenue, which is why slots are the first product line after launch (M6).

## 3. Customers

| Segment | What they want | What YuuBet offers |
| --- | --- | --- |
| Crypto-native casual players | Fast stablecoin deposits and withdrawals, simple games, low minimums | USDT on Tron, bets from 0.01 USDT, instant settlement |
| Sceptical or technical players | Proof the games are not rigged | Per-bet verification pages, open-source verifier, outside entropy, audit report |
| Social players | Playing against people, not a machine | Versus, Jackpot, live Roulette rounds, chat and tips |
| Streamers and affiliates | A brand their audience trusts, fair commission, real-time tracking | Revenue share on house fees, dashboard, verifiable results on stream |

Players must be adults in a country where the licence allows YuuBet to operate.

## 4. Product

### 4.1 Principles

1. **Correct money first.** A stake is never lost and never paid twice. Balances are whole numbers, every movement has an idempotent id, and the books reconcile daily. These are already rules in the code (`docs/architecture.md`).
2. **Verifiable by default.** A result that cannot be checked does not ship.
3. **Safer gambling is part of the product.** Limits, cool-off and self-exclusion are enforced in every service, not added as a page at the end.
4. **Build what makes us different, buy the rest.** See section 7.

### 4.2 Games at launch

| Game | How the house earns | House risk | Launch setting |
| --- | --- | --- | --- |
| Versus (coin flip between two players) | 2% of the pot | None | Lobby, private matches by link |
| Jackpot (one pot, winner by share) | 5% of the pot | None | Rooms by stake size, entry cap per player |
| Roulette (European) | 2.70% house edge | Yes: the house pays winners | Low table maximums, max win per bet and per day |

### 4.3 Trust features

- A verification page for every bet, with seeds, nonce and the calculation, checked in the browser.
- Public outside entropy (a future block hash) for Jackpot and live Roulette, so neither the house nor a player can steer a shared draw.
- A standalone verifier that does not depend on YuuBet.
- A published third-party audit of the scheme and the random number generation.
- Proof of reserves after launch: published wallet addresses and a check that holdings cover player balances.

### 4.4 Retention

Chat with tips and rain, races and challenges, VIP levels with rakeback, and notifications. These come after launch (M5), because they multiply the cost of fraud and bonus abuse if the controls are not yet mature.

## 5. Business model

### 5.1 Revenue

- **Fees on player-versus-player games**: 2% of each Versus pot and 5% of each Jackpot pot.
- **House edge**: 2.70% on Roulette; later the margin on slots and the sportsbook.
- Net gaming revenue (NGR) is GGR less bonuses and rakeback.

### 5.2 Unit economics (illustrative)

| Input | Value | Basis |
| --- | --- | --- |
| Monthly wagered per active real-money player | $1,500 | *assumption* |
| Blended margin on wagers (Versus 2%, Jackpot 5%, Roulette 2.7%) | 3% | *assumption* on game mix |
| GGR per active player per month | $45 | $1,500 × 3% |
| Bonuses and rakeback | 20% of GGR | *assumption* |
| NGR per active player per month | $36 | |
| Affiliate revenue share on referred players | 25% to 45% of NGR is common in crypto casino programmes | Industry rate cards |
| Payment and custody fees | about 1% of deposits | *assumption*, to be replaced by the provider's quote |

Break-even monthly active players ≈ fixed monthly costs ÷ contribution per player. With $40,000 of fixed costs (*assumption*, excluding salaries) and about $25 of contribution per player after affiliates and payments, break-even is roughly 1,600 active players a month. The play-money beta should measure wagers per player and game mix so these inputs can be replaced with real ones.

### 5.3 Main fixed costs

| Item | Indicative cost | Notes |
| --- | --- | --- |
| Licence: Anjouan | about €17,800 a year (issuer fee) | Crypto-friendly, one licence for all verticals, weeks to issue |
| Licence: Curaçao (CGA, under the LOK law) | about €4,600 to apply, from about €24,600 a year, plus local substance | Better recognised; local office and key people required; months to issue |
| Compliance staff | MLRO and compliance officer | Required by the licence |
| Identity verification, chain analytics, sanctions screening | Per check or per volume | Bought from providers |
| Security review, penetration test, fairness audit | One-off before launch, then yearly | |
| Hosting, monitoring, DDoS protection | Monthly | |

## 6. Go to market

### 6.1 Licence and markets

- **Recommendation:** apply for an Anjouan licence first for speed and cost, keeping the option to move to Curaçao when volumes justify the extra cost and recognition. Counsel decides.
- Block every country the licence or local law excludes. Expect this to include the United States, the United Kingdom, France, the Netherlands, Spain, Australia, sanctioned countries, and markets with their own licensing regime such as Ontario and Brazil. The final list comes from counsel and is enforced at sign-up, deposit and play (#39).
- Target crypto-native players in markets the licence allows, starting with the languages of the first communities that form during the beta.

### 6.2 Channels

1. **Affiliates and streamers.** Affiliates are the largest single source of new depositors in iGaming. Offer revenue share on house fees with a real-time dashboard (#45). Streaming on Kick is the main casino-stream channel; contracts must require disclosure and safer-gambling messaging and forbid targeting minors.
2. **Community.** The play-money beta builds a Telegram or Discord community and a waiting list that converts at launch.
3. **Trust content.** Publish the audit, the verifier and explanations of the scheme; these give affiliates something true to say.
4. **Paid search and social** are mostly closed to gambling and are not planned.

### 6.3 Launch sequence

| Phase | Milestone | Real money | Exit criteria |
| --- | --- | --- | --- |
| 0. Foundation | M1 | No | State is durable, no stake can be lost, CI runs on every change |
| 1. Play-money beta | M2 | No | Public site live; KPIs measured for 4 weeks; no data loss under load |
| 2. Real-money readiness | M3 | Test networks only | Licence granted; KYC, AML and safer-gambling controls enforced; security and fairness reviews passed; books balance under load with failures injected |
| 3. Soft launch | M4 | Yes, USDT only, low limits | 30 days with books balancing daily and no high-severity incidents |
| 4. Growth | M5 | Yes | Retention features live with fraud controls |
| 5. New product lines | M6 | Yes | Slots, then the sportsbook |

## 7. Build or buy

| Capability | Decision | Why |
| --- | --- | --- |
| Game engine and fairness | Build (exists) | The product's difference |
| Wallet ledger and books | Build (exists) | Must be exactly right and owned |
| Deposits, withdrawals and custody | Buy at launch: an iGaming crypto payment and custody provider behind our own payments interface | Months faster and safer than running chain watchers and hot wallets; can be replaced later |
| Identity and age verification | Buy | Specialist, regulated |
| Wallet screening and sanctions | Buy | Data the provider has and we do not |
| Slots | Buy: aggregator | Hundreds of certified games through one integration |
| Sportsbook | Buy: turnkey provider or odds feed with managed trading | Odds and risk management are a business in themselves |
| Back office | Build a small one | Fits our ledger and roles |

## 8. Key metrics

| Area | Metric |
| --- | --- |
| Acquisition | Sign-ups, sign-up to first bet, sign-up to first deposit, cost per first depositor by channel |
| Engagement | Daily and monthly active players, bets per session, D1, D7 and D30 retention |
| Revenue | Wagered, GGR and NGR per game and per day; actual against expected house edge |
| Trust | Share of bets verified, verification failures (must be zero), payout pending time |
| Safety | Players with limits set, self-exclusions, time to review flagged accounts |
| Operations | Withdrawal time, failed payouts, ledger reconciliation differences (must be zero) |

Product analytics are tracked as a new issue so the beta can measure these from day one.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Operating without the right licence, or in a blocked market | No real money before M3; geo-blocking; counsel signs off each market |
| Loss of player funds through a bug or a key compromise | Idempotent ledger, double-entry books, daily reconciliation, custody provider, multi-signature cold storage, load and failure tests |
| Suspicion that games are rigged | Outside entropy, per-bet verification, open-source verifier, published audit |
| Collusion and chip dumping in Versus and Jackpot | Linked-account detection and review before withdrawal |
| Bonus and affiliate abuse | Wagering requirements, self-referral detection, risk scores; promotions only after fraud controls |
| Bad luck on Roulette | Max win per bet and per day tied to bankroll; automatic pause on loss thresholds |
| Harm to vulnerable players, and the reputational and legal cost | Limits, cool-off, self-exclusion, reality checks, no marketing to excluded players, responsible streamer contracts |
| Payment provider withdraws service | Provider-agnostic payments interface; a second provider identified before launch |

## 10. What changes in the backlog

The issues already cover most of this plan. The changes:

- **Milestones re-cut around the phases above.** M2 becomes the play-money beta, M3 becomes real-money readiness, M4 the soft launch, M5 growth, and M6 slots and sportsbook.
- **Deployment, rate limiting, history, real-time updates and the verification page move earlier,** because the public beta needs them.
- **Deposits, withdrawals and custody start with a payment provider** behind a provider-agnostic interface, instead of in-house chain watchers and hot wallets.
- **Raffle merges into challenges and leaderboards** as one promotions issue; rakeback moves out of the bonus issue into VIP.
- **New issues:** product analytics and KPIs; landing page, waiting list and beta onboarding; proof of reserves.

## 11. Decisions needed from the owners

1. Company jurisdiction and licence (Anjouan first, or straight to Curaçao).
2. Budget for licence, providers, audits and the first year of marketing.
3. Payment and custody provider, and identity verification provider.
4. First target markets and languages.
5. Who will be the MLRO and the compliance officer.

## Sources

- Yield Sec estimate via Gambling Insider: https://www.gamblinginsider.com/news/178380/crypto-casino-investigation-how-big-or-small-is-the-industry
- Market size spread and game mix, Track360: https://track360.io/blog/crypto-gambling-statistics-2026
- Stake GGR, SCCG Research: https://sccgmanagement.com/wp-content/uploads/2026/07/2026-07-23_SCCG-Research_The-Border-Toll_FINAL.pdf
- Stablecoins and withdrawal speeds, DeucesCracked: https://www.deucescracked.com/statistics/crypto-gambling
- Curaçao CGA fees, Zitadelle AG: https://www.zitadelleag.com/services/igaming/curacao
- Anjouan fee schedule, Global Law Experts: https://globallawexperts.com/?p=1535688
- Affiliate economics, Track360: https://track360.io/blog/state-of-igaming-affiliate-marketing-2026-report
- Streamer channel, Track360: https://track360.io/blog/casino-streamers-kick-twitch-sponsorship-operator-2026
