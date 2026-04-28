/**
 * MCP server factory — shared between local HTTP runner and Vercel handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerServicesTools } from "./tools/services.js";
import { registerGroupsTools } from "./tools/groups.js";
import { registerCheckInsTools } from "./tools/checkins.js";
import { registerGivingTools } from "./tools/giving.js";
import { registerListsTools } from "./tools/lists.js";
import { registerHouseholdsTools } from "./tools/households.js";
import { registerWorkflowsTools } from "./tools/workflows.js";
import { registerFormsTools } from "./tools/forms.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "planning-center-mcp-server",
    version: "1.1.0",
  });

  // Existing
  registerPeopleTools(server);
  registerServicesTools(server);
  registerGroupsTools(server);
  registerCheckInsTools(server);
  registerGivingTools(server);

  // Wave 1 — People expansion
  registerListsTools(server);
  registerHouseholdsTools(server);
  registerWorkflowsTools(server);
  registerFormsTools(server);

  return server;
}
