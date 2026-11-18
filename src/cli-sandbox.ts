import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AigisBrain } from './brain/llmClient.js';
import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';
import { sanitizeIncomingText } from './guards/sanitize.js';
import { loadCommunitySeedFile, seedCommunityTrivia } from './memory/communitySeed.js';
import { MemoryContextService } from './memory/contextService.js';
import { closeMemoryDatabase, openMemoryDatabase } from './memory/database.js';
import { GroupBufferRepository } from './memory/groupBufferRepo.js';
import { MemberMemoryRepository } from './memory/memberMemoryRepo.js';

const SANDBOX_GROUP_JID = 'sandbox-group@g.us';
const SANDBOX_USER_JID = 'sandbox-user@s.whatsapp.net';

async function runSandbox(): Promise<void> {
  const config = loadConfig();
  const { appLogger } = createAppLogger(config.logLevel === 'info' ? 'warn' : config.logLevel);
  const brain = new AigisBrain(config, appLogger);

  const db = openMemoryDatabase(':memory:', appLogger);
  const seedEntries = loadCommunitySeedFile(config.communitySeedPath, appLogger);
  const seededCount = seedCommunityTrivia(db, seedEntries);

  const groupBufferRepo = new GroupBufferRepository(db);
  const memberMemoryRepo = new MemberMemoryRepository(db);
  const memoryContext = new MemoryContextService(
    groupBufferRepo,
    memberMemoryRepo,
    config.groupContextWindowSize,
    config.groupMessageRetentionLimit,
  );

  const rl = readline.createInterface({ input, output });
  let pendingQuoteText: string | undefined;
  let pendingQuoteAuthor: string | undefined;
  let simulateDarkHour = false;
  let sequence = 0;

  console.log('=== AigisBot CLI Sandbox (Mode Santai, Mode Serius & SQLite Memory) ===');
  console.log(
    `Model: ${config.geminiModel} | Search Grounding: ${config.enableSearchGrounding} | Seeded Trivia: ${seededCount}`,
  );
  console.log('Commands:');
  console.log('  /chatter <Name>: <text> -> Simulate background group chatter without tagging Aigis');
  console.log('  /quote <text>           -> Simulate replying to another member message on next prompt');
  console.log('  /history                -> Inspect buffered sliding-window messages & Bond Rank');
  console.log('  /darkhour               -> Toggle Dark Hour clock (00:15 WIB)');
  console.log('  /exit                   -> Quit sandbox\n');

  try {
    while (true) {
      const prefix = simulateDarkHour ? '[DARK HOUR] ' : '';
      const rawLine = (await rl.question(`${prefix}You > `)).trim();
      if (!rawLine) {
        continue;
      }

      if (rawLine === '/exit' || rawLine === '/quit') {
        break;
      }

      if (rawLine === '/darkhour') {
        simulateDarkHour = !simulateDarkHour;
        console.log(`Dark Hour simulation: ${simulateDarkHour ? 'ON (00:15 WIB)' : 'OFF (Live clock)'}\n`);
        continue;
      }

      if (rawLine === '/history') {
        const recent = groupBufferRepo.getRecentMessages(SANDBOX_GROUP_JID, config.groupContextWindowSize);
        const member = memberMemoryRepo.getMemberByIdentity(SANDBOX_GROUP_JID, SANDBOX_USER_JID);
        console.log(`\n--- Sliding Window (${recent.length} messages) ---`);
        for (const msg of recent) {
          console.log(`- ${msg.isFromBot ? 'Aigis' : msg.senderName}: ${msg.text}`);
        }
        console.log(
          `--- Member Profile: ${member ? `${member.displayName} | Bond Rank ${member.bondLevel}/10 (${member.interactionCount} interactions)` : 'Not recorded yet'} ---\n`,
        );
        continue;
      }

      if (rawLine.startsWith('/chatter ')) {
        const payload = rawLine.slice('/chatter '.length).trim();
        const colonIdx = payload.indexOf(':');
        const speaker = colonIdx > 0 ? payload.slice(0, colonIdx).trim() : 'Comrade';
        const text = colonIdx > 0 ? payload.slice(colonIdx + 1).trim() : payload;
        if (!text) {
          console.log('Usage: /chatter <Name>: <message>\n');
          continue;
        }
        sequence += 1;
        const slug = speaker.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'comrade';
        memoryContext.recordObservedMessage({
          groupJid: SANDBOX_GROUP_JID,
          messageId: `sandbox-chatter-${sequence}`,
          senderJid: `sandbox-${slug}@lid`,
          senderName: speaker,
          text,
          timestampMs: Date.now(),
        });
        console.log(`Recorded background chatter from ${speaker}: "${text}"\n`);
        continue;
      }

      if (rawLine.startsWith('/quote ')) {
        pendingQuoteText = rawLine.slice('/quote '.length).trim();
        pendingQuoteAuthor = 'Group Member';
        console.log(`Quoted text armed for next message: "${pendingQuoteText}"\n`);
        continue;
      }

      sequence += 1;
      const messageId = `sandbox-msg-${sequence}`;
      const now = simulateDarkHour ? new Date('2026-11-16T17:15:00.000Z') : new Date();
      const timestampMs = now.getTime();
      const sanitizedPrompt = sanitizeIncomingText(rawLine, { maxChars: config.maxPromptChars });
      const sanitizedQuote = pendingQuoteText
        ? sanitizeIncomingText(pendingQuoteText, { maxChars: config.maxQuotedChars })
        : undefined;

      memoryContext.recordObservedMessage({
        groupJid: SANDBOX_GROUP_JID,
        messageId,
        senderJid: SANDBOX_USER_JID,
        senderName: 'Zhafir (Sandbox)',
        text: sanitizedPrompt.text,
        timestampMs,
      });

      const promptContext = memoryContext.preparePromptContext({
        groupJid: SANDBOX_GROUP_JID,
        currentMessageId: messageId,
        senderJid: SANDBOX_USER_JID,
        senderName: 'Zhafir (Sandbox)',
        promptText: sanitizedPrompt.text,
        quotedText: sanitizedQuote?.text,
        timestampMs,
      });

      const response = await brain.generateReply({
        senderName: 'Zhafir (Sandbox)',
        senderJid: SANDBOX_USER_JID,
        promptText: sanitizedPrompt.text,
        quotedText: sanitizedQuote?.text,
        quotedParticipantLabel: sanitizedQuote?.text ? (pendingQuoteAuthor ?? 'Group Member') : undefined,
        recentMessages: promptContext.recentMessages,
        memberProfile: promptContext.memberProfile,
        matchedTrivia: promptContext.matchedTrivia,
        now,
      });

      memoryContext.recordBotReply({
        groupJid: SANDBOX_GROUP_JID,
        messageId: `sandbox-bot-${sequence}`,
        botJid: 'aigis@bot',
        text: response.formattedText,
        timestampMs: timestampMs + 1,
      });

      pendingQuoteText = undefined;
      pendingQuoteAuthor = undefined;
      const modelLabel = response.modelUsed ? `:${response.modelUsed}` : '';
      console.log(
        `\nAigis [${response.mode} | ${response.provider}${modelLabel} | window:${promptContext.recentMessages.length} | bond:${promptContext.memberProfile.bondLevel}/10] >\n${response.formattedText}\n`,
      );
    }
  } finally {
    rl.close();
    closeMemoryDatabase(db, appLogger);
  }
}

void runSandbox();
