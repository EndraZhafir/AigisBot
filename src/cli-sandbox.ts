import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AigisBrain } from './brain/llmClient.js';
import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';

async function runSandbox(): Promise<void> {
  const config = loadConfig();
  const { appLogger } = createAppLogger(config.logLevel === 'info' ? 'warn' : config.logLevel);
  const brain = new AigisBrain(config, appLogger);

  const rl = readline.createInterface({ input, output });
  let pendingQuoteText: string | undefined;
  let simulateDarkHour = false;

  console.log('=== AigisBot CLI Sandbox (Mode Santai & Mode Serius) ===');
  console.log(`Model: ${config.geminiModel} | Search Grounding: ${config.enableSearchGrounding}`);
  console.log('Commands:');
  console.log('  /quote <text>   -> Simulate replying to another member message on next prompt');
  console.log('  /darkhour       -> Toggle Dark Hour clock (00:15 WIB)');
  console.log('  /exit           -> Quit sandbox\n');

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

      if (rawLine.startsWith('/quote ')) {
        pendingQuoteText = rawLine.slice('/quote '.length).trim();
        console.log(`Quoted text armed for next message: "${pendingQuoteText}"\n`);
        continue;
      }

      const now = simulateDarkHour ? new Date('2026-11-16T17:15:00.000Z') : new Date();
      const response = await brain.generateReply({
        senderName: 'Zhafir (Sandbox)',
        senderJid: 'sandbox-user@s.whatsapp.net',
        promptText: rawLine,
        quotedText: pendingQuoteText,
        quotedParticipantLabel: pendingQuoteText ? 'Group Member' : undefined,
        now,
      });

      pendingQuoteText = undefined;
      const modelLabel = response.modelUsed ? `:${response.modelUsed}` : '';
      console.log(`\nAigis [${response.mode} | ${response.provider}${modelLabel}] >\n${response.formattedText}\n`);
    }
  } finally {
    rl.close();
  }
}

void runSandbox();
