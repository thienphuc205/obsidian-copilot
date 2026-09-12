/**
 * Agent Reasoning Block State Management
 *
 * This module provides state management for the Agent Reasoning Block UI component,
 * which replaces the old tool call banner with a more informative reasoning display.
 */

/**
 * Status of the reasoning block
 * - idle: No agent activity
 * - reasoning: Agent is actively processing/executing tools
 * - collapsed: Reasoning complete, block is collapsed
 * - complete: Response complete, block can be expanded
 */
export type ReasoningStatus = "idle" | "reasoning" | "collapsed" | "complete";

/**
 * Parsed reasoning data from a marker
 */
export interface ParsedReasoningBlock {
  hasReasoning: boolean;
  status: ReasoningStatus;
  elapsedSeconds: number;
  steps: string[];
  contentAfter: string;
}

/**
 * Parse reasoning block marker from message content.
 *
 * @param content - Message content that may contain reasoning marker
 * @returns Parsed reasoning data or null if no marker found
 */
export function parseReasoningBlock(content: string): ParsedReasoningBlock | null {
  const match = content.match(/<!--AGENT_REASONING:(\w+):(\d+):(.+?)-->/);
  if (!match) {
    return null;
  }

  const [fullMatch, status, elapsed, stepsJson] = match;

  let steps: string[] = [];
  try {
    steps = JSON.parse(stepsJson) as string[];
  } catch {
    // Invalid JSON, return empty steps
    steps = [];
  }

  return {
    hasReasoning: true,
    status: status as ReasoningStatus,
    elapsedSeconds: parseInt(elapsed, 10),
    steps,
    contentAfter: content.replace(fullMatch, "").trim(),
  };
}
