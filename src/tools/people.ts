/**
 * Planning Center People tools.
 * Wraps: GET /people/v2/people
 *        GET /people/v2/people/:id
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormat, DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import {
  pcoGet,
  handlePcoError,
  paginationParams,
  extractPagination,
  PcoResource,
} from "../services/pco-client.js";

interface PersonAttributes {
  first_name?: string;
  last_name?: string;
  name?: string;
  email?: string;
  phone_number?: string;
  birthdate?: string;
  gender?: string;
  grade?: string | null;
  site_administrator?: boolean;
  membership?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

function formatPerson(p: PcoResource, brief = false): string {
  const a = p.attributes as PersonAttributes;
  const lines: string[] = [];
  lines.push(`### ${a.name ?? `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()} (ID: ${p.id})`);
  if (!brief) {
    if (a.email) lines.push(`- **Email**: ${a.email}`);
    if (a.phone_number) lines.push(`- **Phone**: ${a.phone_number}`);
    if (a.birthdate) lines.push(`- **Birthdate**: ${a.birthdate}`);
    if (a.gender) lines.push(`- **Gender**: ${a.gender}`);
    if (a.membership) lines.push(`- **Membership**: ${a.membership}`);
    if (a.status) lines.push(`- **Status**: ${a.status}`);
  }
  return lines.join("\n");
}

export function registerPeopleTools(server: McpServer): void {
  // ─── pc_list_people ───────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_people",
    {
      title: "List / Search People",
      description: `Search and list congregation members in Planning Center People.

Supports partial-match name search via the 'search_name' parameter. Results are paginated.

Args:
  - search_name (string, optional): Filter by partial first/last name match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "total": number,
    "count": number,
    "offset": number,
    "has_more": boolean,
    "next_offset": number | undefined,
    "people": [{ "id": string, "name": string, "email": string, "status": string }]
  }

Examples:
  - "List all congregation members" → no search_name
  - "Find everyone named Smith" → search_name="smith"
  - "Get next page" → offset=25`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial name to search for"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
        response_format: z
          .nativeEnum(ResponseFormat)
          .default(ResponseFormat.MARKDOWN),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ search_name, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = {
          ...paginationParams(limit, offset),
          include: "emails",
        };
        if (search_name) params["where[search_name]"] = search_name;

        const resp = await pcoGet<PcoResource>("/people/v2/people", params);
        const people = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!people.length) {
          return { content: [{ type: "text", text: search_name ? `No people found matching "${search_name}".` : "No people found." }] };
        }

        const output = {
          ...pagination,
          offset,
          people: people.map((p) => ({
            id: p.id,
            name: (p.attributes as PersonAttributes).name ?? `${(p.attributes as PersonAttributes).first_name ?? ""} ${(p.attributes as PersonAttributes).last_name ?? ""}`.trim(),
            status: (p.attributes as PersonAttributes).status ?? null,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# People (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          text = [header, "", ...people.map((p) => formatPerson(p, true))].join("\n");
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

  // ─── pc_get_person ────────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_person",
    {
      title: "Get Person Profile",
      description: `Retrieve the full profile for a specific person in Planning Center by their ID.

Args:
  - person_id (string): The Planning Center person ID (e.g. "12345678")
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns all available profile fields: name, email, phone, birthdate, gender, membership, status, site_administrator flag, and timestamps.

Examples:
  - "Get details for person 12345678" → person_id="12345678"
  - Use pc_list_people first to find the ID if you only have a name`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("Planning Center person ID"),
        response_format: z
          .nativeEnum(ResponseFormat)
          .default(ResponseFormat.MARKDOWN),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ person_id, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/people/v2/people/${person_id}`, { include: "emails,phone_numbers,addresses" });
        const person = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const a = person.attributes as PersonAttributes;

        const output = { id: person.id, ...a };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = formatPerson(person, false);
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
