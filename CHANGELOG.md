# Changelog

## 2026.5.21

### Changes

- Linux install: mark the scoped Linux MVP path ready, with the public npm one-line install, direct Codex turns, and Agent Deck/Codex turns verified through the Ubuntu UI test VM. Thanks @IAMSamuelRodda.
- Windows install: add Codex CLI-first Windows groundwork with Start Menu/Desktop launchers, Pixel Forge icon integration, built desktop shell startup, and Agent Deck disabled by default. Thanks @IAMSamuelRodda.
- Release proof: add Windows Codex provider smoke coverage and strengthen npm install/release-update smokes so public installer and update lanes are exercised before publishing. Thanks @IAMSamuelRodda.
- Live Editor: improve chat naming, sidebar truncation, chat-scoped Open TUI actions, and default dark-shell behavior for a cleaner installed app experience. Thanks @IAMSamuelRodda.

### Fixes

- Windows launcher: prevent user-launched Pixel Forge from attaching to a stale backend owned by another Windows session, and open direct Codex TUI sessions in a persistent terminal window. Thanks @IAMSamuelRodda.
- Agent Deck/Codex: keep fresh chat startup snappy by moving slow Agent Deck metadata probes off the critical path and falling back gracefully when session lookups time out. Thanks @IAMSamuelRodda.
- Chat lifecycle: make chat deletion nonblocking, require Open TUI to wait for an actual bound provider session, and detach stale direct-provider bindings instead of showing misleading actions. Thanks @IAMSamuelRodda.
- Resource management: replace the artificial max-session stop with memory-pressure-aware Agent Deck admission and bounded subprocess waits. Thanks @IAMSamuelRodda.
