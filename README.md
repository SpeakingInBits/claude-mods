# claude-mods

Mods for [Claude Code](https://claude.com/claude-code) from SpeakingInBits. Mods work in the terminal and in the desktop app's Code tab. This repo is a plugin marketplace, and each mod in it installs on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [session-spend](mods/session-spend) | A card above the prompt shows Bit, a pixel-art critter who hops while Claude works and stacks coins as the spend grows. The card also has the session's API spend with a per-turn chart, plan usage meters (5-hour and 7-day windows) on a subscription, and a pixel character for each subagent. The status line shows the running total (`API spend $1.30 (+$0.08 last turn)`). `/spend` gives a turn-by-turn breakdown, and `/spend card` hides or shows the card. |

## Install

At a Claude Code prompt:

```
/plugin install session-spend --marketplace SpeakingInBits/claude-mods
```

Answer `y` to add the marketplace, then choose a scope (user scope enables it in every session).

The spend figure is the same estimate `/cost` reports, at list price or at your organization's own pricing if it has set one. On a Pro or Max subscription it shows what the usage would cost on the API, not what you're billed.

## Developing

Each mod lives in `mods/<name>/` and is listed in `.claude-plugin/marketplace.json`.

```
claude plugin validate mods/session-spend
claude plugin test mods/session-spend
```

To run mods from your working copy, add this folder as a marketplace (`claude plugin marketplace add .`), install from it, and run `/reload-plugins` after each edit.

To add a mod, create `mods/<name>/`, add an entry to `plugins` in `.claude-plugin/marketplace.json`, and add a row to the table above.
