/**
 * Vercel serverless handler for the Planning Center MCP server.
 *
 * Vercel automatically compiles this TypeScript file via @vercel/node.
 *
 * Required environment variables (set in Vercel dashboard):
 *   PCO_APP_ID  — Planning Center App ID
 *   PCO_SECRET  — Planning Center Personal Access Token Secret
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../src/server.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only accept POST (stateless JSON MCP)
  if (req.method === "GET") {
    res.status(405).json({
      error: "Method Not Allowed",
      message:
        "This MCP server uses stateless JSON transport. Send POST requests to /mcp.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no sessions
    enableJsonResponse: true,
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
