/**
 * scripts/twilio-send.ts — Manual Twilio message sender for testing
 * Usage: npx tsx scripts/twilio-send.ts --to "+353851234567" --from "biz-ie-01" --body "Test"
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const to = getArg('to');
const fromSlug = getArg('from');
const body = getArg('body');

if (!to || !fromSlug || !body) {
  console.error(
    'Usage: npx tsx scripts/twilio-send.ts --to "+1234567890" --from "biz-ie-01" --body "Hello"',
  );
  process.exit(1);
}

// Load credentials from .env
const envPath = path.resolve(process.cwd(), '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) env[match[1]] = match[2];
}

const accountSid = env.TWILIO_ACCOUNT_SID;
const authToken = env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) {
  console.error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
  process.exit(1);
}

// Load businesses.json to find the phone number
const bizPath = path.resolve(process.cwd(), 'data', 'businesses.json');
const businesses = JSON.parse(fs.readFileSync(bizPath, 'utf-8'));
const biz = businesses.businesses[fromSlug];
if (!biz) {
  console.error(`Business ${fromSlug} not found in businesses.json`);
  process.exit(1);
}
const fromPhone = biz.channels?.twilio?.phone_number;
if (!fromPhone) {
  console.error(`No Twilio number configured for ${fromSlug}`);
  process.exit(1);
}

console.log(`Sending from ${fromPhone} (${fromSlug}) to ${to}: "${body}"`);

const postData = new URLSearchParams({ From: fromPhone, To: to, Body: body }).toString();

const req = https.request(
  {
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
    method: 'POST',
    auth: `${accountSid}:${authToken}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
    res.on('end', () => {
      const json = JSON.parse(body);
      if (res.statusCode && res.statusCode >= 400) {
        console.error(`Error ${res.statusCode}: ${json.message || body}`);
      } else {
        console.log(`Sent! SID: ${json.sid}, Status: ${json.status}`);
      }
    });
  },
);
req.on('error', (err) => console.error('Request error:', err));
req.write(postData);
req.end();
