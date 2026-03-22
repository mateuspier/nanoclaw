---
name: health-scripts
description: 3-layer health monitoring, encrypted backups every 30min, migration scripts. Trigger on health, backup, monitoring, alert, cron, or migration questions.
---

## Scripts (all in /home/nanoclaw/scripts/)
| Script | Cron | Purpose |
|--------|------|---------|
| watchdog.sh | */2 | Alert if health-fast missed run |
| health-fast.sh | */10 | Services, disk, mem, CPU, stuck containers |
| health-deep.sh | 0 2,8,14,20 | SQLite integrity, APIs, Twilio balance, SSL, SUID, npm audit |
| backup-nanoclaw.sh | */30 | SQLite .backup + tar + AES-256-GPG encryption |
| version-workspaces.sh | hourly | Git auto-commit of group workspaces |
| cleanup-containers.sh | */10 | Kill stuck containers, docker system prune |
| export-full-state.sh | manual | Full encrypted server state export (11MB) |
| import-full-state.sh | manual | Restore on fresh Ubuntu |
| update-twilio-webhooks.sh | manual | Update all webhook URLs after IP change |

## Alerts
Primary: Telegram ALERTS channel (all severities)
Backup: SMS via Twilio (CRITICAL+ only, from +12764962168 to +3530852092285)
Config: ~/.config/nanoclaw/alert-credentials (chmod 600)

## Backup Details
Retention: 24h=all, 7d=per-6h, 30d=per-day
Passphrase: ~/.config/nanoclaw/backup-passphrase
Offsite: Hetzner Storage Box (NOT YET configured)
