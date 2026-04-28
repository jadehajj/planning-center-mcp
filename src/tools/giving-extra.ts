/**
 * Planning Center Giving — expanded tools.
 *
 * Wraps:
 *   GET /giving/v2/funds
 *   GET /giving/v2/batches
 *   GET /giving/v2/pledge_campaigns
 *   GET /giving/v2/pledge_campaigns/:id/pledges
 *   GET /giving/v2/donations/:id
 *   GET /giving/v2/people/:person_id/donations
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

interface FundAttributes {
  name?: string;
  description?: string;
  code?: string;
  visibility?: string;
  default?: boolean;
  color?: string;
  deletable?: boolean;
  ledger_code?: string;
  created_at?: string;
  updated_at?: string;
}

interface BatchAttributes {
  description?: string;
  total_cents?: number;
  total_currency?: string;
  donations_count?: number;
  status?: string;
  committed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PledgeCampaignAttributes {
  name?: string;
  description?: string;
  starts_at?: string;
  ends_at?: string;
  goal_cents?: number;
  goal_currency?: string;
  show_goal_in_church_center?: boolean;
  received_total_from_pledges_cents?: number;
  received_total_outside_of_pledges_cents?: number;
  total_pledges_cents?: number;
  pledges_count?: number;
}

interface PledgeAttributes {
  amount_cents?: number;
  amount_currency?: string;
  donated_total_cents?: number;
  joint_giver_amount_cents?: number;
  created_at?: string;
  updated_at?: string;
}

interface DonationAttributes {
  amount_cents?: number;
  amount_currency?: string;
  payment_status?: string;
  payment_method?: string;
  payment_method_sub?: string;
  payment_last4?: string;
  payment_brand?: string;
  payment_check_number?: number;
  payment_check_dated_at?: string | null;
  fee_cents?: number;
  payment_id?: string;
  received_at?: string;
  refunded?: boolean;
  refund_amount_cents?: number;
  completed_at?: string | null;
  updated_at?: string;
  created_at?: string;
}

function formatCurrency(cents: number, currency = "AUD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

export function registerGivingExtraTools(server: McpServer): void {
  // ─── pc_list_funds ───────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_funds",
    {
      title: "List Giving Funds",
      description: `List all giving funds (e.g. General Tithe, Building, Missions, Benevolence).

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: fund ID, name, code, visibility, ledger code, default flag.`,
      inputSchema: z.object({
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>("/giving/v2/funds", { ...paginationParams(limit, offset) });
        const funds = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!funds.length) return { content: [{ type: "text", text: "No funds found." }] };

        const output = {
          ...pagination,
          offset,
          funds: funds.map((f) => {
            const a = f.attributes as FundAttributes;
            return {
              id: f.id,
              name: a.name ?? null,
              code: a.code ?? null,
              ledger_code: a.ledger_code ?? null,
              visibility: a.visibility ?? null,
              default: a.default ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Giving Funds (${pagination.count} of ${pagination.total})`;
          const rows = output.funds.map((f) => `- **${f.name ?? "(unnamed)"}** (ID: ${f.id})${f.code ? ` [${f.code}]` : ""}${f.default ? " — default" : ""}${f.visibility ? ` — ${f.visibility}` : ""}`);
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

  // ─── pc_list_batches ─────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_batches",
    {
      title: "List Donation Batches",
      description: `List donation batches (e.g. weekly offering counts) in Planning Center Giving.

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: batch description, status (in_progress/committed), total amount, donations count, committed timestamp.`,
      inputSchema: z.object({
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>("/giving/v2/batches", { ...paginationParams(limit, offset), order: "-created_at" });
        const batches = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!batches.length) return { content: [{ type: "text", text: "No batches found." }] };

        const output = {
          ...pagination,
          offset,
          batches: batches.map((b) => {
            const a = b.attributes as BatchAttributes;
            return {
              id: b.id,
              description: a.description ?? null,
              status: a.status ?? null,
              total_cents: a.total_cents ?? null,
              currency: a.total_currency ?? null,
              donations_count: a.donations_count ?? null,
              committed_at: a.committed_at ?? null,
              created_at: a.created_at ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Batches (${pagination.count} of ${pagination.total})`;
          const rows = batches.map((b) => {
            const a = b.attributes as BatchAttributes;
            const total = a.total_cents != null ? formatCurrency(a.total_cents, a.total_currency) : "?";
            return `- **${a.description ?? "(no description)"}** (ID: ${b.id}) — ${total}${a.donations_count ? ` (${a.donations_count} donations)` : ""} — ${a.status ?? "?"}${a.committed_at ? ` — committed ${a.committed_at}` : ""}`;
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

  // ─── pc_list_pledge_campaigns ────────────────────────────────────────────
  server.registerTool(
    "pc_list_pledge_campaigns",
    {
      title: "List Pledge Campaigns",
      description: `List pledge campaigns (e.g. Building Fund Campaign, Missions Pledge Drive) and their progress towards goal.

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: campaign ID, name, dates, goal, total pledged, total received, pledges count.`,
      inputSchema: z.object({
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>("/giving/v2/pledge_campaigns", { ...paginationParams(limit, offset) });
        const camps = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!camps.length) return { content: [{ type: "text", text: "No pledge campaigns found." }] };

        const output = {
          ...pagination,
          offset,
          pledge_campaigns: camps.map((c) => ({ id: c.id, ...(c.attributes as PledgeCampaignAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Pledge Campaigns (${pagination.count} of ${pagination.total})`;
          const rows = camps.map((c) => {
            const a = c.attributes as PledgeCampaignAttributes;
            const goal = a.goal_cents != null ? formatCurrency(a.goal_cents, a.goal_currency) : "?";
            const received = a.received_total_from_pledges_cents != null ? formatCurrency(a.received_total_from_pledges_cents, a.goal_currency) : "?";
            const pledged = a.total_pledges_cents != null ? formatCurrency(a.total_pledges_cents, a.goal_currency) : "?";
            return `- **${a.name ?? "(unnamed)"}** (ID: ${c.id}) — goal ${goal}, pledged ${pledged}, received ${received} (${a.pledges_count ?? 0} pledges)`;
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

  // ─── pc_list_pledges ─────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_pledges",
    {
      title: "List Pledges for a Campaign",
      description: `List individual pledges within a campaign.

Args:
  - campaign_id (string): The pledge campaign ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: pledge ID, amount pledged, amount donated to date.`,
      inputSchema: z.object({
        campaign_id: z.string().min(1).describe("Pledge campaign ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ campaign_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/giving/v2/pledge_campaigns/${campaign_id}/pledges`, { ...paginationParams(limit, offset), include: "person" });
        const pledges = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!pledges.length) return { content: [{ type: "text", text: `No pledges in campaign ${campaign_id}.` }] };

        const output = {
          ...pagination,
          offset,
          campaign_id,
          pledges: pledges.map((p) => {
            const a = p.attributes as PledgeAttributes;
            return {
              id: p.id,
              amount_cents: a.amount_cents ?? null,
              currency: a.amount_currency ?? null,
              donated_total_cents: a.donated_total_cents ?? null,
            };
          }),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Pledges in campaign ${campaign_id} (${pagination.count} of ${pagination.total})`;
          const rows = pledges.map((p) => {
            const a = p.attributes as PledgeAttributes;
            const pledged = a.amount_cents != null ? formatCurrency(a.amount_cents, a.amount_currency) : "?";
            const donated = a.donated_total_cents != null ? formatCurrency(a.donated_total_cents, a.amount_currency) : "?";
            return `- Pledge ${p.id}: pledged ${pledged}, donated ${donated} to date`;
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

  // ─── pc_get_donation ─────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_donation",
    {
      title: "Get Donation Detail",
      description: `Retrieve a specific donation with full payment details and fund designations.

Args:
  - donation_id (string): The donation ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: amount, payment method, status, fee, fund designations, refund info.`,
      inputSchema: z.object({
        donation_id: z.string().min(1).describe("Donation ID"),
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ donation_id, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/giving/v2/donations/${donation_id}`, { include: "designations,person" });
        const donation = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as PcoResource;
        const a = donation.attributes as DonationAttributes;

        const output = { id: donation.id, ...a };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Donation ${donation.id}`];
          if (a.amount_cents != null) lines.push(`- **Amount**: ${formatCurrency(a.amount_cents, a.amount_currency)}`);
          if (a.fee_cents != null) lines.push(`- **Fee**: ${formatCurrency(a.fee_cents, a.amount_currency)}`);
          if (a.payment_method) lines.push(`- **Method**: ${a.payment_method}${a.payment_method_sub ? ` (${a.payment_method_sub})` : ""}`);
          if (a.payment_brand) lines.push(`- **Brand**: ${a.payment_brand}${a.payment_last4 ? ` ****${a.payment_last4}` : ""}`);
          if (a.payment_status) lines.push(`- **Status**: ${a.payment_status}`);
          if (a.received_at) lines.push(`- **Received**: ${a.received_at}`);
          if (a.completed_at) lines.push(`- **Completed**: ${a.completed_at}`);
          if (a.refunded) lines.push(`- ⚠️ **Refunded**${a.refund_amount_cents ? ` ${formatCurrency(a.refund_amount_cents, a.amount_currency)}` : ""}`);
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

  // ─── pc_list_person_donations ────────────────────────────────────────────
  server.registerTool(
    "pc_list_person_donations",
    {
      title: "List Donations by Person",
      description: `List all donations made by a specific person. Sensitive financial data — handle with appropriate care.

Args:
  - person_id (string): The PCO person ID
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: per-donation amount, method, status, date.`,
      inputSchema: z.object({
        person_id: z.string().min(1).describe("PCO person ID"),
        limit: limitSchema,
        offset: offsetSchema,
        response_format: responseFormatSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ person_id, limit, offset, response_format }) => {
      try {
        const resp = await pcoGet<PcoResource>(`/giving/v2/people/${person_id}/donations`, { ...paginationParams(limit, offset), order: "-received_at" });
        const donations = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!donations.length) return { content: [{ type: "text", text: `No donations recorded for person ${person_id}.` }] };

        const output = {
          ...pagination,
          offset,
          person_id,
          donations: donations.map((d) => ({ id: d.id, ...(d.attributes as DonationAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const header = `# Donations by person ${person_id} (${pagination.count} of ${pagination.total})`;
          const rows = donations.map((d) => {
            const a = d.attributes as DonationAttributes;
            const amount = a.amount_cents != null ? formatCurrency(a.amount_cents, a.amount_currency) : "?";
            const refund = a.refunded ? " ⚠️ refunded" : "";
            return `- ${amount} — ${a.payment_method ?? "?"} — ${a.received_at ?? "?"} (ID: ${d.id})${refund}`;
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
}
