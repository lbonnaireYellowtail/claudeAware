# aware-mod

Usage awareness for Claude Code, as a mod: a coloured band above the prompt with your
context fill, live 5h / 7d plan limits (synced across terminals), and the plan week's
spend.

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
```

```
/plugin marketplace add lbonnaireYellowtail/claudeAwareMod
/plugin install aware-mod@aware
```

What each segment means, the options, how sync and the cost ledger work, and the
security model: see the [project README](../README.md).

## Layout

```
aware-mod/
├── .claude-plugin/plugin.json   manifest + userConfig (the options)
├── hooks/hooks.json             names the module
├── hooks/register.tsx           wiring: events, files, the band
├── hooks/core.ts                the logic, pure: no engine calls
├── types/index.d.ts             $.state contract
└── tests/                       core (pure) + band (engine, in-memory fs)
```

```bash
claude plugin validate aware-mod
claude plugin test aware-mod
```
