import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';
import { WaGatewayClient } from './whatsapp/client.js';
import { sendQuotedReply } from './whatsapp/dispatcher.js';
import { routeIncomingMessage } from './whatsapp/router.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { appLogger, baileysLogger } = createAppLogger(config.logLevel);
  const loggedDiscoveryGroups = new Set<string>();

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
      appLogger.info(
        {
          groupJid: trigger.groupJid,
          senderName: trigger.senderName,
          senderJid: trigger.senderJid,
          triggerReason: trigger.triggerReason,
          cleanPromptText: trigger.cleanPromptText,
          hasQuotedContext: Boolean(trigger.quotedContext),
        },
        'Aigis trigger matched.',
      );

      // Modul 1 diagnostic echo so live group @tag & reply routing can be verified before Modul 2 LLM integration.
      const promptPreview = trigger.cleanPromptText || '(ping without text)';
      const diagnosticReply = [
        `Systems online, ${trigger.senderName}.`,
        `Trigger detected (${trigger.triggerReason}): "${promptPreview}".`,
        'LLM module is not attached yet — Stage 2 gateway routing verified, for sure!',
      ].join(' ');

      await sendQuotedReply(sock, trigger.groupJid, diagnosticReply, msg, appLogger);
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
