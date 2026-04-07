/**
 * Planning Center Check-Ins tools.
 * Wraps: GET /check-ins/v2/check_ins
 *        GET /check-ins/v2/events
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

interface CheckInAttributes {
  first_name?: string;
  last_name?: string;
  kind?: string;
  checked_out_at?: string | null;
  created_at?: string;
  emergency_contact_name?: string;
  emergency_contact_phone_number?: string;
  medical_notes?: string | null;
  number?: number;
}

interface EventAttributes {
  name?: string;
  attendance_count?: number;
  check_ins_count?: number;
  created_at?: string;
}

export function registerCheckInsTools(server: McpServer): void {
  server.registerTool(
    "pc_list_checkins",
    {
      title: "List Check-Ins",
      description: `List check-in records from Planning Center Check-Ins.

Can filter by event_id to show attendance for a specific event. Returns check-in time, person name, and kind (regular, guest, volunteer).

Args:
  - event_id (string, optional): Filter check-ins to a specific event ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

To find event IDs, call pc_list_checkins without event_id first and check the linked events, or use the PCO Check-Ins dashboard.

Examples:
  - "Who checked in this Sunday?" → event_id="<event_id>"
  - "Show recent check-in activity" → no event_id`,
      inputSchema: z.object({
        event_id: z.string().optional().describe("Filter check-ins by event ID"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ event_id, limit, offset, response_format }) => {
      try {
        const basePath = event_id
          ? `/check-ins/v2/events/${event_id}/check_ins`
          : "/check-ins/v2/check_ins";

        const params: Record<string, unknown> = {
          ...paginationParams(limit, offset),
          order: "-created_at",
        };

        const resp = await pcoGet<PcoResource>(basePath, params);
        const checkIns = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!checkIns.length) {
          return { content: [{ type: "text", text: "No check-ins found." }] };
        }

        const output = {
          ...pagination,
          offset,
          check_ins: checkIns.map((c) => ({ id: c.id, ...(c.attributes as CheckInAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Check-Ins (${pagination.count} of ${pagination.total})`, ""];
          for (const c of checkIns) {
            const a = c.attributes as CheckInAttributes;
            const name = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unknown";
            const time = a.created_at ? new Date(a.created_at).toLocaleString() : "Unknown time";
            lines.push(`- **${name}** — ${a.kind ?? "regular"} — ${time}`);
          }
          if (pagination.has_more) lines.push(`\n_More results — use offset=${pagination.next_offset}_`);
          text = lines.join("\n");
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use a smaller limit or event_id filter.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
