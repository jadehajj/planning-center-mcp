/**
 * Planning Center Check-Ins — expanded tools.
 *
 * Wraps:
 *   GET /check-ins/v2/events
 *   GET /check-ins/v2/events/:id
 *   GET /check-ins/v2/events/:id/event_times
 *   GET /check-ins/v2/events/:id/locations
 *   GET /check-ins/v2/check_in_groups
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

interface EventAttributes {
  name?: string;
  frequency?: string;
  enable_services_integration?: boolean;
  archived_at?: string | null;
  integration_key?: string;
  location_times_enabled?: boolean;
  pre_select_enabled?: boolean;
  app_source?: string;
  created_at?: string;
  updated_at?: string;
}

interface EventTimeAttributes {
  starts_at?: string;
  ends_at?: string;
  hour?: number;
  minute?: number;
  day_of_week?: number;
  total_count?: number;
  regular_count?: number;
  guest_count?: number;
  volunteer_count?: number;
  name?: string | null;
  available_for_check_in?: boolean;
  hidden?: boolean;
  shows_at?: string;
  hides_at?: string;
  total_count_including_unconfirmed?: number;
}

interface LocationAttributes {
  name?: string;
  kind?: string;
  opened?: boolean;
  questions?: string;
  age_min_in_months?: number | null;
  age_max_in_months?: number | null;
  age_range_by?: string;
  age_on?: string | null;
  child_or_adult?: string;
  effective_date?: string | null;
  gender?: string;
  grade_min?: number | null;
  grade_max?: number | null;
  max_occupancy?: number | null;
  min_volunteers?: number | null;
  attendees_per_volunteer?: number | null;
  position?: number | null;
  updated_at?: string;
  created_at?: string;
  milestone?: string | null;
}

export function registerCheckInsExtraTools(server: McpServer): void {
  // ─── pc_list_events ──────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_checkin_events",
    {
      title: "List Check-In Events",
      description: `List check-in events (e.g. Sunday Service, Kids Programs, Youth Group).

Args:
  - search_name (string, optional): Filter by partial event name match
  - include_archived (boolean): Include archived events (default: false)
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: event ID, name, frequency, archived status.`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial event name to search for"),
        include_archived: z.boolean().optional().default(false).describe("Include archived events"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ search_name, include_archived, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (search_name) params["where[name]"] = search_name;
        if (!include_archived) params["filter"] = "not_archived";

        const resp = await pcoGet<PcoResource>("/check-ins/v2/events", params);
        const events = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!events.length) return { content: [{ type: "text", text: search_name ? `No events found matching "${search_name}".` : "No events found." }] };

        const output = {
          ...pagination,
          offset,
          events: events.map((e) => {
            const a = e.attributes as EventAttributes;
            return {
              id: e.id,
              name: a.name ?? null,
              frequency: a.frequency ?? null,
              archived: !!a.archived_at,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Check-In Events (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          const rows = output.events.map((e) => `- **${e.name ?? "(unnamed)"}** (ID: ${e.id})${e.frequency ? ` — ${e.frequency}` : ""}${e.archived ? " ⚠️ archived" : ""}`);
          text = [header, "", ...rows].join("\n");
          if (pagination.has_more) text += `\n\n_More results — use offset=${pagination.next_offset}_`;
        } else {
          text = JSON.stringify(output, null, 2);
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_get_checkin_event ────────────────────────────────────────────────
  server.registerTool(
    "pc_get_checkin_event",
    {
      title: "Get Check-In Event Detail",
      description: `Retrieve a specific check-in event including its event times (occurrences) with attendance counts.

Args:
  - event_id (string): The event ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: event metadata + event_times array with regular/guest/volunteer/total counts per occurrence.`,
      inputSchema: z.object({
        event_id: z.string().min(1).describe("Planning Center event ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, response_format }) => {
      try {
        const [eventResp, timesResp] = await Promise.all([
          pcoGet<PcoResource>(`/check-ins/v2/events/${event_id}`),
          pcoGet<PcoResource>(`/check-ins/v2/events/${event_id}/event_times`, { per_page: 50, order: "-starts_at" }),
        ]);

        const event = (Array.isArray(eventResp.data) ? eventResp.data[0] : eventResp.data) as PcoResource;
        const times = (Array.isArray(timesResp.data) ? timesResp.data : [timesResp.data]) as PcoResource[];
        const a = event.attributes as EventAttributes;

        const output = {
          id: event.id,
          ...a,
          event_times: times.map((t) => ({ id: t.id, ...(t.attributes as EventTimeAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# ${a.name ?? "(unnamed event)"} (ID: ${event.id})`];
          if (a.frequency) lines.push(`- **Frequency**: ${a.frequency}`);
          if (a.archived_at) lines.push(`- ⚠️ **Archived**: ${a.archived_at}`);
          if (times.length) {
            lines.push("", `## Recent occurrences (${times.length})`);
            for (const t of times) {
              const ta = t.attributes as EventTimeAttributes;
              const counts: string[] = [];
              if (ta.regular_count != null) counts.push(`${ta.regular_count} regulars`);
              if (ta.guest_count != null) counts.push(`${ta.guest_count} guests`);
              if (ta.volunteer_count != null) counts.push(`${ta.volunteer_count} volunteers`);
              if (ta.total_count != null) counts.push(`**${ta.total_count} total**`);
              lines.push(`- **${ta.starts_at ?? "?"}** (ID: ${t.id})${counts.length ? ` — ${counts.join(", ")}` : ""}`);
            }
          }
          text = lines.join("\n");
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated.]";
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_list_event_locations ─────────────────────────────────────────────
  server.registerTool(
    "pc_list_event_locations",
    {
      title: "List Locations for a Check-In Event",
      description: `List locations (rooms/stations) configured for a specific check-in event — useful for kids programs with multiple age-graded rooms.

Args:
  - event_id (string): The event ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: location ID, name, age range, gender, capacity, volunteer ratio.`,
      inputSchema: z.object({
        event_id: z.string().min(1).describe("Planning Center event ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/check-ins/v2/events/${event_id}/locations`, { ...paginationParams(limit, offset), order: "position" });
        const locs = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!locs.length) return { content: [{ type: "text", text: `No locations for event ${event_id}.` }] };

        const output = {
          ...pagination,
          offset,
          event_id,
          locations: locs.map((l) => {
            const a = l.attributes as LocationAttributes;
            return {
              id: l.id,
              name: a.name ?? null,
              kind: a.kind ?? null,
              opened: a.opened ?? null,
              max_occupancy: a.max_occupancy ?? null,
              child_or_adult: a.child_or_adult ?? null,
              gender: a.gender ?? null,
              age_min_months: a.age_min_in_months ?? null,
              age_max_months: a.age_max_in_months ?? null,
              grade_min: a.grade_min ?? null,
              grade_max: a.grade_max ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Locations for event ${event_id} (${pagination.count} of ${pagination.total})`;
          const rows = output.locations.map((l) => {
            const meta: string[] = [];
            if (l.child_or_adult) meta.push(l.child_or_adult);
            if (l.gender && l.gender !== "either") meta.push(l.gender);
            if (l.max_occupancy) meta.push(`cap: ${l.max_occupancy}`);
            return `- **${l.name ?? "(unnamed)"}** (ID: ${l.id})${meta.length ? ` — ${meta.join(" · ")}` : ""}${l.opened === false ? " ⚠️ closed" : ""}`;
          });
          text = [header, "", ...rows].join("\n");
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
