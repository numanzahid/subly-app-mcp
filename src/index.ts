import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? "3000");
const SUBLY_BASE_URL = "https://web.subly.app/api/v1";

const MCP_PATH = process.env.MCP_PATH;
if (!MCP_PATH?.startsWith("/") || !MCP_PATH.endsWith("/mcp")) {
  throw new Error("MCP_PATH must start with / and end with /mcp");
}

function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "subly-mcp",
      event,
      ...fields,
    }),
  );
}

/** Avoid writing the secret URL segment into logs. */
function redactPath(path: string) {
  return path === MCP_PATH ? "[mcp]" : path;
}

const configuredApiKey = process.env.SUBLY_API_KEY;
if (!configuredApiKey) {
  throw new Error("SUBLY_API_KEY is required");
}
const SUBLY_API_KEY: string = configuredApiKey;

type QueryValue = string | number | boolean | undefined;

async function sublyRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  resource: string,
  options: {
    query?: Record<string, QueryValue>;
    body?: Record<string, unknown>;
  } = {},
) {
  const url = new URL(`${SUBLY_BASE_URL}/${resource}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      "x-api-key": SUBLY_API_KEY,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.text();
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      detail += `: ${String(parsed.error ?? parsed.message ?? "Subly request failed")}`;
    } catch {
      // Avoid returning an upstream HTML error page.
    }
    throw new Error(detail);
  }

  return body ? (JSON.parse(body) as unknown) : null;
}

function sublyGet(resource: string, query: Record<string, QueryValue> = {}) {
  return sublyRequest("GET", resource, { query });
}

function sublyWrite(
  method: "POST" | "PUT",
  resource: string,
  body: Record<string, unknown>,
) {
  return sublyRequest(method, resource, { body });
}

async function sublyDelete(resource: string) {
  await sublyRequest("DELETE", resource);
  return { deleted: true };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Subly API error: ${message}` }],
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const updateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const deleteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const entityId = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Subly resource ID");
const dateTime = z.string().describe("ISO 8601 date-time");
const currency = z.string().length(3).describe("ISO 4217 currency code");
const website = z.string().describe("Associated URL");
const billingRange = z.enum(["day", "week", "month", "year"]);
const expenseType = z.enum(["subscription", "one-time", "ltd"]);
const transactionType = z.enum(["expense", "revenue"]);

const projectUpdateFields = {
  name: z.string().min(1).optional(),
  budget_amount: z.number().nonnegative().optional(),
  budget_period: z.enum(["month", "year"]).optional(),
  budget_currency: currency.optional(),
};

const expenseOptionalFields = {
  category: z.string().optional(),
  tags: z.array(z.number().int()).optional(),
  is_recurring: z.boolean().optional(),
  billing_freq: z.number().int().positive().optional(),
  billing_range: billingRange.optional(),
  nextPaymentDate: dateTime.optional(),
  initialPaymentDate: dateTime.optional(),
  end_date: dateTime.optional(),
  refund_deadline: dateTime.optional(),
  currency: currency.optional(),
  isActive: z.boolean().optional(),
  website: website.optional(),
  renewal_date: dateTime.optional(),
};

const revenueOptionalFields = {
  is_recurring: z.boolean().optional(),
  billing_freq: z.number().int().positive().optional(),
  billing_range: billingRange.optional(),
  category: z.string().optional(),
  tags: z.array(z.number().int()).optional(),
  nextPaymentDate: dateTime.optional(),
  end_date: dateTime.optional(),
  currency: currency.optional(),
  isActive: z.boolean().optional(),
  website: website.optional(),
};

const transactionOptionalFields = {
  sub_id: entityId.optional(),
  revenue_item_id: entityId.optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.number().int()).optional(),
  website: website.optional(),
  project_id: entityId.optional(),
};

