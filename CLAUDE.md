# NanoClaw — AI Agent Platform

Multi-business AI agent platform on Hetzner CCX23 (178.104.91.250 / Tailscale 100.115.26.38).
3 active businesses, 14 reserved. Production since March 2026.

## Stack
Node 22 · TypeScript · Docker 29.3 · SQLite WAL · Caddy 2.11 · systemd
Twilio (SMS/WA) · Telegram Bot API · Anthropic Claude API

## Structure
src/channels/twilio.ts — webhook adapter (port 3001)
src/container-runner.ts — Docker spawn (file mount, not stdin)
src/types.ts — shared TypeScript types
container/Dockerfile — agent container image definition
data/businesses.json — business registry
groups/{slug}/CLAUDE.md — agent personality per business
groups/global/ — shared agent resources (mounted read-only)
store/ — SQLite databases
scripts/ — health, backup, migration (in /home/nanoclaw/scripts/)
Obsidian vault: /home/nanoclaw/obsidian-vault/NanoClaw/

## Conventions
kebab-case files · camelCase functions · PascalCase types
Conventional Commits: feat|fix|docs|refactor|test: description
Branches: {type}/{slug}-{description} (ex: fix/biz-ie-01-memory)

## Commands
npm run dev · npm run build · sudo systemctl restart nanoclaw
sudo systemctl status nanoclaw · sudo journalctl -u nanoclaw -f

## Architecture Decisions
- File mount /run/nanoclaw-input.json (not stdin pipe — stdin hangs)
- nanoclaw user in docker group (direct socket, not proxy for spawn)
- NO WebSearch/WebFetch in agent containers (no internet)
- Container limits: 1GB mem, 1 CPU, 1024 PIDs, NO --read-only
- Network: nanoclaw-agents 172.20.0.0/16 with iptables egress
- Each business: isolated group dir + memory dir + session data

## On-Demand Skills (heavy content, loaded only when needed)
/twilio-adapter · /business-config · /container-runner · /server-security · /health-scripts
