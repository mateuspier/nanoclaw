---
name: twilio-adapter
description: Twilio webhook adapter on port 3001. Signature validation, message dedup, file mount workaround, Telegram log forwarding. Trigger on any SMS, WhatsApp, webhook, or Twilio question.
---

## Architecture
Read src/channels/twilio.ts for full implementation.

Inbound flow:
POST https://api.robotchicken.top/webhook/twilio/incoming (Cloudflare → Caddy → localhost:3001)
validate Twilio signature → write SQLite → dedup by MessageSid → return TwiML <Response/> in <100ms → async: route by "To" number → spawn agent container → collect response → send via Twilio API → post to Telegram Logs channel

File mount (stdin fix):
NanoClaw writes input to data/inputs/{container-id}.json
Mounted into container as /run/nanoclaw-input.json:ro
Container entrypoint reads mounted file, not stdin
stdin.end() called immediately after spawn
Temp file deleted after container exits

Telegram logging:
Full message text (no truncation), auto-split at 4096 chars, Markdown with plain text fallback.

## Debugging
sudo journalctl -u nanoclaw --since "10 min ago" -o cat
curl -sf http://localhost:3001/health | python3 -m json.tool
docker ps -a --filter "name=nanoclaw-biz"
sqlite3 /home/nanoclaw/nanoclaw-workspace/nanoclaw/store/messages.db "SELECT * FROM messages ORDER BY rowid DESC LIMIT 5"
