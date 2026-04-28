/**
 * Planning Center Groups — expanded tools.
 *
 * Wraps:
 *   GET /groups/v2/groups/:id
 *   GET /groups/v2/groups/:id/memberships
 *   GET /groups/v2/groups/:id/events
 *   GET /groups/v2/events/:id/attendances
 *   GET /groups/v2/group_types
 *   GET /groups/v2/tags
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
  contact_email?: string;
  archived_at?: string | null;
  created_at?: string;
  chat_enabled?: boolean;
  events_visibility?: string;
  memberships_count?: number;
  enrollment_open?: boolean;
  enrollment_strategy_string?: string;
  virtual_location_url?: string | null;
}

interface MembershipAttributes {
  joined_at?: string;
  role?: string;
  account_center_identifier?: string;
  first_name?: string;
  last_name?: string;
  email_address?: string;
  phone_number?: string;
  avatar_url?: string;
}

interface GroupEventAttributes {
  attendance_requests_enabled?: boolean;
  automated_reminder_enabled?: boolean;
  canceled?: boolean;
  canceled_at?: string | null;
  description?: string;
  ends_at?: string;
  location_type_preference?: string;
  multi_day?: boolean;
  name?: string;
  reminders_sent?: boolean;
  reminders_sent_at?: string | null;
  repeating?: boolean;
  starts_at?: string;
  visitors_count?: number;
  created_at?: string;
  updated_at?: string;
  virtual_location_url?: string | null;
}

interface AttendanceAttributes {
  attended?: boolean;
  role?: string;
  first_name?: string;
  last_name?: string;
}

interface GroupTypeAttributes {
  name?: string;
  description?: string;
  church_center_visible?: boolean;
  church_center_map_visible?: boolean;
  color?: string;
  position?: number;
  default_group_settings?: string;
}

interface TagAttributes {
  name?: string;
  position?: number;
}

export function registerGroupsExtraTools(server: McpServer): void {
  // ─── pc_get_group ────────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_group",
    {
      title: "Get Group Detail",
      description: `Retrieve full details for a specific group including memberships count, schedule, location, contact email.

Args:
  - group_id (string): The group ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        group_id: z.string().min(1).describe("Group ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}`);
        const group = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const a = group.attributes as GroupAttributes;
        const output = { id: group.id, ...a };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# ${a.name ?? "(unnamed group)"} (ID: ${group.id})`];
          if (a.description) lines.push("", `> ${a.description}`, "");
          if (a.memberships_count !== undefined) lines.push(`- **Members**: ${a.memberships_count}`);
          if (a.schedule) lines.push(`- **Schedule**: ${a.schedule}`);
          if (a.location) lines.push(`- **Location**: ${a.location}`);
          if (a.contact_email) lines.push(`- **Contact**: ${a.contact_email}`);
          if (a.enrollment_strategy_string) lines.push(`- **Enrollment**: ${a.enrollment_strategy_string}`);
          if (a.archived_at) lines.push(`- ⚠️ **Archived**: ${a.archived_at}`);
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

  // ─── pc_list_group_members ───────────────────────────────────────────────
  server.registerTool(
    "pc_list_group_members",
    {
      title: "List Group Members",
      description: `List the people in a specific group.

Args:
  - group_id (string): The group ID
  - role (string, optional): Filter by role — 'leader' or 'member'
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        group_id: z.string().min(1).describe("Group ID"),
        role: z.enum(["leader", "member"]).optional().describe("Filter by role"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, role, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (role) params["where[role]"] = role;

        const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}/memberships`, params);
        const members = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!members.length) return { content: [{ type: "text", text: `No members in group ${group_id}.` }] };

        const output = {
          ...pagination,
          offset,
          group_id,
          members: members.map((m) => {
            const a = m.attributes as MembershipAttributes;
            return {
              id: m.id,
              name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
              email: a.email_address ?? null,
              role: a.role ?? null,
              joined_at: a.joined_at ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Group ${group_id} — members (${pagination.count} of ${pagination.total})${role ? ` (role: ${role})` : ""}`;
          const rows = output.members.map((m) => `- **${m.name}** — ${m.role ?? "?"}${m.joined_at ? ` (joined ${m.joined_at})` : ""}${m.email ? ` — ${m.email}` : ""}`);
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

  // ─── pc_list_group_events ────────────────────────────────────────────────
  server.registerTool(
    "pc_list_group_events",
    {
      title: "List Group Events",
      description: `List events (meetings) for a specific group, past or future.

Args:
  - group_id (string): The group ID
  - filter (string, optional): 'upcoming' or 'past' (default: 'upcoming')
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        group_id: z.string().min(1).describe("Group ID"),
        filter: z.enum(["upcoming", "past"]).optional().default("upcoming").describe("Time filter"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group_id, filter, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}/events`, {
          ...paginationParams(limit, offset),
          filter,
          order: filter === "past" ? "-starts_at" : "starts_at",
        });
        const events = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!events.length) return { content: [{ type: "text", text: `No ${filter} events for group ${group_id}.` }] };

        const output = {
          ...pagination,
          offset,
          group_id,
          filter,
          events: events.map((e) => {
            const a = e.attributes as GroupEventAttributes;
            return {
              id: e.id,
              name: a.name ?? null,
              starts_at: a.starts_at ?? null,
              ends_at: a.ends_at ?? null,
              canceled: !!a.canceled,
              repeating: !!a.repeating,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Group ${group_id} — ${filter} events (${pagination.count} of ${pagination.total})`;
          const rows = output.events.map((e) => `- **${e.name ?? "(unnamed)"}** — ${e.starts_at ?? "?"} (ID: ${e.id})${e.canceled ? " ⚠️ canceled" : ""}`);
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

  // ─── pc_list_group_event_attendances ────────────────────────────────────
  server.registerTool(
    "pc_list_group_event_attendances",
    {
      title: "List Attendances for a Group Event",
      description: `List who attended (and didn't attend) a specific group event.

Args:
  - event_id (string): The group event ID (find via pc_list_group_events)
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        event_id: z.string().min(1).describe("Group event ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/groups/v2/events/${event_id}/attendances`, { ...paginationParams(limit, offset) });
        const attendances = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!attendances.length) return { content: [{ type: "text", text: `No attendance records for event ${event_id}.` }] };

        const output = {
          ...pagination,
          offset,
          event_id,
          attendances: attendances.map((att) => {
            const a = att.attributes as AttendanceAttributes;
            return {
              id: att.id,
              name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
              attended: a.attended ?? null,
              role: a.role ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const presentCount = output.attendances.filter((a) => a.attended === true).length;
          const absentCount = output.attendances.filter((a) => a.attended === false).length;
          const header = `# Group event ${event_id} — attendance (${pagination.count} of ${pagination.total})\n${presentCount} present · ${absentCount} absent`;
          const rows = output.attendances.map((a) => `- ${a.attended ? "✅" : a.attended === false ? "❌" : "?"} **${a.name}**${a.role ? ` (${a.role})` : ""}`);
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

  // ─── pc_list_group_types ─────────────────────────────────────────────────
  server.registerTool(
    "pc_list_group_types",
    {
      title: "List Group Types",
      description: `List group types (e.g. Life Groups, Discipleship Groups, Ministry Teams).

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
        const resp = await pcoGet<PcoResource>("/groups/v2/group_types", { ...paginationParams(limit, offset), order: "position" });
        const types = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!types.length) return { content: [{ type: "text", text: "No group types found." }] };

        const output = {
          ...pagination,
          offset,
          group_types: types.map((t) => ({ id: t.id, ...(t.attributes as GroupTypeAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Group Types (${pagination.count} of ${pagination.total})`;
          const rows = types.map((t) => {
            const a = t.attributes as GroupTypeAttributes;
            return `- **${a.name ?? "(unnamed)"}** (ID: ${t.id})${a.description ? ` — ${a.description}` : ""}`;
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

  // ─── pc_list_group_tags ──────────────────────────────────────────────────
  server.registerTool(
    "pc_list_group_tags",
    {
      title: "List Group Tags",
      description: `List tags used to categorize groups (e.g. age, life stage, location).

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
        const resp = await pcoGet<PcoResource>("/groups/v2/tags", { ...paginationParams(limit, offset), order: "position" });
        const tags = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!tags.length) return { content: [{ type: "text", text: "No tags found." }] };

        const output = {
          ...pagination,
          offset,
          tags: tags.map((t) => ({ id: t.id, ...(t.attributes as TagAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Group Tags (${pagination.count} of ${pagination.total})`;
          const rows = tags.map((t) => `- **${(t.attributes as TagAttributes).name ?? "(unnamed)"}** (ID: ${t.id})`);
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
