import { z } from 'zod';

/**
 * Attachment kinds the composer can insert as chips.
 *
 * Images travel as allowlisted media URLs to multimodal providers. Files carry
 * optional inline text for the model thread; binary payloads stay host-side.
 */
export const AttachmentKindSchema = z.enum(['image', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * A structured attachment reference on a user turn.
 *
 * The composer sends these alongside wire text and context-menu `refs[]` so the
 * runtime never has to re-parse chip labels to recover what was attached.
 *
 * `url` is only for images and must be allowlisted (`https:` or `data:image/*`)
 * before it reaches a provider. `text` is for non-image file contents (or a
 * truncated preview) wrapped as untrusted data on the model thread.
 */
export const AttachmentRefSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  /** Byte size when known. */
  size: z.number().int().nonnegative().optional(),
  /**
   * Allowlisted media source for images: `https:` or `data:image/*`.
   * Omitted for non-image files that only carry text.
   */
  url: z.string().min(1).optional(),
  /**
   * Inline text for non-image files. Never used as an image payload.
   */
  text: z.string().optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** Plain text part of a multimodal user message. */
export const TextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextContentPart = z.infer<typeof TextContentPartSchema>;

/**
 * Image part matching the OpenAI-compatible chat completions shape.
 *
 * `image_url.url` must already be allowlisted before it is stored or sent.
 */
export const ImageUrlContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
  }),
});
export type ImageUrlContentPart = z.infer<typeof ImageUrlContentPartSchema>;

export const MessageContentPartSchema = z.discriminatedUnion('type', [
  TextContentPartSchema,
  ImageUrlContentPartSchema,
]);
export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;

/** String content or OpenAI-compatible multimodal parts. */
export const MessageContentSchema = z.union([
  z.string(),
  z.array(MessageContentPartSchema).min(1),
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp)(?:;|,)/i;

/**
 * Whether an image URL may reach the model or a transcript renderer.
 *
 * Matches the markdown image allowlist: `https:` and raster `data:image/*`.
 */
export function isAllowedAttachmentUrl(url: string): boolean {
  if (url === '') return false;
  if (ALLOWED_DATA_IMAGE.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Flatten message content to plain text (ignores image parts). */
export function textFromMessageContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((part): part is TextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Stable wire token for an attachment chip.
 *
 * Tokens sit in the composer wire text next to context-menu tokens so caret
 * math and chip paint stay shared. Labels stay UI-only.
 */
export function attachmentToken(kind: AttachmentKind, name: string): string {
  const safe = name.replace(/[[\]]/g, '_');
  return kind === 'image' ? `[image:${safe}]` : `[file:${safe}]`;
}
