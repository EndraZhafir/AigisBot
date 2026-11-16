import { loadConfig } from './config/env.js';
import { createAppLogger } from './config/logger.js';

function bootstrap(): void {
  const config = loadConfig();
  const { appLogger } = createAppLogger(config.logLevel);

  appLogger.info(
    {
      nodeEnv: config.nodeEnv,
      waAuthDir: config.waAuthDir,
      pairingMode: config.waPairingPhone ? 'pairing_code' : 'qr_code',
      allowedGroupCount: config.allowedGroupJids.size,
      ownerCount: config.botOwnerNumbers.size,
    },
    'AigisBot Stage 1 config initialized. Ready for Stage 2 Baileys gateway integration.',
  );
}

bootstrap();
