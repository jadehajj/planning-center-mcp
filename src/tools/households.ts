/**
 * Planning Center People — Households tools.
 *
 * Wraps:
 *   GET /people/v2/households
 *   GET /people/v2/households/:id
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
  PcoResponse,
} from "../services/pco-client.js";

interface HouseholdAttributes {
  name?: string;
  member_count?: number;
  primary_contact_name?: string;
  primary_contact_id?: string;
  avatar?: string;
  created_at?: string;
  updated_at?: string;
}

interface PersonAttributes {
  name?: string;
  first_name?: string;
  last_name?: string;
  child?: boolean;
  birthdate?: string;
}

function formatHousehold(h: PcoResource): string {
  const a = h.attributes as HouseholdAttributes;
  const parts: string[] = [`### ${a.name ?? "(unnamed household)"} (ID: ${h.id})`];
  if (a.member_count !== undefined) parts.push(`- **Members**: ${a.member_count}`);
  if (a.primary_contact_name) parts.push(`- **Primary contact**: ${a.primary_contact_name}`);
  return parts.join("\n");
}

export function registerHouseholdsTools(server: McpServer): void {
  // ─── pc_list_households ──────────────────────────────────────────────────
  server.registerTool(
    "pc_list_households",
    {
      title: "List Households",
      description: `List households (family units) in Planning Center People.

Args:
  - search_name (string, optional): Filter by partial household name match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: household IDs, names, member counts, primary contact names.

Examples:
  - "List all households" → no params
  - "Find the Hajj family" → search_name="hajj"`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial household name to search for"),
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
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (search_name) params["where[name]"] = search_name;

        const resp = await pcoGet<PcoResource>("/people/v2/households", params);
        const households = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!households.length) {
          return { content: [{ type: "text", text: search_name ? `No households found matching "${search_name}".` : "No households found." }] };
        }

        const output = {
          ...pagination,
          offset,
          households: households.map((h) => {
            const a = h.attributes as HouseholdAttributes;
            return {
              id: h.id,
              name: a.name ?? null,
              member_count: a.member_count ?? null,
              primary_contact_name: a.primary_contact_name ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Households (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          text = [header, "", ...households.map(formatHousehold)].join("\n\n");
          if (pagination.has_more) text += `\n\n_More results available. Use offset=${pagination.next_offset} for the next page._`;
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use a smaller limit or add a search_name filter.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_get_household ────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_household",
    {
      title: "Get Household Detail",
      description: `Retrieve a specific household with all its members.

Args:
  - household_id (string): The household ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the household plus each member's id, name, child/adult flag, and birthdate.

Examples:
  - "Show me household 12345" → household_id="12345"`,
      inputSchema: z.object({
        household_id: z.string().min(1).describe("Planning Center household ID"),
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ household_id, response_format }) => {
      try {
        const resp = (await pcoGet<PcoResource>(`/people/v2/households/${household_id}`, {
          include: "people",
        })) as PcoResponse<PcoResource> & { included?: PcoResource[] };

        const household = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const included = (resp.included ?? []) as PcoResource[];
        const members = included.filter((r) => r.type === "Person");
        const a = household.attributes as HouseholdAttributes;

        const output = {
          id: household.id,
          ...a,
          members: members.map((p) => {
            const pa = p.attributes as PersonAttributes;
            return {
              id: p.id,
              name: pa.name ?? `${pa.first_name ?? ""} ${pa.last_name ?? ""}`.trim(),
              child: pa.child ?? null,
              birthdate: pa.birthdate ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# ${a.name ?? "(unnamed household)"} (ID: ${household.id})`,
            "",
            `- **Members**: ${a.member_count ?? members.length}`,
          ];
          if (a.primary_contact_name) lines.push(`- **Primary contact**: ${a.primary_contact_name}`);
          lines.push("", "## Members");
          for (const m of output.members) {
            const flag = m.child === true ? " (child)" : m.child === false ? " (adult)" : "";
            lines.push(`- **${m.name}** (ID: ${m.id})${flag}${m.birthdate ? ` — ${m.birthdate}` : ""}`);
          }
          text = lines.join("\n");
        } else {
          text = JSON.stringify(output, null, 2);
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
