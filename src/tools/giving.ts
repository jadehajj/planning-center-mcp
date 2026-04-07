/**
 * Planning Center Giving tools.
 * Wraps: GET /giving/v2/donations
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

interface DonationAttributes {
  amount_cents?: number;
  amount_currency?: string;
  payment_status?: string;
  payment_method?: string;
  received_at?: string;
  refunded?: boolean;
  refund_amount_cents?: number;
}

interface DesignationAttributes {
  amount_cents?: number;
  amount_currency?: string;
}

function formatCurrency(cents: number, currency = "AUD"): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

export function registerGivingTools(server: McpServer): void {
  server.registerTool(
    "pc_list_donations",
    {
      title: "List Donation Records",
      description: `List donation/giving records from Planning Center Giving.

Results are sorted most-recent first. Sensitive financial data — ensure appropriate access.

Args:
  - limit (number): Max results per page, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: donation amount, currency, payment method, status, received date, and whether it was refunded.

Examples:
  - "Show recent donations" → no extra params
  - "Get next page of donations" → offset=25`,
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
        const resp = await pcoGet<PcoResource>("/giving/v2/donations", {
          ...paginationParams(limit, offset),
          order: "-received_at",
        });
        const donations = (Array.isArray(resp.data) ? resp.data : [resp.data]) as PcoResource[];
        const pagination = extractPagination(resp, limit, offset);

        if (!donations.length) {
          return { content: [{ type: "text", text: "No donation records found." }] };
        }

        const output = {
          ...pagination,
          offset,
          donations: donations.map((d) => ({ id: d.id, ...(d.attributes as DonationAttributes) })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [`# Donations (${pagination.count} of ${pagination.total})`, ""];
          for (const d of donations) {
            const a = d.attributes as DonationAttributes;
            const amount = a.amount_cents != null ? formatCurrency(a.amount_cents, a.amount_currency) : "Unknown";
            const date = a.received_at ? new Date(a.received_at).toLocaleDateString() : "Unknown date";
            const refundNote = a.refunded ? " _(refunded)_" : "";
            lines.push(`- ${amount} via ${a.payment_method ?? "unknown"} — ${date}${refundNote}`);
          }
          if (pagination.has_more) lines.push(`\n_More results — use offset=${pagination.next_offset}_`);
          text = lines.join("\n");
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use a smaller limit.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );
}
