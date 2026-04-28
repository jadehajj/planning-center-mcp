/**
 * Planning Center People — Lists tools.
 *
 * Wraps:
 *   GET /people/v2/lists
 *   GET /people/v2/lists/:id              (with ?include=rules,rules.conditions)
 *   GET /people/v2/lists/:id/people
 *
 * Crucially, fetching a list with `include=rules,rules.conditions` reveals:
 *   - The `auto_refresh` and `status` flags
 *   - The list's rules and conditions
 *   - The `subset` attribute, which is "all", "active", or "inactive"
 *     and explains why a list may include/exclude inactive profiles
 *     regardless of what the rules themselves say.
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface ListAttributes {
  name?: string;
  description?: string;
  auto_refresh?: boolean;
  status?: string;
  subset?: string;
  return_original_if_none?: boolean;
  total_people?: number;
  batch_completed_at?: string | null;
  starts_at?: string | null;
  recently_viewed?: boolean;
  refreshed_at?: string | null;
  has_inactive_results?: boolean;
  include_inactive?: boolean;
  invalid?: boolean;
  name_or_description?: string;
  recently_viewed_at?: string | null;
  paused?: boolean;
  automations_active?: boolean;
  automations_count?: number;
  paused_automations_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface RuleAttributes {
  subset?: string; // "any" or "all"
  created_at?: string;
  updated_at?: string;
}

interface ConditionAttributes {
  application?: string;
  definition_class?: string;
  comparison?: string;
  settings?: string;
  definition_identifier?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

interface PersonAttributes {
  name?: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  membership?: string;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatListSummary(l: PcoResource): string {
  const a = l.attributes as ListAttributes;
  const parts: string[] = [`### ${a.name ?? "(unnamed list)"} (ID: ${l.id})`];
  if (a.total_people !== undefined) parts.push(`- **Total people**: ${a.total_people}`);
  if (a.subset) parts.push(`- **Subset**: ${a.subset}`);
  if (a.status) parts.push(`- **Status**: ${a.status}`);
  if (a.auto_refresh !== undefined) parts.push(`- **Auto-refresh**: ${a.auto_refresh ? "yes" : "no"}`);
  if (a.refreshed_at) parts.push(`- **Last refreshed**: ${a.refreshed_at}`);
  if (a.description) parts.push(`- **Description**: ${a.description}`);
  return parts.join("\n");
}

function formatListDetail(
  list: PcoResource,
  rules: PcoResource[],
  conditions: PcoResource[]
): string {
  const a = list.attributes as ListAttributes;
  const lines: string[] = [];

  lines.push(`# ${a.name ?? "(unnamed list)"} (ID: ${list.id})`);
  lines.push("");
  if (a.description) {
    lines.push(`> ${a.description}`);
    lines.push("");
  }

  lines.push("## List configuration");
  if (a.total_people !== undefined) lines.push(`- **Total people**: ${a.total_people}`);
  if (a.subset) lines.push(`- **Subset (active/inactive scope)**: \`${a.subset}\``);
  if (a.include_inactive !== undefined) lines.push(`- **Include inactive**: ${a.include_inactive ? "yes" : "no"}`);
  if (a.has_inactive_results !== undefined) lines.push(`- **Has inactive results**: ${a.has_inactive_results ? "yes" : "no"}`);
  if (a.status) lines.push(`- **Status**: ${a.status}`);
  if (a.auto_refresh !== undefined) lines.push(`- **Auto-refresh**: ${a.auto_refresh ? "yes" : "no"}`);
  if (a.return_original_if_none !== undefined) lines.push(`- **Return original if none**: ${a.return_original_if_none ? "yes" : "no"}`);
  if (a.invalid !== undefined && a.invalid) lines.push(`- ⚠️ **Invalid**: yes`);
  if (a.refreshed_at) lines.push(`- **Last refreshed**: ${a.refreshed_at}`);
  if (a.batch_completed_at) lines.push(`- **Batch completed**: ${a.batch_completed_at}`);
  if (a.created_at) lines.push(`- **Created**: ${a.created_at}`);
  if (a.updated_at) lines.push(`- **Updated**: ${a.updated_at}`);
  lines.push("");

  if (rules.length === 0) {
    lines.push("## Rules");
    lines.push("_No rules attached. (Try refetching with include=rules,rules.conditions if this seems wrong.)_");
    return lines.join("\n");
  }

  lines.push(`## Rules (${rules.length})`);
  lines.push("");

  // Group conditions by parent rule via the JSON:API relationships block.
  const conditionsByRuleId = new Map<string, PcoResource[]>();
  for (const c of conditions) {
    const rel = (c.relationships ?? {}) as Record<string, { data?: { id?: string } }>;
    const ruleId = rel?.rule?.data?.id;
    if (!ruleId) continue;
    if (!conditionsByRuleId.has(ruleId)) conditionsByRuleId.set(ruleId, []);
    conditionsByRuleId.get(ruleId)!.push(c);
  }

  rules.forEach((rule, idx) => {
    const ra = rule.attributes as RuleAttributes;
    const matchType = ra.subset === "all" ? "ALL (AND)" : ra.subset === "any" ? "ANY (OR)" : (ra.subset ?? "?");
    lines.push(`### Rule ${idx + 1} — match ${matchType}`);
    const ruleConditions = conditionsByRuleId.get(rule.id) ?? [];
    if (ruleConditions.length === 0) {
      lines.push("  _(no conditions)_");
    } else {
      ruleConditions.forEach((c, ci) => {
        const ca = c.attributes as ConditionAttributes;
        const desc = ca.description ?? "(no description)";
        const meta: string[] = [];
        if (ca.application) meta.push(ca.application);
        if (ca.definition_class) meta.push(ca.definition_class);
        if (ca.comparison) meta.push(`comparison: ${ca.comparison}`);
        const metaStr = meta.length ? ` _(${meta.join(" · ")})_` : "";
        lines.push(`  ${ci + 1}. ${desc}${metaStr}`);
      });
    }
    lines.push("");
  });

  // Diagnostic note — this is the whole reason this tool exists.
  if (a.subset && a.subset !== "active") {
    lines.push("---");
    lines.push(`⚠️  **Diagnostic note**: this list's \`subset\` is \`${a.subset}\`, which means inactive profiles ${a.subset === "inactive" ? "ONLY" : "may"} be included regardless of what individual rule conditions say. If you only want active profiles, set the list to \`subset: active\` (or add an explicit "Status is Active" condition).`);
  }

  return lines.join("\n");
}

// ─── Tool registration ─────────────────────────────────────────────────────

export function registerListsTools(server: McpServer): void {
  // ─── pc_list_lists ────────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_lists",
    {
      title: "List All People Lists",
      description: `List all lists in Planning Center People. Use this to find a list ID before calling pc_get_list or pc_list_people_on_list.

Args:
  - search_name (string, optional): Filter by partial list name match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: list IDs, names, total people counts, subset (active/inactive scope), auto-refresh status, and last refresh time.

Examples:
  - "Show me all our lists" → no params
  - "Find the visitor follow-up list" → search_name="visitor"`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial list name to search for"),
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

        const resp = await pcoGet<PcoResource>("/people/v2/lists", params);
        const lists = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!lists.length) {
          return {
            content: [
              { type: "text", text: search_name ? `No lists found matching "${search_name}".` : "No lists found." },
            ],
          };
        }

        const output = {
          ...pagination,
          offset,
          lists: lists.map((l) => {
            const a = l.attributes as ListAttributes;
            return {
              id: l.id,
              name: a.name ?? null,
              total_people: a.total_people ?? null,
              subset: a.subset ?? null,
              auto_refresh: a.auto_refresh ?? null,
              refreshed_at: a.refreshed_at ?? null,
              status: a.status ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Lists (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          text = [header, "", ...lists.map(formatListSummary)].join("\n\n");
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

  // ─── pc_get_list ──────────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_list",
    {
      title: "Get List Detail (with Rules & Conditions)",
      description: `Retrieve full configuration for a specific People List, INCLUDING its rules and conditions. This is the diagnostic tool for understanding why a list returns the counts it does.

The response surfaces critical fields that the PCO web UI obscures:
  - **subset** — controls whether the list operates over active, inactive, or all profiles. This is set at the list level, not in the rules.
  - **include_inactive** / **has_inactive_results** — flags that explain unexpected inactive profiles in results.
  - **rules** — each rule with its match type (any/all) and ordered conditions.
  - **conditions** — each condition's description, comparison operator, and application.

If a list's count seems wrong (e.g. NOT conditions returning more results than expected, or inactives showing up unexpectedly), check the 'subset' attribute first — it's almost always the culprit.

Args:
  - list_id (string): The list ID (find it via pc_list_lists, or from the URL: /lists/<list_id>)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Examples:
  - "Why is list 4875343 returning weird counts?" → list_id="4875343"`,
      inputSchema: z.object({
        list_id: z.string().min(1).describe("Planning Center list ID"),
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ list_id, response_format }) => {
      try {
        const resp = (await pcoGet<PcoResource>(`/people/v2/lists/${list_id}`, {
          include: "rules,rules.conditions",
        })) as PcoResponse<PcoResource> & { included?: PcoResource[] };

        const list = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const included = (resp.included ?? []) as PcoResource[];
        const rules = included.filter((r) => r.type === "Rule");
        const conditions = included.filter((r) => r.type === "Condition");

        const output = {
          id: list.id,
          attributes: list.attributes,
          rules: rules.map((r) => ({
            id: r.id,
            attributes: r.attributes,
            condition_ids: ((r.relationships?.conditions as { data?: Array<{ id: string }> } | undefined)?.data ?? []).map((c) => c.id),
          })),
          conditions: conditions.map((c) => ({
            id: c.id,
            rule_id: ((c.relationships?.rule as { data?: { id?: string } } | undefined)?.data ?? {}).id ?? null,
            attributes: c.attributes,
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = formatListDetail(list, rules, conditions);
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — switch to JSON format or paginate.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_list_people_on_list ──────────────────────────────────────────────
  server.registerTool(
    "pc_list_people_on_list",
    {
      title: "List People on a List",
      description: `Get the actual people currently on a specific List. Useful for verifying a list's results match expectations and for cross-checking counts.

Note: PCO returns whatever the list's last refresh produced. If the list isn't auto-refreshing, the results may be stale — check the 'refreshed_at' field via pc_get_list.

Args:
  - list_id (string): The list ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: id, name, status, and membership type for each person on the list.

Examples:
  - "Who's on list 4875343?" → list_id="4875343"
  - "Get the next 25" → list_id="4875343", offset=25`,
      inputSchema: z.object({
        list_id: z.string().min(1).describe("Planning Center list ID"),
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
    async ({ list_id, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        const resp = await pcoGet<PcoResource>(`/people/v2/lists/${list_id}/people`, params);
        const people = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!people.length) {
          return { content: [{ type: "text", text: `No people on list ${list_id}.` }] };
        }

        const output = {
          ...pagination,
          offset,
          list_id,
          people: people.map((p) => {
            const a = p.attributes as PersonAttributes;
            return {
              id: p.id,
              name: a.name ?? `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
              status: a.status ?? null,
              membership: a.membership ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# People on list ${list_id} (${pagination.count} of ${pagination.total})`;
          const rows = output.people.map((p) => `- **${p.name}** (ID: ${p.id})${p.status ? ` — ${p.status}` : ""}${p.membership ? ` — ${p.membership}` : ""}`);
          text = [header, "", ...rows].join("\n");
          if (pagination.has_more) text += `\n\n_More results available. Use offset=${pagination.next_offset} for the next page._`;
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use a smaller limit or paginate.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
