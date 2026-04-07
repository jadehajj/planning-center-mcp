/**
 * Planning Center Online API client.
 * Uses Personal Access Token (App ID + Secret) via HTTP Basic Auth.
 */

import axios, { AxiosError, AxiosInstance } from "axios";
import { PCO_BASE_URL } from "../constants.js";

// PCO JSON:API response shape
export interface PcoResponse<T> {
  data: T | T[];
  included?: unknown[];
  meta?: {
    total_count?: number;
    count?: number;
    next?: { offset?: number };
  };
  links?: {
    next?: string;
    self?: string;
  };
}

export interface PcoAttributes {
  [key: string]: unknown;
}

export interface PcoResource {
  id: string;
  type: string;
  attributes: PcoAttributes;
  relationships?: Record<string, unknown>;
  links?: Record<string, string>;
}

let _client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (_client) return _client;

  const appId = process.env.PCO_APP_ID;
  const secret = process.env.PCO_SECRET;

  if (!appId || !secret) {
    throw new Error(
      "PCO_APP_ID and PCO_SECRET environment variables must be set."
    );
  }

  _client = axios.create({
    baseURL: PCO_BASE_URL,
    auth: { username: appId, password: secret },
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  return _client;
}

export async function pcoGet<T>(
  path: string,
  params?: Record<string, unknown>
): Promise<PcoResponse<T>> {
  const client = getClient();
  const response = await client.get<PcoResponse<T>>(path, { params });
  return response.data;
}

export function handlePcoError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const body = error.response.data as Record<string, unknown> | undefined;
      const detail =
        body && typeof body === "object" && "errors" in body
          ? JSON.stringify(body.errors)
          : "";
      switch (status) {
        case 401:
          return "Error: Authentication failed. Check that PCO_APP_ID and PCO_SECRET are correct.";
        case 403:
          return `Error: Permission denied. Your PAT may lack access to this resource. ${detail}`;
        case 404:
          return "Error: Resource not found. Check the ID is correct.";
        case 422:
          return `Error: Invalid request parameters. ${detail}`;
        case 429:
          return "Error: Rate limit exceeded. Please wait before making more requests.";
        default:
          return `Error: API request failed with status ${status}. ${detail}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. The PCO API may be slow — please try again.";
    }
    return `Error: Network error — ${error.message}`;
  }
  return `Error: Unexpected error — ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Build PCO pagination query params from limit/offset.
 * PCO uses per_page + offset.
 */
export function paginationParams(
  limit: number,
  offset: number
): Record<string, number> {
  return { per_page: limit, offset };
}

/**
 * Extract pagination metadata from a PCO response.
 */
export function extractPagination(
  response: PcoResponse<unknown>,
  limit: number,
  offset: number
): { total: number; count: number; has_more: boolean; next_offset?: number } {
  const total = response.meta?.total_count ?? 0;
  const count = Array.isArray(response.data) ? response.data.length : 1;
  const has_more = total > offset + count;
  return {
    total,
    count,
    has_more,
    ...(has_more ? { next_offset: offset + count } : {}),
  };
}
