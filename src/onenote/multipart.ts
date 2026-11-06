/**
 * RFC 7578 `multipart/form-data` payload builder for Microsoft Graph OneNote
 * InkML + Presentation HTML creation (`POST /sections/{id}/pages`) and
 * replacement (`PATCH /pages/{id}/content`).
 */

import { escapeHtml } from '../converter/inkmlExporter';

export interface MultipartFormPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly data: string | Uint8Array;
}

export interface EncodedMultipartPayload {
  readonly boundary: string;
  readonly contentTypeHeader: string;
  readonly body: Uint8Array;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

function toUint8Array(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? UTF8_ENCODER.encode(data) : data;
}

function toUtf8String(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : UTF8_DECODER.decode(data);
}

/**
 * Ensures the `<head><title>...</title></head>` element in a OneNote presentation
 * HTML document matches the target `title` without duplicating `<title>` tags.
 */
export function ensurePresentationHtmlTitle(
  htmlInput: string | Uint8Array,
  title: string
): string {
  const rawHtml = toUtf8String(htmlInput);
  const escapedTitle = escapeHtml(title);

  if (/<title>[\s\S]*?<\/title>/i.test(rawHtml)) {
    return rawHtml.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`);
  }

  if (/<head>/i.test(rawHtml)) {
    return rawHtml.replace(/<head>/i, `<head>\n    <title>${escapedTitle}</title>`);
  }

  if (/<html[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(
      /<html[^>]*>/i,
      (match) => `${match}\n  <head>\n    <title>${escapedTitle}</title>\n  </head>`
    );
  }

  return (
    `<html>\n  <head>\n    <title>${escapedTitle}</title>\n  </head>\n` +
    `  <body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">\n${rawHtml}\n  </body>\n</html>`
  );
}

/**
 * Serializes an ordered list of parts into a binary `multipart/form-data` payload.
 */
export function encodeMultipartFormData(
  parts: readonly MultipartFormPart[],
  customBoundary?: string
): EncodedMultipartPayload {
  const boundary =
    customBoundary ?? `rmOneNoteBoundary_${crypto.randomUUID().replace(/-/g, '')}`;

  const chunks: Uint8Array[] = [];
  const crlf = UTF8_ENCODER.encode('\r\n');

  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
      : `Content-Disposition: form-data; name="${part.name}"`;
    const headerBlock =
      `--${boundary}\r\n` +
      `${disposition}\r\n` +
      `Content-Type: ${part.contentType}\r\n\r\n`;

    chunks.push(UTF8_ENCODER.encode(headerBlock));
    chunks.push(toUint8Array(part.data));
    chunks.push(crlf);
  }

  chunks.push(UTF8_ENCODER.encode(`--${boundary}--\r\n`));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    boundary,
    contentTypeHeader: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}

export function buildUploadInkMlMultipart(params: {
  readonly title: string;
  readonly inkmlXml: string | Uint8Array;
  readonly presentationHtml: string | Uint8Array;
  readonly boundary?: string;
}): EncodedMultipartPayload {
  const normalizedHtml = ensurePresentationHtmlTitle(params.presentationHtml, params.title);

  return encodeMultipartFormData(
    [
      {
        name: 'presentation-onenote-inkml',
        filename: 'drawing.xml',
        contentType: 'application/inkml+xml',
        data: params.inkmlXml,
      },
      {
        name: 'presentation',
        filename: 'presentation.html',
        contentType: 'text/html',
        data: normalizedHtml,
      },
    ],
    params.boundary
  );
}

export function buildUpdateInkMlMultipart(params: {
  readonly title: string;
  readonly inkmlXml: string | Uint8Array;
  readonly presentationHtml: string | Uint8Array;
  readonly boundary?: string;
}): EncodedMultipartPayload {
  const normalizedHtml = ensurePresentationHtmlTitle(params.presentationHtml, params.title);
  const patchCommands = [
    {
      target: 'body',
      action: 'replace',
      content: normalizedHtml,
    },
  ];

  return encodeMultipartFormData(
    [
      {
        name: 'Commands',
        contentType: 'application/json',
        data: JSON.stringify(patchCommands),
      },
      {
        name: 'presentation-onenote-inkml',
        filename: 'drawing.xml',
        contentType: 'application/inkml+xml',
        data: params.inkmlXml,
      },
    ],
    params.boundary
  );
}

