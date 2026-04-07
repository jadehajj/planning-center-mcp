/**
 * MCP server factory — shared between local HTTP runner and Vercel handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerServicesTools } from "./tools/services.js";
import { registerGroupsTools } from "./tools/groups.js";
import { registerCheckInsTools } from "./tools/checkins.js";
import { registerGivingTools } from "./tools/giving.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "planning-center-mcp-server",
    version: "1.0.0",
  });

  registerPeopleTools(server);
  registerServicesTools(server);
  registerGroupsTools(server);
  registerCheckInsTools(server);
  registerGivingTools(server);

  return server;
}
