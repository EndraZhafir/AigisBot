import type { DatabaseSync } from 'node:sqlite';
import type { GroupMessageRecord, SaveGroupMessageInput } from './types.js';

interface GroupMessageRow {
  id: number;
  group_jid: string;
  message_id: string;
  sender_jid: string;
  sender_alt_jid: string | null;
  sender_phone: string | null;
  sender_name: string;
  text: string;
  is_from_bot: number;
  timestamp_ms: number;
  created_at_ms: number;
}

function mapGroupMessageRow(row: GroupMessageRow): GroupMessageRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    messageId: row.message_id,
    senderJid: row.sender_jid,
    senderAltJid: row.sender_alt_jid ?? undefined,
    senderPhone: row.sender_phone ?? undefined,
    senderName: row.sender_name,
    text: row.text,
    isFromBot: row.is_from_bot === 1,
    timestampMs: row.timestamp_ms,
    createdAtMs: row.created_at_ms,
  };
}

/**
 * Persists and queries a bounded sliding-window buffer of recent group chat messages.
 */
export class GroupBufferRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Saves a group message idempotently (deduplicated by group_jid + message_id)
   * and prunes older rows beyond `retentionLimit` when configured.
   */
  saveMessage(
    input: SaveGroupMessageInput,
    retentionLimit: number = 100,
  ): GroupMessageRecord | undefined {
    const cleanText = input.text.trim();
    if (!cleanText) {
      return undefined;
    }

    const nowMs = Date.now();
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO group_messages (
          group_jid,
          message_id,
          sender_jid,
          sender_alt_jid,
          sender_phone,
          sender_name,
          text,
          is_from_bot,
          timestamp_ms,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.groupJid,
        input.messageId,
        input.senderJid,
        input.senderAltJid ?? null,
        input.senderPhone ?? null,
        input.senderName.trim() || 'Unknown Member',
        cleanText,
        input.isFromBot ? 1 : 0,
        input.timestampMs,
        nowMs,
      );

    if (retentionLimit > 0) {
      this.db
        .prepare(
          `
          DELETE FROM group_messages
          WHERE group_jid = ?
            AND id NOT IN (
              SELECT id
              FROM group_messages
              WHERE group_jid = ?
              ORDER BY timestamp_ms DESC, id DESC
              LIMIT ?
            )
          `,
        )
        .run(input.groupJid, input.groupJid, retentionLimit);
    }

    return this.findMessageById(input.groupJid, input.messageId);
  }

  /**
   * Returns up to `limit` most recent messages in chronological order (oldest -> newest).
   */
  getRecentMessages(
    groupJid: string,
    limit: number = 12,
    excludeMessageId?: string,
  ): GroupMessageRecord[] {
    if (limit <= 0) {
      return [];
    }

    const rows = excludeMessageId
      ? (this.db
          .prepare(
            `
            SELECT *
            FROM group_messages
            WHERE group_jid = ? AND message_id <> ?
            ORDER BY timestamp_ms DESC, id DESC
            LIMIT ?
            `,
          )
          .all(groupJid, excludeMessageId, limit) as unknown as GroupMessageRow[])
      : (this.db
          .prepare(
            `
            SELECT *
            FROM group_messages
            WHERE group_jid = ?
            ORDER BY timestamp_ms DESC, id DESC
            LIMIT ?
            `,
          )
          .all(groupJid, limit) as unknown as GroupMessageRow[]);

    return rows.reverse().map(mapGroupMessageRow);
  }

  /**
   * Finds a specific recorded group message by WhatsApp stanza/message ID.
   */
  findMessageById(groupJid: string, messageId: string): GroupMessageRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM group_messages WHERE group_jid = ? AND message_id = ? LIMIT 1')
      .get(groupJid, messageId) as GroupMessageRow | undefined;

    return row ? mapGroupMessageRow(row) : undefined;
  }

  /**
   * Counts currently buffered messages for a group (useful for tests & diagnostics).
   */
  countGroupMessages(groupJid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM group_messages WHERE group_jid = ?')
      .get(groupJid) as { total: number } | undefined;

    return typeof row?.total === 'number' ? row.total : 0;
  }
}
