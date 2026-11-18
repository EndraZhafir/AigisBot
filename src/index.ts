import { jidDecode, type WASocket } from '@whiskeysockets/baileys';
import { AigisBrain } from './brain/llmClient.js';
import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';
import { GroupAdminResolver } from './guards/adminResolver.js';
import { TieredRateLimiter, buildRateLimitActorKey } from './guards/rateLimiter.js';
import { sanitizeIncomingText } from './guards/sanitize.js';
import { loadCommunitySeedFile, seedCommunityTrivia } from './memory/communitySeed.js';
import { MemoryContextService } from './memory/contextService.js';
import { closeMemoryDatabase, openMemoryDatabase } from './memory/database.js';
import { GroupBufferRepository } from './memory/groupBufferRepo.js';
import { MemberMemoryRepository } from './memory/memberMemoryRepo.js';
import { WaGatewayClient } from './whatsapp/client.js';
import { sendCooldownReaction, sendQuotedReply } from './whatsapp/dispatcher.js';
import { observeWhitelistedGroupMessage, routeIncomingMessage } from './whatsapp/router.js';

async function resolveAlternatePhoneJid(
  sock: WASocket,
  jid: string | undefined,
  existingAltJid: string | undefined,
): Promise<string | undefined> {
  if (existingAltJid || !jid) {
    return existingAltJid;
  }

  const decoded = jidDecode(jid);
  if (decoded?.server !== 'lid') {
    return undefined;
  }

  try {
    const mappedPn = await sock.signalRepository.lidMapping.getPNForLID(jid);
    return mappedPn ?? undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { appLogger, baileysLogger } = createAppLogger(config.logLevel);
  const brain = new AigisBrain(config, appLogger);
  const loggedDiscoveryGroups = new Set<string>();

  const db = openMemoryDatabase(config.dbPath, appLogger);
  const seedEntries = loadCommunitySeedFile(config.communitySeedPath, appLogger);
  if (seedEntries.length > 0) {
    seedCommunityTrivia(db, seedEntries);
  }

  const groupBufferRepo = new GroupBufferRepository(db);
  const memberMemoryRepo = new MemberMemoryRepository(db);
  const memoryContext = new MemoryContextService(
    groupBufferRepo,
    memberMemoryRepo,
    config.groupContextWindowSize,
    config.groupMessageRetentionLimit,
  );

  const adminResolver = new GroupAdminResolver(
    config.groupMetadataCacheTtlMs,
    config.botOwnerNumbers,
    appLogger,
  );
  const rateLimiter = new TieredRateLimiter({
    userCooldownMs: config.userCooldownMs,
    adminCooldownMs: config.adminCooldownMs,
    groupCooldownMs: config.groupCooldownMs,
    adminGroupCooldownMs: config.adminGroupCooldownMs,
  });

  if (!config.geminiApiKey) {
    appLogger.warn('GEMINI_API_KEY is not set in .env; Aigis will reply with configuration fallback.');
  }

  const gateway = new WaGatewayClient(
    config,
    appLogger,
    baileysLogger,
    async (messages, identity, sock) => {
      for (const msg of messages) {
        const observed = observeWhitelistedGroupMessage(msg, identity, config.allowedGroupJids);
        let resolvedSenderAltJid = observed?.senderAltJid;

        if (observed) {
          resolvedSenderAltJid = await resolveAlternatePhoneJid(
            sock,
            observed.senderJid,
            observed.senderAltJid,
          );
          const sanitizedObserved = sanitizeIncomingText(observed.cleanText, {
            maxChars: config.maxPromptChars,
          });
          memoryContext.recordObservedMessage({
            groupJid: observed.groupJid,
            messageId: observed.messageId,
            senderJid: observed.senderJid,
            senderAltJid: resolvedSenderAltJid,
            senderName: observed.senderName,
            text: sanitizedObserved.text || observed.cleanText,
            timestampMs: observed.timestampMs,
          });
        }

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
        const triggerSenderAltJid =
          resolvedSenderAltJid ??
          (await resolveAlternatePhoneJid(sock, trigger.senderJid, trigger.senderAltJid));

        const adminResolution = await adminResolver.resolveSenderTier(
          sock,
          trigger.groupJid,
          trigger.senderJid,
          triggerSenderAltJid,
        );
        const actorKey = buildRateLimitActorKey(trigger.senderJid, triggerSenderAltJid);
        const limitDecision = rateLimiter.tryAcquire({
          groupJid: trigger.groupJid,
          actorKey,
          tier: adminResolution.tier,
        });

        if (!limitDecision.allowed) {
          appLogger.info(
            {
              botEvent: 'cooldown_hit',
              groupJid: trigger.groupJid,
              senderName: trigger.senderName,
              actorKey: limitDecision.actorKey,
              tier: limitDecision.tier,
              resolvedBy: adminResolution.resolvedBy,
              reason: limitDecision.reason,
              retryAfterMs: limitDecision.retryAfterMs,
              shouldReact: limitDecision.shouldReact,
            },
            'Rate-limited incoming Aigis trigger.',
          );

          if (limitDecision.shouldReact && config.cooldownReactionEmoji) {
            await sendCooldownReaction(
              sock,
              trigger.groupJid,
              msg,
              config.cooldownReactionEmoji,
              appLogger,
            );
          }
          continue;
        }

        try {
          const sanitizedPrompt = sanitizeIncomingText(trigger.cleanPromptText, {
            maxChars: config.maxPromptChars,
          });
          const sanitizedQuote = trigger.quotedContext?.text
            ? sanitizeIncomingText(trigger.quotedContext.text, {
                maxChars: config.maxQuotedChars,
              })
            : undefined;

          if (sanitizedPrompt.hadInjectionSignals || sanitizedQuote?.hadInjectionSignals) {
            appLogger.warn(
              {
                botEvent: 'prompt_injection_neutralized',
                groupJid: trigger.groupJid,
                senderName: trigger.senderName,
                actorKey,
              },
              'Neutralized suspicious prompt-injection markers in incoming message.',
            );
          }

          const quotedParticipantAltJid = await resolveAlternatePhoneJid(
            sock,
            trigger.quotedContext?.participantJid,
            undefined,
          );

          const promptContext = memoryContext.preparePromptContext({
            groupJid: trigger.groupJid,
            currentMessageId: trigger.messageId,
            senderJid: trigger.senderJid,
            senderAltJid: triggerSenderAltJid,
            senderName: trigger.senderName,
            promptText: sanitizedPrompt.text,
            quotedText: sanitizedQuote?.text,
            quotedStanzaId: trigger.quotedContext?.stanzaId,
            quotedParticipantJid: trigger.quotedContext?.participantJid,
            quotedParticipantAltJid,
            timestampMs: trigger.timestampMs,
          });

          appLogger.info(
            {
              botEvent: 'mention_matched',
              groupJid: trigger.groupJid,
              senderName: trigger.senderName,
              tier: adminResolution.tier,
              resolvedBy: adminResolution.resolvedBy,
              triggerReason: trigger.triggerReason,
              hasQuotedContext: Boolean(trigger.quotedContext),
              windowCount: promptContext.recentMessages.length,
              bondLevel: promptContext.memberProfile.bondLevel,
              matchedTriviaCount: promptContext.matchedTrivia.length,
            },
            'Aigis trigger matched; generating reply...',
          );

          const brainResponse = await brain.generateReply({
            senderName: trigger.senderName,
            senderJid: trigger.senderJid,
            promptText: sanitizedPrompt.text,
            quotedText: sanitizedQuote?.text,
            quotedParticipantLabel: promptContext.quotedParticipantLabel,
            recentMessages: promptContext.recentMessages,
            memberProfile: promptContext.memberProfile,
            matchedTrivia: promptContext.matchedTrivia,
          });

          appLogger.info(
            {
              botEvent: 'reply_sent',
              groupJid: trigger.groupJid,
              mode: brainResponse.mode,
              provider: brainResponse.provider,
              modelUsed: brainResponse.modelUsed,
              groundingCount: brainResponse.groundingUrls.length,
            },
            'Sending Aigis reply.',
          );

          const sentMsg = await sendQuotedReply(
            sock,
            trigger.groupJid,
            brainResponse.formattedText,
            msg,
            appLogger,
          );

          memoryContext.recordBotReply({
            groupJid: trigger.groupJid,
            messageId: sentMsg?.key?.id ?? `bot-${Date.now()}-${trigger.messageId}`,
            botJid: identity.phoneJid ?? identity.lidJid ?? 'aigis@bot',
            text: brainResponse.formattedText,
          });
        } finally {
          limitDecision.releaseLock();
        }
      }
    },
    (groupJid) => {
      adminResolver.invalidateGroup(groupJid);
      appLogger.debug({ groupJid }, 'Invalidated cached group admin metadata after participant update.');
    },
  );

  const shutdown = async (signal: string) => {
    appLogger.info({ signal }, 'Shutting down AigisBot gracefully...');
    await gateway.stop();
    closeMemoryDatabase(db, appLogger);
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
