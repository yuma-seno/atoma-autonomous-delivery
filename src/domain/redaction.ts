/**
 * redaction.ts — removes credential-shaped text from what a run emits.
 *
 * Applied where a command's output enters the run, because that output reaches
 * three places and only one of them is protected. GitHub Actions substitutes
 * `***` for registered secrets in the workflow LOG; it does nothing for the issue
 * comment a run posts, or for the session JSON saved to the `atoma-data` branch.
 * Those two publish whatever they were given.
 *
 * Be clear about what this is not. It cannot catch a value derived from a secret
 * — a slice of a key, a base64 of one — because nothing distinguishes that from
 * ordinary text. It recognises the shapes credentials are issued in, and the
 * exact values this process was handed. A secret that has been transformed gets
 * through, so this is a net under the real controls, not one of them.
 */

/**
 * Credential formats worth recognising by shape.
 *
 * Each is a vendor-issued prefix followed by an opaque body, which is what makes
 * them safe to match: no ordinary sentence looks like one. Formats that are
 * merely long and random are left out, since matching those would redact
 * commit SHAs and test fixtures and teach everyone to distrust the output.
 */
const PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI and compatible
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub personal, OAuth, user, server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // any PEM private key
];

export const REDACTED = "[redacted]";

/** Shortest value from the environment worth substituting. */
const MIN_LITERAL_LENGTH = 12;

/**
 * The literal secret values this process holds, longest first.
 *
 * Longest first so that a value containing another is replaced whole rather than
 * broken into a redacted half and a readable remainder.
 *
 * Short values are skipped. A four-character variable would match inside
 * unrelated words and redact the output into uselessness, and something that
 * short is not a credential worth protecting this way.
 */
export function literalsFrom(env: Record<string, string | undefined>, names: readonly string[]): string[] {
  return names
    .map((name) => env[name] ?? "")
    .filter((value) => value.length >= MIN_LITERAL_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * `text` with every recognised credential replaced.
 *
 * Literals go first: a known value is replaced whole even where a pattern would
 * have matched only part of it.
 */
export function redact(text: string, literals: readonly string[] = []): string {
  let out = text;
  for (const literal of literals) out = out.split(literal).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
