/**
 * Shared Zod schemas for all tools.
 *
 * Uses z.coerce.number() so that MCP clients which serialise parameters as
 * strings (e.g. Claude custom connectors) still pass validation.
 */

import { z } from "zod";
import { ResponseFormat, DEFAULT_LIMIT, MAX_LIMIT } from "./constants.js";

export const limitSchema = z
  .union([z.number(), z.string()])
  .transform((v) => Number(v))
  .pipe(z.number().int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT)
  .describe(`Max results per page (1–${MAX_LIMIT}, default: ${DEFAULT_LIMIT})`);

export const offsetSchema = z
  .union([z.number(), z.string()])
  .transform((v) => Number(v))
  .pipe(z.number().int().min(0))
  .default(0)
  .describe("Number of results to skip for pagination (default: 0)");

export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

export const paginationSchema = z.object({
  limit: limitSchema,
  offset: offsetSchema,
  response_format: responseFormatSchema,
});
