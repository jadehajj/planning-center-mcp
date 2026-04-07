/**
 * Planning Center Services tools.
 * Wraps: GET /services/v2/service_types/:service_type_id/plans
 *        GET /services/v2/service_types/:service_type_id/plans/:id
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormat, DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import {
  pcoGet,
  handlePcoError,
  paginationParams,
  extractPagination,
  PcoResource,
} from "../services/pco-client.js";

interface ServiceTypeAttributes {
  name?: string;
}

interface PlanAttributes {
  title?: string;
  dates?: string;
  sort_date?: string;
  series_title?: string;
  public?: boolean;
  items_count?: number;
  needed_positions_count?: number;
}

interface PlanItemAttributes {
  title?: string;
  item_type?: string;
  length?: number;
  sequence?: number;
  song_id?: string;
}

interface TeamPositionAttributes {
  name?: string;
}

function formatPlan(plan: PcoResource, serviceTypeName: string): string {
  const a = plan.attributes as PlanAttributes;
  const lines = [
    `## ${a.title ?? "Untitled Plan"} (ID: ${plan.id})`,
    `- **Service Type**: ${serviceTypeName}`,
    `- **Date**: ${a.dates ?? a.sort_date ?? "TBD"}`,
  ];
  if (a.series_title) lines.push(`- **Series**: ${a.series_title}`);
  if (typeof a.items_count === "number") lines.push(`- **Items**: ${a.items_count}`);
  if (typeof a.needed_positions_count === "number") lines.push(`- **Open Positions**: ${a.needed_positions_count}`);
  return lines.join("\n");
}

export function registerServicesTools(server: McpServer): void {
  // ─── pc_list_services ─────────────────────────────────────────────────────
  server.registerTool(
    "pc_list_services",
    {
      title: "List Upcoming Service Plans",
      description: `List upcoming service plans across all service types in Planning Center Services.

Fetches all service types first, then retrieves upcoming plans for each type.

Args:
  - limit (number): Max plans per service type, 1–100 (default: 25)
  - offset (number): Results to skip for pagination (default: 0)
  - service_type_id (string, optional): Filter to a specific service type ID
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns plan titles, dates, series, and team position counts.

Examples:
  - "What services are coming up?" → no extra params
  - "Show Sunday morning plans" → service_type_id="<id from pc_list_services>"`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
        service_type_id: z.string().optional().describe("Filter to a specific service type ID"),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, offset, service_type_id, response_format }) => {
      try {
        // Get service types
        let serviceTypes: PcoResource[];
        if (service_type_id) {
          const st = await pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}`);
          serviceTypes = [Array.isArray(st.data) ? st.data[0] : st.data] as PcoResource[];
        } else {
          const st = await pcoGet<PcoResource>("/services/v2/service_types", { per_page: 50 });
          serviceTypes = (Array.isArray(st.data) ? st.data : [st.data]) as PcoResource[];
        }

        const allPlans: Array<{ serviceType: string; plan: PcoResource }> = [];

        for (const serviceType of serviceTypes) {
          const typeName = (serviceType.attributes as ServiceTypeAttributes).name ?? serviceType.id;
          const plansResp = await pcoGet<PcoResource>(
            `/services/v2/service_types/${serviceType.id}/plans`,
            {
              filter: "future",
              ...paginationParams(limit, offset),
              order: "sort_date",
            }
          );
          const plans = (Array.isArray(plansResp.data) ? plansResp.data : [plansResp.data]) as PcoResource[];
          for (const plan of plans) {
            allPlans.push({ serviceType: typeName, plan });
          }
        }

        if (!allPlans.length) {
          return { content: [{ type: "text", text: "No upcoming service plans found." }] };
        }

        const output = {
          count: allPlans.length,
          plans: allPlans.map(({ serviceType, plan }) => ({
            id: plan.id,
            service_type: serviceType,
            ...(plan.attributes as PlanAttributes),
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          text = `# Upcoming Service Plans (${allPlans.length})\n\n` +
            allPlans.map(({ serviceType, plan }) => formatPlan(plan, serviceType)).join("\n\n");
        } else {
          text = JSON.stringify(output, null, 2);
        }

        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated — use service_type_id or a smaller limit.]";
        }

        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return { content: [{ type: "text", text: handlePcoError(error) }] };
      }
    }
  );

  // ─── pc_get_service ───────────────────────────────────────────────────────
  server.registerTool(
    "pc_get_service",
    {
      title: "Get Service Plan Detail",
      description: `Retrieve full details for a specific service plan including order of service items and team positions.

Args:
  - service_type_id (string): The service type ID (get from pc_list_services)
  - plan_id (string): The plan ID (get from pc_list_services)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns: plan metadata, all order-of-service items (songs, notes, headers), team positions and their fill status.

Examples:
  - "What's on the order of service for plan 12345?" → service_type_id="...", plan_id="12345"`,
      inputSchema: z.object({
        service_type_id: z.string().min(1).describe("Service type ID"),
        plan_id: z.string().min(1).describe("Plan ID"),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ service_type_id, plan_id, response_format }) => {
      try {
        const [planResp, itemsResp, teamsResp] = await Promise.all([
          pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}`),
          pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}/items`, { per_page: 100, order: "sequence" }),
          pcoGet<PcoResource>(`/services/v2/service_types/${service_type_id}/plans/${plan_id}/needed_positions`, { per_page: 100 }),
        ]);

        const plan = (Array.isArray(planResp.data) ? planResp.data[0] : planResp.data) as PcoResource;
        const items = (Array.isArray(itemsResp.data) ? itemsResp.data : [itemsResp.data]) as PcoResource[];
        const neededPositions = (Array.isArray(teamsResp.data) ? teamsResp.data : [teamsResp.data]) as PcoResource[];

        const planAttrs = plan.attributes as PlanAttributes;

        const output = {
          id: plan.id,
          ...planAttrs,
          items: items.map((i) => ({
            id: i.id,
            ...(i.attributes as PlanItemAttributes),
          })),
          needed_positions: neededPositions.map((np) => ({
            id: np.id,
            ...(np.attributes as TeamPositionAttributes),
          })),
        };

        let text: string;
        if (response_format === ResponseFormat.MARKDOWN) {
          const lines = [
            `# ${planAttrs.title ?? "Service Plan"} (ID: ${plan.id})`,
            `**Date**: ${planAttrs.dates ?? planAttrs.sort_date ?? "TBD"}`,
            planAttrs.series_title ? `**Series**: ${planAttrs.series_title}` : "",
            "",
            "## Order of Service",
          ];
          for (const item of items) {
            const ia = item.attributes as PlanItemAttributes;
            const mins = ia.length ? ` (${Math.round(ia.length / 60000)}m)` : "";
            lines.push(`- **${ia.item_type ?? "item"}**: ${ia.title ?? "Untitled"}${mins}`);
          }
          if (neededPositions.length) {
            lines.push("", "## Open Positions");
            for (const np of neededPositions) {
              lines.push(`- ${(np.attributes as TeamPositionAttributes).name ?? np.id}`);
            }
          }
          text = lines.filter(Boolean).join("\n");
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
