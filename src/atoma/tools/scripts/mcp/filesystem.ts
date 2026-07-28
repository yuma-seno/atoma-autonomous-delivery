#!/usr/bin/env bun
/**
 * filesystem.ts — Thin wrapper that starts the @modelcontextprotocol/
 * server-filesystem MCP server in-process, eliminating the 3-10 second
 * npx cold-start overhead.
 *
 * The server-filesystem package reads `process.argv.slice(2)` for the
 * list of allowed directories.  tools.yaml passes "." as the last arg
 * so the server grants access to the repository root.
 *
 * Tool filtering (read-only allowlist) is handled entirely by Atoma's
 * hooks in tools.yaml — this wrapper is purely server startup.
 *
 * IMPORTANT: this process's `process.stdout` IS the JSON-RPC transport —
 * never `console.log()` anywhere in this file; always `console.error()`
 * for logging.
 */
import "@modelcontextprotocol/server-filesystem/dist/index.js";
