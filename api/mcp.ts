/**
 * Vercel serverless handler — Planning Center MCP server.
 *
 * Self-contained: all logic is inlined here so Vercel's @vercel/node runtime
 * can resolve everything without ESM/CJS path issues.
 *
 * Required env vars (set in Vercel dashboard):
 *   PCO_APP_ID  — Planning Center App ID
 *   PCO_SECRET  — Planning Center PAT Secret
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { z } from "zod";
import axios, { AxiosError, AxiosInstance } from "axios";

// ── Constants ────────────────────────────────────────────────────────────────

const PCO_BASE_URL = "https://api.planningcenteronline.com";
const CHARACTER_LIMIT = 25000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// ── PCO API client ───────────────────────────────────────────────────────────

interface PcoResponse<T> {
  data: T | T[];
  meta?: { total_count?: number };
}

interface PcoResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

function getClient(): AxiosInstance {
  const appId = process.env.PCO_APP_ID;
  const secret = process.env.PCO_SECRET;
  if (!appId || !secret) throw new Error("PCO_APP_ID and PCO_SECRET must be set");
  return axios.create({
    baseURL: PCO_BASE_URL,
    auth: { username: appId, password: secret },
    timeout: 30000,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
}

async function pcoGet<T>(path: string, params?: Record<string, unknown>): Promise<PcoResponse<T>> {
  const client = getClient();
  const response = await client.get<PcoResponse<T>>(path, { params });
  return response.data;
}

function handlePcoError(error: unknown): string {
  if (error instanceof AxiosError && error.response) {
    switch (error.response.status) {
      case 401: return "Error: Authentication failed. Check that PCO_APP_ID and PCO_SECRET are correct.";
      case 403: return "Error: Permission denied. Your PAT may lack access to this resource.";
      case 404: return "Error: Resource not found. Check the ID is correct.";
      case 429: return "Error: Rate limit exceeded. Please wait before making more requests.";
      default:  return `Error: API request failed with status ${error.response.status}.`;
    }
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

// ── Shared Zod schemas ───────────────────────────────────────────────────────

const limitSchema = z.union([z.number(), z.string()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT);

const offsetSchema = z.union([z.number(), z.string()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(0))
  .default(0);

const responseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);

// ── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "planning-center-mcp-server", version: "1.0.0" });

  // ── pc_list_people ──────────────────────────────────────────────────────
  server.registerTool("pc_list_people", {
    title: "List / Search People",
    description: "Search and list congregation members in Planning Center People. Use search_name for partial name match.",
    inputSchema: z.object({
      search_name: z.string().optional(),
      limit: limitSchema,
      offset: offsetSchema,
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
      if (search_name) params["where[search_name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/people/v2/people", params);
      const people = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
      const pagination = extractPagination(resp, offset);
      if (!people.length) return { content: [{ type: "text", text: `No people found${search_name ? ` matching "${search_name}"` : ""}.` }] };
      const output = { ...pagination, offset, people: people.map(p => ({ id: p.id, name: (p.attributes.name ?? `${p.attributes.first_name ?? ""} ${p.attributes.last_name ?? ""}`.trim()) as string, status: p.attributes.status ?? null })) };
      let text = response_format === ResponseFormat.MARKDOWN
        ? `# People (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}\n\n` +
          people.map(p => `### ${p.attributes.name ?? `${p.attributes.first_name} ${p.attributes.last_name}`} (ID: ${p.id})`).join("\n") +
          (pagination.has_more ? `\n\n_More results — use offset=${pagination.next_offset}_` : "")
        : JSON.stringify(output, null, 2);
      if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated — use a smaller limit or search_name filter.]";
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ── pc_get_person ───────────────────────────────────────────────────────
  server.registerTool("pc_get_person", {
    title: "Get Person Profile",
    description: "Retrieve the full profile for a specific person by their Planning Center ID.",
    inputSchema: z.object({
      person_id: z.string().min(1),
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ person_id, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>(`/people/v2/people/${person_id}`, { include: "emails,phone_numbers" });
      const person = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
      const a = person.attributes;
      const output = { id: person.id, ...a };
      const text = response_format === ResponseFormat.MARKDOWN
        ? [`### ${a.name ?? `${a.first_name} ${a.last_name}`} (ID: ${person.id})`,
            a.email ? `- **Email**: ${a.email}` : "",
            a.phone_number ? `- **Phone**: ${a.phone_number}` : "",
            a.birthdate ? `- **Birthdate**: ${a.birthdate}` : "",
            a.gender ? `- **Gender**: ${a.gender}` : "",
            a.membership ? `- **Membership**: ${a.membership}` : "",
            a.status ? `- **Status**: ${a.status}` : "",
          ].filter(Boolean).join("\n")
        : JSON.stringify(output, null, 2);
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ── pc_list_services ────────────────────────────────────────────────────
  server.registerTool("pc_list_services", {
    title: "List Upcoming Service Plans",
    description: "List upcoming service plans across all service types in Planning Center Services.",
    inputSchema: z.object({
      limit: limitSchema,
      offset: offsetSchema,
      service_type_id: z.string().optional(),
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, service_type_id, response_format }) => {
    try {
      let serviceTypes: PcoResource[];
      if (service_type_id) {
        const st = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}`);
        serviceTypes = [Array.isArray(st.data) ? st.data[0] : st.data] as PcoResource[];
      } else {
        const st = await pcoGet<PcoResource>("/services/v2/service_types", { per_page: 50 });
        serviceTypes = (Array.isArray(st.data) ? st.data : [st.data]) as PcoResource[];
      }
      const allPlans: Array<{ serviceType: string; plan: PcoResource }> = [];
      for (const st of serviceTypes) {
        const typeName = (st.attributes.name as string) ?? st.id;
        const pr = await pcoGet<PcoResource>(`/services/v2/service_types/${st.id}/plans`, { filter: "future", ...paginationParams(limit, offset), order: "sort_date" });
        const plans = (Array.isArray(pr.data) ? pr.data : [pr.data]) as PcoResource[];
        plans.forEach(plan => allPlans.push({ serviceType: typeName, plan }));
      }
      if (!allPlans.length) return { content: [{ type: "text", text: "No upcoming service plans found." }] };
      const output = { count: allPlans.length, plans: allPlans.map(({ serviceType, plan }) => ({ id: plan.id, service_type: serviceType, ...plan.attributes })) };
      let text = response_format === ResponseFormat.MARKDOWN
        ? `# Upcoming Service Plans (${allPlans.length})\n\n` + allPlans.map(({ serviceType, plan: p }) => {
            const a = p.attributes;
            return [`## ${a.title ?? "Untitled Plan"} (ID: ${p.id})`, `- **Service Type**: ${serviceType}`, `- **Date**: ${a.dates ?? a.sort_date ?? "TBD"}`, a.series_title ? `- **Series**: ${a.series_title}` : "", typeof a.needed_positions_count === "number" ? `- **Open Positions**: ${a.needed_positions_count}` : ""].filter(Boolean).join("\n");
          }).join("\n\n")
        : JSON.stringify(output, null, 2);
      if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated — use service_type_id or smaller limit.]";
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ── pc_get_service ──────────────────────────────────────────────────────
  server.registerTool("pc_get_service", {
    title: "Get Service Plan Detail",
    description: "Retrieve full details for a specific service plan: order of service, songs, and open team positions.",
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
      const plan = (Array.isArray(planResp.data) ? planResp.data[0] : planResp.data) as PcoResource;
      const items = (Array.isArray(itemsResp.data) ? itemsResp.data : [itemsResp.data]) as PcoResource[];
      const positions = (Array.isArray(posResp.data) ? posResp.data : [posResp.data]) as PcoResource[];
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

  // ── pc_list_groups ──────────────────────────────────────────────────────
  server.registerTool("pc_list_groups", {
    title: "List Groups",
    description: "List small groups / community groups from Planning Center Groups.",
    inputSchema: z.object({
      search_name: z.string().optional(),
      limit: limitSchema,
      offset: offsetSchema,
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ search_name, limit, offset, response_format }) => {
    try {
      const params: Record<string, unknown> = paginationParams(limit, offset);
      if (search_name) params["where[name]"] = search_name;
      const resp = await pcoGet<PcoResource>("/groups/v2/groups", params);
      const groups = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
      const pagination = extractPagination(resp, offset);
      if (!groups.length) return { content: [{ type: "text", text: `No groups found${search_name ? ` matching "${search_name}"` : ""}.` }] };
      const output = { ...pagination, offset, groups: groups.map(g => ({ id: g.id, ...g.attributes })) };
      let text = response_format === ResponseFormat.MARKDOWN
        ? `# Groups (${pagination.count} of ${pagination.total})\n\n` + groups.map(g => {
            const a = g.attributes;
            return [`### ${a.name ?? "Unnamed Group"} (ID: ${g.id})`, a.description ? `> ${a.description}` : "", a.schedule ? `- **Schedule**: ${a.schedule}` : "", a.location ? `- **Location**: ${a.location}` : "", typeof a.members_count === "number" ? `- **Members**: ${a.members_count}` : ""].filter(Boolean).join("\n");
          }).join("\n\n") + (pagination.has_more ? `\n\n_More results — use offset=${pagination.next_offset}_` : "")
        : JSON.stringify(output, null, 2);
      if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated.]";
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ── pc_list_checkins ────────────────────────────────────────────────────
  server.registerTool("pc_list_checkins", {
    title: "List Check-Ins",
    description: "List check-in attendance records from Planning Center Check-Ins. Filter by event_id for a specific service.",
    inputSchema: z.object({
      event_id: z.string().optional(),
      limit: limitSchema,
      offset: offsetSchema,
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ event_id, limit, offset, response_format }) => {
    try {
      const basePath = event_id ? `/check-ins/v2/events/${event_id}/check_ins` : "/check-ins/v2/check_ins";
      const resp = await pcoGet<PcoResource>(basePath, { ...paginationParams(limit, offset), order: "-created_at" });
      const checkIns = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
      const pagination = extractPagination(resp, offset);
      if (!checkIns.length) return { content: [{ type: "text", text: "No check-ins found." }] };
      const output = { ...pagination, offset, check_ins: checkIns.map(c => ({ id: c.id, ...c.attributes })) };
      let text = response_format === ResponseFormat.MARKDOWN
        ? `# Check-Ins (${pagination.count} of ${pagination.total})\n\n` + checkIns.map(c => {
            const a = c.attributes;
            const name = `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unknown";
            const time = a.created_at ? new Date(a.created_at as string).toLocaleString() : "Unknown time";
            return `- **${name}** — ${a.kind ?? "regular"} — ${time}`;
          }).join("\n") + (pagination.has_more ? `\n\n_More results — use offset=${pagination.next_offset}_` : "")
        : JSON.stringify(output, null, 2);
      if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated.]";
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  // ── pc_list_donations ───────────────────────────────────────────────────
  server.registerTool("pc_list_donations", {
    title: "List Donation Records",
    description: "List giving/donation records from Planning Center Giving, sorted most-recent first.",
    inputSchema: z.object({
      limit: limitSchema,
      offset: offsetSchema,
      response_format: responseFormatSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, offset, response_format }) => {
    try {
      const resp = await pcoGet<PcoResource>("/giving/v2/donations", { ...paginationParams(limit, offset), order: "-received_at" });
      const donations = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
      const pagination = extractPagination(resp, offset);
      if (!donations.length) return { content: [{ type: "text", text: "No donation records found." }] };
      const output = { ...pagination, offset, donations: donations.map(d => ({ id: d.id, ...d.attributes })) };
      let text = response_format === ResponseFormat.MARKDOWN
        ? `# Donations (${pagination.count} of ${pagination.total})\n\n` + donations.map(d => {
            const a = d.attributes;
            const cents = a.amount_cents as number | undefined;
            const currency = (a.amount_currency as string | undefined) ?? "AUD";
            const amount = cents != null ? new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100) : "Unknown";
            const date = a.received_at ? new Date(a.received_at as string).toLocaleDateString() : "Unknown date";
            return `- ${amount} via ${a.payment_method ?? "unknown"} — ${date}${a.refunded ? " _(refunded)_" : ""}`;
          }).join("\n") + (pagination.has_more ? `\n\n_More results — use offset=${pagination.next_offset}_` : "")
        : JSON.stringify(output, null, 2);
      if (text.length > CHARACTER_LIMIT) text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Truncated.]";
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) { return { content: [{ type: "text", text: handlePcoError(e) }] }; }
  });

  return server;
}

// ── Vercel handler ───────────────────────────────────────────────────────────

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
