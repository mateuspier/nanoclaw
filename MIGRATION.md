# NanoClaw Server Migration Guide

## Quick Migration (~30 min downtime)

1. **On old server**: Run export
   ```bash
   ~/scripts/export-full-state.sh
   ```

2. **Transfer** the .gpg file to the new server:
   ```bash
   scp -P 2222 ~/exports/nanoclaw-export-*.gpg user@new-server:/tmp/
   ```

3. **On new server** (fresh Ubuntu 24.04): Run import
   ```bash
   sudo bash /tmp/import-full-state.sh /tmp/nanoclaw-export-*.gpg
   ```

4. **Update DNS**: Change A record for `api.robotchicken.top` to new IP

5. **Update Twilio webhooks** (if domain changed):
   ```bash
   ~/scripts/update-twilio-webhooks.sh new-domain.com
   ```

6. **Re-authenticate Tailscale**:
   ```bash
   sudo tailscale up
   ```

7. **Start services**:
   ```bash
   sudo systemctl start nanoclaw
   ```

8. **Verify**: Send test message to each number and Telegram bot

## Zero-Downtime Migration

1. Set up new server with import script (steps 1-3 above)
2. Set Cloudflare DNS TTL to 60 seconds
3. Keep old server running
4. Switch DNS A record to new server IP
5. Wait for propagation (~1-2 min with low TTL)
6. Verify new server receives webhooks
7. Stop old server's NanoClaw service
8. Run final backup on old server, transfer and restore on new
9. Restore DNS TTL to 300 seconds

## Provider Change Guide

Works on any Ubuntu 24.04 server (any cloud provider):

1. Provision Ubuntu 24.04 server (min: 2 vCPU, 4GB RAM, 40GB SSD)
2. Create users: `nanoclaw` and `claudecode` with sudo
3. Transfer export archive to new server
4. Run `import-full-state.sh`
5. Install Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh`
6. Authenticate: `sudo tailscale up`
7. Update DNS and Twilio webhooks
8. Verify all services

## Important Notes

- **Backup passphrase** is required for decryption — store it safely
- **Telegram bots** reconnect automatically (same tokens)
- **Twilio numbers** stay with your account — just update webhook URLs
- **SSL certificates** are re-issued by Caddy automatically
- **Docker images** need to be rebuilt: `cd container && bash build.sh`
