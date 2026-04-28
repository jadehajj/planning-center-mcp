/**
 * Planning Center Services — expanded tools.
 *
 * Wraps:
 *   GET /services/v2/service_types
 *   GET /services/v2/songs
 *   GET /services/v2/songs/:id
 *   GET /services/v2/songs/:id/arrangements
 *   GET /services/v2/teams
 *   GET /services/v2/teams/:id/people
 *   GET /services/v2/people/:id/schedules
 *   GET /services/v2/people/:id/blockouts
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

interface ServiceTypeAttributes {
  name?: string;
  sequence?: number;
  permissions?: string;
  attachment_types_enabled?: boolean;
  scheduled_publish?: boolean;
  custom_item_types?: unknown[];
  standard_item_types?: unknown[];
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface SongAttributes {
  title?: string;
  admin?: string;
  author?: string;
  copyright?: string;
  ccli_number?: number;
  hidden?: boolean;
  notes?: string;
  themes?: string;
  last_scheduled_short_dates?: string;
  last_scheduled_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ArrangementAttributes {
  name?: string;
  bpm?: number;
  length_seconds?: number;
  meter?: string;
  notes?: string;
  print_margin?: string;
  print_orientation?: string;
  print_page_size?: string;
  rehearsal_mix_url?: string;
  chord_chart?: string;
  chord_chart_chord_color?: number;
  chord_chart_columns?: number;
  chord_chart_font?: string;
  chord_chart_font_size?: number;
  chord_chart_key?: string;
  has_chord_chart?: boolean;
  has_chords?: boolean;
  lyrics_enabled?: boolean;
  number_chart_enabled?: boolean;
  numeral_chart_enabled?: boolean;
  sequence?: string[];
  sequence_short?: string[];
  sequence_full?: string[];
  created_at?: string;
  updated_at?: string;
}

interface TeamAttributes {
  name?: string;
  schedule_to?: string;
  default_status?: string;
  default_prepare_notifications?: boolean;
  rehearsal_team?: boolean;
  sequence?: number;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PersonScheduleAttributes {
  sort_date?: string;
  dates?: string;
  decline_reason?: string | null;
  organization_name?: string;
  organization_time_zone?: string;
  organization_twenty_four_hour_time?: boolean;
  person_name?: string;
  position_display_times?: string;
  responds_to_name?: string;
  service_type_name?: string;
  short_dates?: string;
  status?: string;
  team_name?: string;
  team_position_name?: string;
  can_accept_partial?: boolean;
  can_accept_partial_one_time?: boolean;
  can_rehearse?: boolean;
  plan_visible?: boolean;
  plan_visible_to_me?: boolean;
}

interface BlockoutAttributes {
  description?: string;
  group_identifier?: string;
  organization_name?: string;
  reason?: string;
  repeat_frequency?: string;
  repeat_interval?: string;
  repeat_period?: string;
  settings?: string;
  time_zone?: string;
  starts_at?: string;
  ends_at?: string;
  share?: boolean;
  created_at?: string;
  updated_at?: string;
}

export function registerServicesExtraTools(server: McpServer): void {
  // ─── pc_list_service_types ───────────────────────────────────────────────
  server.registerTool(
    "pc_list_service_types",
    {
      title: "List Service Types",
      description: `List all service types in Planning Center Services (e.g. Sunday Morning, Sunday Evening, Youth Service). Use this to find a service_type_id for other Services tools.

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: service type IDs, names, and archive status.`,
      inputSchema: z.object({
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>("/services/v2/service_types", { ...paginationParams(limit, offset), order: "sequence" });
        const types = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!types.length) return { content: [{ type: "text", text: "No service types found." }] };

        const output = {
          ...pagination,
          offset,
          service_types: types.map((t) => {
            const a = t.attributes as ServiceTypeAttributes;
            return { id: t.id, name: a.name ?? null, sequence: a.sequence ?? null, archived: !!a.archived_at };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Service Types (${pagination.count} of ${pagination.total})`;
          const rows = output.service_types.map((t) => `- **${t.name ?? "(unnamed)"}** (ID: ${t.id})${t.archived ? " ⚠️ archived" : ""}`);
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

  // ─── pc_list_songs ───────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_songs",
    {
      title: "List Songs",
      description: `List songs in the Planning Center Services song library.

Args:
  - search_title (string, optional): Filter by partial title match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: song ID, title, author, CCLI number, themes, last scheduled date.

Examples:
  - "Find all songs by Stuart Townend" → search_title="townend"
  - "What songs have we scheduled recently?" → no params, results sorted by last scheduled`,
      inputSchema: z.object({
        search_title: z.string().optional().describe("Partial song title to search for"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ search_title, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset), order: "-last_scheduled_at" };
        if (search_title) params["where[title]"] = search_title;

        const resp = await pcoGet<PcoResource>("/services/v2/songs", params);
        const songs = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!songs.length) return { content: [{ type: "text", text: search_title ? `No songs found matching "${search_title}".` : "No songs found." }] };

        const output = {
          ...pagination,
          offset,
          songs: songs.map((s) => {
            const a = s.attributes as SongAttributes;
            return {
              id: s.id,
              title: a.title ?? null,
              author: a.author ?? null,
              ccli_number: a.ccli_number ?? null,
              last_scheduled_at: a.last_scheduled_at ?? null,
              themes: a.themes ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Songs (${pagination.count} of ${pagination.total})${search_title ? ` matching "${search_title}"` : ""}`;
          const rows = output.songs.map((s) => `- **${s.title ?? "(untitled)"}** (ID: ${s.id})${s.author ? ` — ${s.author}` : ""}${s.last_scheduled_at ? ` — last: ${s.last_scheduled_at}` : ""}`);
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

  // ─── pc_get_song ─────────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_song",
    {
      title: "Get Song Detail with Arrangements",
      description: `Retrieve a specific song with its arrangements (different versions: keys, BPMs, chord charts).

Args:
  - song_id (string): The song ID (find via pc_list_songs)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: song metadata + arrangement details including keys, BPM, length, sequences.`,
      inputSchema: z.object({
        song_id: z.string().min(1).describe("Planning Center song ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ song_id, response_format }) => {
      try {
        const [songResp, arrResp] = await Promise.all([
          pcoGet<PcoResource>(`/services/v2/songs/${song_id}`),
          pcoGet<PcoResource>(`/services/v2/songs/${song_id}/arrangements`, { per_page: 50 }),
        ]);
        const song = (Array.isArray(songResp.data) ? songResp.data[0] : songResp.data) as PcoResource;
        const arrangements = (Array.isArray(arrResp.data) ? arrResp.data : [arrResp.data]) as PcoResource[];
        const a = song.attributes as SongAttributes;

        const output = {
          id: song.id,
          ...a,
          arrangements: arrangements.map((arr) => ({
            id: arr.id,
            ...(arr.attributes as ArrangementAttributes),
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# ${a.title ?? "(untitled)"} (ID: ${song.id})`];
          if (a.author) lines.push(`- **Author**: ${a.author}`);
          if (a.admin) lines.push(`- **Admin**: ${a.admin}`);
          if (a.copyright) lines.push(`- **Copyright**: ${a.copyright}`);
          if (a.ccli_number) lines.push(`- **CCLI**: ${a.ccli_number}`);
          if (a.themes) lines.push(`- **Themes**: ${a.themes}`);
          if (arrangements.length) {
            lines.push("", `## Arrangements (${arrangements.length})`);
            for (const arr of arrangements) {
              const aa = arr.attributes as ArrangementAttributes;
              const meta: string[] = [];
              if (aa.bpm) meta.push(`${aa.bpm} BPM`);
              if (aa.meter) meta.push(aa.meter);
              if (aa.length_seconds) meta.push(`${Math.round(aa.length_seconds / 60)}m`);
              if (aa.chord_chart_key) meta.push(`key: ${aa.chord_chart_key}`);
              const metaStr = meta.length ? ` — ${meta.join(" · ")}` : "";
              lines.push(`- **${aa.name ?? "(unnamed)"}** (ID: ${arr.id})${metaStr}`);
            }
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

  // ─── pc_list_teams ───────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_teams",
    {
      title: "List Teams",
      description: `List teams across service types in Planning Center Services (e.g. Worship Team, Welcome Team, Kids Team).

Args:
  - service_type_id (string, optional): Filter to a specific service type
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        service_type_id: z.string().optional().describe("Filter by service type ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ service_type_id, limit, offset, response_format }) => {
      try {
        const path = service_type_id
          ? `/services/v2/service_types/${service_type_id}/teams`
          : "/services/v2/teams";
        const resp = await pcoGet<PcoResource>(path, { ...paginationParams(limit, offset) });
        const teams = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!teams.length) return { content: [{ type: "text", text: "No teams found." }] };

        const output = {
          ...pagination,
          offset,
          teams: teams.map((t) => {
            const a = t.attributes as TeamAttributes;
            return { id: t.id, name: a.name ?? null, schedule_to: a.schedule_to ?? null, archived: !!a.archived_at };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Teams (${pagination.count} of ${pagination.total})`;
          const rows = output.teams.map((t) => `- **${t.name ?? "(unnamed)"}** (ID: ${t.id})${t.archived ? " ⚠️ archived" : ""}`);
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

  // ─── pc_list_team_members ────────────────────────────────────────────────
  server.registerTool(
    "pc_list_team_members",
    {
      title: "List Team Members",
      description: `List the people on a specific team.

Args:
  - team_id (string): The team ID (find via pc_list_teams)
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        team_id: z.string().min(1).describe("Planning Center team ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ team_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/services/v2/teams/${team_id}/people`, { ...paginationParams(limit, offset) });
        const people = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!people.length) return { content: [{ type: "text", text: `No members on team ${team_id}.` }] };

        interface TM { full_name?: string; first_name?: string; last_name?: string; status?: string; }
        const output = {
          ...pagination,
          offset,
          team_id,
          members: people.map((p) => {
            const a = p.attributes as TM;
            return { id: p.id, name: a.full_name ?? `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(), status: a.status ?? null };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Team ${team_id} — members (${pagination.count} of ${pagination.total})`;
          const rows = output.members.map((m) => `- **${m.name}** (ID: ${m.id})${m.status ? ` — ${m.status}` : ""}`);
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

  // ─── pc_list_person_schedules ────────────────────────────────────────────
  server.registerTool(
    "pc_list_person_schedules",
    {
      title: "List a Person's Service Schedules",
      description: `List upcoming service schedules (rosters) for a specific person — what they're scheduled to serve on.

Args:
  - person_id (string): The PCO person ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: scheduled position, team, service type, date, and confirmation status.`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("Planning Center person ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ person_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/services/v2/people/${person_id}/schedules`, { ...paginationParams(limit, offset) });
        const schedules = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!schedules.length) return { content: [{ type: "text", text: `No schedules for person ${person_id}.` }] };

        const output = {
          ...pagination,
          offset,
          person_id,
          schedules: schedules.map((s) => {
            const a = s.attributes as PersonScheduleAttributes;
            return {
              id: s.id,
              dates: a.dates ?? null,
              service_type_name: a.service_type_name ?? null,
              team_name: a.team_name ?? null,
              team_position_name: a.team_position_name ?? null,
              status: a.status ?? null,
              decline_reason: a.decline_reason ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Schedules for person ${person_id} (${pagination.count} of ${pagination.total})`;
          const rows = output.schedules.map((s) => `- **${s.dates ?? "?"}** — ${s.service_type_name ?? "?"} — ${s.team_position_name ?? "?"} (${s.team_name ?? "?"}) — ${s.status ?? "?"}`);
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

  // ─── pc_list_person_blockouts ────────────────────────────────────────────
  server.registerTool(
    "pc_list_person_blockouts",
    {
      title: "List a Person's Blockout Dates",
      description: `List blockout dates (when they're unavailable) for a specific person.

Args:
  - person_id (string): The PCO person ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("Planning Center person ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ person_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/services/v2/people/${person_id}/blockouts`, { ...paginationParams(limit, offset) });
        const blockouts = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!blockouts.length) return { content: [{ type: "text", text: `No blockouts for person ${person_id}.` }] };

        const output = {
          ...pagination,
          offset,
          person_id,
          blockouts: blockouts.map((b) => {
            const a = b.attributes as BlockoutAttributes;
            return {
              id: b.id,
              starts_at: a.starts_at ?? null,
              ends_at: a.ends_at ?? null,
              reason: a.reason ?? null,
              description: a.description ?? null,
              repeat_frequency: a.repeat_frequency ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Blockouts for person ${person_id} (${pagination.count} of ${pagination.total})`;
          const rows = output.blockouts.map((b) => `- **${b.starts_at ?? "?"}** to **${b.ends_at ?? "?"}**${b.reason ? ` — ${b.reason}` : ""}${b.repeat_frequency ? ` (repeats: ${b.repeat_frequency})` : ""}`);
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
