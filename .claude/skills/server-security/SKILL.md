---
name: server-security
description: 11-layer server security architecture. SSH, UFW, fail2ban, AppArmor, Tailscale, Docker isolation, credential management. Trigger on security, audit, firewall, access, or credential questions.
---

## Access
Server: 178.104.91.250 (public) / 100.115.26.38 (Tailscale)
SSH: port 2222, key-only, AllowUsers nanoclaw claudecode
Tailscale-only: UFW restricts SSH to 100.64.0.0/10

## 11 Security Layers
1. SSH hardened (key-only, port 2222, no root)
2. UFW (deny incoming, allow 80/443/2222-Tailscale/22000-Tailscale)
3. fail2ban (24h ban, 3 failures)
4. AppArmor (120 profiles loaded, 25 enforcing)
5. Tailscale VPN (SSH restricted to mesh network)
6. Docker socket proxy (tecnativa, fallback)
7. Agent network isolation (172.20.0.0/16, iptables egress filtering)
8. Container resource limits (1GB/1CPU/1024PIDs)
9. Twilio signature validation (HMAC-SHA1)
10. Mount allowlist (blocks .env, .ssh, credentials, *.pem, *.key)
11. Credential proxy on port 3002 (API keys never in containers)

## Key Files
/etc/ssh/sshd_config · /etc/ufw/ · /etc/fail2ban/
~/.config/nanoclaw/alert-credentials (chmod 600)
~/.config/nanoclaw/backup-passphrase (chmod 600)
~/.config/nanoclaw/mount-allowlist.json
CRITICAL: NEVER log, output, or include credential VALUES in any response, skill, or file.