function registerLoggedTool(
  server: McpServer,
  toolName: string,
  config: Record<string, unknown>,
  handler: (...args: any[]) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>,
) {
  server.registerTool(
    toolName,
    config as Parameters<McpServer["registerTool"]>[1],
    async (...args: any[]) => {
    const started = Date.now();
    try {
      const result = await handler(...args);
      const isError = Boolean(result.isError);
      logEvent("mcp_tool", {
        tool: toolName,
        ok: !isError,
        is_error: isError,
        duration_ms: Date.now() - started,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logEvent("mcp_tool", {
        tool: toolName,
        ok: false,
        is_error: true,
        duration_ms: Date.now() - started,
        error: message,
      });
      throw error;
    }
    },
  );
}

function createServer() {
  const server = new McpServer({
    name: "subly-mcp",
    version: "1.0.0",
  });

  registerLoggedTool(
    server,
    "list_projects",
    {
      title: "List Subly projects",
      description: "List every project in the authenticated Subly workspace.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        return toolResult(await sublyGet("projects"));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "get_project",
    {
      title: "Get a Subly project",
      description: "Get one project by its numeric Subly ID.",
      inputSchema: { id: z.number().int().positive() },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await sublyGet(`projects/${id}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "list_expenses",
    {
      title: "List Subly expenses",
      description:
        "List expenses in the Subly workspace, optionally filtered by project ID.",
      inputSchema: { project_id: z.number().int().positive().optional() },
      annotations: readOnlyAnnotations,
    },
    async ({ project_id }) => {
      try {
        return toolResult(await sublyGet("expenses", { project_id }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "get_expense",
    {
      title: "Get a Subly expense",
      description: "Get one expense by its numeric Subly ID.",
      inputSchema: { id: z.number().int().positive() },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await sublyGet(`expenses/${id}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "list_revenue",
    {
      title: "List Subly revenue",
      description:
        "List revenue items, optionally filtered by project or recurrence status. The upstream Subly endpoint may currently return a server error.",
      inputSchema: {
        project_id: z.number().int().positive().optional(),
        is_recurring: z.boolean().optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ project_id, is_recurring }) => {
      try {
        return toolResult(
          await sublyGet("revenue", { project_id, is_recurring }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "get_revenue",
    {
      title: "Get a Subly revenue item",
      description: "Get one revenue item by its numeric Subly ID.",
      inputSchema: { id: z.number().int().positive() },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await sublyGet(`revenue/${id}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "list_transactions",
    {
      title: "List Subly transactions",
      description:
        "List workspace transactions, optionally filtered by transaction type, expense ID, or revenue item ID.",
      inputSchema: {
        type: z.enum(["expense", "revenue"]).optional(),
        sub_id: z.number().int().positive().optional(),
        revenue_item_id: z.number().int().positive().optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ type, sub_id, revenue_item_id }) => {
      try {
        return toolResult(
          await sublyGet("transactions", {
            type,
            sub_id,
            revenue_item_id,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "get_transaction",
    {
      title: "Get a Subly transaction",
      description: "Get one transaction by its numeric Subly ID.",
      inputSchema: { id: z.number().int().positive() },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await sublyGet(`transactions/${id}`));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "create_project",
    {
      title: "Create a Subly project",
      description: "Create a project in the authenticated Subly workspace.",
      inputSchema: {
        name: z.string().min(1),
        budget_amount: z.number().nonnegative().optional(),
        budget_period: z.enum(["month", "year"]).optional(),
        budget_currency: currency.optional(),
      },
      annotations: createAnnotations,
    },
    async (input) => {
      try {
        return toolResult(await sublyWrite("POST", "projects", input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "update_project",
    {
      title: "Update a Subly project",
      description: "Update fields on an existing Subly project.",
      inputSchema: { id: entityId, ...projectUpdateFields },
      annotations: updateAnnotations,
    },
    async ({ id, ...updates }) => {
      try {
        return toolResult(
          await sublyWrite("PUT", `projects/${id}`, updates),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "delete_project",
    {
      title: "Delete a Subly project",
      description:
        "Permanently delete a project. This is destructive and cannot be undone.",
      inputSchema: { id: entityId },
      annotations: deleteAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult({ id, ...(await sublyDelete(`projects/${id}`)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "create_expense",
    {
      title: "Create a Subly expense",
      description: "Create an expense in the authenticated Subly workspace.",
      inputSchema: {
        name: z.string().min(1),
        project_id: entityId,
        cost: z.number().nonnegative(),
        type: expenseType,
        ...expenseOptionalFields,
      },
      annotations: createAnnotations,
    },
    async (input) => {
      try {
        return toolResult(await sublyWrite("POST", "expenses", input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "update_expense",
    {
      title: "Update a Subly expense",
      description: "Update fields on an existing Subly expense.",
      inputSchema: {
        id: entityId,
        name: z.string().min(1).optional(),
        project_id: entityId.optional(),
        cost: z.number().nonnegative().optional(),
        type: expenseType.optional(),
        ...expenseOptionalFields,
      },
      annotations: updateAnnotations,
    },
    async ({ id, ...updates }) => {
      try {
        return toolResult(
          await sublyWrite("PUT", `expenses/${id}`, updates),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "delete_expense",
    {
      title: "Delete a Subly expense",
      description:
        "Permanently delete an expense. This is destructive and cannot be undone.",
      inputSchema: { id: entityId },
      annotations: deleteAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult({ id, ...(await sublyDelete(`expenses/${id}`)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "create_revenue",
    {
      title: "Create a Subly revenue item",
      description: "Create a revenue item in the authenticated workspace.",
      inputSchema: {
        name: z.string().min(1),
        amount: z.number().nonnegative(),
        project_id: entityId,
        ...revenueOptionalFields,
      },
      annotations: createAnnotations,
    },
    async (input) => {
      try {
        return toolResult(await sublyWrite("POST", "revenue", input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "update_revenue",
    {
      title: "Update a Subly revenue item",
      description: "Update fields on an existing Subly revenue item.",
      inputSchema: {
        id: entityId,
        name: z.string().min(1).optional(),
        amount: z.number().nonnegative().optional(),
        project_id: entityId.optional(),
        ...revenueOptionalFields,
      },
      annotations: updateAnnotations,
    },
    async ({ id, ...updates }) => {
      try {
        return toolResult(
          await sublyWrite("PUT", `revenue/${id}`, updates),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "delete_revenue",
    {
      title: "Delete a Subly revenue item",
      description:
        "Permanently delete a revenue item. This is destructive and cannot be undone.",
      inputSchema: { id: entityId },
      annotations: deleteAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult({ id, ...(await sublyDelete(`revenue/${id}`)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "create_transaction",
    {
      title: "Create a Subly transaction",
      description: "Create a financial transaction in the Subly workspace.",
      inputSchema: {
        type: transactionType,
        amount: z.number().nonnegative(),
        currency_code: currency,
        date: dateTime,
        ...transactionOptionalFields,
      },
      annotations: createAnnotations,
    },
    async (input) => {
      try {
        return toolResult(await sublyWrite("POST", "transactions", input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "update_transaction",
    {
      title: "Update a Subly transaction",
      description: "Update fields on an existing financial transaction.",
      inputSchema: {
        id: entityId,
        type: transactionType.optional(),
        amount: z.number().nonnegative().optional(),
        currency_code: currency.optional(),
        date: dateTime.optional(),
        ...transactionOptionalFields,
      },
      annotations: updateAnnotations,
    },
    async ({ id, ...updates }) => {
      try {
        return toolResult(
          await sublyWrite("PUT", `transactions/${id}`, updates),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerLoggedTool(
    server,
    "delete_transaction",
    {
      title: "Delete a Subly transaction",
      description:
        "Permanently delete a transaction. This is destructive and cannot be undone.",
      inputSchema: { id: entityId },
      annotations: deleteAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult({
          id,
          ...(await sublyDelete(`transactions/${id}`)),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  const started = Date.now();
  response.on("finish", () => {
    logEvent("http_request", {
      method: request.method,
      path: redactPath(request.path),
      status: response.statusCode,
      duration_ms: Date.now() - started,
      content_length: Number(response.getHeader("content-length")) || undefined,
    });
  });
  next();
});

app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.all(MCP_PATH, async (request: Request, response: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  response.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logEvent("mcp_request_failed", { error: message });
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.use((_request, response) => response.status(404).send("Not Found"));

app.listen(PORT, "0.0.0.0", () => {
  logEvent("server_start", { port: PORT, mcp_path: "[configured]" });
});
