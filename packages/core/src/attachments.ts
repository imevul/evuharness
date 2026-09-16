import type {
  AttachmentRef,
  ChatMessage,
  MessageContent,
  MessageContentPart,
} from '@evu/harness-protocol';
import { isAllowedAttachmentUrl, textFromMessageContent } from '@evu/harness-protocol';
import { wrapUntrustedToolResult } from './untrusted.js';

/** Soft limits so a single turn cannot flood the provider with megabytes. */
export const MAX_ATTACHMENT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 256 * 1024;

/**
 * Normalize and filter attachments for a turn.
 *
 * Drops entries that fail the image allowlist or exceed size limits. When the
 * feature flag is off, everything is dropped so a client cannot sneak payloads
 * past a host that disabled attachments.
 */
export function sanitizeAttachments(
  attachments: readonly AttachmentRef[] | undefined,
  enabled: boolean,
): AttachmentRef[] {
  if (!enabled || attachments === undefined || attachments.length === 0) {
    return [];
  }

  const accepted: AttachmentRef[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const url = attachment.url;
      if (url === undefined || !isAllowedAttachmentUrl(url)) {
        continue;
      }
      if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_IMAGE_BYTES) {
        continue;
      }
      // Data URLs encode ~4/3 of the raw bytes; reject obviously oversized payloads.
      if (url.startsWith('data:') && url.length > MAX_ATTACHMENT_IMAGE_BYTES * 2) {
        continue;
      }
      accepted.push({
        id: attachment.id,
        kind: 'image',
        name: attachment.name,
        mimeType: attachment.mimeType,
        url,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
      });
      continue;
    }

    let text = attachment.text;
    if (text !== undefined && text.length > MAX_ATTACHMENT_TEXT_CHARS) {
      text = `${text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n…[truncated]`;
    }
    accepted.push({
      id: attachment.id,
      kind: 'file',
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
      ...(text === undefined ? {} : { text }),
    });
  }
  return accepted;
}

/**
 * Build the model-facing content for one user turn.
 *
 * File text is appended (wrapped) into the text body. Allowlisted images become
 * OpenAI-compatible `image_url` parts so multimodal providers receive them.
 */
export function buildUserMessageContent(
  text: string,
  attachments: readonly AttachmentRef[],
): MessageContent {
  const fileBlocks: string[] = [];
  const imageParts: MessageContentPart[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.url !== undefined) {
      imageParts.push({
        type: 'image_url',
        image_url: { url: attachment.url },
      });
      continue;
    }

    const body =
      attachment.text !== undefined && attachment.text.trim() !== ''
        ? attachment.text
        : `(binary or empty file; mime=${attachment.mimeType}; size=${attachment.size ?? 'unknown'})`;
    fileBlocks.push(
      wrapUntrustedToolResult(
        `attachment:${attachment.name}`,
        `filename=${attachment.name}\nmime=${attachment.mimeType}\n---\n${body}`,
      ),
    );
  }

  const combined =
    fileBlocks.length === 0 ? text : `${text}\n\n${fileBlocks.join('\n\n')}`.trimStart();

  if (imageParts.length === 0) {
    return combined;
  }

  const parts: MessageContentPart[] = [];
  if (combined.trim() !== '') {
    parts.push({ type: 'text', text: combined });
  } else {
    parts.push({ type: 'text', text: '(image attachment)' });
  }
  parts.push(...imageParts);
  return parts;
}

/** Transcript-safe summary: wire text only; attachment payloads stay on `attachments`. */
export function transcriptTextForUserTurn(content: MessageContent): string {
  return textFromMessageContent(content);
}

/** Strip heavy image payloads from transcript attachment rows (keep name/kind/mime). */
export function transcriptAttachments(
  attachments: readonly AttachmentRef[],
): AttachmentRef[] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    if (attachment.kind === 'image') {
      return {
        id: attachment.id,
        kind: 'image',
        name: attachment.name,
        mimeType: attachment.mimeType,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        // Keep allowlisted https URLs for transcript preview; drop data URLs.
        ...(attachment.url?.startsWith('https:') && isAllowedAttachmentUrl(attachment.url)
          ? { url: attachment.url }
          : {}),
      };
    }
    return {
      id: attachment.id,
      kind: 'file',
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(attachment.size === undefined ? {} : { size: attachment.size }),
    };
  });
}

export function userMessageFromContent(content: MessageContent): ChatMessage {
  return { role: 'user', content };
}
