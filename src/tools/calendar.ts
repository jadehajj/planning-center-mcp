/**
 * Planning Center Calendar tools (new product coverage).
 *
 * Wraps:
 *   GET /calendar/v2/events
 *   GET /calendar/v2/events/:id
 *   GET /calendar/v2/event_instances
 *   GET /calendar/v2/events/:id/event_instances
 *   GET /calendar/v2/resources
 *   GET /calendar/v2/resources/:id
 *   GET /calendar/v2/resource_bookings
 *   GET /calendar/v2/conflicts
 *   GET /calendar/v2/tags
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

interface CalendarEventAttributes {
  approval_status?: string;
  archived_at?: string | null;
  description?: string;
  details_url?: string;
  featured?: boolean;
  image_url?: string;
  name?: string;
  percent_approved?: number;
  percent_rejected?: number;
  registration_url?: string;
  summary?: string;
  visible_in_church_center?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface EventInstanceAttributes {
  all_day_event?: boolean;
  compact_recurrence_description?: string;
  ends_at?: string;
  location?: string;
  recurrence?: string;
  recurrence_description?: string;
  starts_at?: string;
  church_center_url?: string;
  published_starts_at?: string;
  published_ends_at?: string;
  created_at?: string;
  updated_at?: string;
}

interface CalResourceAttributes {
  description?: string;
  expires_at?: string | null;
  home_location?: string;
  kind?: string;
  name?: string;
  path_name?: string;
  quantity?: number | null;
  serial_number?: string;
  created_at?: string;
  updated_at?: string;
}

interface ResourceBookingAttributes {
  ends_at?: string;
  starts_at?: string;
  quantity?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

interface ConflictAttributes {
  note?: string;
  resolved_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface CalTagAttributes {
  church_center_category?: boolean;
  color?: string;
  name?: string;
  position?: number;
  created_at?: string;
  updated_at?: string;
}

export function registerCalendarTools(server: McpServer): void {
  // ─── pc_list_calendar_events ─────────────────────────────────────────────
  server.registerTool(
    "pc_list_calendar_events",
    {
      title: "List Calendar Events",
      description: `List events on the church calendar.

Args:
  - search_name (string, optional): Filter by partial event name match
  - approval_status (string, optional): Filter by 'A' (approved), 'P' (pending), 'R' (rejected)
  - visible_in_church_center (boolean, optional): Only events visible publicly
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: event ID, name, summary, approval status, visibility.`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial event name to search for"),
        approval_status: z.enum(["A", "P", "R"]).optional().describe("A=approved, P=pending, R=rejected"),
        visible_in_church_center: z.boolean().optional().describe("Only events visible publicly"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ search_name, approval_status, visible_in_church_center, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (search_name) params["where[name]"] = search_name;
        if (approval_status) params["where[approval_status]"] = approval_status;
        if (visible_in_church_center !== undefined) params["where[visible_in_church_center]"] = visible_in_church_center;

        const resp = await pcoGet<PcoResource>("/calendar/v2/events", params);
        const events = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!events.length) return { content: [{ type: "text", text: "No calendar events found." }] };

        const output = {
          ...pagination,
          offset,
          events: events.map((e) => {
            const a = e.attributes as CalendarEventAttributes;
            return {
              id: e.id,
              name: a.name ?? null,
              summary: a.summary ?? null,
              approval_status: a.approval_status ?? null,
              visible_in_church_center: a.visible_in_church_center ?? null,
              archived: !!a.archived_at,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Calendar Events (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          const rows = output.events.map((e) => {
            const status = e.approval_status === "A" ? "✅" : e.approval_status === "P" ? "⏳" : e.approval_status === "R" ? "❌" : "?";
            return `- ${status} **${e.name ?? "(unnamed)"}** (ID: ${e.id})${e.visible_in_church_center ? " 🌐 public" : ""}${e.archived ? " ⚠️ archived" : ""}`;
          });
          text = [header, "", ...rows].join("\n");
          if (pagination.has_more) text += `\n\n_More results — use offset=${pagination.next_offset}_`;
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

  // ─── pc_get_calendar_event ───────────────────────────────────────────────
  server.registerTool(
    "pc_get_calendar_event",
    {
      title: "Get Calendar Event Detail",
      description: `Retrieve a calendar event with its instances (occurrences).

Args:
  - event_id (string): The calendar event ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        event_id: z.string().min(1).describe("Calendar event ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, response_format }) => {
      try {
        const [eventResp, instResp] = await Promise.all([
          pcoGet<PcoResource>(`/calendar/v2/events/${event_id}`),
          pcoGet<PcoResource>(`/calendar/v2/events/${event_id}/event_instances`, { per_page: 25, order: "starts_at" }),
        ]);

        const event = (Array.isArray(eventResp.data) ? eventResp.data[0] : eventResp.data) as PcoResource;
        const instances = (Array.isArray(instResp.data) ? instResp.data : [instResp.data]) as PcoResource[];
        const a = event.attributes as CalendarEventAttributes;

        const output = {
          id: event.id,
          ...a,
          instances: instances.map((i) => ({ id: i.id, ...(i.attributes as EventInstanceAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# ${a.name ?? "(unnamed)"} (ID: ${event.id})`];
          if (a.summary) lines.push("", `> ${a.summary}`);
          if (a.approval_status) lines.push("", `- **Approval status**: ${a.approval_status}`);
          if (a.visible_in_church_center !== undefined) lines.push(`- **Public**: ${a.visible_in_church_center ? "yes" : "no"}`);
          if (a.registration_url) lines.push(`- **Registration**: ${a.registration_url}`);
          if (instances.length) {
            lines.push("", `## Upcoming instances (${instances.length})`);
            for (const inst of instances) {
              const ia = inst.attributes as EventInstanceAttributes;
              lines.push(`- **${ia.starts_at ?? "?"}** to **${ia.ends_at ?? "?"}**${ia.location ? ` — ${ia.location}` : ""}${ia.all_day_event ? " (all day)" : ""} (ID: ${inst.id})`);
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

  // ─── pc_list_event_instances ─────────────────────────────────────────────
  server.registerTool(
    "pc_list_calendar_event_instances",
    {
      title: "List Event Instances (across all events)",
      description: `List event instances (specific occurrences) across all calendar events. Useful for "what's happening this week?" queries.

Args:
  - starts_after (string, optional): ISO date — only instances starting after this
  - ends_before (string, optional): ISO date — only instances ending before this
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        starts_after: z.string().optional().describe("ISO date (e.g. '2026-04-28')"),
        ends_before: z.string().optional().describe("ISO date (e.g. '2026-05-05')"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ starts_after, ends_before, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset), order: "starts_at", include: "event" };
        if (starts_after) params["where[starts_at][gt]"] = starts_after;
        if (ends_before) params["where[ends_at][lt]"] = ends_before;

        const resp = await pcoGet<PcoResource>("/calendar/v2/event_instances", params) as { data: PcoResource[]; included?: PcoResource[]; meta?: { total_count?: number } };
        const instances = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const included = (resp.included ?? []) as PcoResource[];
        const eventsById = new Map(included.filter((r) => r.type === "Event").map((e) => [e.id, e]));
        const pagination = extractPagination(resp, limit, offset);

        if (!instances.length) return { content: [{ type: "text", text: "No event instances found in that range." }] };

        const output = {
          ...pagination,
          offset,
          instances: instances.map((i) => {
            const a = i.attributes as EventInstanceAttributes;
            const eventId = ((i.relationships?.event as { data?: { id?: string } } | undefined)?.data ?? {}).id;
            const ev = eventId ? eventsById.get(eventId) : undefined;
            return {
              id: i.id,
              event_id: eventId ?? null,
              event_name: ev ? (ev.attributes as CalendarEventAttributes).name ?? null : null,
              starts_at: a.starts_at ?? null,
              ends_at: a.ends_at ?? null,
              location: a.location ?? null,
              all_day: a.all_day_event ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Event Instances (${pagination.count} of ${pagination.total})`;
          const rows = output.instances.map((i) => `- **${i.event_name ?? "(unknown event)"}** — ${i.starts_at ?? "?"} to ${i.ends_at ?? "?"}${i.location ? ` @ ${i.location}` : ""}${i.all_day ? " (all day)" : ""} (ID: ${i.id})`);
          text = [header, "", ...rows].join("\n");
          if (pagination.has_more) text += `\n\n_More results — use offset=${pagination.next_offset}_`;
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

  // ─── pc_list_resources ───────────────────────────────────────────────────
  server.registerTool(
    "pc_list_calendar_resources",
    {
      title: "List Calendar Resources",
      description: `List bookable resources — rooms, equipment, vehicles. Use this to find what can be booked.

Args:
  - kind (string, optional): Filter by 'Room' or 'Resource'
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        kind: z.enum(["Room", "Resource"]).optional().describe("Filter by resource kind"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ kind, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (kind) params["where[kind]"] = kind;

        const resp = await pcoGet<PcoResource>("/calendar/v2/resources", params);
        const resources = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!resources.length) return { content: [{ type: "text", text: "No resources found." }] };

        const output = {
          ...pagination,
          offset,
          resources: resources.map((r) => {
            const a = r.attributes as CalResourceAttributes;
            return {
              id: r.id,
              name: a.name ?? null,
              kind: a.kind ?? null,
              home_location: a.home_location ?? null,
              path_name: a.path_name ?? null,
              quantity: a.quantity ?? null,
              serial_number: a.serial_number ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Calendar Resources (${pagination.count} of ${pagination.total})${kind ? ` (${kind})` : ""}`;
          const rows = output.resources.map((r) => `- **${r.name ?? "(unnamed)"}** (ID: ${r.id})${r.kind ? ` — ${r.kind}` : ""}${r.home_location ? ` @ ${r.home_location}` : ""}${r.quantity ? ` (qty ${r.quantity})` : ""}`);
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

  // ─── pc_list_resource_bookings ───────────────────────────────────────────
  server.registerTool(
    "pc_list_resource_bookings",
    {
      title: "List Resource Bookings",
      description: `List resource bookings — what's booked when, by whom.

Args:
  - resource_id (string, optional): Filter to a specific resource
  - starts_after (string, optional): ISO date filter
  - ends_before (string, optional): ISO date filter
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        resource_id: z.string().optional().describe("Filter to a specific resource"),
        starts_after: z.string().optional().describe("ISO date filter"),
        ends_before: z.string().optional().describe("ISO date filter"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ resource_id, starts_after, ends_before, limit, offset, response_format }) => {
      try {
        const path = resource_id
          ? `/calendar/v2/resources/${resource_id}/resource_bookings`
          : "/calendar/v2/resource_bookings";
        const params: Record<string, unknown> = { ...paginationParams(limit, offset), order: "starts_at" };
        if (starts_after) params["where[starts_at][gt]"] = starts_after;
        if (ends_before) params["where[ends_at][lt]"] = ends_before;

        const resp = await pcoGet<PcoResource>(path, params);
        const bookings = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!bookings.length) return { content: [{ type: "text", text: "No resource bookings found." }] };

        const output = {
          ...pagination,
          offset,
          resource_id: resource_id ?? null,
          bookings: bookings.map((b) => ({ id: b.id, ...(b.attributes as ResourceBookingAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Resource Bookings (${pagination.count} of ${pagination.total})${resource_id ? ` for resource ${resource_id}` : ""}`;
          const rows = bookings.map((b) => {
            const a = b.attributes as ResourceBookingAttributes;
            return `- **${a.starts_at ?? "?"}** to **${a.ends_at ?? "?"}** — ${a.status ?? "?"}${a.quantity ? ` (qty ${a.quantity})` : ""} (ID: ${b.id})`;
          });
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

  // ─── pc_list_calendar_conflicts ──────────────────────────────────────────
  server.registerTool(
    "pc_list_calendar_conflicts",
    {
      title: "List Calendar Conflicts",
      description: `List calendar conflicts — situations where multiple events have requested the same resource at the same time.

Args:
  - resolved (boolean, optional): Filter by resolved/unresolved
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        resolved: z.boolean().optional().describe("Filter by resolved status"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ resolved, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (resolved !== undefined) params["where[resolved]"] = resolved;

        const resp = await pcoGet<PcoResource>("/calendar/v2/conflicts", params);
        const conflicts = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!conflicts.length) return { content: [{ type: "text", text: "No conflicts found." }] };

        const output = {
          ...pagination,
          offset,
          conflicts: conflicts.map((c) => ({ id: c.id, ...(c.attributes as ConflictAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Calendar Conflicts (${pagination.count} of ${pagination.total})`;
          const rows = conflicts.map((c) => {
            const a = c.attributes as ConflictAttributes;
            return `- ${a.resolved_at ? "✅ resolved" : "⚠️ unresolved"} (ID: ${c.id})${a.note ? ` — ${a.note}` : ""}`;
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

  // ─── pc_list_calendar_tags ───────────────────────────────────────────────
  server.registerTool(
    "pc_list_calendar_tags",
    {
      title: "List Calendar Tags",
      description: `List tags used to categorize calendar events (e.g. ministry area, audience).

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>("/calendar/v2/tags", { ...paginationParams(limit, offset), order: "position" });
        const tags = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!tags.length) return { content: [{ type: "text", text: "No tags found." }] };

        const output = {
          ...pagination,
          offset,
          tags: tags.map((t) => ({ id: t.id, ...(t.attributes as CalTagAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Calendar Tags (${pagination.count} of ${pagination.total})`;
          const rows = tags.map((t) => {
            const a = t.attributes as CalTagAttributes;
            return `- **${a.name ?? "(unnamed)"}** (ID: ${t.id})${a.color ? ` (${a.color})` : ""}${a.church_center_category ? " 🌐 public category" : ""}`;
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
