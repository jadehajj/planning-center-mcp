/**
 * Planning Center — write operations.
 *
 * Carefully scoped to safe, reversible, high-value writes. Destructive operations
 * (delete person, delete list, etc.) are intentionally NOT included.
 *
 * Wraps:
 *   PATCH /people/v2/people/:id                         (update profile basics)
 *   POST  /people/v2/people/:id/notes                   (add a pastoral note)
 *   POST  /people/v2/workflows/:id/cards                (add person to workflow)
 *   PATCH /people/v2/workflows/:wid/cards/:cid          (move card / mark complete)
 *   POST  /people/v2/lists/:id/list_results             (add person to a static list)
 *   DELETE /people/v2/lists/:id/list_results/:rid       (remove person from a static list)
 *   POST  /groups/v2/events/:id/attendances             (mark attendance for group event)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormat } from "../constants.js";
import { responseFormatSchema } from "../schemas.js";
import {
  pcoPost,
  pcoPatch,
  pcoDelete,
  handlePcoError,
  PcoResource,
} from "../services/pco-client.js";

export function registerWriteTools(server: McpServer): void {
  // ─── pc_update_person ────────────────────────────────────────────────────
  server.registerTool(
    "pc_update_person",
    {
      title: "Update Person Profile",
      description: `Update basic profile fields for a person. Only the fields you provide will be changed.

Supported fields: first_name, last_name, nickname, gender, birthdate, anniversary, status, membership, medical_notes.

Note: emails, phone numbers, and addresses are separate resources and are not updated by this tool.

Args:
  - person_id (string): The PCO person ID
  - first_name (string, optional)
  - last_name (string, optional)
  - nickname (string, optional)
  - gender (string, optional): 'Male', 'Female', or null
  - birthdate (string, optional): YYYY-MM-DD
  - anniversary (string, optional): YYYY-MM-DD
  - status (string, optional): 'active' or 'inactive'
  - membership (string, optional): The membership type label
  - medical_notes (string, optional)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns the updated person record.`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("PCO person ID"),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        nickname: z.string().optional(),
        gender: z.string().optional(),
        birthdate: z.string().optional().describe("YYYY-MM-DD"),
        anniversary: z.string().optional().describe("YYYY-MM-DD"),
        status: z.enum(["active", "inactive"]).optional(),
        membership: z.string().optional(),
        medical_notes: z.string().optional(),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ person_id, response_format, ...attributes }) => {
      try {
        // Drop undefined keys so we only PATCH the fields the user supplied.
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(attributes)) if (v !== undefined) cleaned[k] = v;

        if (Object.keys(cleaned).length === 0) {
          return { content: [{ type: "text", text: "Error: No fields provided to update." }] };
        }

        const resp = await pcoPatch<PcoResource>(`/people/v2/people/${person_id}`, {
          data: { type: "Person", id: person_id, attributes: cleaned },
        });
        const person = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: person.id, ...person.attributes }, null, 2)
          : `✅ Updated person ${person_id}.\n\nFields changed: ${Object.keys(cleaned).join(", ")}`;

        return { content: [{ type: "text", text }], structuredContent: { id: person.id, ...person.attributes } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_add_person_note ──────────────────────────────────────────────────
  server.registerTool(
    "pc_add_person_note",
    {
      title: "Add a Note to a Person Profile",
      description: `Create a pastoral note on someone's profile. Useful for logging conversations, prayer requests, or follow-up reminders.

Args:
  - person_id (string): The PCO person ID
  - note_category_id (string): The note category ID (find via the API or web UI — required by PCO)
  - body (string): The note text (markdown supported in PCO web UI)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("PCO person ID"),
        note_category_id: z.string().min(1).describe("Note category ID"),
        body: z.string().min(1).describe("Note body text"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ person_id, note_category_id, body, response_format }) => {
      try {
        const resp = await pcoPost<PcoResource>(`/people/v2/people/${person_id}/notes`, {
          data: {
            type: "Note",
            attributes: { note: body },
            relationships: {
              note_category: { data: { type: "NoteCategory", id: note_category_id } },
            },
          },
        });
        const note = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: note.id, ...note.attributes }, null, 2)
          : `✅ Added note to person ${person_id} (note ID: ${note.id}).`;

        return { content: [{ type: "text", text }], structuredContent: { id: note.id, ...note.attributes } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_add_person_to_workflow ───────────────────────────────────────────
  server.registerTool(
    "pc_add_person_to_workflow",
    {
      title: "Add a Person to a Workflow",
      description: `Add a person to a workflow as a new card (e.g. add a new visitor to your follow-up workflow).

Args:
  - workflow_id (string): The workflow ID
  - person_id (string): The PCO person ID to add
  - assignee_id (string, optional): The PCO person ID of who should action this card
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        workflow_id: z.string().min(1).describe("Workflow ID"),
        person_id: z.string().min(1).describe("Person to add to the workflow"),
        assignee_id: z.string().optional().describe("Person responsible for the card"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflow_id, person_id, assignee_id, response_format }) => {
      try {
        const relationships: Record<string, unknown> = {
          person: { data: { type: "Person", id: person_id } },
        };
        if (assignee_id) {
          relationships.assignee = { data: { type: "Person", id: assignee_id } };
        }

        const resp = await pcoPost<PcoResource>(`/people/v2/workflows/${workflow_id}/cards`, {
          data: { type: "WorkflowCard", attributes: {}, relationships },
        });
        const card = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: card.id, ...card.attributes }, null, 2)
          : `✅ Added person ${person_id} to workflow ${workflow_id} (card ID: ${card.id}).`;

        return { content: [{ type: "text", text }], structuredContent: { id: card.id, ...card.attributes } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_complete_workflow_card ───────────────────────────────────────────
  server.registerTool(
    "pc_complete_workflow_card",
    {
      title: "Mark a Workflow Card Complete",
      description: `Mark a workflow card as completed (i.e. they finished the pipeline).

Args:
  - workflow_id (string): The workflow ID
  - card_id (string): The card ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        workflow_id: z.string().min(1).describe("Workflow ID"),
        card_id: z.string().min(1).describe("Card ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workflow_id, card_id, response_format }) => {
      try {
        // PCO uses POST /go to advance/complete a card, or PATCH the card directly.
        // Safest portable approach: POST to the dedicated complete action.
        const resp = await pcoPost<PcoResource>(
          `/people/v2/workflows/${workflow_id}/cards/${card_id}/go`,
          {}
        );
        const card = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource | undefined;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(card ? { id: card.id, ...card.attributes } : { ok: true }, null, 2)
          : `✅ Advanced/completed card ${card_id} in workflow ${workflow_id}.`;

        return { content: [{ type: "text", text }], structuredContent: card ? { id: card.id, ...card.attributes } : { ok: true } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_add_person_to_list ───────────────────────────────────────────────
  server.registerTool(
    "pc_add_person_to_list",
    {
      title: "Add a Person to a Static List",
      description: `Manually add a person to a list. NOTE: This only works on STATIC lists (not auto-refresh rule-based lists). For rule-based lists, modify the rules instead.

Args:
  - list_id (string): The list ID
  - person_id (string): The PCO person ID to add
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        list_id: z.string().min(1).describe("List ID"),
        person_id: z.string().min(1).describe("Person to add"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ list_id, person_id, response_format }) => {
      try {
        const resp = await pcoPost<PcoResource>(`/people/v2/lists/${list_id}/list_results`, {
          data: {
            type: "ListResult",
            relationships: {
              person: { data: { type: "Person", id: person_id } },
            },
          },
        });
        const result = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: result.id, ...result.attributes }, null, 2)
          : `✅ Added person ${person_id} to list ${list_id} (entry ID: ${result.id}).\n\n_Note: this only works for static lists, not rule-based auto-refresh lists._`;

        return { content: [{ type: "text", text }], structuredContent: { id: result.id, ...result.attributes } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_remove_person_from_list ──────────────────────────────────────────
  server.registerTool(
    "pc_remove_person_from_list",
    {
      title: "Remove a Person from a Static List",
      description: `Remove a person from a list. Like add_person_to_list, this only affects STATIC lists.

Args:
  - list_id (string): The list ID
  - list_result_id (string): The ListResult ID (NOT the person ID — find via pc_list_people_on_list, look at the entry ID)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        list_id: z.string().min(1).describe("List ID"),
        list_result_id: z.string().min(1).describe("ListResult entry ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ list_id, list_result_id, response_format }) => {
      try {
        await pcoDelete(`/people/v2/lists/${list_id}/list_results/${list_result_id}`);

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ ok: true, list_id, list_result_id }, null, 2)
          : `✅ Removed entry ${list_result_id} from list ${list_id}.`;

        return { content: [{ type: "text", text }], structuredContent: { ok: true, list_id, list_result_id } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_mark_group_attendance ────────────────────────────────────────────
  server.registerTool(
    "pc_mark_group_attendance",
    {
      title: "Mark Group Event Attendance",
      description: `Record whether someone attended a specific group event.

Args:
  - event_id (string): The group event ID (find via pc_list_group_events)
  - person_id (string): The PCO person ID
  - attended (boolean): Did they attend?
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
      inputSchema: z.object({
        event_id: z.string().min(1).describe("Group event ID"),
        person_id: z.string().min(1).describe("PCO person ID"),
        attended: z.boolean().describe("Did they attend?"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_id, person_id, attended, response_format }) => {
      try {
        const resp = await pcoPost<PcoResource>(`/groups/v2/events/${event_id}/attendances`, {
          data: {
            type: "Attendance",
            attributes: { attended },
            relationships: {
              person: { data: { type: "Person", id: person_id } },
            },
          },
        });
        const att = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;

        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: att.id, ...att.attributes }, null, 2)
          : `✅ Marked person ${person_id} as ${attended ? "present" : "absent"} for event ${event_id}.`;

        return { content: [{ type: "text", text }], structuredContent: { id: att.id, ...att.attributes } };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
