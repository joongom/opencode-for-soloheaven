import { useSync } from "@tui/context/sync"
import { createMemo, For, Show, Switch, Match, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { getToolSummary } from "./index"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"

const ThinkingHistory = (props: { sessionID: string; sync: ReturnType<typeof useSync> }) => {
  const { theme } = useTheme()
  const messages = createMemo(() => props.sync.data.message[props.sessionID] ?? [])
  
  const completedThinkings = createMemo(() => {
    const result: Array<{
      message: AssistantMessage
      reasoning: any
      tools: ToolPart[]
      duration: number
    }> = []
    
    for (const msg of messages()) {
      if (msg.role !== "assistant" || !msg.time.completed) continue
      
      const parts = props.sync.data.part[msg.id] ?? []
      const reasoningPart = parts.find((p): p is any => p.type === "reasoning")
      
      if (!reasoningPart || !reasoningPart.time?.end) continue
      
      const tools = parts.filter((p): p is ToolPart => p.type === "tool")
      const duration = reasoningPart.time.end - reasoningPart.time.start
      
      result.push({
        message: msg,
        reasoning: reasoningPart,
        tools,
        duration,
      })
    }
    
    return result.reverse()
  })

  const [expandedItems, setExpandedItems] = createSignal<Set<string>>(new Set())

  const toggleExpand = (messageId: string) => {
    const current = expandedItems()
    const next = new Set(current)
    if (next.has(messageId)) {
      next.delete(messageId)
    } else {
      next.add(messageId)
    }
    setExpandedItems(next)
  }

  return (
    <Show when={completedThinkings().length > 0}>
      <box>
        <text fg={theme.text}>
          <b>Thinking History</b>
        </text>
        <box flexDirection="column" gap={0.5}>
          <For each={completedThinkings()}>
            {(item) => {
              const isExpanded = expandedItems().has(item.message.id)
              const timestamp = new Date(item.reasoning.time.start).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
              
              return (
                <box
                  flexDirection="column"
                  border={["top"]}
                  borderColor={theme.border}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    alignItems="center"
                    onMouseDown={() => toggleExpand(item.message.id)}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.textMuted}>{timestamp}</text>
                      <text fg={theme.text}>
                        <b>Thinking</b>
                      </text>
                      <text fg={theme.textMuted}>
                        ({(item.duration / 1000).toFixed(1)}s · ~{Math.round((item.reasoning.text?.length || 0) / 4)} tokens)
                      </text>
                    </box>
                    <text fg={theme.textMuted}>
                      {isExpanded ? "▼" : "▶"}
                    </text>
                  </box>
                  
                  <Show when={isExpanded}>
                    <box flexDirection="column" gap={1} marginTop={1}>
                      <Show when={item.tools.length > 0}>
                        <text fg={theme.warning}>
                          🛠️ Tools ({item.tools.length}):
                        </text>
                        <For each={item.tools}>
                          {(tool) => (
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.textMuted}>↳</text>
                              <text fg={theme.text} wrapMode="word">
                                {tool.tool}: {tool.state.status}
                              </text>
                            </box>
                          )}
                        </For>
                      </Show>
                      
                      <Show when={item.tools.length === 0}>
                        <text fg={theme.textMuted}>
                          No tool calls
                        </text>
                      </Show>
                    </box>
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </Show>
  )
}

const KVCacheEntry = z.object({
  timestamp: z.number(),
  cacheMode: z.string().optional(),
  cachedTokens: z.number(),
  newTokens: z.number(),
  totalTokens: z.number(),
})

type KVCacheEntry = z.infer<typeof KVCacheEntry>

const KVCacheLog = (props: { sessionID: string; sync: ReturnType<typeof useSync> }) => {
  const { theme } = useTheme()
  const [logs, setLogs] = createSignal<KVCacheEntry[]>([])
  
  createMemo(() => {
    const messages = props.sync.data.message[props.sessionID] ?? []
    const newLogs: KVCacheEntry[] = []
    
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.time.completed) continue
      
      const parts = props.sync.data.part[msg.id] ?? []
      const stepFinish = parts.findLast((p: any) => p.type === "step-finish" && p.metadata?.cacheInfo)
      
      if (!stepFinish) continue
      
      const cacheInfo = stepFinish.metadata.cacheInfo
      const cachedTokens = cacheInfo.cached_tokens ?? 0
      const totalTokens = cacheInfo.total_prompt_tokens ?? 0
      const newWriteTokens = totalTokens - cachedTokens
      
      if (cachedTokens === 0 && newWriteTokens === 0) continue
      
      newLogs.push({
        cacheMode: cacheInfo.cache_mode ?? (cachedTokens > 0 ? "HIT" : "MISS"),
        cachedTokens,
        newTokens: newWriteTokens,
        totalTokens,
      })
    }
    
    setLogs(newLogs.slice(-5).reverse())
  })
  
  return (
    <box>
      <text fg={theme.text}>
        <b>KV Cache</b>
      </text>
      <box flexDirection="column">
        <Show when={logs().length > 0}>
          <For each={logs()}>
            {(log) => {
              const isHit = log.cacheMode.toUpperCase().includes("HIT")
              return (
                <text fg={theme.textMuted}>
                  <span style={{ fg: isHit ? theme.success : theme.warning }}>{isHit ? "HIT" : "MISS"}</span>
                  {` ${log.cachedTokens.toLocaleString()} reused +${log.newTokens.toLocaleString()} new`}
                </text>
              )
            }}
          </For>
        </Show>
        <Show when={logs().length === 0}>
          <text fg={theme.textMuted}>No cache data</text>
        </Show>
      </box>
    </box>
  )
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const directory = useDirectory()
  const kv = useKV()

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
            <ThinkingHistory sessionID={props.sessionID} sync={sync} />
            <KVCacheLog sessionID={props.sessionID} sync={sync} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
