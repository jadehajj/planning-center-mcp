/**
 * Planning Center People — Workflows tools.
 *
 * Workflows are PCO's way of tracking pastoral pipelines (new visitor follow-up,
 * baptism prep, etc.) Cards represent individual people in a workflow.
 *
 * Wraps:
 *   GET /people/v2/workflows
 *   GET /people/v2/workflows/:id
 *   GET /people/v2/workflows/:id/cards
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

interface WorkflowAttributes {
  name?: string;
  my_ready_card_count?: number;
  total_ready_card_count?: number;
  completed_card_count?: number;
  total_cards_count?: number;
  total_ready_and_snoozed_card_count?: number;
  total_steps_count?: number;
  total_unassigned_steps_count?: number;
  total_unassigned_card_count?: number;
  total_overdue_card_count?: number;
  my_overdue_card_count?: number;
  my_due_soon_card_count?: number;
  recently_viewed?: boolean;
  campus_id?: string | null;
  workflow_category_id?: string | null;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  deleted_at?: string | null;
}

interface CardAttributes {
  snooze_until?: string | null;
  overdue?: boolean;
  stage?: string;
  calculated_due_at_in_days_ago?: number | null;
  sticky_assignment?: boolean;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  flagged_for_notification_at?: string | null;
  removed_at?: string | null;
  moved_to_step_at?: string | null;
}

interface PersonRel {
  data?: { id?: string };
}

function formatWorkflow(w: PcoResource): string {
  const a = w.attributes as WorkflowAttributes;
  const lines: string[] = [`### ${a.name ?? "(unnamed workflow)"} (ID: ${w.id})`];
  if (a.total_cards_count !== undefined) lines.push(`- **Total cards**: ${a.total_cards_count}`);
  if (a.total_ready_card_count !== undefined) lines.push(`- **Ready**: ${a.total_ready_card_count}`);
  if (a.total_overdue_card_count !== undefined && a.total_overdue_card_count > 0) lines.push(`- **Overdue**: ${a.total_overdue_card_count}`);
  if (a.completed_card_count !== undefined) lines.push(`- **Completed**: ${a.completed_card_count}`);
  if (a.archived_at) lines.push(`- ⚠️ **Archived**: ${a.archived_at}`);
  return lines.join("\n");
}

export function registerWorkflowsTools(server: McpServer): void {
  // ─── pc_list_workflows ────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_workflows",
    {
      title: "List Workflows",
      description: `List pastoral workflows in Planning Center People (e.g. new visitor follow-up, baptism prep, new member assimilation).

Args:
  - search_name (string, optional): Filter by partial workflow name match
  - include_archived (boolean): Include archived workflows (default: false)
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: workflow IDs, names, total/ready/overdue/completed card counts.

Examples:
  - "List our active workflows" → no params
  - "Show all workflows including archived" → include_archived=true`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial workflow name to search for"),
        include_archived: z.boolean().optional().default(false).describe("Include archived workflows"),
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
    async ({ search_name, include_archived, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        if (search_name) params["where[name]"] = search_name;
        if (!include_archived) params["filter"] = "not_archived";

        const resp = await pcoGet<PcoResource>("/people/v2/workflows", params);
        const workflows = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!workflows.length) {
          return { content: [{ type: "text", text: search_name ? `No workflows found matching "${search_name}".` : "No workflows found." }] };
        }

        const output = {
          ...pagination,
          offset,
          workflows: workflows.map((w) => {
            const a = w.attributes as WorkflowAttributes;
            return {
              id: w.id,
              name: a.name ?? null,
              total_cards: a.total_cards_count ?? null,
              ready_cards: a.total_ready_card_count ?? null,
              overdue_cards: a.total_overdue_card_count ?? null,
              completed_cards: a.completed_card_count ?? null,
              archived: !!a.archived_at,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Workflows (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          text = [header, "", ...workflows.map(formatWorkflow)].join("\n\n");
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

  // ─── pc_get_workflow ──────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_workflow",
    {
      title: "Get Workflow Detail",
      description: `Retrieve a specific workflow with its full set of metrics.

Args:
  - workflow_id (string): The workflow ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Examples:
  - "Show me workflow 12345" → workflow_id="12345"`,
      inputSchema: z.object({
        workflow_id: z.string().min(1).describe("Planning Center workflow ID"),
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workflow_id, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/people/v2/workflows/${workflow_id}`);
        const w = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const a = w.attributes as WorkflowAttributes;
        const output = { id: w.id, ...a };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = formatWorkflow(w);
        } else {
          text = JSON.stringify(output, null, 2);
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_list_workflow_cards ──────────────────────────────────────────────
  server.registerTool(
    "pc_list_workflow_cards",
    {
      title: "List Workflow Cards",
      description: `List cards (people in the pipeline) for a specific workflow.

Args:
  - workflow_id (string): The workflow ID
  - stage (string, optional): Filter by stage — 'ready', 'snoozed', 'overdue', 'all'
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: card ID, person ID, stage, overdue flag, snooze status, timestamps.

Examples:
  - "Who's overdue in workflow 12345?" → workflow_id="12345", stage="overdue"`,
      inputSchema: z.object({
        workflow_id: z.string().min(1).describe("Planning Center workflow ID"),
        stage: z.enum(["ready", "snoozed", "overdue", "all"]).optional().describe("Filter cards by stage"),
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
    async ({ workflow_id, stage, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = {
          ...paginationParams(limit, offset),
          include: "person",
        };
        if (stage && stage !== "all") params["where[stage]"] = stage;

        const resp = (await pcoGet<PcoResource>(`/people/v2/workflows/${workflow_id}/cards`, params)) as PcoResponse<PcoResource> & { included?: PcoResource[] };
        const cards = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const included = (resp.included ?? []) as PcoResource[];
        const peopleById = new Map(included.filter((r) => r.type === "Person").map((p) => [p.id, p]));
        const pagination = extractPagination(resp, limit, offset);

        if (!cards.length) {
          return { content: [{ type: "text", text: `No cards in workflow ${workflow_id}${stage && stage !== "all" ? ` (stage: ${stage})` : ""}.` }] };
        }

        const output = {
          ...pagination,
          offset,
          workflow_id,
          cards: cards.map((c) => {
            const ca = c.attributes as CardAttributes;
            const personRel = (c.relationships?.person as PersonRel | undefined)?.data?.id;
            const person = personRel ? peopleById.get(personRel) : undefined;
            const personName = person ? (person.attributes as { name?: string }).name ?? null : null;
            return {
              card_id: c.id,
              person_id: personRel ?? null,
              person_name: personName,
              stage: ca.stage ?? null,
              overdue: ca.overdue ?? null,
              snooze_until: ca.snooze_until ?? null,
              calculated_due_at_in_days_ago: ca.calculated_due_at_in_days_ago ?? null,
              completed_at: ca.completed_at ?? null,
              moved_to_step_at: ca.moved_to_step_at ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Workflow ${workflow_id} — cards (${pagination.count} of ${pagination.total})${stage && stage !== "all" ? ` (stage: ${stage})` : ""}`;
          const rows = output.cards.map((c) => {
            const flag = c.overdue ? " ⚠️ overdue" : "";
            const due = c.calculated_due_at_in_days_ago != null ? ` — ${c.calculated_due_at_in_days_ago}d ago` : "";
            return `- **${c.person_name ?? `Person ${c.person_id}`}** (card: ${c.card_id})${c.stage ? ` — ${c.stage}` : ""}${flag}${due}`;
          });
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
