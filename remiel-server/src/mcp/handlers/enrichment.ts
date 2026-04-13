import type { EnrichmentService } from "../../services/EnrichmentService.js";

export function getEnrichmentTools() {
  return [
    {
      name: "get_enrichment_status",
      description: "Get the enrichment queue status (counts by state)",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

export async function handleEnrichmentTool(
  name: string,
  _args: Record<string, unknown>,
  enrichmentService: EnrichmentService,
): Promise<unknown> {
  switch (name) {
    case "get_enrichment_status":
      return enrichmentService.getStatus();
    default:
      throw new Error(`Unknown enrichment tool: ${name}`);
  }
}
