#!/usr/bin/env node
/**
 * A small, read-only SQLite MCP server.
 *
 * The database is selected when the process starts, never by a tool call. This
 * prevents an MCP client from using the server to browse arbitrary file paths.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_ROWS = 1_000;
const HELP = `Usage: sqlite-mcp [database-file]

Environment: SQLITE_MCP_DB=/absolute/or/relative/path.db

If no database is supplied, sqlite-mcp uses SQLITE_MCP_DB or, when exactly one
*.db, *.sqlite, or *.sqlite3 file is in the current directory, that file.`;

function databasePath(): string {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(HELP);
    process.exit(0);
  }

  const requested = arg ?? process.env.SQLITE_MCP_DB;
  if (requested) return resolve(requested);

  const candidates = readdirSync(process.cwd())
    .filter((name) => [".db", ".sqlite", ".sqlite3"].includes(extname(name).toLowerCase()));
  if (candidates.length === 1) return resolve(candidates[0]);

  throw new Error(
    candidates.length === 0
      ? `No SQLite database found in ${process.cwd()}.\n${HELP}`
      : `More than one SQLite database found. Pass one explicitly.\n${HELP}`,
  );
}

const dbFile = databasePath();
if (!existsSync(dbFile)) throw new Error(`Database does not exist: ${dbFile}`);

// Native node:sqlite avoids a native SQLite npm dependency. readOnly protects
// the database even if a query-validation edge case is discovered.
const db = new DatabaseSync(dbFile, { readOnly: true, allowExtension: false });

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Returns the first SQL keyword and rejects multiple real SQL statements.
 * Semicolons in quoted identifiers, string literals, and comments are legal. */
function validateReadQuery(sql: string): void {
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "lineComment" | "blockComment" = "normal";
  let statementEnded = false;

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const next = sql[i + 1];
    if (state === "lineComment") {
      if (c === "\n") state = "normal";
      continue;
    }
    if (state === "blockComment") {
      if (c === "*" && next === "/") { state = "normal"; i += 1; }
      continue;
    }
    if (state === "single") {
      if (c === "'" && next === "'") { i += 1; continue; }
      if (c === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (c === '"' && next === '"') { i += 1; continue; }
      if (c === '"') state = "normal";
      continue;
    }
    if (state === "backtick") { if (c === "`") state = "normal"; continue; }
    if (state === "bracket") { if (c === "]") state = "normal"; continue; }

    if (c === "-" && next === "-") { state = "lineComment"; i += 1; continue; }
    if (c === "/" && next === "*") { state = "blockComment"; i += 1; continue; }
    if (c === "'") { state = "single"; continue; }
    if (c === '"') { state = "double"; continue; }
    if (c === "`") { state = "backtick"; continue; }
    if (c === "[") { state = "bracket"; continue; }
    if (c === ";") {
      if (statementEnded) throw new Error("Only one SQL statement is allowed.");
      statementEnded = true;
      continue;
    }
    if (statementEnded && !/\s/.test(c)) throw new Error("Only one SQL statement is allowed.");
  }
  if (state === "single" || state === "double" || state === "backtick" || state === "bracket" || state === "blockComment") {
    throw new Error("Query contains an unterminated string, identifier, or comment.");
  }

  const firstKeyword = sql.replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))\s*/g, "").match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase();
  if (!firstKeyword) throw new Error("Query cannot be empty.");
  if (!["select", "with", "explain"].includes(firstKeyword)) {
    throw new Error("Only read queries starting with SELECT, WITH, or EXPLAIN are allowed.");
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return { type: "blob", base64: Buffer.from(item).toString("base64") };
    return item;
  }, 2);
}

const server = new McpServer({ name: "sqlite-mcp-local", version: "0.1.0" });

server.registerTool(
  "list_tables",
  {
    title: "List SQLite tables",
    description: "Lists user tables and views in the local SQLite database.",
    inputSchema: {},
  },
  async () => {
    const rows = db.prepare(`
      SELECT name, type, sql
      FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    return { content: [{ type: "text", text: json(rows) }] };
  },
);

server.registerTool(
  "get_schema",
  {
    title: "Get table or view schema",
    description: "Returns CREATE SQL, columns, indexes (with indexed columns), and foreign keys for one table or view.",
    inputSchema: {
      table_name: z.string().describe("Exact table or view name."),
    },
  },
  async (args) => {
    const tableName = text(args.table_name);
    const object = db.prepare(`
      SELECT name, type, sql FROM sqlite_master
      WHERE name = ? AND type IN ('table', 'view')
    `).get(tableName) as Record<string, unknown> | undefined;
    if (!object) {
      return { content: [{ type: "text", text: `No table or view named ${JSON.stringify(tableName)} exists.` }], isError: true };
    }
    const columns = db.prepare("SELECT * FROM pragma_table_info(?)").all(tableName);
    const indexList = db.prepare("SELECT * FROM pragma_index_list(?)").all(tableName) as Array<Record<string, unknown>>;
    const indexes = indexList.map((index) => ({
      ...index,
      columns: db.prepare("SELECT * FROM pragma_index_info(?)").all(String(index.name)),
    }));
    const foreignKeys = db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(tableName);
    return { content: [{ type: "text", text: json({ ...object, columns, indexes, foreign_keys: foreignKeys }) }] };
  },
);

server.registerTool(
  "execute_read_query",
  {
    title: "Execute a read-only SQL query",
    description: `Runs one read-only SELECT, WITH, or EXPLAIN query. Results are capped at ${MAX_ROWS} rows.`,
    inputSchema: {
      query: z.string().describe("A single read-only SQLite query."),
    },
  },
  async (args) => {
    try {
      const query = text(args.query);
      validateReadQuery(query);
      // Iteration means we stop reading once the cap is reached instead of
      // materializing an unbounded result set with StatementSync#all().
      const rows: unknown[] = [];
      let truncated = false;
      for (const row of db.prepare(query).iterate()) {
        if (rows.length === MAX_ROWS) { truncated = true; break; }
        rows.push(row);
      }
      return {
        content: [{ type: "text", text: json({ rows, truncated, row_limit: MAX_ROWS }) }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`sqlite-mcp-local: serving ${basename(dbFile)} (read-only) over stdio`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
