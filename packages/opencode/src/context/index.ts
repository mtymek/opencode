import z from "zod"
import { SystemPrompt } from "../session/system"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { ProviderTransform } from "../provider/transform"

export namespace Context {
  export const Component = z
    .object({
      name: z.string(),
      category: z.enum([
        "system",
        "environment",
        "instructions",
        "tools",
        "mcp",
        "skills",
        "messages",
        "files",
        "other",
      ]),
      tokens: z.number(),
      source: z.string().optional(),
      count: z.number().optional(),
    })
    .meta({ ref: "ContextComponent" })
  export type Component = z.infer<typeof Component>

  export const Info = z
    .object({
      components: Component.array(),
      total: z.number(),
      limit: z.number(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      ratio: z.number(),
      imageCount: z.number(),
    })
    .meta({ ref: "ContextInfo" })
  export type Info = z.infer<typeof Info>

  export const GetInfoInput = z.object({
    sessionID: Identifier.schema("session"),
    providerID: z.string(),
    modelID: z.string(),
    agent: z.string().optional(),
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Character Measurement Functions
  // These mirror what gets sent to the LLM in llm.ts and prompt.ts
  // ─────────────────────────────────────────────────────────────────────────────

  async function measureSystem(providerID: string, agent: Agent.Info, model: Provider.Model): Promise<number> {
    const header = SystemPrompt.header(providerID)
    const headerChars = header.join("\n").length

    const providerPrompt = agent.prompt ? [agent.prompt] : SystemPrompt.provider(model)
    const providerPromptChars = providerPrompt.join("\n").length

    return headerChars + providerPromptChars
  }

  async function measureEnvironment(): Promise<number> {
    const env = await SystemPrompt.environment()
    return env.join("\n").length
  }

  async function measureInstructions(): Promise<{
    items: { name: string; source: string; chars: number }[]
    total: number
  }> {
    const customPrompts = await SystemPrompt.custom()
    const items = customPrompts.map((prompt) => {
      const match = prompt.match(/^Instructions from: (.+)\n/)
      const source = match?.[1] ?? ""
      const name = source?.split("/").pop() ?? "Custom"
      return { name, source, chars: prompt.length }
    })
    const total = items.reduce((sum, i) => sum + i.chars, 0)
    return { items, total }
  }

  async function measureTools(
    providerID: string,
    agent: Agent.Info,
    model: Provider.Model,
  ): Promise<{
    tools: { name: string; chars: number }[]
    total: number
  }> {
    const tools = await ToolRegistry.tools(providerID, agent)
    const result: { name: string; chars: number }[] = []

    for (const tool of tools) {
      // Mirror how tools are serialized in prompt.ts:589
      const schema = ProviderTransform.schema(model, z.toJSONSchema(tool.parameters))
      const schemaStr = JSON.stringify(schema)
      const chars = tool.id.length + tool.description.length + schemaStr.length
      result.push({ name: tool.id, chars })
    }

    const total = result.reduce((sum, t) => sum + t.chars, 0)
    return { tools: result, total }
  }

  async function measureMCPTools(): Promise<{
    tools: { name: string; chars: number }[]
    total: number
  }> {
    const mcpTools = await MCP.tools()
    const result: { name: string; chars: number }[] = []

    for (const [key, tool] of Object.entries(mcpTools)) {
      // MCP tools have name, description, and input schema
      const desc = ((tool as { description?: string }).description ?? "") as string
      const inputSchema = (tool as { parameters?: unknown }).parameters
      const schemaStr = inputSchema ? JSON.stringify(inputSchema) : ""
      const chars = key.length + desc.length + schemaStr.length
      result.push({ name: key, chars })
    }

    const total = result.reduce((sum, t) => sum + t.chars, 0)
    return { tools: result, total }
  }

  async function measureSkills(): Promise<{
    skills: { name: string; chars: number }[]
    total: number
  }> {
    const skills = await Skill.all()
    const result: { name: string; chars: number }[] = []
    for (const skill of skills) {
      const chars = skill.name.length + skill.description.length
      result.push({ name: skill.name, chars })
    }
    const total = result.reduce((sum, s) => sum + s.chars, 0)
    return { skills: result, total }
  }

  async function measureMessages(sessionID: string): Promise<{
    userMessages: number
    userSystemPrompts: number
    assistantText: number
    toolCalls: number
    toolResults: number
    toolResultsCompacted: number
    imageCount: number
    messageCount: number
  }> {
    let userMessages = 0
    let userSystemPrompts = 0
    let assistantText = 0
    let toolCalls = 0
    let toolResults = 0
    let toolResultsCompacted = 0
    let imageCount = 0
    let messageCount = 0

    // Replicate MessageV2.toModelMessage() logic for what gets sent to LLM
    for await (const msg of MessageV2.stream(sessionID)) {
      messageCount++

      if (msg.info.role === "user") {
        // Track user-provided system prompts
        const userInfo = msg.info as MessageV2.User
        if (userInfo.system) {
          userSystemPrompts += userInfo.system.length
        }

        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored) {
            userMessages += part.text.length
          }
          if (part.type === "file") {
            // Images are handled differently by providers, count but exclude from chars
            if (part.mime.startsWith("image/")) {
              imageCount++
            }
            // text/plain and directory files are converted to text parts in createUserMessage
            // We're measuring after that conversion happens, so these would be in text parts
          }
          if (part.type === "compaction") {
            // Compaction marker adds "What did we do so far?"
            userMessages += "What did we do so far?".length
          }
          if (part.type === "subtask") {
            // Subtask adds "The following tool was executed by the user"
            userMessages += "The following tool was executed by the user".length
          }
        }
      }

      if (msg.info.role === "assistant") {
        // Skip errored messages (same as toModelMessage)
        const assistantInfo = msg.info as MessageV2.Assistant
        if (
          assistantInfo.error &&
          !(
            MessageV2.AbortedError.isInstance(assistantInfo.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }

        for (const part of msg.parts) {
          if (part.type === "text") {
            assistantText += part.text.length
          }
          if (part.type === "tool") {
            if (part.state.status === "completed") {
              // Tool call input
              toolCalls += JSON.stringify(part.state.input).length

              // Tool result output
              if (part.state.time.compacted) {
                // Compacted outputs use a placeholder
                toolResultsCompacted += "[Old tool result content cleared]".length
              } else {
                toolResults += part.state.output.length
              }
            }
            if (part.state.status === "error") {
              // Error tool calls still have input and error text
              toolCalls += JSON.stringify(part.state.input).length
              toolResults += part.state.error.length
            }
          }
          // Note: reasoning parts are not counted - they don't count against context window
          // (tracked separately in tokens.reasoning)
        }
      }
    }

    return {
      userMessages,
      userSystemPrompts,
      assistantText,
      toolCalls,
      toolResults,
      toolResultsCompacted,
      imageCount,
      messageCount,
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main Function
  // ─────────────────────────────────────────────────────────────────────────────

  // Fixed ratio for character-to-token estimation (matching web app)
  const CHARS_PER_TOKEN = 4

  // Safe wrapper for measurement functions - returns default on error
  async function safeMeasure<T>(fn: () => Promise<T>, defaultValue: T): Promise<T> {
    try {
      return await fn()
    } catch {
      return defaultValue
    }
  }

  export async function getInfo(input: z.infer<typeof GetInfoInput>): Promise<Info | null> {
    // Find the assistant message with the highest input token count
    // (input + cache.read represents the actual context window usage)
    // We look for the max because recent messages might have low input tokens
    // if they're mostly cache writes (new content being cached)
    let lastAssistant: MessageV2.Assistant | undefined
    let maxInputTokens = 0
    for await (const msg of MessageV2.stream(input.sessionID)) {
      if (msg.info.role === "assistant") {
        const inputTokens = msg.info.tokens.input + msg.info.tokens.cache.read
        if (inputTokens > maxInputTokens) {
          maxInputTokens = inputTokens
          lastAssistant = msg.info
        }
      }
    }

    // Don't show breakdown before first response with input tokens
    if (!lastAssistant || maxInputTokens === 0) {
      return null
    }

    // Use input tokens + cached tokens as the budget for breakdown
    // (cached tokens are still part of the input context window)
    const actualTokens = maxInputTokens

    // Use model info from the session's last assistant message (more accurate than current selection)
    const providerID = lastAssistant.providerID ?? input.providerID
    const modelID = lastAssistant.modelID ?? input.modelID

    // Try to get model info, but don't fail if unavailable
    const model = await safeMeasure(() => Provider.getModel(providerID, modelID), {
      limit: { context: 200000, output: 8192 },
    } as Provider.Model)

    // Try to get agent info, but don't fail if unavailable
    const agent = await safeMeasure(async () => Agent.get(input.agent ?? (await Agent.defaultAgent())), {
      prompt: undefined,
      tools: {},
    } as unknown as Agent.Info)

    // Measure all character counts with error handling
    const system = await safeMeasure(() => measureSystem(providerID, agent, model), 0)
    const environment = await safeMeasure(() => measureEnvironment(), 0)
    const instructions = await safeMeasure(() => measureInstructions(), { items: [], total: 0 })
    const tools = await safeMeasure(() => measureTools(providerID, agent, model), { tools: [], total: 0 })
    const mcpTools = await safeMeasure(() => measureMCPTools(), { tools: [], total: 0 })
    const skills = await safeMeasure(() => measureSkills(), { skills: [], total: 0 })
    const messages = await safeMeasure(() => measureMessages(input.sessionID), {
      userMessages: 0,
      userSystemPrompts: 0,
      assistantText: 0,
      toolCalls: 0,
      toolResults: 0,
      toolResultsCompacted: 0,
      imageCount: 0,
      messageCount: 0,
    })

    // Helper to convert chars to tokens using fixed ratio
    const toTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

    // Build components
    const components: Component[] = []

    // System - single entry combining header + provider prompt
    if (system > 0) {
      components.push({
        name: "System",
        category: "system",
        tokens: toTokens(system),
      })
    }

    // User system prompts (if any)
    if (messages.userSystemPrompts > 0) {
      components.push({
        name: "User System Prompt",
        category: "system",
        tokens: toTokens(messages.userSystemPrompts),
      })
    }

    // Environment - single entry
    if (environment > 0) {
      components.push({
        name: "Environment",
        category: "environment",
        tokens: toTokens(environment),
      })
    }

    // Instructions - individual files
    for (const instruction of instructions.items) {
      components.push({
        name: instruction.name,
        category: "instructions",
        tokens: toTokens(instruction.chars),
        source: instruction.source,
      })
    }

    // Tools - individual tools in definition order
    for (const tool of tools.tools) {
      components.push({
        name: tool.name,
        category: "tools",
        tokens: toTokens(tool.chars),
      })
    }

    // MCP - individual tools in definition order
    for (const tool of mcpTools.tools) {
      components.push({
        name: tool.name,
        category: "mcp",
        tokens: toTokens(tool.chars),
      })
    }

    // Skills - individual skills
    for (const skill of skills.skills) {
      components.push({
        name: skill.name,
        category: "skills",
        tokens: toTokens(skill.chars),
      })
    }

    // Messages breakdown
    if (messages.userMessages > 0) {
      components.push({
        name: "User Messages",
        category: "messages",
        tokens: toTokens(messages.userMessages),
      })
    }
    if (messages.assistantText > 0) {
      components.push({
        name: "Assistant Text",
        category: "messages",
        tokens: toTokens(messages.assistantText),
      })
    }
    if (messages.toolCalls > 0) {
      components.push({
        name: "Tool Calls",
        category: "messages",
        tokens: toTokens(messages.toolCalls),
      })
    }
    if (messages.toolResults > 0) {
      components.push({
        name: "Tool Results",
        category: "messages",
        tokens: toTokens(messages.toolResults),
      })
    }
    if (messages.toolResultsCompacted > 0) {
      components.push({
        name: "Tool Results (compacted)",
        category: "messages",
        tokens: toTokens(messages.toolResultsCompacted),
      })
    }

    // Files (images) - shown but not counted in tokens
    if (messages.imageCount > 0) {
      components.push({
        name: `Images: ${messages.imageCount}`,
        category: "files",
        tokens: 0,
        count: messages.imageCount,
      })
    }

    // Calculate estimated total from components
    const estimatedTotal = components.reduce((sum, c) => sum + c.tokens, 0)

    // If estimates exceed actual tokens, scale down proportionally (matching web app)
    if (estimatedTotal > actualTokens) {
      const scale = actualTokens / estimatedTotal
      for (const component of components) {
        component.tokens = Math.floor(component.tokens * scale)
      }
    }

    // Add "Other" category for unmeasured overhead (tool definitions overhead, JSON encoding, etc.)
    const scaledTotal = components.reduce((sum, c) => sum + c.tokens, 0)
    const other = Math.max(0, actualTokens - scaledTotal)
    if (other > 0) {
      components.push({
        name: "Other",
        category: "other",
        tokens: other,
      })
    }

    return {
      components,
      total: actualTokens,
      limit: model.limit.context,
      model: {
        providerID,
        modelID,
      },
      ratio: CHARS_PER_TOKEN,
      imageCount: messages.imageCount,
    }
  }
}
