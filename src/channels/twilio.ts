/**
 * Twilio Channel for NanoClaw
 * HTTP server handling SMS and WhatsApp webhooks from Twilio.
 *
 * Architecture:
 *   Caddy (443) → localhost:3001 → this server
 *   Twilio sends webhooks here, we route to the correct business agent.
 *   Agent responses come back via sendMessage(), we send them out via Twilio API.
 *
 * JID format: tw:{slug} — one group per business, all senders routed there.
 * Sender phone is included in the message content so the agent can address them.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { STORE_DIR, DATA_DIR } from '../config.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Types ---

interface BusinessConfig {
  slug: string;
  display_name: string;
  phone_number: string | null;
  sms: boolean;
  whatsapp: boolean;
  active: boolean;
}

interface TwilioMessage {
  MessageSid: string;
  From: string;
  To: string;
  Body: string;
  AccountSid: string;
  NumMedia?: string;
}

// --- Twilio signature validation ---

function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], '');
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(data)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// --- Parse URL-encoded body ---

function parseUrlEncoded(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(
        rest.join('=').replace(/\+/g, ' '),
      );
    }
  }
  return params;
}

// --- Telegram logs channel forwarder ---

function sendTgMessage(
  botToken: string,
  channelId: string,
  text: string,
): void {
  const postData = JSON.stringify({
    chat_id: channelId,
    text,
    parse_mode: 'Markdown',
  });
  const req = https.request(
    {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    },
    (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        // Markdown parse failure — retry as plain text
        const plainData = JSON.stringify({ chat_id: channelId, text });
        const retry = https.request(
          {
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(plainData),
            },
          },
          (r) => r.resume(),
        );
        retry.on('error', () => {});
        retry.write(plainData);
        retry.end();
      }
    },
  );
  req.on('error', (err) => {
    logger.warn({ err }, 'Telegram logs channel post error');
  });
  req.write(postData);
  req.end();
}

function postToLogsChannel(
  botToken: string,
  channelId: string,
  text: string,
): void {
  // Telegram limit is 4096 chars per message — split if needed
  const MAX_LEN = 4096;
  if (text.length <= MAX_LEN) {
    sendTgMessage(botToken, channelId, text);
    return;
  }
  for (let i = 0; i < text.length; i += MAX_LEN) {
    sendTgMessage(botToken, channelId, text.slice(i, i + MAX_LEN));
  }
}

// --- Twilio API client ---

class TwilioClient {
  private accountSid: string;
  private authToken: string;
  private agent: https.Agent;

  constructor(accountSid: string, authToken: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
  }

  async sendMessage(
    from: string,
    to: string,
    body: string,
  ): Promise<{ sid: string }> {
    const data = new URLSearchParams({ From: from, To: to, Body: body });
    const postData = data.toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.twilio.com',
          path: `/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
          method: 'POST',
          auth: `${this.accountSid}:${this.authToken}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
          agent: this.agent,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new Error(
                    `Twilio API ${res.statusCode}: ${json.message || body}`,
                  ),
                );
              } else {
                resolve({ sid: json.sid });
              }
            } catch {
              reject(new Error(`Twilio API parse error: ${body}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  destroy(): void {
    this.agent.destroy();
  }
}

// --- Main Channel Class ---

export class TwilioChannel implements Channel {
  name = 'twilio';

  private opts: ChannelOpts;
  private accountSid: string;
  private authToken: string;
  private client: TwilioClient;
  private server: Server | null = null;
  private port: number;
  private startTime: number;
  private lastMessageAt: string | null = null;

  // Phone number → business slug lookup
  private phoneToSlug = new Map<string, string>();
  // Business slug → phone number lookup
  private slugToPhone = new Map<string, string>();
  // Business slug → display name lookup
  private slugToName = new Map<string, string>();
  // Track last sender per business for reply routing
  private lastSender = new Map<string, string>();
  // Deduplication set (cleared hourly)
  private seenMessageSids = new Set<string>();
  private dedupeInterval: ReturnType<typeof setInterval> | null = null;
  // Track if we're shutting down
  private shuttingDown = false;
  // Telegram logs channel config
  private tgBotToken: string;
  private tgLogsChannelId: string;

  constructor(
    accountSid: string,
    authToken: string,
    port: number,
    tgBotToken: string,
    tgLogsChannelId: string,
    opts: ChannelOpts,
  ) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.port = port;
    this.tgBotToken = tgBotToken;
    this.tgLogsChannelId = tgLogsChannelId;
    this.opts = opts;
    this.client = new TwilioClient(accountSid, authToken);
    this.startTime = Date.now();
  }

  /** Load businesses.json and build phone→slug maps */
  private loadBusinesses(): void {
    const bizPath = path.join(DATA_DIR, 'businesses.json');
    if (!fs.existsSync(bizPath)) {
      logger.warn('businesses.json not found — no Twilio routing available');
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(bizPath, 'utf-8'));
      for (const [slug, biz] of Object.entries(data.businesses) as [
        string,
        any,
      ][]) {
        if (!biz.active) continue;
        const phone = biz.channels?.twilio?.phone_number;
        if (phone) {
          this.phoneToSlug.set(phone, slug);
          this.slugToPhone.set(slug, phone);
          this.slugToName.set(slug, biz.display_name || slug);
          logger.info({ slug, phone }, 'Twilio number mapped to business');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load businesses.json');
    }
  }

  /** Post to Telegram logs channel if configured */
  private logToTelegram(message: string): void {
    if (this.tgBotToken && this.tgLogsChannelId) {
      postToLogsChannel(this.tgBotToken, this.tgLogsChannelId, message);
    }
  }

  async connect(): Promise<void> {
    this.loadBusinesses();

    // Clear deduplication set every hour
    this.dedupeInterval = setInterval(
      () => {
        this.seenMessageSids.clear();
      },
      60 * 60 * 1000,
    );

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'Twilio webhook server listening');
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.shuttingDown) {
      res.writeHead(503);
      res.end('Shutting down');
      return;
    }

    const url = req.url || '/';

    if (req.method === 'GET' && url === '/health') {
      this.handleHealth(res);
      return;
    }

    if (req.method === 'POST' && url === '/webhook/twilio/incoming') {
      this.handleIncoming(req, res);
      return;
    }

    if (req.method === 'POST' && url === '/webhook/twilio/status') {
      this.handleStatus(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private handleHealth(res: ServerResponse): void {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const health = {
      status: 'ok',
      uptime_seconds: uptimeSeconds,
      last_message_at: this.lastMessageAt,
      active_businesses: this.phoneToSlug.size,
      db_ok: true,
    };

    try {
      const dbPath = path.join(STORE_DIR, 'messages.db');
      fs.accessSync(dbPath, fs.constants.R_OK);
    } catch {
      health.db_ok = false;
      health.status = 'degraded';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }

  private handleIncoming(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const params = parseUrlEncoded(body);

      // Validate Twilio signature
      const signature = req.headers['x-twilio-signature'] as string;
      if (!signature) {
        logger.warn('Twilio webhook: missing signature');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const webhookUrl = `https://api.robotchicken.top${req.url}`;
      try {
        if (
          !validateTwilioSignature(
            this.authToken,
            signature,
            webhookUrl,
            params,
          )
        ) {
          logger.warn('Twilio webhook: invalid signature');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      } catch {
        logger.warn('Twilio webhook: signature validation error');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Respond immediately with empty TwiML
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');

      // Process asynchronously
      this.processIncoming(params).catch((err) => {
        logger.error({ err }, 'Error processing incoming Twilio message');
      });
    });
  }

  private async processIncoming(params: Record<string, string>): Promise<void> {
    const msg: TwilioMessage = {
      MessageSid: params.MessageSid || '',
      From: params.From || '',
      To: params.To || '',
      Body: params.Body || '',
      AccountSid: params.AccountSid || '',
      NumMedia: params.NumMedia || '0',
    };

    // Deduplication
    if (this.seenMessageSids.has(msg.MessageSid)) {
      logger.debug(
        { sid: msg.MessageSid },
        'Duplicate Twilio message, skipping',
      );
      return;
    }
    this.seenMessageSids.add(msg.MessageSid);
    this.lastMessageAt = new Date().toISOString();

    // Detect channel: WhatsApp if From starts with "whatsapp:"
    const isWhatsApp = msg.From.startsWith('whatsapp:');
    const senderPhone = isWhatsApp
      ? msg.From.replace('whatsapp:', '')
      : msg.From;
    const toPhone = isWhatsApp ? msg.To.replace('whatsapp:', '') : msg.To;

    // Lookup business by "To" phone number
    const slug = this.phoneToSlug.get(toPhone);
    if (!slug) {
      logger.warn(
        { to: toPhone, from: senderPhone },
        'Twilio message to unrecognized number',
      );
      return;
    }

    // JID is per-business (all senders → same group)
    const chatJid = `tw:${slug}`;
    const channelName = isWhatsApp ? 'whatsapp' : 'sms';
    const timestamp = new Date().toISOString();
    const bizName = this.slugToName.get(slug) || slug;

    // Track last sender for reply routing
    this.lastSender.set(slug, isWhatsApp ? msg.From : senderPhone);

    // Determine content (handle media)
    let content = msg.Body || '';
    const numMedia = parseInt(msg.NumMedia || '0', 10);
    if (numMedia > 0) {
      content = content
        ? `${content} [+${numMedia} media]`
        : `[${numMedia} media attachment(s)]`;
    }

    if (!content) return;

    // Log to Telegram logs channel
    this.logToTelegram(
      `[${slug}] \u{1f4e9} ${senderPhone} \u{2192} ${bizName}: '${content}'`,
    );

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      `${bizName} (${channelName})`,
      channelName,
      false,
    );

    // Check if this business JID is registered
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, slug }, 'Twilio message for unregistered JID');
      return;
    }

    // Deliver message to NanoClaw with sender info in content
    this.opts.onMessage(chatJid, {
      id: msg.MessageSid,
      chat_jid: chatJid,
      sender: senderPhone,
      sender_name: senderPhone,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, slug, channel: channelName, from: senderPhone },
      'Twilio message delivered',
    );
  }

  private handleStatus(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const params = parseUrlEncoded(body);
      logger.debug(
        {
          sid: params.MessageSid,
          status: params.MessageStatus,
          to: params.To,
        },
        'Twilio delivery status',
      );
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // JID format: tw:{slug}
    const parts = jid.split(':');
    if (parts.length < 2 || parts[0] !== 'tw') {
      logger.error({ jid }, 'Invalid Twilio JID format');
      return;
    }
    const slug = parts[1];

    // Find the business phone number
    const fromPhone = this.slugToPhone.get(slug);
    if (!fromPhone) {
      logger.error({ slug }, 'No Twilio number configured for business');
      return;
    }

    // Get the last sender for this business to know who to reply to
    const recipientPhone = this.lastSender.get(slug);
    if (!recipientPhone) {
      logger.error({ slug }, 'No recent sender to reply to');
      return;
    }

    const bizName = this.slugToName.get(slug) || slug;

    try {
      const result = await this.client.sendMessage(
        fromPhone,
        recipientPhone,
        text,
      );
      logger.info(
        { jid, to: recipientPhone, sid: result.sid, length: text.length },
        'Twilio message sent',
      );
      // Log outbound to Telegram logs channel
      this.logToTelegram(
        `[${slug}] \u{1f4e4} ${bizName} \u{2192} ${recipientPhone}: '${text}'`,
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Twilio message');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tw:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;

    if (this.dedupeInterval) {
      clearInterval(this.dedupeInterval);
      this.dedupeInterval = null;
    }

    this.client.destroy();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('Twilio webhook server stopped');
          resolve();
        });
      });
    }
  }
}

// --- Self-registration ---

registerChannel('twilio', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WEBHOOK_PORT',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_LOGS_CHANNEL_ID',
  ]);
  const accountSid =
    process.env.TWILIO_ACCOUNT_SID || envVars.TWILIO_ACCOUNT_SID || '';
  const authToken =
    process.env.TWILIO_AUTH_TOKEN || envVars.TWILIO_AUTH_TOKEN || '';
  const port = parseInt(
    process.env.TWILIO_WEBHOOK_PORT || envVars.TWILIO_WEBHOOK_PORT || '3001',
    10,
  );
  const tgBotToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  const tgLogsChannelId =
    process.env.TELEGRAM_LOGS_CHANNEL_ID ||
    envVars.TELEGRAM_LOGS_CHANNEL_ID ||
    '';

  if (!accountSid || !authToken) {
    logger.info('Twilio: credentials not set, channel disabled');
    return null;
  }

  return new TwilioChannel(
    accountSid,
    authToken,
    port,
    tgBotToken,
    tgLogsChannelId,
    opts,
  );
});
