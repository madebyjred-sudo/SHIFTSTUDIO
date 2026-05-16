/**
 * E2E graph mock helpers — page.route wrappers for Cerebro API surfaces
 * used in modo-nodos specs.
 */
import type { Page } from '@playwright/test';
import type { GraphGenerateResponse } from '../../../src/services/graphApi';

export interface TemplateNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface TemplateEdge {
  id: string;
  source: string;
  target: string;
}

export interface MockTemplate {
  id: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  dag_json: { nodes: TemplateNode[]; edges: TemplateEdge[] };
}

/**
 * Intercept POST *\/v1/graph/generate and return a canned response.
 * Call before the action that triggers the fetch.
 */
export async function mockGenerateGraph(
  page: Page,
  response: GraphGenerateResponse,
): Promise<void> {
  await page.route('**/v1/graph/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

/**
 * Intercept GET *\/v1/graph/templates and return a canned list.
 * Call before the action that triggers the fetch.
 */
export async function mockTemplates(
  page: Page,
  templates: MockTemplate[],
): Promise<void> {
  await page.route('**/v1/graph/templates**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ templates }),
    });
  });
}
