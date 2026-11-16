import { jidDecode } from '@whiskeysockets/baileys';
import { AigisBrain } from './brain/llmClient.js';
import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';
import { WaGatewayClient } from './whatsapp/client.js';
import { sendQuotedReply } from './whatsapp/dispatcher.js';
import { routeIncomingMessage } from './whatsapp/router.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { appLogger, baileysLogger } = createAppLogger(config.logLevel);
  const brain = new AigisBrain(config, appLogger);
  const loggedDiscoveryGroups = new Set<string>();

  if (!config.geminiApiKey) {
    appLogger.warn('GEMINI_API_KEY is not set in .env; Aigis will reply with configuration fallback.');
  }

  const gateway = new WaGatewayClient(config, appLogger, baileysLogger, async (messages, identity, sock) => {
    for (const msg of messages) {
      const decision = routeIncomingMessage(msg, identity, config.allowedGroupJids);

      if (!decision.matched) {
        // When ALLOWED_GROUP_JIDS is empty, log newly seen group JIDs once for easy .env setup.
        if (
          config.allowedGroupJids.size === 0 &&
          decision.reason === 'group_not_whitelisted' &&
          decision.groupJid &&
          !loggedDiscoveryGroups.has(decision.groupJid)
        ) {
          loggedDiscoveryGroups.add(decision.groupJid);
          appLogger.info(
            { groupJid: decision.groupJid, senderName: msg.pushName ?? 'Unknown' },
            'Observed unwhitelisted group activity (Discovery Mode).',
          );
        }
        continue;
      }

      const { trigger } = decision;
      const quotedUser = trigger.quotedContext?.participantJid
        ? jidDecode(trigger.quotedContext.participantJid)?.user
        : undefined;

      appLogger.info(
        {
          groupJid: trigger.groupJid,
          senderName: trigger.senderName,
          triggerReason: trigger.triggerReason,
          hasQuotedContext: Boolean(trigger.quotedContext),
        },
        'Aigis trigger matched; generating reply...',
      );

      const brainResponse = await brain.generateReply({
        senderName: trigger.senderName,
        senderJid: trigger.senderJid,
        promptText: trigger.cleanPromptText,
        quotedText: trigger.quotedContext?.text,
        quotedParticipantLabel: quotedUser ? `Member (${quotedUser})` : undefined,
      });

      appLogger.info(
        {
          groupJid: trigger.groupJid,
          mode: brainResponse.mode,
          provider: brainResponse.provider,
          modelUsed: brainResponse.modelUsed,
          groundingCount: brainResponse.groundingUrls.length,
        },
        'Sending Aigis reply.',
      );

      await sendQuotedReply(sock, trigger.groupJid, brainResponse.formattedText, msg, appLogger);
    }
  });

  const shutdown = async (signal: string) => {
    appLogger.info({ signal }, 'Shutting down AigisBot gracefully...');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await gateway.start();
}

void main().catch((err: unknown) => {
  console.error('Fatal error starting AigisBot:', err);
  process.exit(1);
});
