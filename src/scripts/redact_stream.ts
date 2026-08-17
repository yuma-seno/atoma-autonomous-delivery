#!/usr/bin/env bun
/**
 * redact_stream.ts — read stdin, write it back with credential-shaped text
 * removed.
 *
 * For workflow bash that is about to publish log text somewhere GitHub does not
 * mask. Actions substitutes `***` for registered secrets in the workflow LOG and
 * does nothing for an issue comment, so an excerpt lifted out of a log file and
 * posted as a comment arrives in the clear.
 *
 * Shape patterns only, by necessity and by design: the step that posts the
 * excerpt holds no credential values, and giving it some so it could match them
 * literally would put them in one more process's environment to protect one
 * comment. `domain/redaction.ts`'s patterns need no values at all.
 *
 * A net, not a control. See that module's header for what a shape check cannot
 * catch -- a value derived from a secret gets through, because nothing
 * distinguishes it from ordinary text.
 *
 * Usage:
 *   grep -i error logs.txt | bun run redact_stream.ts
 */
import { redact } from "../domain/redaction.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

async function main(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).text();
  process.stdout.write(redact(input));
}

if (import.meta.main) main();
