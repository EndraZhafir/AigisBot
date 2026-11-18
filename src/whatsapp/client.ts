import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import type { AppConfig } from '../config/env.js';
import type { BotIdentity } from './types.js';

export type IncomingMessagesHandler = (
  messages: WAMessage[],
  identity: BotIdentity,
  sock: WASocket,
) => Promise<void>;

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_500;

function getDisconnectStatusCode(error: Error | undefined): number | undefined {
  if (!error) {
    return undefined;
  }

  if (error instanceof Boom) {
    return error.output.statusCode;
  }

  const maybeBoom = error as { output?: { statusCode?: number } };
  return maybeBoom.output?.statusCode;
}

/**
 * Manages the WhatsApp Multi-Device Baileys lifecycle: auth, pairing, reconnect backoff,
 * bot identity resolution (Phone JID + LID), and incoming message forwarding.
 */
export class WaGatewayClient {
  private sock: WASocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private isStopped = false;
  private cachedLidJid: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly appLogger: Logger,
    private readonly baileysLogger: Logger,
    private readonly onMessages: IncomingMessagesHandler,
    private readonly onGroupParticipantsUpdate?: (groupJid: string) => void,
  ) {}

  async start(): Promise<void> {
    this.isStopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      try {
        this.sock.ws.close();
      } catch {
        // Ignore socket close error during shutdown.
      }
      this.sock = undefined;
    }
  }

  private async connect(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.config.waAuthDir);
    const versionInfo = await fetchLatestBaileysVersion().catch((err: unknown) => {
      this.appLogger.warn({ err }, 'Could not fetch latest WA version; falling back to bundled version.');
      return undefined;
    });

    const sock = makeWASocket({
      ...(versionInfo ? { version: versionInfo.version } : {}),
      logger: this.baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger),
      },
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) =>
        Boolean(isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
    });

    this.sock = sock;
    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(sock, update, {
        isRegistered: state.creds.registered,
        hasRequestedPairing: () => pairingRequested,
        markPairingRequested: () => {
          pairingRequested = true;
        },
      });
    });

    sock.ev.on('messages.upsert', (upsert) => {
      // Only process real-time incoming messages; skip offline/history sync batches.
      if (upsert.type !== 'notify') {
        return;
      }

      const identity = this.resolveIdentity(sock);
      void this.onMessages(upsert.messages, identity, sock).catch((err: unknown) => {
        this.appLogger.error({ err }, 'Unhandled error inside message handler.');
      });
    });

    sock.ev.on('group-participants.update', (update) => {
      if (update.id) {
        this.onGroupParticipantsUpdate?.(update.id);
      }
    });
  }

  private async handleConnectionUpdate(
    sock: WASocket,
    update: BaileysEventMap['connection.update'],
    pairingCtrl: {
      isRegistered: boolean;
      hasRequestedPairing: () => boolean;
      markPairingRequested: () => void;
    },
  ): Promise<void> {
    if (update.qr && !pairingCtrl.isRegistered) {
      if (this.config.waPairingPhone) {
        if (!pairingCtrl.hasRequestedPairing()) {
          pairingCtrl.markPairingRequested();
          await this.requestAndPrintPairingCode(sock, this.config.waPairingPhone);
        }
      } else {
        this.appLogger.info('Scan QR code below using the bot WhatsApp app (Linked Devices):');
        qrcode.generate(update.qr, { small: true });
      }
    }

    if (update.connection === 'open') {
      this.reconnectAttempt = 0;
      await this.hydrateLidIdentity(sock);
      const identity = this.resolveIdentity(sock);
      this.appLogger.info(
        {
          phoneJid: identity.phoneJid,
          lidJid: identity.lidJid,
          allowedGroups: [...this.config.allowedGroupJids],
        },
        'WhatsApp gateway connected cleanly.',
      );

      if (this.config.allowedGroupJids.size === 0) {
        await this.logParticipatingGroups(sock);
      }
      return;
    }

    if (update.connection === 'close') {
      const statusCode = getDisconnectStatusCode(update.lastDisconnect?.error);
      this.handleDisconnect(statusCode, update.lastDisconnect?.error);
    }
  }

  private async requestAndPrintPairingCode(sock: WASocket, phone: string): Promise<void> {
    try {
      const rawCode = await sock.requestPairingCode(phone);
      const formatted = rawCode.match(/.{1,4}/g)?.join('-') ?? rawCode;
      this.appLogger.info(
        { phone, pairingCode: formatted },
        'Enter this 8-character Pairing Code in WhatsApp -> Linked Devices -> Link with phone number.',
      );
    } catch (err) {
      this.appLogger.error({ err, phone }, 'Failed to request WhatsApp Pairing Code.');
    }
  }

  private async hydrateLidIdentity(sock: WASocket): Promise<void> {
    if (sock.user?.lid) {
      this.cachedLidJid = jidNormalizedUser(sock.user.lid);
      return;
    }

    if (!sock.user?.id) {
      return;
    }

    try {
      const pnJid = jidNormalizedUser(sock.user.id);
      const mappedLid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
      if (mappedLid) {
        this.cachedLidJid = jidNormalizedUser(mappedLid);
      }
    } catch (err) {
      this.appLogger.debug({ err }, 'Could not resolve bot LID from Signal LIDMappingStore.');
    }
  }

  private resolveIdentity(sock: WASocket): BotIdentity {
    const rawPhoneJid = sock.user?.id ?? sock.authState.creds.me?.id;
    const rawLidJid = sock.user?.lid ?? sock.authState.creds.me?.lid ?? this.cachedLidJid;

    return {
      phoneJid: rawPhoneJid ? jidNormalizedUser(rawPhoneJid) : undefined,
      lidJid: rawLidJid ? jidNormalizedUser(rawLidJid) : undefined,
    };
  }

  private async logParticipatingGroups(sock: WASocket): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const summary = Object.values(groups).map((group) => ({
        groupJid: group.id,
        subject: group.subject,
        memberCount: group.participants.length,
      }));
      this.appLogger.info(
        { groups: summary },
        'ALLOWED_GROUP_JIDS is empty (Discovery Mode). Copy your test group JID into .env and restart.',
      );
    } catch (err) {
      this.appLogger.warn({ err }, 'Unable to fetch participating groups during discovery.');
    }
  }

  private handleDisconnect(statusCode: number | undefined, error: Error | undefined): void {
    if (this.isStopped) {
      return;
    }

    if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
      this.appLogger.error(
        { statusCode },
        'WhatsApp session logged out or forbidden. Delete auth_info/ and re-pair manually.',
      );
      return;
    }

    if (statusCode === DisconnectReason.connectionReplaced) {
      this.appLogger.error(
        { statusCode },
        'Session replaced by another active instance (440). Stop the other machine before restarting.',
      );
      return;
    }

    const isRestartRequired = statusCode === DisconnectReason.restartRequired;
    const delayMs = isRestartRequired
      ? 500
      : Math.min(BASE_BACKOFF_MS * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
    this.reconnectAttempt += 1;

    this.appLogger.warn(
      { statusCode, delayMs, attempt: this.reconnectAttempt, errMsg: error?.message },
      'WhatsApp connection closed. Scheduling safe reconnect.',
    );

    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((err: unknown) => {
        this.appLogger.error({ err }, 'Reconnect attempt failed.');
      });
    }, delayMs);
  }
}
