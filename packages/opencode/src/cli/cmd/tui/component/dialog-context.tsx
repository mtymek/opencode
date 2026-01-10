import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useLocal } from "@tui/context/local"
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"

// Types matching Context.Info and Context.Component from src/context/index.ts
type ContextComponent = {
  name: string
  category: "system" | "environment" | "instructions" | "tools" | "mcp" | "skills" | "messages" | "files" | "other"
  tokens: number
  source?: string
  count?: number
}

type ContextInfo = {
  components: ContextComponent[]
  total: number
  limit: number
  model: {
    providerID: string
    modelID: string
  }
  ratio: number
  imageCount: number
}

const CATEGORY_ORDER = ["system", "environment", "instructions", "tools", "mcp", "skills", "messages", "files", "other"]

// Categories that should be rendered as a single row (no sub-items)
const FLAT_CATEGORIES = ["system", "environment", "other"]

// Categories that can be collapsed
const COLLAPSIBLE_CATEGORIES = ["instructions", "tools", "mcp", "skills", "messages"]

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return tokens.toString()
}

function ProgressBar(props: { value: number; max: number }) {
  const { theme } = useTheme()
  const percentage = () => Math.min(props.value / props.max, 1)

  const color = () => (percentage() > 0.9 ? theme.error : percentage() > 0.7 ? theme.warning : theme.success)

  return (
    <box flexDirection="row" width="100%">
      <box flexGrow={percentage()} height={1} backgroundColor={color()} />
      <box flexGrow={1 - percentage()} height={1} backgroundColor={theme.backgroundPanel} />
    </box>
  )
}

function ComponentRow(props: { component: ContextComponent; total: number }) {
  const { theme } = useTheme()
  const percentage = () => ((props.component.tokens / props.total) * 100).toFixed(1)

  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
      <text fg={theme.text}>
        {props.component.name}
        {props.component.count !== undefined && <span style={{ fg: theme.textMuted }}> ({props.component.count})</span>}
      </text>
      <text fg={theme.textMuted}>
        ~{formatTokens(props.component.tokens)} ({percentage()}%)
      </text>
    </box>
  )
}

function FlatCategoryRow(props: { name: string; tokens: number; total: number }) {
  const { theme } = useTheme()
  const percentage = () => ((props.tokens / props.total) * 100).toFixed(1)

  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.name}
      </text>
      <text fg={theme.textMuted}>
        ~{formatTokens(props.tokens)} ({percentage()}%)
      </text>
    </box>
  )
}

function CategorySection(props: {
  category: string
  components: ContextComponent[]
  total: number
  collapsed: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const categoryTotal = () => props.components.reduce((sum, c) => sum + c.tokens, 0)
  const categoryName = props.category.charAt(0).toUpperCase() + props.category.slice(1)
  const isCollapsible = COLLAPSIBLE_CATEGORIES.includes(props.category)

  // For flat categories with a single component, render as a single row
  if (FLAT_CATEGORIES.includes(props.category) && props.components.length === 1) {
    const component = props.components[0]
    return <FlatCategoryRow name={component.name} tokens={component.tokens} total={props.total} />
  }

  // For flat categories with multiple components (shouldn't happen, but handle gracefully)
  if (FLAT_CATEGORIES.includes(props.category)) {
    return <FlatCategoryRow name={categoryName} tokens={categoryTotal()} total={props.total} />
  }

  const chevron = () => (props.collapsed ? "▶" : "▼")

  return (
    <box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        onMouseUp={() => {
          if (isCollapsible) props.onToggle()
        }}
      >
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {isCollapsible ? `${chevron()} ${categoryName}` : categoryName}
        </text>
        <text fg={theme.textMuted}>~{formatTokens(categoryTotal())}</text>
      </box>
      <Show when={!props.collapsed}>
        <For each={props.components}>{(component) => <ComponentRow component={component} total={props.total} />}</For>
      </Show>
    </box>
  )
}

export function DialogContext() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const route = useRoute()
  const local = useLocal()
  const dimensions = useTerminalDimensions()

  let scroll: ScrollBoxRenderable | undefined

  const maxHeight = createMemo(() => Math.floor(dimensions().height / 2) - 4)

  // Track collapsed state for each collapsible category
  // All categories collapsed by default except messages
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({
    instructions: true,
    tools: true,
    mcp: true,
    skills: true,
    messages: false,
  })

  onMount(() => {
    dialog.setSize("large")
  })

  useKeyboard((evt) => {
    if (evt.name === "escape" || evt.name === "return") {
      dialog.clear()
      evt.preventDefault()
    }
    if (evt.name === "up") {
      scroll?.scrollBy(-1)
      evt.preventDefault()
    }
    if (evt.name === "down") {
      scroll?.scrollBy(1)
      evt.preventDefault()
    }
    if (evt.name === "pageup") {
      scroll?.scrollBy(-10)
      evt.preventDefault()
    }
    if (evt.name === "pagedown") {
      scroll?.scrollBy(10)
      evt.preventDefault()
    }
  })

  // Source signal for the resource - tracks session ID to refetch when it changes
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : null)

  const [contextInfo] = createResource(sessionID, async (id): Promise<ContextInfo | null> => {
    if (!id) return null
    const model = local.model.current()
    if (!model) return null

    const params = new URLSearchParams({
      providerID: model.providerID,
      modelID: model.modelID,
    })
    const agent = local.agent.current()
    if (agent) params.set("agent", agent.name)

    const response = await fetch(`${sdk.url}/session/${id}/context?${params}`)
    if (!response.ok) return null
    return response.json()
  })

  const groupedComponents = () => {
    const info = contextInfo()
    if (!info) return []

    const groups: Record<string, ContextComponent[]> = {}
    for (const component of info.components) {
      if (!groups[component.category]) {
        groups[component.category] = []
      }
      groups[component.category].push(component)
    }

    return CATEGORY_ORDER.filter((cat) => groups[cat]?.length > 0).map((cat) => ({
      category: cat,
      components: groups[cat],
    }))
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Context
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={contextInfo.loading}>
        <text fg={theme.textMuted}>Loading...</text>
      </Show>

      <Show when={contextInfo.error}>
        <text fg={theme.error}>Error loading context info</text>
      </Show>

      <Show when={contextInfo()}>
        {(info) => (
          <>
            {/* Model info */}
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Model:</text>
              <text fg={theme.text}>
                {info().model.providerID}/{info().model.modelID}
              </text>
            </box>

            {/* Components by category - scrollable */}
            <scrollbox
              ref={(r: ScrollBoxRenderable) => (scroll = r)}
              maxHeight={maxHeight()}
              scrollX={false}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
            >
              <For each={groupedComponents()}>
                {(group) => (
                  <CategorySection
                    category={group.category}
                    components={group.components}
                    total={info().limit}
                    collapsed={collapsed[group.category] ?? false}
                    onToggle={() => setCollapsed(group.category, !collapsed[group.category])}
                  />
                )}
              </For>
            </scrollbox>

            {/* Divider */}
            <box border={["top"]} borderColor={theme.textMuted} />

            {/* Total */}
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Total
              </text>
              <text fg={theme.text}>
                ~{formatTokens(info().total)} / {formatTokens(info().limit)} tokens (
                {((info().total / info().limit) * 100).toFixed(1)}%)
              </text>
            </box>

            {/* Progress bar */}
            <ProgressBar value={info().total} max={info().limit} />
          </>
        )}
      </Show>
    </box>
  )
}
