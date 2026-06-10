import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "b", "i", "em", "strong", "u", "s", "strike",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "a", "span",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "target", "rel"],
  span: ["class"],
  p: ["class"],
};

/**
 * Strip all tags and attributes not on the allowlist.
 * Suitable for Quill editor output stored in description fields.
 */
export function sanitizeRichText(html: string): string {
  if (!html || typeof html !== "string") return html;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    // Force safe values on links — prevents javascript: href
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  });
}
