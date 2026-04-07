/**
 * Planning Center Groups tools.
 * Wraps: GET /groups/v2/groups
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormat, CHARACTER_LIMIT } from "../constants.js";
import { limitSchema, offsetSchema, responseFormatSchema } from "../schemas.js";
import {
  pcoGet,
  handlePcoError,
  paginationParams,
  extractPagination,
  PcoResource,
} from "../services/pco-client.js";

interface GroupAttributes {
  name?: string;
  description?: string;
  schedule?: string;
  location?: string;
  members_count?: number;
  enrollment_strategy?: string;
  public_church_center_web_url?: string;
  created_at?: string;
}

function formatGroup(g: PcoResource): string {
  const a = g.attributes as GroupAttributes;
  const lines = [`### ${a.name ?? "Unnamed Group"} (ID: ${g.id})`];
  if (a.description) lines.push(`> ${a.description}`);
  if (a.schedule) lines.push(`- **Schedule**: ${a.schedule}`);
  if (a.location) lines.push(`- **Location**: ${a.location}`);
  if (typeof a.members_count === "number") lines.push(`- **Members**: ${a.members_count}`);
  if (a.enrollment_strategy) lines.push(`- **Enrollment**: ${a.enrollment_strategy}`);
  return lines.join("\n");
}

export function registerGroupsTools(server: McpServer): void {
  server.registerTool(
    "pc_list_groups",
    {
      title: "List Groups",
      description: `List small groups / community groups from Planning Center Groups.

Supports optional name search and pagination.

Args:
  - search_name (string, optional): Filter groups by partial name match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns group name, description, schedule, location, member count, and enrollment strategy.

Examples:
  - "Show all groups" → no extra params
  - "Find groups named 'young adults'" → search_name="young adults"`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial group name to search for"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ search_name, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = paginationParams(limit, offset);
        if (search_name) params["where[name]"] = search_name;

        const resp = await pcoGet<PcoResource>("/groups/v2/groups", params);
        const groups = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!groups.length) {
          return { content: [{ type: "text", text: search_name ? `No groups found matching "${search_name}".` : "No groups found." }] };
        }

        const output = {
          ...pagination,
          offset,
          groups: groups.map((g) => ({ id: g.id, ...(g.attributes as GroupAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = `# Groups (${pagination.count} of ${pagination.total})\n\n` +
            groups.map(formatGroup).join("\n\n");
          if (pagination.has_more) text += `\n\n_More results — use offset=${pagination.next_offset}_`;
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use a smaller limit or search_name filter.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
