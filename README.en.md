# aramgg_client · Manual-refresh overlay (Lentolove fork)

[中文 README](./README.md)

An in-game overlay for League of Legends **ARAM Mayhem** (queue 2400). When an augment choice appears you press **Refresh** (or a hotkey); it takes a single screenshot, recognizes the three augments (icon hash + PaddleOCR), ranks them, and suggests switchable item builds based on your picked augments, both team comps and your live items.

Forked from [valkia/aramgg_client](https://github.com/valkia/aramgg_client) (thanks to the original author); branch `manual-overlay`. The upstream repository ships no license file, so this fork adds none and the original code remains the author's; fork changes are for personal use. arammeta data is used under its MIT license.

- **Ranking (measured)**: arammeta's method — win rate shrunk toward the champion baseline (Beta prior, strength 350), ranked by the 10% lower bound minus baseline, with rank within rarity and sample size. Falls back to dtodo per card.
- **Builds**: measured arammeta routes/core/pairs/boots plus *rule-based* augment→item and team-comp→item bonuses; every reason is labelled measured (`实测`) or rule (`规则`).
- **Data**: arammeta (champion data refreshed every 6 h, global every 12 h, ETag revalidation; mirrors raw.githubusercontent → jsDelivr → fastly → arammeta.com; cache then bundled snapshot as fallback), dtodo data API for augment names/icons and base data, local LCU (read-only) and Live Client Data API (`127.0.0.1:2999`).
- **Install/update**: get `aramgg_client-Setup-<version>.exe` from this fork's [Releases](https://github.com/Lentolove/aramgg_client/releases/latest). Updates are checked only against this repo's releases; you choose when to download; nothing downloads or installs during GameStart/InProgress.
- **Hotkeys/tray**: `Ctrl+Shift+R` refresh, `Ctrl+Shift+H` collapse (configurable); tray menu shows/hides the main window and the overlay; `--show-manual-overlay` shows the overlay.
- **Dev/release**: `npm ci && npm run dev`; push a `vX.Y.Z` tag matching `package.json` to run `.github/workflows/release-fork.yml`.
- **Limits**: Windows only; Riot policy disallows displaying augment win rates (a toggle hides the numbers); arammeta data is likely from the TW server; augment/comp→item effects are rules, not statistics.

Not endorsed by or affiliated with Riot Games.
