import { type Accessor, createMemo, createSignal, createEffect, onCleanup, Match, Show, Switch, For } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage, Session, ToolPart, TextPart } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Flag } from "@/flag/flag"
import { useTerminalDimensions } from "@opentui/solid"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} ({props.cost()})
      </text>
    </Show>
  )
}

export const ThinkingInfo = (props: { sessionID: string; sync: ReturnType<typeof useSync> }) => {
  const { theme } = useTheme()
  const messages = createMemo(() => props.sync.data.message[props.sessionID] ?? [])

  // Find active thinking state from either:
  // 1. A reasoning part (AI SDK reasoning events)
  // 2. A text part containing <think> tags (Qwen/soloheaven style)
  const currentThinking = createMemo(() => {
    const assistantMsg = messages().findLast((x) => x.role === "assistant" && !x.time.completed)
    if (!assistantMsg) return undefined

    const parts = props.sync.data.part[assistantMsg.id] ?? []

    // Check for AI SDK reasoning part first
    const reasoningPart = parts.find((p) => p.type === "reasoning") as any
    if (reasoningPart && !reasoningPart.time?.end) {
      return {
        type: "reasoning" as const,
        text: reasoningPart.text ?? "",
        startTime: reasoningPart.time?.start || assistantMsg.time?.created || Date.now(),
      }
    }

    // Check for <think> tag in text parts (Qwen/soloheaven)
    const textPart = parts.find((p) => p.type === "text") as TextPart | undefined
    if (textPart) {
      const text = (textPart as any).text ?? ""
      const thinkStart = text.indexOf("<think>")
      if (thinkStart !== -1) {
        const thinkEnd = text.indexOf("</think>")
        if (thinkEnd === -1) {
          // Still thinking — no closing tag yet
          const thinkContent = text.slice(thinkStart + 7)
          return {
            type: "think-tag" as const,
            text: thinkContent,
            startTime: assistantMsg.time?.created || Date.now(),
          }
        }
      }
    }

    return undefined
  })

  const [elapsed, setElapsed] = createSignal(0)
  const [collapsed, setCollapsed] = createSignal(true)

  createEffect(() => {
    const thinking = currentThinking()
    if (!thinking) return

    setElapsed(Date.now() - thinking.startTime)
    setCollapsed(false)

    const timer = setInterval(() => {
      const t = currentThinking()
      if (t) {
        setElapsed(Date.now() - t.startTime)
      }
    }, 100)

    onCleanup(() => clearInterval(timer))
  })

  const estimatedTokens = createMemo(() => {
    const t = currentThinking()
    return t ? Math.round((t.text.length || 0) / 4) : 0
  })

  // Preview: last 3 lines of thinking text (strip tags)
  const thinkingPreview = createMemo(() => {
    const t = currentThinking()
    if (!t || !t.text.trim()) return ""
    const clean = t.text.replace(/<\/?think>/g, "").trim()
    if (!clean) return ""
    const lines = clean.split("\n")
    const preview = lines.slice(-3).join("\n")
    return preview.length > 200 ? preview.slice(-200) : preview
  })

  return (
    <Show when={currentThinking()}>
      <box
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.backgroundElement}
        border={["top"]}
        borderColor={theme.warning}
        flexDirection="column"
      >
        <box
          flexDirection="row"
          justifyContent="space-between"
          onMouseDown={() => setCollapsed(!collapsed())}
        >
          <box flexDirection="row" gap={1}>
            <text fg={theme.warning}>▲</text>
            <text fg={theme.text}>
              <b>Thinking</b>
            </text>
            <text fg={theme.textMuted}>
              {(elapsed() / 1000).toFixed(1)}s · ~{estimatedTokens()} tokens
            </text>
          </box>
          <text fg={theme.textMuted}>
            {collapsed() ? "▶" : "▼"}
          </text>
        </box>

        <Show when={!collapsed() && thinkingPreview()}>
          <box
            paddingLeft={2}
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.backgroundElement}
          >
            <text fg={theme.textMuted} wrapMode="word">
              {thinkingPreview()}
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const WorkspaceInfo = (props: { workspace: Accessor<string | undefined> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.workspace()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.workspace()}
      </text>
    </Show>
  )
}

export function Header(props: { sessionID: string }) {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage | undefined
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }

    // Show thinking stats: SDK reasoning tokens or <think> tag content
    if (last.tokens.reasoning > 0) {
      result += ` · ~${last.tokens.reasoning.toLocaleString()} reasoning`
    } else if (last.time?.completed) {
      // Estimate thinking tokens from <think> tag in text parts
      const parts = sync.data.part[last.id] ?? []
      const textPart = parts.find((p) => p.type === "text") as any
      if (textPart?.text) {
        const closeIdx = (textPart.text as string).indexOf("</think>")
        if (closeIdx > 0) {
          const thinkTokens = Math.round(closeIdx / 4)
          const duration = last.time.completed - last.time.created
          result += ` · ~${thinkTokens.toLocaleString()} thought (${(duration / 1000).toFixed(1)}s)`
        }
      }
    }

    return result
  })

  const workspace = createMemo(() => {
    const id = session()?.workspaceID
    if (!id) return "Workspace local"
    const info = sync.workspace.get(id)
    if (!info) return `Workspace ${id}`
    return `Workspace ${id} (${info.type})`
  })

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={narrow() ? 1 : 0}>
                {Flag.OPENCODE_EXPERIMENTAL_WORKSPACES ? (
                  <box flexDirection="column">
                    <text fg={theme.text}>
                      <b>Subagent session</b>
                    </text>
                    <WorkspaceInfo workspace={workspace} />
                  </box>
                ) : (
                  <text fg={theme.text}>
                    <b>Subagent session</b>
                  </text>
                )}

<ThinkingInfo sessionID={route.sessionID} sync={sync} />
                <ContextInfo context={context} cost={cost} />
              </box>
              <box flexDirection="row" gap={2}>
                <box
                  onMouseOver={() => setHover("parent")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.parent")}
                  backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("prev")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.previous")}
                  backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("next")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.next")}
                  backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                  </text>
                </box>
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={1}>
              {Flag.OPENCODE_EXPERIMENTAL_WORKSPACES ? (
                <box flexDirection="column">
                  <Title session={session} />
                  <WorkspaceInfo workspace={workspace} />
                </box>
              ) : (
                <Title session={session} />
              )}
              <ThinkingInfo sessionID={route.sessionID} sync={sync} />
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
