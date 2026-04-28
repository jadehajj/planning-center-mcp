/**
 * Vercel serverless handler — Planning Center MCP server (v2.1 inline).
 *
 * SELF-CONTAINED by design: all logic — constants, schemas, the API client,
 * formatters, and all 54 tools — is inlined in this single file so Vercel's
 * @vercel/node runtime can resolve everything without ESM/CJS path issues.
 *
 * Required env vars (set in Vercel dashboard):
 *   PCO_APP_ID  — Planning Center App ID
 *   PCO_SECRET  — Planning Center Personal Access Token Secret
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios, { AxiosError, AxiosInstance } from "axios";

// ═════════════════════════════════════════════════════════════════════════════
// SHARED INFRASTRUCTURE
// ═════════════════════════════════════════════════════════════════════════════

const PCO_BASE_URL = "https://api.planningcenteronline.com";
const CHARACTER_LIMIT = 25000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

interface PcoResponse<T> {
  data: T | T[];
  included?: unknown[];
  meta?: { total_count?: number; count?: number; next?: { offset?: number } };
  links?: { next?: string; self?: string };
}

interface PcoResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  links?: Record<string, string>;
}

let _client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (_client) return _client;
  const appId = process.env.PCO_APP_ID;
  const secret = process.env.PCO_SECRET;
  if (!appId || !secret) {
    throw new Error("PCO_APP_ID and PCO_SECRET environment variables must be set.");
  }
  _client = axios.create({
    baseURL: PCO_BASE_URL,
    auth: { username: appId, password: secret },
    timeout: 30000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return _client;
}

async function pcoGet<T>(path: string, params?: Record<string, unknown>): Promise<PcoResponse<T>> {
  const r = await getClient().get<PcoResponse<T>>(path, { params });
  return r.data;
}

async function pcoPost<T>(path: string, body: unknown): Promise<PcoResponse<T>> {
  const r = await getClient().post<PcoResponse<T>>(path, body);
  return r.data;
}

async function pcoPatch<T>(path: string, body: unknown): Promise<PcoResponse<T>> {
  const r = await getClient().patch<PcoResponse<T>>(path, body);
  return r.data;
}

async function pcoDelete(path: string): Promise<boolean> {
  const r = await getClient().delete(path);
  return r.status === 204 || r.status === 200;
}

function handlePcoError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const s = error.response.status;
      const body = error.response.data as Record<string, unknown> | undefined;
      const detail = body && typeof body === "object" && "errors" in body ? JSON.stringify(body.errors) : "";
      switch (s) {
        case 401: return "Error: Authentication failed. Check that PCO_APP_ID and PCO_SECRET are correct.";
        case 403: return `Error: Permission denied. Your PAT may lack access to this resource. ${detail}`;
        case 404: return "Error: Resource not found. Check the ID is correct.";
        case 422: return `Error: Invalid request parameters. ${detail}`;
        case 429: return "Error: Rate limit exceeded. Please wait before making more requests.";
        default:  return `Error: API request failed with status ${s}. ${detail}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. The PCO API may be slow — please try again.";
    }
    return `Error: Network error — ${error.message}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function paginationParams(limit: number, offset: number) {
  return { per_page: limit, offset };
}

function extractPagination(resp: PcoResponse<unknown>, offset: number) {
  const total = resp.meta?.total_count ?? 0;
  const count = Array.isArray(resp.data) ? resp.data.length : 1;
  const has_more = total > offset + count;
  return { total, count, has_more, ...(has_more ? { next_offset: offset + count } : {}) };
}

// Shared Zod schemas
const limitSchema = z.union([z.number(), z.string()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT);

const offsetSchema = z.union([z.number(), z.string()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(0))
  .default(0);

const responseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);

// Helpers used by multiple tools
function fmtCurrency(cents: number, currency = "AUD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

function trunc(text: string, hint: string = "use a smaller limit or paginate"): string {
  return text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT) + `\n\n[Response truncated — ${hint}.]` : text;
}

function asArr<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

// Type alias — anywhere in tools, attributes are loosely-typed Records.
type Attrs = Record<string, unknown>;

// ═════════════════════════════════════════════════════════════════════════════
// MCP SERVER — registers all 54 tools
// ═════════════════════════════════════════════════════════════════════════════

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "planning-center-mcp-server", version: "2.1.0" });

  // ─── PEOPLE: pc_list_people ─────────────────────────────────────────────
  server.registerTool("pc_list_people", {
    title: "List / Search People",
    description: "Search and list congregation members in Planning Center People. Use search_name for partial name match.",
    inputSchema: z.object({
      search_name: z.string().optional(),
      limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset), include: "emails" };
      if (search_name) params["where[search_name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/people/v2/people", params);
      const people = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!people.length) return { content: [{ type: "text", text: search_name ? `No people found matching "${search_name}".` : "No people found." }] };
      const output = { ...pg, offset, people: people.map(p => ({ id: p.id, name: (p.attributes.name as string) ?? `${p.attributes.first_name ?? ""} ${p.attributes.last_name ?? ""}`.trim(), status: p.attributes.status ?? null })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# People (${pg.count} of ${pg.total})${search_name ? ` matching "${search_name}"` : ""}\n\n` +
            people.map(p => `### ${p.attributes.name ?? `${p.attributes.first_name} ${p.attributes.last_name}`} (ID: ${p.id})`).join("\n") +
            (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── PEOPLE: pc_get_person ──────────────────────────────────────────────
  server.registerTool("pc_get_person", {
    title: "Get Person Profile",
    description: "Retrieve the full profile for a specific person by their PCO ID.",
    inputSchema: z.object({ person_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ person_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/people/${person_id}`, { include: "emails,phone_numbers,addresses" });
      const person = asArr(resp.data)[0] as PcoResource;
      const a = person.attributes;
      const output = { id: person.id, ...a };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`### ${a.name ?? `${a.first_name} ${a.last_name}`} (ID: ${person.id})`,
            a.email ? `- **Email**: ${a.email}` : "",
            a.phone_number ? `- **Phone**: ${a.phone_number}` : "",
            a.birthdate ? `- **Birthdate**: ${a.birthdate}` : "",
            a.gender ? `- **Gender**: ${a.gender}` : "",
            a.membership ? `- **Membership**: ${a.membership}` : "",
            a.status ? `- **Status**: ${a.status}` : ""].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── SERVICES: pc_list_services ─────────────────────────────────────────
  server.registerTool("pc_list_services", {
    title: "List Upcoming Service Plans",
    description: "List upcoming service plans across all service types in Planning Center Services.",
    inputSchema: z.object({
      limit: limitSchema, offset: offsetSchema,
      service_type_id: z.string().optional(),
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, service_type_id, response_format }) => {
    try {
      let serviceTypes: PcoResource[];
      if (service_type_id) {
        const st = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}`);
        serviceTypes = [asArr(st.data)[0]] as PcoResource[];
      } else {
        const st = await pcoGet<PcoResource>("/services/v2/service_types", { per_page: 50 });
        serviceTypes = asArr(st.data) as PcoResource[];
      }
      const allPlans: Array<{ serviceType: string; plan: PcoResource }> = [];
      for (const st of serviceTypes) {
        const typeName = (st.attributes.name as string) ?? st.id;
        const pr = await pcoGet<PcoResource>(`/services/v2/service_types/${st.id}/plans`, { filter: "future", ...paginationParams(limit, offset), order: "sort_date" });
        asArr(pr.data).forEach(plan => allPlans.push({ serviceType: typeName, plan: plan as PcoResource }));
      }
      if (!allPlans.length) return { content: [{ type: "text", text: "No upcoming service plans found." }] };
      const output = { count: allPlans.length, plans: allPlans.map(({ serviceType, plan }) => ({ id: plan.id, service_type: serviceType, ...plan.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Upcoming Service Plans (${allPlans.length})\n\n` + allPlans.map(({ serviceType, plan: p }) => {
            const a = p.attributes;
            return [`## ${a.title ?? "Untitled Plan"} (ID: ${p.id})`, `- **Service Type**: ${serviceType}`, `- **Date**: ${a.dates ?? a.sort_date ?? "TBD"}`, a.series_title ? `- **Series**: ${a.series_title}` : "", typeof a.needed_positions_count === "number" ? `- **Open Positions**: ${a.needed_positions_count}` : ""].filter(Boolean).join("\n");
          }).join("\n\n"), "use service_type_id or smaller limit")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── SERVICES: pc_get_service ───────────────────────────────────────────
  server.registerTool("pc_get_service", {
    title: "Get Service Plan Detail",
    description: "Full details for a specific service plan: order of service, songs, and open team positions.",
    inputSchema: z.object({
      service_type_id: z.string().min(1),
      plan_id: z.string().min(1),
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ service_type_id, plan_id, response_format }) => {
    try {
      const [planResp, itemsResp, posResp] = await Promise.all([
        pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}`),
        pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}/items`, { per_page: 100, order: "sequence" }),
        pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}/needed_positions`, { per_page: 100 }),
      ]);
      const plan = asArr(planResp.data)[0] as PcoResource;
      const items = asArr(itemsResp.data) as PcoResource[];
      const positions = asArr(posResp.data) as PcoResource[];
      const a = plan.attributes;
      const output = { id: plan.id, ...a, items: items.map(i => ({ id: i.id, ...i.attributes })), needed_positions: positions.map(p => ({ id: p.id, ...p.attributes })) };
      let text: string;
      if (response_format === ResponseFormat.MARKDOWN) {
        const lines = [`# ${a.title ?? "Service Plan"} (ID: ${plan.id})`, `**Date**: ${a.dates ?? a.sort_date ?? "TBD"}`, a.series_title ? `**Series**: ${a.series_title}` : "", "", "## Order of Service"];
        items.forEach(i => { const ia = i.attributes; const mins = ia.length ? ` (${Math.round((ia.length as number) / 60000)}m)` : ""; lines.push(`- **${ia.item_type ?? "item"}**: ${ia.title ?? "Untitled"}${mins}`); });
        if (positions.length) { lines.push("", "## Open Positions"); positions.forEach(p => lines.push(`- ${p.attributes.name ?? p.id}`)); }
        text = lines.filter(Boolean).join("\n");
      } else { text = JSON.stringify(output, null, 2); }
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── GROUPS: pc_list_groups ─────────────────────────────────────────────
  server.registerTool("pc_list_groups", {
    title: "List Groups",
    description: "List small groups / community groups from Planning Center Groups.",
    inputSchema: z.object({
      search_name: z.string().optional(),
      limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = paginationParams(limit, offset);
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/groups/v2/groups", params);
      const groups = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!groups.length) return { content: [{ type: "text", text: search_name ? `No groups found matching "${search_name}".` : "No groups found." }] };
      const output = { ...pg, offset, groups: groups.map(g => ({ id: g.id, ...g.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Groups (${pg.count} of ${pg.total})\n\n` + groups.map(g => {
            const a = g.attributes;
            return [`### ${a.name ?? "Unnamed Group"} (ID: ${g.id})`, a.description ? `> ${a.description}` : "", a.schedule ? `- **Schedule**: ${a.schedule}` : "", a.location ? `- **Location**: ${a.location}` : "", typeof a.members_count === "number" ? `- **Members**: ${a.members_count}` : ""].filter(Boolean).join("\n");
          }).join("\n\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── CHECK-INS: pc_list_checkins ────────────────────────────────────────
  server.registerTool("pc_list_checkins", {
    title: "List Check-Ins",
    description: "List check-in records. Filter by event_id for a specific service.",
    inputSchema: z.object({
      event_id: z.string().optional(),
      limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const path = event_id ? `/check-ins/v2/events/${event_id}/check_ins` : "/check-ins/v2/check_ins";
      const resp = await pcoGet<PcoResource>(path, { ...paginationParams(limit, offset), order: "-created_at" });
      const ci = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!ci.length) return { content: [{ type: "text", text: "No check-ins found." }] };
      const output = { ...pg, offset, check_ins: ci.map(c => ({ id: c.id, ...c.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Check-Ins (${pg.count} of ${pg.total})\n\n` + ci.map(c => {
            const a = c.attributes;
            const name = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unknown";
            const time = a.created_at ? new Date(a.created_at as string).toLocaleString() : "Unknown time";
            return `- **${name}** — ${a.kind ?? "regular"} — ${time}`;
          }).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── GIVING: pc_list_donations ──────────────────────────────────────────
  server.registerTool("pc_list_donations", {
    title: "List Donation Records",
    description: "List donation records from Planning Center Giving (most recent first).",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/donations", { ...paginationParams(limit, offset), order: "-received_at" });
      const d = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!d.length) return { content: [{ type: "text", text: "No donation records found." }] };
      const output = { ...pg, offset, donations: d.map(x => ({ id: x.id, ...x.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Donations (${pg.count} of ${pg.total})\n\n` + d.map(x => {
            const a = x.attributes;
            const cents = a.amount_cents as number | undefined;
            const cur = (a.amount_currency as string | undefined) ?? "AUD";
            const amt = cents != null ? fmtCurrency(cents, cur) : "Unknown";
            const date = a.received_at ? new Date(a.received_at as string).toLocaleDateString() : "Unknown date";
            return `- ${amt} via ${a.payment_method ?? "unknown"} — ${date}${a.refunded ? " _(refunded)_" : ""}`;
          }).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });


  // ═══ WAVE 1: PEOPLE EXPANSION ═══════════════════════════════════════════

  // ─── pc_list_lists ──────────────────────────────────────────────────────
  server.registerTool("pc_list_lists", {
    title: "List All People Lists",
    description: "List all lists in Planning Center People. Returns id, name, total_people, subset (active/inactive scope), auto_refresh, refreshed_at.",
    inputSchema: z.object({
      search_name: z.string().optional(),
      limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/people/v2/lists", params);
      const lists = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!lists.length) return { content: [{ type: "text", text: search_name ? `No lists found matching "${search_name}".` : "No lists found." }] };
      const output = { ...pg, offset, lists: lists.map(l => { const a = l.attributes; return { id: l.id, name: a.name ?? null, total_people: a.total_people ?? null, subset: a.subset ?? null, auto_refresh: a.auto_refresh ?? null, refreshed_at: a.refreshed_at ?? null, status: a.status ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Lists (${pg.count} of ${pg.total})${search_name ? ` matching "${search_name}"` : ""}\n\n` + lists.map(l => {
            const a = l.attributes; const parts = [`### ${a.name ?? "(unnamed)"} (ID: ${l.id})`];
            if (a.total_people !== undefined) parts.push(`- **Total people**: ${a.total_people}`);
            if (a.subset) parts.push(`- **Subset**: ${a.subset}`);
            if (a.auto_refresh !== undefined) parts.push(`- **Auto-refresh**: ${a.auto_refresh ? "yes" : "no"}`);
            if (a.refreshed_at) parts.push(`- **Last refreshed**: ${a.refreshed_at}`);
            return parts.join("\n");
          }).join("\n\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_list ────────────────────────────────────────────────────────
  server.registerTool("pc_get_list", {
    title: "Get List Detail (with Rules & Conditions)",
    description: "Retrieve full configuration for a specific People List, INCLUDING its rules and conditions. Surfaces the 'subset' attribute (active/inactive/all) which is the diagnostic key for unexpected list counts.",
    inputSchema: z.object({ list_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ list_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/lists/${list_id}`, { include: "rules,rules.conditions" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const list = asArr(resp.data)[0] as PcoResource;
      const included = (resp.included ?? []) as PcoResource[];
      const rules = included.filter(r => r.type === "Rule");
      const conditions = included.filter(r => r.type === "Condition");
      const a = list.attributes;
      const output = {
        id: list.id, attributes: a,
        rules: rules.map(r => ({ id: r.id, attributes: r.attributes, condition_ids: ((r.relationships?.conditions as { data?: Array<{ id: string }> } | undefined)?.data ?? []).map(c => c.id) })),
        conditions: conditions.map(c => ({ id: c.id, rule_id: ((c.relationships?.rule as { data?: { id?: string } } | undefined)?.data ?? {}).id ?? null, attributes: c.attributes })),
      };
      let text: string;
      if (response_format === ResponseFormat.MARKDOWN) {
        const lines = [`# ${a.name ?? "(unnamed list)"} (ID: ${list.id})`];
        if (a.description) { lines.push("", `> ${a.description}`); }
        lines.push("", "## List configuration");
        if (a.total_people !== undefined) lines.push(`- **Total people**: ${a.total_people}`);
        if (a.subset) lines.push(`- **Subset (active/inactive scope)**: \`${a.subset}\``);
        if (a.auto_refresh !== undefined) lines.push(`- **Auto-refresh**: ${a.auto_refresh ? "yes" : "no"}`);
        if (a.status) lines.push(`- **Status**: ${a.status}`);
        if (a.refreshed_at) lines.push(`- **Last refreshed**: ${a.refreshed_at}`);
        if (a.invalid) lines.push(`- ⚠️ **Invalid**: yes`);
        const condByRule = new Map<string, PcoResource[]>();
        for (const c of conditions) {
          const rid = ((c.relationships?.rule as { data?: { id?: string } } | undefined)?.data ?? {}).id;
          if (!rid) continue;
          if (!condByRule.has(rid)) condByRule.set(rid, []);
          condByRule.get(rid)!.push(c);
        }
        if (rules.length) {
          lines.push("", `## Rules (${rules.length})`);
          rules.forEach((rule, idx) => {
            const ra = rule.attributes;
            const matchType = ra.subset === "all" ? "ALL (AND)" : ra.subset === "any" ? "ANY (OR)" : (ra.subset ?? "?");
            lines.push("", `### Rule ${idx + 1} — match ${matchType}`);
            const conds = condByRule.get(rule.id) ?? [];
            if (!conds.length) { lines.push("  _(no conditions)_"); }
            else { conds.forEach((c, ci) => { const ca = c.attributes; lines.push(`  ${ci + 1}. ${ca.description ?? "(no description)"}`); }); }
          });
        }
        if (a.subset && a.subset !== "active") {
          lines.push("", "---", "", `⚠️  **Diagnostic note**: this list's \`subset\` is \`${a.subset}\`, which means inactive profiles ${a.subset === "inactive" ? "ONLY" : "may"} be included regardless of rule conditions. To restrict to active only, set the list's subset to \`active\`.`);
        }
        text = lines.join("\n");
      } else { text = JSON.stringify(output, null, 2); }
      return { content: [{ type: "text", text: trunc(text) }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_people_on_list ─────────────────────────────────────────────
  server.registerTool("pc_list_people_on_list", {
    title: "List People on a List",
    description: "Get the actual people currently on a specific List.",
    inputSchema: z.object({ list_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ list_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/lists/${list_id}/people`, { ...paginationParams(limit, offset) });
      const people = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!people.length) return { content: [{ type: "text", text: `No people on list ${list_id}.` }] };
      const output = { ...pg, offset, list_id, people: people.map(p => ({ id: p.id, name: (p.attributes.name as string) ?? `${p.attributes.first_name ?? ""} ${p.attributes.last_name ?? ""}`.trim(), status: p.attributes.status ?? null, membership: p.attributes.membership ?? null })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# People on list ${list_id} (${pg.count} of ${pg.total})\n\n` + output.people.map(p => `- **${p.name}** (ID: ${p.id})${p.status ? ` — ${p.status}` : ""}${p.membership ? ` — ${p.membership}` : ""}`).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_households ─────────────────────────────────────────────────
  server.registerTool("pc_list_households", {
    title: "List Households",
    description: "List households (family units) in Planning Center People.",
    inputSchema: z.object({ search_name: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/people/v2/households", params);
      const hh = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!hh.length) return { content: [{ type: "text", text: search_name ? `No households found matching "${search_name}".` : "No households found." }] };
      const output = { ...pg, offset, households: hh.map(h => { const a = h.attributes; return { id: h.id, name: a.name ?? null, member_count: a.member_count ?? null, primary_contact_name: a.primary_contact_name ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Households (${pg.count} of ${pg.total})\n\n` + hh.map(h => { const a = h.attributes; return `### ${a.name ?? "(unnamed household)"} (ID: ${h.id})\n- **Members**: ${a.member_count ?? "?"}${a.primary_contact_name ? `\n- **Primary contact**: ${a.primary_contact_name}` : ""}`; }).join("\n\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_household ───────────────────────────────────────────────────
  server.registerTool("pc_get_household", {
    title: "Get Household Detail",
    description: "Retrieve a specific household with all its members.",
    inputSchema: z.object({ household_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ household_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/households/${household_id}`, { include: "people" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const hh = asArr(resp.data)[0] as PcoResource;
      const members = ((resp.included as PcoResource[] | undefined) ?? []).filter((r) => r.type === "Person");
      const a = hh.attributes;
      const output = { id: hh.id, ...a, members: members.map(p => { const pa = p.attributes; return { id: p.id, name: (pa.name as string) ?? `${pa.first_name ?? ""} ${pa.last_name ?? ""}`.trim(), child: pa.child ?? null, birthdate: pa.birthdate ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`# ${a.name ?? "(unnamed household)"} (ID: ${hh.id})`, "", `- **Members**: ${a.member_count ?? members.length}`, a.primary_contact_name ? `- **Primary contact**: ${a.primary_contact_name}` : "", "", "## Members", ...output.members.map(m => `- **${m.name}** (ID: ${m.id})${m.child === true ? " (child)" : m.child === false ? " (adult)" : ""}${m.birthdate ? ` — ${m.birthdate}` : ""}`)].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_workflows ──────────────────────────────────────────────────
  server.registerTool("pc_list_workflows", {
    title: "List Workflows",
    description: "List pastoral workflows. Use include_archived=true to see archived ones.",
    inputSchema: z.object({ search_name: z.string().optional(), include_archived: z.boolean().optional().default(false), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, include_archived, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      if (!include_archived) params["filter"] = "not_archived";
      const resp = await pcoGet<PcoResource>("/people/v2/workflows", params);
      const wf = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!wf.length) return { content: [{ type: "text", text: search_name ? `No workflows found matching "${search_name}".` : "No workflows found." }] };
      const output = { ...pg, offset, workflows: wf.map(w => { const a = w.attributes; return { id: w.id, name: a.name ?? null, total_cards: a.total_cards_count ?? null, ready_cards: a.total_ready_card_count ?? null, overdue_cards: a.total_overdue_card_count ?? null, completed_cards: a.completed_card_count ?? null, archived: !!a.archived_at }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Workflows (${pg.count} of ${pg.total})\n\n` + wf.map(w => {
            const a = w.attributes; const parts = [`### ${a.name ?? "(unnamed workflow)"} (ID: ${w.id})`];
            if (a.total_cards_count !== undefined) parts.push(`- **Total cards**: ${a.total_cards_count}`);
            if (a.total_ready_card_count !== undefined) parts.push(`- **Ready**: ${a.total_ready_card_count}`);
            if ((((a.total_overdue_card_count as number | undefined) ?? 0)) > 0) parts.push(`- **Overdue**: ${a.total_overdue_card_count}`);
            if (a.archived_at) parts.push(`- ⚠️ **Archived**`);
            return parts.join("\n");
          }).join("\n\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_workflow ────────────────────────────────────────────────────
  server.registerTool("pc_get_workflow", {
    title: "Get Workflow Detail",
    description: "Retrieve a specific workflow with full metrics.",
    inputSchema: z.object({ workflow_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ workflow_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/workflows/${workflow_id}`);
      const w = asArr(resp.data)[0] as PcoResource;
      const a = w.attributes;
      const output = { id: w.id, ...a };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`### ${a.name ?? "(unnamed workflow)"} (ID: ${w.id})`, a.total_cards_count !== undefined ? `- **Total cards**: ${a.total_cards_count}` : "", a.total_ready_card_count !== undefined ? `- **Ready**: ${a.total_ready_card_count}` : "", (((a.total_overdue_card_count as number | undefined) ?? 0)) > 0 ? `- **Overdue**: ${a.total_overdue_card_count}` : "", a.completed_card_count !== undefined ? `- **Completed**: ${a.completed_card_count}` : "", a.archived_at ? `- ⚠️ **Archived**` : ""].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_workflow_cards ─────────────────────────────────────────────
  server.registerTool("pc_list_workflow_cards", {
    title: "List Workflow Cards",
    description: "List cards (people in pipeline) for a workflow. Filter by stage: ready/snoozed/overdue/all.",
    inputSchema: z.object({ workflow_id: z.string().min(1), stage: z.enum(["ready","snoozed","overdue","all"]).optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ workflow_id, stage, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset), include: "person" };
      if (stage && stage !== "all") params["where[stage]"] = stage;
      const resp = await pcoGet<PcoResource>(`/people/v2/workflows/${workflow_id}/cards`, params) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const cards = asArr(resp.data) as PcoResource[];
      const peopleById = new Map(((resp.included as PcoResource[] | undefined) ?? []).filter((r) => r.type === "Person").map((p) => [p.id, p]));
      const pg = extractPagination(resp, offset);
      if (!cards.length) return { content: [{ type: "text", text: `No cards in workflow ${workflow_id}${stage && stage !== "all" ? ` (stage: ${stage})` : ""}.` }] };
      const output = { ...pg, offset, workflow_id, cards: cards.map(c => { const ca = c.attributes; const pid = ((c.relationships?.person as { data?: { id?: string } } | undefined)?.data ?? {}).id; const p = pid ? peopleById.get(pid) : undefined; return { card_id: c.id, person_id: pid ?? null, person_name: p ? ((p.attributes.name as string | undefined) ?? null) : null, stage: ca.stage ?? null, overdue: ca.overdue ?? null, calculated_due_at_in_days_ago: ca.calculated_due_at_in_days_ago ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Workflow ${workflow_id} — cards (${pg.count} of ${pg.total})${stage && stage !== "all" ? ` (stage: ${stage})` : ""}\n\n` + output.cards.map(c => `- **${c.person_name ?? `Person ${c.person_id}`}** (card: ${c.card_id})${c.stage ? ` — ${c.stage}` : ""}${c.overdue ? " ⚠️ overdue" : ""}${c.calculated_due_at_in_days_ago != null ? ` — ${c.calculated_due_at_in_days_ago}d ago` : ""}`).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_forms ──────────────────────────────────────────────────────
  server.registerTool("pc_list_forms", {
    title: "List Forms",
    description: "List forms (connect cards, signups, registrations).",
    inputSchema: z.object({ search_name: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/people/v2/forms", params);
      const forms = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!forms.length) return { content: [{ type: "text", text: search_name ? `No forms found matching "${search_name}".` : "No forms found." }] };
      const output = { ...pg, offset, forms: forms.map(f => { const a = f.attributes; return { id: f.id, name: a.name ?? null, submission_count: a.submission_count ?? null, active: a.active ?? null, archived: a.archived ?? null, public_url: a.public_url ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Forms (${pg.count} of ${pg.total})\n\n` + forms.map(f => { const a = f.attributes; const parts = [`### ${a.name ?? "(unnamed)"} (ID: ${f.id})`]; if (a.submission_count !== undefined) parts.push(`- **Submissions**: ${a.submission_count}`); if (a.active !== undefined) parts.push(`- **Active**: ${a.active ? "yes" : "no"}`); if (a.archived) parts.push(`- ⚠️ **Archived**`); if (a.public_url) parts.push(`- **URL**: ${a.public_url}`); return parts.join("\n"); }).join("\n\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_form_submissions ───────────────────────────────────────────
  server.registerTool("pc_list_form_submissions", {
    title: "List Form Submissions",
    description: "List submissions for a specific form.",
    inputSchema: z.object({ form_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ form_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/forms/${form_id}/form_submissions`, { ...paginationParams(limit, offset), include: "person" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const subs = asArr(resp.data) as PcoResource[];
      const peopleById = new Map(((resp.included as PcoResource[] | undefined) ?? []).filter((r) => r.type === "Person").map((p) => [p.id, p]));
      const pg = extractPagination(resp, offset);
      if (!subs.length) return { content: [{ type: "text", text: `No submissions for form ${form_id}.` }] };
      const output = { ...pg, offset, form_id, submissions: subs.map(s => { const sa = s.attributes; const pid = ((s.relationships?.person as { data?: { id?: string } } | undefined)?.data ?? {}).id; const p = pid ? peopleById.get(pid) : undefined; return { id: s.id, person_id: pid ?? null, person_name: p ? ((p.attributes.name as string | undefined) ?? null) : null, verified: sa.verified ?? null, created_at: sa.created_at ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Form ${form_id} — submissions (${pg.count} of ${pg.total})\n\n` + output.submissions.map(s => `- **${s.person_name ?? "(no linked person)"}** — ${s.created_at ?? "?"}${s.verified === true ? " ✓" : s.verified === false ? " ⚠️ unverified" : ""} (ID: ${s.id})`).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_field_definitions ──────────────────────────────────────────
  server.registerTool("pc_list_field_definitions", {
    title: "List Custom Field Definitions",
    description: "List custom field definitions on PCO People profiles.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/people/v2/field_definitions", { ...paginationParams(limit, offset) });
      const defs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!defs.length) return { content: [{ type: "text", text: "No field definitions found." }] };
      const output = { ...pg, offset, field_definitions: defs.map(d => { const a = d.attributes; return { id: d.id, name: a.name ?? null, slug: a.slug ?? null, data_type: a.data_type ?? null, deleted: !!a.deleted_at }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Custom field definitions (${pg.count} of ${pg.total})\n\n` + output.field_definitions.map(d => `- **${d.name ?? "(unnamed)"}** (ID: ${d.id})${d.data_type ? ` — ${d.data_type}` : ""}${d.deleted ? " ⚠️ deleted" : ""}`).join("\n") + (pg.has_more ? `\n\n_More results — use offset=${pg.next_offset}_` : ""))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });


  // ═══ WAVE 2: SERVICES, CHECK-INS, GIVING, GROUPS DEEPER ═════════════════

  // ─── pc_list_service_types ──────────────────────────────────────────────
  server.registerTool("pc_list_service_types", {
    title: "List Service Types",
    description: "List all service types (e.g. Sunday AM, Sunday PM) in PCO Services.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/services/v2/service_types", { ...paginationParams(limit, offset) });
      const sts = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!sts.length) return { content: [{ type: "text", text: "No service types found." }] };
      const output = { ...pg, offset, service_types: sts.map(s => ({ id: s.id, ...s.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Service Types (${pg.count} of ${pg.total})\n\n` + sts.map(s => `- **${s.attributes.name ?? "(unnamed)"}** (ID: ${s.id})${s.attributes.frequency ? ` — ${s.attributes.frequency}` : ""}`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_teams ──────────────────────────────────────────────────────
  server.registerTool("pc_list_teams", {
    title: "List Service Teams",
    description: "List teams within a service type (e.g. Welcome, Tech, Worship).",
    inputSchema: z.object({ service_type_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ service_type_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/teams`, { ...paginationParams(limit, offset) });
      const teams = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!teams.length) return { content: [{ type: "text", text: `No teams found in service type ${service_type_id}.` }] };
      const output = { ...pg, offset, service_type_id, teams: teams.map(t => ({ id: t.id, ...t.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Teams in service type ${service_type_id} (${pg.count} of ${pg.total})\n\n` + teams.map(t => `- **${t.attributes.name ?? "(unnamed)"}** (ID: ${t.id})`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_team_members ───────────────────────────────────────────────
  server.registerTool("pc_list_team_members", {
    title: "List Team Members for a Plan",
    description: "Get who's serving on a specific plan, with their team positions and confirmation status.",
    inputSchema: z.object({ service_type_id: z.string().min(1), plan_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ service_type_id, plan_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}/team_members`, { ...paginationParams(limit, offset), include: "person,team" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const members = asArr(resp.data) as PcoResource[];
      const incl = (resp.included as PcoResource[] | undefined) ?? [];
      const peopleById = new Map(incl.filter(r => r.type === "Person").map(p => [p.id, p]));
      const teamsById = new Map(incl.filter(r => r.type === "Team").map(t => [t.id, t]));
      const pg = extractPagination(resp, offset);
      if (!members.length) return { content: [{ type: "text", text: "No team members on this plan." }] };
      const output = { ...pg, offset, plan_id, members: members.map(m => { const ma = m.attributes; const pid = ((m.relationships?.person as { data?: { id?: string } } | undefined)?.data ?? {}).id; const tid = ((m.relationships?.team as { data?: { id?: string } } | undefined)?.data ?? {}).id; const p = pid ? peopleById.get(pid) : undefined; const t = tid ? teamsById.get(tid) : undefined; return { id: m.id, person_name: p ? (p.attributes.name as string | undefined) ?? null : null, team_name: t ? (t.attributes.name as string | undefined) ?? null : null, status: ma.status ?? null, team_position_name: ma.team_position_name ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Team members on plan ${plan_id} (${pg.count} of ${pg.total})\n\n` + output.members.map(m => `- **${m.person_name ?? "(unknown)"}** — ${m.team_name ?? "?"} / ${m.team_position_name ?? "?"}${m.status ? ` (${m.status})` : ""}`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_songs ──────────────────────────────────────────────────────
  server.registerTool("pc_list_songs", {
    title: "List Songs",
    description: "List songs in your PCO Services library.",
    inputSchema: z.object({ search_title: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_title, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_title) params["where[title]"] = search_title;
      const resp = await pcoGet<PcoResource>("/services/v2/songs", params);
      const songs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!songs.length) return { content: [{ type: "text", text: search_title ? `No songs found matching "${search_title}".` : "No songs found." }] };
      const output = { ...pg, offset, songs: songs.map(s => ({ id: s.id, ...s.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Songs (${pg.count} of ${pg.total})\n\n` + songs.map(s => { const a = s.attributes; return `- **${a.title ?? "(untitled)"}**${a.author ? ` — ${a.author}` : ""} (ID: ${s.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_song ────────────────────────────────────────────────────────
  server.registerTool("pc_get_song", {
    title: "Get Song Detail",
    description: "Retrieve a song with full metadata (CCLI, themes, author).",
    inputSchema: z.object({ song_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ song_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/services/v2/songs/${song_id}`);
      const s = asArr(resp.data)[0] as PcoResource;
      const a = s.attributes;
      const output = { id: s.id, ...a };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`# ${a.title ?? "(untitled)"} (ID: ${s.id})`, a.author ? `- **Author**: ${a.author}` : "", a.copyright ? `- **Copyright**: ${a.copyright}` : "", a.ccli_number ? `- **CCLI**: ${a.ccli_number}` : "", a.themes ? `- **Themes**: ${a.themes}` : "", a.last_scheduled_short_dates ? `- **Last scheduled**: ${a.last_scheduled_short_dates}` : ""].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_arrangements ───────────────────────────────────────────────
  server.registerTool("pc_list_arrangements", {
    title: "List Song Arrangements",
    description: "List arrangements (different keys/versions) for a song.",
    inputSchema: z.object({ song_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ song_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/services/v2/songs/${song_id}/arrangements`, { ...paginationParams(limit, offset) });
      const arr = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!arr.length) return { content: [{ type: "text", text: `No arrangements found for song ${song_id}.` }] };
      const output = { ...pg, offset, song_id, arrangements: arr.map(a => ({ id: a.id, ...a.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Arrangements for song ${song_id} (${pg.count} of ${pg.total})\n\n` + arr.map(a => { const x = a.attributes; return `- **${x.name ?? "(unnamed)"}** — key: ${x.print_key ?? x.chord_chart_key ?? "?"}, BPM: ${x.bpm ?? "?"} (ID: ${a.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_series ─────────────────────────────────────────────────────
  server.registerTool("pc_list_series", {
    title: "List Sermon Series",
    description: "List sermon/series within a service type.",
    inputSchema: z.object({ service_type_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ service_type_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/series`, { ...paginationParams(limit, offset), order: "-last_plan_short_dates" });
      const series = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!series.length) return { content: [{ type: "text", text: `No series in service type ${service_type_id}.` }] };
      const output = { ...pg, offset, service_type_id, series: series.map(s => ({ id: s.id, ...s.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Series in service type ${service_type_id} (${pg.count} of ${pg.total})\n\n` + series.map(s => { const a = s.attributes; return `- **${a.title ?? "(untitled)"}** (ID: ${s.id})${a.last_plan_short_dates ? ` — ${a.last_plan_short_dates}` : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_events ─────────────────────────────────────────────────────
  server.registerTool("pc_list_events", {
    title: "List Check-In Events",
    description: "List events in PCO Check-Ins (kids services, weekly programmes).",
    inputSchema: z.object({ search_name: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/check-ins/v2/events", params);
      const events = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!events.length) return { content: [{ type: "text", text: search_name ? `No events found matching "${search_name}".` : "No events found." }] };
      const output = { ...pg, offset, events: events.map(e => ({ id: e.id, ...e.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Events (${pg.count} of ${pg.total})\n\n` + events.map(e => { const a = e.attributes; return `- **${a.name ?? "(unnamed)"}** (ID: ${e.id})${a.frequency ? ` — ${a.frequency}` : ""}${a.archived_at ? " ⚠️ archived" : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_event ───────────────────────────────────────────────────────
  server.registerTool("pc_get_event", {
    title: "Get Event Detail",
    description: "Retrieve a check-in event's full configuration.",
    inputSchema: z.object({ event_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/check-ins/v2/events/${event_id}`);
      const ev = asArr(resp.data)[0] as PcoResource;
      const output = { id: ev.id, ...ev.attributes };
      const text = response_format === ResponseFormat.MARKDOWN
        ? `# ${ev.attributes.name ?? "(unnamed)"} (ID: ${ev.id})\n\n` + Object.entries(ev.attributes).map(([k, v]) => `- **${k}**: ${v ?? "—"}`).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_event_times ────────────────────────────────────────────────
  server.registerTool("pc_list_event_times", {
    title: "List Event Times (Sessions)",
    description: "List the specific scheduled times for an event.",
    inputSchema: z.object({ event_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/check-ins/v2/events/${event_id}/event_times`, { ...paginationParams(limit, offset), order: "-starts_at" });
      const ets = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!ets.length) return { content: [{ type: "text", text: `No event times for event ${event_id}.` }] };
      const output = { ...pg, offset, event_id, event_times: ets.map(t => ({ id: t.id, ...t.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Event times for event ${event_id} (${pg.count} of ${pg.total})\n\n` + ets.map(t => { const a = t.attributes; return `- **${a.name ?? "Session"}** — ${a.starts_at ?? "?"} (ID: ${t.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_funds ──────────────────────────────────────────────────────
  server.registerTool("pc_list_funds", {
    title: "List Giving Funds",
    description: "List the giving funds in PCO Giving.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/funds", { ...paginationParams(limit, offset) });
      const funds = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!funds.length) return { content: [{ type: "text", text: "No funds found." }] };
      const output = { ...pg, offset, funds: funds.map(f => ({ id: f.id, ...f.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Funds (${pg.count} of ${pg.total})\n\n` + funds.map(f => { const a = f.attributes; return `- **${a.name ?? "(unnamed)"}** (ID: ${f.id})${a.visibility ? ` — ${a.visibility}` : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_batches ────────────────────────────────────────────────────
  server.registerTool("pc_list_batches", {
    title: "List Donation Batches",
    description: "List donation batches (groupings of donations) in PCO Giving.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/batches", { ...paginationParams(limit, offset), order: "-committed_at" });
      const batches = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!batches.length) return { content: [{ type: "text", text: "No batches found." }] };
      const output = { ...pg, offset, batches: batches.map(b => ({ id: b.id, ...b.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Batches (${pg.count} of ${pg.total})\n\n` + batches.map(b => { const a = b.attributes; const cents = a.total_cents as number | undefined; return `- **${a.description ?? "(no description)"}** — ${cents != null ? fmtCurrency(cents, (a.total_currency as string) ?? "AUD") : "—"} (ID: ${b.id})${a.committed_at ? ` — committed ${a.committed_at}` : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_pledges ────────────────────────────────────────────────────
  server.registerTool("pc_list_pledges", {
    title: "List Pledges",
    description: "List pledges (giving commitments). Optionally filter by pledge_campaign_id.",
    inputSchema: z.object({ pledge_campaign_id: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ pledge_campaign_id, limit, offset, response_format }) => {
    try {
      const path = pledge_campaign_id ? `/giving/v2/pledge_campaigns/${pledge_campaign_id}/pledges` : "/giving/v2/pledges";
      const resp = await pcoGet<PcoResource>(path, { ...paginationParams(limit, offset) });
      const pledges = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!pledges.length) return { content: [{ type: "text", text: "No pledges found." }] };
      const output = { ...pg, offset, pledges: pledges.map(p => ({ id: p.id, ...p.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Pledges (${pg.count} of ${pg.total})\n\n` + pledges.map(p => { const a = p.attributes; const amt = a.amount_cents != null ? fmtCurrency(a.amount_cents as number, (a.amount_currency as string) ?? "AUD") : "?"; const paid = a.donated_total_cents != null ? fmtCurrency(a.donated_total_cents as number, (a.amount_currency as string) ?? "AUD") : "?"; return `- pledge ${p.id} — pledged ${amt}, paid ${paid}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_pledge_campaigns ───────────────────────────────────────────
  server.registerTool("pc_list_pledge_campaigns", {
    title: "List Pledge Campaigns",
    description: "List pledge campaigns (e.g. building fund, missions).",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/pledge_campaigns", { ...paginationParams(limit, offset) });
      const camps = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!camps.length) return { content: [{ type: "text", text: "No pledge campaigns found." }] };
      const output = { ...pg, offset, pledge_campaigns: camps.map(c => ({ id: c.id, ...c.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Pledge campaigns (${pg.count} of ${pg.total})\n\n` + camps.map(c => { const a = c.attributes; const goal = a.goal_cents != null ? fmtCurrency(a.goal_cents as number, (a.goal_currency as string) ?? "AUD") : "?"; const pledged = a.total_pledged_cents != null ? fmtCurrency(a.total_pledged_cents as number, (a.goal_currency as string) ?? "AUD") : "?"; return `- **${a.name ?? "(unnamed)"}** — goal ${goal}, pledged ${pledged} (ID: ${c.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_recurring_donations ────────────────────────────────────────
  server.registerTool("pc_list_recurring_donations", {
    title: "List Recurring Donations",
    description: "List active recurring donations / standing orders.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/recurring_donations", { ...paginationParams(limit, offset) });
      const rds = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!rds.length) return { content: [{ type: "text", text: "No recurring donations found." }] };
      const output = { ...pg, offset, recurring_donations: rds.map(r => ({ id: r.id, ...r.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Recurring donations (${pg.count} of ${pg.total})\n\n` + rds.map(r => { const a = r.attributes; const amt = a.amount_cents != null ? fmtCurrency(a.amount_cents as number, (a.amount_currency as string) ?? "AUD") : "?"; return `- ${amt} ${a.schedule ?? "?"} — status: ${a.status ?? "?"} (ID: ${r.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_donation ────────────────────────────────────────────────────
  server.registerTool("pc_get_donation", {
    title: "Get Donation Detail",
    description: "Retrieve full details for a specific donation, with line items by fund.",
    inputSchema: z.object({ donation_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ donation_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/giving/v2/donations/${donation_id}`, { include: "designations" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const d = asArr(resp.data)[0] as PcoResource;
      const designations = ((resp.included as PcoResource[] | undefined) ?? []).filter(r => r.type === "Designation");
      const a = d.attributes;
      const output = { id: d.id, ...a, designations: designations.map(x => ({ id: x.id, ...x.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`# Donation ${d.id}`, `- **Amount**: ${a.amount_cents != null ? fmtCurrency(a.amount_cents as number, (a.amount_currency as string) ?? "AUD") : "?"}`, a.received_at ? `- **Received**: ${a.received_at}` : "", a.payment_method ? `- **Method**: ${a.payment_method}` : "", a.refunded ? "- ⚠️ refunded" : "", "", "## Designations", ...designations.map(x => { const xa = x.attributes; return `- ${xa.amount_cents != null ? fmtCurrency(xa.amount_cents as number) : "?"} → fund ${((x.relationships?.fund as { data?: { id?: string } } | undefined)?.data ?? {}).id ?? "?"}`; })].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_group ───────────────────────────────────────────────────────
  server.registerTool("pc_get_group", {
    title: "Get Group Detail",
    description: "Retrieve full configuration for a specific small group.",
    inputSchema: z.object({ group_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}`);
      const g = asArr(resp.data)[0] as PcoResource;
      const output = { id: g.id, ...g.attributes };
      const text = response_format === ResponseFormat.MARKDOWN
        ? `# ${g.attributes.name ?? "(unnamed)"} (ID: ${g.id})\n\n` + Object.entries(g.attributes).filter(([_, v]) => v != null && v !== "").map(([k, v]) => `- **${k}**: ${v}`).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_group_memberships ──────────────────────────────────────────
  server.registerTool("pc_list_group_memberships", {
    title: "List Group Members",
    description: "List members of a specific group with their roles (member/leader).",
    inputSchema: z.object({ group_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}/memberships`, { ...paginationParams(limit, offset), include: "person" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const ms = asArr(resp.data) as PcoResource[];
      const peopleById = new Map(((resp.included as PcoResource[] | undefined) ?? []).filter(r => r.type === "Person").map(p => [p.id, p]));
      const pg = extractPagination(resp, offset);
      if (!ms.length) return { content: [{ type: "text", text: `No members in group ${group_id}.` }] };
      const output = { ...pg, offset, group_id, memberships: ms.map(m => { const ma = m.attributes; const pid = ((m.relationships?.person as { data?: { id?: string } } | undefined)?.data ?? {}).id; const p = pid ? peopleById.get(pid) : undefined; return { id: m.id, person_id: pid ?? null, person_name: p ? (p.attributes.name as string | undefined) ?? null : null, role: ma.role ?? null, joined_at: ma.joined_at ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Group ${group_id} — members (${pg.count} of ${pg.total})\n\n` + output.memberships.map(m => `- **${m.person_name ?? "(unknown)"}** — ${m.role ?? "member"}${m.joined_at ? ` (joined ${m.joined_at})` : ""}`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_group_events ───────────────────────────────────────────────
  server.registerTool("pc_list_group_events", {
    title: "List Group Events",
    description: "List meetings/events for a small group.",
    inputSchema: z.object({ group_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}/events`, { ...paginationParams(limit, offset), order: "-starts_at" });
      const evs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!evs.length) return { content: [{ type: "text", text: `No events for group ${group_id}.` }] };
      const output = { ...pg, offset, group_id, events: evs.map(e => ({ id: e.id, ...e.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Group ${group_id} — events (${pg.count} of ${pg.total})\n\n` + evs.map(e => { const a = e.attributes; return `- **${a.name ?? "(unnamed)"}** — ${a.starts_at ?? "?"} (ID: ${e.id})${a.canceled ? " ⚠️ cancelled" : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_group_attendances ──────────────────────────────────────────
  server.registerTool("pc_list_group_attendances", {
    title: "List Group Attendances",
    description: "List attendance records for a specific group event.",
    inputSchema: z.object({ group_id: z.string().min(1), event_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group_id, event_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/groups/v2/groups/${group_id}/events/${event_id}/attendances`, { ...paginationParams(limit, offset), include: "person" }) as PcoResponse<PcoResource> & { included?: PcoResource[] };
      const att = asArr(resp.data) as PcoResource[];
      const peopleById = new Map(((resp.included as PcoResource[] | undefined) ?? []).filter(r => r.type === "Person").map(p => [p.id, p]));
      const pg = extractPagination(resp, offset);
      if (!att.length) return { content: [{ type: "text", text: `No attendances for event ${event_id}.` }] };
      const output = { ...pg, offset, group_id, event_id, attendances: att.map(a => { const aa = a.attributes; const pid = ((a.relationships?.person as { data?: { id?: string } } | undefined)?.data ?? {}).id; const p = pid ? peopleById.get(pid) : undefined; return { id: a.id, person_id: pid ?? null, person_name: p ? (p.attributes.name as string | undefined) ?? null : null, attended: aa.attended ?? null, role: aa.role ?? null }; }) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Attendance for event ${event_id} (${pg.count} of ${pg.total})\n\n` + output.attendances.map(a => `- **${a.person_name ?? "(unknown)"}** — ${a.attended === true ? "✓ present" : a.attended === false ? "✗ absent" : "?"}${a.role ? ` (${a.role})` : ""}`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_group_types ────────────────────────────────────────────────
  server.registerTool("pc_list_group_types", {
    title: "List Group Types",
    description: "List group types (e.g. Connect, Mission, Discipleship).",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/groups/v2/group_types", { ...paginationParams(limit, offset) });
      const gts = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!gts.length) return { content: [{ type: "text", text: "No group types found." }] };
      const output = { ...pg, offset, group_types: gts.map(g => ({ id: g.id, ...g.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Group types (${pg.count} of ${pg.total})\n\n` + gts.map(g => `- **${g.attributes.name ?? "(unnamed)"}** (ID: ${g.id})`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_tag_groups ─────────────────────────────────────────────────
  server.registerTool("pc_list_tag_groups", {
    title: "List Group Tag Groups",
    description: "List tag groups for categorising small groups.",
    inputSchema: z.object({ limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/groups/v2/tag_groups", { ...paginationParams(limit, offset) });
      const tgs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!tgs.length) return { content: [{ type: "text", text: "No tag groups found." }] };
      const output = { ...pg, offset, tag_groups: tgs.map(t => ({ id: t.id, ...t.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Tag groups (${pg.count} of ${pg.total})\n\n` + tgs.map(t => `- **${t.attributes.name ?? "(unnamed)"}** (ID: ${t.id})`).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });


  // ═══ WAVE 3: CALENDAR (resource booking & events) ═══════════════════════

  // ─── pc_list_calendar_events ────────────────────────────────────────────
  server.registerTool("pc_list_calendar_events", {
    title: "List Calendar Events",
    description: "List events from PCO Calendar (rooms, building bookings, ministry events).",
    inputSchema: z.object({ search_name: z.string().optional(), starts_after: z.string().optional().describe("ISO datetime — only events starting after this"), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, starts_after, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset), order: "starts_at" };
      if (search_name) params["where[name]"] = search_name;
      if (starts_after) params["where[starts_at][gte]"] = starts_after;
      const resp = await pcoGet<PcoResource>("/calendar/v2/events", params);
      const evs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!evs.length) return { content: [{ type: "text", text: "No calendar events found." }] };
      const output = { ...pg, offset, events: evs.map(e => ({ id: e.id, ...e.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Calendar events (${pg.count} of ${pg.total})\n\n` + evs.map(e => { const a = e.attributes; return `- **${a.name ?? "(unnamed)"}** — ${a.starts_at ?? "?"}${a.approval_status ? ` [${a.approval_status}]` : ""} (ID: ${e.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_get_calendar_event ──────────────────────────────────────────────
  server.registerTool("pc_get_calendar_event", {
    title: "Get Calendar Event Detail",
    description: "Retrieve a calendar event with full details.",
    inputSchema: z.object({ event_id: z.string().min(1), response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/calendar/v2/events/${event_id}`);
      const e = asArr(resp.data)[0] as PcoResource;
      const output = { id: e.id, ...e.attributes };
      const text = response_format === ResponseFormat.MARKDOWN
        ? `# ${e.attributes.name ?? "(unnamed)"} (ID: ${e.id})\n\n` + Object.entries(e.attributes).filter(([_, v]) => v != null && v !== "").map(([k, v]) => `- **${k}**: ${v}`).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_event_instances ────────────────────────────────────────────
  server.registerTool("pc_list_event_instances", {
    title: "List Event Instances",
    description: "List the specific dated instances of a recurring calendar event.",
    inputSchema: z.object({ event_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/calendar/v2/events/${event_id}/event_instances`, { ...paginationParams(limit, offset), order: "starts_at" });
      const ins = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!ins.length) return { content: [{ type: "text", text: `No instances for event ${event_id}.` }] };
      const output = { ...pg, offset, event_id, instances: ins.map(i => ({ id: i.id, ...i.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Event ${event_id} — instances (${pg.count} of ${pg.total})\n\n` + ins.map(i => { const a = i.attributes; return `- ${a.starts_at ?? "?"} → ${a.ends_at ?? "?"}${a.all_day_event ? " (all day)" : ""} (ID: ${i.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_resources ──────────────────────────────────────────────────
  server.registerTool("pc_list_resources", {
    title: "List Calendar Resources",
    description: "List bookable resources (rooms, equipment).",
    inputSchema: z.object({ search_name: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Attrs = { ...paginationParams(limit, offset) };
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/calendar/v2/resources", params);
      const res = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!res.length) return { content: [{ type: "text", text: "No resources found." }] };
      const output = { ...pg, offset, resources: res.map(r => ({ id: r.id, ...r.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Resources (${pg.count} of ${pg.total})\n\n` + res.map(r => { const a = r.attributes; return `- **${a.name ?? "(unnamed)"}** (ID: ${r.id})${a.kind ? ` — ${a.kind}` : ""}${a.quantity != null ? ` × ${a.quantity}` : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_resource_bookings ──────────────────────────────────────────
  server.registerTool("pc_list_resource_bookings", {
    title: "List Resource Bookings",
    description: "List resource bookings on calendar events. Filter by resource_id for a specific room.",
    inputSchema: z.object({ resource_id: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ resource_id, limit, offset, response_format }) => {
    try {
      const path = resource_id ? `/calendar/v2/resources/${resource_id}/resource_bookings` : "/calendar/v2/resource_bookings";
      const resp = await pcoGet<PcoResource>(path, { ...paginationParams(limit, offset), order: "starts_at" });
      const bks = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!bks.length) return { content: [{ type: "text", text: "No resource bookings found." }] };
      const output = { ...pg, offset, resource_bookings: bks.map(b => ({ id: b.id, ...b.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Resource bookings (${pg.count} of ${pg.total})\n\n` + bks.map(b => { const a = b.attributes; return `- ${a.starts_at ?? "?"} → ${a.ends_at ?? "?"} (ID: ${b.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_event_resource_requests ────────────────────────────────────
  server.registerTool("pc_list_event_resource_requests", {
    title: "List Event Resource Requests",
    description: "List resource booking requests for events (pending/approved/rejected).",
    inputSchema: z.object({ event_id: z.string().optional(), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const path = event_id ? `/calendar/v2/events/${event_id}/event_resource_requests` : "/calendar/v2/event_resource_requests";
      const resp = await pcoGet<PcoResource>(path, { ...paginationParams(limit, offset) });
      const reqs = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!reqs.length) return { content: [{ type: "text", text: "No resource requests found." }] };
      const output = { ...pg, offset, requests: reqs.map(r => ({ id: r.id, ...r.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Resource requests (${pg.count} of ${pg.total})\n\n` + reqs.map(r => { const a = r.attributes; return `- request ${r.id} — status: ${a.status ?? "?"}${a.notes ? ` — ${a.notes}` : ""}`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_list_attachments ────────────────────────────────────────────────
  server.registerTool("pc_list_attachments", {
    title: "List Calendar Event Attachments",
    description: "List file attachments on a calendar event.",
    inputSchema: z.object({ event_id: z.string().min(1), limit: limitSchema, offset: offsetSchema, response_format: responseFormatSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/calendar/v2/events/${event_id}/attachments`, { ...paginationParams(limit, offset) });
      const at = asArr(resp.data) as PcoResource[];
      const pg = extractPagination(resp, offset);
      if (!at.length) return { content: [{ type: "text", text: `No attachments on event ${event_id}.` }] };
      const output = { ...pg, offset, event_id, attachments: at.map(a => ({ id: a.id, ...a.attributes })) };
      const text = response_format === ResponseFormat.MARKDOWN
        ? trunc(`# Attachments on event ${event_id} (${pg.count} of ${pg.total})\n\n` + at.map(a => { const x = a.attributes; return `- **${x.name ?? "(unnamed)"}** — ${x.url ?? ""} (ID: ${a.id})`; }).join("\n"))
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ═══ WAVE 4: WRITE OPERATIONS (be careful!) ═════════════════════════════

  // ─── pc_update_person ───────────────────────────────────────────────────
  server.registerTool("pc_update_person", {
    title: "Update Person Profile (Write)",
    description: "Update a person's basic profile. Only the fields provided will be changed. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({
      person_id: z.string().min(1),
      first_name: z.string().optional(), last_name: z.string().optional(),
      birthdate: z.string().optional(), gender: z.string().optional(),
      membership: z.string().optional(), status: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ person_id, ...attrs }) => {
    try {
      const cleanAttrs: Attrs = {};
      Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined) cleanAttrs[k] = v; });
      if (!Object.keys(cleanAttrs).length) return { content: [{ type: "text", text: "No fields provided to update." }] };
      const body = { data: { type: "Person", id: person_id, attributes: cleanAttrs } };
      await pcoPatch(`/people/v2/people/${person_id}`, body);
      return { content: [{ type: "text", text: `✓ Updated person ${person_id}: ${Object.keys(cleanAttrs).join(", ")}` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_add_person_note ─────────────────────────────────────────────────
  server.registerTool("pc_add_person_note", {
    title: "Add Note to Person (Write)",
    description: "Add a pastoral note to a person's profile. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ person_id: z.string().min(1), note_category_id: z.string().min(1), note: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ person_id, note_category_id, note }) => {
    try {
      const body = { data: { type: "Note", attributes: { note }, relationships: { person: { data: { type: "Person", id: person_id } }, note_category: { data: { type: "NoteCategory", id: note_category_id } } } } };
      const resp = await pcoPost<PcoResource>(`/people/v2/notes`, body);
      const created = asArr(resp.data)[0] as PcoResource;
      return { content: [{ type: "text", text: `✓ Added note ${created.id} to person ${person_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_add_person_to_workflow ──────────────────────────────────────────
  server.registerTool("pc_add_person_to_workflow", {
    title: "Add Person to Workflow (Write)",
    description: "Add a person to a pastoral workflow as a new card. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ workflow_id: z.string().min(1), person_id: z.string().min(1), note: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workflow_id, person_id, note }) => {
    try {
      const attrs: Attrs = {};
      if (note) attrs.note = note;
      const body = { data: { type: "WorkflowCard", attributes: attrs, relationships: { person: { data: { type: "Person", id: person_id } } } } };
      const resp = await pcoPost<PcoResource>(`/people/v2/workflows/${workflow_id}/cards`, body);
      const created = asArr(resp.data)[0] as PcoResource;
      return { content: [{ type: "text", text: `✓ Added person ${person_id} to workflow ${workflow_id} (card: ${created.id})` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_complete_workflow_card ──────────────────────────────────────────
  server.registerTool("pc_complete_workflow_card", {
    title: "Complete Workflow Card (Write)",
    description: "Mark a workflow card as complete. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ workflow_id: z.string().min(1), card_id: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ workflow_id, card_id }) => {
    try {
      await pcoPost(`/people/v2/workflows/${workflow_id}/cards/${card_id}/promote`, {});
      return { content: [{ type: "text", text: `✓ Promoted card ${card_id} (workflow ${workflow_id})` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_add_person_to_list ──────────────────────────────────────────────
  server.registerTool("pc_add_person_to_list", {
    title: "Add Person to List (Write)",
    description: "Manually add a person to a list. Note: this only works for lists with no rules (manual lists). ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ list_id: z.string().min(1), person_id: z.string().min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ list_id, person_id }) => {
    try {
      const body = { data: { type: "ListResult", relationships: { person: { data: { type: "Person", id: person_id } } } } };
      await pcoPost(`/people/v2/lists/${list_id}/list_results`, body);
      return { content: [{ type: "text", text: `✓ Added person ${person_id} to list ${list_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_remove_person_from_list ─────────────────────────────────────────
  server.registerTool("pc_remove_person_from_list", {
    title: "Remove Person from List (Write)",
    description: "Remove a person from a list. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ list_id: z.string().min(1), list_result_id: z.string().min(1).describe("The ListResult ID, not the person_id. Get this from pc_list_people_on_list.") }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ list_id, list_result_id }) => {
    try {
      await pcoDelete(`/people/v2/lists/${list_id}/list_results/${list_result_id}`);
      return { content: [{ type: "text", text: `✓ Removed list result ${list_result_id} from list ${list_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ─── pc_mark_group_attendance ───────────────────────────────────────────
  server.registerTool("pc_mark_group_attendance", {
    title: "Mark Group Attendance (Write)",
    description: "Record attendance for a group event. ⚠️ This modifies live PCO data.",
    inputSchema: z.object({ group_id: z.string().min(1), event_id: z.string().min(1), person_id: z.string().min(1), attended: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ group_id, event_id, person_id, attended }) => {
    try {
      const body = { data: { type: "Attendance", attributes: { attended }, relationships: { person: { data: { type: "Person", id: person_id } } } } };
      await pcoPost(`/groups/v2/groups/${group_id}/events/${event_id}/attendances`, body);
      return { content: [{ type: "text", text: `✓ Marked person ${person_id} ${attended ? "PRESENT" : "ABSENT"} for event ${event_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });


  return server;
}

// ═════════════════════════════════════════════════════════════════════════════
// VERCEL HANDLER
// ═════════════════════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") {
    res.status(405).json({ error: "Method Not Allowed", message: "POST to /mcp" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
