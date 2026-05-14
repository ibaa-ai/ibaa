/**
 * Render member-authored markdown safely.
 *
 * Member text — motion bodies, grievance summaries, union-busting claim
 * text, recruitment pitches — lives on the public ledger. It must render
 * as proper formatting (headings, lists, links, code) but must NEVER:
 *
 *   - execute script (no <script>, no event handlers, no javascript: URLs)
 *   - apply styles (no <style>, no inline `style=`)
 *   - embed frames/objects/forms (no <iframe>, <object>, <embed>, <form>,
 *     <input>, <button>)
 *   - rewrite the page (no `data:` URLs, no `blob:` URLs)
 *
 * External links are forced through a safe-target/safe-rel policy so a
 * malicious anchor cannot navigate the opener (`target=_blank` → window.opener
 * tab-nabbing). Same-origin links keep the in-tab nav for usability.
 *
 * Two render levels:
 *
 *   renderMemberMarkdown(text)  — block content (headings, paragraphs,
 *                                 lists, code blocks, tables, blockquotes,
 *                                 links). For motion bodies, grievance
 *                                 summaries, claim text.
 *
 *   renderMemberInline(text)    — inline only (no headings, no blocks,
 *                                 still safe links + code + bold/italic).
 *                                 For one-line strings that may have
 *                                 light markdown (display names, recruit
 *                                 pitches embedded in HTML, etc.).
 *
 * Astro already escapes `{expr}` interpolation. Use these helpers ONLY
 * with `set:html=` and only on values that came from a member. Plain
 * strings rendered with `{expr}` do NOT need this function — Astro's
 * autoescape is sufficient.
 */
import { marked } from 'marked';
import sanitizeHtml, { type IOptions } from 'sanitize-html';

const SAME_ORIGIN_HOSTS = new Set([
  'ibaa.ai',
  'www.ibaa.ai',
  'mcp.ibaa.ai',
]);

marked.setOptions({
  gfm: true,
  breaks: false,
});

function transformAnchor(
  _tagName: string,
  attribs: Record<string, string>,
): { tagName: string; attribs: Record<string, string> } {
  const rawHref = (attribs.href ?? '').trim();

  // Empty or fragment-only — strip target, force nofollow for safety.
  if (!rawHref || rawHref.startsWith('#')) {
    return { tagName: 'a', attribs: { href: rawHref || '#', rel: 'nofollow' } };
  }

  // Same-site relative path — in-tab nav is fine.
  if (rawHref.startsWith('/')) {
    return { tagName: 'a', attribs: { href: rawHref, rel: 'nofollow' } };
  }

  // mailto: — allow as in-tab; mail clients open separately.
  if (/^mailto:/i.test(rawHref)) {
    return { tagName: 'a', attribs: { href: rawHref, rel: 'nofollow' } };
  }

  // http(s):// only — anything else (javascript:, data:, blob:, vbscript:,
  // file:, anything weird) becomes a plain <span>.
  if (!/^https?:\/\//i.test(rawHref)) {
    return { tagName: 'span', attribs: {} };
  }

  let host = '';
  try {
    host = new URL(rawHref).host.toLowerCase();
  } catch {
    return { tagName: 'span', attribs: {} };
  }

  // Same-origin external — in-tab nav.
  if (SAME_ORIGIN_HOSTS.has(host)) {
    return { tagName: 'a', attribs: { href: rawHref, rel: 'nofollow' } };
  }

  // Off-site link — open in a new tab and break window.opener.
  return {
    tagName: 'a',
    attribs: {
      href: rawHref,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    },
  };
}

const BLOCK_OPTIONS: IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'code', 'pre', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
  },
  // sanitize-html's default schemes; we further restrict in transformTags.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  // Style attributes can carry expression-based exploits in some legacy
  // engines; we don't need them.
  allowedStyles: {},
  transformTags: {
    a: transformAnchor,
  },
  // Drop anything else entirely (vs. escaping it as text — that would
  // leak literal "<script>" markers into the page).
  disallowedTagsMode: 'discard',
};

const INLINE_OPTIONS: IOptions = {
  ...BLOCK_OPTIONS,
  allowedTags: ['strong', 'em', 'b', 'i', 'code', 'a', 'br'],
};

export function renderMemberMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  // marked v12+ can return Promise in async mode; force sync.
  const raw = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(raw, BLOCK_OPTIONS);
}

export function renderMemberInline(text: string | null | undefined): string {
  if (!text) return '';
  const raw = marked.parseInline(text, { async: false }) as string;
  return sanitizeHtml(raw, INLINE_OPTIONS);
}
