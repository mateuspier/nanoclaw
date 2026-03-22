---
name: business-config
description: Business registry with 3 active + 14 reserved businesses. Routing, activation workflow, CLAUDE.md agent prompts. Trigger on business, activate, routing, agent, or slug questions.
---

## Active Businesses
| Slug | Name | Number | Channels |
|------|------|--------|----------|
| biz-cn-01 | Genius | +12764962168 | SMS, TG |
| biz-ie-01 | Sou da Irlanda | +12762623230 | SMS, TG |
| biz-br-01 | MiauPop | +12762509968 | SMS, TG |

## Reserved (14)
biz-pt-01, biz-es-01, biz-mt-01, biz-br-02 to biz-br-05, biz-ca-01, biz-ie-02, biz-ie-03, biz-uk-01, biz-us-01, biz-int-01, biz-int-02

## Files
- data/businesses.json — full config (read for details)
- groups/{slug}/CLAUDE.md — agent personality, rules, FAQs
- groups/{slug}/memory/ — conversation memory
- data/sessions/ — session persistence per chat JID

## Activation Workflow
1. Set active:true in businesses.json
2. Buy Twilio number (US or local with regulatory bundle)
3. Configure webhook URL in Twilio console
4. Create Telegram bot via @BotFather
5. Create groups/{slug}/CLAUDE.md with personality + "no internet" instruction
6. Create groups/{slug}/memory/
7. sudo systemctl restart nanoclaw
8. Test: send SMS, verify response + Telegram Logs
