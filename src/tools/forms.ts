/**
 * Planning Center People — Forms tools.
 *
 * Wraps:
 *   GET /people/v2/forms
 *   GET /people/v2/forms/:id
 *   GET /people/v2/forms/:id/form_submissions
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

interface FormAttributes {
  name?: string;
  description?: string;
  active?: boolean;
  archived?: boolean;
  send_submission_notification_to_submitter?: boolean;
  submission_count?: number;
  public_url?: string;
  recently_viewed?: boolean;
  archived_at?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface FormSubmissionAttributes {
  verified?: boolean;
  requires_verification?: boolean;
  created_at?: string;
}

interface PersonRef {
  data?: { id?: string };
}

function formatForm(f: PcoResource): string {
  const a = f.attributes as FormAttributes;
  const lines: string[] = [`### ${a.name ?? "(unnamed form)"} (ID: ${f.id})`];
  if (a.submission_count !== undefined) lines.push(`- **Submissions**: ${a.submission_count}`);
  if (a.active !== undefined) lines.push(`- **Active**: ${a.active ? "yes" : "no"}`);
  if (a.archived) lines.push(`- ⚠️ **Archived**`);
  if (a.public_url) lines.push(`- **URL**: ${a.public_url}`);
  if (a.description) lines.push(`- **Description**: ${a.description}`);
  return lines.join("\n");
}

export function registerFormsTools(server: McpServer): void {
  // ─── pc_list_forms ────────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_forms",
    {
      title: "List Forms",
      description: `List forms (e.g. connect cards, signups, registration forms) in Planning Center People.

Args:
  - search_name (string, optional): Filter by partial form name match
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: form IDs, names, submission counts, active status, public URLs.

Examples:
  - "List all our forms" → no params
  - "Find the connect card form" → search_name="connect"`,
      inputSchema: z.object({
        search_name: z.string().optional().describe("Partial form name to search for"),
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

        const resp = await pcoGet<PcoResource>("/people/v2/forms", params);
        const forms = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!forms.length) {
          return { content: [{ type: "text", text: search_name ? `No forms found matching "${search_name}".` : "No forms found." }] };
        }

        const output = {
          ...pagination,
          offset,
          forms: forms.map((f) => {
            const a = f.attributes as FormAttributes;
            return {
              id: f.id,
              name: a.name ?? null,
              submission_count: a.submission_count ?? null,
              active: a.active ?? null,
              archived: a.archived ?? null,
              public_url: a.public_url ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Forms (${pagination.count} of ${pagination.total})${search_name ? ` matching "${search_name}"` : ""}`;
          text = [header, "", ...forms.map(formatForm)].join("\n\n");
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

  // ─── pc_list_form_submissions ────────────────────────────────────────────
  server.registerTool(
    "pc_list_form_submissions",
    {
      title: "List Form Submissions",
      description: `List submissions for a specific form. Use this to see who has filled out a connect card, signup, or registration form.

Args:
  - form_id (string): The form ID (find via pc_list_forms)
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: submission ID, person ID (if linked), verified flag, timestamps.

Examples:
  - "Show submissions for form 12345" → form_id="12345"`,
      inputSchema: z.object({
        form_id: z.string().min(1).describe("Planning Center form ID"),
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
    async ({ form_id, limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = {
          ...paginationParams(limit, offset),
          include: "person",
        };
        const resp = (await pcoGet<PcoResource>(`/people/v2/forms/${form_id}/form_submissions`, params)) as PcoResponse<PcoResource> & { included?: PcoResource[] };
        const subs = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const included = (resp.included ?? []) as PcoResource[];
        const peopleById = new Map(included.filter((r) => r.type === "Person").map((p) => [p.id, p]));
        const pagination = extractPagination(resp, limit, offset);

        if (!subs.length) {
          return { content: [{ type: "text", text: `No submissions for form ${form_id}.` }] };
        }

        const output = {
          ...pagination,
          offset,
          form_id,
          submissions: subs.map((s) => {
            const sa = s.attributes as FormSubmissionAttributes;
            const personId = (s.relationships?.person as PersonRef | undefined)?.data?.id;
            const person = personId ? peopleById.get(personId) : undefined;
            return {
              id: s.id,
              person_id: personId ?? null,
              person_name: person ? (person.attributes as { name?: string }).name ?? null : null,
              verified: sa.verified ?? null,
              requires_verification: sa.requires_verification ?? null,
              created_at: sa.created_at ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Form ${form_id} — submissions (${pagination.count} of ${pagination.total})`;
          const rows = output.submissions.map((s) => {
            const verified = s.verified === true ? " ✓" : s.verified === false ? " ⚠️ unverified" : "";
            return `- **${s.person_name ?? `(no linked person)`}** — ${s.created_at ?? "?"}${verified} (submission: ${s.id})`;
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

  // ─── pc_list_field_definitions ───────────────────────────────────────────
  server.registerTool(
    "pc_list_field_definitions",
    {
      title: "List Custom Field Definitions",
      description: `List custom field definitions in Planning Center People. These are the custom fields you've set up on profiles (e.g. "Baptism Date", "Heritage Language", "Small Group").

Useful for understanding what custom data is available before querying it on individual profiles.

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: field definition ID, name, data type, slug, deleted_at.

Examples:
  - "What custom fields do we have on profiles?" → no params`,
      inputSchema: z.object({
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
    async ({ limit, offset, response_format }) => {
      try {
        const params: Record<string, unknown> = { ...paginationParams(limit, offset) };
        const resp = await pcoGet<PcoResource>("/people/v2/field_definitions", params);
        const defs = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!defs.length) {
          return { content: [{ type: "text", text: "No field definitions found." }] };
        }

        interface FieldDefAttrs {
          name?: string;
          slug?: string;
          data_type?: string;
          deleted_at?: string | null;
          tab_id?: string;
        }

        const output = {
          ...pagination,
          offset,
          field_definitions: defs.map((d) => {
            const a = d.attributes as FieldDefAttrs;
            return {
              id: d.id,
              name: a.name ?? null,
              slug: a.slug ?? null,
              data_type: a.data_type ?? null,
              deleted: !!a.deleted_at,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Custom field definitions (${pagination.count} of ${pagination.total})`;
          const rows = output.field_definitions.map((d) => `- **${d.name ?? "(unnamed)"}** (ID: ${d.id})${d.data_type ? ` — ${d.data_type}` : ""}${d.deleted ? " ⚠️ deleted" : ""}`);
          text = [header, "", ...rows].join("\n");
          if (pagination.has_more) text += `\n\n_More results available. Use offset=${pagination.next_offset} for the next page._`;
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
