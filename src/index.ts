#!/usr/bin/env node
/**
 * Planning Center MCP Server — local runner.
 *
 * For Vercel deployment, see api/mcp.ts which is the serverless entry point.
 * This file is for local development / stdio testing only.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express, { Request, Response } from "express";
import { createMcpServer } from "./server.js";

export { createMcpServer } from "./server.js";

// ─── HTTP transport (local) ──────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "planning-center-mcp-server", version: "1.0.0" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({ error: "Method Not Allowed — POST to /mcp" });
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`Planning Center MCP server running on http://localhost:${port}/mcp`);
  });
}

// ─── stdio transport ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Planning Center MCP server running via stdio");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const transportMode = process.env.TRANSPORT ?? "http";

if (transportMode === "stdio") {
  runStdio().catch((err) => { console.error(err); process.exit(1); });
} else {
  runHTTP().catch((err) => { console.error(err); process.exit(1); });
}
