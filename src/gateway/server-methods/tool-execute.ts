/**
 * tool.execute / tool.list — Direct tool execution RPC methods.
 *
 * Allows calling any OpenClaw tool (coding or gateway) without going through
 * the LLM agent loop.  Used by the Scale backend to replay edited trajectories
 * against a sandbox for validation.
 *
 * Coding tools (exec, read, write, edit, apply_patch) are created with
 * hardcoded container defaults.  Gateway tools (web_search, web_fetch,
 * memory_search, etc.) are resolved through the standard policy pipeline.
 */

import crypto from "node:crypto";
import { codingTools, createReadTool, readTool } from "@mariozechner/pi-coding-agent";
import { createExecTool, createProcessTool } from "../../agents/bash-tools.js";
import { createApplyPatchTool } from "../../agents/apply-patch.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ErrorCodes, errorShape, type ErrorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

// ---------------------------------------------------------------------------
// Container defaults — these match the OpenClaw Docker container layout used
// in Modal sandboxes.  See server/docker/openclaw/entrypoint.sh.
// ---------------------------------------------------------------------------

const CONTAINER_WORKSPACE = "/root/.openclaw/workspace";

// ---------------------------------------------------------------------------
// Tool creation helpers
// ---------------------------------------------------------------------------

type AnyTool = {
  name: string;
  description?: string;
  label?: string;
  parameters?: unknown;
  execute?: (toolCallId: string, args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
};

/** Lazily created set of coding tools (exec, read, write, edit, apply_patch, process). */
let cachedCodingTools: AnyTool[] | null = null;

function getCodingTools(): AnyTool[] {
  if (cachedCodingTools) return cachedCodingTools;

  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) || CONTAINER_WORKSPACE;

  // Base coding tools from pi-coding-agent (read, write, edit, etc.)
  const base: AnyTool[] = codingTools.flatMap((tool) => {
    if (tool.name === readTool.name) {
      return [createReadTool(workspaceDir) as unknown as AnyTool];
    }
    // write + edit are included as-is from codingTools
    return [tool as unknown as AnyTool];
  });

  // Exec tool with permissive defaults for direct invocation
  const execTool = createExecTool({
    cwd: workspaceDir,
    security: "full",
    ask: "off",
    host: "gateway",
    allowBackground: true,
    timeoutSec: 300,
  }) as unknown as AnyTool;

  // Process tool (background process management)
  const processTool = createProcessTool({}) as unknown as AnyTool;

  // Apply-patch tool
  const applyPatchTool = createApplyPatchTool({
    cwd: workspaceDir,
  }) as unknown as AnyTool;

  cachedCodingTools = [...base, execTool, processTool, applyPatchTool];
  return cachedCodingTools;
}

function getGatewayTools(sessionKey: string): AnyTool[] {
  const cfg = loadConfig();
  return createOpenClawTools({
    agentSessionKey: sessionKey,
    config: cfg,
  }) as unknown as AnyTool[];
}

function getAllTools(sessionKey: string): AnyTool[] {
  const codingToolsList = getCodingTools();
  const gatewayToolsList = getGatewayTools(sessionKey);

  // Merge, coding tools take precedence on name conflict
  const seen = new Set(codingToolsList.map((t) => t.name));
  const merged = [...codingToolsList];
  for (const tool of gatewayToolsList) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      merged.push(tool);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Normalize tool result to MCP content format
// ---------------------------------------------------------------------------

function normalizeContent(result: unknown): Array<{ type: string; text?: string }> {
  if (result === undefined || result === null) {
    return [{ type: "text", text: "" }];
  }
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  if (Array.isArray(result)) {
    // Already content blocks
    return result as Array<{ type: string; text?: string }>;
  }
  if (typeof result === "object" && result !== null) {
    // Check if it has a content array (MCP-style result)
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      return obj.content as Array<{ type: string; text?: string }>;
    }
    // Check for text field
    if (typeof obj.text === "string") {
      return [{ type: "text", text: obj.text }];
    }
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const toolExecuteHandlers: GatewayRequestHandlers = {
  /**
   * Execute a single tool by name.
   *
   * Params:
   *   name       — Tool name (required)
   *   arguments  — Tool arguments object (default: {})
   *   sessionKey — Session context for gateway tools (default: "main")
   */
  "tool.execute": async ({ params, respond }) => {
    const name = typeof params?.name === "string" ? params.name.trim() : "";
    if (!name) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tool.execute requires params.name"),
      );
      return;
    }

    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    const rawSessionKey =
      typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const cfg = loadConfig();
    const sessionKey =
      !rawSessionKey || rawSessionKey === "main" ? resolveMainSessionKey(cfg) : rawSessionKey;

    const allTools = getAllTools(sessionKey);
    const tool = allTools.find((t) => t.name === name);

    if (!tool) {
      respond(
        true,
        { content: [{ type: "text", text: `Tool not found: ${name}` }], isError: true },
        undefined,
      );
      return;
    }

    if (typeof tool.execute !== "function") {
      respond(
        true,
        { content: [{ type: "text", text: `Tool has no execute function: ${name}` }], isError: true },
        undefined,
      );
      return;
    }

    try {
      const toolCallId = `direct-${crypto.randomUUID()}`;
      const result = await tool.execute(toolCallId, args);
      respond(true, { content: normalizeContent(result), isError: false }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(
        true,
        { content: [{ type: "text", text: message || "tool execution failed" }], isError: true },
        undefined,
      );
    }
  },

  /**
   * List all available tools.
   *
   * Params:
   *   sessionKey — Session context (default: "main")
   */
  "tool.list": ({ params, respond }) => {
    const rawSessionKey =
      typeof params?.sessionKey === "string" ? params.sessionKey.trim() : undefined;
    const cfg = loadConfig();
    const sessionKey =
      !rawSessionKey || rawSessionKey === "main" ? resolveMainSessionKey(cfg) : rawSessionKey;

    const allTools = getAllTools(sessionKey);
    respond(
      true,
      {
        tools: allTools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? {},
        })),
      },
      undefined,
    );
  },
};
