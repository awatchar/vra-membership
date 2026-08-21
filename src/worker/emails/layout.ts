import { ASSOCIATION_NAME } from '../lib/association';

/**
 * Email rendering.
 *
 * Every template describes itself as a list of blocks, and both the HTML and the
 * plain-text version are produced from that same list. This is the point of the
 * module: a plain-text fallback written by hand drifts from the HTML the first
 * time someone edits one of them, and the reader who gets the text version is
 * exactly the reader least likely to be able to work around a stale one
 * (Issue #1 section 55).
 *
 * The HTML is deliberately old-fashioned - tables, inline styles, one column,
 * 600px maximum. Email clients strip `<style>` blocks and ignore most modern
 * layout, and a single column is what makes it readable on a phone without any
 * media query at all.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface DetailRow {
  label: string;
  value: string;
}

export type EmailBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'lines'; lines: readonly string[] }
  | { kind: 'details'; rows: readonly DetailRow[] }
  | { kind: 'emphasis'; label: string; value: string }
  | { kind: 'button'; href: string; label: string }
  | { kind: 'note'; text: string };

export interface EmailDocument {
  subject: string;
  /** Shown by many clients next to the subject; the first line of context. */
  preheader: string;
  heading: string;
  blocks: readonly EmailBlock[];
}

const INK = '#141f2b';
const MUTED = '#59626e';
const RULE = '#dde2e8';
const ACCENT = '#1f4e79';
const PAGE = '#f4f6f8';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Sarabun,'Noto Sans Thai',Tahoma,sans-serif";

/**
 * Escapes text for HTML.
 *
 * Applied to every interpolated value without exception. Thai names do not
 * usually contain markup characters, but a template that escapes only the
 * fields someone thought were risky is one edit away from not escaping the one
 * that was.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Escapes a URL for an `href`.
 *
 * Only http(s) survives. A `javascript:` or `data:` URL in an email is not a
 * plausible mistake in this codebase, but the guard costs nothing and the
 * alternative is trusting every future caller of `button`.
 */
function safeHref(href: string): string {
  const allowed = /^https?:\/\//i.test(href);
  return escapeHtml(allowed ? href : '');
}

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${INK}">${escapeHtml(block.text)}</p>`;

    case 'lines':
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${INK}">${block.lines
        .map((line) => escapeHtml(line))
        .join('<br />')}</p>`;

    case 'details':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:collapse">${block.rows
        .map(
          (row) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid ${RULE};font-size:14px;color:${MUTED};vertical-align:top;width:42%">${escapeHtml(row.label)}</td>` +
            `<td style="padding:8px 0;border-bottom:1px solid ${RULE};font-size:15px;color:${INK};vertical-align:top">${escapeHtml(row.value)}</td></tr>`,
        )
        .join('')}</table>`;

    case 'emphasis':
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:collapse">` +
        `<tr><td style="padding:16px;background:${PAGE};border-radius:8px">` +
        `<div style="font-size:14px;color:${MUTED};margin-bottom:4px">${escapeHtml(block.label)}</div>` +
        `<div style="font-size:22px;font-weight:700;color:${INK}">${escapeHtml(block.value)}</div>` +
        `</td></tr></table>`
      );

    case 'button':
      // A table-wrapped anchor, because Outlook does not honour padding on an
      // inline element and the button would collapse to bare text.
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate">` +
        `<tr><td style="border-radius:8px;background:${ACCENT}">` +
        `<a href="${safeHref(block.href)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">${escapeHtml(block.label)}</a>` +
        `</td></tr></table>`
      );

    case 'note':
      return `<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:${MUTED}">${escapeHtml(block.text)}</p>`;
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
    case 'note':
      return block.text;
    case 'lines':
      return block.lines.join('\n');
    case 'details':
      return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    case 'emphasis':
      return `${block.label}: ${block.value}`;
    case 'button':
      // The label alone would be useless without somewhere to go.
      return `${block.label}: ${block.href}`;
  }
}

/** Renders one document to both formats. */
export function renderEmail(document: EmailDocument): RenderedEmail {
  const body = document.blocks.map(blockHtml).join('\n');

  const html = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(document.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(document.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE};border-collapse:collapse">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;border-collapse:collapse">
<tr><td style="padding:28px 24px;font-family:${FONT}">
<div style="font-size:14px;color:${MUTED};margin-bottom:6px">${escapeHtml(ASSOCIATION_NAME)}</div>
<h1 style="margin:0 0 20px;font-size:21px;line-height:1.4;color:${INK}">${escapeHtml(document.heading)}</h1>
${body}
</td></tr>
</table>
<div style="max-width:600px;padding:16px 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">
${escapeHtml(`${ASSOCIATION_NAME} — อีเมลนี้ส่งจากระบบอัตโนมัติ กรุณาอย่าตอบกลับ`)}
</div>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    ASSOCIATION_NAME,
    '',
    document.heading,
    '',
    ...document.blocks.map(blockText),
    '',
    'อีเมลนี้ส่งจากระบบอัตโนมัติ กรุณาอย่าตอบกลับ',
  ].join('\n\n');

  return { subject: document.subject, html, text };
}
